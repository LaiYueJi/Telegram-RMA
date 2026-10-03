<script setup>
/**
 * 通知中心鈴鐺(鈴鐺鈕 + 下載進度 popover)。
 * 抽成共用元件,集中下載清單顯示與暫停/繼續/取消/開啟資料夾等操作。
 */
import { Bell, X, Pause, Play, FolderOpen, ClipboardList } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import { useNotificationsStore } from '../stores/notifications.js'
import { notify } from '../notify.js'

defineProps({
  placement: { type: String, default: 'bottom-end' }
})

const notifications = useNotificationsStore()
const router = useRouter()

const TASK_LABEL = {
  queued: '排隊中',
  scanning: '掃描中',
  downloading: '下載中',
  forwarding: '轉發中',
  paused: '已暫停',
  done: '已完成',
  canceled: '已取消',
  error: '失敗',
  interrupted: '已中斷'
}

function itemKey(item) {
  return item.kind === 'task' ? 't_' + item.id : item.dialogId + '_' + item.msgId
}
function fmtSize(n) {
  if (!n) return '0 B'
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
function fmtEta(sec) {
  const s = Math.round(sec || 0)
  if (s <= 0) return ''
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分`
  return `${Math.floor(m / 60)} 時 ${m % 60} 分`
}
function taskPause(item) {
  window.api.tasks.pause(item.id)
}
async function taskResume(item) {
  const r = await window.api.tasks.resume(item.id)
  if (r && r.ok === false && r.error) notify.error({ title: '無法繼續', content: r.error })
}
function goBoard() {
  router.push({ name: 'tasks' })
}
function notifPct(item) {
  if (!item.total) return 0
  return Math.min(100, Math.round((item.downloaded / item.total) * 100))
}
function revealItem(item) {
  if (item.path) window.api.download.reveal(item.path)
}
function pauseItem(item) {
  window.api.download.pause(item.dialogId, item.msgId)
}
async function resumeItem(item) {
  const r = await window.api.download.resume(item.dialogId, item.msgId)
  // 續傳失敗(如未連線、代理關閉、訊息抓不到)→ 明確提示,不再默默卡在「已暫停」
  if (r && r.ok === false && r.error) {
    notify.error({ title: '無法續傳', content: r.error })
  }
}
function cancelItem(item) {
  window.api.download.cancel(item.dialogId, item.msgId)
  notifications.remove(`${item.dialogId}_${item.msgId}`)
}
</script>

<template>
  <n-popover trigger="click" :placement="placement" :width="340">
    <template #trigger>
      <button class="bellbtn" title="通知">
        <Bell class="icon-bell" :size="17" />
        <span v-if="notifications.activeCount" class="badge">{{ notifications.activeCount }}</span>
      </button>
    </template>
    <div class="notify-pop">
      <div class="np-head">
        <span class="np-title">通知中心</span>
        <button v-if="notifications.total" class="np-clear" @click="notifications.clear()">清除已完成</button>
      </div>
      <div v-if="!notifications.total" class="np-empty">尚無下載任務</div>
      <div v-else class="np-list">
        <!-- 批量任務 -->
        <template v-for="item in notifications.list" :key="itemKey(item)">
          <div v-if="item.kind === 'task'" class="np-item">
            <div class="np-item-top">
              <span class="np-kind">{{ item.taskKind === 'forward' ? '轉發' : '批量' }}</span>
              <span class="np-name" :title="item.name">{{ item.name }}</span>
              <span class="np-status" :class="item.status">{{ TASK_LABEL[item.status] || item.status }}</span>
            </div>
            <div v-if="['downloading', 'forwarding', 'paused', 'scanning'].includes(item.status)" class="np-bar">
              <div
                class="np-bar-fill"
                :class="{ paused: item.status === 'paused' }"
                :style="{ width: notifications.pctTask(item) + '%' }"
              />
            </div>
            <div class="np-item-foot">
              <span class="np-size">
                {{ item.done }}/{{ item.totalFiles }} 個
                <template v-if="item.total"> · {{ fmtSize(item.downloaded) }} / {{ fmtSize(item.total) }}</template>
                <template v-if="item.speed"> · {{ fmtSpeed(item.speed) }}</template>
                <template v-if="item.eta"> · 剩 {{ fmtEta(item.eta) }}</template>
                <template v-if="item.failed"> · <span class="err">失敗 {{ item.failed }}</span></template>
              </span>
              <div class="np-acts">
                <button v-if="['downloading', 'forwarding'].includes(item.status)" title="暫停" @click="taskPause(item)"><Pause :size="13" /></button>
                <button v-if="item.status === 'paused'" title="繼續" @click="taskResume(item)"><Play :size="13" /></button>
                <button title="到任務台" @click="goBoard"><ClipboardList :size="13" /></button>
                <button
                  v-if="!['downloading', 'forwarding', 'scanning'].includes(item.status)"
                  title="移除"
                  @click="notifications.removeTask(item.id)"
                >
                  <X :size="13" />
                </button>
              </div>
            </div>
          </div>

          <!-- 單檔下載 -->
          <div v-else class="np-item">
          <div class="np-item-top">
            <span class="np-name" :title="item.name">{{ item.name }}</span>
            <span class="np-status" :class="item.status">
              <template v-if="item.status === 'downloading'">{{ notifPct(item) }}%</template>
              <template v-else-if="item.status === 'paused'">已暫停</template>
              <template v-else-if="item.status === 'done'">{{ item.skipped ? '已存在' : '完成' }}</template>
              <template v-else-if="item.status === 'error'">失敗</template>
            </span>
          </div>
          <div v-if="item.status === 'downloading' || item.status === 'paused'" class="np-bar">
            <div class="np-bar-fill" :class="{ paused: item.status === 'paused' }" :style="{ width: notifPct(item) + '%' }" />
          </div>
          <div class="np-item-foot">
            <span class="np-size">
              <template v-if="item.status === 'done'">{{ fmtSize(item.total) }}</template>
              <template v-else-if="item.status === 'error'" class="err">{{ item.error }}</template>
              <template v-else>
                {{ fmtSize(item.downloaded) }} / {{ fmtSize(item.total) }}
                <template v-if="item.status === 'downloading' && notifications.speedText(item)">
                  · {{ notifications.speedText(item) }}<template v-if="notifications.etaText(item)"> · 剩 {{ notifications.etaText(item) }}</template>
                </template>
              </template>
            </span>
            <div class="np-acts">
              <button v-if="item.status === 'downloading'" title="暫停" @click="pauseItem(item)"><Pause :size="13" /></button>
              <button v-if="item.status === 'paused'" title="繼續" @click="resumeItem(item)"><Play :size="13" /></button>
              <button v-if="item.status === 'done'" title="開啟資料夾" @click="revealItem(item)"><FolderOpen :size="13" /></button>
              <button v-if="item.status === 'downloading' || item.status === 'paused'" title="取消" @click="cancelItem(item)"><X :size="13" /></button>
              <button v-if="item.status === 'done' || item.status === 'error'" title="移除" @click="notifications.remove(item.dialogId + '_' + item.msgId)"><X :size="13" /></button>
            </div>
          </div>
          </div>
        </template>
      </div>
    </div>
  </n-popover>
</template>

<style scoped>
/* 預設:頂部列圖示鈕 */
.bellbtn {
  width: 34px;
  height: 34px;
  border: none;
  background: transparent;
  color: var(--text-1);
  border-radius: 8px;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: transform 0.2s ease, background 0.15s;
  position: relative;
}
.bellbtn:hover {
  background: var(--bg-2);
}
.icon-bell {
  transition: transform 0.3s ease;
}
.bellbtn:hover .icon-bell {
  transform: scale(1.25);
}

.badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  background: var(--red);
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  border-radius: 8px;
  display: grid;
  place-items: center;
  line-height: 1;
}

.notify-pop { padding: 4px 0; }
.np-head { display: flex; align-items: center; justify-content: space-between; padding: 0 4px 8px; border-bottom: 1px solid var(--border); margin-bottom: 8px; }
.np-title { font-size: 13px; font-weight: 600; }
.np-clear { border: none; background: transparent; color: var(--text-2); font-size: 11px; cursor: pointer; }
.np-clear:hover { color: var(--accent); }
.np-empty { font-size: 12px; color: var(--text-2); padding: 18px 8px; text-align: center; }
.np-list { max-height: 360px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.np-item { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.np-item-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.np-name { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
.np-kind {
  flex: none;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 6px;
  background: rgba(91, 108, 255, 0.18);
  color: #8ea2ff;
}
.np-status { font-size: 11px; font-weight: 600; flex: none; }
.np-status.downloading { color: var(--accent); }
.np-status.paused { color: var(--text-2); }
.np-status.done { color: var(--green); }
.np-status.error { color: var(--red); }
.np-bar { height: 4px; background: var(--bg-3); border-radius: 2px; margin: 6px 0; overflow: hidden; }
.np-bar-fill { height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.3s; }
.np-bar-fill.paused { background: var(--text-2); }
.np-item-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; }
.np-size { font-size: 10.5px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.np-acts { display: flex; gap: 4px; flex: none; }
.np-acts button { width: 24px; height: 24px; border: none; background: var(--bg-3); color: var(--text-1); border-radius: 6px; cursor: pointer; display: grid; place-items: center; transition: background 0.12s; }
.np-acts button:hover { background: var(--accent); color: #fff; }
</style>
