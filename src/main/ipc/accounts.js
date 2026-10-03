/** 協議號 / 直登號 帳號工具箱 IPC。 */
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../store/config.js'
import {
  importSession,
  importSessionsBatch,
  exportSession,
  healthCheck,
  healthCheckAll,
  setProfile,
  setTwoFa,
  terminateOthers,
  setMeta
} from '../telegram/protocolAccounts.js'
import { sessionToTdata, tdataToSession } from '../telegram/tdataConvert.js'

/** 轉換錯誤轉可讀中文。 */
function humanizeConvertErr(e) {
  const m = String((e && e.message) || e || '')
  if (/passcode|local key|decrypt|MAC/i.test(m)) return 'tdata 讀取失敗:可能設有本機密碼,或資料夾不正確'
  if (/Invalid session|version/i.test(m)) return 'session 格式不正確(需 GramJS 字串)'
  if (/ENOENT|no such file|key_datas?/i.test(m)) return '找不到 tdata(請選擇含 key_datas 的 tdata 資料夾)'
  return m || '轉換失敗'
}

/** 供輸出 tdata 用的乾淨、不覆蓋既有的資料夾名。 */
function uniqueTdataDir(baseDir, label) {
  const safe = String(label || 'tdata').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'tdata'
  let dir = path.join(baseDir, safe === 'tdata' ? 'tdata' : 'tdata_' + safe)
  let i = 2
  while (fs.existsSync(dir)) dir = path.join(baseDir, (safe === 'tdata' ? 'tdata' : 'tdata_' + safe) + '_' + i++)
  return dir
}

export function registerAccounts(ipcMain) {
  const guard = (fn) => async (...args) => {
    try {
      return await fn(...args)
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  // 導入單筆協議號
  ipcMain.handle(
    'accounts:import',
    guard((_e, { session, label, note }) => importSession({ session, label, note }))
  )

  // 批量導入:透過 accounts:progress 事件回報逐筆進度
  ipcMain.handle(
    'accounts:importBatch',
    guard((e, { text }) => {
      const send = (payload) => {
        if (!e.sender.isDestroyed()) e.sender.send('accounts:progress', { kind: 'import', ...payload })
      }
      return importSessionsBatch(text, send)
    })
  )

  // 匯出 session
  ipcMain.handle(
    'accounts:export',
    guard((_e, { id }) => exportSession(id))
  )

  // 單一健康檢測
  ipcMain.handle(
    'accounts:health',
    guard((_e, { id }) => healthCheck(id))
  )

  // 批量健康檢測
  ipcMain.handle(
    'accounts:healthAll',
    guard((e, { ids }) => {
      const send = (payload) => {
        if (!e.sender.isDestroyed()) e.sender.send('accounts:progress', { kind: 'health', ...payload })
      }
      return healthCheckAll(ids, send)
    })
  )

  // 改資料
  ipcMain.handle(
    'accounts:setProfile',
    guard((_e, { id, profile }) => setProfile(id, profile))
  )

  // 兩步驗證
  ipcMain.handle(
    'accounts:setTwoFa',
    guard((_e, { id, params }) => setTwoFa(id, params))
  )

  // 踢其他裝置
  ipcMain.handle(
    'accounts:terminateOthers',
    guard((_e, { id }) => terminateOthers(id))
  )

  // 更新標註
  ipcMain.handle(
    'accounts:setMeta',
    guard((_e, { id, patch }) => setMeta(id, patch))
  )

  // 協議號 → 直登號(tdata):session 或帳號 id 皆可,outDir 為使用者選的父資料夾
  ipcMain.handle('accounts:sessionToTdata', async (_e, { session, accountId, outDir }) => {
    try {
      let gram = session
      let label = 'tdata'
      if (accountId) {
        const acc = config.getAccount(accountId)
        if (!acc || !acc.session) return { ok: false, error: '帳號不存在或無 session' }
        gram = acc.session
        label = acc.user?.username || acc.phone || acc.user?.id || 'tdata'
      }
      if (!gram || !String(gram).trim()) return { ok: false, error: '沒有可轉換的 session' }
      if (!outDir) return { ok: false, error: '未選擇輸出資料夾' }
      const target = uniqueTdataDir(outDir, label)
      return await sessionToTdata(gram, target)
    } catch (e) {
      return { ok: false, error: humanizeConvertErr(e) }
    }
  })

  // 直登號(tdata)→ 協議號:回 session 字串
  ipcMain.handle('accounts:tdataToSession', async (_e, { tdataDir, accountIdx }) => {
    try {
      if (!tdataDir) return { ok: false, error: '未選擇 tdata 資料夾' }
      return await tdataToSession(tdataDir, accountIdx || 0)
    } catch (e) {
      return { ok: false, error: humanizeConvertErr(e) }
    }
  })
}
