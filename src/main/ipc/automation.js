/** 自動化 IPC:規則 CRUD。 */
import { listRules, createRule, updateRule, toggleRule, removeRule } from '../telegram/automation.js'

export function registerAutomation(ipcMain) {
  ipcMain.handle('automation:list', () => ({ ok: true, rules: listRules() }))
  ipcMain.handle('automation:create', (_e, cfg) => {
    try {
      return createRule(cfg || {})
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })
  ipcMain.handle('automation:update', (_e, { id, patch }) => updateRule(id, patch || {}))
  ipcMain.handle('automation:toggle', (_e, { id, enabled }) => toggleRule(id, enabled))
  ipcMain.handle('automation:remove', (_e, { id }) => removeRule(id))
}
