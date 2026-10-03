<script setup>
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { useDialogsStore } from '../stores/dialogs.js'

const props = defineProps({
  peerId: String,
  title: { type: String, default: '' },
  // 直接提供圖片 URL(如登入帳號頭像);提供時不走對話清單快取
  url: { type: String, default: '' },
  hasPhoto: { type: Boolean, default: true },
  size: { type: Number, default: 44 },
  // 指定文字縮寫的底色;不給就依 peerId / 名稱雜湊出固定色
  bg: { type: String, default: '' }
})

const dialogs = useDialogsStore()
const src = ref(props.url || null)
const el = ref(null)
let io = null

watch(
  () => props.url,
  (v) => {
    src.value = v || null
  }
)

// 同一個位置換人(列表複用元件)時要重抓,否則會留著上一個人的臉
watch(
  () => props.peerId,
  () => {
    if (props.url) return
    src.value = null
    loadAvatar()
  }
)

const initials = computed(() => {
  const t = (props.title || '').trim()
  if (!t) return '?'
  // 中文取首字,英文取前兩字母
  if (/[一-龥]/.test(t[0])) return t[0]
  return t.replace(/\s+/g, '').slice(0, 2).toUpperCase()
})

const bgColor = computed(() => {
  if (props.bg) return props.bg
  let h = 0
  const s = props.peerId || props.title || ''
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return `hsl(${h}, 45%, 42%)`
})

async function loadAvatar() {
  if (props.url) return // 已直接提供圖片
  if (!props.hasPhoto || !props.peerId) return
  const id = props.peerId
  const url = await dialogs.avatar(id)
  // 等待期間可能又換人了,別把舊結果貼上去
  if (url && props.peerId === id) src.value = url
}

onMounted(() => {
  io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        loadAvatar()
        io?.disconnect()
      }
    },
    { rootMargin: '120px' }
  )
  if (el.value) io.observe(el.value)
})
onUnmounted(() => io?.disconnect())
</script>

<template>
  <div
    ref="el"
    class="avatar"
    :style="{ width: size + 'px', height: size + 'px', background: src ? '#000' : bgColor, fontSize: size * 0.4 + 'px' }"
  >
    <img v-if="src" :src="src" alt="" />
    <span v-else>{{ initials }}</span>
  </div>
</template>

<style scoped>
.avatar {
  border-radius: 50%;
  overflow: hidden;
  display: grid;
  place-items: center;
  color: #fff;
  font-weight: 600;
  flex: none;
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
