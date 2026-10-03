import { defineStore } from 'pinia'

/** peerId → 進行中的頭像請求,避免同一個 peer 被重複打。失敗不寫進 state,下次掛載可再試。 */
const avatarPending = new Map()

/** 套用型別子篩選 + 關鍵字搜尋。 */
function applyTypeAndSearch(arr, typeFilter, kw) {
  return arr.filter((d) => {
    if (typeFilter !== 'all' && d.type !== typeFilter) return false
    if (kw && !d.title.toLowerCase().includes(kw) && !(d.username || '').toLowerCase().includes(kw))
      return false
    return true
  })
}

/** 判斷對話是否屬於某資料夾(include 名單 + 型別 flags,扣除 exclude)。 */
function inFolder(d, folder) {
  if (folder.exclude?.includes(d.id)) return false
  if (folder.include?.includes(d.id)) return true
  const f = folder.flags || {}
  if (f.groups && d.type === 'group') return true
  if (f.broadcasts && d.type === 'channel') return true
  if ((f.contacts || f.nonContacts || f.bots) && d.type === 'user') return true
  return false
}

export const useDialogsStore = defineStore('dialogs', {
  state: () => ({
    list: [], // 主資料夾(非封存)
    loading: false,
    loaded: false,
    error: '',
    search: '',
    typeFilter: 'all', // all | user | group | channel
    activeFolder: 'all', // 'all' | 'archived' | <folderId:number>
    folders: [], // Telegram 聊天資料夾
    foldersLoaded: false,
    archivedList: [],
    archivedLoaded: false,
    archivedLoading: false,
    avatars: {} // peerId → dataUrl|null
  }),
  getters: {
    /** 目前資料夾頁籤對應的基礎清單(尚未套型別/搜尋)。 */
    baseList(s) {
      if (s.activeFolder === 'archived') return s.archivedList
      if (s.activeFolder === 'all') {
        // 全部:我的收藏置頂,然後非封存(不含封存)
        const saved = s.list.filter((d) => d.isSaved)
        const rest = s.list.filter((d) => !d.isSaved)
        return [...saved, ...rest]
      }
      const folder = s.folders.find((f) => f.id === s.activeFolder)
      if (!folder) {
        // fallback:非封存
        return s.list
      }
      // 資料夾:非封存匹配 + 封存匹配(不反灰,各有獨立置頂)
      const main = s.list.filter((d) => inFolder(d, folder))
      if (folder.flags?.excludeArchived) return main
      return [...main, ...s.archivedList.filter((d) => inFolder(d, folder))]
    },
    /** 封存對話未讀總數 */
    archivedUnread(s) {
      return s.archivedList.reduce((sum, d) => sum + (d.unreadCount || 0), 0)
    },
    /** 「我的收藏」(Saved Messages) 對話,供常駐置頂入口使用。 */
    savedDialog(s) {
      return s.list.find((d) => d.isSaved) || null
    },
    filtered(s) {
      const kw = s.search.trim().toLowerCase()
      // 收藏改由清單上方常駐入口呈現,這裡濾掉避免重複
      return applyTypeAndSearch(this.baseList, s.typeFilter, kw).filter((d) => !d.isSaved)
    }
  },
  actions: {
    async load(force = false) {
      if (this.loaded && !force) return
      this.loading = true
      this.error = ''
      const r = await window.api.dialogs.list({ limit: 300 })
      this.loading = false
      if (r.ok) {
        this.list = r.dialogs
        this.loaded = true
      } else {
        this.error = r.error || '載入對話失敗'
      }
      this.loadFolders(force)
    },
    async loadFolders(force = false) {
      if (this.foldersLoaded && !force) return
      const r = await window.api.dialogs.folders()
      if (r.ok) {
        this.folders = r.folders
        this.foldersLoaded = true
      }
    },
    async loadArchived(force = false) {
      if (this.archivedLoaded && !force) return
      this.archivedLoading = true
      const r = await window.api.dialogs.list({ limit: 300, archived: true })
      this.archivedLoading = false
      if (r.ok) {
        this.archivedList = r.dialogs
        this.archivedLoaded = true
      } else {
        this.error = r.error || '載入封存對話失敗'
      }
    },
    /**
     * 丟掉所有屬於「目前帳號」的資料。切換/新增/移除帳號時必須做:
     * 後端換帳號時會清掉 entity 與 raw 訊息快取,前端留著舊清單只會點進去就報錯、媒體也載不出來。
     */
    reset() {
      avatarPending.clear()
      this.list = []
      this.archivedList = []
      this.folders = []
      this.avatars = {}
      this.loaded = false
      this.foldersLoaded = false
      this.archivedLoaded = false
      this.loading = false
      this.archivedLoading = false
      this.activeFolder = 'all'
      this.search = ''
      this.typeFilter = 'all'
      this.error = ''
    },
    /** 換帳號後重載:先清空舊帳號資料,再用新帳號重抓一次。 */
    async reload() {
      this.reset()
      await this.load(true)
      await this.loadArchived(true)
    },
    setFolder(key) {
      this.activeFolder = key
      if (key === 'archived') this.loadArchived()
    },
    /**
     * 添加對話。⚠ 以前這裡用 window.prompt() —— Electron renderer **不支援 prompt**,
     * 按下去完全沒反應。改由呼叫端(DialogList)用自繪對話框收輸入。
     */
    async addDialog(username) {
      if (!username) return { ok: false, error: '請輸入用戶名或連結' }
      const r = await window.api.dialogs.addDialog(String(username).trim())
      if (r?.ok && r?.added) {
        await this.load(true)
        return { ok: true }
      }
      return r || { ok: false, error: '添加失敗' }
    },
    async avatar(peerId) {
      const key = String(peerId || '')
      if (!key) return null
      if (key in this.avatars) return this.avatars[key]
      if (avatarPending.has(key)) return avatarPending.get(key)
      const p = (async () => {
        try {
          const r = await window.api.dialogs.avatar(key)
          // 只有「確定沒有頭像」才記進 state;抓失敗不記,之後重新掛載可再試一次
          if (r?.ok) this.avatars[key] = r.dataUrl || null
          return r?.dataUrl || null
        } catch {
          return null
        } finally {
          avatarPending.delete(key)
        }
      })()
      avatarPending.set(key, p)
      return p
    }
  }
})
