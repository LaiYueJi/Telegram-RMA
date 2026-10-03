/**
 * 獨立驗證 M2 補強後端(不開 GUI、不外印 session):
 *  1. messages.GetDialogFilters → 列聊天資料夾與其 include 數
 *  2. getDialogs({archived:true}) → 列封存對話
 *  3. 找一則影片訊息,用 iterDownload 從 offset 抓前 ~64KB 證明 Range 串流可行
 *  4. 印自己的 id(我的收藏 / Saved Messages 判定依據)
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import bigInt from 'big-integer'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { getPeerId, getDisplayName } from 'telegram/Utils.js'

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

function inputPeerToId(p) {
  try {
    if (p.userId !== undefined) return getPeerId(new Api.PeerUser({ userId: p.userId }), true).toString()
    if (p.chatId !== undefined) return getPeerId(new Api.PeerChat({ chatId: p.chatId }), true).toString()
    if (p.channelId !== undefined) return getPeerId(new Api.PeerChannel({ channelId: p.channelId }), true).toString()
  } catch {
    /* ignore */
  }
  return null
}

function docOf(msg) {
  const m = msg.media
  if (m?.className === 'MessageMediaDocument' && m.document?.className === 'Document') return m.document
  return null
}
function isVideoDoc(doc) {
  return (doc.attributes || []).some((a) => a.className === 'DocumentAttributeVideo')
}

const run = async () => {
  await client.connect()
  const me = await client.getMe()
  console.log('帳號:', getDisplayName(me), '| 我的 id:', me.id.toString(), '| 代理:', proxy ? 'on' : 'direct')

  // 1. 資料夾
  console.log('\n=== 聊天資料夾(GetDialogFilters) ===')
  const res = await client.invoke(new Api.messages.GetDialogFilters())
  const filters = res?.filters || res || []
  let folderCount = 0
  for (const f of filters) {
    if (!f || f.className === 'DialogFilterDefault') continue
    folderCount++
    const title = typeof f.title === 'string' ? f.title : f.title?.text || `資料夾 ${f.id}`
    const inc = [...(f.pinnedPeers || []), ...(f.includePeers || [])]
      .map(inputPeerToId)
      .filter(Boolean)
    console.log(`  [${f.id}] ${f.emoticon || ''}${title} — include ${inc.length} 個(範例 id: ${inc.slice(0, 2).join(', ') || '—'})`)
  }
  console.log(`共 ${folderCount} 個自訂資料夾`)

  // 2. 封存
  console.log('\n=== 封存對話(archived) ===')
  const arch = await client.getDialogs({ limit: 30, archived: true })
  console.log(`封存對話數(前 30):${arch.length}`)
  for (const d of arch.slice(0, 5)) {
    if (d.entity) console.log('  •', getDisplayName(d.entity))
  }

  // 3. 串流(Range)測試:找一則影片,抓前 64KB
  console.log('\n=== iterDownload Range 串流測試 ===')
  const main = await client.getDialogs({ limit: 20 })
  let videoMsg = null
  let chatTitle = ''
  for (const d of main) {
    if (!d.entity || videoMsg) continue
    if (d.entity.className === 'User') continue
    for await (const msg of client.iterMessages(d.entity, { limit: 40 })) {
      const doc = docOf(msg)
      if (doc && isVideoDoc(doc)) {
        videoMsg = msg
        chatTitle = getDisplayName(d.entity)
        break
      }
    }
  }
  if (!videoMsg) {
    console.log('(前面對話沒找到影片,略過串流測試;不影響功能)')
  } else {
    const doc = docOf(videoMsg)
    const size = Number(doc.size)
    const WANT = 64 * 1024
    const iter = client.iterDownload({
      file: videoMsg.media,
      offset: bigInt(0),
      fileSize: bigInt(size),
      requestSize: 512 * 1024
    })
    let got = 0
    for await (const chunk of iter) {
      got += chunk.length
      if (got >= WANT) break
    }
    const head = got > 0 ? '抓到資料' : '無資料'
    console.log(`來源「${chatTitle}」影片 #${videoMsg.id} 大小 ${(size / 1048576).toFixed(2)} MB`)
    console.log(`從 offset 0 串流取得 ${got} bytes(目標 ≥${WANT})→ ${got >= WANT ? '✅ Range 串流可行' : '⚠ ' + head}`)
  }

  await client.disconnect()
  console.log('\n✅ M2 補強後端驗證完成')
  process.exit(0)
}

run().catch((e) => {
  console.error('❌ 驗證失敗:', e.message)
  process.exit(1)
})
