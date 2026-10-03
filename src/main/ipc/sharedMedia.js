/** 共享媒體(照片/影片/檔案/音訊/連結/語音/GIF/置頂)+ 共同群組 + 禮物 IPC。 */
import {
  SHARED_KINDS,
  getCounters,
  listMedia,
  getCalendar,
  scanPolls,
  cancelPollScan,
  getCommonChats,
  getGifts
} from '../telegram/sharedMedia.js'

export function registerSharedMedia(ipcMain) {
  ipcMain.handle('shared:kinds', () => ({ ok: true, kinds: SHARED_KINDS }))

  ipcMain.handle('shared:counters', async (_e, { dialogId }) => {
    try {
      return { ok: true, counters: await getCounters(dialogId) }
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('shared:list', async (_e, { dialogId, kind, offsetId, limit }) => {
    try {
      return { ok: true, ...(await listMedia(dialogId, kind, { offsetId, limit })) }
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('shared:calendar', async (_e, { dialogId, kind, offsetId }) => {
    try {
      return { ok: true, ...(await getCalendar(dialogId, kind, { offsetId })) }
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  // 投票只能掃歷史 → 過程用事件回報進度,讓 UI 不會像當掉
  ipcMain.handle('shared:scanPolls', async (e, { dialogId, maxScan }) => {
    const send = (p) => {
      if (!e.sender.isDestroyed()) e.sender.send('shared:pollProgress', { dialogId, ...p })
    }
    try {
      return { ok: true, ...(await scanPolls(dialogId, { maxScan, onProgress: send })) }
    } catch (err) {
      return { ok: false, error: String(err.message || err) }
    }
  })

  ipcMain.handle('shared:cancelPollScan', (_e, { dialogId }) => {
    cancelPollScan(dialogId)
    return { ok: true }
  })

  ipcMain.handle('shared:commonChats', async (_e, { peerId, limit }) => {
    try {
      return { ok: true, chats: await getCommonChats(peerId, { limit }) }
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('shared:gifts', async (_e, { peerId, offset, limit }) => {
    try {
      return { ok: true, ...(await getGifts(peerId, { offset, limit })) }
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })
}
