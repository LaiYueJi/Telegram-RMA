<script setup>
import { ref, watch, computed, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { MessageCircle, FolderOpen } from 'lucide-vue-next'
import { useTasksStore } from '../stores/tasks.js'
import { useConversationStore } from '../stores/conversation.js'
import { notify } from '../notify.js'

const props = defineProps({ show: Boolean, taskId: String })
const emit = defineEmits(['update:show'])
const tasks = useTasksStore()
const conversation = useConversationStore()
const router = useRouter()

const tab = ref('success')
const detail = ref({ current: [], pending: [], success: [], failed: [], dialogId: '', dialogTitle: '' })
const loading = ref(false)
let timer = null

function fmtBytes(n) {
  if (!n) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB'
  return (n / 1024 ** 3).toFixed(2) + ' GB'
}
function fmtSpeed(n) {
  if (!n || n < 1) return ''
  if (n < 1024) return Math.round(n) + ' B/s'
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB/s'
  return (n / 1024 ** 2).toFixed(1) + ' MB/s'
}
function sum(list) {
  return (list || []).reduce((a, b) => a + (b.size || 0), 0)
}
// 明細可能因為舊版任務而遺失,但 stats 一直都有;用它決定要不要給「重新掃描」的出口
const failedCount = computed(() => {
  const t = tasks.list.find((x) => x.id === props.taskId)
  return t?.stats?.failed || 0
})
const pendingSize = computed(() => sum(detail.value.pending))
const successSize = computed(() => sum(detail.value.success))
const failedSize = computed(() => sum(detail.value.failed))

async function refresh() {
  if (!props.taskId) return
  loading.value = true
  const r = await tasks.detail(props.taskId)
  loading.value = false
  if (r?.ok) {
    detail.value = {
      current: r.current || [],
      pending: r.pending || [],
      success: r.success || [],
      failed: r.failed || [],
      dialogId: r.dialogId || '',
      dialogTitle: r.dialogTitle || ''
    }
  }
}
watch(
  () => props.show,
  (v) => {
    clearInterval(timer)
    if (v) {
      tab.value = detail.value.current.length ? 'current' : 'success'
      refresh()
      // 開著的時候自動更新,「下載中」那頁才會動
      timer = setInterval(refresh, 1000)
    }
  }
)
onUnmounted(() => clearInterval(timer))

function reveal(path) {
  if (path) window.api.download.reveal(path)
}

async function retryFailed() {
  const r = await tasks.retry(props.taskId)
  if (r?.ok) {
    notify.success({
      title: r.rescanned ? '已重新掃描這個任務' : `已重新排入 ${r.count} 個失敗項目`,
      content: r.rescanned ? '已下載好的檔案會自動略過' : ''
    })
    refresh()
  } else {
    notify.error({ title: '無法重試', content: r?.error || '' })
  }
}

/** 跳到對話裡的那則訊息(關掉這個視窗再跳)。 */
async function jump(msgId) {
  if (!detail.value.dialogId || !msgId) return
  emit('update:show', false)
  router.push({ name: 'chat' })
  const r = await conversation.jumpTo(
    { id: detail.value.dialogId, title: detail.value.dialogTitle },
    msgId
  )
  if (r && r.ok === false) notify.error({ title: '跳轉失敗', content: r.error || '' })
}
</script>

<template>
  <n-modal
    :show="show"
    @update:show="(v) => emit('update:show', v)"
    preset="card"
    title="下載詳情"
    style="width: 620px"
    :bordered="false"
  >
    <n-tabs v-model:value="tab" type="line" size="small">
      <n-tab-pane name="current" :tab="`下載中 (${detail.current.length})`">
        <div v-if="detail.current.length" class="sumline">
          同時進行 {{ detail.current.length }} 個(可在「系統設定 → 批量下載同時檔案數」調整)
        </div>
        <div class="list">
          <div v-if="!detail.current.length" class="empty">目前沒有正在下載的檔案</div>
          <div v-for="it in detail.current" :key="it.msgId" class="row cur">
            <div class="cur-top">
              <span class="nm" :title="it.name">{{ it.name }}</span>
              <span class="sz">
                {{ fmtBytes(it.loaded) }}<template v-if="it.size"> / {{ fmtBytes(it.size) }}</template>
              </span>
              <span v-if="it.speed" class="spd">{{ fmtSpeed(it.speed) }}</span>
              <span class="pc">{{ it.pct }}%</span>
              <button class="act" title="跳到對話中的這則訊息" @click="jump(it.msgId)">
                <MessageCircle :size="13" />
              </button>
            </div>
            <div class="cbar"><div class="cfill" :style="{ width: it.pct + '%' }" /></div>
          </div>
        </div>
      </n-tab-pane>
      <n-tab-pane name="success" :tab="`成功 (${detail.success.length})`">
        <div v-if="detail.success.length" class="sumline">
          共 {{ detail.success.length }} 個 · {{ fmtBytes(successSize) || '—' }}
        </div>
        <div class="list">
          <div v-if="!detail.success.length" class="empty">尚無</div>
          <div v-for="it in detail.success" :key="it.msgId" class="row">
            <span class="nm" :title="it.name">{{ it.name }}</span>
            <span class="sz">{{ fmtBytes(it.size) }}</span>
            <span class="tag">{{ it.skipped ? '已存在' : '完成' }}</span>
            <button class="act" title="跳到對話中的這則訊息" @click="jump(it.msgId)">
              <MessageCircle :size="13" />
            </button>
            <button class="act" title="開啟所在資料夾" @click="reveal(it.path)">
              <FolderOpen :size="13" />
            </button>
          </div>
        </div>
      </n-tab-pane>
      <n-tab-pane name="pending" :tab="`待下載 (${detail.pending.length})`">
        <div v-if="detail.pending.length" class="sumline">
          還要下載 {{ detail.pending.length }} 個 · {{ fmtBytes(pendingSize) || '大小未知' }}
        </div>
        <div class="list">
          <div v-if="!detail.pending.length" class="empty">尚無</div>
          <div v-for="it in detail.pending" :key="it.msgId" class="row">
            <span class="kd">{{ it.kind }}</span>
            <span class="nm" :title="it.name">{{ it.name }}</span>
            <span class="sz">{{ fmtBytes(it.size) }}</span>
            <button class="act" title="跳到對話中的這則訊息" @click="jump(it.msgId)">
              <MessageCircle :size="13" />
            </button>
          </div>
        </div>
      </n-tab-pane>
      <n-tab-pane name="failed" :tab="`失敗 (${detail.failed.length})`">
        <div v-if="detail.failed.length" class="sumline">
          共 {{ detail.failed.length }} 個 · {{ fmtBytes(failedSize) || '—' }}
        </div>
        <div class="list">
          <div v-if="!detail.failed.length" class="empty">尚無</div>
          <div v-for="it in detail.failed" :key="it.msgId" class="row err">
            <span class="nm" :title="it.name">{{ it.name }}</span>
            <span class="sz">{{ fmtBytes(it.size) }}</span>
            <span class="ex" :title="it.error">{{ it.error }}</span>
            <button class="act" title="跳到對話中的這則訊息" @click="jump(it.msgId)">
              <MessageCircle :size="13" />
            </button>
          </div>
        </div>
      </n-tab-pane>
    </n-tabs>
    <template #footer>
      <div class="foot">
        <n-button size="small" :loading="loading" @click="refresh">重新整理</n-button>
        <n-button v-if="detail.failed.length" size="small" type="warning" ghost @click="retryFailed">
          重試失敗 {{ detail.failed.length }} 個
        </n-button>
        <n-button
          v-else-if="failedCount"
          size="small"
          type="warning"
          ghost
          title="找不到失敗明細,會改用重新掃描的方式補下載"
          @click="retryFailed"
        >
          重新掃描補下載
        </n-button>
        <div class="grow" />
        <n-button size="small" type="primary" @click="emit('update:show', false)">關閉</n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.list {
  max-height: 380px;
  overflow-y: auto;
}
.empty {
  color: var(--text-2);
  text-align: center;
  padding: 24px;
  font-size: 13px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
}
.row:hover {
  background: var(--bg-2);
}
.sumline {
  font-size: 12px;
  color: var(--text-2);
  padding: 2px 8px 8px;
}
.nm {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sz {
  flex: none;
  font-size: 11.5px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.kd {
  flex: none;
  font-size: 10.5px;
  color: var(--text-2);
  background: var(--bg-3);
  padding: 1px 6px;
  border-radius: 5px;
}
.act {
  flex: none;
  border: none;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
}
.act:hover {
  color: var(--accent);
  background: var(--bg-3);
}
/* 下載中:每個檔案一條進度 */
.row.cur {
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
}
.cur-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.spd,
.pc {
  flex: none;
  font-size: 11.5px;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.pc {
  min-width: 34px;
  text-align: right;
}
.cbar {
  height: 3px;
  background: var(--bg-3);
  border-radius: 3px;
  overflow: hidden;
}
.cfill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  transition: width 0.3s;
}
.tag {
  font-size: 10.5px;
  color: var(--green);
  background: rgba(43, 191, 122, 0.15);
  padding: 1px 6px;
  border-radius: 5px;
}
.ex {
  color: var(--red);
  font-size: 11px;
  max-width: 50%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.foot {
  display: flex;
  align-items: center;
}
.grow {
  flex: 1;
}
</style>
