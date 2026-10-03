/**
 * 驗證 M3 批量下載引擎(真帳號,純 node;邏輯與 batchDownload.js 對齊):
 *  1. 掃描一個對話 + 篩選(只要媒體)→ 計 matched
 *  2. 取前數個小檔,「多檔並行(concurrency=4)」vs「逐一(=1)」計時 → 證明多檔並行才是真加速
 *  3. 每檔大小驗證(size===media.size)
 */
import { readFileSync, openSync, writeSync, closeSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import bigInt from 'big-integer'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { getDisplayName } from 'telegram/Utils.js'

function normalizeMtprotoSecret(raw) {
  if (!raw) return raw
  const s = String(raw).trim()
  if (/^[0-9a-f]+$/i.test(s) && s.length % 2 === 0) return s.toLowerCase()
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4) b64 += '='
  const bytes = Buffer.from(b64, 'base64')
  if (bytes[0] === 0xee && bytes.length >= 17) return bytes.subarray(1, 17).toString('hex')
  if (bytes[0] === 0xdd && bytes.length >= 17) return bytes.subarray(0, 17).toString('hex')
  return bytes.subarray(0, 16).toString('hex')
}
function mediaOf(msg) {
  if (msg?.photo?.className === 'Photo') return { kind: 'photo', size: 0 }
  const doc = msg?.document
  if (doc?.className === 'Document') {
    const a = doc.attributes || []
    let kind = 'document'
    if (a.find((x) => x.className === 'DocumentAttributeSticker')) kind = 'sticker'
    else if (a.find((x) => x.className === 'DocumentAttributeAnimated')) kind = 'gif'
    else if (a.find((x) => x.className === 'DocumentAttributeVideo')) kind = 'video'
    else if (a.find((x) => x.className === 'DocumentAttributeAudio')) kind = 'audio'
    return { kind, size: Number(doc.size) }
  }
  return null
}

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
const apiId = cfg.credentials?.apiId || 2040
const apiHash = cfg.credentials?.apiHash || 'b18441a1ff607e10a989891a5462e627'
if (!cfg.session) {
  console.error('找不到 session,請先登入')
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
const client = new TelegramClient(new StringSession(cfg.session), Number(apiId), String(apiHash), {
  connectionRetries: 3,
  useWSS: false,
  proxy
})
client.setLogLevel('none')

const REQUEST_SIZE = 512 * 1024
async function downloadOne(msgMedia, size, outPath) {
  const fd = openSync(outPath, 'w')
  let pos = 0
  const iter = client.iterDownload({ file: msgMedia, offset: bigInt(0), fileSize: bigInt(size), requestSize: REQUEST_SIZE })
  try {
    for await (const chunk of iter) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      writeSync(fd, buf, 0, buf.length, pos)
      pos += buf.length
    }
  } finally {
    closeSync(fd)
    try {
      await iter.return?.()
    } catch {
      /* ignore */
    }
  }
  return statSync(outPath).size
}
async function downloadAll(files, concurrency, dir, tag) {
  let idx = 0
  let ok = 0
  const worker = async () => {
    while (true) {
      const i = idx++
      const f = files[i]
      if (!f) return
      const size = await downloadOne(f.msg.media, f.size, join(dir, `${tag}_${i}`))
      if (size === f.size) ok++
    }
  }
  const t0 = Date.now()
  await Promise.all(Array.from({ length: concurrency }, worker))
  return { ms: Date.now() - t0, ok }
}

const run = async () => {
  await client.connect()
  const me = await client.getMe()
  console.log('帳號:', getDisplayName(me), '| 代理:', proxy ? 'on' : 'direct')

  // 掃描 + 篩選(只要媒體)— 跨多個對話收集小檔
  console.log('\n=== 掃描 + 篩選(只要媒體)===')
  const dialogs = await client.getDialogs({ limit: 25 })
  const small = []
  let totalMatched = 0
  for (const d of dialogs) {
    if (!d.entity || d.entity.className === 'User') continue
    if (small.length >= 6) break
    let matched = 0
    let scanned = 0
    for await (const msg of client.iterMessages(d.entity, { limit: 200 })) {
      scanned++
      const m = mediaOf(msg)
      if (!m || m.kind === 'sticker') continue
      matched++
      if (m.size > 0 && m.size <= 8 * 1024 * 1024 && small.length < 6) small.push({ msg, size: m.size })
    }
    if (matched) {
      totalMatched += matched
      console.log(`  「${getDisplayName(d.entity)}」掃 ${scanned} → 媒體 ${matched}`)
    }
  }
  console.log(`命中媒體合計 ${totalMatched};取 ${small.length} 個小檔(<8MB)測下載`)

  if (small.length < 2) {
    console.log('小檔不足,略過並行測試')
    await client.disconnect()
    process.exit(0)
  }

  const dir = mkdtempSync(join(tmpdir(), 'tgff-m3-'))
  const totalMB = (small.reduce((s, f) => s + f.size, 0) / 1048576).toFixed(2)
  console.log(`\n=== 下載 ${small.length} 檔(共 ${totalMB} MB) ===`)

  const par = await downloadAll(small, 4, dir, 'par')
  console.log(`多檔並行(4):${par.ms} ms,大小驗證通過 ${par.ok}/${small.length}`)

  const seq = await downloadAll(small, 1, dir, 'seq')
  console.log(`逐一(1)  :${seq.ms} ms,大小驗證通過 ${seq.ok}/${small.length}`)

  const speedup = (seq.ms / par.ms).toFixed(2)
  console.log(`\n加速比(逐一/並行):約 ${speedup}x ${par.ms < seq.ms ? '✅ 多檔並行較快(真加速)' : '(此網路差異不明顯)'}`)
  console.log(`大小驗證:${par.ok === small.length && seq.ok === small.length ? '✅ 全部一致' : '⚠ 有不一致'}`)

  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  await client.disconnect()
  console.log('\n✅ M3 批量下載後端驗證完成')
  process.exit(0)
}
run().catch((e) => {
  console.error('❌ 驗證失敗:', e.message)
  process.exit(1)
})
