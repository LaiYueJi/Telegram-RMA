import { createRouter, createWebHashHistory } from 'vue-router'
import { useAccountStore } from './stores/account.js'

const routes = [
  { path: '/', redirect: '/chat' },
  {
    path: '/login',
    name: 'login',
    component: () => import('./views/Login.vue'),
    meta: { fullscreen: true }
  },
  { path: '/chat', name: 'chat', component: () => import('./views/Conversation.vue') },
  { path: '/accounts', name: 'accounts', component: () => import('./views/Accounts.vue') },
  { path: '/protocol-tool', name: 'protocol-tool', component: () => import('./views/ProtocolTools.vue') },
  { path: '/tasks', name: 'tasks', component: () => import('./views/TaskBoard.vue') },
  { path: '/automation', name: 'automation', component: () => import('./views/Automation.vue') },
  { path: '/search', name: 'search', component: () => import('./views/Search.vue') }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

// 未授權一律導去登入頁
router.beforeEach(async (to) => {
  const account = useAccountStore()
  if (!account.loaded) await account.refresh()
  // 有 session 但還在連線中 → 等它,不然開機那一下會被誤判成未登入而跳到掃碼頁
  if (!account.authorized && account.hasSession && account.connecting) {
    await account.waitForConnect()
  }
  if (to.name !== 'login' && !account.authorized) {
    return { name: 'login' }
  }
  if (to.name === 'login' && account.authorized) {
    return { name: 'chat' }
  }
  return true
})

export default router
