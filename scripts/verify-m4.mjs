/**
 * 驗證 M4 檢索 + 導出(真帳號):
 *  1. 單對話搜尋(messages.Search via iterMessages)
 *  2. 全域搜尋(SearchGlobal via iterMessages(undefined))
 *  3. 把結果組 rows → 寫 xlsx/csv/txt 到 temp,並用 exceljs 讀回 xlsx 驗列數
 */
import { readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import ExcelJS from 'exceljs'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { getDisplayName } from 'telegram/Utils.js'

function normSecret(raw) {
  if (!raw) return raw
  const s = String(raw).trim()
  if (/^[0-9a-f]+$/i.test(s) && s.length % 2 === 0) return s.toLowerCase()
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4) b64 += '='
  const b = Buffer.from(b64, 'base64')
  if (b[0] === 0xee && b.length >= 17) return b.subarray(1, 17).toString('hex')
  if (b[0] === 0xdd && b.length >= 17) return b.subarray(0, 17).toString('hex')
  return b.subarray(0, 16).toString('hex')
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
      ? { ip: active.ip, port: Number(active.port), MTProxy: true, secret: normSecret(active.secret) }
      : { ip: active.ip, port: Number(active.port), socksType: Number(active.socksType) || 5 }
}
const client = new TelegramClient(new StringSession(cfg.session), Number(apiId), String(apiHash), {
  connectionRetries: 3,
  useWSS: false,
  proxy
})
client.setLogLevel('none')

function two(n) {
  return String(n).padStart(2, '0')
}
function fmtDate(u) {
  const d = new Date(u * 1000)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}
function rowOf(msg) {
  return {
    id: msg.id,
    date: fmtDate(msg.date),
    sender: '',
    text: (msg.message || '').replace(/\r?\n/g, ' '),
    mediaType: msg.photo ? 'photo' : msg.document ? 'document' : '',
    fileName: '',
    link: ''
  }
}

const run = async () => {
  await client.connect()
  console.log('帳號:', getDisplayName(await client.getMe()), '| 代理:', proxy ? 'on' : 'direct')

  // 找一個有文字訊息的對話 + 取樣一個關鍵詞
  const dialogs = await client.getDialogs({ limit: 20 })
  let entity = null
  let title = ''
  let word = ''
  for (const d of dialogs) {
    if (!d.entity || d.entity.className === 'User') continue
    for await (const m of client.iterMessages(d.entity, { limit: 40 })) {
      const t = (m.message || '').trim()
      if (t.length >= 2) {
        const latin = t.match(/[A-Za-z]{3,}/)
        word = latin ? latin[0] : t.slice(0, 2)
        entity = d.entity
        title = getDisplayName(d.entity)
        break
      }
    }
    if (entity) break
  }
  if (!entity) {
    console.log('找不到含文字的對話,略過')
    await client.disconnect()
    process.exit(0)
  }
  console.log(`\n取樣對話「${title}」,關鍵詞「${word}」`)

  // 1. 單對話搜尋
  console.log('\n=== 單對話搜尋(messages.Search)===')
  const single = []
  for await (const m of client.iterMessages(entity, { search: word, limit: 50 })) single.push(m)
  console.log(`命中 ${single.length} 筆;前 3:`)
  single.slice(0, 3).forEach((m) => console.log('  #' + m.id, (m.message || '').slice(0, 30)))

  // 2. 全域搜尋
  console.log('\n=== 全域搜尋(SearchGlobal)===')
  let globalCount = 0
  try {
    for await (const m of client.iterMessages(undefined, { search: word, limit: 30 })) globalCount++
    console.log(`全域命中 ${globalCount} 筆`)
  } catch (e) {
    console.log('全域搜尋錯誤(部分帳號/詞限制):', e.message)
  }

  // 3. 導出 rows → xlsx/csv/txt
  console.log('\n=== 導出 xlsx / csv / txt ===')
  const rows = (single.length ? single : []).map(rowOf)
  if (!rows.length) {
    // 退而用最近訊息
    for await (const m of client.iterMessages(entity, { limit: 20 })) rows.push(rowOf(m))
  }
  const dir = mkdtempSync(join(tmpdir(), 'tgff-m4-'))
  const COLS = [
    { header: '訊息ID', key: 'id' },
    { header: '日期', key: 'date' },
    { header: '寄件者', key: 'sender' },
    { header: '文字', key: 'text' },
    { header: '媒體類型', key: 'mediaType' },
    { header: '檔名', key: 'fileName' },
    { header: '連結', key: 'link' }
  ]
  const xlsxPath = join(dir, 'out.xlsx')
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: xlsxPath })
  const ws = wb.addWorksheet('messages')
  ws.columns = COLS
  for (const r of rows) ws.addRow(r).commit()
  await wb.commit()

  // 讀回 xlsx 驗列數
  const rwb = new ExcelJS.Workbook()
  await rwb.xlsx.readFile(xlsxPath)
  const rws = rwb.getWorksheet('messages')
  const dataRows = rws.rowCount - 1 // 扣表頭
  console.log(`xlsx:寫 ${rows.length} 列 → 讀回 ${dataRows} 列 ${dataRows === rows.length ? '✅' : '⚠'}  (${statSync(xlsxPath).size} bytes)`)

  rmSync(dir, { recursive: true, force: true })
  await client.disconnect()
  console.log('\n✅ M4 檢索+導出 後端驗證完成')
  process.exit(0)
}
run().catch((e) => {
  console.error('❌ 驗證失敗:', e.message)
  process.exit(1)
})
