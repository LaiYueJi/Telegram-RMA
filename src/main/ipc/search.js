/** 消息檢索 IPC。 */
import { searchMessages } from '../telegram/search.js'

export function registerSearch(ipcMain) {
  ipcMain.handle('search:run', async (_e, params) => {
    try {
      return await searchMessages(params || {})
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })
}
