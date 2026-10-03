/**
 * 協議號 / 直登號 帳號工具箱。
 *
 * 「協議號」= 以既有 session 字串(GramJS / Telethon 原生格式)導入的帳號 —— 免手機驗證碼。
 * 「直登號」= 走手機驗證碼 / QR 登入的帳號(既有流程,見 client.js)。
 *
 * 設計:一次只連一個「active」帳號(單例 client)。本模組對帳號做養護操作時:
 *   - 若目標就是 active 且已連線 → 直接用單例 client(不另開連線)。
 *   - 否則 → 用 createEphemeralClient() 開一個「獨立、不觸碰單例」的臨時 client,
 *     操作完 finally 內斷線。臨時 client 與單例 client 互不影響。
 */
import { Api } from 'telegram'
import { CustomFile } from 'telegram/client/uploads.js'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../store/config.js'
import * as tg from './client.js'

function nowSec() {
  return Math.floor(Date.now() / 1000)
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 把 Telegram RPC 錯誤轉成可讀的中文訊息。 */
function humanizeErr(e) {
  const m = String((e && e.message) || e || '')
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED/.test(m))
    return 'session 已失效或帳號被封禁'
  const flood = m.match(/FLOOD_WAIT_(\d+)/)
  if (flood) return `操作過於頻繁,請等待約 ${flood[1]} 秒後再試`
  if (/USERNAME_OCCUPIED/.test(m)) return '用戶名已被占用'
  if (/USERNAME_INVALID/.test(m)) return '用戶名格式不正確(5–32 字元、僅字母數字底線)'
  if (/USERNAME_NOT_MODIFIED|PROFILE.*NOT_MODIFIED/.test(m)) return '資料未變更'
  if (/PASSWORD_HASH_INVALID/.test(m)) return '目前的兩步驗證密碼錯誤'
  if (/連線逾時/.test(m)) return '連線逾時(代理可能無法使用)'
  if (/Not a valid string/.test(m)) return 'session 格式不正確(需 GramJS / Telethon 字串)'
  return m || '未知錯誤'
}

/**
 * 取得可用於操作某帳號的 client 並執行 fn。
 * active 且已連線 → 用單例;否則開臨時 client,操作後斷線。
 * @param {string} id
 * @param {(c:import('telegram').TelegramClient, ephemeral:boolean)=>Promise<any>} fn
 */
async function withClient(id, fn) {
  const activeId = config.getActiveAccountId()
  if (id === activeId && tg.isReady()) {
    return await fn(tg.getClient(), false)
  }
  const acc = config.getAccount(id)
  if (!acc || !acc.session) throw new Error('帳號不存在或沒有可用 session')
  const c = tg.createEphemeralClient(acc.session)
  try {
    await tg.connectEphemeral(c)
    return await fn(c, true)
  } finally {
    try {
      await c.disconnect()
    } catch {
      /* ignore */
    }
    try {
      await c.destroy()
    } catch {
      /* ignore */
    }
  }
}

// ---------------- @SpamBot 檢測 ----------------

/** 依 @SpamBot 回覆文字歸類帳號狀態。保留原文由前端顯示,避免誤判即當結論。 */
function classifySpam(text) {
  const t = String(text || '').toLowerCase()
  if (!t) return 'unknown'
  if (/banned|deleted|blocked|terminated|封禁|封號|已刪除|已封/.test(t)) return 'bad'
  if (/no limits|good news|free as a bird|not limited|no restrictions|沒有.*限制|未受限|一切正常/.test(t))
    return 'ok'
  if (/limited|restricted|will be able|is limited|until|受限|限制|凍結/.test(t)) return 'warn'
  return 'unknown'
}

/** 向 @SpamBot 送 /start 讀最新回覆做限制檢測。 */
async function checkSpam(c) {
  try {
    await c.sendMessage('SpamBot', { message: '/start' })
    await sleep(2500)
    const msgs = await c.getMessages('SpamBot', { limit: 1 })
    const text = (msgs && msgs[0] && (msgs[0].message || msgs[0].text)) || ''
    return { state: classifySpam(text), text }
  } catch {
    return { state: 'unknown', text: '' }
  }
}

// ---------------- 導入 ----------------

/**
 * 導入單筆協議號(session 字串)。用臨時 client 連線驗證 → getMe → 正規化存檔。
 * 不干擾目前 active client。
 */
export async function importSession({ session, label = '', note = '' }) {
  const raw = String(session || '').trim()
  if (!raw) return { ok: false, error: 'session 為空' }
  // Telethon 字串:版本字元後 base64 長度為 352(見 GramJS StringSession 建構子)
  const format = raw.length === 353 ? 'telethon' : 'gramjs'
  let c
  try {
    c = tg.createEphemeralClient(raw) // 格式非法會丟 'Not a valid string'
  } catch (e) {
    return { ok: false, error: humanizeErr(e) }
  }
  try {
    await tg.connectEphemeral(c)
    const me = await c.getMe()
    if (!me) return { ok: false, error: '此 session 未授權或已失效' }
    const user = tg.normalizeUser(me)
    const existing = config.findAccountByUserId(user.id)
    if (existing) {
      return {
        ok: false,
        duplicate: true,
        error: `此帳號已在清單中(${user.username ? '@' + user.username : user.id})`
      }
    }
    const savedSession = c.session.save() // Telethon → 正規化成 GramJS 字串
    const id = config.addProtocolAccount({
      session: savedSession,
      user,
      label,
      note,
      importedFormat: format
    })
    return { ok: true, id, user }
  } catch (e) {
    return { ok: false, error: humanizeErr(e) }
  } finally {
    try {
      await c.disconnect()
    } catch {
      /* ignore */
    }
    try {
      await c.destroy()
    } catch {
      /* ignore */
    }
  }
}

/**
 * 批量導入:一行一個 session,序列化導入(避免同時大量連線),透過 onProgress 回報逐筆結果。
 * @param {string} text
 * @param {(p:{index:number,total:number,ok:boolean,error?:string,user?:object})=>void} [onProgress]
 */
export async function importSessionsBatch(text, onProgress) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  const total = lines.length
  const results = []
  let ok = 0
  for (let i = 0; i < total; i++) {
    const r = await importSession({ session: lines[i] })
    if (r.ok) ok++
    results.push({ index: i, ...r })
    onProgress?.({ index: i, total, ok: r.ok, error: r.error, user: r.user })
  }
  return { ok: true, total, succeeded: ok, failed: total - ok, results }
}

/** 匯出帳號的 GramJS session 字串(免連線,直接讀本機)。 */
export function exportSession(id) {
  const acc = config.getAccount(id)
  if (!acc || !acc.session) return { ok: false, error: '此帳號沒有可匯出的 session' }
  return { ok: true, session: acc.session, type: acc.type || 'direct' }
}

// ---------------- 健康檢測 ----------------

/** 對單一帳號做健康檢測:getMe + DC + 2FA + 裝置數 + SpamBot,寫回 health 快照。 */
export async function healthCheck(id) {
  try {
    const health = await withClient(id, async (c) => {
      const me = await c.getMe()
      if (!me) throw new Error('AUTH_KEY_UNREGISTERED')
      const user = tg.normalizeUser(me)
      config.setAccountUser(id, user)

      let dc = null
      try {
        dc = c.session.dcId ?? null
      } catch {
        /* ignore */
      }

      let has2fa = null
      try {
        const pwd = await c.invoke(new Api.account.GetPassword())
        has2fa = !!pwd.hasPassword
      } catch {
        /* ignore */
      }

      let sessionsCount = null
      try {
        const auths = await c.invoke(new Api.account.GetAuthorizations())
        sessionsCount = auths.authorizations ? auths.authorizations.length : null
      } catch {
        /* ignore */
      }

      const spam = await checkSpam(c)
      return {
        state: spam.state, // 'ok' | 'warn' | 'bad' | 'unknown'
        dc,
        has2fa,
        sessionsCount,
        spamText: spam.text,
        checkedAt: nowSec()
      }
    })
    config.setAccountMeta(id, { health })
    return { ok: true, health }
  } catch (e) {
    const health = { state: 'bad', dc: null, has2fa: null, sessionsCount: null, spamText: '', checkedAt: nowSec() }
    config.setAccountMeta(id, { health })
    return { ok: false, error: humanizeErr(e), health }
  }
}

/** 批量健康檢測(序列化)。onProgress 回報逐一結果。 */
export async function healthCheckAll(ids, onProgress) {
  const list = Array.isArray(ids) && ids.length ? ids : config.getAccounts().map((a) => a.id)
  const total = list.length
  for (let i = 0; i < total; i++) {
    const r = await healthCheck(list[i])
    onProgress?.({ index: i, total, id: list[i], ok: r.ok, health: r.health })
  }
  return { ok: true, total }
}

// ---------------- 改資料 ----------------

/**
 * 一鍵改資料:名字 / 姓氏 / 簡介 / 用戶名 / 頭像。逐項容錯。
 * 只傳你想改的欄位;username 傳空字串會清除用戶名。
 */
export async function setProfile(id, { firstName, lastName, bio, username, avatarPath } = {}) {
  return await withClient(id, async (c) => {
    const done = []
    if (firstName !== undefined || lastName !== undefined || bio !== undefined) {
      await c.invoke(
        new Api.account.UpdateProfile({
          firstName: firstName !== undefined ? String(firstName) : undefined,
          lastName: lastName !== undefined ? String(lastName) : undefined,
          about: bio !== undefined ? String(bio) : undefined
        })
      )
      done.push('profile')
    }
    if (username !== undefined && username !== null) {
      try {
        await c.invoke(new Api.account.UpdateUsername({ username: String(username).trim() }))
        done.push('username')
      } catch (e) {
        throw new Error('用戶名設定失敗:' + humanizeErr(e))
      }
    }
    if (avatarPath && fs.existsSync(avatarPath)) {
      const st = fs.statSync(avatarPath)
      const toUpload = new CustomFile(path.basename(avatarPath), st.size, avatarPath)
      const inputFile = await c.uploadFile({ file: toUpload, workers: 1 })
      await c.invoke(new Api.photos.UploadProfilePhoto({ file: inputFile }))
      done.push('avatar')
    }
    const me = await c.getMe().catch(() => null)
    if (me) config.setAccountUser(id, tg.normalizeUser(me))
    return { ok: true, done }
  }).catch((e) => ({ ok: false, error: humanizeErr(e) }))
}

// ---------------- 兩步驗證 ----------------

/**
 * 設定 / 修改 / 移除兩步驗證密碼。
 * - 初次設定:只給 newPassword(+ 選填 hint)。
 * - 修改:給 current(舊)+ newPassword(新)。
 * - 移除:給 current + newPassword 留空。
 */
export async function setTwoFa(id, { current = '', newPassword = '', hint = '' } = {}) {
  return await withClient(id, async (c) => {
    await c.updateTwoFaSettings({
      currentPassword: current || undefined,
      newPassword: newPassword || undefined,
      hint: hint || undefined
    })
    const acc = config.getAccount(id)
    const health = { ...(acc?.health || {}), has2fa: !!newPassword }
    config.setAccountMeta(id, { health })
    return { ok: true, has2fa: !!newPassword }
  }).catch((e) => ({ ok: false, error: humanizeErr(e) }))
}

// ---------------- 裝置與安全 ----------------

/** 踢掉其他所有已登入裝置(防賣家收回協議號)。回踢完後的剩餘裝置數。 */
export async function terminateOthers(id) {
  return await withClient(id, async (c) => {
    await c.invoke(new Api.auth.ResetAuthorizations())
    let sessionsCount = null
    try {
      const auths = await c.invoke(new Api.account.GetAuthorizations())
      sessionsCount = auths.authorizations ? auths.authorizations.length : null
    } catch {
      /* ignore */
    }
    const acc = config.getAccount(id)
    const health = { ...(acc?.health || {}), sessionsCount }
    config.setAccountMeta(id, { health })
    return { ok: true, sessionsCount }
  }).catch((e) => ({ ok: false, error: humanizeErr(e) }))
}

/** 更新帳號標註(標籤/備註/類型等)。 */
export function setMeta(id, patch) {
  const ok = config.setAccountMeta(id, patch || {})
  return { ok }
}
