import { defineStore } from 'pinia'

export const useProxyStore = defineStore('proxy', {
  state: () => ({
    proxies: [],
    activeId: null,
    loaded: false
  }),
  getters: {
    active(s) {
      return s.proxies.find((p) => p.id === s.activeId) || null
    }
  },
  actions: {
    async load() {
      const r = await window.api.proxy.list()
      this.proxies = r.proxies
      this.activeId = r.activeId
      this.loaded = true
    },
    async save(proxy) {
      const r = await window.api.proxy.save(proxy)
      this.proxies = r.proxies
      return r
    },
    async remove(id) {
      const r = await window.api.proxy.remove(id)
      this.proxies = r.proxies
      this.activeId = r.activeId
    },
    async setActive(id) {
      this.activeId = id
      return await window.api.proxy.setActive(id)
    },
    test(ip, port) {
      return window.api.proxy.test(ip, port)
    },
    ping() {
      return window.api.proxy.ping()
    },
    parseLink(link) {
      return window.api.proxy.parseLink(link)
    },
    autodetect() {
      return window.api.proxy.autodetect()
    }
  }
})
