<script setup>
import { computed } from 'vue'
import { Pause, Play, X, Check, RotateCcw, Download } from 'lucide-vue-next'

const props = defineProps({
  download: Object,
  overlay: Boolean
})
const emit = defineEmits(['download', 'pause', 'resume', 'cancel', 'reveal'])

const status = computed(() => props.download?.status || 'idle')
const pct = computed(() => {
  const d = props.download
  if (!d || !d.total) return 0
  return Math.min(100, Math.round((d.downloaded / d.total) * 100))
})
</script>

<template>
  <div class="dlbtn" :class="[status, { overlay }]">
    <!-- 下載中:暫停+取消 -->
    <template v-if="status === 'downloading'">
      <button class="cb" title="暫停" @click.stop="emit('pause')"><Pause :size="overlay ? 14 : 16" /></button>
      <span v-if="!overlay" class="pc">{{ pct }}%</span>
      <button class="cb x" title="停止" @click.stop="emit('cancel')"><X :size="14" /></button>
    </template>
    <!-- 暫停:繼續 -->
    <template v-else-if="status === 'paused'">
      <button class="cb" title="繼續" @click.stop="emit('resume')"><Play :size="overlay ? 14 : 16" /></button>
      <span v-if="!overlay" class="pc">{{ pct }}%</span>
      <button class="cb x" title="停止" @click.stop="emit('cancel')"><X :size="14" /></button>
    </template>
    <!-- 完成:開啟 -->
    <button v-else-if="status === 'done'" class="cb done" title="已下載" @click.stop="emit('reveal')">
      <Check :size="overlay ? 14 : 18" />
    </button>
    <!-- 失敗:重試 -->
    <button v-else-if="status === 'error'" class="cb err" title="重試" @click.stop="emit('download')">
      <RotateCcw :size="overlay ? 14 : 16" />
    </button>
    <!-- 閒置:下載 -->
    <button v-else class="cb dl" title="下載" @click.stop="emit('download')"><Download :size="overlay ? 14 : 16" /></button>
  </div>
</template>

<style scoped>
.dlbtn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.dlbtn.overlay {
  gap: 6px;
}
.cb {
  width: 38px;
  height: 38px;
  border: none;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  font-size: 16px;
  display: grid;
  place-items: center;
  flex: none;
  transition: transform 0.1s, background 0.12s;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}
.cb:hover {
  transform: scale(1.08);
}
.cb.dl { background: var(--accent); }
.cb.done { background: var(--green); }
.cb.err { background: var(--red); }
.cb.x {
  width: 32px;
  height: 32px;
  background: rgba(229, 72, 77, 0.9);
}
/* overlay:投影取代黑色背景,僅顯示單一圖示按鈕 */
.overlay .cb {
  width: 30px;
  height: 30px;
  background: rgba(91, 108, 255, 0.92);
  box-shadow: 0 0 10px rgba(0,0,0,0.6);
}
.overlay .cb.done { background: rgba(43, 191, 122, 0.95); }
.overlay .cb.err { background: rgba(229, 72, 77, 0.95); }
.overlay .cb.x { width: 26px; height: 26px; }
.pc {
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  min-width: 30px;
  text-align: center;
}
.dlbtn:not(.overlay) .pc {
  color: var(--text-0);
}
</style>
