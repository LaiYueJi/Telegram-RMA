<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { Image, Play } from 'lucide-vue-next'

/**
 * 正方形縮圖格。共享媒體的方格分頁與日曆格共用:
 * MediaThumb 會依原圖比例算尺寸(訊息氣泡裡才對),排方格會參差不齊,所以另外做這個。
 */
const props = defineProps({
  dialogId: String,
  msgId: Number,
  kind: { type: String, default: '' },
  thumb: { type: String, default: null }, // stripped 模糊預覽(訊息已帶就先顯示)
  hasThumb: { type: Boolean, default: true },
  duration: { type: Number, default: 0 },
  round: Boolean, // 日曆格用圓形
  dim: Boolean // 日曆:非本月的日期壓暗
})

const src = ref(props.thumb || null)
const sharp = ref(false)
const el = ref(null)
let io = null
let fetched = false

async function fetchSharp() {
  if (fetched || !props.hasThumb || !props.msgId) return
  fetched = true
  const id = props.msgId
  const r = await window.api.messages.thumb(props.dialogId, id)
  if (r?.dataUrl && props.msgId === id) {
    src.value = r.dataUrl
    sharp.value = true
  }
}

// 同一格換訊息(日曆換月、方格重載)要重抓
watch(
  () => props.msgId,
  () => {
    fetched = false
    sharp.value = false
    src.value = props.thumb || null
    fetchSharp()
  }
)

onMounted(() => {
  io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        fetchSharp()
        io?.disconnect()
      }
    },
    { rootMargin: '250px' }
  )
  if (el.value) io.observe(el.value)
})
onUnmounted(() => io?.disconnect())

function fmtDur(s) {
  if (!s) return ''
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
</script>

<template>
  <div ref="el" class="sq" :class="{ round, dim, blur: src && !sharp }">
    <img v-if="src" :src="src" alt="" />
    <div v-else class="ph"><Image :size="18" /></div>
    <div v-if="kind === 'video' || kind === 'gif'" class="play"><Play :size="14" /></div>
    <div v-if="duration && !round" class="dur">{{ fmtDur(duration) }}</div>
    <div v-if="kind === 'gif' && !round" class="gif">GIF</div>
    <slot />
  </div>
</template>

<style scoped>
.sq {
  position: relative;
  aspect-ratio: 1;
  width: 100%;
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-3);
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: transform 0.12s, filter 0.12s;
}
.sq:hover {
  transform: scale(1.03);
  filter: brightness(1.08);
}
.sq.round {
  border-radius: 50%;
}
.sq.dim {
  opacity: 0.42;
}
.sq img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.sq.blur img {
  filter: blur(6px);
  transform: scale(1.1);
}
.ph {
  color: var(--text-2);
}
.play {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #fff;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.7);
  pointer-events: none;
}
.dur,
.gif {
  position: absolute;
  bottom: 3px;
  font-size: 10px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  pointer-events: none;
}
.dur {
  right: 3px;
}
.gif {
  left: 3px;
  font-weight: 700;
}
</style>
