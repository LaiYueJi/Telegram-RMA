/**
 * 訊息流:分頁載入、正規化、縮圖。
 * 會保留原始 GramJS message 於記憶體快取,供縮圖下載與單則下載按 id 查詢。
 */
import { getDisplayName } from 'telegram/Utils.js'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { getClient } from './client.js'
import { getCachedEntity, cacheEntity, clearCaches } from './dialogs.js'
import { config } from '../store/config.js'
import { getMediaInfo, getStrippedThumbDataUrl, pickThumbSize, hasThumb } from './media.js'

/** dialogId → Map(msgId → raw message)。最多保留近 N 個對話。 */
const rawCache = new Map()
const MAX_DIALOGS = 5

function rawMapFor(dialogId) {
  const key = String(dialogId)
  let m = rawCache.get(key)
  if (!m) {
    m = new Map()
    rawCache.set(key, m)
    // 淘汰最舊
    if (rawCache.size > MAX_DIALOGS) {
      const oldest = rawCache.keys().next().value
      rawCache.delete(oldest)
    }
  }
  return m
}

export function getRawMessage(dialogId, msgId) {
  return rawCache.get(String(dialogId))?.get(Number(msgId)) || null
}

/** 切換帳號時清空 raw 訊息快取(裸 dialogId 跨帳號會撞,必清)。 */
export function clearRawCache() {
  rawCache.clear()
}

/** 把一批 raw 訊息塞進快取(供檢索結果也能單則下載/取縮圖)。 */
export function cacheRawMessages(dialogId, msgs) {
  if (!dialogId || !msgs?.length) return
  const map = rawMapFor(dialogId)
  for (const m of msgs) if (m?.id != null) map.set(Number(m.id), m)
}

/**
 * 向伺服器補抓單一訊息(依 id),抓到就寫回快取並回傳 raw message;失敗回 null。
 * 供跨程序重啟後續傳用:重開時 raw 快取為空,需要重新取得媒體位置(fileReference 也會刷新)。
 */
export async function fetchRawMessage(dialogId, msgId) {
  const client = getClient()
  if (!client?.connected) return null
  let entity = getCachedEntity(dialogId)
  if (!entity) {
    try {
      entity = await client.getEntity(String(dialogId))
    } catch {
      return null
    }
  }
  try {
    const res = await client.getMessages(entity, { ids: [Number(msgId)] })
    const msg = res && res[0]
    if (msg && msg.id != null) {
      cacheRawMessages(dialogId, [msg])
      return msg
    }
  } catch {
    /* 取不到(訊息已刪 / 無權限 / 逾時)→ 回 null,由呼叫端提示 */
  }
  return null
}

/**
 * 依 id 批次補抓訊息(一次最多 100 筆,Telegram 的上限)。
 * 重開程式後記憶體沒有 raw 訊息時用,順便拿到新的 fileReference。
 * @returns {Promise<object[]>} 抓到的 raw 訊息(抓不到的會直接略過)
 */
export async function fetchRawMessages(dialogId, msgIds = []) {
  const client = getClient()
  if (!client?.connected || !msgIds.length) return []
  let entity = getCachedEntity(dialogId)
  if (!entity) {
    try {
      entity = await client.getEntity(String(dialogId))
    } catch {
      return []
    }
  }
  const out = []
  const ids = msgIds.map(Number).filter((n) => Number.isFinite(n))
  for (let i = 0; i < ids.length; i += 100) {
    try {
      const res = await client.getMessages(entity, { ids: ids.slice(i, i + 100) })
      for (const m of res || []) {
        if (m && m.id != null && m.className !== 'MessageEmpty') out.push(m)
      }
    } catch {
      /* 這批抓不到就跳過,不要讓整個重試失敗 */
    }
  }
  if (out.length) cacheRawMessages(dialogId, out)
  return out
}

/** service 訊息簡述。 */
function serviceText(action) {
  const map = {
    MessageActionChatCreate: '建立了群組',
    MessageActionChannelCreate: '建立了頻道',
    MessageActionChatAddUser: '加入了成員',
    MessageActionChatDeleteUser: '移除了成員',
    MessageActionChatJoinedByLink: '透過連結加入',
    MessageActionPinMessage: '釘選了訊息',
    MessageActionChatEditPhoto: '更換了頭像',
    MessageActionChatEditTitle: '更改了名稱'
  }
  return map[action?.className] || '系統訊息'
}

/** 轉發來源顯示名(取得到什麼算什麼,取不到回空字串)。 */
function fwdName(fwd) {
  if (!fwd) return ''
  if (fwd.fromName) return String(fwd.fromName)
  try {
    const id = fwd.fromId
    if (!id) return ''
    if (id.userId) return 'user:' + id.userId.toString()
    if (id.channelId) return 'channel:' + id.channelId.toString()
    if (id.chatId) return 'chat:' + id.chatId.toString()
  } catch {
    /* ignore */
  }
  return ''
}

/**
 * 正規化單一訊息(可序列化)。
 * @param {{withThumb?:boolean}} opts 匯出/索引時關掉縮圖,省下每則訊息的 base64 解碼
 */
export function normalizeMessage(msg, opts = {}) {
  const withThumb = opts.withThumb !== false
  if (!msg) return null
  if (msg.className === 'MessageService' || msg.action) {
    return {
      id: msg.id,
      date: msg.date,
      service: true,
      text: serviceText(msg.action),
      out: !!msg.out
    }
  }

  const media = getMediaInfo(msg)
  let senderName = ''
  let senderHasPhoto = false
  try {
    if (msg.sender) {
      senderName = getDisplayName(msg.sender) || ''
      const cn = msg.sender.photo?.className
      senderHasPhoto = !!(cn && cn !== 'ChatPhotoEmpty' && cn !== 'UserProfilePhotoEmpty')
      // 訊息串要畫發送者頭像:群組成員多半不在對話清單裡,趁這裡把 entity 收進快取
      cacheEntity(msg.sender)
    }
  } catch {
    /* 取不到不影響 */
  }

  return {
    id: msg.id,
    date: msg.date,
    out: !!msg.out,
    senderId: msg.senderId ? msg.senderId.toString() : '',
    senderName,
    senderHasPhoto,
    text: msg.message || '',
    replyTo: msg.replyTo?.replyToMsgId || null,
    forwardFrom: fwdName(msg.fwdFrom),
    grouped: msg.groupedId ? msg.groupedId.toString() : null,
    views: msg.views || 0,
    media: media
      ? {
          kind: media.kind,
          fileName: media.fileName,
          size: media.size,
          duration: media.duration,
          width: media.width,
          height: media.height,
          mime: media.mime
        }
      : null,
    hasThumb: media ? hasThumb(msg) : false,
    thumb: media && withThumb ? getStrippedThumbDataUrl(msg) : null // 即時模糊預覽
  }
}

/**
 * 分頁載入訊息。offsetId=0 取最新;往上捲時傳目前最舊的 id。
 * 回傳「由舊到新」排序的陣列。
 */
export async function loadMessages(dialogId, { limit = 30, offsetId = 0 } = {}) {
  let entity = getCachedEntity(dialogId)
  if (!entity) {
    // 代理切換後 entity 快取可能已失效,嘗試重新從 client 取得
    try {
      const client = getClient()
      if (client.connected) {
        entity = await client.getEntity(String(dialogId))
        cacheEntity(entity) // 收回快取:共享媒體 / 置頂訊息都靠它,少了會報「對話尚未載入」
      }
    } catch {
      throw new Error('對話不存在或尚未載入清單(請重新整理對話列表)')
    }
  }
  if (!entity) throw new Error('對話不存在或尚未載入清單')
  const client = getClient()
  if (!client.connected) throw new Error('尚未連線(請檢查代理 / 網路後重試)')
  // 逾時保護:12 秒內沒回應則拋錯
  const raws = []
  try {
    const collect = (async () => {
      for await (const msg of client.iterMessages(entity, { limit, offsetId })) {
        raws.push(msg)
        if (raws.length >= limit) break
      }
    })()
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('載入逾時(代理可能過慢,請檢查連線)')), 20000)
    )
    await Promise.race([collect, timeout])
  } catch (e) {
    if (e.message?.includes('逾時')) throw e
    throw new Error('載入訊息失敗:' + (e.message || e))
  }
  const map = rawMapFor(dialogId)
  for (const m of raws) map.set(Number(m.id), m)

  const normalized = raws.map(normalizeMessage).filter(Boolean)
  normalized.sort((a, b) => a.id - b.id) // 由舊到新
  const oldestId = raws.length ? Math.min(...raws.map((m) => Number(m.id))) : offsetId
  return { messages: normalized, oldestId, hasMore: raws.length >= limit }
}

/**
 * 載入「某則訊息前後」的一段訊息(給任務台/檢索跳轉用)。
 * addOffset 傳負值 = 從 offsetId 往「更新」的方向再取幾則,這樣目標訊息會落在中間。
 */
export async function loadMessagesAround(dialogId, msgId, { limit = 40 } = {}) {
  let entity = getCachedEntity(dialogId)
  if (!entity) {
    try {
      entity = await getClient().getEntity(String(dialogId))
      cacheEntity(entity)
    } catch {
      throw new Error('對話不存在或尚未載入清單(請先開一次對話列表)')
    }
  }
  const client = getClient()
  if (!client.connected) throw new Error('尚未連線(請檢查代理 / 網路後重試)')

  const half = Math.floor(limit / 2)
  const raws = []
  try {
    const collect = (async () => {
      for await (const msg of client.iterMessages(entity, {
        limit,
        offsetId: Number(msgId) + 1, // +1 才會把目標訊息本身也收進來
        addOffset: -half
      })) {
        raws.push(msg)
        if (raws.length >= limit) break
      }
    })()
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('載入逾時(代理可能過慢,請檢查連線)')), 20000)
    )
    await Promise.race([collect, timeout])
  } catch (e) {
    if (e.message?.includes('逾時')) throw e
    throw new Error('載入訊息失敗:' + (e.message || e))
  }

  const map = rawMapFor(dialogId)
  for (const m of raws) map.set(Number(m.id), m)

  const normalized = raws.map(normalizeMessage).filter(Boolean)
  normalized.sort((a, b) => a.id - b.id)
  const ids = raws.map((m) => Number(m.id))
  return {
    messages: normalized,
    oldestId: ids.length ? Math.min(...ids) : 0,
    newestId: ids.length ? Math.max(...ids) : 0,
    hasMore: raws.length >= limit,
    found: ids.includes(Number(msgId))
  }
}

/** 往「更新」的方向讀一頁 —— 跳轉 / 跳到最舊之後,要能繼續往下讀回來。 */
export async function loadNewerMessages(dialogId, { offsetId = 0, limit = 30 } = {}) {
  let entity = getCachedEntity(dialogId)
  if (!entity) {
    try {
      entity = await getClient().getEntity(String(dialogId))
      cacheEntity(entity)
    } catch {
      throw new Error('對話不存在或尚未載入清單(請重新整理對話列表)')
    }
  }
  const client = getClient()
  if (!client.connected) throw new Error('尚未連線(請檢查代理 / 網路後重試)')

  const raws = []
  try {
    const collect = (async () => {
      // reverse:從 offsetId 往「更新」的方向讀(offsetId 本身不含)
      for await (const msg of client.iterMessages(entity, { limit, offsetId, reverse: true })) {
        raws.push(msg)
        if (raws.length >= limit) break
      }
    })()
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('載入逾時(代理可能過慢,請檢查連線)')), 20000)
    )
    await Promise.race([collect, timeout])
  } catch (e) {
    if (e.message?.includes('逾時')) throw e
    throw new Error('載入較新訊息失敗:' + (e.message || e))
  }

  const map = rawMapFor(dialogId)
  for (const m of raws) map.set(Number(m.id), m)

  const normalized = raws.map(normalizeMessage).filter(Boolean)
  normalized.sort((a, b) => a.id - b.id)
  const nids = normalized.map((m) => m.id)
  return {
    messages: normalized,
    newestId: nids.length ? nids[nids.length - 1] : offsetId,
    hasMore: raws.length >= limit
  }
}

/**
 * 直接跳到「對話最初的訊息」。
 * 以前的「最舊」按鈕只是把捲軸拉到 scrollTop=0 —— 那只是「目前載進來的」最上面,
 * 一則四萬條的群組要按幾百次才會到頭。這裡用 reverse 從最舊那端抓一頁回來,
 * 一次就真的到底(再往下捲就走 loadNewerMessages 繼續往新的方向讀)。
 */
export async function loadOldestMessages(dialogId, { limit = 40 } = {}) {
  let entity = getCachedEntity(dialogId)
  if (!entity) {
    try {
      entity = await getClient().getEntity(String(dialogId))
      cacheEntity(entity)
    } catch {
      throw new Error('對話不存在或尚未載入清單(請重新整理對話列表)')
    }
  }
  const client = getClient()
  if (!client.connected) throw new Error('尚未連線(請檢查代理 / 網路後重試)')

  const raws = []
  try {
    const collect = (async () => {
      // reverse:由最舊往新讀(offsetId 0 → GramJS 會自動從 id 1 起算)
      for await (const msg of client.iterMessages(entity, { limit, offsetId: 0, reverse: true })) {
        raws.push(msg)
        if (raws.length >= limit) break
      }
    })()
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('載入逾時(代理可能過慢,請檢查連線)')), 20000)
    )
    await Promise.race([collect, timeout])
  } catch (e) {
    if (e.message?.includes('逾時')) throw e
    throw new Error('載入最舊訊息失敗:' + (e.message || e))
  }

  const map = rawMapFor(dialogId)
  for (const m of raws) map.set(Number(m.id), m)

  const normalized = raws.map(normalizeMessage).filter(Boolean)
  normalized.sort((a, b) => a.id - b.id)
  const ids = normalized.map((m) => m.id)
  return {
    messages: normalized,
    // 已經在最初了,不會再有更舊的
    oldestId: 0,
    hasMore: false,
    firstId: ids.length ? ids[0] : 0,
    newestId: ids.length ? ids[ids.length - 1] : 0
  }
}

/** 取較清晰的小縮圖 → data URL(下載後落地快取)。 */
export async function getThumbDataUrl(dialogId, msgId) {
  const msg = getRawMessage(dialogId, msgId)
  if (!msg) return null

  const cacheDir = join(config.getPaths().cacheDir, 'thumbs')
  fs.mkdirSync(cacheDir, { recursive: true })
  const file = join(cacheDir, `${String(dialogId).replace(/[^\d-]/g, '_')}_${msgId}.jpg`)

  try {
    const st = await fsp.stat(file)
    if (st.size > 0) {
      const buf = await fsp.readFile(file)
      return 'data:image/jpeg;base64,' + buf.toString('base64')
    }
  } catch {
    /* 尚未快取 */
  }

  const size = pickThumbSize(msg)
  if (!size) return getStrippedThumbDataUrl(msg)
  try {
    const buf = await getClient().downloadMedia(msg, { thumb: size })
    if (!buf || !buf.length) return getStrippedThumbDataUrl(msg)
    await fsp.writeFile(file, buf)
    return 'data:image/jpeg;base64,' + Buffer.from(buf).toString('base64')
  } catch {
    return getStrippedThumbDataUrl(msg)
  }
}
