/**
 * 對話清單:getDialogs、實體快取、頭像快取。
 */
import { Api } from 'telegram'
import { getPeerId, getDisplayName } from 'telegram/Utils.js'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { getClient } from './client.js'
import { config } from '../store/config.js'

/** Promise 逾時包裝:超過 ms 未完成則 reject。 */
function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms))
  ])
}

/** peerId(string) → { entity, type, title } */
const entityCache = new Map()

export function getCachedEntity(peerId) {
  return entityCache.get(String(peerId))?.entity || null
}

/** 切換帳號時清空快取:entity 只對建立它的 client 有效;myId 換帳號後會變。 */
export function clearCaches() {
  entityCache.clear()
  myIdCache = null
}

/**
 * 把任意 entity(訊息發送者、搜尋結果對象…)收進快取,讓頭像/實體查詢不必只靠對話清單。
 * 已存在就不覆蓋 —— 對話清單算過的標題(例如「我的收藏」)比較準。
 */
export function cacheEntity(entity) {
  if (!entity) return
  let peerId
  try {
    peerId = getPeerId(entity).toString()
  } catch {
    return
  }
  if (entityCache.has(peerId)) return
  entityCache.set(peerId, {
    entity,
    type: dialogType(entity),
    title: getDisplayName(entity) || entity.username || peerId
  })
}

export function getCachedTitle(peerId) {
  return entityCache.get(String(peerId))?.title || String(peerId)
}

/** 自己的 peerId(用來標記「我的收藏 / Saved Messages」)。快取避免重複請求。 */
let myIdCache = null
export async function getMyId() {
  if (myIdCache) return myIdCache
  try {
    const me = await getClient().getMe()
    myIdCache = me?.id ? me.id.toString() : null
  } catch {
    myIdCache = null
  }
  return myIdCache
}

/** entity 是否真的有頭像(空頭像的 className 會是 …PhotoEmpty)。 */
function hasProfilePhoto(entity) {
  const cn = entity?.photo?.className
  return !!(cn && cn !== 'ChatPhotoEmpty' && cn !== 'UserProfilePhotoEmpty')
}

function dialogType(entity) {
  const cn = entity?.className
  if (cn === 'User') return 'user'
  if (cn === 'Chat' || cn === 'ChatForbidden') return 'group'
  if (cn === 'Channel' || cn === 'ChannelForbidden') return entity.megagroup ? 'group' : 'channel'
  return 'unknown'
}

/** 最後一則訊息的摘要文字。 */
function lastMessagePreview(message) {
  if (!message) return ''
  if (message.message) return message.message.replace(/\s+/g, ' ').slice(0, 60)
  if (message.media) {
    const cn = message.media.className
    const map = {
      MessageMediaPhoto: '[圖片]',
      MessageMediaDocument: '[檔案]',
      MessageMediaGeo: '[位置]',
      MessageMediaContact: '[聯絡人]',
      MessageMediaPoll: '[投票]',
      MessageMediaWebPage: '[連結]'
    }
    return map[cn] || '[訊息]'
  }
  if (message.action) return '[系統訊息]'
  return ''
}

/** 載入對話清單。archived=true 取「已歸檔」資料夾(folderId 1)。 */
export async function loadDialogs({ limit = 200, archived = false } = {}) {
  const client = getClient()
  if (!client.connected) throw new Error('尚未連線(請檢查代理 / 網路後重試)')
  const myId = await getMyId()
  // 逾時保護:代理建立連線後若資料層卡住,getDialogs 會永久 hang,務必加上限
  const dialogs = await withTimeout(
    client.getDialogs({ limit, archived }),
    25000,
    '載入對話逾時(代理連線異常,請嘗試重新整理或更換代理)'
  )
  const list = []
  for (const d of dialogs) {
    const entity = d.entity
    if (!entity) continue
    let peerId
    try {
      peerId = getPeerId(entity).toString()
    } catch {
      continue
    }
    const type = dialogType(entity)
    const isSaved = !!(myId && peerId === myId)
    const title = isSaved ? '我的收藏' : getDisplayName(entity) || entity.username || peerId
    entityCache.set(peerId, { entity, type, title })
    list.push({
      id: peerId,
      type,
      title,
      username: entity.username || '',
      verified: !!entity.verified,
      unreadCount: d.unreadCount || 0,
      pinned: !!d.pinned,
      isSaved,
      archived: !!archived,
      hasPhoto: hasProfilePhoto(entity),
      date: d.date || (d.message && d.message.date) || 0,
      lastMessage: lastMessagePreview(d.message)
    })
  }
  return list
}

/** InputPeer → marked peerId 字串(與 loadDialogs 的 id 對齊)。 */
function inputPeerToId(p) {
  try {
    if (p.className === 'InputPeerUser' || p.userId !== undefined) {
      return getPeerId(new Api.PeerUser({ userId: p.userId }), true).toString()
    }
    if (p.className === 'InputPeerChat' || p.chatId !== undefined) {
      return getPeerId(new Api.PeerChat({ chatId: p.chatId }), true).toString()
    }
    if (p.className === 'InputPeerChannel' || p.channelId !== undefined) {
      return getPeerId(new Api.PeerChannel({ channelId: p.channelId }), true).toString()
    }
  } catch {
    /* ignore */
  }
  return null
}

/** 取 Telegram 聊天資料夾(對話分類)。回可序列化清單。 */
export async function getFolders() {
  const res = await getClient().invoke(new Api.messages.GetDialogFilters())
  const filters = res?.filters || res || []
  const out = []
  for (const f of filters) {
    if (!f || f.className === 'DialogFilterDefault') continue // 「所有對話」= 我們的「全部」
    const include = new Set()
    for (const p of [...(f.pinnedPeers || []), ...(f.includePeers || [])]) {
      const id = inputPeerToId(p)
      if (id) include.add(id)
    }
    const exclude = new Set()
    for (const p of f.excludePeers || []) {
      const id = inputPeerToId(p)
      if (id) exclude.add(id)
    }
    // title 新版為 TextWithEntities 物件,舊版為字串
    const title = typeof f.title === 'string' ? f.title : f.title?.text || `資料夾 ${f.id}`
    out.push({
      id: f.id,
      title,
      emoticon: f.emoticon || '',
      include: [...include],
      exclude: [...exclude],
      flags: {
        contacts: !!f.contacts,
        nonContacts: !!f.nonContacts,
        groups: !!f.groups,
        broadcasts: !!f.broadcasts,
        bots: !!f.bots,
        excludeArchived: !!f.excludeArchived
      }
    })
  }
  return out
}

/** 下載某 entity 的頭像(小)→ data URL,落地快取避免重複下載。回 null 表示無頭像。 */
async function downloadAvatar(cacheKey, entity) {
  const cacheDir = join(config.getPaths().cacheDir, 'avatars')
  fs.mkdirSync(cacheDir, { recursive: true })
  const file = join(cacheDir, String(cacheKey).replace(/[^\d-]/g, '_') + '.jpg')

  try {
    const st = await fsp.stat(file)
    if (st.size > 0) {
      const buf = await fsp.readFile(file)
      return 'data:image/jpeg;base64,' + buf.toString('base64')
    }
  } catch {
    /* 尚未快取 */
  }

  if (!entity) return null
  try {
    const buf = await getClient().downloadProfilePhoto(entity, { isBig: false })
    if (!buf || !buf.length) return null
    await fsp.writeFile(file, buf)
    return 'data:image/jpeg;base64,' + Buffer.from(buf).toString('base64')
  } catch {
    return null
  }
}

/**
 * 取任意 peer 的頭像 → data URL。對話清單載過的直接用快取;群組成員之類沒在清單裡的,
 * 現場 resolve 一次再抓(檔案快取命中時連 entity 都不需要)。
 */
export async function getAvatarDataUrl(peerId) {
  let entity = entityCache.get(String(peerId))?.entity || null
  if (!entity) {
    try {
      const client = getClient()
      if (client.connected) {
        entity = await client.getEntity(String(peerId))
        cacheEntity(entity)
      }
    } catch {
      /* resolve 不到就只能退回文字縮寫 */
    }
  }
  return downloadAvatar(peerId, entity)
}

/**
 * 取目前登入帳號自己的頭像,不依賴對話清單是否已載入。
 * 回 { dataUrl, hasPhoto, retriable }:retriable=true 代表「這帳號有頭像但這次沒抓到」——
 * 剛登入完 client 還在暖機(要跟頭像所在 DC 借連線)時很常見,呼叫端該過一下重試,
 * 而不是把「沒有頭像」記下來一直顯示文字縮寫。
 */
export async function getSelfAvatar() {
  let me
  try {
    me = await getClient().getMe()
  } catch {
    return { dataUrl: null, hasPhoto: false, retriable: true }
  }
  if (!me) return { dataUrl: null, hasPhoto: false, retriable: true }
  const id = me.id?.toString?.() ?? String(me.id)
  const hasPhoto = hasProfilePhoto(me)
  const dataUrl = await downloadAvatar(id, me)
  return { dataUrl, hasPhoto, retriable: !dataUrl && hasPhoto }
}

/** 透過用戶名/連結添加對話:resolve entity 後自然會出現在下次 getDialogs 中。 */
export async function addDialogByUsername(raw) {
  const s = (raw || '').trim()
  if (!s) throw new Error('請輸入用戶名、電話或邀請連結')
  const client = getClient()
  if (!client.connected) throw new Error('尚未連線')
  // 嘗試 resolve 成 entity
  try {
    await client.getEntity(s)
  } catch (e) {
    throw new Error('找不到該用戶或連結: ' + (e.message || e))
  }
  // 成功 resolve 即代表可以對話,refresh 後就會出現
  return true
}
