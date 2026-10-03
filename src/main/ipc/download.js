/** 下載 IPC:多連線下載 / 暫停 / 續傳 / 停止 / 已下載實檢 / 開啟資料夾。 */
import { shell } from 'electron'
import {
  startDownload,
  pauseDownload,
  resumeDownload,
  cancelDownload,
  checkDownloaded,
  listResumable,
  setProgressSink
} from '../telegram/downloadManager.js'

export function registerDownload(ipcMain, ctx) {
  // 進度/狀態事件統一推給目前視窗
  setProgressSink((payload) => {
    const w = ctx?.getWindow?.()
    if (w && !w.isDestroyed()) w.webContents.send('download:progress', payload)
  })

  ipcMain.handle('download:single', async (_e, { dialogId, msgId }) => {
    try {
      return await startDownload(dialogId, msgId)
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('download:pause', (_e, { dialogId, msgId }) => pauseDownload(dialogId, msgId))
  ipcMain.handle('download:resume', (_e, { dialogId, msgId }) => resumeDownload(dialogId, msgId))
  ipcMain.handle('download:cancel', (_e, { dialogId, msgId }) => cancelDownload(dialogId, msgId))
  ipcMain.handle('download:check', (_e, { dialogId, msgIds }) => ({
    ok: true,
    map: checkDownloaded(dialogId, msgIds)
  }))

  // 開機還原的可續傳清單(供通知中心種子)
  ipcMain.handle('download:pending', () => listResumable())

  ipcMain.handle('download:reveal', (_e, { path }) => {
    if (path) shell.showItemInFolder(path)
    return { ok: true }
  })

  ipcMain.handle('shell:openPath', (_e, { path }) => {
    if (path) shell.openPath(path)
    return { ok: true }
  })

  // 用系統瀏覽器開外部連結(共享媒體的「連結」分頁)。只放行 http(s),
  // 別讓 file:// / javascript: 這種東西從渲染層被丟進 shell。
  ipcMain.handle('shell:openExternal', (_e, { url }) => {
    const s = String(url || '')
    if (!/^https?:\/\//i.test(s)) return { ok: false, error: '只支援 http/https 連結' }
    shell.openExternal(s)
    return { ok: true }
  })
}
