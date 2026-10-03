/** 集中註冊所有 ipcMain handlers。 */
import { ipcMain } from 'electron'
import { registerAuth } from './auth.js'
import { registerProxy } from './proxy.js'
import { registerSettings } from './settings.js'
import { registerWindow } from './window.js'
import { registerDialogs } from './dialogs.js'
import { registerMessages } from './messages.js'
import { registerDownload } from './download.js'
import { registerTasks } from './tasks.js'
import { registerSearch } from './search.js'
import { registerExport } from './export.js'
import { registerAutomation } from './automation.js'
import { registerAccounts } from './accounts.js'
import { registerSharedMedia } from './sharedMedia.js'

/**
 * @param {{ getWindow: () => import('electron').BrowserWindow|null }} ctx
 */
export function registerIpc(ctx) {
  registerWindow(ipcMain, ctx)
  registerAuth(ipcMain, ctx)
  registerProxy(ipcMain, ctx)
  registerSettings(ipcMain, ctx)
  registerDialogs(ipcMain, ctx)
  registerMessages(ipcMain, ctx)
  registerDownload(ipcMain, ctx)
  registerTasks(ipcMain, ctx)
  registerSearch(ipcMain, ctx)
  registerExport(ipcMain, ctx)
  registerAutomation(ipcMain, ctx)
  registerAccounts(ipcMain, ctx)
  registerSharedMedia(ipcMain, ctx)
}
