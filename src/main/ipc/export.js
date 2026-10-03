/** 文本導出 IPC。 */
import { dialog } from 'electron'
import { join } from 'node:path'
import { exportRows, exportDialogToFile } from '../telegram/exporter.js'
import { config } from '../store/config.js'

export function registerExport(ipcMain, ctx) {
  ipcMain.handle('export:pickSave', async (_e, { defaultName, format } = {}) => {
    const w = ctx.getWindow()
    const ext = format || 'xlsx'
    const res = await dialog.showSaveDialog(w, {
      defaultPath: join(config.getPaths().saveRoot || '', `${defaultName || 'export'}.${ext}`),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    })
    if (res.canceled || !res.filePath) return { canceled: true }
    return { canceled: false, path: res.filePath }
  })

  ipcMain.handle('export:rows', async (_e, { rows, format, outPath, meta }) => {
    try {
      return await exportRows({ rows, format, outPath, meta: meta || {} })
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('export:dialog', async (_e, params) => {
    try {
      return await exportDialogToFile(params || {})
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })
}
