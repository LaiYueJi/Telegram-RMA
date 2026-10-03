import { defineStore } from 'pinia'

let off = null // task:update 取消訂閱

export const useTasksStore = defineStore('tasks', {
  state: () => ({
    list: [],
    loaded: false
  }),
  actions: {
    async load() {
      const r = await window.api.tasks.list()
      if (r?.ok) this.list = r.tasks
      this.loaded = true
      this.subscribe()
    },
    subscribe() {
      if (off) return
      off = window.api.on('task:update', (t) => {
        const i = this.list.findIndex((x) => x.id === t.id)
        if (i >= 0) this.list[i] = t
        else this.list.unshift(t)
      })
    },
    async createDownload(cfg) {
      const r = await window.api.tasks.createDownload(cfg)
      await this.load()
      return r
    },
    async createForward(cfg) {
      const r = await window.api.tasks.createForward(cfg)
      await this.load()
      return r
    },
    pause(id) {
      return window.api.tasks.pause(id)
    },
    resume(id) {
      return window.api.tasks.resume(id)
    },
    cancel(id) {
      return window.api.tasks.cancel(id)
    },
    retry(id) {
      return window.api.tasks.retry(id)
    },
    async remove(id, deleteFiles = false) {
      const r = await window.api.tasks.remove(id, deleteFiles)
      this.list = this.list.filter((t) => t.id !== id)
      return r
    },
    detail(id) {
      return window.api.tasks.detail(id)
    }
  }
})
