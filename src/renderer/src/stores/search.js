import { defineStore } from 'pinia'
import { useSettingsStore } from './settings.js'

/** 用戶端二次篩選:TG 搜尋只支援「按詞匹配」,此函式對結果做子字串過濾(改善中文/部分字串搜不到的問題)。 */
function clientFilter(results, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return results
  return results.filter((r) => (r.text || '').toLowerCase().includes(q))
}

export const useSearchStore = defineStore('search', {
  state: () => ({
    query: '',
    scope: 'global', // 'current' | 'global'
    types: [], // photo/video/document/voice/audio/url
    startDate: null, // ms
    endDate: null,
    results: [],
    scanned: 0,
    loading: false,
    error: '',
    ran: false
  }),
  actions: {
    async run(dialogId) {
      this.loading = true
      this.error = ''
      this.ran = true
      // 檢索上限改由設定決定(預設 1000),不再寫死 600
      const settings = useSettingsStore()
      if (!settings.loaded) await settings.load()
      const limit = Math.max(100, Number(settings.preferences.searchLimit) || 1000)
      const params = {
        dialogId: this.scope === 'current' ? dialogId || null : null,
        query: this.query.trim(),
        types: this.types.slice(),
        startDate: this.startDate ? Math.floor(this.startDate / 1000) : null,
        endDate: this.endDate ? Math.floor(this.endDate / 1000) + 86399 : null,
        limit
      }
      const r = await window.api.search.run(params)
      this.loading = false
      if (r?.ok) {
        // 用戶端二次子字串過濾(改善中文/部分字串搜不到)
        this.results = clientFilter(r.results, this.query)
        this.scanned = r.scanned
      } else {
        this.results = []
        this.error = r?.error || '搜尋失敗'
      }
    },
    clear() {
      this.results = []
      this.scanned = 0
      this.ran = false
      this.error = ''
    }
  }
})
