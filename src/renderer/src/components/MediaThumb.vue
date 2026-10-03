<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { Image, Play } from 'lucide-vue-next'

const props = defineProps({
  dialogId: String,
  msgId: Number,
  kind: String,
  duration: { type: Number, default: 0 },
  thumb: { type: String, default: null }, // stripped 模糊預覽
  hasThumb: Boolean,
  width: { type: Number, default: 0 },
  height: { type: Number, default: 0 },
  size: { type: Number, default: 0 },
  maxW: { type: Number, default: 280 }, // 顯示上限(總覽縮圖會傳較小值)
  maxH: { type: Number, default: 360 }
})

const src = ref(props.thumb)
const sharp = ref(false)
const el = ref(null)
let io = null
let fetched = false

async function fetchSharp() {
  if (fetched || !props.hasThumb) return
  fetched = true
  const r = await window.api.messages.thumb(props.dialogId, props.msgId)
  if (r.dataUrl) {
    src.value = r.dataUrl
    sharp.value = true
  }
}

onMounted(() => {
  io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        fetchSharp()
        io?.disconnect()
      }
    },
    { rootMargin: '200px' }
  )
  if (el.value) io.observe(el.value)
})
onUnmounted(() => io?.disconnect())

function fmtDur(s) {
  if (!s) return ''
  const m = Math.floor(s / 60)
  const ss = s % 60
  return `${m}:${String(ss).padStart(2, '0')}`
}
function fmtSize(n) {
  if (!n) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB'
  return (n / 1024 ** 3).toFixed(2) + ' GB'
}

// 依原始長寬算顯示尺寸(限制在 maxW×maxH 內,保持比例)
function boxStyle() {
  let w = props.width || 220
  let h = props.height || 165
  const r = Math.min(props.maxW / w, props.maxH / h, 1)
  return { width: Math.round(w * r) + 'px', height: Math.round(h * r) + 'px' }
}
</script>

<template>
  <div ref="el" class="thumb" :class="{ blur: !sharp && src }" :style="boxStyle()">
    <img v-if="src" :src="src" alt="" />
    <div v-else class="ph"><Image :size="28" /></div>
    <div v-if="kind === 'video' || kind === 'gif'" class="play"><Play :size="18" /></div>
    <div v-if="duration" class="dur">{{ fmtDur(duration) }}</div>
    <div v-if="kind === 'gif'" class="gifbadge">GIF</div>
    <div v-if="size" class="sizebadge">{{ fmtSize(size) }}</div>
  </div>
</template>

<style scoped>
.thumb {
  position: relative;
  border-radius: 10px;
  overflow: hidden;
  background: var(--bg-3);
  min-width: 80px;
  min-height: 60px;
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.thumb.blur img {
  filter: blur(8px);
  transform: scale(1.05);
}
.ph {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  font-size: 28px;
  opacity: 0.4;
}
.play {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 18px;
}
.dur {
  position: absolute;
  left: 6px;
  bottom: 6px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 5px;
}
.gifbadge {
  position: absolute;
  right: 6px;
  top: 6px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
}
.sizebadge {
  position: absolute;
  right: 6px;
  bottom: 6px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 5px;
}
</style>
