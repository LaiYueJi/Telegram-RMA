<script setup>
import { ref, watch, computed } from 'vue'
import { useTasksStore } from '../stores/tasks.js'
import { useDialogsStore } from '../stores/dialogs.js'
import { notify } from '../notify.js'
import ChatSelector from './ChatSelector.vue'

const props = defineProps({
  show: Boolean,
  dialogId: String,
  dialogTitle: String,
  messageIds: { type: Array, default: null } // 有值 = 單則/指定轉發
})
const emit = defineEmits(['update:show', 'created'])

const tasks = useTasksStore()
const dialogs = useDialogsStore()

const TYPES = [
  { label: '圖片', value: 'photo' },
  { label: '影片', value: 'video' },
  { label: '文件', value: 'document' },
  { label: '音訊', value: 'audio' },
  { label: '純文字', value: 'text' }
]

const targetId = ref('')
const dropAuthor = ref(false)
const mediaOnly = ref(false)
const types = ref([])
const keyword = ref('')
const startDate = ref(null)
const endDate = ref(null)
const submitting = ref(false)

const isSingle = computed(() => Array.isArray(props.messageIds) && props.messageIds.length > 0)
const targetTitle = computed(() => dialogs.list.find((d) => d.id === targetId.value)?.title || '')

watch(
  () => props.show,
  (v) => {
    if (v) {
      targetId.value = ''
      dropAuthor.value = false
      mediaOnly.value = false
      types.value = []
      keyword.value = ''
      startDate.value = null
      endDate.value = null
    }
  }
)

async function submit() {
  if (!props.dialogId) return notify.warning({ title: '請先選擇來源對話' })
  if (!targetId.value) return notify.warning({ title: '請選擇轉發目標' })
  submitting.value = true
  const cfg = {
    title: `轉發 ${props.dialogTitle || ''} → ${targetTitle.value}`,
    dialogId: props.dialogId,
    dialogTitle: props.dialogTitle,
    targetId: targetId.value,
    targetTitle: targetTitle.value,
    dropAuthor: dropAuthor.value,
    messageIds: isSingle.value ? props.messageIds : null,
    filter: isSingle.value
      ? {}
      : {
          mediaOnly: mediaOnly.value,
          types: types.value.slice(),
          keyword: keyword.value.trim(),
          startDate: startDate.value ? Math.floor(startDate.value / 1000) : null,
          endDate: endDate.value ? Math.floor(endDate.value / 1000) + 86399 : null
        }
  }
  const r = await tasks.createForward(cfg)
  submitting.value = false
  if (r?.ok) {
    notify.success({ title: '已建立轉發任務', content: '可到「任務台」查看進度' })
    emit('created', r.id)
    emit('update:show', false)
  } else {
    notify.error({ title: '建立失敗', content: r?.error || '' })
  }
}
</script>

<template>
  <n-modal
    :show="show"
    @update:show="(v) => emit('update:show', v)"
    preset="card"
    :title="isSingle ? '轉發訊息' : '批量轉發'"
    style="width: 560px"
    :bordered="false"
  >
    <div class="src">
      來源:<b>{{ dialogTitle || '(未選擇)' }}</b>
      <span v-if="isSingle" class="cnt">· {{ messageIds.length }} 則</span>
    </div>

    <div class="label">轉發到</div>
    <ChatSelector v-model="targetId" />

    <n-checkbox v-model:checked="dropAuthor" class="opt">去除來源標記(不顯示「轉發自」)</n-checkbox>

    <template v-if="!isSingle">
      <div class="label mt">篩選(不選=全部)</div>
      <n-checkbox v-model:checked="mediaOnly">僅轉發含媒體的訊息</n-checkbox>
      <n-checkbox-group v-model:value="types" class="types">
        <n-checkbox v-for="t in TYPES" :key="t.value" :value="t.value" :label="t.label" />
      </n-checkbox-group>
      <n-input v-model:value="keyword" placeholder="內容關鍵詞(選填)" size="small" class="mt8" />
      <div class="two mt8">
        <n-date-picker v-model:value="startDate" type="date" clearable size="small" placeholder="開始" style="width: 100%" />
        <n-date-picker v-model:value="endDate" type="date" clearable size="small" placeholder="結束" style="width: 100%" />
      </div>
    </template>

    <template #footer>
      <div class="foot">
        <span class="hint">轉發到目標對話;大量轉發會自動分批並退避 FloodWait</span>
        <div class="grow" />
        <n-button @click="emit('update:show', false)">取消</n-button>
        <n-button type="primary" :loading="submitting" :disabled="!targetId" @click="submit">開始轉發</n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.src {
  font-size: 13px;
  color: var(--text-1);
  margin-bottom: 10px;
}
.cnt {
  color: var(--text-2);
}
.label {
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 6px;
}
.label.mt {
  margin-top: 14px;
}
.opt {
  margin-top: 10px;
}
.types {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-top: 8px;
}
.mt8 {
  margin-top: 8px;
}
.two {
  display: flex;
  gap: 10px;
}
.foot {
  display: flex;
  align-items: center;
  gap: 10px;
}
.foot .hint {
  font-size: 11px;
  color: var(--text-2);
}
.grow {
  flex: 1;
}
</style>
