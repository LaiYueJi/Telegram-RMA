/** 登入相關 IPC。 */
import { config } from '../store/config.js'
import * as tg from '../telegram/client.js'
import { getSelfAvatar } from '../telegram/dialogs.js'
import {
  listAccounts,
  switchAccount,
  beginAddAccount,
  cancelAddAccount,
  removeAccount
} from '../telegram/accountManager.js'

export function registerAuth(ipcMain) {
  // 目前登入帳號自己的頭像(data URL),供標題列等處顯示
  ipcMain.handle('auth:avatar', async () => {
    try {
      return { ok: true, ...(await getSelfAvatar()) }
    } catch {
      // 例外 = 這次沒抓到,不代表沒有頭像 → 讓前端可以重試
      return { ok: true, dataUrl: null, hasPhoto: false, retriable: true }
    }
  })

  // ---- 多帳號 ----
  ipcMain.handle('auth:list', () => ({ ok: true, accounts: listAccounts() }))
  ipcMain.handle('auth:switch', async (_e, { id }) => {
    try {
      return await switchAccount(id)
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })
  ipcMain.handle('auth:beginAdd', async () => {
    try {
      return await beginAddAccount()
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })
  ipcMain.handle('auth:cancelAdd', async () => {
    try {
      return await cancelAddAccount()
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })
  ipcMain.handle('auth:remove', async (_e, { id }) => {
    try {
      return await removeAccount(id)
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('auth:getCredentials', () => {
    const c = config.getCredentials()
    // apiHash 不直接回傳明文長度以外資訊也無妨,這裡照原樣回(本機應用)
    return { apiId: c.apiId, apiHash: c.apiHash }
  })

  ipcMain.handle('auth:setCredentials', (_e, { apiId, apiHash }) => {
    config.setCredentials({ apiId: Number(apiId), apiHash: String(apiHash).trim() })
    return { ok: true }
  })

  ipcMain.handle('auth:status', async () => {
    return await tg.getStatus()
  })

  ipcMain.handle('auth:autoConnect', async () => {
    try {
      return await tg.autoConnect()
    } catch (e) {
      return { authorized: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('auth:sendCode', async (_e, { phoneNumber }) => {
    try {
      return await tg.sendCode(String(phoneNumber).trim())
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('auth:signIn', async (_e, { code }) => {
    try {
      return await tg.signIn(code)
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('auth:checkPassword', async (_e, { password }) => {
    try {
      return await tg.checkPassword(password)
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  // 掃碼登入:開始後透過事件推送 QR token;完成才回傳結果
  ipcMain.handle('auth:qrStart', async (e) => {
    const send = (channel, payload) => {
      if (!e.sender.isDestroyed()) e.sender.send(channel, payload)
    }
    try {
      const user = await tg.qrLogin(
        (url) => send('auth:qrToken', { url }),
        () => send('auth:qrNeedPassword', {})
      )
      return { ok: true, user }
    } catch (err) {
      return { ok: false, error: String(err.message || err) }
    }
  })

  ipcMain.handle('auth:qrSubmitPassword', (_e, { password }) => {
    return { ok: tg.submitQrPassword(password) }
  })

  ipcMain.handle('auth:logout', async () => {
    return await tg.logout()
  })
}
