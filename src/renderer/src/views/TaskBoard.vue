<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { RefreshCw, ClipboardList, MessageCircle, Trash2 } from 'lucide-vue-next'
import { useTasksStore } from '../stores/tasks.js'
import { useConversationStore } from '../stores/conversation.js'
import { notify } from '../notify.js'
import DownloadDetailDialog from '../components/DownloadDetailDialog.vue'

const tasks = useTasksStore()
const conversation = useConversationStore()
const router = useRouter()

const showDetail = ref(false)
const detailId = ref('')
const expanded = ref({}) // 任務 id → 是否展開全部進行中的檔案
const selected = ref({}) // 任務 id → 是否勾選(批次移除用)

const FINISHED = ['done', 'canceled', 'error', 'interrupted']
const selectedIds = computed(() => Object.keys(selected.value).filter((k) => selected.value[k]))
const finishedCount = computed(() => tasks.list.filter((t) => FINISHED.includes(t.status)).length)

function toggleSel(id, v) {
  selected.value = { ...selected.value, [id]: v }
}
// 移除任務的確認框(自繪,取代系統原生對話框)
const removing = ref(false)
const removeAsk = ref({ show: false, ids: [], title: '', message: '', bytes: 0, deleteFiles: false })

function askRemove(mode, one) {
  let ids = []
  let title = '移除任務'
  if (mode === 'finished') {
    ids = tasks.list.filter((t) => FINISHED.includes(t.status)).map((t) => t.id)
    title = `清除 ${ids.length} 個已結束的任務`
  } else if (mode === 'selected') {
    ids = selectedIds.value.slice()
    title = `移除選取的 ${ids.length} 個任務`
  } else if (one) {
    ids = [one.id]
    title = '移除這個任務'
  }
  if (!ids.length) return
  const bytes = tasks.list
    .filter((t) => ids.includes(t.id))
    .reduce((a, t) => a + (t.stats?.doneBytes || 0), 0)
  removeAsk.value = {
    show: true,
    ids,
    title,
    message: ids.length > 1 ? `確定要移除這 ${ids.length} 個任務嗎?` : '確定要移除這個任務嗎?',
    bytes,
    deleteFiles: false
  }
}

async function doRemove() {
  const { ids, deleteFiles } = removeAsk.value
  removing.value = true
  let deleted = 0
  let freed = 0
  for (const id of ids) {
    const r = await tasks.remove(id, deleteFiles)
    deleted += r?.deleted || 0
    freed += r?.freed || 0
  }
  removing.value = false
  removeAsk.value.show = false
  selected.value = {}
  notify.success({
    title: `已移除 ${ids.length} 個任務`,
    content: deleteFiles
      ? `並刪除 ${deleted} 個檔案,釋出 ${fmtBytes(freed)}`
      : '已下載的檔案不受影響'
  })
}

onMounted(() => tasks.load())

const CUR_PREVIEW = 4 // 收合時先顯示幾個

const STATUS = {
  queued: { label: '排隊中', cls: 'grey' },
  scanning: { label: '掃描中', cls: 'blue' },
  downloading: { label: '下載中', cls: 'accent' },
  forwarding: { label: '轉發中', cls: 'accent' },
  paused: { label: '已暫停', cls: 'orange' },
  done: { label: '已完成', cls: 'green' },
  canceled: { label: '已取消', cls: 'grey' },
  error: { label: '失敗', cls: 'red' },
  interrupted: { label: '已中斷', cls: 'orange' }
}

function fmtBytes(n) {
  if (!n) return '0 B'
  if (n < 1024) return n + ' B'
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB'
  return (n / 1024 ** 3).toFixed(2) + ' GB'
}
function doneCount(t) {
  if (t.kind === 'forward') return t.stats.forwarded || 0
  return (t.stats.downloaded || 0) + (t.stats.skipped || 0)
}
function fmtSpeed(n) {
  if (!n || n < 1) return ''
  if (n < 1024) return Math.round(n) + ' B/s'
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB/s'
  return (n / 1024 ** 2).toFixed(1) + ' MB/s'
}
function fmtEta(sec) {
  const s = Math.round(sec || 0)
  if (s <= 0) return ''
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  const h = Math.floor(m / 60)
  return `${h} 時 ${m % 60} 分`
}
function pct(t) {
  const total = t.stats?.total || t.stats?.matched || 0
  if (!total) return 0
  const fin = doneCount(t) + (t.stats.failed || 0)
  return Math.min(100, Math.round((fin / total) * 100))
}
/** 位元組進度(比檔案數細,大檔下到一半也看得出來)。 */
function bytePct(t) {
  const tb = t.stats?.totalBytes || 0
  if (!tb) return pct(t)
  return Math.min(100, Math.round(((t.stats.doneBytes || 0) / tb) * 100))
}
function filePct(c) {
  if (c.pct != null) return c.pct
  return c.size ? Math.min(100, Math.round((c.loaded / c.size) * 100)) : 0
}
function curList(t) {
  const all = t.stats?.current || []
  return expanded.value[t.id] ? all : all.slice(0, CUR_PREVIEW)
}
function toggleExpand(t) {
  expanded.value[t.id] = !expanded.value[t.id]
}

async function retryFailed(t) {
  const r = await tasks.retry(t.id)
  if (r?.ok) {
    if (r.rescanned) {
      notify.success({
        title: '已重新掃描這個任務',
        content: '找不到失敗明細(可能是舊版任務),改成整個重掃;已下載好的檔案會自動略過'
      })
    } else {
      notify.success({ title: `已重新排入 ${r.count} 個失敗項目` })
    }
  } else {
    notify.error({ title: '無法重試', content: r?.error || '' })
  }
}

/** 跳到該檔案在對話裡的那則訊息。 */
async function jumpToMsg(t, msgId) {
  if (!t.dialogId || !msgId) return
  router.push({ name: 'chat' })
  const r = await conversation.jumpTo({ id: t.dialogId, title: t.dialogTitle }, msgId)
  if (r && r.ok === false) notify.error({ title: '跳轉失敗', content: r.error || '' })
}

function openDetail(id) {
  detailId.value = id
  showDetail.value = true
}
async function revealFolder(t) {
  const r = await tasks.detail(t.id)
  const first = r?.success?.find((x) => x.path)
  if (first) window.api.download.reveal(first.path)
  else notify.info({ title: '尚無已完成檔案可開啟' })
}
function goChat() {
  router.push({ name: 'chat' })
  notify.info({ title: '在對話頁工具列點「批量下載」即可建立任務', duration: 3500 })
}
</script>

<template>
  <div class="board">
    <div class="head">
      <div class="head-title">
        <div class="head-icon"><ClipboardList :size="20" /></div>
        <div>
          <h3>任務台</h3>
          <p class="head-sub">批量下載 / 轉發任務的進度與控制</p>
        </div>
      </div>
      <div class="grow" />
      <n-button size="small" tertiary @click="tasks.load"><RefreshCw :size="14" style="margin-right:4px" /> 重新整理</n-button>
      <n-button v-if="finishedCount" size="small" tertiary @click="askRemove('finished')">
        <Trash2 :size="14" style="margin-right: 4px" /> 清除已完成 {{ finishedCount }}
      </n-button>
      <n-button size="small" type="primary" @click="goChat">＋ 新增批量下載</n-button>
    </div>

    <div v-if="!tasks.list.length" class="empty">
      <div class="emoji"><ClipboardList :size="48" /></div>
      <p>尚無任務。到對話頁工具列點「批量下載」建立。</p>
      <n-button size="small" @click="goChat">前往對話頁</n-button>
    </div>

    <!-- 勾選後的批次操作列 -->
    <div v-if="selectedIds.length" class="selbar">
      <span>已選取 {{ selectedIds.length }} 個</span>
      <div class="grow" />
      <n-button size="tiny" @click="selected = {}">取消選取</n-button>
      <n-button size="tiny" type="error" ghost @click="askRemove('selected')">
        移除選取的 {{ selectedIds.length }} 個
      </n-button>
    </div>

    <div v-if="tasks.list.length" class="list">
      <div v-for="t in tasks.list" :key="t.id" class="card" :class="{ picked: selected[t.id] }">
        <div class="top">
          <n-checkbox :checked="!!selected[t.id]" @update:checked="(v) => toggleSel(t.id, v)" />
          <span class="kind" :class="t.kind">{{ t.kind === 'forward' ? '轉發' : '下載' }}</span>
          <div class="ttl">
            <span class="name">{{ t.title }}</span>
            <span class="sub">{{ t.dialogTitle }}<template v-if="t.kind === 'forward'"> → {{ t.targetTitle }}</template></span>
          </div>
          <span class="badge" :class="(STATUS[t.status] || {}).cls">{{ (STATUS[t.status] || {}).label || t.status }}</span>
        </div>

        <div class="bar">
          <div class="fill" :style="{ width: (t.kind === 'forward' ? pct(t) : bytePct(t)) + '%' }" />
        </div>

        <div class="stats">
          <span v-if="t.kind === 'forward'">已轉發 {{ t.stats.forwarded || 0 }}/{{ t.stats.total || t.stats.matched || 0 }}</span>
          <template v-else>
            <span>成功 {{ (t.stats.downloaded || 0) + (t.stats.skipped || 0) }}/{{ t.stats.total || t.stats.matched || 0 }}</span>
            <span v-if="t.stats.skipped">已存在 {{ t.stats.skipped }}</span>
            <!-- 已下載 / 總容量:掃描完才知道總量 -->
            <span class="bytes">
              {{ fmtBytes(t.stats.doneBytes || t.stats.bytes) }}
              <template v-if="t.stats.totalBytes"> / {{ fmtBytes(t.stats.totalBytes) }}</template>
            </span>
            <span v-if="t.stats.speed" class="spd">{{ fmtSpeed(t.stats.speed) }}</span>
            <span v-if="t.stats.eta && t.status === 'downloading'">剩 {{ fmtEta(t.stats.eta) }}</span>
          </template>
          <span v-if="t.stats.failed" class="fail">失敗 {{ t.stats.failed }}</span>
        </div>

        <!-- 目前下載中的檔案:各自的進度條 / 大小 / 速率 -->
        <div v-if="t.stats.current && t.stats.current.length" class="current">
          <div v-for="c in curList(t)" :key="c.msgId" class="cur">
            <div class="cur-top">
              <span class="cn" :title="c.name">{{ c.name }}</span>
              <button
                v-if="t.dialogId"
                class="jump"
                title="跳到對話中的這則訊息"
                @click="jumpToMsg(t, c.msgId)"
              >
                <MessageCircle :size="12" />
              </button>
              <span class="csz">
                {{ fmtBytes(c.loaded || 0) }}<template v-if="c.size"> / {{ fmtBytes(c.size) }}</template>
              </span>
              <span v-if="c.speed" class="cspd">{{ fmtSpeed(c.speed) }}</span>
              <span class="cp">{{ filePct(c) }}%</span>
            </div>
            <div class="cbar"><div class="cfill" :style="{ width: filePct(c) + '%' }" /></div>
          </div>
          <button
            v-if="t.stats.current.length > CUR_PREVIEW"
            class="more"
            @click="toggleExpand(t)"
          >
            {{ expanded[t.id] ? '收起' : `顯示全部 ${t.stats.current.length} 個` }}
          </button>
        </div>

        <div v-if="t.error" class="errline">{{ t.error }}</div>

        <div class="actions">
          <n-button v-if="['downloading', 'forwarding'].includes(t.status)" size="tiny" @click="tasks.pause(t.id)">暫停</n-button>
          <n-button v-if="t.status === 'paused'" size="tiny" type="primary" @click="tasks.resume(t.id)">繼續</n-button>
          <n-button v-if="t.status === 'interrupted'" size="tiny" type="primary" @click="tasks.resume(t.id)">重新執行</n-button>
          <n-button
            v-if="['downloading', 'forwarding', 'paused', 'scanning', 'queued'].includes(t.status)"
            size="tiny"
            type="error"
            ghost
            @click="tasks.cancel(t.id)"
          >
            停止
          </n-button>
          <n-button
            v-if="t.kind !== 'forward' && t.stats.failed && !['scanning', 'downloading'].includes(t.status)"
            size="tiny"
            type="warning"
            ghost
            @click="retryFailed(t)"
          >
            重試失敗 {{ t.stats.failed }}
          </n-button>
          <n-button size="tiny" @click="openDetail(t.id)">詳情</n-button>
          <n-button v-if="t.kind !== 'forward'" size="tiny" @click="revealFolder(t)">開資料夾</n-button>
          <n-button
            v-if="['done', 'canceled', 'error', 'interrupted'].includes(t.status)"
            size="tiny"
            quaternary
            @click="askRemove('one', t)"
          >
            移除
          </n-button>
        </div>
      </div>
    </div>

    <!-- 移除任務確認(自繪,不用系統原生對話框) -->
    <n-modal
      v-model:show="removeAsk.show"
      preset="card"
      :title="removeAsk.title"
      style="width: 460px"
      :bordered="false"
      :mask-closable="!removing"
    >
      <div class="rm-body">
        <div class="rm-icon" :class="{ danger: removeAsk.deleteFiles }">
          <Trash2 :size="20" />
        </div>
        <div class="rm-text">
          <p>{{ removeAsk.message }}</p>
          <p class="rm-sub">任務只是從列表消失,預設<b>不會動到你已經下載好的檔案</b>。</p>
        </div>
      </div>

      <div class="rm-opt" :class="{ on: removeAsk.deleteFiles }">
        <n-checkbox v-model:checked="removeAsk.deleteFiles">
          同時刪除這些任務下載到的本機檔案
        </n-checkbox>
        <div v-if="removeAsk.deleteFiles" class="rm-warn">
          ⚠ 會實際刪除硬碟上的檔案(共約 {{ fmtBytes(removeAsk.bytes) }}),而且<b>不會進資源回收筒</b>,刪掉就沒了。
        </div>
      </div>

      <template #footer>
        <div class="rm-foot">
          <div class="grow" />
          <n-button size="small" :disabled="removing" @click="removeAsk.show = false">取消</n-button>
          <n-button
            size="small"
            type="error"
            :loading="removing"
            @click="doRemove"
          >
            {{ removeAsk.deleteFiles ? '移除並刪除檔案' : '移除任務' }}
          </n-button>
        </div>
      </template>
    </n-modal>

    <DownloadDetailDialog v-model:show="showDetail" :task-id="detailId" />
  </div>
</template>

<style scoped>
.board {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px 20px;
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}
.head-title {
  display: flex;
  align-items: center;
  gap: 12px;
}
.head-icon {
  width: 42px;
  height: 42px;
  border-radius: 13px;
  background: var(--accent-grad);
  color: #fff;
  display: grid;
  place-items: center;
  flex: none;
  box-shadow: var(--shadow-card);
}
.head h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}
.head-sub {
  margin: 2px 0 0;
  font-size: 12.5px;
  color: var(--text-2);
}
.grow {
  flex: 1;
}
.empty {
  flex: 1;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 10px;
  color: var(--text-2);
}
.empty .emoji {
  font-size: 44px;
}
.list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}
.card {
  position: relative;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 13px 15px;
  box-shadow: var(--shadow-card);
  transition: border-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
}
.card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--card-hi);
  pointer-events: none;
}
.card:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  transform: translateY(-1px);
}
.card > * {
  position: relative;
}
.top {
  display: flex;
  align-items: center;
  gap: 10px;
}
.card.picked {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--bg-1));
}
.selbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 10px;
  border: 1px solid var(--accent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 10%, var(--bg-1));
  font-size: 13px;
  flex: none;
}
.kind {
  font-size: 10.5px;
  padding: 2px 8px;
  border-radius: 8px;
  flex: none;
  font-weight: 600;
}
.kind.download {
  background: rgba(91, 108, 255, 0.18);
  color: #8ea2ff;
}
.kind.forward {
  background: rgba(245, 121, 59, 0.18);
  color: #f5a35b;
}
.ttl {
  flex: 1;
  min-width: 0;
}
.name {
  font-weight: 600;
  font-size: 14px;
}
.sub {
  font-size: 12px;
  color: var(--text-2);
  margin-left: 8px;
}
.badge {
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 10px;
  background: var(--bg-3);
  color: var(--text-1);
  flex: none;
}
.badge.green {
  background: rgba(43, 191, 122, 0.18);
  color: var(--green);
}
.badge.red {
  background: rgba(229, 72, 77, 0.18);
  color: var(--red);
}
.badge.orange {
  background: rgba(245, 158, 66, 0.18);
  color: #f6a350;
}
.badge.blue,
.badge.accent {
  background: rgba(91, 108, 255, 0.18);
  color: #8ea2ff;
}
.bar {
  height: 6px;
  background: var(--bg-3);
  border-radius: 4px;
  overflow: hidden;
  margin: 10px 0 8px;
}
.fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  transition: width 0.3s;
}
.stats {
  display: flex;
  gap: 14px;
  font-size: 12px;
  color: var(--text-2);
}
.stats .fail {
  color: var(--red);
}
.stats .bytes {
  color: var(--text-1);
}
.stats .spd {
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.current {
  margin-top: 9px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.cur {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.cur-top {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-2);
}
.cur .cn {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cur .jump {
  border: none;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  padding: 1px 3px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  flex: none;
}
.cur .jump:hover {
  color: var(--accent);
  background: var(--bg-3);
}
.cur .csz,
.cur .cspd {
  flex: none;
  font-variant-numeric: tabular-nums;
}
.cur .cspd {
  color: var(--accent);
}
.cur .cp {
  color: var(--accent);
  flex: none;
  min-width: 30px;
  text-align: right;
  font-variant-numeric: tabular-nums;
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
.more {
  align-self: flex-start;
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 0;
}
.more:hover {
  color: var(--accent);
}
.errline {
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--red);
}
.actions {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.rm-body {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.rm-icon {
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 11px;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--text-2) 16%, transparent);
  color: var(--text-1);
  transition: background 0.16s, color 0.16s;
}
.rm-icon.danger {
  background: color-mix(in srgb, var(--red) 18%, transparent);
  color: var(--red);
}
.rm-text p {
  margin: 0 0 6px;
  font-size: 14px;
}
.rm-text .rm-sub {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.7;
  margin: 0;
}
.rm-opt {
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-2);
  transition: border-color 0.16s, background 0.16s;
}
.rm-opt.on {
  border-color: color-mix(in srgb, var(--red) 55%, transparent);
  background: color-mix(in srgb, var(--red) 8%, var(--bg-2));
}
.rm-warn {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--red);
}
.rm-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
