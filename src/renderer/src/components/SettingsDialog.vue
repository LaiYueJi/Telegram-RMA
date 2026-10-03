<script setup>
import { ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { useSettingsStore } from '../stores/settings.js'
import { BG_THEMES, bgSwatch } from '../data/gradients.js'

const props = defineProps({ show: Boolean })
const emit = defineEmits(['update:show'])
const message = useMessage()
const settings = useSettingsStore()

const tab = ref('cache')
const cache = ref({ dir: '', size: 0, files: 0 })
const about = ref({})
const exporting = ref(false)
const importing = ref(false)

watch(
  () => props.show,
  async (v) => {
    if (!v) return
    if (!settings.loaded) await settings.load()
    refreshCache()
    about.value = await settings.appInfo()
  }
)

function fmtSize(n) {
  if (!n) return '0 B'
  if (n < 1024) return n + ' B'
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB'
  return (n / 1024 ** 3).toFixed(2) + ' GB'
}

async function refreshCache() {
  cache.value = await settings.cacheInfo()
}
async function clearCache() {
  await settings.clearCache()
  await refreshCache()
  message.success('緩存已清理')
}
async function pickCacheDir() {
  const r = await settings.pickFolder(cache.value.dir)
  if (r.canceled) return
  await settings.savePaths({ cacheDir: r.path })
  await refreshCache()
  message.success('已更新緩存目錄(重新載入後完全生效)')
}

async function setPref(patch) {
  await settings.savePreferences(patch)
}

async function exportData() {
  exporting.value = true
  try {
    const r = await settings.exportData()
    if (r?.canceled) return
    if (r?.ok) message.success('已匯出到 ' + r.path)
    else message.error('匯出失敗:' + (r?.error || '未知錯誤'))
  } finally {
    exporting.value = false
  }
}

async function importData() {
  importing.value = true
  try {
    const r = await settings.importData()
    if (r?.canceled) return
    if (r?.ok) message.success('已匯入,部分項目重啟後完全生效')
    else message.error('匯入失敗:' + (r?.error || '檔案格式不正確'))
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <n-modal
    :show="show"
    @update:show="(v) => emit('update:show', v)"
    preset="card"
    title="系統設定"
    style="width: 680px; max-height: 86vh"
    :bordered="false"
  >
    <n-tabs
      v-model:value="tab"
      type="line"
      pane-style="max-height: 62vh; overflow-y: auto; padding-right: 8px;"
    >
      <!-- 緩存與存儲 -->
      <n-tab-pane name="cache" tab="緩存與存儲">
        <div class="block">
          <div class="line">
            <span>文件數量 <b class="num">{{ cache.files }}</b></span>
            <span>文件容量 <b class="num accent">{{ fmtSize(cache.size) }}</b></span>
            <div class="grow" />
            <n-button size="small" @click="refreshCache">刷新</n-button>
            <n-button size="small" type="error" @click="clearCache">清理緩存</n-button>
          </div>
          <div class="sub">縮圖 / 頭像快取。清理不影響已下載檔案。</div>
        </div>
        <div class="block">
          <div class="line">
            <div>
              <div>緩存目錄</div>
              <div class="sub mono">{{ cache.dir }}</div>
            </div>
            <div class="grow" />
            <n-button size="small" type="primary" @click="pickCacheDir">選擇目錄</n-button>
          </div>
        </div>
      </n-tab-pane>

      <!-- 偏好設定 -->
      <n-tab-pane name="pref" tab="偏好設定">
        <div class="prefrow">
          <span>普通下載是否彈框</span>
          <n-radio-group
            :value="settings.preferences.downloadPopup"
            @update:value="(v) => setPref({ downloadPopup: v })"
          >
            <n-radio :value="true">彈框</n-radio>
            <n-radio :value="false">不彈框</n-radio>
          </n-radio-group>
        </div>

        <div class="prefrow col">
          <div>
            <div>背景漸層主題</div>
            <div class="sub">套用在整個 App 的背景畫布(主內容區底色);面板/文字維持不變。深色調,適合深色模式。</div>
          </div>
          <div class="swatches">
            <button
              v-for="t in BG_THEMES"
              :key="t.id"
              class="swatch"
              :class="{ active: (settings.preferences.backgroundTheme || 'default') === t.id }"
              :style="{ background: bgSwatch(t) }"
              :title="t.en && t.en !== t.name ? `${t.name}（${t.en}）` : t.name"
              @click="setPref({ backgroundTheme: t.id })"
            >
              <span class="swatch-check" v-if="(settings.preferences.backgroundTheme || 'default') === t.id">✓</span>
              <span class="swatch-name">{{ t.name }}</span>
            </button>
          </div>
        </div>

        <div class="prefrow">
          <div>
            <div>狀態列霓虹效果</div>
            <div class="sub">頂部已登入/代理/網路燈號與邊框發光動畫風格。</div>
          </div>
          <n-radio-group
            :value="settings.preferences.glowStyle || 'breathe'"
            @update:value="(v) => setPref({ glowStyle: v })"
          >
            <n-radio value="breathe">呼吸</n-radio>
            <n-radio value="none">靜態</n-radio>
          </n-radio-group>
        </div>

        <div class="prefrow">
          <div>
            <div>GPU 加速</div>
            <div class="sub">只影響介面流暢度,不影響後台下載/轉發能力。切換後需重啟生效。</div>
          </div>
          <n-radio-group
            :value="settings.preferences.gpuAcceleration"
            @update:value="(v) => setPref({ gpuAcceleration: v })"
          >
            <n-radio value="system">系統默認</n-radio>
            <n-radio value="off">關閉</n-radio>
          </n-radio-group>
        </div>

        <div class="prefrow col">
          <div>下載並發數</div>
          <n-input-number
            :value="settings.preferences.concurrency"
            :min="1"
            :max="16"
            @update:value="(v) => setPref({ concurrency: v || 1 })"
          />
        </div>

        <div class="prefrow col">
          <div>單檔下載連線數</div>
          <div class="sub">
            單一檔案對同一伺服器開幾條獨立連線。Telegram 限速是「每連線」的,連線越多越快。<b>代理延遲高或會週期性卡頓時,多連線是提速關鍵</b>——每條是獨立的 TCP,一條卡住不會拖住其他條(單一連線則會整條塞住)。下載已改在<b>背景執行緒</b>解密,調高不會再卡 UI、也不會斷線,可放心設 <b>4~8</b>。設 1 最慢(等於沒有多連線加速)。
          </div>
          <n-input-number
            :value="settings.preferences.downloadConnections"
            :min="1"
            :max="8"
            @update:value="(v) => setPref({ downloadConnections: v || 1 })"
          />
        </div>

        <div class="prefrow col">
          <div>按下關閉鈕(X)時</div>
          <div class="sub">
            縮到系統匣後,批量下載與自動化規則會<b>繼續在背景執行</b>,點右下角圖示可叫回視窗。
            選「每次詢問」的話,關閉時會跳出選擇視窗,那裡也可以勾「不再詢問」。
          </div>
          <n-radio-group
            :value="settings.preferences.closeAction || 'ask'"
            @update:value="(v) => setPref({ closeAction: v })"
          >
            <n-space vertical :size="4">
              <n-radio value="ask">每次詢問</n-radio>
              <n-radio value="tray">縮到系統匣(背景繼續下載)</n-radio>
              <n-radio value="quit">直接結束程式</n-radio>
            </n-space>
          </n-radio-group>
        </div>

        <div class="prefrow col">
          <div>批量下載同時檔案數</div>
          <div class="sub">
            批量任務一次同時抓幾個檔案(1~16,預設 4)。這幾個檔案目前是<b>共用同一條連線</b>,所以調高主要是把「等待伺服器回應」的時間疊起來用,不是真的開更多條線
            —— 高延遲代理下調到 <b>6~8</b> 通常有感;調太高反而會互相搶頻寬、也比較容易觸發 FloodWait。
          </div>
          <n-input-number
            :value="settings.preferences.batchConcurrency"
            :min="1"
            :max="16"
            @update:value="(v) => setPref({ batchConcurrency: v || 1 })"
          />
        </div>

        <div class="prefrow">
          <div class="col">
            <div>批量下載單次上限</div>
            <div class="sub">單一批量下載任務最多掃描/下載幾則訊息(安全上限,避免一次掃整個大頻道)。預設 5000。</div>
            <n-input-number
              :value="settings.preferences.batchDownloadLimit"
              :min="100"
              :max="50000"
              @update:value="(v) => setPref({ batchDownloadLimit: v || 100 })"
            />
          </div>
          <div class="col">
            <div>轉發任務單次上限</div>
            <div class="sub">單一轉發任務最多處理幾則訊息。預設 2000。</div>
            <n-input-number
              :value="settings.preferences.forwardLimit"
              :min="100"
              :max="50000"
              @update:value="(v) => setPref({ forwardLimit: v || 100 })"
            />
          </div>
        </div>

        <div class="prefrow col">
          <div>消息檢索結果上限</div>
          <div class="sub">單次消息檢索最多回傳幾筆命中結果。越大越完整,但搜尋越久(後端掃描上限會同步放大)。預設 1000。</div>
          <n-input-number
            :value="settings.preferences.searchLimit"
            :min="100"
            :max="10000"
            :step="100"
            @update:value="(v) => setPref({ searchLimit: v || 100 })"
          />
        </div>
      </n-tab-pane>

      <!-- 資料匯入匯出 -->
      <n-tab-pane name="data" tab="資料匯入匯出">
        <div class="block">
          <div class="line">
            <div>
              <div>備份資料</div>
              <div class="sub">匯出偏好設定、下載/轉發任務、自動化規則、增量進度為一個 JSON 檔。</div>
            </div>
            <div class="grow" />
            <n-button size="small" type="primary" :loading="exporting" @click="exportData">匯出</n-button>
          </div>
        </div>
        <div class="block">
          <div class="line">
            <div>
              <div>還原資料</div>
              <div class="sub">從 JSON 檔匯入並覆蓋上述資料(重啟後完全生效)。</div>
            </div>
            <div class="grow" />
            <n-button size="small" :loading="importing" @click="importData">匯入</n-button>
          </div>
        </div>
        <div class="sub safe">為安全起見,匯出不含登入 session、API 憑證與代理設定。</div>
      </n-tab-pane>

      <!-- 關於 -->
      <n-tab-pane name="about" tab="關於">
        <div class="about">
          <div class="logo">TG</div>
          <div class="title">Telegram 資源管理助手 v{{ about.version }}</div>
          <div class="sub">Telegram Resource Management Assistant (Telegram-RMA)</div>
          <div class="sub">輕量的 Telegram 資源管理工具 · 資料只存在你的電腦</div>
          <div class="kv">Electron {{ about.electron }} · Node {{ about.node }} · Chromium {{ about.chrome }}</div>
        </div>
      </n-tab-pane>
    </n-tabs>
  </n-modal>
</template>

<style scoped>
.block {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
  margin-bottom: 12px;
}
.line {
  display: flex;
  align-items: center;
  gap: 16px;
}
.grow {
  flex: 1;
}
.num {
  color: var(--accent);
}
.num.accent {
  color: var(--accent-2);
}
.sub {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 4px;
}
.sub.safe {
  margin-top: 10px;
  padding-left: 2px;
}
.mono {
  font-family: monospace;
}
.prefrow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 14px 4px;
  border-bottom: 1px solid var(--border);
}
.prefrow.col,
.prefrow .col {
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}
.swatches {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  gap: 8px;
  width: 100%;
  max-height: 260px;
  overflow-y: auto;
  padding: 2px 4px 2px 2px;
}
.swatch {
  position: relative;
  height: 46px;
  border-radius: 10px;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
  overflow: hidden;
  box-shadow: var(--shadow-card);
  transition: transform 0.12s ease, border-color 0.12s ease;
}
.swatch:hover {
  transform: translateY(-1px);
}
.swatch.active {
  border-color: var(--text-0);
}
.swatch-name {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 2px 4px;
  font-size: 10.5px;
  color: #fff;
  text-align: center;
  background: rgba(0, 0, 0, 0.32);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.swatch-check {
  position: absolute;
  top: 3px;
  right: 5px;
  font-size: 12px;
  font-weight: 700;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}
.about {
  text-align: center;
  padding: 20px 0;
}
.about .logo {
  width: 56px;
  height: 56px;
  border-radius: 14px;
  margin: 0 auto 12px;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 18px;
}
.about .title {
  font-size: 16px;
  font-weight: 700;
}
.about .kv {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-2);
}
</style>
