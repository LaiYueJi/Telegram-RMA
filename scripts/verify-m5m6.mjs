/**
 * 驗證 M5 轉發 + M6 自動化(真帳號,最小副作用,全程只動「我的收藏」)。
 *
 *  M5 批量轉發:用 client.forwardMessages(target,{messages,fromPeer,dropAuthor}) —— 與 app 的
 *     forward.js 完全同一條 API 路徑 —— 把一則自測訊息轉發到 Saved Messages,確認到達。
 *
 *  M6 自動化:
 *    ① NewMessage 事件可掛載並即時觸發(新訊息自動下載的核心,與 automation.js 同樣 new NewMessage({}))
 *    ② iterMessages({ minId }) 增量補抓(catchUp 漏接補抓機制)
 *    ③ node-cron 排程可被觸發(排程批量下載的觸發器)
 *
 *  不發任何訊息到他人對話;所有自測訊息測完一律 revoke 刪除。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import nodeCron from 'node-cron'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { getDisplayName } from 'telegram/Utils.js'
import { NewMessage } from 'telegram/events/index.js'

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

// 設定:新識別名優先,回退舊資料夾
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
if (!cfg || !cfg.session) {
  console.error('找不到 session,請先在 app 登入')
  process.exit(1)
}
const apiId = cfg.credentials?.apiId || 2040
const apiHash = cfg.credentials?.apiHash || 'b18441a1ff607e10a989891a5462e627'

function buildProxy(p) {
  if (!p) return undefined
  return p.type === 'mtproto'
    ? { ip: p.ip, port: Number(p.port), MTProxy: true, secret: normSecret(p.secret) }
    : { ip: p.ip, port: Number(p.port), socksType: Number(p.socksType) || 5, username: p.username || undefined, password: p.password || undefined }
}

// 連線候選:啟用代理(若有)→ 直連 → 第一個設定的代理。逐一嘗試直到連上。
const active = (cfg.proxies || []).find((p) => p.id === cfg.activeProxyId)
const candidates = []
if (active) candidates.push({ label: `代理 ${active.ip}:${active.port}`, proxy: buildProxy(active) })
candidates.push({ label: '直連', proxy: undefined })
const first = (cfg.proxies || [])[0]
if (first && first.id !== cfg.activeProxyId) candidates.push({ label: `代理 ${first.ip}:${first.port}`, proxy: buildProxy(first) })

async function connect() {
  for (const c of candidates) {
    const client = new TelegramClient(new StringSession(cfg.session), Number(apiId), String(apiHash), {
      connectionRetries: 2,
      useWSS: false,
      proxy: c.proxy
    })
    client.setLogLevel('none')
    try {
      await Promise.race([
        client.connect(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('逾時')), 20000))
      ])
      if (await client.isUserAuthorized()) {
        console.log(`連線方式:${c.label} ✅`)
        return client
      }
      await client.disconnect()
    } catch (e) {
      console.log(`連線方式:${c.label} ✗ (${e.message})`)
      try {
        await client.disconnect()
      } catch {
        /* ignore */
      }
    }
  }
  throw new Error('所有連線方式都失敗(請在 app 設定並啟用代理後重試)')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TAG_PREFIX = 'Telegram-RMA-自測-'

/** 掃描「我的收藏」近期訊息,刪掉所有自測訊息(含先前殘留)。回刪除筆數。 */
async function purgeSelfTests(client) {
  const ids = []
  for await (const m of client.iterMessages('me', { limit: 80 })) {
    if ((m.message || '').includes(TAG_PREFIX)) ids.push(Number(m.id))
  }
  if (ids.length) {
    try {
      await client.deleteMessages('me', ids, { revoke: true })
    } catch {
      /* ignore */
    }
  }
  return ids.length
}

const run = async () => {
  const client = await connect()
  const me = await client.getMe()
  console.log('帳號:', getDisplayName(me), '\n')

  // 先清掉任何先前殘留的自測訊息
  const purgedBefore = await purgeSelfTests(client)
  if (purgedBefore) console.log(`(清理先前殘留自測訊息 ${purgedBefore} 則)\n`)

  let pass = 0
  let fail = 0
  const ok = (b, msg) => {
    console.log((b ? '  ✅ ' : '  ❌ ') + msg)
    b ? pass++ : fail++
  }

  const tag = TAG_PREFIX + Math.floor(Date.now() / 1000)

  // ===== M6 ① 即時更新管道 + NewMessage 監聽可掛載 =====
  // 註:Telegram 不會把「自己送出的訊息」以 updateNewMessage 回送給自己,故自送無法觸發
  // NewMessage;真正的「新訊息自動下載」是針對別人/頻道的新訊息。這裡驗證底層即時更新管道
  // 確實在運作(送訊息時 raw update 計數 > 0),以及 app 用的 NewMessage({}) 可正常掛載/卸載。
  console.log('=== M6 ① 即時更新管道 + NewMessage 監聽 ===')
  let rawCount = 0
  const rawCb = () => rawCount++
  client.addEventHandler(rawCb)
  const sent = await client.sendMessage('me', { message: tag + ' #M6' })
  for (let i = 0; i < 15 && rawCount === 0; i++) await sleep(300)
  client.removeEventHandler(rawCb)
  ok(rawCount > 0, `送出訊息後即時收到 ${rawCount} 筆伺服器更新(自動化監聽的更新管道在運作)`)

  let attachOk = true
  try {
    const nmCb = () => {}
    client.addEventHandler(nmCb, new NewMessage({}))
    client.removeEventHandler(nmCb, new NewMessage({}))
  } catch (e) {
    attachOk = false
    console.log('    掛載錯誤:' + e.message)
  }
  ok(attachOk, 'NewMessage({}) 監聽可掛載/卸載(automation.js 監聽新訊息所用)')

  // ===== M5 轉發(client.forwardMessages,與 forward.js 同路徑)=====
  console.log('\n=== M5 批量轉發(forwardMessages,與 forward.js 同路徑)===')
  let topBefore = 0
  for await (const m of client.iterMessages('me', { limit: 1 })) topBefore = Number(m.id)
  let fwdId = null
  try {
    await client.forwardMessages('me', { messages: [sent.id], fromPeer: 'me', dropAuthor: true })
    // 不依賴回傳形狀:轉發後讀回最新,找出新出現、含同樣 tag、且非原訊息者
    for await (const m of client.iterMessages('me', { limit: 5 })) {
      if (Number(m.id) > topBefore && (m.message || '').includes(tag) && Number(m.id) !== sent.id) {
        fwdId = Number(m.id)
        break
      }
    }
    ok(!!fwdId, `轉發成功 → 我的收藏新增訊息 #${fwdId ?? '—'}(dropAuthor=true 去來源標記)`)
  } catch (e) {
    ok(false, '轉發失敗:' + e.message)
  }

  // ===== M6 ② iterMessages minId 增量補抓 =====
  console.log('\n=== M6 ② iterMessages({ minId }) 增量補抓(catchUp 漏接補抓)===')
  const baseId = sent.id - 1
  const newer = []
  for await (const m of client.iterMessages('me', { minId: baseId, limit: 20 })) newer.push(Number(m.id))
  ok(newer.includes(sent.id), `minId=${baseId} 補抓到自測訊息(共 ${newer.length} 則 > 基準)`)

  // ===== M6 ③ node-cron 排程觸發 =====
  console.log('\n=== M6 ③ node-cron 排程觸發(排程批量下載觸發器)===')
  ok(nodeCron.validate('0 * * * *'), 'cron 表達式校驗:0 * * * * (每小時)有效')
  let ticks = 0
  const job = nodeCron.schedule('* * * * * *', () => ticks++) // 每秒
  await sleep(2600)
  job.stop()
  ok(ticks >= 1, `每秒排程在 ~2.5s 內觸發 ${ticks} 次`)

  // ===== 清理自測訊息 =====
  console.log('\n=== 清理自測訊息(revoke)===')
  const purged = await purgeSelfTests(client)
  console.log(`  已刪除 ${purged} 則自測訊息`)

  await client.disconnect()
  console.log(`\n結果:${pass} 通過 / ${fail} 失敗`)
  console.log(fail === 0 ? '✅ M5 轉發 + M6 自動化 後端驗證通過' : '⚠ 有項目未通過,見上方')
  process.exit(fail === 0 ? 0 : 1)
}

run().catch((e) => {
  console.error('❌ 驗證失敗:', e.message)
  process.exit(1)
})
