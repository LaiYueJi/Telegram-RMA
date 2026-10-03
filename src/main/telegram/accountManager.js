/**
 * 多帳號協調器:列出 / 切換 / 新增 / 取消新增 / 移除帳號。
 * 採「單一 active client」模型 —— 一次只連一個帳號。切換 = 斷線 → 重置快取/自動化 →
 * 換 activeAccountId → 用新帳號 session 重連 → 重裝自動化。把所有時序鎖在 main,前端只發一個 IPC。
 *
 * 憑證與代理為全域共用(不做 per-account)。
 */
import { config } from '../store/config.js'
import * as tg from './client.js'
import { resetAutomation, initAutomation, purgeAccountData } from './automation.js'
import { clearCaches } from './dialogs.js'
import { clearRawCache } from './messages.js'
import { hasActiveDownloadTasks } from './batchDownload.js'
import { hasActiveForwardTasks } from './forward.js'

/** 「新增帳號」開始前的 active 帳號,供取消時還原。 */
let addReturnTo = null

/** 切換/新增前的忙碌檢查:登入流程進行中或有進行中任務則擋下(避免寫錯帳號 / 下載落錯帳號)。 */
function checkBusy() {
  if (tg.isAuthInFlight()) {
    return { ok: false, busy: true, error: '登入流程進行中,請先完成或取消' }
  }
  if (hasActiveDownloadTasks() || hasActiveForwardTasks()) {
    return { ok: false, busy: true, error: '有進行中的下載/轉發任務,請先暫停或等待完成再切換' }
  }
  return null
}

export function listAccounts() {
  const activeId = config.getActiveAccountId()
  return config.getAccounts().map((a) => ({
    id: a.id,
    user: a.user || null,
    phone: a.phone || (a.user && a.user.phone) || '',
    active: a.id === activeId,
    type: a.type || 'direct',
    label: a.label || '',
    note: a.note || '',
    tags: a.tags || [],
    importedFormat: a.importedFormat || '',
    health: a.health || null,
    hasSession: !!a.session
  }))
}

/** 重置快取/自動化 → 斷舊 client → 用目前 active 帳號重連 → (連上才)重裝自動化。 */
async function reconnectActive() {
  resetAutomation()
  clearCaches()
  clearRawCache()
  await tg.disconnectClient()
  const r = await tg.autoConnect().catch(() => ({ authorized: false }))
  if (tg.isReady()) initAutomation()
  return r
}

export async function switchAccount(id) {
  const busy = checkBusy()
  if (busy) return busy
  if (!config.getAccounts().find((a) => a.id === id)) return { ok: false, error: '帳號不存在' }
  if (id === config.getActiveAccountId() && tg.isReady()) return { ok: true }
  config.setActiveAccountId(id)
  await reconnectActive()
  return { ok: true }
}

/** 開始新增帳號:斷開目前帳號、建立空 placeholder 並設為 active,讓登入流程寫進這個新帳號。 */
export async function beginAddAccount() {
  const busy = checkBusy()
  if (busy) return busy
  addReturnTo = config.getActiveAccountId()
  resetAutomation()
  clearCaches()
  clearRawCache()
  await tg.disconnectClient()
  const id = config.addAccountPlaceholder()
  return { ok: true, id }
}

/** 取消新增:精準刪掉空 placeholder、還原先前 active 並重連。 */
export async function cancelAddAccount() {
  config.removeEmptyAccount(config.getActiveAccountId()) // 只刪空的(已登入有 session 就不動)
  const accounts = config.getAccounts()
  const back = accounts.find((a) => a.id === addReturnTo) ? addReturnTo : accounts[0]?.id ?? null
  config.setActiveAccountId(back)
  addReturnTo = null
  await reconnectActive()
  return { ok: true }
}

export async function removeAccount(id) {
  const activeId = config.getActiveAccountId()
  purgeAccountData(id) // 清該帳號的自動化規則與 offsets
  if (id === activeId) {
    await tg.logout() // 真正 LogOut + 斷線 + client=null(會清空該帳號 session)
    config.removeAccount(id) // active 自動 fallback 第一個
    if (config.getActiveAccountId()) {
      await reconnectActive()
    } else {
      resetAutomation()
      clearCaches()
      clearRawCache()
    }
  } else {
    config.removeAccount(id) // 非 active:只從本機移除(不連去做 server logout)
  }
  return { ok: true }
}
