<script setup>
import { computed, ref, watch, nextTick, onMounted } from 'vue'
import {
  ArrowLeft, X, MoreVertical, Image, Video, File, Headphones, Link2, BarChart3,
  Mic, Pin, Gift, Users, Calendar, ZoomIn, ZoomOut, ExternalLink, Play
} from 'lucide-vue-next'
import { useSharedMediaStore, KIND_LABEL } from '../stores/sharedMedia.js'
import SquareThumb from './SquareThumb.vue'
import MediaCalendar from './MediaCalendar.vue'
import DownloadButton from './DownloadButton.vue'
import Avatar from './Avatar.vue'

/**
 * 共享媒體側欄。對應官方客戶端點對話標題後那一排「N 張照片 / N 個影片 / …」,
 * 點進去分月瀏覽、可跳日期、可直接下載,私聊另有「禮物」與「共同的群組」。
 */
const props = defineProps({
  dialogId: String,
  dialogType: String,
  dialogTitle: { type: String, default: '' },
  // 開啟時要直接進哪一個分頁(如置頂橫幅的「查看全部」)。空字串 = 停在分類總覽
  initialKind: { type: String, default: '' },
  // 父層(Conversation)的下載狀態表,直接沿用同一份,進度/已下載打勾才會一致
  downloads: { type: Object, default: () => ({}) }
})
const emit = defineEmits(['close', 'jump', 'view', 'download', 'pause', 'resume', 'cancel', 'reveal', 'openDialog'])

const shared = useSharedMediaStore()
const scrollEl = ref(null)
const showMenu = ref(false)

watch(
  () => [props.dialogId, props.dialogType],
  ([id, type]) => shared.openFor(id, type),
  { immediate: true }
)

// 面板是 v-if 掛上來的,掛載當下若指定了分頁就直接進去
// (openFor 的同步段已在 immediate watcher 跑完,dialogId 這時候一定是對的)
onMounted(() => {
  if (props.initialKind) shared.openKind(props.initialKind)
})

const KIND_ICON = {
  photo: Image, video: Video, document: File, audio: Headphones, url: Link2,
  poll: BarChart3, voice: Mic, gif: Image, pinned: Pin, gift: Gift, common: Users
}

const headTitle = computed(() => {
  if (!shared.kind) return '共享媒體'
  const n = shared.kind === 'poll' ? (shared.pollScan.done ? shared.pollScan.found : null) : null
  if (shared.kind === 'poll') return KIND_LABEL.poll(n)
  const c = shared.counters?.[shared.kind]?.count
  return KIND_LABEL[shared.kind]?.(c ?? shared.items.length) || '共享媒體'
})

/** 方格分頁才有「放大/縮小/日曆」;禮物沒有日曆。 */
const canCalendar = computed(() => ['photo', 'video', 'gif', 'document', 'audio', 'url', 'voice'].includes(shared.kind))
const canZoom = computed(() => shared.isGrid)

// ---------------------------------------------------------------- 分月

function monthLabel(unix) {
  const d = new Date(unix * 1000)
  const now = new Date()
  return d.getFullYear() === now.getFullYear()
    ? `${d.getMonth() + 1}月`
    : `${d.getFullYear()}年${d.getMonth() + 1}月`
}
function dayLabel(unix) {
  const d = new Date(unix * 1000)
  const ap = d.getHours() < 12 ? '上午' : '下午'
  const h = d.getHours() % 12 || 12
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${ap} ${h}:${String(d.getMinutes()).padStart(2, '0')}`
}
function shortDate(unix) {
  const d = new Date(unix * 1000)
  const ap = d.getHours() < 12 ? '上午' : '下午'
  const h = d.getHours() % 12 || 12
  return `${d.getMonth() + 1}月${d.getDate()}日 ${ap} ${h}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 依月份分段(禮物/共同群組不分段)。 */
const groups = computed(() => {
  if (shared.kind === 'common') return [{ label: '', items: shared.items }]
  const out = []
  let cur = null
  for (const it of shared.items) {
    const label = it.date ? monthLabel(it.date) : ''
    if (!cur || cur.label !== label) {
      cur = { label, items: [] }
      out.push(cur)
    }
    cur.items.push(it)
  }
  return out
})

// ---------------------------------------------------------------- 互動

const VIEWABLE = ['photo', 'video', 'gif', 'audio', 'voice']
/** 目前清單裡可進燈箱的項目(給 MediaViewer 用的精簡格式)。 */
const viewables = computed(() =>
  shared.items
    .filter((m) => m.media && VIEWABLE.includes(m.media.kind))
    .map((m) => ({
      id: m.id,
      kind: m.media.kind,
      fileName: m.media.fileName,
      width: m.media.width,
      height: m.media.height,
      size: m.media.size
    }))
)

function onItemClick(item) {
  if (item.media && VIEWABLE.includes(item.media.kind)) {
    const idx = viewables.value.findIndex((v) => v.id === item.id)
    if (idx >= 0) return emit('view', { items: viewables.value, index: idx })
  }
  emit('jump', item.id)
}

async function openKind(kind) {
  showMenu.value = false
  await shared.openKind(kind)
  await nextTick()
  if (scrollEl.value) scrollEl.value.scrollTop = 0
}

function onScroll() {
  const el = scrollEl.value
  if (!el || shared.calendar) return
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) shared.loadMore()
}

function onCalendarPick(period) {
  shared.closeCalendar()
  // 從那一天最後一則往回讀 → 方格分頁就會從那天開始
  shared.openKind(shared.kind, { offsetId: period.maxMsgId + 1 })
}

function openLink(url) {
  if (url) window.api.openExternal(url)
}

// ---------------------------------------------------------------- 顯示小工具

const EXT_COLOR = {
  exe: '#2bbf7a', msi: '#2bbf7a', pdf: '#e5484d', zip: '#f5a623', rar: '#f5a623',
  '7z': '#f5a623', txt: '#5b6cff', doc: '#3a6ff7', docx: '#3a6ff7', xls: '#1f9d55',
  xlsx: '#1f9d55', ppt: '#e06c2b', pptx: '#e06c2b', apk: '#59c04a', iso: '#8a6cff'
}
function extOf(name) {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name || '')
  return m ? m[1].toLowerCase() : ''
}
function fileColor(name) {
  return EXT_COLOR[extOf(name)] || 'var(--bg-3)'
}
function fmtSize(n) {
  if (!n) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB'
  return (n / 1024 ** 3).toFixed(2) + ' GB'
}
function fmtDur(s) {
  if (!s) return '00:00'
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
function audioTitle(it) {
  const a = it.audioMeta
  if (a?.title) return a.performer ? `${a.performer} – ${a.title}` : a.title
  return it.media?.fileName || '音訊'
}
function linkOf(it) {
  return it.webpage?.url || it.urls?.[0] || ''
}
function linkHost(it) {
  const u = linkOf(it)
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return it.webpage?.displayUrl || u
  }
}
</script>

<template>
  <aside class="sp">
    <header class="sp-head">
      <button v-if="shared.kind" class="hbtn" title="返回" @click="shared.back()">
        <ArrowLeft :size="17" />
      </button>
      <span class="sp-title">{{ headTitle }}</span>
      <div class="grow" />

      <div v-if="canZoom || canCalendar" class="menuwrap">
        <button class="hbtn" title="更多" @click="showMenu = !showMenu"><MoreVertical :size="17" /></button>
        <div v-if="showMenu" class="menu" @click.stop>
          <button v-if="canZoom" @click="shared.setCols(shared.cols - 1)"><ZoomIn :size="15" /> 放大</button>
          <button v-if="canZoom" @click="shared.setCols(shared.cols + 1)"><ZoomOut :size="15" /> 縮小</button>
          <button v-if="canCalendar" @click="showMenu = false; shared.loadCalendar(0)">
            <Calendar :size="15" /> 日曆
          </button>
        </div>
      </div>
      <button class="hbtn" title="關閉" @click="emit('close')"><X :size="17" /></button>
    </header>

    <!-- 日曆疊在內容上面 -->
    <div v-if="shared.calendar" class="calwrap">
      <MediaCalendar
        :dialog-id="dialogId"
        :kind="shared.kind"
        :periods="shared.calendar.periods"
        :min-date="shared.calendar.minDate"
        :loading="shared.calendarLoading"
        @pick="onCalendarPick"
        @close="shared.closeCalendar()"
        @need-older="(id) => shared.loadCalendar(id)"
      />
    </div>

    <div ref="scrollEl" class="sp-body" @scroll="onScroll" @click="showMenu = false">
      <!-- ── 分類總覽 ── -->
      <template v-if="!shared.kind">
        <div v-if="shared.countersLoading" class="center"><n-spin size="small" /> 讀取中…</div>
        <div v-else-if="shared.countersError" class="center err">{{ shared.countersError }}</div>
        <template v-else>
          <button v-for="row in shared.overviewRows" :key="row.kind" class="ovrow" @click="openKind(row.kind)">
            <component :is="KIND_ICON[row.kind]" :size="19" class="ovicon" />
            <span class="ovlabel">
              {{ KIND_LABEL[row.kind](row.count) }}<span v-if="row.inexact">+</span>
            </span>
            <span v-if="row.kind === 'poll' && row.count == null" class="ovhint">點擊掃描</span>
          </button>
          <div v-if="!shared.overviewRows.length" class="center muted">這個對話還沒有共享媒體</div>
          <div v-if="shared.extrasLoading" class="center muted sm"><n-spin size="small" /> 讀取禮物 / 共同群組…</div>
        </template>
      </template>

      <!-- ── 投票:沒有伺服器 filter,要掃 ── -->
      <template v-else-if="shared.kind === 'poll'">
        <div v-if="shared.pollScan.running" class="scanbox">
          <n-spin size="small" />
          <div class="scantext">
            掃描中… 已檢查 {{ shared.pollScan.scanned.toLocaleString() }} 則,找到
            {{ shared.pollScan.found }} 個投票
          </div>
          <n-button size="tiny" @click="shared.cancelPollScan()">停止</n-button>
        </div>
        <div v-else-if="!shared.pollScan.done" class="scanbox col">
          <BarChart3 :size="30" class="muted" />
          <div class="scantext">
            Telegram 伺服器沒有「投票」這個篩選器,只能翻歷史找 —— 訊息多的話會花一點時間。
          </div>
          <n-button size="small" type="primary" @click="shared.startPollScan()">開始掃描</n-button>
        </div>
        <template v-else>
          <div v-if="shared.pollScan.partial" class="notice">
            已掃描 {{ shared.pollScan.scanned.toLocaleString() }} 則(未掃完整個對話),結果可能不完整。
          </div>
          <div v-for="g in groups" :key="g.label">
            <div v-if="g.label" class="mhead">{{ g.label }}</div>
            <button v-for="it in g.items" :key="it.id" class="pollcard" @click="emit('jump', it.id)">
              <div class="pq">{{ it.poll?.question || '(無題目)' }}</div>
              <div v-for="(a, i) in it.poll?.answers || []" :key="i" class="pa">○ {{ a }}</div>
              <div class="pmeta">
                {{ it.poll?.totalVoters || 0 }} 人投票 ·
                {{ it.poll?.closed ? '已結束' : '進行中' }} · {{ shortDate(it.date) }}
              </div>
            </button>
          </div>
          <div v-if="!shared.items.length" class="center muted">沒有找到投票</div>
        </template>
      </template>

      <!-- ── 禮物 ── -->
      <template v-else-if="shared.kind === 'gift'">
        <div v-if="shared.loading" class="center"><n-spin size="small" /> 讀取中…</div>
        <template v-else>
          <div class="giftgrid" :style="{ '--cols': shared.cols }">
            <button v-for="g in shared.items" :key="g.id" class="giftcard" :title="g.text" @click="g.msgId && emit('jump', g.msgId)">
              <img v-if="g.sticker" :src="g.sticker" alt="" />
              <div v-else class="giftph"><Gift :size="26" /></div>
              <div class="giftmeta">
                <span v-if="g.stars" class="stars">⭐ {{ g.stars }}</span>
                <span v-if="g.limited" class="tag">限量</span>
              </div>
            </button>
          </div>
          <div class="giftnote">
            這些禮物均已贈送給 <b>{{ dialogTitle }}</b>。
          </div>
        </template>
      </template>

      <!-- ── 共同的群組 ── -->
      <template v-else-if="shared.kind === 'common'">
        <div v-if="shared.loading" class="center"><n-spin size="small" /> 讀取中…</div>
        <button v-for="c in shared.items" :key="c.id" class="chatrow" @click="emit('openDialog', c)">
          <Avatar :peer-id="c.id" :title="c.title" :has-photo="c.hasPhoto" :size="40" />
          <div class="crinfo">
            <div class="crtitle">{{ c.title }}</div>
            <div class="crsub">
              {{ c.type === 'channel' ? '頻道' : '群組' }}
              <template v-if="c.participants"> · {{ c.participants }} 位成員</template>
            </div>
          </div>
        </button>
      </template>

      <!-- ── 有伺服器 filter 的分類 ── -->
      <template v-else>
        <div v-if="shared.loading" class="center"><n-spin size="small" /> 載入中…</div>
        <div v-else-if="shared.error" class="center err">{{ shared.error }}</div>
        <template v-else>
          <div v-for="g in groups" :key="g.label">
            <div v-if="g.label" class="mhead">{{ g.label }}</div>

            <!-- 方格:照片 / 影片 / GIF -->
            <div v-if="shared.isGrid" class="grid" :style="{ '--cols': shared.cols }">
              <SquareThumb
                v-for="it in g.items"
                :key="it.id"
                :dialog-id="dialogId"
                :msg-id="it.id"
                :kind="it.media?.kind"
                :thumb="it.thumb"
                :has-thumb="it.hasThumb"
                :duration="it.media?.duration"
                @click="onItemClick(it)"
              />
            </div>

            <!-- 連結 -->
            <template v-else-if="shared.kind === 'url'">
              <div v-for="it in g.items" :key="it.id" class="linkrow" @click="emit('jump', it.id)">
                <SquareThumb
                  v-if="it.hasThumb"
                  class="lthumb"
                  :dialog-id="dialogId"
                  :msg-id="it.id"
                  :thumb="it.thumb"
                  :has-thumb="it.hasThumb"
                />
                <div v-else class="lph" :style="{ background: fileColor(linkHost(it)) }">
                  {{ (linkHost(it)[0] || '?').toUpperCase() }}
                </div>
                <div class="linfo">
                  <div class="ltitle">{{ it.webpage?.title || it.text?.slice(0, 60) || linkHost(it) }}</div>
                  <div v-if="it.webpage?.description" class="ldesc">{{ it.webpage.description }}</div>
                  <a
                    v-for="(u, i) in it.urls.slice(0, 2)"
                    :key="i"
                    class="lurl"
                    :title="u"
                    @click.stop="openLink(u)"
                  >{{ u }}</a>
                  <div class="lmeta">{{ shortDate(it.date) }}</div>
                </div>
                <ExternalLink :size="14" class="lext" />
              </div>
            </template>

            <!-- 語音訊息 -->
            <template v-else-if="shared.kind === 'voice'">
              <div v-for="it in g.items" :key="it.id" class="filerow" @click="onItemClick(it)">
                <button class="playtile"><Play :size="16" /></button>
                <div class="finfo">
                  <div class="fname">{{ it.out ? '我' : it.senderName || '語音訊息' }}</div>
                  <div class="fmeta">{{ dayLabel(it.date) }}, {{ fmtDur(it.media?.duration) }}</div>
                </div>
                <DownloadButton
                  :download="downloads[it.id]"
                  @download="emit('download', it)"
                  @pause="emit('pause', it)"
                  @resume="emit('resume', it)"
                  @cancel="emit('cancel', it)"
                  @reveal="emit('reveal', downloads[it.id]?.path)"
                />
              </div>
            </template>

            <!-- 音訊檔 -->
            <template v-else-if="shared.kind === 'audio'">
              <div v-for="it in g.items" :key="it.id" class="filerow" @click="onItemClick(it)">
                <SquareThumb
                  v-if="it.hasThumb"
                  class="atile"
                  :dialog-id="dialogId"
                  :msg-id="it.id"
                  :thumb="it.thumb"
                  :has-thumb="it.hasThumb"
                  round
                />
                <button v-else class="playtile"><Play :size="16" /></button>
                <div class="finfo">
                  <div class="fname">{{ audioTitle(it) }}</div>
                  <div class="fmeta">{{ fmtDur(it.media?.duration) }} · {{ fmtSize(it.media?.size) }}</div>
                </div>
                <DownloadButton
                  :download="downloads[it.id]"
                  @download="emit('download', it)"
                  @pause="emit('pause', it)"
                  @resume="emit('resume', it)"
                  @cancel="emit('cancel', it)"
                  @reveal="emit('reveal', downloads[it.id]?.path)"
                />
              </div>
            </template>

            <!-- 置頂訊息 -->
            <template v-else-if="shared.kind === 'pinned'">
              <div v-for="it in g.items" :key="it.id" class="pinrow" @click="emit('jump', it.id)">
                <Avatar
                  :peer-id="it.out ? '' : it.senderId"
                  :title="it.out ? '我' : it.senderName || dialogTitle"
                  :has-photo="!it.out && it.senderHasPhoto !== false"
                  :size="34"
                />
                <div class="pinfo">
                  <div class="pname">{{ it.out ? '我' : it.senderName || dialogTitle }}</div>
                  <div class="ptext">{{ it.text || (it.media ? `[${it.media.kind}]` : '') }}</div>
                  <div class="pmeta">{{ shortDate(it.date) }}</div>
                </div>
              </div>
            </template>

            <!-- 檔案 -->
            <template v-else>
              <div v-for="it in g.items" :key="it.id" class="filerow" @click="emit('jump', it.id)">
                <SquareThumb
                  v-if="it.hasThumb"
                  class="atile"
                  :dialog-id="dialogId"
                  :msg-id="it.id"
                  :thumb="it.thumb"
                  :has-thumb="it.hasThumb"
                />
                <div v-else class="ftile" :style="{ background: fileColor(it.media?.fileName) }">
                  {{ extOf(it.media?.fileName) || '?' }}
                </div>
                <div class="finfo">
                  <div class="fname">{{ it.media?.fileName || '檔案' }}</div>
                  <div class="fmeta">{{ fmtSize(it.media?.size) }} · {{ shortDate(it.date) }}</div>
                </div>
                <DownloadButton
                  :download="downloads[it.id]"
                  @download="emit('download', it)"
                  @pause="emit('pause', it)"
                  @resume="emit('resume', it)"
                  @cancel="emit('cancel', it)"
                  @reveal="emit('reveal', downloads[it.id]?.path)"
                />
              </div>
            </template>
          </div>

          <div v-if="shared.loadingMore" class="center sm"><n-spin size="small" /> 載入更多…</div>
          <div v-else-if="!shared.items.length" class="center muted">沒有內容</div>
        </template>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.sp {
  width: 340px;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--border);
  background: var(--bg-1);
  position: relative;
}
.sp-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 8px 8px 10px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.sp-title {
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.grow {
  flex: 1;
}
.hbtn {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  color: var(--text-1);
  border-radius: 7px;
  cursor: pointer;
  flex: none;
}
.hbtn:hover {
  background: var(--bg-3);
  color: var(--text-0);
}
.menuwrap {
  position: relative;
}
.menu {
  position: absolute;
  right: 0;
  top: 34px;
  z-index: 30;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow-pop);
  padding: 4px;
  min-width: 118px;
}
.menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  background: transparent;
  color: var(--text-0);
  font-size: 12.5px;
  border-radius: 7px;
  cursor: pointer;
}
.menu button:hover {
  background: var(--bg-3);
}
.calwrap {
  position: absolute;
  top: 46px;
  left: 8px;
  right: 8px;
  z-index: 25;
}
.sp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}

/* 總覽 */
.ovrow {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 11px 12px;
  border: none;
  background: transparent;
  color: var(--text-0);
  border-radius: 10px;
  cursor: pointer;
  text-align: left;
}
.ovrow:hover {
  background: var(--bg-2);
}
.ovicon {
  color: var(--text-1);
  flex: none;
}
.ovlabel {
  font-size: 13.5px;
  color: var(--accent);
}
.ovhint {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-2);
}

/* 分月標題 */
.mhead {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
  padding: 10px 6px 6px;
  position: sticky;
  top: -6px;
  background: var(--bg-1);
  z-index: 5;
}

/* 方格 */
.grid {
  display: grid;
  grid-template-columns: repeat(var(--cols, 3), 1fr);
  gap: 3px;
}

/* 檔案 / 音訊 / 語音列 */
.filerow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 6px;
  border-radius: 10px;
  cursor: pointer;
}
.filerow:hover {
  background: var(--bg-2);
}
.ftile,
.playtile,
.atile {
  width: 42px;
  height: 42px;
  flex: none;
  border-radius: 9px;
}
.ftile {
  display: grid;
  place-items: center;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}
.playtile {
  display: grid;
  place-items: center;
  border: none;
  background: var(--accent);
  color: #fff;
  border-radius: 50%;
  cursor: pointer;
}
.finfo {
  flex: 1;
  min-width: 0;
}
.fname {
  font-size: 12.5px;
  color: var(--text-0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fmeta {
  font-size: 11px;
  color: var(--text-2);
  margin-top: 2px;
}

/* 連結 */
.linkrow {
  display: flex;
  gap: 10px;
  padding: 8px 6px;
  border-radius: 10px;
  cursor: pointer;
}
.linkrow:hover {
  background: var(--bg-2);
}
.lthumb,
.lph {
  width: 42px;
  height: 42px;
  flex: none;
  border-radius: 9px;
}
.lph {
  display: grid;
  place-items: center;
  color: #fff;
  font-weight: 700;
}
.linfo {
  flex: 1;
  min-width: 0;
}
.ltitle {
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ldesc {
  font-size: 11.5px;
  color: var(--text-1);
  margin-top: 2px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.lurl {
  display: block;
  font-size: 11.5px;
  color: var(--accent);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.lurl:hover {
  text-decoration: underline;
}
.lmeta {
  font-size: 10.5px;
  color: var(--text-2);
  margin-top: 3px;
}
.lext {
  color: var(--text-2);
  flex: none;
  align-self: center;
}

/* 置頂訊息 */
.pinrow {
  display: flex;
  gap: 10px;
  padding: 8px 6px;
  border-radius: 10px;
  cursor: pointer;
}
.pinrow:hover {
  background: var(--bg-2);
}
.pinfo {
  flex: 1;
  min-width: 0;
}
.pname {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--accent);
}
.ptext {
  font-size: 12.5px;
  margin-top: 2px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.pmeta {
  font-size: 10.5px;
  color: var(--text-2);
  margin-top: 3px;
}

/* 投票 */
.scanbox {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 12px;
}
.scanbox.col {
  flex-direction: column;
  text-align: center;
  gap: 12px;
  padding: 34px 18px;
}
.scantext {
  flex: 1;
  font-size: 12px;
  color: var(--text-1);
  line-height: 1.7;
}
.notice {
  font-size: 11.5px;
  color: var(--amber);
  padding: 8px 10px;
  background: color-mix(in srgb, var(--amber) 12%, transparent);
  border-radius: 8px;
  margin-bottom: 6px;
}
.pollcard {
  display: block;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  margin-bottom: 6px;
  border: 1px solid var(--border);
  background: var(--bg-2);
  border-radius: 12px;
  cursor: pointer;
  color: var(--text-0);
}
.pollcard:hover {
  border-color: var(--accent);
}
.pq {
  font-size: 12.5px;
  font-weight: 600;
  margin-bottom: 6px;
}
.pa {
  font-size: 12px;
  color: var(--text-1);
  padding: 2px 0;
}

/* 禮物 */
.giftgrid {
  display: grid;
  grid-template-columns: repeat(var(--cols, 3), 1fr);
  gap: 6px;
}
.giftcard {
  position: relative;
  aspect-ratio: 1;
  border: 1px solid var(--border);
  background: var(--bg-2);
  border-radius: 12px;
  cursor: pointer;
  display: grid;
  place-items: center;
  padding: 8px;
  overflow: hidden;
}
.giftcard:hover {
  border-color: var(--accent);
}
.giftcard img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.giftph {
  color: var(--text-2);
}
.giftmeta {
  position: absolute;
  left: 4px;
  right: 4px;
  bottom: 4px;
  display: flex;
  gap: 4px;
  justify-content: center;
}
.stars,
.tag {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 99px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
}
.tag {
  background: var(--accent);
}
.giftnote {
  text-align: center;
  font-size: 11.5px;
  color: var(--text-2);
  padding: 14px 10px;
}

/* 共同的群組 */
.chatrow {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 6px;
  border: none;
  background: transparent;
  color: var(--text-0);
  border-radius: 10px;
  cursor: pointer;
  text-align: left;
}
.chatrow:hover {
  background: var(--bg-2);
}
.crinfo {
  flex: 1;
  min-width: 0;
}
.crtitle {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.crsub {
  font-size: 11px;
  color: var(--text-2);
  margin-top: 2px;
}

.center {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 26px 12px;
  font-size: 12.5px;
  color: var(--text-1);
}
.center.sm {
  padding: 12px;
  font-size: 11.5px;
}
.center.muted {
  color: var(--text-2);
}
.center.err {
  color: var(--red);
}
.muted {
  color: var(--text-2);
}
</style>
