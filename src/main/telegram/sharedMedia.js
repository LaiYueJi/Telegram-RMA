/**
 * 共享媒體:照片 / 影片 / 檔案 / 音訊檔 / 連結 / 語音訊息 / GIF / 置頂訊息,
 * 外加私聊限定的「共同的群組」與「禮物」—— 對應官方客戶端側欄那一排「N 張照片 / N 個影片…」。
 *
 *   計數 → messages.GetSearchCounters(一次帶所有 filter 拿完,不用逐類翻歷史)
 *   列表 → iterMessages + 對應 filter,分頁靠 offsetId
 *   日曆 → messages.GetSearchResultsCalendar(伺服器直接給「每天幾則 + 當天第一則 id」)
 *
 * ⚠ 投票沒有伺服器端 filter —— MTProto 就只有 InputMessagesFilter* 那十幾種,沒有 poll。
 *   所以投票只能自己掃歷史(scanPolls),做成「按了才掃」並回報進度,不放進計數列。
 */
import { Api } from 'telegram'
import { getPeerId, getDisplayName } from 'telegram/Utils.js'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { getClient } from './client.js'
import { getCachedEntity, cacheEntity } from './dialogs.js'
import { normalizeMessage, cacheRawMessages } from './messages.js'
import { pickThumbSize } from './media.js'
import { config } from '../store/config.js'

/** 分類 → MTProto filter。順序即側欄顯示順序(對齊官方客戶端)。 */
const FILTERS = {
  photo: () => new Api.InputMessagesFilterPhotos(),
  video: () => new Api.InputMessagesFilterVideo(),
  document: () => new Api.InputMessagesFilterDocument(),
  audio: () => new Api.InputMessagesFilterMusic(),
  url: () => new Api.InputMessagesFilterUrl(),
  voice: () => new Api.InputMessagesFilterVoice(),
  gif: () => new Api.InputMessagesFilterGif(),
  pinned: () => new Api.InputMessagesFilterPinned()
}
/** 有伺服器 filter 的分類(計數 / 列表 / 日曆都走同一套)。 */
export const SHARED_KINDS = Object.keys(FILTERS)

/** filter 實例 → 我們的分類 key(GetSearchCounters 回來時要對回去)。 */
function kindOfFilter(filter) {
  const cn = filter?.className
  for (const k of SHARED_KINDS) {
    if (FILTERS[k]().className === cn) return k
  }
  return ''
}

function requireEntity(dialogId) {
  const entity = getCachedEntity(dialogId)
  if (!entity) throw new Error('對話尚未載入,請先在對話列表開啟一次')
  return entity
}

function requireConnected() {
  const client = getClient()
  if (!client.connected) throw new Error('尚未連線(請檢查代理 / 網路)')
  return client
}

// ---------------------------------------------------------------- 額外欄位

/** 音訊/語音的曲名與演出者(音訊檔分頁要顯示「筷子兄弟 – 小蘋果」這種)。 */
function audioMeta(msg) {
  const doc = msg.document
  if (!doc || doc.className !== 'Document') return null
  const a = (doc.attributes || []).find((x) => x.className === 'DocumentAttributeAudio')
  if (!a) return null
  return { title: a.title || '', performer: a.performer || '', voice: !!a.voice }
}

/** 連結預覽卡(標題 / 描述 / 網址 / 站名)。 */
function webpageMeta(msg) {
  const wp = msg.media?.className === 'MessageMediaWebPage' ? msg.media.webpage : null
  if (!wp || wp.className !== 'WebPage') return null
  return {
    url: wp.url || '',
    displayUrl: wp.displayUrl || '',
    siteName: wp.siteName || '',
    title: wp.title || '',
    description: (wp.description || '').slice(0, 200)
  }
}

/**
 * 訊息裡的所有網址。優先用 entity(才抓得到「文字連結」底下的真實網址),
 * 沒有 entity 才退回正則掃文字。
 * ⚠ Telegram 的 offset/length 以 UTF-16 code unit 計 —— 跟 JS 字串一致,可以直接 slice。
 */
function extractUrls(msg) {
  const text = msg.message || ''
  const out = []
  for (const e of msg.entities || []) {
    if (e.className === 'MessageEntityTextUrl' && e.url) out.push(e.url)
    else if (e.className === 'MessageEntityUrl') out.push(text.slice(e.offset, e.offset + e.length))
  }
  if (!out.length) {
    const re = /https?:\/\/\S+/g
    let m
    while ((m = re.exec(text)) !== null) out.push(m[0])
  }
  return [...new Set(out)].slice(0, 8)
}

/** 投票內容。新版 layer 的 question/answer 是 TextWithEntities,舊版是字串,兩種都收。 */
function pollMeta(msg) {
  if (msg.media?.className !== 'MessageMediaPoll') return null
  const poll = msg.media.poll || {}
  const txt = (v) => (typeof v === 'string' ? v : v?.text || '')
  return {
    question: txt(poll.question),
    quiz: !!poll.quiz,
    closed: !!poll.closed,
    answers: (poll.answers || []).map((a) => txt(a.text)),
    totalVoters: msg.media.results?.totalVoters || 0
  }
}

/**
 * 正規化 + 補上共享媒體分頁要用的欄位。
 * msg.document / msg.media 在 GramJS 都是 getter,服務訊息之類的東西上取值會炸,
 * 所以整段包起來 —— 補充欄位取不到不該讓整批訊息消失。
 */
function normalizeShared(msg) {
  const n = normalizeMessage(msg)
  if (!n) return null
  try {
    n.audioMeta = audioMeta(msg)
    n.webpage = webpageMeta(msg)
    n.urls = extractUrls(msg)
    n.poll = pollMeta(msg)
  } catch {
    n.audioMeta = n.audioMeta || null
    n.webpage = n.webpage || null
    n.urls = n.urls || []
    n.poll = n.poll || null
  }
  return n
}

// ---------------------------------------------------------------- 計數 / 列表 / 日曆

/**
 * 一次取回所有分類的則數。
 * @returns {Promise<Record<string, {count:number, inexact:boolean}>>}
 */
export async function getCounters(dialogId) {
  const client = requireConnected()
  const entity = requireEntity(dialogId)
  const res = await client.invoke(
    new Api.messages.GetSearchCounters({
      peer: entity,
      filters: SHARED_KINDS.map((k) => FILTERS[k]())
    })
  )
  const out = {}
  for (const c of res || []) {
    const kind = kindOfFilter(c.filter)
    if (kind) out[kind] = { count: Number(c.count || 0), inexact: !!c.inexact }
  }
  for (const k of SHARED_KINDS) if (!out[k]) out[k] = { count: 0, inexact: false }
  return out
}

/**
 * 取某分類的一頁。offsetId=0 從最新開始,往下翻時傳目前最舊的 id。
 * 回「由新到舊」—— 共享媒體分頁本來就是新的在上面。
 */
export async function listMedia(dialogId, kind, { offsetId = 0, limit = 60 } = {}) {
  if (!FILTERS[kind]) throw new Error('不支援的分類:' + kind)
  const client = requireConnected()
  const entity = requireEntity(dialogId)

  const raws = []
  const collect = (async () => {
    for await (const msg of client.iterMessages(entity, {
      limit,
      offsetId,
      filter: FILTERS[kind]()
    })) {
      raws.push(msg)
      if (raws.length >= limit) break
    }
  })()
  await Promise.race([
    collect,
    new Promise((_, reject) => setTimeout(() => reject(new Error('載入逾時(代理可能過慢)')), 25000))
  ])

  cacheRawMessages(dialogId, raws) // 讓縮圖 / 單則下載 / 燈箱都查得到
  const items = raws.map(normalizeShared).filter(Boolean)
  const ids = items.map((m) => m.id)
  return {
    items,
    oldestId: ids.length ? Math.min(...ids) : offsetId,
    hasMore: raws.length >= limit
  }
}

/**
 * 某分類的「日期分佈」:每天幾則 + 當天最早那則的 id(拿來當日曆格的縮圖與跳轉目標)。
 * 伺服器一次回一整段,offsetId 傳 0 就是從最新往回。
 */
export async function getCalendar(dialogId, kind, { offsetId = 0 } = {}) {
  if (!FILTERS[kind]) throw new Error('不支援的分類:' + kind)
  const client = requireConnected()
  const entity = requireEntity(dialogId)
  const res = await client.invoke(
    new Api.messages.GetSearchResultsCalendar({
      peer: entity,
      filter: FILTERS[kind](),
      offsetId,
      offsetDate: 0
    })
  )
  // 回傳的 messages 是每天第一則 → 快取起來,日曆格才有縮圖可抓
  cacheRawMessages(dialogId, res.messages || [])
  return {
    count: Number(res.count || 0),
    minDate: Number(res.minDate || 0),
    minMsgId: Number(res.minMsgId || 0),
    periods: (res.periods || []).map((p) => ({
      date: Number(p.date || 0),
      minMsgId: Number(p.minMsgId || 0),
      maxMsgId: Number(p.maxMsgId || 0),
      count: Number(p.count || 0)
    }))
  }
}

// ---------------------------------------------------------------- 投票(只能掃)

/** 掃描中的取消旗標:dialogId → true。 */
const pollScanCancel = new Set()

export function cancelPollScan(dialogId) {
  pollScanCancel.add(String(dialogId))
}

/**
 * 掃歷史找投票。沒有伺服器 filter,只能一頁頁翻,所以:
 *  - 由呼叫端決定上限(maxScan),掃到上限就停並回報 partial
 *  - 每 500 則回報一次進度,讓 UI 有東西可以顯示
 *  - 可中途取消
 * @param {(p:{scanned:number, found:number})=>void} onProgress
 */
export async function scanPolls(dialogId, { maxScan = 30000, onProgress } = {}) {
  // ⚠ GramJS 在 limit > 3000 時會自作主張把每批間隔設成 1 秒(30000 則 = 5 分鐘)。
  //   明確指定 waitTime 壓到 0.25 秒,既不會被當成打點又不用等半天。
  const client = requireConnected()
  const entity = requireEntity(dialogId)
  const key = String(dialogId)
  pollScanCancel.delete(key)

  const found = []
  const raws = []
  let scanned = 0
  let canceled = false

  for await (const msg of client.iterMessages(entity, { limit: maxScan, waitTime: 0.25 })) {
    if (pollScanCancel.has(key)) {
      canceled = true
      break
    }
    scanned++
    if (msg.media?.className === 'MessageMediaPoll') {
      raws.push(msg)
      const n = normalizeShared(msg)
      if (n) found.push(n)
    }
    if (scanned % 500 === 0) onProgress?.({ scanned, found: found.length })
  }
  pollScanCancel.delete(key)

  cacheRawMessages(dialogId, raws)
  onProgress?.({ scanned, found: found.length })
  return { items: found, scanned, canceled, partial: canceled || scanned >= maxScan }
}

// ---------------------------------------------------------------- 私聊限定

/** 共同的群組(只有私聊有)。 */
export async function getCommonChats(peerId, { limit = 100 } = {}) {
  const client = requireConnected()
  const entity = getCachedEntity(peerId) || (await client.getEntity(String(peerId)))
  if (!entity || entity.className !== 'User') throw new Error('只有私聊才有共同的群組')
  const res = await client.invoke(
    new Api.messages.GetCommonChats({ userId: entity, maxId: 0, limit })
  )
  const out = []
  for (const chat of res.chats || []) {
    cacheEntity(chat)
    let id = ''
    try {
      id = getPeerId(chat).toString()
    } catch {
      continue
    }
    out.push({
      id,
      title: getDisplayName(chat) || chat.title || id,
      username: chat.username || '',
      type: chat.className === 'Channel' && !chat.megagroup ? 'channel' : 'group',
      participants: Number(chat.participantsCount || 0),
      hasPhoto: !!(chat.photo && chat.photo.className !== 'ChatPhotoEmpty')
    })
  }
  return out
}

/** 禮物貼圖 → data URL。TGS/lottie 在畫面放不出來,所以只取靜態縮圖。 */
async function giftStickerDataUrl(giftId, doc) {
  if (!doc) return null
  const cacheDir = join(config.getPaths().cacheDir, 'gifts')
  fs.mkdirSync(cacheDir, { recursive: true })
  const file = join(cacheDir, String(giftId).replace(/[^\d-]/g, '_') + '.jpg')
  try {
    const st = await fsp.stat(file)
    if (st.size > 0) return 'data:image/jpeg;base64,' + (await fsp.readFile(file)).toString('base64')
  } catch {
    /* 尚未快取 */
  }
  const size = pickThumbSize({ document: doc })
  if (!size) return null
  try {
    const buf = await getClient().downloadMedia(doc, { thumb: size })
    if (!buf || !buf.length) return null
    await fsp.writeFile(file, buf)
    return 'data:image/jpeg;base64,' + Buffer.from(buf).toString('base64')
  } catch {
    return null
  }
}

/** 收到的禮物(星星禮物)。offset 為空字串代表第一頁,回傳的 nextOffset 拿來翻頁。 */
export async function getGifts(peerId, { offset = '', limit = 50 } = {}) {
  const client = requireConnected()
  const entity = getCachedEntity(peerId) || (await client.getEntity(String(peerId)))
  if (!entity) throw new Error('找不到這個對象')
  const res = await client.invoke(
    new Api.payments.GetSavedStarGifts({ peer: entity, offset: String(offset || ''), limit })
  )
  // 送禮者名字要靠回傳的 users 對照
  const byId = new Map()
  for (const u of [...(res.users || []), ...(res.chats || [])]) {
    cacheEntity(u)
    try {
      byId.set(getPeerId(u).toString(), getDisplayName(u) || u.title || '')
    } catch {
      /* ignore */
    }
  }

  const items = []
  for (const g of res.gifts || []) {
    const gift = g.gift || {}
    let fromName = ''
    if (g.nameHidden) fromName = '匿名'
    else if (g.fromId) {
      try {
        fromName = byId.get(getPeerId(g.fromId).toString()) || ''
      } catch {
        /* ignore */
      }
    }
    const txt = g.message
    const gid = gift.id ?? g.savedId ?? items.length
    items.push({
      id: String(gid),
      savedId: g.savedId ? String(g.savedId) : '',
      msgId: g.msgId || 0,
      date: Number(g.date || 0),
      fromName,
      text: typeof txt === 'string' ? txt : txt?.text || '',
      stars: Number(gift.stars || 0),
      convertStars: Number(g.convertStars || gift.convertStars || 0),
      limited: !!gift.limited,
      unique: gift.className === 'StarGiftUnique',
      availabilityTotal: Number(gift.availabilityTotal || 0),
      sticker: await giftStickerDataUrl(gid, gift.sticker)
    })
  }
  return { count: Number(res.count || items.length), items, nextOffset: res.nextOffset || '' }
}
