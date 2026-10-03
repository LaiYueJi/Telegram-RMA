<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

const isMax = ref(false)
let off = null

onMounted(async () => {
  isMax.value = await window.api.win.isMaximized()
  off = window.api.on('win:maximized', (v) => (isMax.value = v))
})
onUnmounted(() => off?.())

const winMin = () => window.api.win.minimize()
const winMax = () => window.api.win.maximize()
const winClose = () => window.api.win.close()
</script>

<template>
  <div class="winctl no-drag">
    <button class="wbtn" title="最小化" @click="winMin">
      <svg width="11" height="11" viewBox="0 0 11 11"><rect x="1" y="5" width="9" height="1" fill="currentColor" /></svg>
    </button>
    <button class="wbtn" :title="isMax ? '還原' : '最大化'" @click="winMax">
      <svg v-if="!isMax" width="11" height="11" viewBox="0 0 11 11">
        <rect x="1.5" y="1.5" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1" />
      </svg>
      <svg v-else width="11" height="11" viewBox="0 0 11 11">
        <rect x="1.5" y="3" width="6.5" height="6.5" fill="none" stroke="currentColor" stroke-width="1" />
        <path d="M3.5 3 V1.5 H9.5 V7.5 H8" fill="none" stroke="currentColor" stroke-width="1" />
      </svg>
    </button>
    <button class="wbtn close" title="關閉" @click="winClose">
      <svg width="11" height="11" viewBox="0 0 11 11">
        <path d="M1 1 L10 10 M10 1 L1 10" stroke="currentColor" stroke-width="1.2" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.winctl {
  display: flex;
  gap: 2px;
}
.wbtn {
  width: 40px;
  height: 40px;
  border: none;
  background: transparent;
  color: var(--text-1);
  cursor: pointer;
  display: grid;
  place-items: center;
  position: relative;
}
/* hover 高光改成「內縮的圓角小方塊」,不再是貼齊邊緣的整塊尖角正方形 */
.wbtn::before {
  content: '';
  position: absolute;
  inset: 5px 4px;
  border-radius: 8px;
  background: transparent;
  transition: background 0.12s ease;
  pointer-events: none;
}
.wbtn > svg {
  position: relative;
  z-index: 1;
}
.wbtn:hover {
  color: var(--text-0);
}
.wbtn:hover::before {
  background: var(--bg-2);
}
.wbtn.close:hover {
  color: #fff;
}
.wbtn.close:hover::before {
  background: var(--red);
}
</style>
