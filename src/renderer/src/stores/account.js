import { defineStore } from 'pinia'
import { useDialogsStore } from './dialogs.js'
import { useConversationStore } from './conversation.js'
import { useSearchStore } from './search.js'
import { useSharedMediaStore } from './sharedMedia.js'

/**
 * 頭像請求的世代序號。帳號一換就 ++,讓還在飛的舊請求回來時自己作廢 ——
 * 否則慢一步的前帳號頭像會蓋掉新帳號的。
 */
let avatarToken = 0

/** 丟掉所有「屬於上一個帳號」的畫面資料(對話列表 / 已開對話 / 檢索結果)。 */
function dropAccountScopedData() {
  useConversationStore().reset()
  useSearchStore().clear()
  useSharedMediaStore().reset()
  useDialogsStore().reset()
}

/** 由帳號物件算顯示名。 */
export function accountName(a) {
  const u = a?.user
  if (u) return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || u.id
  return a?.phone || '帳號'
}

export const useAccountStore = defineStore('account', {
  state: () => ({
    loaded: false,
    hasCredentials: false,
    connected: false,
    authorized: false,
    hasSession: false, // 本機仍存有 session(連不上≠登出):登入頁據此顯示「重新連線」
    connecting: false, // 開機自動連線進行中 → 路由守衛要等它,別誤判成未登入
    user: null,
    avatarUrl: null,
    activeProxy: null,
    accounts: [], // [{ id, user, phone, active }]
    switching: false
  }),
  getters: {
    displayName(s) {
      if (!s.user) return '未登入'
      return [s.user.firstName, s.user.lastName].filter(Boolean).join(' ') || s.user.username || s.user.id
    },
    activeAccountId(s) {
      return s.accounts.find((a) => a.active)?.id || null
    },
    /** 帳號分類統計:總數 / 協議號 / 直登號 / 健康 / 受限 / 封禁 / 未檢測。 */
    counts(s) {
      const c = { total: 0, protocol: 0, direct: 0, ok: 0, warn: 0, bad: 0, unknown: 0 }
      for (const a of s.accounts) {
        c.total++
        if (a.type === 'protocol') c.protocol++
        else c.direct++
        const st = a.health?.state || 'unknown'
        if (st === 'ok') c.ok++
        else if (st === 'warn') c.warn++
        else if (st === 'bad') c.bad++
        else c.unknown++
      }
      return c
    }
  },
  actions: {
    async refresh() {
      const st = await window.api.auth.status()
      this.hasCredentials = st.hasCredentials
      this.connected = st.connected
      this.authorized = st.authorized
      this.connecting = !!st.connecting
      this.hasSession = !!st.hasSession
      this.user = st.user
      this.activeProxy = st.activeProxy
      this.loaded = true
      if (st.authorized) this.loadAvatar()
      else this.avatarUrl = null
      await this.loadAccounts()
      return st
    },
    /**
     * 開機時自動連線是非同步的:畫面常常比連線快,這時 status 會回 authorized:false。
     * 有存 session 的話就等連線嘗試收斂,別急著把使用者踢去登入頁。
     */
    async waitForConnect(maxMs = 25000) {
      const t0 = Date.now()
      while (!this.authorized && this.hasSession && this.connecting && Date.now() - t0 < maxMs) {
        await new Promise((r) => setTimeout(r, 350))
        await this.refresh()
      }
      return this.authorized
    },
    async loadAccounts() {
      try {
        const r = await window.api.auth.list()
        this.accounts = r?.accounts || []
      } catch {
        this.accounts = []
      }
    },
    /**
     * 載入登入帳號自己的頭像。
     * 剛登入完(尤其是新增帳號)常常第一次抓不到 —— 頭像多半放在別的 DC,client 要先借一條
     * 連線過去,那當下還沒暖好就回空。以前一失敗就記成「沒有頭像」,只好切走再切回來才會更新;
     * 現在後端會回報 retriable,這裡照著退避重試幾次。
     */
    async loadAvatar({ retries = 4 } = {}) {
      const token = ++avatarToken
      for (let i = 0; i <= retries; i++) {
        let r = null
        try {
          r = await window.api.auth.avatar()
        } catch {
          /* 當成可重試 */
        }
        if (token !== avatarToken) return // 期間換過帳號,這個結果已作廢
        if (r?.dataUrl) {
          this.avatarUrl = r.dataUrl
          return
        }
        if (r && !r.retriable) {
          this.avatarUrl = null // 這帳號真的沒設頭像
          return
        }
        if (i < retries) await new Promise((res) => setTimeout(res, 700 * (i + 1)))
      }
      // 重試完仍抓不到:維持現況(短暫斷線時別把已經顯示好的頭像洗掉)
    },
    /**
     * 帳號真的換掉之後的統一收尾:先把上一個帳號的畫面資料清乾淨,再重讀狀態、重載對話列表。
     * 後端切帳號時會清掉 entity 與 raw 訊息快取,前端不跟著清的話,對話列表還是舊帳號的、
     * 已開的對話也還開著(文字看得到、媒體全部載不出來)。
     * @param {{reload?:boolean}} opts reload=false:只清空,交給接下來要掛載的 DialogList 自己載
     */
    async applyAccountChange({ reload = true } = {}) {
      avatarToken++ // 讓前一個帳號還在飛的頭像請求作廢
      this.avatarUrl = null
      dropAccountScopedData()
      await this.refresh()
      if (reload && this.authorized) await useDialogsStore().reload()
    },
    async switchAccount(id) {
      if (id === this.activeAccountId) return { ok: true }
      this.switching = true
      try {
        const r = await window.api.auth.switchAccount(id)
        // 被擋下(忙碌/帳號不存在)時舊帳號還連著,不要動畫面
        if (r?.ok) await this.applyAccountChange()
        else await this.refresh()
        return r
      } finally {
        this.switching = false
      }
    },
    /** 開始新增帳號(回 ok 後由呼叫端導向登入頁 add 模式)。 */
    async addAccount() {
      const r = await window.api.auth.beginAdd()
      // active 變成未授權的 placeholder:舊帳號已斷線,畫面資料全部作廢,先清掉再導頁
      // (refresh 也順便更新守衛用的 authorized)
      if (r?.ok) await this.applyAccountChange({ reload: false })
      return r
    },
    async cancelAdd() {
      const r = await window.api.auth.cancelAdd()
      await this.applyAccountChange()
      return r
    },
    async removeAccount(id) {
      const wasActive = id === this.activeAccountId
      this.switching = true
      try {
        const r = await window.api.auth.removeAccount(id)
        // 移除非 active 帳號不會動到連線,沒必要把使用者正在看的對話關掉
        if (wasActive) await this.applyAccountChange()
        else await this.refresh()
        return r
      } finally {
        this.switching = false
      }
    },
    async autoConnect() {
      await window.api.auth.autoConnect()
      return this.refresh()
    },
    async logout() {
      await window.api.auth.logout()
      return this.applyAccountChange()
    },

    // ---------------- 協議號 / 帳號工具箱 ----------------
    /** 導入單筆協議號(session 字串)。成功後刷新清單。 */
    async importSession(session, label = '', note = '') {
      const r = await window.api.accounts.import(session, label, note)
      if (r?.ok) await this.loadAccounts()
      return r
    },
    /** 批量導入(逐行 session)。訂閱進度請用 window.api.on('accounts:progress', …)。 */
    async importBatch(text) {
      const r = await window.api.accounts.importBatch(text)
      await this.loadAccounts()
      return r
    },
    /** 單一帳號健康檢測。 */
    async healthCheck(id) {
      const r = await window.api.accounts.health(id)
      await this.loadAccounts()
      return r
    },
    /** 批量健康檢測(不傳 = 全部)。 */
    async healthCheckAll(ids) {
      const r = await window.api.accounts.healthAll(ids || null)
      await this.loadAccounts()
      return r
    },
    /** 改資料(名字/姓氏/簡介/用戶名/頭像路徑)。 */
    async setProfile(id, profile) {
      const r = await window.api.accounts.setProfile(id, profile)
      await this.loadAccounts()
      if (id === this.activeAccountId) await this.refresh()
      return r
    },
    /** 設定 / 修改 / 移除兩步驗證。 */
    async setTwoFa(id, params) {
      const r = await window.api.accounts.setTwoFa(id, params)
      await this.loadAccounts()
      return r
    },
    /** 踢掉其他登入裝置。 */
    async terminateOthers(id) {
      const r = await window.api.accounts.terminateOthers(id)
      await this.loadAccounts()
      return r
    },
    /** 匯出 session 字串。 */
    async exportSession(id) {
      return await window.api.accounts.export(id)
    },
    /** 更新標註(標籤/備註等)。 */
    async setMeta(id, patch) {
      const r = await window.api.accounts.setMeta(id, patch)
      await this.loadAccounts()
      return r
    },

    // ---------------- 協議號 ↔ 直登號(tdata)轉換 ----------------
    /** 協議號 → 直登號(tdata):傳 { session, outDir } 或 { accountId, outDir }。 */
    async sessionToTdata(opts) {
      return await window.api.accounts.sessionToTdata(opts)
    },
    /** 直登號(tdata)→ 協議號:回 { ok, session }。 */
    async tdataToSession(tdataDir, accountIdx = 0) {
      return await window.api.accounts.tdataToSession(tdataDir, accountIdx)
    }
  }
})
