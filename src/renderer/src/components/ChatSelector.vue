<script setup>
import { ref, computed, onMounted } from 'vue'
import { Search, Star } from 'lucide-vue-next'
import { useDialogsStore } from '../stores/dialogs.js'
import Avatar from './Avatar.vue'

const props = defineProps({
  modelValue: String // 選中的 dialogId
})
const emit = defineEmits(['update:modelValue', 'pick'])

const dialogs = useDialogsStore()
const kw = ref('')

onMounted(() => dialogs.load())

const list = computed(() => {
  const q = kw.value.trim().toLowerCase()
  const base = dialogs.list
  if (!q) return base.slice(0, 200)
  return base
    .filter((d) => d.title.toLowerCase().includes(q) || (d.username || '').toLowerCase().includes(q))
    .slice(0, 200)
})

function pick(d) {
  emit('update:modelValue', d.id)
  emit('pick', d)
}
</script>

<template>
  <div class="cs">
    <n-input v-model:value="kw" placeholder="搜尋對話…" clearable size="small">
      <template #prefix><Search :size="14" /></template>
    </n-input>
    <div class="list">
      <div v-if="dialogs.loading" class="hint"><n-spin size="small" /> 載入中…</div>
      <div
        v-for="d in list"
        :key="d.id"
        class="item"
        :class="{ on: modelValue === d.id }"
        @click="pick(d)"
      >
        <div v-if="d.isSaved" class="sav"><Star :size="16" /></div>
        <Avatar v-else :peer-id="d.id" :title="d.title" :has-photo="d.hasPhoto" :size="32" />
        <span class="t">{{ d.title }}</span>
        <span class="ty">{{ d.type === 'channel' ? '頻道' : d.type === 'group' ? '群' : '私' }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cs {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.list {
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.hint {
  text-align: center;
  color: var(--text-2);
  padding: 16px;
  font-size: 13px;
}
.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  cursor: pointer;
  border-left: 3px solid transparent;
}
.item:hover {
  background: var(--bg-2);
}
.item.on {
  background: var(--bg-2);
  border-left-color: var(--accent);
}
.sav {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #f6c350, #f59e42);
  flex: none;
}
.t {
  flex: 1;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ty {
  font-size: 10px;
  color: var(--text-2);
  background: var(--bg-3);
  padding: 0 5px;
  border-radius: 4px;
}
</style>
