/** 任務台 IPC:批量下載 + 批量轉發,統一列表與控制(依 id 分派)。 */
import {
  createDownloadTask,
  listTasks as listDl,
  taskDetail as dlDetail,
  pauseTask as dlPause,
  resumeTask as dlResume,
  cancelTask as dlCancel,
  retryFailedTask as dlRetry,
  removeTask as dlRemove,
  setTaskSink as setDlSink,
  initTasks
} from '../telegram/batchDownload.js'
import {
  createForwardTask,
  listForwardTasks,
  forwardDetail,
  pauseForward,
  resumeForward,
  cancelForward,
  removeForward,
  hasTask as fwHas,
  setForwardSink,
  initForwardTasks
} from '../telegram/forward.js'

export function registerTasks(ipcMain, ctx) {
  initTasks()
  initForwardTasks()

  const send = (payload) => {
    const w = ctx?.getWindow?.()
    if (w && !w.isDestroyed()) w.webContents.send('task:update', payload)
  }
  setDlSink(send)
  setForwardSink(send)

  ipcMain.handle('tasks:list', () => ({
    ok: true,
    tasks: [...listDl(), ...listForwardTasks()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }))

  ipcMain.handle('tasks:createDownload', (_e, cfg) => {
    try {
      return createDownloadTask(cfg || {})
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })
  ipcMain.handle('tasks:createForward', (_e, cfg) => {
    try {
      return createForwardTask(cfg || {})
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('tasks:detail', (_e, { id }) => (fwHas(id) ? forwardDetail(id) : dlDetail(id)))
  ipcMain.handle('tasks:pause', (_e, { id }) => (fwHas(id) ? pauseForward(id) : dlPause(id)))
  ipcMain.handle('tasks:resume', (_e, { id }) => (fwHas(id) ? resumeForward(id) : dlResume(id)))
  ipcMain.handle('tasks:cancel', (_e, { id }) => (fwHas(id) ? cancelForward(id) : dlCancel(id)))
  ipcMain.handle('tasks:retry', async (_e, { id }) => {
    if (fwHas(id)) return { ok: false, error: '轉發任務不支援重試' }
    try {
      return await dlRetry(id)
    } catch (e) {
      return { ok: false, error: String(e?.message || e) }
    }
  })
  ipcMain.handle('tasks:remove', (_e, { id, deleteFiles }) =>
    fwHas(id) ? removeForward(id) : dlRemove(id, { deleteFiles: !!deleteFiles })
  )
}
