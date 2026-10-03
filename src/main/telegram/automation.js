/**
 * 自動化:① 新訊息自動下載(監聽 NewMessage,符合規則即下載,增量記 offset)
 *        ② 排程批量下載(node-cron 到點建立批量下載任務)。
 * 規則存 db automations;offset 存 db offsets。
 */
import nodeCron from 'node-cron'
import { NewMessage } from 'telegram/events/index.js'
import { getPeerId } from 'telegram/Utils.js'
import { getClient } from './client.js'
import { getCachedEntity, getCachedTitle } from './dialogs.js'
import { getMediaInfo } from './media.js'
import { cacheRawMessages } from './messages.js'
import { startDownload } from './downloadManager.js'
import { createDownloadTask } from './batchDownload.js'
import { db } from '../store/db.js'
import { config } from '../store/config.js'

let handlerInstalled = false
const cronJobs = new Map() // ruleId → ScheduledTask

/** 目前 active 帳號的規則(跨帳號隔離:只回本帳號的)。 */
function getRules() {
  const activeId = config.getActiveAccountId() || null
  return (db.get('automations') || []).filter((r) => (r.accountId || null) === activeId)
}
/** 寫回本帳號規則,其他帳號的規則原樣保留。 */
function saveRules(rules) {
  const activeId = config.getActiveAccountId() || null
  const others = (db.get('automations') || []).filter((r) => (r.accountId || null) !== activeId)
  db.set('automations', [...others, ...rules])
}
function genId() {
  return 'a' + Math.random().toString(36).slice(2, 9) + ((db.get('automations') || []).length || 0)
}

/** offsets key 加 accountId 前綴,避免跨帳號同 dialogId 衝突。 */
function offKey(dialogId) {
  return (config.getActiveAccountId() || '') + ':' + dialogId
}
function bumpOffset(dialogId, msgId) {
  const offsets = db.get('offsets') || {}
  const k = offKey(dialogId)
  if (!offsets[k] || msgId > offsets[k]) {
    offsets[k] = msgId
    db.set('offsets', offsets)
  }
}

function passRule(msg, f = {}) {
  if (msg.className === 'MessageService' || msg.action) return false
  const media = getMediaInfo(msg)
  if (!media) return false // 自動下載只處理媒體
  const text = msg.message || ''
  if (f.keyword && !text.includes(f.keyword)) return false
  if (f.types?.length && !f.types.includes(media.kind)) return false
  if (f.minSize && (media.size || 0) < f.minSize) return false
  if (f.maxSize && media.size && media.size > f.maxSize) return false
  return true
}

// —— 新訊息事件 ——
async function onNewMessage(event) {
  try {
    const msg = event.message
    if (!msg) return
    let did
    try {
      did = getPeerId(msg.peerId).toString()
    } catch {
      return
    }
    const rules = getRules().filter((r) => r.enabled && r.type === 'newmsg' && String(r.dialogId) === did)
    if (!rules.length) return
    let matched = false
    for (const r of rules) {
      if (passRule(msg, r.filter)) {
        matched = true
        break
      }
    }
    if (matched) {
      cacheRawMessages(did, [msg])
      startDownload(did, Number(msg.id)).catch(() => {})
    }
    bumpOffset(did, Number(msg.id))
  } catch {
    /* ignore */
  }
}

/** 首次啟用記錄當前最新 id;之後補抓自上次後的新訊息。 */
async function catchUp(rule) {
  const entity = getCachedEntity(rule.dialogId)
  if (!entity) return // 對話未載入,略過補抓(live 事件仍會運作)
  const client = getClient()
  const offsets = db.get('offsets') || {}
  const lastId = offsets[offKey(rule.dialogId)] || 0
  if (!lastId) {
    let latest = 0
    for await (const m of client.iterMessages(entity, { limit: 1 })) latest = Number(m.id)
    bumpOffset(rule.dialogId, latest)
    return
  }
  const news = []
  for await (const m of client.iterMessages(entity, { minId: lastId, limit: 200 })) news.push(m)
  news.sort((a, b) => a.id - b.id)
  for (const m of news) {
    if (passRule(m, rule.filter)) {
      cacheRawMessages(rule.dialogId, [m])
      startDownload(rule.dialogId, Number(m.id)).catch(() => {})
    }
    bumpOffset(rule.dialogId, Number(m.id))
  }
}

// —— cron 排程 ——
function scheduleCron(rule) {
  if (!rule.cron || !nodeCron.validate(rule.cron)) return
  unscheduleCron(rule.id)
  const job = nodeCron.schedule(rule.cron, () => {
    createDownloadTask({
      title: `[排程] ${rule.name || rule.dialogTitle}`,
      dialogId: rule.dialogId,
      dialogTitle: rule.dialogTitle,
      filter: rule.filter || {},
      output: rule.output || {}
    })
  })
  cronJobs.set(rule.id, job)
}
function unscheduleCron(id) {
  const job = cronJobs.get(id)
  if (job) {
    try {
      job.stop()
    } catch {
      /* ignore */
    }
    cronJobs.delete(id)
  }
}

function applyRule(rule) {
  if (!rule.enabled) return
  if (rule.type === 'cron') scheduleCron(rule)
  else if (rule.type === 'newmsg') catchUp(rule).catch(() => {})
}
function unapplyRule(rule) {
  if (rule.type === 'cron') unscheduleCron(rule.id)
  // newmsg 靠 enabled 旗標即時生效,無需額外動作
}

/** 回填升級前無 accountId 的舊規則 → 目前 active 帳號(只在有舊規則時動)。 */
function backfillRuleAccountIds() {
  const all = db.get('automations') || []
  const activeId = config.getActiveAccountId() || null
  let changed = false
  for (const r of all) {
    if (r.accountId === undefined) {
      r.accountId = activeId
      changed = true
    }
  }
  if (changed) db.set('automations', all)
}

// —— 啟動初始化 ——
export function initAutomation() {
  const client = getClient()
  if (!client || !client.connected) return
  backfillRuleAccountIds()
  if (!handlerInstalled) {
    try {
      client.addEventHandler(onNewMessage, new NewMessage({}))
      handlerInstalled = true
    } catch {
      /* ignore */
    }
  }
  for (const r of getRules()) applyRule(r)
}

/** 切換帳號前:停掉所有 cron、讓 NewMessage handler 可重裝(舊 handler 隨舊 client 丟棄)。 */
export function resetAutomation() {
  for (const job of cronJobs.values()) {
    try {
      job.stop()
    } catch {
      /* ignore */
    }
  }
  cronJobs.clear()
  handlerInstalled = false
}

/** 移除某帳號的所有自動化規則與 offsets(移除帳號時用)。 */
export function purgeAccountData(accountId) {
  const id = accountId || null
  db.set(
    'automations',
    (db.get('automations') || []).filter((r) => (r.accountId || null) !== id)
  )
  const offsets = db.get('offsets') || {}
  const prefix = (accountId || '') + ':'
  let changed = false
  for (const k of Object.keys(offsets)) {
    if (k.startsWith(prefix)) {
      delete offsets[k]
      changed = true
    }
  }
  if (changed) db.set('offsets', offsets)
}

// —— CRUD ——
export function listRules() {
  return getRules()
}
export function createRule(cfg) {
  const rules = getRules()
  const rule = {
    id: genId(),
    accountId: config.getActiveAccountId() || null,
    name: cfg.name || '',
    enabled: cfg.enabled !== false,
    type: cfg.type === 'cron' ? 'cron' : 'newmsg',
    dialogId: String(cfg.dialogId || ''),
    dialogTitle: cfg.dialogTitle || getCachedTitle(cfg.dialogId),
    filter: cfg.filter || {},
    output: cfg.output || {},
    cron: cfg.cron || '',
    createdAt: cfg.createdAt || 0
  }
  if (rule.type === 'cron' && !nodeCron.validate(rule.cron)) {
    return { ok: false, error: 'cron 表達式無效(例:0 * * * * 每小時)' }
  }
  if (!rule.dialogId) return { ok: false, error: '請選擇對話' }
  rules.push(rule)
  saveRules(rules)
  applyRule(rule)
  return { ok: true, id: rule.id }
}
export function updateRule(id, patch) {
  const rules = getRules()
  const i = rules.findIndex((r) => r.id === id)
  if (i < 0) return { ok: false }
  unapplyRule(rules[i])
  rules[i] = { ...rules[i], ...patch }
  saveRules(rules)
  applyRule(rules[i])
  return { ok: true }
}
export function toggleRule(id, enabled) {
  return updateRule(id, { enabled: !!enabled })
}
export function removeRule(id) {
  const rules = getRules()
  const r = rules.find((x) => x.id === id)
  if (r) unapplyRule(r)
  saveRules(rules.filter((x) => x.id !== id))
  return { ok: true }
}
