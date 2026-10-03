/**
 * 消息檢索:單對話(messages.Search)/ 全域(SearchGlobal),皆透過 iterMessages。
 * 篩選:關鍵字(server)、媒體型別、時間範圍(client)。結果正規化 + 補對話名/連結 + raw 快取。
 */
import { Api } from 'telegram'
import { getPeerId } from 'telegram/Utils.js'
import { getClient } from './client.js'
import { getCachedEntity, getCachedTitle } from './dialogs.js'
import { normalizeMessage, cacheRawMessages } from './messages.js'
import { getMediaInfo } from './media.js'

const TYPE_FILTER = {
  photo: () => new Api.InputMessagesFilterPhotos(),
  video: () => new Api.InputMessagesFilterVideo(),
  document: () => new Api.InputMessagesFilterDocument(),
  voice: () => new Api.InputMessagesFilterVoice(),
  audio: () => new Api.InputMessagesFilterMusic(),
  url: () => new Api.InputMessagesFilterUrl()
}

function buildServerFilter(types) {
  if (!types || types.length !== 1) return new Api.InputMessagesFilterEmpty()
  const f = TYPE_FILTER[types[0]]
  return f ? f() : new Api.InputMessagesFilterEmpty()
}

function buildLink(msg, did) {
  try {
    const entity = getCachedEntity(did)
    if (entity?.username) return `https://t.me/${entity.username}/${msg.id}`
    const s = String(did)
    if (s.startsWith('-100')) return `https://t.me/c/${s.slice(4)}/${msg.id}`
  } catch {
    /* ignore */
  }
  return ''
}

/**
 * @param {{dialogId?:string, query?:string, types?:string[], startDate?:number, endDate?:number, limit?:number}} p
 */
export async function searchMessages({ dialogId, query, types = [], startDate, endDate, limit = 200 } = {}) {
  const client = getClient()
  if (!client.connected) throw new Error('尚未連線(請檢查代理 / 網路)')
  const q = (query || '').trim()
  const entity = dialogId ? getCachedEntity(dialogId) : undefined
  if (dialogId && !entity) throw new Error('對話未載入,請先在對話頁開啟一次')
  if (!entity && !q) throw new Error('全域搜尋請輸入關鍵字')

  const opts = { limit }
  if (q) opts.search = q
  opts.filter = entity ? buildServerFilter(types) : new Api.InputMessagesFilterEmpty()

  const results = []
  const rawByDialog = new Map()
  let scanned = 0
  const HARD = limit * 6 + 500

  for await (const msg of client.iterMessages(entity, opts)) {
    scanned++
    if (scanned > HARD) break
    if (startDate && msg.date < startDate) {
      if (entity) break // 單對話由新到舊,過了開始日期即可停
      continue
    }
    if (endDate && msg.date > endDate) continue

    const media = getMediaInfo(msg)
    if (types.length) {
      const ok =
        types.includes(media?.kind) ||
        (types.includes('url') && /https?:\/\//.test(msg.message || ''))
      if (!ok) continue
    }

    let did = dialogId
    if (!did) {
      try {
        did = getPeerId(msg.peerId).toString()
      } catch {
        did = ''
      }
    }
    const norm = normalizeMessage(msg)
    if (!norm) continue
    norm.dialogId = String(did)
    norm.dialogTitle = did ? getCachedTitle(did) : ''
    norm.link = did ? buildLink(msg, did) : ''
    results.push(norm)

    if (did) {
      if (!rawByDialog.has(String(did))) rawByDialog.set(String(did), [])
      rawByDialog.get(String(did)).push(msg)
    }
    if (results.length >= limit) break
  }

  for (const [did, msgs] of rawByDialog) cacheRawMessages(did, msgs)
  return { ok: true, results, scanned }
}
