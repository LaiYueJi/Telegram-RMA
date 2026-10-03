/**
 * 獨立驗證 M2 後端:讀已登入 session → getDialogs → iterMessages → 媒體正規化。
 * 不開 GUI、不外印 session。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { getPeerId, getDisplayName, strippedPhotoToJpg } from 'telegram/Utils.js'

// —— 內嵌最小媒體判斷(與 src/main/telegram/media.js 同邏輯,供獨立測試) ——
function getMediaInfo(message) {
  if (message?.photo?.className === 'Photo') return { kind: 'photo', fileName: '' }
  const doc = message?.document
  if (doc?.className === 'Document') {
    const a = doc.attributes || []
    const file = a.find((x) => x.className === 'DocumentAttributeFilename')
    const video = a.find((x) => x.className === 'DocumentAttributeVideo')
    const audio = a.find((x) => x.className === 'DocumentAttributeAudio')
    const sticker = a.find((x) => x.className === 'DocumentAttributeSticker')
    const animated = a.find((x) => x.className === 'DocumentAttributeAnimated')
    let kind = 'document'
    if (sticker) kind = 'sticker'
    else if (animated || doc.mimeType === 'image/gif') kind = 'gif'
    else if (video) kind = 'video'
    else if (audio) kind = audio.voice ? 'voice' : 'audio'
    return { kind, fileName: file?.fileName || '' }
  }
  return null
}
function strippedBytes(message) {
  const c = message.photo || message.document
  if (!c) return null
  const sizes = message.photo ? message.photo.sizes : message.document.thumbs
  return sizes?.find((x) => x.className === 'PhotoStrippedSize')?.bytes || null
}
function hasThumb(m) {
  if (strippedBytes(m)) return true
  const sizes = m.photo ? m.photo.sizes : m.document?.thumbs
  return !!sizes?.some((s) => s.className === 'PhotoSize' || s.className === 'PhotoSizeProgressive')
}
function getStrippedThumbDataUrl(m) {
  const b = strippedBytes(m)
  if (!b) return null
  try {
    return 'data:image/jpeg;base64,' + Buffer.from(strippedPhotoToJpg(Buffer.from(b))).toString('base64')
  } catch {
    return null
  }
}

const DEFAULT = { apiId: 2040, apiHash: 'b18441a1ff607e10a989891a5462e627' }

let cfg
for (const d of ['telegram-rma', 'trma', 'televault', 'tg-ff-open']) {
  try {
    cfg = JSON.parse(readFileSync(join(homedir(), 'AppData', 'Roaming', d, 'tgff-config.json'), 'utf8'))
    break
  } catch {
    /* 試下一個位置 */
  }
}
// 多帳號遷移後 session 移到 accounts[],回填 cfg.session 以相容後續讀取
if (cfg && !cfg.session && Array.isArray(cfg.accounts)) {
  const a = cfg.accounts.find((x) => x.id === cfg.activeAccountId) || cfg.accounts[0]
  if (a && a.session) cfg.session = a.session
}
if (!cfg) {
  console.error('找不到設定(televault / tg-ff-open 皆無),請先登入')
  process.exit(1)
}

const apiId = cfg.credentials?.apiId || DEFAULT.apiId
const apiHash = cfg.credentials?.apiHash || DEFAULT.apiHash
const sessionStr = cfg.session || ''
if (!sessionStr) {
  console.error('找不到 session,請先在 app 登入')
  process.exit(1)
}

const active = (cfg.proxies || []).find((p) => p.id === cfg.activeProxyId)
let proxy
if (active) {
  proxy =
    active.type === 'mtproto'
      ? { ip: active.ip, port: Number(active.port), MTProxy: true, secret: active.secret }
      : { ip: active.ip, port: Number(active.port), socksType: Number(active.socksType) || 5 }
}

const client = new TelegramClient(new StringSession(sessionStr), Number(apiId), String(apiHash), {
  connectionRetries: 3,
  useWSS: false,
  proxy
})
client.setLogLevel('none')

const run = async () => {
  await client.connect()
  const me = await client.getMe()
  console.log('帳號:', getDisplayName(me), '| ID:', me.id.toString(), '| 代理:', proxy ? 'on' : 'direct')

  const dialogs = await client.getDialogs({ limit: 12 })
  console.log('\n=== 對話清單(前 12)===')
  let target = null
  for (const d of dialogs) {
    const e = d.entity
    if (!e) continue
    const type = e.className === 'User' ? 'user' : e.className === 'Channel' ? (e.megagroup ? 'group' : 'channel') : 'group'
    const pid = getPeerId(e).toString()
    console.log(`  [${type}] ${getDisplayName(e)} (id=${pid}, 未讀=${d.unreadCount || 0})`)
    if (!target && (type === 'channel' || type === 'group')) target = { entity: e, title: getDisplayName(e) }
  }

  const chat = target || { entity: dialogs[0].entity, title: getDisplayName(dialogs[0].entity) }
  console.log(`\n=== 抓「${chat.title}」最新 15 則訊息 ===`)
  let n = 0
  const kinds = {}
  let withThumb = 0
  let strippedOk = 0
  for await (const msg of client.iterMessages(chat.entity, { limit: 15 })) {
    n++
    const media = getMediaInfo(msg)
    if (media) {
      kinds[media.kind] = (kinds[media.kind] || 0) + 1
      if (hasThumb(msg)) withThumb++
      if (getStrippedThumbDataUrl(msg)) strippedOk++
    }
    const preview = (msg.message || '').replace(/\s+/g, ' ').slice(0, 24)
    console.log(
      `  #${msg.id} ${media ? '[' + media.kind + (media.fileName ? ':' + media.fileName.slice(0, 18) : '') + ']' : ''} ${preview}`
    )
  }
  console.log(`\n統計:共 ${n} 則,媒體類型`, kinds, `| 有縮圖 ${withThumb} | stripped 解碼成功 ${strippedOk}`)

  await client.disconnect()
  console.log('\n✅ M2 後端驗證完成')
  process.exit(0)
}

run().catch((e) => {
  console.error('❌ 驗證失敗:', e.message)
  process.exit(1)
})
