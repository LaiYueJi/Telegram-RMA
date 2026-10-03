/**
 * 驗證下載重構後端(真帳號):
 *  1. MTProto secret 正規化(hex / base64url / FakeTLS ee)→ 應產出 16-byte hex
 *  2. 多連線分段下載一個檔 → 比對最終大小===TG 大小(大小驗證)
 *  3. 與單連線計時比較(展示加速效果)
 * 不開 GUI、不外印 session。
 */
import { readFileSync, openSync, closeSync, writeSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import bigInt from 'big-integer'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { getDisplayName } from 'telegram/Utils.js'

// —— 1. secret 正規化(與 client.js 同邏輯) ——
function normalizeMtprotoSecret(raw) {
  if (!raw) return raw
  const s = String(raw).trim()
  if (/^[0-9a-f]+$/i.test(s) && s.length % 2 === 0) return s.toLowerCase()
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4) b64 += '='
  let bytes
  try {
    bytes = Buffer.from(b64, 'base64')
  } catch {
    return s
  }
  if (!bytes.length) return s
  if (bytes[0] === 0xdd && bytes.length >= 17) return bytes.subarray(0, 17).toString('hex')
  if (bytes[0] === 0xee && bytes.length >= 17) return bytes.subarray(1, 17).toString('hex')
  if (bytes.length >= 16) return bytes.subarray(0, 16).toString('hex')
  return bytes.toString('hex')
}

console.log('=== secret 正規化 ===')
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
const sampleSecret = (cfg.proxies || []).find((p) => p.type === 'mtproto')?.secret
if (sampleSecret) {
  const norm = normalizeMtprotoSecret(sampleSecret)
  console.log(`你的 MTProto secret → ${norm}  (${norm.length / 2} bytes, ${norm.length === 32 ? '✅ 16-byte 可用' : '⚠ 非 16 bytes'})`)
}
console.log('hex 範例 →', normalizeMtprotoSecret('0123456789abcdef0123456789abcdef'))

// —— 連線 ——
const DEFAULT = { apiId: 2040, apiHash: 'b18441a1ff607e10a989891a5462e627' }
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
      ? { ip: active.ip, port: Number(active.port), MTProxy: true, secret: normalizeMtprotoSecret(active.secret) }
      : { ip: active.ip, port: Number(active.port), socksType: Number(active.socksType) || 5 }
}
const client = new TelegramClient(new StringSession(sessionStr), Number(apiId), String(apiHash), {
  connectionRetries: 3,
  useWSS: false,
  proxy
})
client.setLogLevel('none')

const REQUEST_SIZE = 512 * 1024
function buildSegments(total, threads) {
  if (total < 1024 * 1024 || threads === 1) return [{ start: 0, end: total - 1, next: 0 }]
  const segSize = Math.ceil(total / threads)
  const segs = []
  for (let i = 0; i < threads; i++) {
    const start = i * segSize
    if (start >= total) break
    segs.push({ start, end: Math.min(total - 1, start + segSize - 1), next: start })
  }
  return segs
}
async function runSegment(msgMedia, total, seg, fd) {
  const iter = client.iterDownload({
    file: msgMedia,
    offset: bigInt(seg.next),
    fileSize: bigInt(total),
    requestSize: REQUEST_SIZE
  })
  for await (const chunk of iter) {
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const room = seg.end - seg.next + 1
    if (buf.length > room) buf = buf.subarray(0, room)
    if (buf.length) {
      writeSync(fd, buf, 0, buf.length, seg.next)
      seg.next += buf.length
    }
    if (seg.next > seg.end) break
  }
  try {
    await iter.return?.()
  } catch {
    /* ignore */
  }
}
async function downloadSegmented(msgMedia, total, threads, outPath) {
  const fd = openSync(outPath, 'w')
  try {
    const segs = buildSegments(total, threads)
    const t0 = Date.now()
    await Promise.all(segs.map((seg) => runSegment(msgMedia, total, seg, fd)))
    const ms = Date.now() - t0
    return { ms, segs: segs.length }
  } finally {
    closeSync(fd)
  }
}

function docOf(msg) {
  const m = msg.media
  if (m?.className === 'MessageMediaDocument' && m.document?.className === 'Document') return m.document
  return null
}

const run = async () => {
  await client.connect()
  const me = await client.getMe()
  console.log('\n帳號:', getDisplayName(me), '| 代理:', proxy ? 'on' : 'direct')

  // 找一個 1~40MB 的檔案(影片/文件)
  console.log('\n=== 尋找測試檔(1~40MB) ===')
  const dialogs = await client.getDialogs({ limit: 20 })
  let target = null
  for (const d of dialogs) {
    if (!d.entity || d.entity.className === 'User' || target) continue
    for await (const msg of client.iterMessages(d.entity, { limit: 60 })) {
      const doc = docOf(msg)
      if (doc) {
        const size = Number(doc.size)
        if (size >= 1024 * 1024 && size <= 40 * 1024 * 1024) {
          target = { msg, size, title: getDisplayName(d.entity) }
          break
        }
      }
    }
  }
  if (!target) {
    console.log('找不到合適大小的測試檔,略過下載測試(不影響功能)')
    await client.disconnect()
    process.exit(0)
  }
  const mb = (target.size / 1048576).toFixed(2)
  console.log(`測試檔:「${target.title}」#${target.msg.id} = ${mb} MB`)

  const out4 = join(tmpdir(), 'tgff_seg4.part')
  const out1 = join(tmpdir(), 'tgff_seg1.part')

  console.log('\n=== 多連線(4 段)下載 ===')
  const r4 = await downloadSegmented(target.msg.media, target.size, 4, out4)
  const s4 = statSync(out4).size
  console.log(`4 段 → ${r4.ms} ms, ${(target.size / 1048576 / (r4.ms / 1000)).toFixed(2)} MB/s, 檔案大小 ${s4}`)
  console.log(`大小驗證:${s4 === target.size ? '✅ 一致(算成功)' : '❌ 不一致(會判定失敗)'}`)

  console.log('\n=== 單連線(1 段)下載(比較) ===')
  const r1 = await downloadSegmented(target.msg.media, target.size, 1, out1)
  const s1 = statSync(out1).size
  console.log(`1 段 → ${r1.ms} ms, ${(target.size / 1048576 / (r1.ms / 1000)).toFixed(2)} MB/s, 檔案大小 ${s1}`)

  const speedup = (r1.ms / r4.ms).toFixed(2)
  console.log(`\n加速比(單/多):約 ${speedup}x ${r4.ms < r1.ms ? '✅ 多連線較快' : '(此檔/網路差異不明顯)'}`)

  try {
    unlinkSync(out4)
    unlinkSync(out1)
  } catch {
    /* ignore */
  }
  await client.disconnect()
  console.log('\n✅ 下載重構後端驗證完成')
  process.exit(0)
}

run().catch((e) => {
  console.error('❌ 驗證失敗:', e.message)
  process.exit(1)
})
