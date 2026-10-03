/** 訊息流 IPC。 */
import {
  loadMessages,
  loadMessagesAround,
  loadOldestMessages,
  loadNewerMessages,
  getThumbDataUrl
} from '../telegram/messages.js'

export function registerMessages(ipcMain) {
  ipcMain.handle('messages:load', async (_e, { dialogId, limit, offsetId }) => {
    try {
      return { ok: true, ...(await loadMessages(dialogId, { limit, offsetId })) }
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('messages:loadAround', async (_e, { dialogId, msgId, limit }) => {
    try {
      return { ok: true, ...(await loadMessagesAround(dialogId, msgId, { limit })) }
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('messages:loadNewer', async (_e, { dialogId, offsetId, limit }) => {
    try {
      return { ok: true, ...(await loadNewerMessages(dialogId, { offsetId, limit })) }
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('messages:loadOldest', async (_e, { dialogId, limit }) => {
    try {
      return { ok: true, ...(await loadOldestMessages(dialogId, { limit })) }
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('messages:thumb', async (_e, { dialogId, msgId }) => {
    try {
      return { ok: true, dataUrl: await getThumbDataUrl(dialogId, msgId) }
    } catch {
      return { ok: true, dataUrl: null }
    }
  })
}
