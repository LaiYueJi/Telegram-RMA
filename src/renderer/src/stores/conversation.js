import { defineStore } from 'pinia'

const PAGE = 30

export const useConversationStore = defineStore('conversation', {
  state: () => ({
    current: null, // { id, title, type, username }
    messages: [], // 由舊到新
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    hasMore: true,
    oldestId: 0,
    // 往「新」的方向:跳轉 / 跳到最舊之後,畫面停在歷史中間,底下還有更新的沒載
    newestId: 0,
    hasNewer: false,
    error: '',
    // 跳轉:要捲到並閃一下的訊息 id(Conversation.vue 監看,處理完自己清掉)
    jumpToId: 0,
    jumpSeq: 0, // 同一則連點兩次也要能再觸發一次
    // 置頂訊息(由新到舊)。官方在訊息區頂端常駐一條橫幅,點一下換下一則。
    pinned: [],
    pinnedIdx: 0,
    pinnedLoading: false,
    // 已經捲到對話最初(loadOldest 之後),別再往上抓
    atOldest: false
  }),
  getters: {
    currentPinned(s) {
      return s.pinned[s.pinnedIdx] || null
    }
  },
  actions: {
    /**
     * 關閉目前對話並清空訊息。切換帳號時一定要做:
     * 後端已經換成別的帳號了,畫面上這串訊息屬於前一個帳號 —— 文字還看得到,
     * 但縮圖/媒體全部載不出來(raw 訊息快取已清、entity 也不是同一個 client 的)。
     */
    reset() {
      this.current = null
      this.messages = []
      this.loading = false
      this.loadingOlder = false
      this.loadingNewer = false
      this.hasMore = true
      this.oldestId = 0
      this.newestId = 0
      this.hasNewer = false
      this.error = ''
      this.jumpToId = 0
      this.pinned = []
      this.pinnedIdx = 0
      this.pinnedLoading = false
      this.atOldest = false
    },
    /** 置頂訊息:走共享媒體的 pinned filter,一次抓夠橫幅與清單用。 */
    async loadPinned() {
      if (!this.current) return
      const id = this.current.id
      this.pinnedLoading = true
      const r = await window.api.shared.list(id, 'pinned', { limit: 50 })
      this.pinnedLoading = false
      if (this.current?.id !== id) return // 期間換對話了
      this.pinned = r?.ok ? r.items : []
      this.pinnedIdx = 0
    },
    /** 橫幅點一下換下一則置頂(繞回第一則),跟官方一樣。 */
    nextPinned() {
      if (!this.pinned.length) return null
      const msg = this.pinned[this.pinnedIdx]
      this.pinnedIdx = (this.pinnedIdx + 1) % this.pinned.length
      return msg
    },
    /**
     * 真的跳到對話最初的訊息。
     * 以前「最舊」只是把捲軸拉到 0 —— 那只是目前載進來的最上面,四萬則的群組要按上百次。
     */
    async jumpToOldest() {
      if (!this.current) return { ok: false }
      this.loading = true
      this.error = ''
      const r = await window.api.messages.loadOldest(this.current.id, 40)
      this.loading = false
      if (!r?.ok) {
        this.error = r?.error || '跳到最舊失敗'
        return r || { ok: false }
      }
      this.messages = r.messages
      this.oldestId = 0
      this.hasMore = false // 已經是最初,沒有更舊的了
      this.atOldest = true
      this.newestId = r.newestId || 0
      this.hasNewer = true // 剩下的全在下面,往下捲就繼續讀
      return { ok: true, firstId: r.firstId }
    },
    async open(dialog) {
      if (this.current?.id === dialog.id) return
      this.current = { id: dialog.id, title: dialog.title, type: dialog.type, username: dialog.username }
      this.messages = []
      this.oldestId = 0
      this.hasMore = true
      this.hasNewer = false
      this.newestId = 0
      this.atOldest = false
      this.error = ''
      this.pinned = []
      this.pinnedIdx = 0
      await this.loadInitial()
      this.loadPinned() // 背景抓,不擋訊息顯示
    },
    async loadInitial() {
      if (!this.current) return
      this.loading = true
      const r = await window.api.messages.load(this.current.id, { limit: PAGE, offsetId: 0 })
      this.loading = false
      if (r.ok) {
        this.messages = r.messages
        this.oldestId = r.oldestId
        this.hasMore = r.hasMore
        // loadInitial 拿的就是最新那一頁,底下不會再有更新的
        this.newestId = r.messages.length ? r.messages[r.messages.length - 1].id : 0
        this.hasNewer = false
        this.atOldest = false
      } else {
        this.error = r.error || '載入訊息失敗'
      }
    },
    /** 往下讀更新的訊息(跳轉 / 跳到最舊之後用)。 */
    async loadNewer() {
      if (!this.current || this.loadingNewer || !this.hasNewer || !this.newestId) return
      this.loadingNewer = true
      const r = await window.api.messages.loadNewer(this.current.id, {
        limit: PAGE,
        offsetId: this.newestId
      })
      this.loadingNewer = false
      if (!r?.ok) return
      const existing = new Set(this.messages.map((m) => m.id))
      const newer = r.messages.filter((m) => !existing.has(m.id))
      this.messages = [...this.messages, ...newer]
      if (newer.length) this.newestId = newer[newer.length - 1].id
      this.hasNewer = r.hasMore && newer.length > 0
    },
    /** 回到最新:不是捲到底而已,是重抓最新那一頁(跳轉過後底下那截根本還沒載)。 */
    async goNewest() {
      if (!this.current) return
      this.messages = []
      this.oldestId = 0
      this.hasMore = true
      this.atOldest = false
      this.hasNewer = false
      await this.loadInitial()
    },
    async loadOlder() {
      if (this.atOldest) return
      if (!this.current || this.loadingOlder || !this.hasMore || !this.oldestId) return
      this.loadingOlder = true
      const r = await window.api.messages.load(this.current.id, {
        limit: PAGE,
        offsetId: this.oldestId
      })
      this.loadingOlder = false
      if (r.ok) {
        // 舊訊息接在最前面
        const existing = new Set(this.messages.map((m) => m.id))
        const older = r.messages.filter((m) => !existing.has(m.id))
        this.messages = [...older, ...this.messages]
        this.oldestId = r.oldestId
        this.hasMore = r.hasMore && older.length > 0
      }
    },
    /**
     * 跳到某則訊息:切到該對話 → 抓那則前後一段 → 標記要捲過去。
     * 已經在同一個對話且訊息就在畫面上時,就不重抓,直接捲。
     * @param {{id:string, title?:string, type?:string}} dialog
     */
    async jumpTo(dialog, msgId) {
      const id = Number(msgId)
      const sameChat = this.current?.id === String(dialog.id)
      if (sameChat && this.messages.some((m) => m.id === id)) {
        this.jumpToId = id
        this.jumpSeq++
        return { ok: true }
      }
      this.atOldest = false // 跳走之後又能往上讀更舊的了
      if (!sameChat) {
        this.current = {
          id: String(dialog.id),
          title: dialog.title || '',
          type: dialog.type || '',
          username: dialog.username || ''
        }
        this.messages = []
      }
      this.loading = true
      this.error = ''
      const r = await window.api.messages.loadAround(String(dialog.id), id, 40)
      this.loading = false
      if (!r?.ok) {
        this.error = r?.error || '跳轉失敗'
        return r || { ok: false }
      }
      this.messages = r.messages
      this.oldestId = r.oldestId
      this.hasMore = r.hasMore
      // 跳進歷史中間 → 底下多半還有更新的沒載,允許往下續讀
      this.newestId = r.newestId || (r.messages.length ? r.messages[r.messages.length - 1].id : 0)
      this.hasNewer = true
      this.jumpToId = id
      this.jumpSeq++
      return { ok: true, found: r.found }
    },
    reload() {
      return this.loadInitial()
    }
  }
})
