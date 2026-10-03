<script setup>
import { useRoute, useRouter } from 'vue-router'
import { MessageCircle, Wallet, ClipboardList, Clock, Search } from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()

const items = [
  { name: 'chat', label: '對話', icon: MessageCircle },
  { name: 'search', label: '消息檢索', icon: Search },
  { name: 'automation', label: '自動化', icon: Clock },
  { name: 'tasks', label: '任務台', icon: ClipboardList },
  { name: 'accounts', label: '帳號', icon: Wallet }
]

function go(name) {
  if (route.name !== name) router.push({ name })
}
</script>

<template>
  <nav class="sidenav">
    <button
      v-for="it in items"
      :key="it.name"
      class="navitem"
      :class="{ active: route.name === it.name }"
      @click="go(it.name)"
    >
      <component :is="it.icon" :size="18" class="i" />
      <span class="t">{{ it.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.sidenav {
  width: 72px;
  flex: none;
  background: var(--bg-1);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 10px;
  gap: 6px;
}
.navitem {
  width: 60px;
  height: 58px;
  border: none;
  background: transparent;
  color: var(--text-1);
  border-radius: 12px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.navitem .i {
  /* lucide icon renders as svg */
}
.navitem .t {
  font-size: 11px;
}
.navitem:hover {
  background: var(--bg-2);
  color: var(--text-0);
}
.navitem.active {
  background: linear-gradient(135deg, rgba(91, 108, 255, 0.25), rgba(124, 92, 255, 0.25));
  color: var(--text-0);
  box-shadow: inset 0 0 0 1px var(--accent);
}
</style>
