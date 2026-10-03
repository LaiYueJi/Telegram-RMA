import { defineStore } from 'pinia'

const PAGE = 60
/** 投票掃描的預設上限(沒有伺服器 filter,只能一頁頁翻,總得有個頭)。 */
const POLL_MAX_SCAN = 30000

/** 分類 → 側欄那一行的文案。count 由呼叫端帶入。 */
export const KIND_LABEL = {
  photo: (n) => `${n} 張照片`,
  video: (n) => `${n} 個影片`,
  document: (n) => `${n} 個檔案`,
  audio: (n) => `${n} 個音訊檔`,
  url: (n) => `${n} 個連結`,
  poll: (n) => (n == null ? '投票活動' : `${n} 個投票活動`),
  voice: (n) => `${n} 則語音訊息`,
  gif: (n) => `${n} 張 GIF`,
  pinned: (n) => `${n} 則置頂訊息`,
  gift: (n) => `${n} 個禮物`,
  common: (n) => `${n} 個共同的群組`
}

/** 側欄顯示順序(對齊官方客戶端)。 */
export const KIND_ORDER = [
  'photo',
  'video',
  'document',
  'audio',
  'url',
  'poll',
  'voice',
  'gif',
  'pinned',
  'gift',
  'common'
]

/** 走伺服器 filter 的分類(其餘是投票掃描 / 禮物 / 共同群組,各有各的來源)。 */
const SERVER_KINDS = ['photo', 'video', 'document', 'audio', 'url', 'voice', 'gif', 'pinned']
/** 用方格排的分類(其餘用列表)。 */
export const GRID_KINDS = ['photo', 'video', 'gif', 'gift']

let offPollProgress = null

export const useSharedMediaStore = defineStore('sharedMedia', {
  state: () => ({
    dialogId: '',
    dialogType: '',

    counters: null, // { photo: {count, inexact}, … }
    countersLoading: false,
    countersError: '',

    kind: '', // '' = 分類總覽
    items: [],
    loading: false,
    loadingMore: false,
    hasMore: false,
    oldestId: 0,
    error: '',

    // 日曆(照片那種方格分頁的「跳到某一天」)
    calendar: null, // { count, minDate, minMsgId, periods: [{date,minMsgId,maxMsgId,count}] }
    calendarLoading: false,

    // 投票只能掃歷史
    pollScan: { running: false, scanned: 0, found: 0, done: false, partial: false },

    // 私聊限定
    giftCount: null,
    giftOffset: '',
    commonCount: null,
    extrasLoading: false,

    cols: 3 // 方格分頁一列幾個(⋮ 選單放大/縮小)
  }),
  getters: {
    /** 總覽要顯示哪幾行(0 則的隱藏,對齊官方;投票沒得算所以永遠顯示)。 */
    overviewRows(s) {
      const rows = []
      for (const k of KIND_ORDER) {
        if (k === 'poll') {
          // 沒有伺服器 filter → 掃過才有數字,沒掃過就先顯示成入口
          rows.push({ kind: k, count: s.pollScan.done ? s.pollScan.found : null })
          continue
        }
        if (k === 'gift') {
          if (s.dialogType === 'user' && s.giftCount) rows.push({ kind: k, count: s.giftCount })
          continue
        }
        if (k === 'common') {
          if (s.dialogType === 'user' && s.commonCount) rows.push({ kind: k, count: s.commonCount })
          continue
        }
        const n = s.counters?.[k]?.count || 0
        if (n > 0) rows.push({ kind: k, count: n, inexact: !!s.counters[k].inexact })
      }
      return rows
    },
    isGrid(s) {
      return GRID_KINDS.includes(s.kind)
    }
  },
  actions: {
    /** 綁到某個對話。換對話就整組重來。 */
    async openFor(dialogId, dialogType) {
      const id = String(dialogId || '')
      if (this.dialogId === id) return
      this.reset()
      this.dialogId = id
      this.dialogType = dialogType || ''
      if (!id) return
      await this.loadCounters()
      this.loadExtras() // 私聊的禮物 / 共同群組,晚點到就晚點補上,不擋總覽
    },
    async loadCounters() {
      if (!this.dialogId) return
      this.countersLoading = true
      this.countersError = ''
      const r = await window.api.shared.counters(this.dialogId)
      this.countersLoading = false
      if (r?.ok) this.counters = r.counters
      else this.countersError = r?.error || '讀取共享媒體失敗'
    },
    /** 私聊限定:禮物與共同群組。兩者都沒有計數 API,只能真的抓一次(順便當快取)。 */
    async loadExtras() {
      if (this.dialogType !== 'user' || !this.dialogId) return
      this.extrasLoading = true
      const id = this.dialogId
      const [gifts, common] = await Promise.all([
        window.api.shared.gifts(id, '', 50).catch(() => null),
        window.api.shared.commonChats(id, 100).catch(() => null)
      ])
      if (this.dialogId !== id) return // 期間換對話了
      this.extrasLoading = false
      if (gifts?.ok) {
        this.giftCount = gifts.count || gifts.items.length
        this.giftOffset = gifts.nextOffset || ''
        this._giftCache = gifts.items
      }
      if (common?.ok) {
        this.commonCount = common.chats.length
        this._commonCache = common.chats
      }
    },

    /** 進入某分類。offsetId 可指定從哪一則往回讀(日曆跳日期用)。 */
    async openKind(kind, { offsetId = 0 } = {}) {
      this.kind = kind
      this.items = []
      this.oldestId = offsetId
      this.hasMore = false
      this.error = ''
      this.calendar = null

      if (kind === 'gift') return this.loadGifts()
      if (kind === 'common') return this.loadCommon()
      if (kind === 'poll') {
        // 掃過就直接用結果,沒掃過等使用者按「開始掃描」
        if (this.pollScan.done) this.items = this._pollCache || []
        return
      }
      if (!SERVER_KINDS.includes(kind)) return

      this.loading = true
      const r = await window.api.shared.list(this.dialogId, kind, { offsetId, limit: PAGE })
      this.loading = false
      if (!r?.ok) {
        this.error = r?.error || '載入失敗'
        return
      }
      this.items = r.items
      this.oldestId = r.oldestId
      this.hasMore = r.hasMore
    },
    async loadMore() {
      if (this.loadingMore || this.loading || !this.hasMore) return
      if (!SERVER_KINDS.includes(this.kind)) return
      this.loadingMore = true
      const r = await window.api.shared.list(this.dialogId, this.kind, {
        offsetId: this.oldestId,
        limit: PAGE
      })
      this.loadingMore = false
      if (!r?.ok) return
      const seen = new Set(this.items.map((m) => m.id))
      const add = r.items.filter((m) => !seen.has(m.id))
      this.items = [...this.items, ...add]
      this.oldestId = r.oldestId
      this.hasMore = r.hasMore && add.length > 0
    },
    back() {
      this.kind = ''
      this.items = []
      this.calendar = null
      this.error = ''
    },

    // ---------------- 日曆 ----------------
    async loadCalendar(offsetId = 0) {
      if (!SERVER_KINDS.includes(this.kind)) return
      this.calendarLoading = true
      const r = await window.api.shared.calendar(this.dialogId, this.kind, offsetId)
      this.calendarLoading = false
      if (!r?.ok) return
      if (offsetId && this.calendar) {
        // 往更舊的月份續抓:接在後面(伺服器由新到舊給)
        const seen = new Set(this.calendar.periods.map((p) => p.date))
        this.calendar = {
          ...this.calendar,
          periods: [...this.calendar.periods, ...r.periods.filter((p) => !seen.has(p.date))]
        }
      } else {
        this.calendar = { count: r.count, minDate: r.minDate, minMsgId: r.minMsgId, periods: r.periods }
      }
    },
    closeCalendar() {
      this.calendar = null
    },

    // ---------------- 投票掃描 ----------------
    async startPollScan() {
      if (this.pollScan.running) return
      this.pollScan = { running: true, scanned: 0, found: 0, done: false, partial: false }
      const id = this.dialogId
      offPollProgress?.()
      offPollProgress = window.api.on('shared:pollProgress', (p) => {
        if (String(p.dialogId) !== id) return
        this.pollScan.scanned = p.scanned
        this.pollScan.found = p.found
      })
      const r = await window.api.shared.scanPolls(id, POLL_MAX_SCAN)
      offPollProgress?.()
      offPollProgress = null
      if (this.dialogId !== id) return
      this.pollScan.running = false
      if (!r?.ok) {
        this.error = r?.error || '掃描失敗'
        return
      }
      this.pollScan.done = true
      this.pollScan.partial = !!r.partial
      this.pollScan.found = r.items.length
      this.pollScan.scanned = r.scanned
      this._pollCache = r.items
      if (this.kind === 'poll') this.items = r.items
    },
    cancelPollScan() {
      if (!this.pollScan.running) return
      window.api.shared.cancelPollScan(this.dialogId)
    },

    // ---------------- 禮物 / 共同群組 ----------------
    async loadGifts() {
      if (this._giftCache) {
        this.items = this._giftCache
        return
      }
      this.loading = true
      const r = await window.api.shared.gifts(this.dialogId, '', 50)
      this.loading = false
      if (!r?.ok) {
        this.error = r?.error || '讀取禮物失敗'
        return
      }
      this._giftCache = r.items
      this.items = r.items
      this.giftCount = r.count
      this.giftOffset = r.nextOffset || ''
    },
    async loadCommon() {
      if (this._commonCache) {
        this.items = this._commonCache
        return
      }
      this.loading = true
      const r = await window.api.shared.commonChats(this.dialogId, 100)
      this.loading = false
      if (!r?.ok) {
        this.error = r?.error || '讀取共同的群組失敗'
        return
      }
      this._commonCache = r.chats
      this.items = r.chats
      this.commonCount = r.chats.length
    },

    setCols(n) {
      this.cols = Math.min(6, Math.max(2, n))
    },

    reset() {
      offPollProgress?.()
      offPollProgress = null
      this._giftCache = null
      this._commonCache = null
      this._pollCache = null
      this.dialogId = ''
      this.dialogType = ''
      this.counters = null
      this.countersLoading = false
      this.countersError = ''
      this.kind = ''
      this.items = []
      this.loading = false
      this.loadingMore = false
      this.hasMore = false
      this.oldestId = 0
      this.error = ''
      this.calendar = null
      this.calendarLoading = false
      this.pollScan = { running: false, scanned: 0, found: 0, done: false, partial: false }
      this.giftCount = null
      this.giftOffset = ''
      this.commonCount = null
      this.extrasLoading = false
    }
  }
})
