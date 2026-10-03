/** 視窗控制(自繪標題列用):最小化 / 最大化還原 / 關閉。 */
export function registerWindow(ipcMain, ctx) {
  ipcMain.handle('win:minimize', () => ctx.getWindow()?.minimize())
  ipcMain.handle('win:maximize', () => {
    const w = ctx.getWindow()
    if (!w) return false
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
    return w.isMaximized()
  })
  ipcMain.handle('win:close', () => ctx.getWindow()?.close())
  ipcMain.handle('win:isMaximized', () => !!ctx.getWindow()?.isMaximized())
}
