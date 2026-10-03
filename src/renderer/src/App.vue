<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { darkTheme, zhTW, dateZhTW } from 'naive-ui'
import { Power } from 'lucide-vue-next'
import TopBar from './layout/TopBar.vue'
import SideNav from './layout/SideNav.vue'
import WindowControls from './components/WindowControls.vue'
import { useSettingsStore } from './stores/settings.js'
import { useProxyStore } from './stores/proxy.js'
import { useNotificationsStore } from './stores/notifications.js'
import { applyBackgroundTheme } from './data/gradients.js'

const route = useRoute()
const isFullscreen = computed(() => !!route.meta.fullscreen)

const settings = useSettingsStore()
const proxy = useProxyStore()
const notifications = useNotificationsStore()

const isDark = computed(() => settings.preferences?.theme !== 'light')
const naiveTheme = computed(() => isDark.value ? darkTheme : null)

// 主題即時生效:把 data-theme 寫到 <html>,讓整套自訂 CSS 變數隨偏好切換(不需重開)
watch(
  isDark,
  (dark) => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  },
  { immediate: true }
)

// 背景漸層主題即時生效(以 inline 變數覆寫 --app-bg);亮/暗模式切換時重套,讓遮罩隨模式調整
watch(
  [() => settings.preferences?.backgroundTheme || 'default', isDark],
  ([id, dark]) => applyBackgroundTheme(id, dark),
  { immediate: true }
)

// 深色才覆寫卡片/彈窗底色;淺色沿用 naive-ui 預設淺色,否則彈窗會卡在深色(亮模式看起來沒變)
const themeOverrides = computed(() => ({
  common: {
    primaryColor: '#5b6cff',
    primaryColorHover: '#6b7cff',
    primaryColorPressed: '#4a5be0',
    primaryColorSuppl: '#5b6cff',
    borderRadius: '8px',
    ...(isDark.value
      ? {
          cardColor: '#111a2e',
          modalColor: '#111a2e',
          popoverColor: '#16223c',
          bodyColor: '#0b1220'
        }
      : {})
  }
}))

onMounted(async () => {
  // 這個要最先訂閱:放在 await 後面的話,只要前面任何一步失敗就再也收不到,
  // 按 X 就會退回系統原生對話框。
  try {
    window.api.on('win:askClose', () => {
      askClose.value = { show: true, remember: false }
      // 先回報「我已經顯示了」,主程序才不會在幾秒後又補一個系統原生對話框
      window.api.closeAck()
    })
  } catch (e) {
    console.error('無法訂閱 win:askClose:', e)
  }
  notifications.start() // 全域訂閱下載進度
  await settings.load()
  await proxy.load()
})

// 關閉方式詢問
const askClose = ref({ show: false, remember: false })
function answerClose(action) {
  askClose.value.show = false
  window.api.closeAnswer({ action, remember: askClose.value.remember })
}
</script>

<template>
  <n-config-provider
    :theme="naiveTheme"
    :theme-overrides="themeOverrides"
    :locale="zhTW"
    :date-locale="dateZhTW"
  >
    <n-message-provider>
      <n-dialog-provider>
        <div v-if="isFullscreen" class="fullscreen">
          <div class="floating-titlebar drag">
            <WindowControls />
          </div>
          <router-view />
        </div>
        <div v-else class="shell">
          <TopBar />
          <div class="body">
            <SideNav />
            <main class="content">
              <router-view />
            </main>
          </div>
        </div>

        <!-- 按 X 的詢問(自繪,取代系統原生對話框) -->
        <n-modal
          v-model:show="askClose.show"
          preset="card"
          title="關閉 Telegram 資源管理助手"
          style="width: 440px"
          :bordered="false"
          :closable="false"
          :mask-closable="false"
        >
          <div class="ac-body">
            <div class="ac-icon"><Power :size="20" /></div>
            <div>
              <p class="ac-q">要結束程式,還是縮到系統匣繼續在背景下載?</p>
              <p class="ac-sub">
                縮到系統匣後,批量下載與自動化規則會<b>繼續執行</b>,點右下角圖示可以叫回視窗。
              </p>
            </div>
          </div>
          <n-checkbox v-model:checked="askClose.remember" class="ac-remember">
            記住我的選擇,不再詢問(之後可到系統設定改)
          </n-checkbox>
          <template #footer>
            <div class="ac-foot">
              <n-button size="small" @click="answerClose('cancel')">取消</n-button>
              <div class="grow" />
              <n-button size="small" @click="answerClose('quit')">直接結束</n-button>
              <n-button size="small" type="primary" @click="answerClose('tray')">縮到系統匣</n-button>
            </div>
          </template>
        </n-modal>
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--app-bg); /* 整個視窗底色;背景漸層主題會覆寫 --app-bg,透過半透明的頂部列/側欄/內容區顯示 */
}
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  background: transparent; /* 透出 .shell 的底色(預設純色底、或漸層主題) */
}
.fullscreen {
  height: 100vh;
  position: relative;
}
.floating-titlebar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 40px;
  display: flex;
  justify-content: flex-end;
  z-index: 100;
}

.ac-body {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.ac-icon {
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 11px;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
}
.ac-q {
  margin: 0 0 6px;
  font-size: 14px;
}
.ac-sub {
  margin: 0;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.75;
}
.ac-remember {
  margin-top: 14px;
  font-size: 12.5px;
}
.ac-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ac-foot .grow {
  flex: 1;
}
</style>
