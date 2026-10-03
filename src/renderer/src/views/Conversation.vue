<script setup>
import { ref, reactive, watch, nextTick, onMounted, onUnmounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { Download, List, Forward, FileDown, Menu, RotateCcw, ChevronUp, ChevronDown, ChevronRight, ChevronLeft, MessageCircle, Pin, Images } from 'lucide-vue-next'
import { useConversationStore } from '../stores/conversation.js'
import { useSharedMediaStore } from '../stores/sharedMedia.js'
import { useDialogsStore } from '../stores/dialogs.js'
import { useSettingsStore } from '../stores/settings.js'
import { useAccountStore } from '../stores/account.js'
import { useNotificationsStore } from '../stores/notifications.js'
import { notify } from '../notify.js'
import DialogList from '../components/DialogList.vue'
import MessageItem from '../components/MessageItem.vue'
import MediaViewer from '../components/MediaViewer.vue'
import DownloadFilterDialog from '../components/DownloadFilterDialog.vue'
import ExportDialog from '../components/ExportDialog.vue'
import ForwardDialog from '../components/ForwardDialog.vue'
import SharedMediaPanel from '../components/SharedMediaPanel.vue'

const router = useRouter()
const showFilter = ref(false)
const showExport = ref(false)
const showForward = ref(false)
const forwardIds = ref(null) // null=批量,[id]=單則

const conversation = useConversationStore()
const shared = useSharedMediaStore()
const dialogs = useDialogsStore()
const settings = useSettingsStore()
const account = useAccountStore()
const notifications = useNotificationsStore()

const scroller = ref(null)
const streamInner = ref(null)
const stickBottom = ref(true) // 是否黏在底部(內容高度變化時自動維持在最新)
// 是否釘在頂端。跳到對話開頭之後,縮圖陸續載入會把內容一路撐高,不釘住的話
// 會被推離頂端(以前要按第二次「最舊」才停得住)。使用者一動滾輪/鍵盤就放開。
const stickTop = ref(false)
function releaseStickTop() {
  stickTop.value = false
}
const searchInput = ref(null)
const toolbarOpen = ref(true)
const downloads = reactive({}) // msgId → { status, downloaded, total, path, error }
const lastViewedTop = ref(null) // 跳轉前位置(供「上次瀏覽」)
const showDialogInfo = ref(false)
const jumpHit = ref(0) // 剛跳過去的訊息 id(閃一下高亮)
const showShared = ref(false) // 右側共享媒體側欄
const sharedInitialKind = ref('')

/**
 * 「載入完成 → 自動捲到底」的臨時開關。
 * 跳轉(任務台跳訊息 / 置頂訊息 / 跳到最舊)本來就是要停在指定位置,
 * 但那些動作也會經過 loading true→false,不擋住的話會被捲回最新,跳了等於白跳。
 */
let autoBottomOff = false
function holdAutoBottom(ms = 400) {
  autoBottomOff = true
  setTimeout(() => {
    autoBottomOff = false
  }, ms)
}

// 任務台/檢索按「跳到訊息」→ store 設好 jumpToId,這裡負責捲過去並高亮
watch(
  () => conversation.jumpSeq,
  async () => {
    const id = conversation.jumpToId
    if (!id) return
    releaseStickTop()
    autoBottomOff = true
    await nextTick()
    const el = document.getElementById('msg-' + id)
    if (!el) {
      notify.warning({ title: '找不到那則訊息', content: '可能已被刪除' })
      return
    }
    lastViewedTop.value = scroller.value?.scrollTop ?? null
    stickBottom.value = false
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    holdAutoBottom()
    jumpHit.value = id
    setTimeout(() => {
      if (jumpHit.value === id) jumpHit.value = 0
    }, 2200)
  }
)

const saveRoot = computed(() => settings.paths.saveRoot)

/** unix → 本地日期鍵(比對是不是同一天用)。 */
function dayKeyOf(unix) {
  const d = new Date(unix * 1000)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}
/** 日期分隔線上的字:今天 / 昨天 / 2025年11月25日。 */
function dayLabelOf(unix) {
  const d = new Date(unix * 1000)
  const now = new Date()
  const yst = new Date(now)
  yst.setDate(now.getDate() - 1)
  const k = dayKeyOf(unix)
  if (k === dayKeyOf(now.getTime() / 1000)) return '今天'
  if (k === dayKeyOf(yst.getTime() / 1000)) return '昨天'
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}
/**
 * 要在哪幾則訊息「之前」插日期分隔線:msgId → 那一天的標籤。
 * 訊息氣泡本身只顯示時分,沒有這條線就完全看不出跨日(尤其跳到很久以前的時候)。
 */
const dayDividers = computed(() => {
  const map = {}
  let prev = ''
  for (const m of conversation.messages) {
    if (!m.date) continue
    const k = dayKeyOf(m.date)
    if (k !== prev) {
      map[m.id] = dayLabelOf(m.date)
      prev = k
    }
  }
  return map
})

const MEDIA_WORD = {
  photo: '圖片', video: '影片', gif: 'GIF', document: '檔案',
  audio: '音訊', voice: '語音訊息', sticker: '貼圖'
}
/** 置頂橫幅顯示的那一行摘要(多行內容由 CSS nowrap 併成一行)。 */
const pinnedPreview = computed(() => {
  const m = conversation.currentPinned
  if (!m) return ''
  const t = (m.text || '').trim()
  if (t) return t
  return m.media ? `[${MEDIA_WORD[m.media.kind] || m.media.kind}]` : '(無內容)'
})

// 可在燈箱開啟的媒體(圖片/影片/GIF/音訊)
const VIEWABLE = ['photo', 'video', 'gif', 'audio', 'voice']
const mediaItems = computed(() =>
  conversation.messages
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
const showViewer = ref(false)
const viewerIndex = ref(0)
// 燈箱資料來源:訊息流,或共享媒體側欄那份清單
const viewerSource = ref('stream')
const sharedViewerItems = ref([])
const viewerItems = computed(() =>
  viewerSource.value === 'shared' ? sharedViewerItems.value : mediaItems.value
)

let offProg = null
let ro = null
onMounted(() => {
  if (!settings.loaded) settings.load()
  // 內容高度變化(圖片載入、補上「已儲存」列、進度條等)時,若仍黏底就維持在最新訊息
  ro = new ResizeObserver(() => {
    const el = scroller.value
    if (!el) return
    if (stickTop.value) {
      el.scrollTop = 0 // 釘在對話開頭
      return
    }
    if (stickBottom.value) el.scrollTop = el.scrollHeight
  })
  if (streamInner.value) ro.observe(streamInner.value)
  offProg = window.api.on('download:progress', (p) => {
    if (p.dialogId !== conversation.current?.id) return
    if (p.status === 'canceled') {
      delete downloads[p.msgId]
      return
    }
    const prev = downloads[p.msgId]
    downloads[p.msgId] = {
      status: p.status,
      downloaded: p.downloaded,
      total: p.total,
      path: p.path,
      error: p.error
    }
    if (p.status === 'done' && prev?.status !== 'done') {
      const name = p.path ? p.path.split(/[\\/]/).pop() : ''
      notify.success({ title: p.skipped ? '已存在,略過' : '下載完成', content: name })
    } else if (p.status === 'error' && prev?.status !== 'error') {
      notify.error({ title: '下載失敗', content: p.error })
    }
  })
  window.addEventListener('keydown', onKeyDown)
})
onUnmounted(() => {
  offProg?.()
  ro?.disconnect()
  window.removeEventListener('keydown', onKeyDown)
})

// 初次載入完成 → 捲到底 + 標記已下載
watch(
  () => conversation.loading,
  (loading, prev) => {
    if (prev && !loading && conversation.current) {
      // 雙重 nextTick 確保 DOM 完全渲染後再捲動
      nextTick(() => {
        nextTick(() => {
          if (!autoBottomOff) scrollToBottom(false)
          markDownloaded()
        })
      })
    }
  }
)
// 訊息陣列更新時也捲到底(初次載入)
watch(
  () => conversation.messages.length,
  (len, prev) => {
    if (prev === 0 && len > 0 && !conversation.loading && !autoBottomOff) {
      nextTick(() => {
        nextTick(() => {
          scrollToBottom(false)
        })
      })
    }
  }
)
// 切換對話時清掉下載狀態與燈箱
watch(
  () => conversation.current?.id,
  (id) => {
    for (const k of Object.keys(downloads)) delete downloads[k]
    // 從全域通知中心把此對話正在進行/已暫停的下載狀態帶回來:
    // 否則切走再切回來,進度會遺失、按鈕變回「下載」,一按就從頭重下、蓋掉既有進度。
    if (id != null) {
      for (const it of notifications.list) {
        if (String(it.dialogId) !== String(id)) continue
        if (it.status === 'done' && !it.path) continue
        downloads[it.msgId] = {
          status: it.status,
          downloaded: it.downloaded,
          total: it.total,
          path: it.path,
          error: it.error
        }
      }
    }
    showViewer.value = false
    lastViewedTop.value = null
    stickTop.value = false
    stickBottom.value = true // 進入新對話預設黏底,確保停在最新訊息
  }
)
// streamInner 位於 v-if 內,進出對話會重建;每次重新掛上 ResizeObserver
watch(streamInner, (el, old) => {
  if (old && ro) ro.unobserve(old)
  if (el && ro) ro.observe(el)
})
// 連線(重新)建立後補做一次磁碟實檢:修正「開機時未開代理 → 已下載檔沒顯示打勾」的時序問題
watch(
  () => account.connected,
  (connected) => {
    if (connected && conversation.current && conversation.messages.length) {
      nextTick(() => markDownloaded())
    }
  }
)

/** 問後端哪些訊息已完整下載(檔案存在且大小相符)→ 標記為 done。 */
async function markDownloaded() {
  if (!conversation.current) return
  const ids = conversation.messages.filter((m) => m.media).map((m) => m.id)
  if (!ids.length) return
  const r = await window.api.download.check(conversation.current.id, ids)
  if (!r?.ok) return
  for (const [id, info] of Object.entries(r.map)) {
    if (downloads[id]?.status === 'downloading' || downloads[id]?.status === 'paused') continue
    downloads[id] = { status: 'done', path: info.path }
  }
}

function scrollToBottom(smooth = true) {
  stickBottom.value = true
  const el = scroller.value
  // 初次進入用 'instant' 直接定位到底(避免被平滑動畫卡在中途);手動按鈕才平滑
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' })
}
async function jumpNewest() {
  rememberPos()
  releaseStickTop()
  // 停在歷史中間時,底部那截根本還沒載 —— 捲到底只會停在半路,得重抓最新一頁
  if (conversation.hasNewer || conversation.atOldest) {
    await conversation.goNewest()
    await nextTick()
    await nextTick()
    markDownloaded()
  }
  scrollToBottom(true)
}
/**
 * 真的回到「對話最初的訊息」。
 * 以前只是把捲軸拉到 scrollTop=0 —— 那只是目前載進來的最上面,一則四萬條的群組
 * 得按上百次才會到頭。現在沒到最初的話,先跟伺服器要最初那一頁再捲到頂。
 */
async function jumpOldest() {
  rememberPos()
  stickBottom.value = false
  if (!conversation.atOldest) {
    autoBottomOff = true
    const r = await conversation.jumpToOldest()
    if (!r?.ok) {
      autoBottomOff = false
      return notify.error({ title: '跳到最舊失敗', content: conversation.error || '' })
    }
    await nextTick()
    await nextTick()
    markDownloaded()
    holdAutoBottom(600)
  }
  await nextTick()
  // 換掉整批訊息後瀏覽器會把 scrollTop 夾到新內容的底部,而縮圖是之後才陸續載入、
  // 一路把內容撐高 —— 平滑動畫追不上,所以改成直接歸零 + 釘住,等使用者自己滾才放開。
  stickTop.value = true
  if (scroller.value) scroller.value.scrollTop = 0
  setTimeout(releaseStickTop, 2500) // 保險:縮圖載完就別再管了
}

/** 跳到某一則訊息(置頂橫幅 / 共享媒體點檔案都走這裡)。 */
async function doJump(msgId) {
  if (!conversation.current || !msgId) return
  releaseStickTop()
  autoBottomOff = true
  const r = await conversation.jumpTo(conversation.current, msgId)
  holdAutoBottom(800)
  if (!r?.ok) notify.warning({ title: '跳轉失敗', content: conversation.error || '' })
}

/** 置頂橫幅:點一下跳到目前這則,然後換顯示下一則(跟官方一樣)。 */
function onPinnedClick() {
  const m = conversation.nextPinned()
  if (m) doJump(m.id)
}

/** 開共享媒體側欄;帶 kind 就直接進那一個分頁。 */
function openShared(kind = '') {
  sharedInitialKind.value = kind
  if (showShared.value) {
    if (kind) shared.openKind(kind)
    else shared.back()
    return
  }
  showShared.value = true
}
function toggleShared() {
  if (showShared.value) showShared.value = false
  else openShared('')
}

/** 共享媒體點縮圖 → 用「那一份清單」開燈箱(而不是訊息流那份)。 */
function onSharedView({ items, index }) {
  sharedViewerItems.value = items
  viewerSource.value = 'shared'
  viewerIndex.value = index
  showViewer.value = true
}

/** 共同的群組 → 直接切過去那個對話。 */
function onOpenCommon(chat) {
  showShared.value = false
  conversation.open({
    id: chat.id,
    title: chat.title,
    type: chat.type,
    username: chat.username
  })
}
function rememberPos() {
  const el = scroller.value
  if (el) lastViewedTop.value = el.scrollTop
}
function gotoLastViewed() {
  releaseStickTop()
  stickBottom.value = false
  const el = scroller.value
  if (el && lastViewedTop.value != null) el.scrollTo({ top: lastViewedTop.value, behavior: 'smooth' })
}

async function onScroll() {
  const el = scroller.value
  if (!el) return
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  // 使用者捲到接近底部 → 維持黏底;捲離底部 → 解除黏底,避免新內容把畫面拉回底部。
  // 但畫面停在歷史中間時(hasNewer)底部並不是「最新」,這時黏底只會擋住往下讀。
  stickBottom.value = nearBottom && !conversation.hasNewer
  if (el.scrollTop < 140 && conversation.hasMore && !conversation.loadingOlder) {
    // 往上補舊訊息後要把畫面停在原本看的位置。
    // ⚠ 舊寫法是 scrollTop = scrollHeight - before,那等於假設「補之前一定在 scrollTop 0」:
    //   實際上在 0~139 之間都會進來,補完就被往上拉一段;補進來的量少(或縮圖還沒撐開)時
    //   算出來的位置又落回 140 以內 → 立刻再觸發一次 → 卡在最上面彈來彈去,得一直滾才衝得出去。
    //   正確做法是「原本位置 + 這次長高的量」,而且沒長高就不要動。
    const before = el.scrollHeight
    const beforeTop = el.scrollTop
    await conversation.loadOlder()
    await nextTick()
    const grew = el.scrollHeight - before
    if (grew > 0) el.scrollTop = beforeTop + grew
    markDownloaded()
  }
  // 跳轉 / 跳到最舊之後,往下捲要能接著把更新的讀回來
  if (nearBottom && conversation.hasNewer && !conversation.loadingNewer) {
    await conversation.loadNewer()
    markDownloaded()
  }
}

const dlId = () => conversation.current.id
async function onDownload(msg) {
  if (!msg.media) return notify.warning({ title: '無法下載', content: '此訊息沒有可下載的媒體' })
  const cur = downloads[msg.id]
  if (cur?.status === 'downloading') return // 防重複觸發
  if (cur?.status === 'paused') return window.api.download.resume(dlId(), msg.id)
  downloads[msg.id] = { status: 'downloading', downloaded: 0, total: msg.media.size || 0 }
  const r = await window.api.download.single(dlId(), msg.id)
  // 真正開始下載 → 跳「下載任務已啟動」提示(單檔下載)
  if (r?.started) notify.info({ title: '下載任務已啟動', content: msg.media.fileName || '', duration: 1800 })
  // 其餘狀態由 download:progress 事件驅動;僅即時錯誤在此處理
  if (r && r.ok === false && r.error) {
    downloads[msg.id] = { status: 'error', error: r.error }
    notify.error({ title: '下載失敗', content: r.error })
  }
}
function onPause(msg) {
  window.api.download.pause(dlId(), msg.id)
}
async function onResume(msg) {
  const r = await window.api.download.resume(dlId(), msg.id)
  if (r && r.ok === false && r.error) notify.error({ title: '無法續傳', content: r.error })
}
function onCancel(msg) {
  window.api.download.cancel(dlId(), msg.id)
  delete downloads[msg.id]
}

function onCopy(msg) {
  navigator.clipboard.writeText(msg.text || '')
  notify.success({ title: '已複製文字', duration: 1800 })
}
function onReveal(path) {
  if (path) window.api.download.reveal(path)
}
function onView(msg) {
  const i = mediaItems.value.findIndex((it) => it.id === msg.id)
  if (i < 0) return
  viewerSource.value = 'stream'
  viewerIndex.value = i
  showViewer.value = true
}
function onForward(msg) {
  forwardIds.value = [msg.id]
  showForward.value = true
}

async function pickSaveDir() {
  const r = await settings.pickFolder(saveRoot.value)
  if (r.canceled) return
  await settings.savePaths({ saveRoot: r.path })
  notify.success({ title: '已更新保存目錄', content: r.path, duration: 2200 })
}

// 右側浮動工具列(批量功能於後續里程碑)
const tools = [
  { key: 'batch-dl', icon: Download, label: '批量下載', ms: 'M3', color: '#7c5cff' },
  { key: 'dl-detail', icon: List, label: '下載詳情', ms: 'M3', color: '#5b6cff' },
  { key: 'batch-fw', icon: Forward, label: '批量轉發', ms: 'M5', color: '#f5793b' },
  { key: 'export', icon: FileDown, label: '文本導出', ms: 'M4', color: '#2bbf7a' },
  { key: 'fw-detail', icon: Menu, label: '轉發詳情', ms: 'M5', color: '#22b8cf' }
]
function onTool(t) {
  if (t.key === 'batch-dl') {
    if (!conversation.current) return notify.warning({ title: '請先選擇一個對話' })
    return (showFilter.value = true)
  }
  if (t.key === 'dl-detail' || t.key === 'fw-detail') return router.push({ name: 'tasks' })
  if (t.key === 'export') {
    if (!conversation.current) return notify.warning({ title: '請先選擇一個對話' })
    return (showExport.value = true)
  }
  if (t.key === 'batch-fw') {
    if (!conversation.current) return notify.warning({ title: '請先選擇一個對話' })
    forwardIds.value = null
    return (showForward.value = true)
  }
  notify.info({ title: t.label, content: `將於 ${t.ms} 推出`, duration: 2200 })
}

/* #17: hashtag 點擊→跳到搜尋頁 */
function onTagClick(tag) {
  router.push({ name: 'search', query: { q: '#' + tag, scope: 'current' } })
}

/* #13: 複製對話資訊 */
async function copyUsername() {
  if (conversation.current?.username) {
    await navigator.clipboard.writeText('@' + conversation.current.username)
    notify.success({ title: '已複製用戶名', duration: 1500 })
  }
}
async function copyLink() {
  if (conversation.current?.username) {
    await navigator.clipboard.writeText('https://t.me/' + conversation.current.username)
    notify.success({ title: '已複製連結', duration: 1500 })
  }
}

/* #18: 鍵盤快捷鍵 */
function onKeyDown(e) {
  // Ctrl+F: 跳到「消息檢索」頁;有開啟對話則自動篩選為當前對話
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault()
    router.push({
      name: 'search',
      query: conversation.current ? { scope: 'current' } : {}
    })
    return
  }
  // Esc: 先關閉目前對話;若無開啟對話且正在封存子列表,則退回主列表
  if (e.key === 'Escape') {
    if (conversation.current) {
      conversation.current = null
      conversation.messages = []
    } else if (dialogs.activeFolder === 'archived') {
      dialogs.setFolder('all')
    }
  }
}
</script>

<template>
  <div class="conv">
    <DialogList />

    <!-- 訊息區 -->
    <div class="pane">
      <template v-if="conversation.current">
        <!-- 頂部列 -->
        <div class="pane-head">
          <div class="title" @click="showDialogInfo = !showDialogInfo" title="點擊查看/隱藏詳細資訊">
            <span class="t">{{ conversation.current.title }}</span>
            <span class="ty">{{ conversation.current.type === 'channel' ? '頻道' : conversation.current.type === 'group' ? '群組' : '私聊' }}</span>
            <span v-if="conversation.current.username" class="ty uname">@{{ conversation.current.username }}</span>
            <span class="infocaret">{{ showDialogInfo ? '▴' : '▾' }}</span>
          </div>
          <div class="grow" />
          <button class="headbtn" :class="{ on: showShared }" title="共享媒體(照片 / 影片 / 檔案 / 連結…)" @click="toggleShared">
            <Images :size="16" />
          </button>
          <div class="savebox" :title="saveRoot">
            <span class="lbl">保存到</span>
            <span class="path">{{ saveRoot }}</span>
            <n-button size="tiny" @click="pickSaveDir">選擇</n-button>
          </div>
        </div>
        <!-- 對話詳細資訊(簡介/連結) -->
        <div v-if="showDialogInfo" class="pane-info">
          <div class="inforow" v-if="conversation.current.username">
            <span class="ikl">用戶名</span>
            <span class="ikv">@{{ conversation.current.username }}</span>
            <n-button size="tiny" text @click="copyUsername">複製</n-button>
          </div>
          <div class="inforow" v-if="conversation.current.username">
            <span class="ikl">連結</span>
            <span class="ikv link">https://t.me/{{ conversation.current.username }}</span>
            <n-button size="tiny" text @click="copyLink">複製</n-button>
          </div>
          <div class="inforow" v-if="conversation.current.phone">
            <span class="ikl">電話</span>
            <span class="ikv">{{ conversation.current.phone }}</span>
          </div>
          <div class="inforow" v-if="conversation.current.bio">
            <span class="ikl">簡介</span>
            <span class="ikv bio">{{ conversation.current.bio }}</span>
          </div>
          <div class="inforow muted" v-if="!conversation.current.username && !conversation.current.phone && !conversation.current.bio">
            暫無更多資訊
          </div>
        </div>

        <!-- 置頂訊息橫幅:點一下跳到那則,再點換下一則 -->
        <div v-if="conversation.pinned.length" class="pinbar" @click="onPinnedClick">
          <span class="pb-bar" />
          <Pin :size="14" class="pb-pin" />
          <div class="pb-text">
            <div class="pb-label">
              置頂訊息
              <span v-if="conversation.pinned.length > 1" class="pb-count">
                {{ conversation.pinnedIdx + 1 }} / {{ conversation.pinned.length }}
              </span>
            </div>
            <div class="pb-msg">{{ pinnedPreview }}</div>
          </div>
          <button class="pb-btn" title="查看所有置頂訊息" @click.stop="openShared('pinned')">
            <List :size="15" />
          </button>
        </div>

        <!-- 訊息流 -->
        <div
          ref="scroller"
          class="stream"
          @scroll="onScroll"
          @wheel="releaseStickTop"
          @touchstart="releaseStickTop"
          @mousedown="releaseStickTop"
          @keydown="releaseStickTop"
        >
          <div ref="streamInner">
            <div v-if="conversation.loadingOlder" class="loadmore"><n-spin size="small" /> 載入較舊訊息…</div>
            <div v-if="conversation.atOldest" class="streamtip">— 這是對話的開頭 —</div>
            <div v-if="conversation.loading" class="center"><n-spin /> 載入訊息中…</div>
            <div v-else-if="conversation.error" class="center err">{{ conversation.error }}</div>
            <template v-else>
              <template v-for="m in conversation.messages" :key="m.id">
              <!-- 日期分隔線(跨日才插一條) -->
              <div v-if="dayDividers[m.id]" class="daysep"><span>{{ dayDividers[m.id] }}</span></div>
              <MessageItem
                :id="'msg-' + m.id"
                :class="{ 'jump-hit': jumpHit === m.id }"
                :msg="m"
                :dialog-id="conversation.current.id"
                :dialog-type="conversation.current.type"
                :dialog-title="conversation.current.title"
                :download="downloads[m.id]"
                @download="onDownload"
                @pause="onPause"
                @resume="onResume"
                @cancel="onCancel"
                @copy="onCopy"
                @forward="onForward"
                @reveal="onReveal"
                @view="onView"
                @tag-click="onTagClick"
              />
              </template>
              <div v-if="conversation.loadingNewer" class="loadmore"><n-spin size="small" /> 載入較新訊息…</div>
            </template>
          </div>
        </div>

        <!-- 右下角:上次瀏覽 / 最舊 / 最新 -->
        <div class="scrollbtns">
          <button v-if="lastViewedTop != null" class="rbtn last" title="回到上次瀏覽位置" @click="gotoLastViewed">
            <RotateCcw class="ri" :size="17" /><span class="rl">上次瀏覽</span>
          </button>
          <button class="rbtn" title="回到最舊" @click="jumpOldest">
            <ChevronUp class="ri" :size="17" /><span class="rl">最舊</span>
          </button>
          <button class="rbtn primary" title="回到最新" @click="jumpNewest">
            <ChevronDown class="ri" :size="17" /><span class="rl">最新</span>
          </button>
        </div>
      </template>

      <!-- 未選對話 -->
      <div v-else class="empty">
        <MessageCircle class="emoji" :size="48" />
        <p>選擇左側對話開始瀏覽</p>
      </div>

      <!-- 右側浮動工具列(收起鈕在第一個) -->
      <!-- 有置頂橫幅時整條往下讓,不然「收起」那顆會壓在置頂訊息上面 -->
      <div v-if="conversation.current" class="toolbar" :class="{ 'with-pin': conversation.pinned.length }">
        <button class="tbtn toggle" :title="toolbarOpen ? '收起' : '展開'" @click="toolbarOpen = !toolbarOpen">
          <span class="ti dim"><component :is="toolbarOpen ? ChevronRight : ChevronLeft" :size="17" /></span>
          <span class="tl">{{ toolbarOpen ? '收起' : '展開' }}</span>
        </button>
        <template v-if="toolbarOpen">
          <button v-for="t in tools" :key="t.key" class="tbtn" @click="onTool(t)">
            <span class="ti" :style="{ background: t.color }"><component :is="t.icon" :size="17" /></span>
            <span class="tl">{{ t.label }}</span>
          </button>
        </template>
      </div>
    </div>

    <!-- 右側共享媒體側欄 -->
    <SharedMediaPanel
      v-if="showShared && conversation.current"
      :dialog-id="conversation.current.id"
      :dialog-type="conversation.current.type"
      :dialog-title="conversation.current.title"
      :initial-kind="sharedInitialKind"
      :downloads="downloads"
      @close="showShared = false"
      @jump="doJump"
      @view="onSharedView"
      @download="onDownload"
      @pause="onPause"
      @resume="onResume"
      @cancel="onCancel"
      @reveal="onReveal"
      @open-dialog="onOpenCommon"
    />

    <!-- 媒體燈箱 -->
    <MediaViewer
      v-model:show="showViewer"
      :dialog-id="conversation.current?.id"
      :items="viewerItems"
      :start-index="viewerIndex"
      @download="onDownload"
    />

    <!-- 批量下載篩選 -->
    <DownloadFilterDialog
      v-model:show="showFilter"
      :dialog-id="conversation.current?.id"
      :dialog-title="conversation.current?.title"
    />

    <!-- 文本導出(掃描整個對話) -->
    <ExportDialog
      v-model:show="showExport"
      :dialog-id="conversation.current?.id"
      :dialog-title="conversation.current?.title"
    />

    <!-- 轉發(單則/批量) -->
    <ForwardDialog
      v-model:show="showForward"
      :dialog-id="conversation.current?.id"
      :dialog-title="conversation.current?.title"
      :message-ids="forwardIds"
    />
  </div>
</template>

<style scoped>
.conv {
  display: flex;
  height: 100%;
  min-height: 0;
}
.pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}
.pane-head {
  height: 52px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-1);
}
.title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.title .t {
  font-weight: 600;
  font-size: 15px;
}
.title .ty {
  font-size: 11px;
  color: var(--text-2);
  background: var(--bg-3);
  padding: 1px 6px;
  border-radius: 5px;
}
.title .ty.uname {
  color: var(--accent);
  cursor: pointer;
}
.infocaret {
  font-size: 10px;
  color: var(--text-2);
  padding: 0 2px;
}
.pane-info {
  background: var(--bg-2);
  border-bottom: 1px solid var(--border);
  padding: 8px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.inforow {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.inforow.muted {
  color: var(--text-2);
}
.ikl {
  color: var(--text-2);
  min-width: 40px;
}
.ikv {
  color: var(--text-0);
}
.ikv.link {
  color: var(--accent);
}
.ikv.bio {
  max-width: 400px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grow {
  flex: 1;
}
/* 頂部列的圖示按鈕(共享媒體) */
.headbtn {
  width: 32px;
  height: 32px;
  flex: none;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  background: var(--bg-2);
  color: var(--text-1);
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.headbtn:hover {
  background: var(--bg-3);
  color: var(--text-0);
}
.headbtn.on {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

/* 置頂訊息橫幅 */
.pinbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 12px 6px 10px;
  background: var(--bg-1);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  min-height: 44px;
}
.pinbar:hover {
  background: var(--bg-2);
}
.pb-bar {
  width: 3px;
  align-self: stretch;
  margin: 2px 0;
  border-radius: 99px;
  background: var(--accent);
  flex: none;
}
.pb-pin {
  color: var(--accent);
  flex: none;
}
.pb-text {
  flex: 1;
  min-width: 0;
}
.pb-label {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--accent);
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.pb-count {
  font-size: 10.5px;
  font-weight: 500;
  color: var(--text-2);
}
.pb-msg {
  font-size: 12.5px;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
}
.pb-btn {
  width: 30px;
  height: 30px;
  flex: none;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  color: var(--text-2);
  border-radius: 7px;
  cursor: pointer;
}
.pb-btn:hover {
  background: var(--bg-3);
  color: var(--text-0);
}

.savebox {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 420px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 8px;
}
.savebox .lbl {
  font-size: 11px;
  color: var(--text-2);
}
.savebox .path {
  font-size: 12px;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 280px;
}
.stream {
  flex: 1;
  overflow-y: auto;
  padding: 12px 86px 12px 16px;
  min-height: 0;
  /* 不設 scroll-behavior: smooth:否則 ResizeObserver 黏底時的 scrollTop 指派會變成平滑動畫,
     圖片陸續載入持續改變高度時動畫永遠追不上 → 卡在中間。手動按鈕已各自指定 smooth。 */
}
.loadmore,
.center {
  text-align: center;
  color: var(--text-2);
  padding: 16px;
}
.streamtip {
  text-align: center;
  color: var(--text-2);
  font-size: 11.5px;
  padding: 12px 0 4px;
  letter-spacing: 0.5px;
}
/* 日期分隔線:黏在捲動區頂端,跨日一目了然(官方也是這樣) */
.daysep {
  position: sticky;
  top: 0;
  z-index: 4;
  display: flex;
  justify-content: center;
  padding: 8px 0 6px;
  pointer-events: none;
}
.daysep span {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-1);
  background: color-mix(in srgb, var(--bg-2) 88%, transparent);
  border: 1px solid var(--border);
  border-radius: 99px;
  padding: 3px 12px;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}
.center {
  margin-top: 40px;
}
.center.err {
  color: var(--red);
}
.empty {
  flex: 1;
  display: grid;
  place-items: center;
  color: var(--text-2);
}
.empty .emoji {
  font-size: 48px;
  text-align: center;
}

/* 右下角滾動鈕 */
.scrollbtns {
  position: absolute;
  right: 16px;
  bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  z-index: 6;
}
.rbtn {
  width: 50px;
  height: 50px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--bg-2);
  color: var(--text-1);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow-card);
  transition: transform 0.12s, background 0.12s;
}
.rbtn:hover {
  transform: translateY(-2px);
}
.rbtn.primary {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  border-color: transparent;
  color: #fff;
}
.rbtn.last {
  background: linear-gradient(135deg, #f6a350, #f5793b);
  border-color: transparent;
  color: #fff;
}
.rbtn .ri {
  font-size: 17px;
  line-height: 1;
}
.rbtn .rl {
  font-size: 9px;
  line-height: 1.5;
}

/* 右側浮動工具列 */
.toolbar {
  position: absolute;
  right: 12px;
  top: 64px;
  transition: top 0.15s;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 5;
}
.toolbar.with-pin {
  top: 112px;
}
.tbtn {
  width: 56px;
  padding: 7px 4px;
  border: 1px solid var(--border);
  background: var(--bg-1);
  color: var(--text-1);
  border-radius: 12px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  box-shadow: var(--shadow-card);
  transition: border-color 0.12s, background 0.12s, transform 0.12s;
}
.tbtn:hover {
  transform: translateY(-1px);
}
.tbtn:hover {
  background: var(--bg-2);
  border-color: var(--accent);
  color: var(--text-0);
}
.tbtn .ti {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  font-size: 17px;
  color: #fff;
}
.tbtn .ti.dim {
  background: var(--bg-3);
  color: var(--text-1);
}
.tbtn .tl {
  font-size: 11px;
  white-space: nowrap;
}

/* 從任務台/檢索跳過來的那則訊息:閃兩下讓眼睛找得到 */
.jump-hit {
  animation: jump-flash 1.1s ease-out 2;
  border-radius: 12px;
}
@keyframes jump-flash {
  0%,
  100% {
    background: transparent;
    box-shadow: none;
  }
  35% {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent);
  }
}
</style>
