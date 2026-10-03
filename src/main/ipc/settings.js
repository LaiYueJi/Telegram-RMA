/** 系統設定 IPC:偏好 / 路徑 / 選資料夾 / 緩存資訊與清理 / 資料匯入匯出。 */
import { dialog, app } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../store/config.js'
import { db } from '../store/db.js'

const DATA_KEYS = ['downloadTasks', 'forwardTasks', 'automations', 'offsets']

/** 遞迴算資料夾大小與檔案數。 */
async function dirStat(dir) {
  let size = 0
  let files = 0
  async function walk(d) {
    let entries
    try {
      entries = await fsp.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const full = join(d, ent.name)
      if (ent.isDirectory()) await walk(full)
      else {
        try {
          const st = await fsp.stat(full)
          size += st.size
          files += 1
        } catch {
          /* ignore */
        }
      }
    }
  }
  await walk(dir)
  return { size, files }
}

export function registerSettings(ipcMain, ctx) {
  ipcMain.handle('settings:getPreferences', () => config.getPreferences())
  ipcMain.handle('settings:setPreferences', (_e, prefs) => {
    config.setPreferences(prefs)
    return config.getPreferences()
  })

  ipcMain.handle('settings:getPaths', () => config.getPaths())
  ipcMain.handle('settings:setPaths', (_e, paths) => {
    config.setPaths(paths)
    return config.getPaths()
  })

  ipcMain.handle('settings:pickFolder', async (_e, { defaultPath } = {}) => {
    const w = ctx.getWindow()
    const res = await dialog.showOpenDialog(w, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath || undefined
    })
    if (res.canceled || !res.filePaths.length) return { canceled: true }
    return { canceled: false, path: res.filePaths[0] }
  })

  ipcMain.handle('settings:pickImage', async () => {
    const w = ctx.getWindow()
    const res = await dialog.showOpenDialog(w, {
      properties: ['openFile'],
      filters: [{ name: '圖片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
    })
    if (res.canceled || !res.filePaths.length) return { canceled: true }
    return { canceled: false, path: res.filePaths[0] }
  })

  ipcMain.handle('settings:cacheInfo', async () => {
    const dir = config.getPaths().cacheDir
    fs.mkdirSync(dir, { recursive: true })
    const { size, files } = await dirStat(dir)
    return { dir, size, files }
  })

  ipcMain.handle('settings:clearCache', async () => {
    const dir = config.getPaths().cacheDir
    try {
      await fsp.rm(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    fs.mkdirSync(dir, { recursive: true })
    return { ok: true }
  })

  ipcMain.handle('settings:appInfo', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  }))

  // 資料匯出:偏好 + 任務 + 自動化(不含 session/憑證/代理)
  ipcMain.handle('settings:exportData', async () => {
    const w = ctx.getWindow()
    const res = await dialog.showSaveDialog(w, {
      defaultPath: join(config.getPaths().saveRoot || '', 'tgff-data.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return { canceled: true }
    const data = { app: 'telegram-rma', preferences: config.getPreferences() }
    for (const k of DATA_KEYS) data[k] = db.get(k)
    await fsp.writeFile(res.filePath, JSON.stringify(data, null, 2), 'utf8')
    return { ok: true, path: res.filePath }
  })

  // 資料匯入:按 key 覆蓋(重啟後完全生效)
  ipcMain.handle('settings:importData', async () => {
    const w = ctx.getWindow()
    const res = await dialog.showOpenDialog(w, {
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePaths.length) return { canceled: true }
    try {
      const data = JSON.parse(await fsp.readFile(res.filePaths[0], 'utf8'))
      if (data.preferences) config.setPreferences(data.preferences)
      for (const k of DATA_KEYS) if (data[k] !== undefined) db.set(k, data[k])
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })
}
