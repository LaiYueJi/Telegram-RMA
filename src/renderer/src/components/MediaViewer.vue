<script setup>
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { RotateCw, Maximize, Download, X } from 'lucide-vue-next'
import Plyr from 'plyr'
import 'plyr/dist/plyr.css'
// plyr 的 package exports 沒開放 dist/plyr.svg,所以把 sprite 複製進專案自己帶
import plyrSprite from '../assets/plyr.svg?raw'

// Plyr 預設會去 CDN 抓圖示,離線一定壞 → 把 sprite 直接內嵌進 DOM,iconUrl 留空走 #plyr-xxx
function ensureSprite() {
  if (document.getElementById('plyr-sprite')) return
  // 檔案開頭有 <?xml?> + <!DOCTYPE>,直接塞進 innerHTML 會被 HTML parser 當成怪東西 → 從 <svg 起頭切
  const i = plyrSprite.indexOf('<svg')
  const d = document.createElement('div')
  d.id = 'plyr-sprite'
  d.style.display = 'none'
  d.setAttribute('aria-hidden', 'true')
  d.innerHTML = i >= 0 ? plyrSprite.slice(i) : plyrSprite
  document.body.appendChild(d)
}

const PLYR_I18N = {
  restart: '重播', rewind: '倒退 {seektime} 秒', play: '播放', pause: '暫停',
  fastForward: '快轉 {seektime} 秒', seek: '跳轉', seekLabel: '{currentTime} / {duration}',
  played: '已播放', buffered: '已緩衝', currentTime: '目前時間', duration: '總長度',
  volume: '音量', mute: '靜音', unmute: '取消靜音', download: '下載',
  enterFullscreen: '全螢幕', exitFullscreen: '離開全螢幕', settings: '設定',
  pip: '子母畫面', menuBack: '返回上一層', speed: '播放速度', normal: '正常',
  quality: '畫質', loop: '循環播放', start: '開始', end: '結束', all: '全部',
  reset: '重設', disabled: '關閉', enabled: '開啟',
  enableCaptions: '開啟字幕', disableCaptions: '關閉字幕', captions: '字幕',
  frameTitle: '播放器:{title}'
}

const props = defineProps({
  show: Boolean,
  dialogId: String,
  items: { type: Array, default: () => [] }, // [{ id, kind, fileName, width, height, size }]
  startIndex: { type: Number, default: 0 }
})
const emit = defineEmits(['update:show', 'download'])

const idx = ref(0)
const loading = ref(true)
const errored = ref(false)
const unsupported = ref(false) // 格式本身瀏覽器放不出來(MKV…),重試沒用
const reloadKey = ref(0) // 重試:bump → 重新掛載 img/video 觸發再次請求(代理偶發失敗時用)
const root = ref(null)
const videoEl = ref(null)
const audioEl = ref(null)

function retry() {
  errored.value = false
  unsupported.value = false
  loading.value = true
  reloadKey.value++
}

// 縮放 / 旋轉 / 平移
const scale = ref(1)
const rotation = ref(0)
const tx = ref(0)
const ty = ref(0)
const isFs = ref(false)

watch(
  () => props.show,
  (v) => {
    if (v) {
      idx.value = props.startIndex
      reset()
    }
  }
)
watch(idx, () => {
  loading.value = true
  errored.value = false
  unsupported.value = false
  reset()
})

function reset() {
  scale.value = 1
  rotation.value = 0
  tx.value = 0
  ty.value = 0
}

const current = computed(() => props.items[idx.value] || null)
// 每個項目可自帶 dialogId(全域檢索結果跨多對話);沒帶就沿用統一的 props.dialogId(對話頁)
const src = computed(() =>
  current.value ? `tgmedia://media/${current.value.dialogId || props.dialogId}/${current.value.id}` : ''
)
const isVideo = computed(() => ['video', 'gif'].includes(current.value?.kind))
const isAudio = computed(() => ['audio', 'voice'].includes(current.value?.kind))
const isImage = computed(() => !isVideo.value && !isAudio.value)

const TYPE = { photo: '圖片', video: '影片', gif: 'GIF', audio: '音訊', voice: '語音', sticker: '貼圖' }
const FORMAT = {
  photo: 'JPG', video: 'MP4', gif: 'GIF', audio: '音訊', voice: '語音',
  'video/mp4': 'MP4', 'video/webm': 'WEBM', 'video/quicktime': 'MOV',
  'image/jpeg': 'JPG', 'image/png': 'PNG', 'image/webp': 'WEBP', 'image/gif': 'GIF',
  'audio/mpeg': 'MP3', 'audio/ogg': 'OGG', 'audio/mp4': 'M4A'
}
const typeLabel = computed(() => TYPE[current.value?.kind] || current.value?.kind || '')
const formatLabel = computed(() => {
  const m = current.value
  if (!m) return ''
  // 從副檔名推
  const ext = (m.fileName || '').split('.').pop()?.toUpperCase()
  if (ext && ext.length <= 5) return ext
  // fallback: kind mapping
  return FORMAT[m.kind] || m.kind?.toUpperCase() || ''
})
const dims = computed(() =>
  current.value?.width && current.value?.height ? `${current.value.width}×${current.value.height}` : ''
)
function fmtSize(n) {
  if (!n) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB'
  return (n / 1024 ** 3).toFixed(2) + ' GB'
}
const sizeLabel = computed(() => fmtSize(current.value?.size))

const transform = computed(
  () => `translate(${tx.value}px, ${ty.value}px) scale(${scale.value}) rotate(${rotation.value}deg)`
)

// ── Plyr 播放器 ──────────────────────────────────────────────
let player = null

function destroyPlayer() {
  try {
    player?.destroy()
  } catch {
    /* 元素已被 Vue 換掉就算了 */
  }
  player = null
}

async function mountPlayer() {
  destroyPlayer()
  if (!props.show || !src.value) return
  await nextTick()
  const el = isVideo.value ? videoEl.value : isAudio.value ? audioEl.value : null
  if (!el) return
  ensureSprite()
  player = new Plyr(el, {
    iconUrl: '', // 走上面內嵌的 sprite(#plyr-play …)
    loadSprite: false,
    blankVideo: '',
    i18n: PLYR_I18N,
    keyboard: { focused: false, global: false }, // 鍵盤統一由 onKey 處理,不然會跟 ←→ 切換打架
    tooltips: { controls: true, seek: true },
    speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2, 3] },
    seekTime: 5,
    autoplay: true,
    storage: { enabled: true, key: 'trma-plyr' },
    controls: isVideo.value
      ? ['play-large', 'restart', 'play', 'progress', 'current-time', 'duration',
         'mute', 'volume', 'settings', 'pip', 'fullscreen']
      : ['restart', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'settings'],
    settings: isVideo.value ? ['speed', 'loop'] : ['speed'],
    ratio:
      isVideo.value && current.value?.width && current.value?.height
        ? `${current.value.width}:${current.value.height}`
        : undefined
  })
}

watch([src, reloadKey, () => props.show], () => {
  if (props.show && (isVideo.value || isAudio.value)) mountPlayer()
  else destroyPlayer()
})

function close() {
  if (isFs.value) document.exitFullscreen?.().catch(() => {})
  emit('update:show', false)
}
function prev() {
  if (idx.value > 0) idx.value--
}
function next() {
  if (idx.value < props.items.length - 1) idx.value++
}
function onLoaded() {
  loading.value = false
}
// code 4 = MEDIA_ERR_SRC_NOT_SUPPORTED,多半是 MKV / AVI 這類 Chromium 不吃的容器
function onError(e) {
  loading.value = false
  errored.value = true
  unsupported.value = e?.target?.error?.code === 4 && (isVideo.value || isAudio.value)
}
function onDownload() {
  if (current.value) emit('download', current.value)
}

function zoomIn() {
  scale.value = Math.min(8, +(scale.value * 1.2).toFixed(3))
}
function zoomOut() {
  scale.value = Math.max(0.2, +(scale.value / 1.2).toFixed(3))
}
function rotateCW() {
  rotation.value = (rotation.value + 90) % 360
}
function onWheel(e) {
  if (isAudio.value) return
  e.preventDefault()
  if (e.deltaY < 0) zoomIn()
  else zoomOut()
}
async function toggleFs() {
  try {
    if (!document.fullscreenElement) {
      await root.value?.requestFullscreen()
      isFs.value = true
    } else {
      await document.exitFullscreen()
      isFs.value = false
    }
  } catch {
    /* ignore */
  }
}
function onFsChange() {
  isFs.value = !!document.fullscreenElement
}

// 拖曳平移(放大後)
let dragging = false
let sx = 0
let sy = 0
function onDown(e) {
  if (isAudio.value || scale.value <= 1) return
  dragging = true
  sx = e.clientX - tx.value
  sy = e.clientY - ty.value
}
function onMove(e) {
  if (!dragging) return
  tx.value = e.clientX - sx
  ty.value = e.clientY - sy
}
function onUp() {
  dragging = false
}

function onKey(e) {
  if (!props.show) return
  if (e.key === 'Escape') {
    if (isFs.value) return // 全螢幕時 Esc 先退出全螢幕(瀏覽器處理)
    close()
  } else if (e.key === 'ArrowLeft') prev()
  else if (e.key === 'ArrowRight') next()
  else if (player) {
    // 播放中的快捷鍵(Plyr 自己的鍵盤是關的,避免跟上面的 ←→ 搶)
    if (e.key === ' ') {
      e.preventDefault()
      player.togglePlay()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      player.currentTime += 10
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      player.currentTime -= 10
    } else if (e.key === 'f' || e.key === 'F') player.fullscreen.toggle()
    else if (e.key === 'm' || e.key === 'M') player.muted = !player.muted
  } else if (e.key === '+' || e.key === '=') zoomIn()
  else if (e.key === '-') zoomOut()
  else if (e.key === 'r' || e.key === 'R') rotateCW()
}
onMounted(() => {
  ensureSprite()
  window.addEventListener('keydown', onKey)
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  document.addEventListener('fullscreenchange', onFsChange)
})
onUnmounted(() => {
  destroyPlayer()
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', onUp)
  document.removeEventListener('fullscreenchange', onFsChange)
})
</script>

<template>
  <teleport to="body">
    <div v-if="show" ref="root" class="viewer" @click.self="close">
      <!-- 左右切換 -->
      <button v-if="idx > 0" class="nav left" @click.stop="prev">‹</button>
      <button v-if="idx < items.length - 1" class="nav right" @click.stop="next">›</button>

      <!-- 內容 -->
      <div class="stage" @click.self="close" @wheel="onWheel">
        <div v-if="loading && !errored" class="state"><n-spin /> 載入中…</div>
        <div v-if="errored && unsupported" class="state err bad">
          <div class="bad-ico">🎞</div>
          <span class="bad-t">播放器不支援這個格式{{ formatLabel ? `(${formatLabel})` : '' }}</span>
          <span class="bad-p">
            MKV、AVI、WMV 這類容器 Chromium 本來就放不出來,檔案本身沒問題。<br />
            下載後用本機播放器(例如 PotPlayer / VLC)開就好。
          </span>
          <button class="retry" @click.stop="onDownload">下載這個檔案</button>
        </div>
        <div v-else-if="errored" class="state err">
          <span>無法載入此媒體(代理可能較慢或已過期)</span>
          <button class="retry" @click.stop="retry">重試</button>
        </div>

        <div v-if="isVideo && src" class="player" @click.stop>
          <video
            ref="videoEl"
            :key="src + '#' + reloadKey"
            playsinline
            preload="metadata"
            :src="src"
            @loadeddata="onLoaded"
            @error="onError"
          />
        </div>
        <div v-else-if="isAudio && src" class="player audio" @click.stop>
          <audio
            ref="audioEl"
            :key="src + '#' + reloadKey"
            preload="metadata"
            :src="src"
            @loadeddata="onLoaded"
            @error="onError"
          />
        </div>
        <img
          v-else-if="isImage && src"
          :key="src + '#' + reloadKey"
          class="media"
          :class="{ grab: scale > 1 }"
          :style="{ transform }"
          :src="src"
          alt=""
          @load="onLoaded"
          @error="onError"
          @mousedown="onDown"
          @click.stop
          draggable="false"
        />
      </div>

      <!-- 底部資訊列 -->
      <div class="vbar" @click.stop>
        <span class="vname">{{ current?.fileName || typeLabel }}</span>
        <span class="vmeta">
          <span class="chip">{{ formatLabel }}</span>
          <span v-if="dims" class="chip">{{ dims }}</span>
          <span v-if="sizeLabel" class="chip">{{ sizeLabel }}</span>
        </span>
        <span class="vcount" v-if="items.length > 1">{{ idx + 1 }} / {{ items.length }}</span>
        <span class="grow" />
        <!-- 縮放/旋轉只對圖片有意義;影片的全螢幕、速度、子母畫面都在播放器上 -->
        <template v-if="isImage">
          <button class="vbtn" title="縮小 (-)" @click="zoomOut">−</button>
          <button class="vbtn zoom" title="重置縮放" @click="reset">{{ Math.round(scale * 100) }}%</button>
          <button class="vbtn" title="放大 (+)" @click="zoomIn">＋</button>
          <button class="vbtn" title="旋轉 (R)" @click="rotateCW"><RotateCw :size="16" /></button>
          <button class="vbtn" title="全螢幕" @click="toggleFs"><Maximize :size="16" /></button>
        </template>
        <button class="vbtn" title="下載" @click="onDownload"><Download :size="16" /></button>
        <button class="vbtn" title="關閉 (Esc)" @click="close"><X :size="16" /></button>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.viewer {
  position: fixed;
  inset: 0;
  z-index: 3000;
  background: rgba(3, 7, 16, 0.93);
  display: flex;
  flex-direction: column;
}
.vbar {
  height: 46px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  color: #fff;
  background: rgba(0, 0, 0, 0.4);
}
.vname {
  font-size: 13px;
  max-width: 26vw;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.vmeta {
  display: flex;
  gap: 6px;
}
.chip {
  font-size: 11px;
  color: #cdd7ea;
  background: rgba(255, 255, 255, 0.1);
  padding: 1px 7px;
  border-radius: 6px;
}
.vcount {
  font-size: 12px;
  color: #b9c4dc;
}
.grow {
  flex: 1;
}
.vbtn {
  height: 32px;
  min-width: 32px;
  padding: 0 8px;
  border: none;
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  border-radius: 8px;
  cursor: pointer;
  font-size: 15px;
}
.vbtn:hover {
  background: var(--accent);
}
.vbtn.zoom {
  font-size: 12px;
  min-width: 50px;
}
.stage {
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  padding: 18px;
  position: relative;
  overflow: hidden;
}
.media {
  max-width: 92vw;
  max-height: calc(100vh - 100px);
  object-fit: contain;
  border-radius: 8px;
  display: block;
  transition: transform 0.08s linear;
  user-select: none;
}
.media.grab {
  cursor: grab;
}
.media.grab:active {
  cursor: grabbing;
}
/* ── Plyr 播放器 ─────────────────────────────── */
.player {
  width: min(92vw, 1280px);
  max-height: calc(100vh - 100px);
  display: flex;
  align-items: center;
  justify-content: center;
}
.player.audio {
  width: min(560px, 84vw);
}
.player :deep(.plyr) {
  width: 100%;
  max-height: calc(100vh - 100px);
  border-radius: 10px;
  overflow: hidden;
}
.player :deep(.plyr video) {
  max-height: calc(100vh - 100px);
}
.player :deep(.plyr--audio .plyr__controls) {
  background: rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  color: #fff;
}
/* 配色跟著 app 主題走 */
.viewer :deep(.plyr) {
  --plyr-color-main: var(--accent);
  --plyr-video-background: #000;
  --plyr-audio-control-color: #dbe4f2;
  --plyr-audio-control-color-hover: #fff;
  --plyr-menu-background: rgba(22, 30, 45, 0.96);
  --plyr-menu-color: #e7edf6;
  --plyr-menu-arrow-color: #93a3bd;
  --plyr-menu-back-border-color: #2c3a52;
  --plyr-tooltip-background: rgba(22, 30, 45, 0.96);
  --plyr-tooltip-color: #e7edf6;
  --plyr-range-track-height: 5px;
  --plyr-range-thumb-height: 13px;
  --plyr-control-radius: 8px;
  --plyr-font-family: inherit;
  --plyr-font-size-small: 12px;
  --plyr-font-size-base: 13px;
}
.bad {
  max-width: 460px;
  text-align: center;
  gap: 6px;
}
.bad-ico {
  font-size: 42px;
}
.bad-t {
  color: #fff;
  font-size: 16px;
}
.bad-p {
  color: #9fb0c2;
  font-size: 12.5px;
  line-height: 1.9;
  margin-bottom: 8px;
}
.state {
  position: absolute;
  color: #cdd7ea;
  font-size: 14px;
  display: flex;
  gap: 8px;
  align-items: center;
}
.state.err {
  color: #ff8a8d;
  flex-direction: column;
}
.retry {
  border: 1px solid rgba(255, 255, 255, 0.25);
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  padding: 5px 16px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}
.retry:hover {
  background: var(--accent);
  border-color: var(--accent);
}
.nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 46px;
  height: 70px;
  border: none;
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
  font-size: 34px;
  cursor: pointer;
  z-index: 5;
  border-radius: 10px;
}
.nav:hover {
  background: rgba(255, 255, 255, 0.18);
}
.nav.left {
  left: 16px;
}
.nav.right {
  right: 16px;
}
</style>
