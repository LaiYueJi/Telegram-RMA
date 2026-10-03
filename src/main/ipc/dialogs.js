/** 對話清單 IPC。 */
import { loadDialogs, getAvatarDataUrl, getFolders, addDialogByUsername } from '../telegram/dialogs.js'

export function registerDialogs(ipcMain) {
  ipcMain.handle('dialogs:list', async (_e, opts = {}) => {
    try {
      return { ok: true, dialogs: await loadDialogs(opts) }
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('dialogs:folders', async () => {
    try {
      return { ok: true, folders: await getFolders() }
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('dialogs:avatar', async (_e, { peerId }) => {
    try {
      return { ok: true, dataUrl: await getAvatarDataUrl(peerId) }
    } catch {
      return { ok: true, dataUrl: null }
    }
  })

  ipcMain.handle('dialogs:addDialog', async (_e, { username } = {}) => {
    try {
      return { ok: true, added: await addDialogByUsername(username) }
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })
}
