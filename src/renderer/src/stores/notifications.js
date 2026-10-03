import { defineStore } from 'pinia'

/** 格式化檔案大小。 */
function fmtSize(n) {
  if (!n) return '0 B'
  if (n < 1024) return n + ' B'
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB'
  return (n / 1024 ** 3).toFixed(2) + ' GB'
}
/** 格式化速率(bytes/sec)。 */
function fmtSpeed(n) {
  if (!n || n < 1) return ''
  if (n < 1024) return Math.round(n) + ' B/s'
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB/s'
  return (n / 1024 ** 2).toFixed(1) + ' MB/s'
}
/** 格式化預估剩餘時間(秒)。 */
function fmtDuration(sec) {
  const s = Math.round(sec)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  const h = Math.floor(m / 60)
  return `${h} 時 ${m % 60} 分`
}

/**
 * 通知中心:全域追蹤下載進度事件。
 * 在 App 層訂閱 download:progress,把每個 msgId 的下載狀態彙整成一張清單,
 * 供頂部通知氣泡框即時顯示進度。
 */
export const useNotificationsStore = defineStore('notifications', {
  state: () => ({
    // key: `${dialogId}_${msgId}` → { dialogId, msgId, name, status, downloaded, total, path, error, ts }
    items: {},
    // 批量任務(下載/轉發):taskId → 彙整後的一筆通知
    taskItems: {},
    started: false,
    // 使用者剛手動移除的項目(key → ts):短時間內忽略殘留的「下載中」事件,避免又跳回來
    dismissed: {}
  }),
  getters: {
    /** 依時間倒序的清單(最新在前);批量任務與單檔下載混在一起。 */
    list(s) {
      return [...Object.values(s.taskItems), ...Object.values(s.items)].sort((a, b) => b.ts - a.ts)
    },
    /** 進行中數量 → 紅點 badge。 */
    activeCount(s) {
      const files = Object.values(s.items).filter(
        (i) => i.status === 'downloading' || i.status === 'paused'
      ).length
      const tasks = Object.values(s.taskItems).filter((t) =>
        ['queued', 'scanning', 'downloading', 'forwarding', 'paused'].includes(t.status)
      ).length
      return files + tasks
    },
    /** 總數。 */
    total(s) {
      return Object.keys(s.items).length + Object.keys(s.taskItems).length
    }
  },
  actions: {
    /** 在 App 啟動時呼叫一次,訂閱全域下載進度事件,並種入開機還原的可續傳項目。 */
    async start() {
      if (this.started) return
      this.started = true
      window.api.on('download:progress', (p) => this.onProgress(p))
      // 批量任務也要進通知中心 —— 以前只追單檔下載,批量跑起來這裡是空的
      window.api.on('task:update', (t) => this.onTask(t))
      try {
        const r = await window.api.tasks.list()
        if (r?.ok) for (const t of r.tasks || []) this.onTask(t, true)
      } catch {
        /* 取不到任務清單不影響其他功能 */
      }
      // 開機還原:把上次未下完、可續傳的項目種進通知中心(顯示為「已暫停」,可按繼續)
      try {
        const pending = await window.api.download.pending?.()
        if (Array.isArray(pending)) {
          const now = Date.now()
          for (const it of pending) {
            const key = `${it.dialogId}_${it.msgId}`
            if (this.items[key]) continue
            this.items[key] = {
              dialogId: it.dialogId,
              msgId: it.msgId,
              name: it.name,
              status: 'paused',
              downloaded: it.downloaded || 0,
              total: it.total || 0,
              path: it.path,
              error: '',
              skipped: false,
              speed: 0,
              eta: 0,
              _spdTs: now,
              ts: now
            }
          }
        }
      } catch {
        /* 取不到還原清單不影響其他功能 */
      }
    },
    /** task:update → 通知中心的一筆(整個批量任務彙整成一條)。 */
    onTask(t, seed = false) {
      if (!t?.id) return
      // 開機載入既有清單時,已結束的舊任務不用再冒出來洗版
      if (seed && !['queued', 'scanning', 'downloading', 'forwarding', 'paused'].includes(t.status)) return
      const prev = this.taskItems[t.id]
      const st = t.stats || {}
      const isFwd = t.kind === 'forward'
      this.taskItems[t.id] = {
        kind: 'task',
        taskKind: t.kind || 'download',
        id: t.id,
        name: t.title || (isFwd ? '批量轉發' : '批量下載'),
        sub: t.dialogTitle || '',
        status: t.status,
        done: isFwd ? st.forwarded || 0 : (st.downloaded || 0) + (st.skipped || 0),
        totalFiles: st.total || st.matched || 0,
        failed: st.failed || 0,
        downloaded: st.doneBytes || st.bytes || 0,
        total: st.totalBytes || 0,
        speed: t.status === 'downloading' ? st.speed || 0 : 0,
        eta: t.status === 'downloading' ? st.eta || 0 : 0,
        error: t.error || '',
        ts: prev?.ts || Date.now()
      }
    },
    pctTask(t) {
      if (t.total) return Math.min(100, Math.round((t.downloaded / t.total) * 100))
      if (t.totalFiles) return Math.min(100, Math.round((t.done / t.totalFiles) * 100))
      return 0
    },
    removeTask(id) {
      delete this.taskItems[id]
    },
    onProgress(p) {
      const key = `${p.dialogId}_${p.msgId}`
      if (p.status === 'canceled') {
        delete this.items[key]
        delete this.dismissed[key]
        return
      }
      // 剛被手動移除(按 X)→ 3 秒內殘留的「下載中/暫停」事件一律忽略,不讓它又冒出來。
      // 終態(done/error)則放行並清掉抑制標記(下載其實已收尾)。
      if (this.dismissed[key]) {
        if (Date.now() - this.dismissed[key] < 3000) {
          if (p.status === 'downloading' || p.status === 'paused') return
        }
        delete this.dismissed[key]
      }
      const prev = this.items[key] || {}
      const now = Date.now()
      // 速度 & 預估剩餘時間:用進度事件間的位元組增量,EMA 平滑(代理是一陣一陣到的,不平滑會亂跳)
      let speed = prev.speed || 0
      let eta = prev.eta || 0
      if (p.status === 'downloading') {
        const dBytes = (p.downloaded || 0) - (prev.downloaded || 0)
        const dt = prev._spdTs ? (now - prev._spdTs) / 1000 : 0
        if (dt > 0.02 && dBytes >= 0) {
          const inst = dBytes / dt
          speed = prev.speed ? prev.speed * 0.6 + inst * 0.4 : inst
          const remain = (p.total || 0) - (p.downloaded || 0)
          eta = speed > 1 ? remain / speed : 0
        }
      } else {
        speed = 0
        eta = 0
      }
      this.items[key] = {
        dialogId: p.dialogId,
        msgId: p.msgId,
        name: prev.name || (p.path ? p.path.split(/[\\/]/).pop() : `訊息 ${p.msgId}`),
        status: p.status,
        downloaded: p.downloaded || 0,
        total: p.total || prev.total || 0,
        path: p.path || prev.path,
        error: p.error,
        skipped: p.skipped,
        speed,
        eta,
        _spdTs: now,
        ts: prev.ts || Date.now()
      }
      // 完成後更新檔名
      if (p.status === 'done' && p.path) this.items[key].name = p.path.split(/[\\/]/).pop()
    },
    /** 下載速率文字(僅下載中)。 */
    speedText(item) {
      if (!item || item.status !== 'downloading') return ''
      return fmtSpeed(item.speed)
    },
    /** 預估剩餘時間文字(僅下載中且速率有效)。 */
    etaText(item) {
      if (!item || item.status !== 'downloading') return ''
      if (!item.eta || item.eta <= 0 || !isFinite(item.eta)) return ''
      return fmtDuration(item.eta)
    },
    pct(item) {
      if (!item.total) return 0
      return Math.min(100, Math.round((item.downloaded / item.total) * 100))
    },
    sizeText(item) {
      if (item.status === 'done') return fmtSize(item.total)
      return `${fmtSize(item.downloaded)} / ${fmtSize(item.total)}`
    },
    remove(key) {
      delete this.items[key]
      this.dismissed[key] = Date.now() // 抑制殘留事件把它又加回來
    },
    clear() {
      // 只清掉已完成/失敗的,保留進行中
      for (const [k, v] of Object.entries(this.items)) {
        if (v.status === 'done' || v.status === 'error') delete this.items[k]
      }
      for (const [k, v] of Object.entries(this.taskItems)) {
        if (['done', 'error', 'canceled', 'interrupted'].includes(v.status)) delete this.taskItems[k]
      }
    },
    clearAll() {
      this.items = {}
      this.taskItems = {}
    }
  }
})
