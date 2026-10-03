/**
 * GramJS TelegramClient 封裝。
 * 單例:整個 main process 共用一個 client。
 * 負責:依設定(憑證 + session + 啟用代理)建立 client、登入狀態機、session 持久化。
 */
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { computeCheck } from 'telegram/Password.js'
import { config } from '../store/config.js'
import { DEFAULT_CREDENTIALS } from './appCredentials.js'
import { FakeTlsSocket } from './fakeTlsSocket.js'
import { resetSenderPool } from './senderPool.js'
import { resetDownloadWorker } from './downloadManager.js'

/** @type {TelegramClient|null} */
let client = null
/** 登入流程暫存 */
let pending = { phoneNumber: '', phoneCodeHash: '' }
/** 掃碼登入時等待 2FA 密碼的 resolver */
let qrPasswordResolver = null
/** 登入流程進行中(主要保護 qrLogin 等掃碼長連線)→ 切換/新增帳號時擋下 */
let authInFlight = false

export function isAuthInFlight() {
  return authInFlight
}

/**
 * 取得實際要用的 api 憑證:使用者自填優先,否則用內建預設(免申請)。
 * @returns {{apiId:number, apiHash:string, custom:boolean}}
 */
export function resolveCredentials() {
  const c = config.getCredentials()
  if (c && c.apiId && c.apiHash) {
    return { apiId: Number(c.apiId), apiHash: String(c.apiHash), custom: true }
  }
  return { apiId: DEFAULT_CREDENTIALS.apiId, apiHash: DEFAULT_CREDENTIALS.apiHash, custom: false }
}

/**
 * 正規化 MTProto secret 成 GramJS 接受的 hex(16 bytes,或 dd+16=17 bytes)。
 * 支援 base64 / base64url;FakeTLS(ee+16+domain)會降級取 16-byte 純 secret(去掉 TLS 偽裝)。
 */
export function normalizeMtprotoSecret(raw) {
  if (!raw) return raw
  const s = String(raw).trim()
  if (/^[0-9a-f]+$/i.test(s) && s.length % 2 === 0) return s.toLowerCase() // 已是 hex
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4) b64 += '='
  let bytes
  try {
    bytes = Buffer.from(b64, 'base64')
  } catch {
    return s
  }
  if (!bytes.length) return s
  if (bytes[0] === 0xdd && bytes.length >= 17) return bytes.subarray(0, 17).toString('hex') // dd+16 保留
  if (bytes[0] === 0xee && bytes.length >= 17) return bytes.subarray(1, 17).toString('hex') // FakeTLS → 純 16
  if (bytes.length >= 16) return bytes.subarray(0, 16).toString('hex')
  return bytes.toString('hex')
}

/**
 * 判斷 MTProto secret 是否為 FakeTLS(ee 開頭,偽裝 TLS + 內嵌域名)。
 * GramJS 只支援 16-byte 純 secret 或 dd+16(secret mode),完全不支援 FakeTLS;
 * 這類代理 TCP 連得上但 MTProto 握手必失敗 → 資料層全部載不出來。
 */
export function isFakeTlsSecret(raw) {
  if (!raw) return false
  const s = String(raw).trim()
  if (/^[0-9a-f]+$/i.test(s) && s.length % 2 === 0) {
    return s.slice(0, 2).toLowerCase() === 'ee'
  }
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4) b64 += '='
  try {
    const bytes = Buffer.from(b64, 'base64')
    return bytes.length >= 17 && bytes[0] === 0xee
  } catch {
    return false
  }
}

/** 把 secret(hex 或 base64url)解成位元組。 */
function decodeSecretBytes(raw) {
  const s = String(raw).trim()
  if (/^[0-9a-f]+$/i.test(s) && s.length % 2 === 0) return Buffer.from(s, 'hex')
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4) b64 += '='
  return Buffer.from(b64, 'base64')
}

/** 拆解 FakeTLS secret:ee(1) + 16-byte 內層 secret + 偽裝域名。 */
export function parseFakeTlsSecret(raw) {
  const bytes = decodeSecretBytes(raw)
  return { secret16: bytes.subarray(1, 17), domain: bytes.subarray(17) }
}

/**
 * 把設定裡的代理轉成 GramJS proxy 物件。
 * @returns {object|undefined}
 */
export function buildProxy() {
  const p = config.getActiveProxy()
  if (!p) return undefined
  if (p.type === 'mtproto') {
    // FakeTLS(ee):走自訂的 FakeTlsSocket(buildClient 會據 fakeTls 旗標注入 networkSocket)
    if (isFakeTlsSecret(p.secret)) {
      const { secret16, domain } = parseFakeTlsSecret(p.secret)
      return {
        ip: p.ip,
        port: Number(p.port),
        MTProxy: true,
        secret: secret16.toString('hex'), // 內層混淆 + FakeTLS HMAC 共用此 16-byte secret
        tlsDomain: domain.toString('hex'),
        fakeTls: true,
        timeout: 15
      }
    }
    return {
      ip: p.ip,
      port: Number(p.port),
      MTProxy: true,
      secret: normalizeMtprotoSecret(p.secret),
      timeout: 15
    }
  }
  // socks
  return {
    ip: p.ip,
    port: Number(p.port),
    socksType: Number(p.socksType) || 5,
    username: p.username || undefined,
    password: p.password || undefined,
    timeout: 15
  }
}

/**
 * 建立(或重建)client 實例,不自動連線。
 * @param {{freshLogin?:boolean}} [opts] freshLogin=true:全新登入用【空】session,且不讀、不覆寫已存的 session
 *   (登入成功才由呼叫端 config.setSession 寫回)。避免舊寫法 `config.setSession('')` 在登入尚未成功前
 *   就把現有登入清空,一旦當下連不上又重啟即被 migrateAccounts 剪掉 = 被迫重登。
 */
export function createClient({ freshLogin = false } = {}) {
  const { apiId, apiHash } = resolveCredentials()
  const session = new StringSession(freshLogin ? '' : config.getSession() || '')
  const proxy = buildProxy()
  const opts = {
    connectionRetries: 5,
    useWSS: false,
    autoReconnect: true,
    proxy,
    deviceModel: 'Telegram-RMA',
    systemVersion: process.platform,
    appVersion: '0.1.0'
  }
  // FakeTLS 代理:注入自訂 socket 做偽 TLS 握手 + TLS record 封裝
  if (proxy && proxy.fakeTls) opts.networkSocket = FakeTlsSocket
  client = new TelegramClient(session, Number(apiId), String(apiHash), opts)
  try {
    client.setLogLevel('none')
  } catch {
    /* 某些版本無此方法,忽略 */
  }
  return client
}

/** 取得現有 client,沒有就建立。 */
export function getClient() {
  if (!client) createClient()
  return client
}

/**
 * 建一個「獨立」的 client 實例(不指派給單例 client、不改動全域狀態),
 * 供對「非 active 帳號」做操作(導入驗證 / 健康檢測 / 改資料 / 2FA / 踢裝置)。
 * 使用目前全域憑證與啟用代理;session 由參數指定。呼叫端負責 connect / disconnect。
 * @param {string} sessionStr GramJS / Telethon session 字串
 */
export function createEphemeralClient(sessionStr) {
  const { apiId, apiHash } = resolveCredentials()
  const session = new StringSession(sessionStr || '') // 格式非法會丟 'Not a valid string'
  const proxy = buildProxy()
  const opts = {
    connectionRetries: 3,
    useWSS: false,
    autoReconnect: false,
    proxy,
    deviceModel: 'Telegram-RMA',
    systemVersion: process.platform,
    appVersion: '0.1.0'
  }
  if (proxy && proxy.fakeTls) opts.networkSocket = FakeTlsSocket
  const c = new TelegramClient(session, Number(apiId), String(apiHash), opts)
  try {
    c.setLogLevel('none')
  } catch {
    /* 某些版本無此方法,忽略 */
  }
  return c
}

/** 對獨立 client 連線並加逾時保護(避免代理失效永久卡住)。 */
export async function connectEphemeral(c, ms = 20000) {
  return Promise.race([
    c.connect(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('連線逾時(代理可能無法使用)')), ms))
  ])
}

/** 是否已存在已連線且授權的 client。 */
export function isReady() {
  return !!(client && client.connected)
}

/**
 * 啟動時嘗試自動登入:有憑證 + session 才連。
 * @returns {Promise<{authorized:boolean, user?:object}>}
 */
/** 開機自動連線是否還在進行中 —— 前端別在連線完成前就把使用者踢去登入頁。
    ⚠ 用 var:這個檔案上面就會賦值,let/const 有 TDZ 會直接 ReferenceError。 */
var autoConnecting = false
export function isAutoConnecting() {
  return autoConnecting
}

export async function autoConnect() {
  if (!config.getSession()) return { authorized: false }
  autoConnecting = true
  try {
    createClient()
    let authorized
    try {
      authorized = await connectWithTimeout()
    } catch {
      // 代理在啟動時連線逾時:回未授權,讓 UI 進入但提示需檢查代理,而非永久卡住
      return { authorized: false, error: '連線逾時(代理可能無法使用)' }
    }
    if (!authorized) return { authorized: false }
    const user = await safeGetMe()
    return { authorized: true, user }
  } finally {
    autoConnecting = false // 不管成功失敗都要放行,否則前端會一直等
  }
}

/** 連線並加逾時保護,避免代理失效時永久卡住。 */
async function connectWithTimeout(ms = 15000) {
  return Promise.race([
    client.connect(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('連線逾時(代理可能無法使用)')), ms))
  ])
}

/** 重建 client(代理或憑證變更後呼叫),若原本已連線則重連。 */
export async function rebuildAndReconnect() {
  const shouldConnect = isReady() || !!config.getSession()
  resetSenderPool() // 下載多連線池綁在舊 client/舊代理上,必須一併丟棄
  resetDownloadWorker() // 下載 worker 綁在舊 session/舊代理上,一併收掉(下次下載以新設定重建)
  try {
    if (client) await client.disconnect()
  } catch {
    /* ignore */
  }
  // 徹底丟棄舊 client,避免殘留的 DC sender 仍走舊代理導致資料層卡死
  client = null
  createClient()
  if (!shouldConnect) return { ok: true, authorized: false, user: null }
  try {
    await connectWithTimeout()
    // 用一次實際資料請求驗證連線真的能通(僅連上 socket 不代表資料層 OK,代理常卡在這)
    const user = await Promise.race([
      safeGetMe(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('連線已建立但無法取得資料(代理可能阻擋 Telegram 資料層)')), 15000))
    ])
    return { ok: true, authorized: !!user, user }
  } catch (e) {
    return { ok: false, authorized: false, user: null, error: String(e.message || e) }
  }
}

async function safeGetMe() {
  try {
    const me = await client.getMe()
    const user = normalizeUser(me)
    persistActiveUser(user)
    return user
  } catch {
    return null
  }
}

/** 把 user 快照寫回目前 active 帳號,讓帳號下拉不必連線也能顯示名字。 */
function persistActiveUser(user) {
  const id = config.getActiveAccountId()
  if (user && id) config.setAccountUser(id, user)
}

/** 斷線並丟棄目前 client(不 LogOut、不清 session),供切換/新增帳號前重置。 */
export async function disconnectClient() {
  authInFlight = false
  resetSenderPool()
  resetDownloadWorker()
  try {
    if (client) await client.disconnect()
  } catch {
    /* ignore */
  }
  client = null
}

/**
 * 量測「目前活連線」的 MTProto 往返延遲(ms),未連線回 -1。
 * 用一次極輕量的 RPC(help.getNearestDc)走完整路徑:你→代理→DC→代理→你,
 * 與官方客戶端顯示的延遲同定義 —— 比 tcpPing(只到代理門口的冷握手)準得多。
 */
export async function pingActive() {
  if (!client || !client.connected) return -1
  const t = Date.now()
  try {
    await client.invoke(new Api.help.GetNearestDc())
    return Date.now() - t
  } catch {
    return -1
  }
}

/** 把 GramJS user 物件正規化成可序列化的純資料。 */
export function normalizeUser(me) {
  if (!me) return null
  return {
    id: me.id?.toString?.() ?? String(me.id),
    firstName: me.firstName || '',
    lastName: me.lastName || '',
    username: me.username || '',
    phone: me.phone || '',
    premium: !!me.premium
  }
}

/** 寄送登入驗證碼。 */
export async function sendCode(phoneNumber) {
  const { apiId, apiHash } = resolveCredentials()
  // 全新登入:用空 session 的 client(不清掉已存的 session,登入成功才寫回)
  createClient({ freshLogin: true })
  await client.connect()
  const result = await client.sendCode({ apiId, apiHash }, phoneNumber)
  pending = { phoneNumber, phoneCodeHash: result.phoneCodeHash }
  return { ok: true, isCodeViaApp: !!result.isCodeViaApp }
}

/**
 * 掃碼登入。會反覆透過 onToken 回傳 tg://login?token=... 連結讓前端畫 QR;
 * 使用者用手機 Telegram 掃描後 promise 解析。需要 2FA 時透過 onNeedPassword 通知前端,
 * 前端再呼叫 submitQrPassword()。
 * @param {(url:string)=>void} onToken
 * @param {()=>void} onNeedPassword
 */
export async function qrLogin(onToken, onNeedPassword) {
  authInFlight = true
  try {
  const { apiId, apiHash } = resolveCredentials()
  // 空 session 的 client 跑掃碼流程,不清掉已存的 session(掃碼成功才 config.setSession 寫回)
  createClient({ freshLogin: true })
  await client.connect()
  const user = await client.signInUserWithQrCode(
    { apiId, apiHash },
    {
      qrCode: async (code) => {
        const token = Buffer.isBuffer(code.token) ? code.token : Buffer.from(code.token)
        const b64url = token
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '')
        onToken('tg://login?token=' + b64url)
      },
      password: async () => {
        onNeedPassword()
        return await new Promise((resolve) => {
          qrPasswordResolver = resolve
        })
      },
      onError: (err) => {
        // 回傳 false 讓 GramJS 繼續嘗試(token 過期會自動換新);真正致命錯誤會 reject
        console.error('[qrLogin]', err?.message || err)
        return false
      }
    }
  )
  config.setSession(client.session.save())
  const u = normalizeUser(user)
  persistActiveUser(u)
  return u
  } finally {
    authInFlight = false
  }
}

/** 掃碼流程中提交 2FA 密碼。 */
export function submitQrPassword(password) {
  if (qrPasswordResolver) {
    qrPasswordResolver(String(password))
    qrPasswordResolver = null
    return true
  }
  return false
}

/**
 * 用驗證碼登入。
 * @returns {Promise<{ok:boolean, needPassword?:boolean, user?:object}>}
 */
export async function signIn(code) {
  if (!client) throw new Error('請先取得驗證碼')
  try {
    const res = await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: pending.phoneNumber,
        phoneCodeHash: pending.phoneCodeHash,
        phoneCode: String(code)
      })
    )
    config.setSession(client.session.save())
    return { ok: true, user: normalizeUser(res.user) }
  } catch (e) {
    if (String(e.message || e).includes('SESSION_PASSWORD_NEEDED')) {
      return { ok: false, needPassword: true }
    }
    throw e
  }
}

/** 兩步驗證:用密碼登入。 */
export async function checkPassword(password) {
  if (!client) throw new Error('登入流程未開始')
  const pwd = await client.invoke(new Api.account.GetPassword())
  const check = await computeCheck(pwd, String(password))
  const res = await client.invoke(new Api.auth.CheckPassword({ password: check }))
  config.setSession(client.session.save())
  return { ok: true, user: normalizeUser(res.user) }
}

/** 登出並清除本機 session。 */
export async function logout() {
  resetSenderPool()
  resetDownloadWorker()
  try {
    if (client) await client.invoke(new Api.auth.LogOut())
  } catch {
    /* ignore */
  }
  try {
    if (client) await client.disconnect()
  } catch {
    /* ignore */
  }
  config.setSession('')
  client = null
  return { ok: true }
}

/** 目前狀態快照。 */
export async function getStatus() {
  const creds = resolveCredentials()
  let authorized = false
  let user = null
  if (client && client.connected) {
    user = await safeGetMe()
    authorized = !!user
  }
  return {
    hasCredentials: true, // 內建預設,永遠可用
    customCredentials: creds.custom,
    connected: !!(client && client.connected),
    authorized,
    connecting: autoConnecting, // 還在嘗試自動連線 → 前端要等,不要當成未登入
    // 本機仍存有 session(= 只是連不上、不是登出)。登入頁據此改顯示「重新連線」而非自動掃碼清 session。
    hasSession: !!config.getSession(),
    user,
    activeProxy: config.getActiveProxy()
  }
}
