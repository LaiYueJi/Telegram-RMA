/** Electron 主程序入口。 */
import { app, BrowserWindow, shell, protocol, dialog, ipcMain } from 'electron'
import fs from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initConfig, ensureDefaultPaths, config } from './store/config.js'
import { initDb } from './store/db.js'
import { registerIpc } from './ipc/index.js'
import * as tg from './telegram/client.js'
import { startSpeedmeter } from './net/speedmeter.js'
import { registerMediaProtocol, MEDIA_SCHEME } from './telegram/mediaServer.js'
import { initAutomation } from './telegram/automation.js'
import { restoreResumableParts } from './telegram/downloadManager.js'
import { createSplashWindow, splashShowLoader } from './splash.js'
import { ensureTray, notifyMinimized, destroyTray, hasTray } from './tray.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// 一次性遷移:舊識別名(tg-ff-open / televault)的設定 / 任務資料夾 → 目前識別名(trma),
// 讓改名後仍保留登入 session、代理與任務。只在新位置尚無檔案時複製。
try {
  const userData = app.getPath('userData')
  const parent = dirname(userData)
  for (const name of ['tgff-config.json', 'tgff-db.json']) {
    const to = join(userData, name)
    if (fs.existsSync(to)) continue
    for (const legacyDir of ['trma', 'televault', 'tg-ff-open']) {
      const from = join(parent, legacyDir, name)
      if (from.toLowerCase() === to.toLowerCase()) continue
      if (fs.existsSync(from)) {
        fs.mkdirSync(userData, { recursive: true })
        fs.copyFileSync(from, to)
        break
      }
    }
  }
} catch {
  /* 遷移失敗不影響啟動,最壞情況是需重新登入 */
}

// 早期讀設定:GPU 加速必須在 app ready 前決定
initConfig()
if (config.getPreferences().gpuAcceleration === 'off') {
  app.disableHardwareAcceleration()
}

// 自訂媒體串流協定須在 app ready 前註冊為特權 scheme(才能支援 Range/串流/fetch)
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true }
  }
])

// 單例鎖
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

/** @type {BrowserWindow|null} */
let mainWindow = null
/** @type {BrowserWindow|null} */
let splashWindow = null
/** 真的要結束了(從系統匣選單、before-quit 或使用者選「直接結束」)→ close 事件不再攔截 */
let isQuitting = false

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function quitApp() {
  isQuitting = true
  destroyTray()
  app.quit()
}

function hideToTray() {
  ensureTray({ show: showMainWindow, quit: quitApp })
  mainWindow?.hide()
  // 氣泡提示只在第一次縮到系統匣時跳一次,之後就別再吵(跟其他程式的行為一致)
  if (!config.getPreferences().trayHintShown) {
    notifyMinimized()
    config.setPreferences({ trayHintShown: true })
  }
}

/**
 * 請 renderer 顯示自繪的「關閉方式」對話框,等它回答。
 * renderer 沒回應(還沒載入 / 卡住)就退回系統原生對話框,至少不會關不掉。
 * @returns {Promise<{action:'tray'|'quit'|'cancel', remember:boolean}|null>}
 */
function askRendererClose() {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) return resolve(null)
    let settled = false
    let acked = false // renderer 已經把對話框顯示出來了
    const done = (v) => {
      if (settled) return
      settled = true
      ipcMain.removeHandler('win:closeAnswer')
      ipcMain.removeHandler('win:closeAck')
      resolve(v)
    }
    ipcMain.removeHandler('win:closeAnswer')
    ipcMain.removeHandler('win:closeAck')
    // renderer 一顯示對話框就先回報一聲,主程序才知道不用退回原生的。
    // (只等「答案」是不夠的 —— 使用者可能想很久,不能因此又跳一個原生視窗出來)
    ipcMain.handle('win:closeAck', () => {
      acked = true
      return true
    })
    ipcMain.handle('win:closeAnswer', (_e, ans) => {
      done(ans || { action: 'cancel', remember: false })
      return true
    })
    mainWindow.webContents.send('win:askClose')
    // 2.5 秒內沒收到「我已顯示」→ renderer 大概沒在聽,退回原生對話框
    setTimeout(async () => {
      if (settled || acked) return
      const r = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: '關閉 Telegram 資源管理助手',
        message: '要結束程式,還是縮到系統匣繼續在背景下載?',
        buttons: ['縮到系統匣', '直接結束', '取消'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
        checkboxLabel: '記住我的選擇,不再詢問'
      })
      done({
        action: r.response === 2 ? 'cancel' : r.response === 0 ? 'tray' : 'quit',
        remember: !!r.checkboxChecked
      })
    }, 2500)
  })
}

/**
 * 按 X 時的處理。回傳 true = 真的關閉。
 * closeAction:'ask' 每次問 / 'tray' 縮到系統匣 / 'quit' 直接結束
 */
async function handleWindowClose() {
  const prefs = config.getPreferences()
  let action = prefs.closeAction || 'ask'

  if (action === 'ask') {
    // 問畫面交給 renderer 自繪(系統原生對話框跟自繪標題列的介面不搭)
    const ans = await askRendererClose()
    if (!ans || ans.action === 'cancel') return false
    action = ans.action
    if (ans.remember) config.setPreferences({ closeAction: action })
  }

  if (action === 'tray' && prefs.trayEnabled !== false) {
    hideToTray()
    return false
  }
  isQuitting = true
  destroyTray()
  return true
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: false,
    frame: false, // 自繪標題列
    backgroundColor: '#0b1220',
    title: 'Telegram 資源管理助手',
    icon: join(__dirname, '../../resources/icon.png'), // 開發視窗/工作列圖示(打包後 Windows 用 exe 內嵌 .ico)
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 主視窗就緒 → 切 splash 到旋轉載入動畫 → 短暫延遲後顯示主視窗、關閉 splash
  mainWindow.on('ready-to-show', () => {
    splashShowLoader(splashWindow)
    setTimeout(() => {
      mainWindow?.show()
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close()
        splashWindow = null
      }
    }, 1200)
  })

  // 對外連結用系統瀏覽器開
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // 按 X:依設定決定要結束還是縮到系統匣(showMessageBox 是非同步,先攔下再自己收尾)
  mainWindow.on('close', (e) => {
    if (isQuitting) return
    e.preventDefault()
    handleWindowClose().then((reallyClose) => {
      if (reallyClose) mainWindow?.destroy()
    })
  })

  // 視窗最大化狀態變化 → 通知 renderer 更新按鈕圖示
  const sendMax = () => mainWindow?.webContents.send('win:maximized', mainWindow.isMaximized())
  mainWindow.on('maximize', sendMax)
  mainWindow.on('unmaximize', sendMax)

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  ensureDefaultPaths()
  restoreResumableParts() // 還原上次未完成、有進度檔的 .part(登記為可續傳);孤兒 .part 才清掉
  initDb()
  splashWindow = createSplashWindow() // 先顯示啟動畫面
  registerIpc({ getWindow: () => mainWindow })
  registerMediaProtocol() // 圖片/影片串流協定 tgmedia://
  createWindow()
  startSpeedmeter(() => mainWindow) // 每秒推播上/下行網速

  // 嘗試自動登入(有 session 才會連),連上後啟動自動化規則
  tg.autoConnect()
    .then(() => initAutomation())
    .catch(() => {})

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  showMainWindow() // 縮在系統匣時再開一次程式 → 直接叫回視窗
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  // 縮到系統匣時視窗是 hide 不是關閉,所以這裡只有真的關掉才會觸發;
  // 但保險起見,系統匣還在就不要結束(背景下載要繼續)。
  if (process.platform !== 'darwin' && !hasTray()) app.quit()
})
