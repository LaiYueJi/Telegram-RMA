/**
 * 系統匣(工作列右下角)圖示。
 * 關閉視窗時可以選擇「縮到系統匣」繼續在背景跑下載,從這裡叫回主視窗或真正結束。
 */
import { Tray, Menu, nativeImage, app } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** @type {Tray|null} */
let tray = null

function iconPath() {
  // electron-builder.yml 的 files 有帶 resources/,打包後會在 app.asar/resources 下
  return join(__dirname, '../../resources/icon.ico')
}

/**
 * 建立系統匣圖示(重複呼叫只會建一次)。
 * @param {{show:Function, quit:Function, hasActive:Function}} handlers
 */
export function ensureTray(handlers) {
  if (tray && !tray.isDestroyed()) return tray
  let img
  try {
    img = nativeImage.createFromPath(iconPath())
  } catch {
    img = nativeImage.createEmpty()
  }
  if (img.isEmpty()) {
    // 圖示讀不到就用一顆藍點,總比整個系統匣功能壞掉好
    img = nativeImage.createFromDataURL(
      'data:image/svg+xml;base64,' +
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7" fill="#5b6cff"/></svg>'
        ).toString('base64')
    )
  }
  tray = new Tray(img)
  tray.setToolTip('Telegram 資源管理助手')

  const menu = Menu.buildFromTemplate([
    { label: '顯示主視窗', click: () => handlers.show() },
    { type: 'separator' },
    { label: '結束', click: () => handlers.quit() }
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => handlers.show())
  tray.on('double-click', () => handlers.show())
  return tray
}

/** 縮到系統匣時提示一次(Windows 的氣泡通知)。 */
export function notifyMinimized() {
  if (!tray || tray.isDestroyed()) return
  try {
    tray.displayBalloon({
      title: 'Telegram 資源管理助手',
      content: '已縮到系統匣,下載會繼續在背景進行。點圖示可叫回視窗。'
    })
  } catch {
    /* 某些 Windows 版本不支援氣泡,忽略 */
  }
}

export function destroyTray() {
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
}

/** 系統匣圖示是否存在。 */
export function hasTray() {
  return !!(tray && !tray.isDestroyed())
}

// app 結束時確保圖示消失(否則 Windows 會殘留一個死圖示)
app.on('before-quit', () => destroyTray())
