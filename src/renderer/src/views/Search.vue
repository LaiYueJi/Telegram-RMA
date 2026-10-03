<script setup>
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useSearchStore } from '../stores/search.js'
import { useConversationStore } from '../stores/conversation.js'
import { useDialogsStore } from '../stores/dialogs.js'
import { notify } from '../notify.js'
import {
  Search, SlidersHorizontal, X, Download, Link2, ArrowRight,
  MessageSquare, Image, Video, FileText, Mic, Music, Link as LinkIcon,
  CalendarDays, Filter
} from 'lucide-vue-next'
import ExportDialog from '../components/ExportDialog.vue'
import DownloadFilterDialog from '../components/DownloadFilterDialog.vue'
import MediaThumb from '../components/MediaThumb.vue'
import MediaViewer from '../components/MediaViewer.vue'

const search = useSearchStore()
const conversation = useConversationStore()
const dialogs = useDialogsStore()
const router = useRouter()
const route = useRoute()

const inputEl = ref(null)

onMounted(() => {
  // 從對話頁帶 scope 進來(如 Ctrl+F 篩選當前對話 / hashtag 點擊)
  if (route.query.scope) search.scope = route.query.scope
  if (route.query.q) {
    search.query = route.query.q
    doSearch()
  } else {
    // 無關鍵詞:只是跳轉過來,聚焦輸入框讓使用者直接打字
    nextTick(() => inputEl.value?.focus())
  }
})

const TYPES = [
  { label: '圖片', value: 'photo', icon: Image },
  { label: '影片', value: 'video', icon: Video },
  { label: '文件', value: 'document', icon: FileText },
  { label: '語音', value: 'voice', icon: Mic },
  { label: '音訊', value: 'audio', icon: Music },
  { label: '連結', value: 'url', icon: LinkIcon }
]
const SCOPES = [
  { label: '全部聊天', value: 'global' },
  { label: '當前對話', value: 'current' }
]

const showExport = ref(false)
const showBatch = ref(false)
const showFilters = ref(false)

const curTitle = computed(() => conversation.current?.title || '')
const activeFilterCount = computed(() => {
  let n = 0
  if (search.types.length) n += search.types.length
  if (search.startDate) n++
  if (search.endDate) n++
  if (search.scope === 'current') n++
  return n
})

function fmtTime(unix) {
  const d = new Date(unix * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const MEDIA = { photo: '圖片', video: '影片', gif: 'GIF', document: '文件', voice: '語音', audio: '音訊', sticker: '貼圖' }
function mediaIcon(kind) {
  return { photo: Image, video: Video, gif: Video, document: FileText, voice: Mic, audio: Music }[kind] || FileText
}

function doSearch() {
  if (search.scope === 'current' && !conversation.current) {
    return notify.warning({ title: '請先在對話頁開啟一個對話', content: '或切換到「全部聊天」搜尋' })
  }
  showFilters.value = false
  showViewer.value = false
  search.run(conversation.current?.id)
}

/* 每筆結果右側內嵌縮圖(取代舊的右側「媒體總覽」面板);點縮圖 → 燈箱。 */
const VIEWABLE = ['photo', 'video', 'gif']

// 可預覽媒體清單(照結果順序)— 內嵌縮圖與燈箱共用
const mediaResults = computed(() => search.results.filter((r) => r.media && VIEWABLE.includes(r.media.kind)))
const lightboxItems = computed(() =>
  mediaResults.value.map((r) => ({
    id: r.id, dialogId: r.dialogId, kind: r.media.kind,
    fileName: r.media.fileName, width: r.media.width, height: r.media.height, size: r.media.size
  }))
)
const showViewer = ref(false)
const viewerIndex = ref(0)
// 開燈箱(原本對話頁那個:可縮放/旋轉/看資訊/全螢幕、影片有拖拉條、可左右切換所有媒體)
function openViewer(r) {
  const i = mediaResults.value.findIndex((m) => m.dialogId === r.dialogId && m.id === r.id)
  if (i < 0) return
  viewerIndex.value = i
  showViewer.value = true
}
function onViewerDownload(it) {
  if (!it) return
  window.api.download.single(it.dialogId, it.id)
  notify.info({ title: '已開始下載', duration: 1800 })
}
function toggleType(v) {
  const i = search.types.indexOf(v)
  if (i >= 0) search.types.splice(i, 1)
  else search.types.push(v)
}
function resetFilters() {
  search.types = []
  search.startDate = null
  search.endDate = null
  search.scope = 'global'
}
function dl(r) {
  window.api.download.single(r.dialogId, r.id)
  notify.info({ title: '已開始下載', content: '完成後可在通知中心查看進度', duration: 2000 })
}
function copyLink(r) {
  if (r.link) {
    navigator.clipboard.writeText(r.link)
    notify.success({ title: '已複製連結', duration: 1500 })
  }
}
function openBatch() {
  if (!conversation.current) return notify.warning({ title: '「丟批量下載」需先在對話頁選一個對話' })
  showBatch.value = true
}

async function goToMessage(r) {
  if (!dialogs.loaded) await dialogs.load()
  const dlg = dialogs.list.find((d) => d.id === String(r.dialogId)) ||
    dialogs.archivedList.find((d) => d.id === String(r.dialogId))
  if (!dlg) return notify.warning({ title: '找不到對話', content: '請先載入對話列表' })
  await conversation.open(dlg)
  router.push({ name: 'chat' })
  setTimeout(() => {
    const el = document.querySelector(`[data-msg-id="${r.id}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, 800)
}
</script>

<template>
  <div class="search">
    <!-- Hero 區 -->
    <div class="hero" :class="{ compact: search.ran }">
      <div v-if="!search.ran" class="hero-icon"><Search :size="30" /></div>
      <h1 v-if="!search.ran" class="hero-title">消息檢索中心</h1>

      <!-- 搜尋列 -->
      <div class="searchbar">
        <Search class="sb-icon" :size="18" />
        <input
          ref="inputEl"
          v-model="search.query"
          class="sb-input"
          placeholder="輸入關鍵詞,例如 會議記錄、方案、鏈接…"
          @keyup.enter="doSearch"
        />
        <div class="sb-divider" />
        <button class="sb-filter" :class="{ on: showFilters || activeFilterCount }" @click="showFilters = !showFilters">
          <SlidersHorizontal :size="15" />
          <span>篩選</span>
          <span v-if="activeFilterCount" class="fcount">{{ activeFilterCount }}</span>
        </button>
        <button class="sb-go" :disabled="search.loading" @click="doSearch">
          <span>搜索</span>
          <ArrowRight :size="15" />
        </button>
      </div>

      <!-- 篩選面板 -->
      <transition name="fade-slide">
        <div v-if="showFilters" class="filter-panel">
          <div class="fp-head">
            <div>
              <div class="fp-title">篩選條件</div>
              <div class="fp-sub">調整後點擊應用,才會刷新當前檢索結果</div>
            </div>
            <button class="fp-close" @click="showFilters = false"><X :size="16" /></button>
          </div>

          <div class="fp-section">
            <div class="fp-label"><CalendarDays :size="14" /> 時間範圍</div>
            <div class="fp-row">
              <n-date-picker v-model:value="search.startDate" type="date" clearable size="small" placeholder="開始時間" style="flex:1" />
              <n-date-picker v-model:value="search.endDate" type="date" clearable size="small" placeholder="結束時間" style="flex:1" />
            </div>
          </div>

          <div class="fp-section">
            <div class="fp-label"><MessageSquare :size="14" /> 聊天對象</div>
            <div class="fp-chips">
              <button
                v-for="s in SCOPES" :key="s.value"
                class="chip" :class="{ on: search.scope === s.value }"
                @click="search.scope = s.value"
              >
                {{ s.value === 'current' && curTitle ? `當前對話 (${curTitle})` : s.label }}
              </button>
            </div>
          </div>

          <div class="fp-section">
            <div class="fp-label"><Filter :size="14" /> 消息類型</div>
            <div class="fp-chips">
              <button
                v-for="t in TYPES" :key="t.value"
                class="chip" :class="{ on: search.types.includes(t.value) }"
                @click="toggleType(t.value)"
              >
                <component :is="t.icon" :size="13" /> {{ t.label }}
              </button>
            </div>
          </div>

          <div class="fp-foot">
            <span class="fp-count">待應用 {{ activeFilterCount }} 個篩選</span>
            <div class="grow" />
            <n-button size="small" quaternary @click="resetFilters">重置</n-button>
            <n-button size="small" type="primary" @click="doSearch">應用</n-button>
          </div>
        </div>
      </transition>
    </div>

    <!-- 說明卡(尚未搜尋時) -->
    <div v-if="!search.ran" class="tip-card">
      <div class="tip-icon">ⓘ</div>
      <div class="tip-text">
        Telegram 為「按詞匹配」,非「包含」關係:中文 / 日文 / 韓文因無空格分詞,相鄰整段文字會被視為「一個詞」,子串通常搜不到(例如搜 "天氣" 不能命中 "今天天氣不錯",需搜整段);不支援識別圖片文字與語音內容。本應用已加入<b>用戶端二次子串過濾</b>以盡量改善中文搜尋。
      </div>
    </div>

    <!-- 結果工具列 -->
    <div v-if="search.ran" class="rtools">
      <span class="count">
        <template v-if="search.loading"><n-spin size="small" /> 搜尋中…</template>
        <template v-else-if="search.error" class="err">{{ search.error }}</template>
        <template v-else>命中 <b>{{ search.results.length }}</b> 筆 · 掃描 {{ search.scanned }}</template>
      </span>
      <div class="grow" />
      <n-button size="small" :disabled="!search.results.length" @click="showExport = true">匯出結果</n-button>
      <n-button size="small" :disabled="search.scope !== 'current'" @click="openBatch">丟批量下載</n-button>
      <n-button size="small" quaternary @click="search.clear">清除</n-button>
    </div>

    <!-- 結果列表:縮圖內嵌在每筆右側(原時間戳位置),時間戳移到群名下方 -->
    <div v-if="search.ran" class="results-wrap">
      <div class="results">
        <div v-if="search.error" class="state err">{{ search.error }}</div>
        <div v-else-if="!search.loading && !search.results.length" class="state">
          <Search :size="40" style="opacity:0.3" />
          <p>無結果</p>
        </div>
        <div
          v-for="r in search.results" :key="r.dialogId + '_' + r.id"
          class="item" @dblclick="goToMessage(r)"
        >
          <div class="item-main">
            <div v-if="search.scope === 'global'" class="dlg">{{ r.dialogTitle || r.dialogId }}</div>
            <div class="meta">
              <span class="time">{{ fmtTime(r.date) }}</span>
              <span class="snd">{{ r.senderName || (r.out ? '我' : '') }}</span>
              <span v-if="r.media" class="mtag"><component :is="mediaIcon(r.media.kind)" :size="11" /> {{ MEDIA[r.media.kind] || r.media.kind }}</span>
            </div>
            <div class="text" v-if="r.text">{{ r.text }}</div>
            <div v-else-if="r.media" class="text muted">[{{ MEDIA[r.media.kind] || r.media.kind }}{{ r.media.fileName ? ' · ' + r.media.fileName : '' }}]</div>
            <div class="acts" @click.stop>
              <button v-if="r.media" class="act" @click="dl(r)"><Download :size="13" /> 下載</button>
              <button v-if="r.link" class="act" @click="copyLink(r)"><Link2 :size="13" /> 複製連結</button>
              <button class="act primary" @click="goToMessage(r)"><ArrowRight :size="13" /> 導航到對話</button>
            </div>
          </div>
          <!-- 縮圖:取代舊的時間戳位置,可點擊放大 / 播放 -->
          <div
            v-if="r.media && VIEWABLE.includes(r.media.kind)"
            class="item-thumb" title="點擊放大 / 播放" @click.stop="openViewer(r)"
          >
            <MediaThumb
              :dialog-id="r.dialogId" :msg-id="r.id" :kind="r.media.kind"
              :duration="r.media.duration" :thumb="r.thumb" :has-thumb="r.hasThumb"
              :width="r.media.width" :height="r.media.height" :size="r.media.size"
              :max-w="150" :max-h="120"
            />
          </div>
        </div>
      </div>
    </div>

    <MediaViewer
      v-model:show="showViewer"
      :items="lightboxItems"
      :start-index="viewerIndex"
      @download="onViewerDownload"
    />

    <ExportDialog v-model:show="showExport" :rows="search.results" :default-name="'檢索結果'" />
    <DownloadFilterDialog
      v-model:show="showBatch"
      :dialog-id="conversation.current?.id"
      :dialog-title="conversation.current?.title"
    />
  </div>
</template>

<style scoped>
.search {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 20px 28px;
  overflow: hidden;
}
/* Hero */
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 8vh;
  transition: padding 0.4s ease;
  position: relative;
}
.hero.compact { padding-top: 8px; }
.hero-icon {
  width: 64px; height: 64px; border-radius: 18px;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  display: grid; place-items: center; color: #fff;
  box-shadow: 0 10px 30px rgba(91, 108, 255, 0.4);
  margin-bottom: 18px;
}
.hero-title { font-size: 30px; font-weight: 800; margin-bottom: 28px; letter-spacing: 1px; }

/* 搜尋列 */
.searchbar {
  width: 100%;
  max-width: 880px;
  height: 56px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 8px 0 18px;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: var(--shadow-card);
}
.searchbar:focus-within { border-color: var(--accent); box-shadow: 0 6px 28px rgba(91,108,255,0.3); }
.sb-icon { color: var(--text-2); flex: none; }
.sb-input {
  flex: 1; border: none; background: transparent; outline: none;
  color: var(--text-0); font-size: 15px;
}
.sb-input::placeholder { color: var(--text-2); }
.sb-divider { width: 1px; height: 24px; background: var(--border); }
.sb-filter {
  display: flex; align-items: center; gap: 6px;
  height: 40px; padding: 0 14px;
  border: 1px solid var(--border); background: var(--bg-2);
  color: var(--text-1); border-radius: 10px; cursor: pointer; font-size: 13px;
}
.sb-filter:hover, .sb-filter.on { border-color: var(--accent); color: var(--accent); }
.sb-filter .fcount {
  background: var(--accent); color: #fff; font-size: 10px;
  min-width: 16px; height: 16px; border-radius: 8px; display: grid; place-items: center; padding: 0 4px;
}
.sb-go {
  display: flex; align-items: center; gap: 6px;
  height: 40px; padding: 0 18px;
  border: none; border-radius: 10px; cursor: pointer; font-size: 14px; font-weight: 600;
  background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff;
}
.sb-go:disabled { opacity: 0.6; cursor: default; }

/* 篩選面板 */
.filter-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 560px;
  max-width: 90vw;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-pop);
  padding: 18px;
  z-index: 30;
}
.hero:not(.compact) .filter-panel { right: 50%; transform: translateX(50%); }
.fp-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
.fp-title { font-size: 15px; font-weight: 700; }
.fp-sub { font-size: 11px; color: var(--text-2); margin-top: 3px; }
.fp-close { border: none; background: transparent; color: var(--text-2); cursor: pointer; }
.fp-close:hover { color: var(--text-0); }
.fp-section { margin-bottom: 16px; }
.fp-label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); margin-bottom: 8px; }
.fp-row { display: flex; gap: 8px; }
.fp-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip {
  display: inline-flex; align-items: center; gap: 5px;
  height: 32px; padding: 0 14px;
  border: 1px solid var(--border); background: var(--bg-2);
  color: var(--text-1); border-radius: 8px; cursor: pointer; font-size: 12.5px;
}
.chip:hover { border-color: var(--accent); }
.chip.on { background: linear-gradient(135deg, var(--accent), var(--accent-2)); border-color: transparent; color: #fff; }
.fp-foot { display: flex; align-items: center; gap: 8px; padding-top: 14px; border-top: 1px solid var(--border); }
.fp-count { font-size: 12px; color: var(--text-2); }

/* 說明卡 */
.tip-card {
  display: flex; gap: 12px;
  max-width: 880px; margin: 28px auto 0;
  background: rgba(245, 159, 11, 0.08);
  border: 1px solid rgba(245, 159, 11, 0.25);
  border-radius: 12px; padding: 14px 16px;
}
.tip-icon { color: #f5a30b; font-size: 16px; flex: none; }
.tip-text { font-size: 12.5px; color: var(--text-1); line-height: 1.7; }
.tip-text b { color: #f5c451; }

/* 結果 */
.rtools { display: flex; align-items: center; gap: 8px; margin: 18px 0 10px; }
.rtools .count { font-size: 13px; color: var(--text-1); }
.rtools .count b { color: var(--accent); }
.grow { flex: 1; }
.results-wrap { flex: 1; display: flex; min-height: 0; }
.results { flex: 1; overflow-y: auto; min-height: 0; }
.state { text-align: center; color: var(--text-2); padding: 50px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.state.err { color: var(--red); }

/* 結果項:左側資訊欄 + 右側內嵌縮圖(取代舊的右側總覽面板) */
.item {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 13px 15px;
  margin-bottom: 10px;
  background: var(--bg-1);
  box-shadow: var(--shadow-card);
  transition: border-color 0.12s, transform 0.1s;
}
.item:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); transform: translateY(-1px); }
.item-main { flex: 1; min-width: 0; }
.item-thumb {
  flex: none; cursor: zoom-in; border-radius: 10px; overflow: hidden;
  align-self: flex-start; transition: transform 0.1s, box-shadow 0.12s;
}
.item-thumb:hover { transform: translateY(-2px); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4); }
.dlg { display: block; color: var(--accent); font-weight: 600; font-size: 13px; }
/* 時間戳在群名正下方 */
.meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 2px; font-size: 12px; }
.snd { color: var(--text-1); font-weight: 500; }
.mtag {
  display: inline-flex; align-items: center; gap: 3px;
  font-size: 10px; background: var(--bg-3); color: var(--text-2);
  padding: 1px 7px; border-radius: 5px;
}
.time { color: var(--text-2); }
.text { margin-top: 6px; font-size: 13px; white-space: pre-wrap; word-break: break-word; max-height: 80px; overflow: hidden; line-height: 1.5; }
.text.muted { color: var(--text-2); }
.acts { display: flex; gap: 6px; margin-top: 10px; }
.act {
  display: inline-flex; align-items: center; gap: 5px;
  height: 28px; padding: 0 12px;
  border: 1px solid var(--border); background: var(--bg-2);
  color: var(--text-1); border-radius: 7px; cursor: pointer; font-size: 12px;
}
.act:hover { border-color: var(--accent); color: var(--accent); }
.act.primary { background: linear-gradient(135deg, var(--accent), var(--accent-2)); border-color: transparent; color: #fff; }

/* 動畫 */
.fade-slide-enter-active, .fade-slide-leave-active { transition: opacity 0.2s ease, transform 0.2s ease; }
.fade-slide-enter-from, .fade-slide-leave-to { opacity: 0; transform: translateY(-8px); }
.hero:not(.compact) .fade-slide-enter-from,
.hero:not(.compact) .fade-slide-leave-to { transform: translateX(50%) translateY(-8px); }
</style>
