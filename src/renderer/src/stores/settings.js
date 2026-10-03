import { defineStore } from 'pinia'

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    preferences: {
      theme: 'dark',
      downloadPopup: false,
      gpuAcceleration: 'system',
      concurrency: 3,
      batchDownloadLimit: 5000,
      forwardLimit: 2000,
      searchLimit: 1000
    },
    paths: { saveRoot: '', cacheDir: '' },
    loaded: false
  }),
  actions: {
    async load() {
      this.preferences = await window.api.settings.getPreferences()
      this.paths = await window.api.settings.getPaths()
      this.loaded = true
    },
    async savePreferences(patch) {
      this.preferences = await window.api.settings.setPreferences(patch)
    },
    async savePaths(patch) {
      this.paths = await window.api.settings.setPaths(patch)
    },
    pickFolder(defaultPath) {
      return window.api.settings.pickFolder(defaultPath)
    },
    cacheInfo() {
      return window.api.settings.cacheInfo()
    },
    clearCache() {
      return window.api.settings.clearCache()
    },
    appInfo() {
      return window.api.settings.appInfo()
    },
    async exportData() {
      return window.api.settings.exportData()
    },
    async importData() {
      const r = await window.api.settings.importData()
      if (r?.ok) await this.load() // 匯入後偏好可能變動,重讀
      return r
    }
  }
})
