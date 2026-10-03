/**
 * 批量轉發引擎(鏡像 batchDownload 的任務模式):掃描來源 → 分批 forwardMessages 到目標。
 * 可去來源標記(dropAuthor)。任務存 db forwardTasks;明細留記憶體。
 */
import { getClient } from './client.js'
import { getCachedEntity, getCachedTitle } from './dialogs.js'
import { getMediaInfo } from './media.js'
import { config } from '../store/config.js'
import { db } from '../store/db.js'

const CHUNK = 100 // Telegram 單次轉發上限
const EMIT_INTERVAL = 300

const tasks = new Map()
let sink = null
export function setForwardSink(fn) {
  sink = fn
}
export function hasTask(id) {
  return tasks.has(id)
}
/** 是否有進行中的轉發任務(切換/新增帳號前用來擋下)。 */
export function hasActiveForwardTasks() {
  return [...tasks.values()].some((t) => ['scanning', 'forwarding', 'queued'].includes(t.status))
}

function genId() {
  return 'f' + Math.random().toString(36).slice(2, 9) + (db.get('forwardTasks')?.length || 0)
}
function serialize(t) {
  return {
    id: t.id,
    kind: 'forward',
    accountId: t.accountId || null,
    title: t.title,
    dialogId: t.dialogId,
    dialogTitle: t.dialogTitle,
    targetId: t.targetId,
    targetTitle: t.targetTitle,
    dropAuthor: t.dropAuthor,
    filter: t.filter,
    status: t.status,
    error: t.error || '',
    stats: t.stats,
    createdAt: t.createdAt
  }
}
function persist() {
  db.set('forwardTasks', [...tasks.values()].map(serialize))
}
function emit(t, force = false) {
  const now = Date.now()
  if (!force && now - (t._lastEmit || 0) < EMIT_INTERVAL) return
  t._lastEmit = now
  sink?.(serialize(t))
  persist()
}

function makeRuntime(s) {
  return {
    ...s,
    stats: s.stats || { matched: 0, forwarded: 0, failed: 0, total: 0, current: [] },
    _ids: [],
    _success: [],
    _failed: [],
    _abort: false,
    _paused: false,
    _lastEmit: 0
  }
}

export function initForwardTasks() {
  for (const s of db.get('forwardTasks') || []) {
    const t = makeRuntime(s)
    if (['scanning', 'forwarding', 'queued'].includes(t.status)) t.status = 'interrupted'
    tasks.set(t.id, t)
  }
}
export function listForwardTasks() {
  return [...tasks.values()].map(serialize)
}
export function forwardDetail(id) {
  const t = tasks.get(id)
  if (!t) return { ok: false }
  return {
    ok: true,
    pending: t._ids.map((mid) => ({ msgId: mid, name: '#' + mid })),
    success: t._success,
    failed: t._failed
  }
}

function passForward(msg, f = {}) {
  if (msg.className === 'MessageService' || msg.action) return false
  if (f.startDate && msg.date < f.startDate) return false
  if (f.endDate && msg.date > f.endDate) return false
  const text = msg.message || ''
  if (f.keyword && !text.includes(f.keyword)) return false
  const media = getMediaInfo(msg)
  if (f.mediaOnly && !media) return false
  if (f.types?.length) {
    const okMedia = media && f.types.includes(media.kind)
    const okText = f.types.includes('text') && !media && text
    if (!okMedia && !okText) return false
  }
  return true
}

export function createForwardTask(cfg) {
  const source = getCachedEntity(cfg.dialogId)
  const target = getCachedEntity(cfg.targetId)
  if (!source) return { ok: false, error: '來源對話未載入' }
  if (!target) return { ok: false, error: '目標對話未載入(請在對話頁開啟過一次)' }

  const t = makeRuntime({
    id: genId(),
    kind: 'forward',
    accountId: config.getActiveAccountId() || null,
    title: cfg.title || `轉發 → ${cfg.targetTitle || getCachedTitle(cfg.targetId)}`,
    dialogId: String(cfg.dialogId),
    dialogTitle: cfg.dialogTitle || getCachedTitle(cfg.dialogId),
    targetId: String(cfg.targetId),
    targetTitle: cfg.targetTitle || getCachedTitle(cfg.targetId),
    dropAuthor: !!cfg.dropAuthor,
    filter: cfg.filter || {},
    status: 'queued',
    stats: { matched: 0, forwarded: 0, failed: 0, total: 0, current: [] },
    createdAt: cfg.createdAt || 0
  })
  t._single = Array.isArray(cfg.messageIds) ? cfg.messageIds.map(Number) : null
  tasks.set(t.id, t)
  emit(t, true)
  runForwardTask(t).catch((e) => {
    t.status = 'error'
    t.error = String(e?.message || e)
    emit(t, true)
  })
  return { ok: true, id: t.id }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function runForwardTask(t) {
  const client = getClient()
  if (!client.connected) {
    t.status = 'error'
    t.error = '尚未連線'
    emit(t, true)
    return
  }
  const source = getCachedEntity(t.dialogId)
  const target = getCachedEntity(t.targetId)

  // 收集要轉發的 id(single 模式直接用指定 id)
  if (t._single) {
    t._ids = t._single.slice()
  } else {
    t.status = 'scanning'
    emit(t, true)
    const cap = config.getPreferences().forwardLimit || 2000
    const opts = {}
    if (t.filter.keyword) opts.search = t.filter.keyword
    if (t.filter.endDate) opts.offsetDate = t.filter.endDate
    let scanned = 0
    const ids = []
    for await (const msg of client.iterMessages(source, opts)) {
      if (t._abort) return finishCanceled(t)
      scanned++
      if (scanned > 200000) break
      if (t.filter.startDate && msg.date < t.filter.startDate) break
      if (passForward(msg, t.filter)) ids.push(Number(msg.id))
      if (ids.length >= cap) break
      if (scanned % 200 === 0) {
        t.stats.matched = ids.length
        emit(t)
      }
    }
    ids.sort((a, b) => a - b) // 由舊到新,維持時間順序
    t._ids = ids
  }

  t.stats.matched = t._ids.length
  t.stats.total = t._ids.length
  if (!t._ids.length) {
    t.status = 'done'
    emit(t, true)
    return
  }

  t.status = 'forwarding'
  emit(t, true)
  const queue = t._ids.slice()
  while (queue.length) {
    if (t._abort) return finishCanceled(t)
    if (t._paused) {
      t.status = 'paused'
      emit(t, true)
      return
    }
    const chunk = queue.splice(0, CHUNK)
    let attempt = 0
    for (;;) {
      try {
        await client.forwardMessages(target, {
          messages: chunk,
          fromPeer: source,
          dropAuthor: t.dropAuthor
        })
        t.stats.forwarded += chunk.length
        for (const mid of chunk) t._success.push({ msgId: mid, name: '#' + mid })
        emit(t)
        break
      } catch (e) {
        const msg = String(e?.message || e)
        const flood = /FLOOD_WAIT_(\d+)/.exec(msg) || (e?.seconds ? [null, e.seconds] : null)
        if (flood && attempt < 5) {
          attempt++
          await sleep((Math.min(120, Number(flood[1]) || 5) + 1) * 1000)
          continue
        }
        t.stats.failed += chunk.length
        for (const mid of chunk) t._failed.push({ msgId: mid, name: '#' + mid, error: msg })
        emit(t)
        break
      }
    }
    t._ids = queue.slice() // 剩餘(供暫停續傳)
    await sleep(300) // 輕微節流,降低 FloodWait 機率
  }

  if (t._abort) return finishCanceled(t)
  if (t._paused) {
    t.status = 'paused'
    emit(t, true)
    return
  }
  t.status = 'done'
  emit(t, true)
}

function finishCanceled(t) {
  t.status = 'canceled'
  t._ids = []
  emit(t, true)
}

export function pauseForward(id) {
  const t = tasks.get(id)
  if (!t || t.status !== 'forwarding') return { ok: false }
  t._paused = true
  return { ok: true }
}
export function resumeForward(id) {
  const t = tasks.get(id)
  if (!t || t.status !== 'paused') return { ok: false }
  if (t.accountId && t.accountId !== (config.getActiveAccountId() || null)) {
    return { ok: false, error: '此任務屬於其他帳號,請先切回該帳號再續傳' }
  }
  t._paused = false
  t._single = t._ids.slice() // 用剩餘 id 續傳
  runForwardTask(t).catch(() => {})
  return { ok: true }
}
export function cancelForward(id) {
  const t = tasks.get(id)
  if (!t) return { ok: false }
  t._abort = true
  t._paused = false
  if (t.status === 'paused') finishCanceled(t)
  return { ok: true }
}
export function removeForward(id) {
  const t = tasks.get(id)
  if (t) t._abort = true
  tasks.delete(id)
  persist()
  return { ok: true }
}
