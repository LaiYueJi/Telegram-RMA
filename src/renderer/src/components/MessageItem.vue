<script setup>
import { computed } from 'vue'
import { useAccountStore } from '../stores/account.js'
import { File, Music, Mic, Sticker, Download, Copy, Forward, FolderOpen } from 'lucide-vue-next'
import MediaThumb from './MediaThumb.vue'
import DownloadButton from './DownloadButton.vue'
import Avatar from './Avatar.vue'

const account = useAccountStore()

const props = defineProps({
  msg: Object,
  dialogId: String,
  dialogType: String,
  dialogTitle: { type: String, default: '' },
  download: Object // { status, downloaded, total, path, error }
})
const emit = defineEmits(['download', 'pause', 'resume', 'cancel', 'copy', 'forward', 'reveal', 'view', 'tagClick'])

const isMedia = computed(() => !!props.msg.media)
const isImageLike = computed(() => ['photo', 'video', 'gif'].includes(props.msg.media?.kind))
const isFileLike = computed(() => ['document', 'audio', 'voice'].includes(props.msg.media?.kind))
const isAudioLike = computed(() => ['audio', 'voice'].includes(props.msg.media?.kind))

// 每則訊息都顯示發送者(私聊也算):自己→真實用戶名、否則發送者名、再退回對話標題
const senderLabel = computed(() => {
  if (props.msg.out) return account.displayName || '我'
  return props.msg.senderName || props.dialogTitle || ''
})

/**
 * 頭像要抓誰:自己發的用登入帳號本人,其他人用發送者 id;
 * 私聊/頻道貼文取不到 senderId 時退回對話本身(就是對方 / 該頻道)。
 */
const senderPeerId = computed(() =>
  props.msg.out
    ? String(account.user?.id || '')
    : props.msg.senderId || props.dialogId || ''
)

function fmtTime(unix) {
  const d = new Date(unix * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
/** 滑過時間看得到完整日期(氣泡上只放時分,跨日靠訊息流的日期分隔線)。 */
function fmtFullTime(unix) {
  const d = new Date(unix * 1000)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${fmtTime(unix)}`
}
function fmtSize(n) {
  if (!n) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB'
  return (n / 1024 ** 3).toFixed(2) + ' GB'
}
const fileIcon = { document: File, audio: Music, voice: Mic, sticker: Sticker }

const pct = computed(() => {
  const d = props.download
  if (!d || !d.total) return 0
  return Math.min(100, Math.round((d.downloaded / d.total) * 100))
})
const downloading = computed(() => ['downloading', 'paused'].includes(props.download?.status))

/** 把文字中的 #hashtag(含中文) 解析為可點擊片段。 */
function renderText(text) {
  if (!text) return []
  const parts = []
  // 支援英文+中文+數字+底線的 hashtag
  const re = /#([\w一-鿿㐀-䶿]+)/g
  let last = 0
  let m
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: 'text', value: text.slice(last, m.index) })
    // value 含 # 供顯示(舊版只存 m[1] → 畫面少了 #);tag 不含 # 供點擊搜尋(onTagClick 會自己補 #)
    parts.push({ type: 'tag', value: m[0], tag: m[1] })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) })
  return parts
}
function onTagClick(tag) {
  // 發送事件給父層 → 觸發搜尋
  emit('tagClick', tag)
}
</script>

<template>
  <!-- 系統訊息 -->
  <div v-if="msg.service" class="service">{{ msg.text }}</div>

  <!-- 一般訊息 -->
  <div v-else class="row" :class="{ out: msg.out }" :data-msg-id="msg.id">
    <!-- 圓形頭像(抓真實大頭照,沒有才退回名字縮寫) -->
    <span class="senderav" :title="senderLabel">
      <Avatar
        :peer-id="senderPeerId"
        :title="senderLabel"
        :url="msg.out ? account.avatarUrl || '' : ''"
        :has-photo="msg.out ? true : msg.senderHasPhoto !== false"
        :bg="msg.out ? 'var(--accent)' : ''"
        :size="34"
      />
    </span>

    <div class="bubble" :class="{ out: msg.out, media: isImageLike }">
      <!-- 發送者 + 時間 -->
      <div class="head">
        <span class="sender" :class="{ me: msg.out }">{{ senderLabel }}</span>
        <span class="time" :title="fmtFullTime(msg.date)">{{ fmtTime(msg.date) }}</span>
      </div>

      <!-- 圖片 / 影片 / GIF(點縮圖 → 開啟燈箱播放/瀏覽) -->
      <div v-if="isImageLike" class="media-wrap" title="點擊開啟" @click="emit('view', msg)">
        <MediaThumb
          :dialog-id="dialogId"
          :msg-id="msg.id"
          :kind="msg.media.kind"
          :duration="msg.media.duration"
          :thumb="msg.thumb"
          :has-thumb="msg.hasThumb"
          :width="msg.media.width"
          :height="msg.media.height"
          :size="msg.media.size"
        />
        <DownloadButton
          class="ov"
          overlay
          :download="download"
          @download="emit('download', msg)"
          @pause="emit('pause', msg)"
          @resume="emit('resume', msg)"
          @cancel="emit('cancel', msg)"
          @reveal="emit('reveal', download?.path)"
        />
      </div>

      <!-- 檔案 / 音訊(音訊可點開直接播放) -->
      <div
        v-else-if="isFileLike"
        class="filecard"
        :class="{ playable: isAudioLike }"
        @click="isAudioLike && emit('view', msg)"
      >
        <div class="fic"><component :is="fileIcon[msg.media.kind] || File" :size="26" /></div>
        <div class="finfo">
          <div class="fname">{{ msg.media.fileName || msg.media.kind }}</div>
          <div class="fmeta">{{ msg.media.kind }} · {{ fmtSize(msg.media.size) }}</div>
        </div>
        <DownloadButton
          :download="download"
          @download="emit('download', msg)"
          @pause="emit('pause', msg)"
          @resume="emit('resume', msg)"
          @cancel="emit('cancel', msg)"
          @reveal="emit('reveal', download?.path)"
        />
      </div>

      <!-- 文字(含 #hashtag 可點擊) -->
      <div v-if="msg.text" class="text">
        <template v-for="(part, i) in renderText(msg.text)" :key="i">
          <span v-if="part.type === 'text'">{{ part.value }}</span>
          <span v-else class="hashtag" @click.stop="onTagClick(part.tag)">{{ part.value }}</span>
        </template>
      </div>

      <!-- 下載進度條(漸層 + 流動光紋) -->
      <div v-if="downloading" class="dlprog" :class="{ paused: download?.status === 'paused' }">
        <div class="dlprog-track">
          <div class="dlprog-fill" :style="{ width: pct + '%' }"><span class="shine" /></div>
        </div>
        <span class="dlprog-pct">{{ download?.status === 'paused' ? '已暫停' : pct + '%' }}</span>
      </div>
      <button v-if="download?.status === 'done'" class="donebtn" @click="emit('reveal', download.path)">
        <FolderOpen :size="13" /><span>已儲存 · 開啟資料夾</span>
      </button>
      <div v-if="download?.status === 'error'" class="err">⚠️ 下載失敗:{{ download.error }}</div>
    </div>

    <!-- hover 動作 -->
    <div class="actions">
      <button v-if="isMedia && !download" title="下載" @click="emit('download', msg)"><Download :size="14" /></button>
      <button v-if="msg.text" title="複製文字" @click="emit('copy', msg)"><Copy :size="14" /></button>
      <button title="轉發" @click="emit('forward', msg)"><Forward :size="14" /></button>
    </div>
  </div>
</template>

<style scoped>
.service {
  text-align: center;
  color: var(--text-2);
  font-size: 12px;
  margin: 10px 0;
}
.row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  margin: 6px 0;
}
.row.out {
  flex-direction: row-reverse;
}
.senderav {
  flex: none;
  display: block;
  line-height: 0;
}
.bubble {
  max-width: 70%;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 7px 10px 8px;
  position: relative;
}
.bubble.out {
  background: var(--bubble-out);
  border-color: var(--bubble-out-border);
}
.bubble.media {
  padding: 6px;
}
.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}
.sender {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sender.me {
  color: var(--accent-2);
}
.head .time {
  font-size: 10.5px;
  color: var(--text-2);
  margin-left: auto;
  flex: none;
}
.media-wrap {
  position: relative;
  cursor: zoom-in;
  width: fit-content;
  max-width: 100%;
}
.ov {
  position: absolute;
  right: 8px;
  top: 8px;
}
.filecard {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 240px;
}
.filecard.playable {
  cursor: pointer;
}
.filecard.playable:hover .fname {
  color: var(--accent);
}
.fic {
  font-size: 26px;
}
.finfo {
  flex: 1;
  min-width: 0;
}
.fname {
  font-size: 13px;
  word-break: break-all;
}
.fmeta {
  font-size: 11px;
  color: var(--text-2);
}
.text {
  margin-top: 5px;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.45;
}
.hashtag {
  color: var(--accent);
  cursor: pointer;
  font-weight: 500;
}
.hashtag:hover {
  text-decoration: underline;
  color: var(--accent-2);
}
/* 下載進度條:漸層填充 + 內部流動光紋 + 百分比 */
.dlprog {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 7px;
}
.dlprog-track {
  flex: 1;
  height: 7px;
  background: var(--bg-3);
  border-radius: 99px;
  overflow: hidden;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.3);
}
.dlprog-fill {
  position: relative;
  height: 100%;
  border-radius: 99px;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  transition: width 0.25s ease;
  overflow: hidden;
  box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 55%, transparent);
}
/* 斜向流動高光 */
.dlprog-fill .shine {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    100deg,
    transparent 20%,
    rgba(255, 255, 255, 0.45) 50%,
    transparent 80%
  );
  background-size: 200% 100%;
  animation: dlshine 1.15s linear infinite;
}
@keyframes dlshine {
  0% { background-position: 200% 0; }
  100% { background-position: -80% 0; }
}
.dlprog-pct {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  min-width: 34px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.dlprog.paused .dlprog-fill {
  background: var(--text-2);
  box-shadow: none;
}
.dlprog.paused .dlprog-fill .shine {
  animation: none;
}
.dlprog.paused .dlprog-pct {
  color: var(--text-2);
}
@media (prefers-reduced-motion: reduce) {
  .dlprog-fill .shine { animation: none; }
}
/* 已儲存:小圓角按鈕 + 資料夾圖示 */
.donebtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 6px;
  padding: 3px 10px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--green);
  background: color-mix(in srgb, var(--green) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--green) 38%, transparent);
  border-radius: 99px;
  cursor: pointer;
  transition: background 0.12s, transform 0.1s;
}
.donebtn:hover {
  background: color-mix(in srgb, var(--green) 22%, transparent);
  transform: translateY(-1px);
}
.err {
  font-size: 11px;
  color: var(--red);
  margin-top: 4px;
}
.actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}
.row:hover .actions {
  opacity: 1;
}
.actions button {
  width: 32px;
  height: 32px;
  border: none;
  background: var(--bg-2);
  border: 1px solid var(--border);
  color: var(--text-1);
  border-radius: 50%;
  cursor: pointer;
  font-size: 14px;
  display: grid;
  place-items: center;
  transition: background 0.12s, transform 0.1s;
}
.actions button:hover {
  background: var(--accent);
  color: #fff;
  transform: scale(1.08);
}
</style>
