import { defineStore } from 'pinia'

export const useAutomationStore = defineStore('automation', {
  state: () => ({ rules: [], loaded: false }),
  actions: {
    async load() {
      const r = await window.api.automation.list()
      if (r?.ok) this.rules = r.rules
      this.loaded = true
    },
    async create(cfg) {
      const r = await window.api.automation.create(cfg)
      await this.load()
      return r
    },
    async toggle(id, enabled) {
      await window.api.automation.toggle(id, enabled)
      await this.load()
    },
    async remove(id) {
      await window.api.automation.remove(id)
      this.rules = this.rules.filter((r) => r.id !== id)
    }
  }
})
