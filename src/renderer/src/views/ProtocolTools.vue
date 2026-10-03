<script setup>
import { ref, computed, onUnmounted } from 'vue'
import { useMessage } from 'naive-ui'
import {
  KeyRound,
  Loader2,
  Check,
  X,
  FolderOutput,
  FolderInput,
  Copy,
  ArrowRightLeft,
  FileDown,
  Download as DownloadIcon,
  Info
} from 'lucide-vue-next'
import { useAccountStore, accountName } from '../stores/account.js'

const message = useMessage()
const account = useAccountStore()

/* ---------- 卡片 1:導入協議號(session → 帳號) ---------- */
const sessionText = ref('')
const importing = ref(false)
const importProgress = ref({ index: 0, total: 0 })
const importResults = ref([])
let offProgress = null
const lineCount = computed(() => sessionText.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length)

async function runImport() {
  const text = sessionText.value.trim()
  if (!text) return message.warning('請貼上至少一組 session 字串')
  importing.value = true
  importResults.value = []
  importProgress.value = { index: 0, total: lineCount.value }
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  offProgress?.()
  offProgress = window.api.on('accounts:progress', (p) => {
    if (p.kind !== 'import') return
    importProgress.value = { index: p.index + 1, total: p.total }
    importResults.value.push({
      ok: p.ok,
      error: p.error,
      name: p.user ? [p.user.firstName, p.user.lastName].filter(Boolean).join(' ') || p.user.username || p.user.id : ''
    })
  })
  const r = await account.importBatch(text)
  offProgress?.()
  offProgress = null
  importing.value = false
  if (r?.ok) {
    if (r.succeeded) message.success(`成功導入 ${r.succeeded} 個協議號`)
    if (r.failed) message.warning(`${r.failed} 個失敗`)
    if (!r.failed) sessionText.value = ''
  } else message.error(r?.error || '導入失敗')
}
onUnmounted(() => offProgress?.())

/* ---------- 卡片 2:協議號 → 直登號(tdata) ---------- */
const toTdataSource = ref('account') // 'account' | 'paste'
const selectedAccountId = ref(null)
const pasteSession = ref('')
const converting1 = ref(false)
const tdataResult = ref(null) // { path }

const accountOptions = computed(() =>
  account.accounts.map((a) => ({
    label: `${accountName(a)}${a.user?.username ? ' (@' + a.user.username + ')' : ''}${a.type === 'protocol' ? ' · 協議' : ''}`,
    value: a.id
  }))
)

async function convertToTdata() {
  if (toTdataSource.value === 'account' && !selectedAccountId.value) return message.warning('請先選擇一個帳號')
  if (toTdataSource.value === 'paste' && !pasteSession.value.trim()) return message.warning('請貼上 session 字串')
  const pick = await window.api.settings.pickFolder()
  if (!pick || pick.canceled) return
  converting1.value = true
  tdataResult.value = null
  const opts =
    toTdataSource.value === 'account'
      ? { accountId: selectedAccountId.value, outDir: pick.path }
      : { session: pasteSession.value.trim(), outDir: pick.path }
  const r = await account.sessionToTdata(opts)
  converting1.value = false
  if (r?.ok) {
    tdataResult.value = { path: r.path }
    message.success('已產生 tdata 資料夾')
  } else message.error(r?.error || '轉換失敗')
}
function revealTdata() {
  if (tdataResult.value?.path) window.api.download.reveal(tdataResult.value.path)
}

/* ---------- 卡片 3:直登號(tdata) → 協議號 ---------- */
const converting2 = ref(false)
const importingBack = ref(false)
const tdataSession = ref('')

async function convertFromTdata() {
  const pick = await window.api.settings.pickFolder()
  if (!pick || pick.canceled) return
  converting2.value = true
  tdataSession.value = ''
  const r = await account.tdataToSession(pick.path)
  converting2.value = false
  if (r?.ok) {
    tdataSession.value = r.session
    message.success('已從 tdata 取出 session')
  } else message.error(r?.error || '轉換失敗')
}
async function copySession() {
  try {
    await navigator.clipboard.writeText(tdataSession.value)
    message.success('已複製 session')
  } catch {
    message.error('複製失敗')
  }
}
async function importBack() {
  if (!tdataSession.value) return
  importingBack.value = true
  const r = await account.importSession(tdataSession.value)
  importingBack.value = false
  if (r?.ok) message.success('已驗證並導入為帳號')
  else message.error(r?.error || '導入失敗')
}
</script>

<template>
  <div class="h-full overflow-y-auto bg-bg0">
    <div class="max-w-4xl mx-auto px-6 py-6">
      <!-- 標題 -->
      <div class="flex items-center gap-3 mb-1">
        <div class="w-11 h-11 rounded-2xl grid place-items-center" style="background: var(--accent-grad)">
          <KeyRound :size="22" class="text-white" />
        </div>
        <div>
          <h1 class="text-[20px] font-bold text-ink">協議號工具</h1>
          <p class="text-[12.5px] text-muted">session 導入 · 協議號 ⇄ 直登號(tdata)互轉</p>
        </div>
      </div>

      <div class="grid gap-4 mt-6">
        <!-- 卡片 1:導入協議號 -->
        <div class="nc-card p-4">
          <div class="flex items-center gap-2 mb-2">
            <FileDown :size="17" class="text-accent" />
            <h2 class="text-[15px] font-semibold text-ink">導入協議號(session → 帳號)</h2>
          </div>
          <p class="text-[12px] text-muted mb-3">貼上 GramJS / Telethon session 字串,一行一個(支援批量),連線驗證後加入帳號清單。</p>
          <n-input
            v-model:value="sessionText"
            type="textarea"
            :rows="4"
            placeholder="1BQANOTEuMТA5Lj… (每行一組)"
            :disabled="importing"
            class="font-mono"
          />
          <div class="flex items-center justify-between mt-2">
            <span class="text-[11.5px] text-muted">偵測到 <b class="text-ink2">{{ lineCount }}</b> 組</span>
            <button class="nc-btn nc-btn--primary" :disabled="importing || !lineCount" @click="runImport">
              <Loader2 v-if="importing" :size="15" class="animate-spin" />
              {{ importing ? `導入中 ${importProgress.index}/${importProgress.total}` : '導入' }}
            </button>
          </div>
          <div v-if="importResults.length" class="mt-3 space-y-1 max-h-40 overflow-y-auto">
            <div v-for="(r, i) in importResults" :key="i" class="flex items-center gap-2 text-[12px]">
              <Check v-if="r.ok" :size="14" class="text-ok flex-none" />
              <X v-else :size="14" class="text-bad flex-none" />
              <span v-if="r.ok" class="text-ink truncate">{{ r.name || '已導入' }}</span>
              <span v-else class="text-bad truncate">{{ r.error }}</span>
            </div>
          </div>
        </div>

        <!-- 卡片 2:協議號 → 直登號(tdata) -->
        <div class="nc-card p-4">
          <div class="flex items-center gap-2 mb-2">
            <FolderOutput :size="17" class="text-accent" />
            <h2 class="text-[15px] font-semibold text-ink">協議號 → 直登號(tdata)</h2>
          </div>
          <p class="text-[12px] text-muted mb-3">
            把協議號 session 轉成 Telegram Desktop 的 <b class="text-ink2">tdata</b> 資料夾,即可放進官方桌面版直接登入(直登)。
          </p>
          <div class="nc-seg mb-3">
            <button :class="{ on: toTdataSource === 'account' }" @click="toTdataSource = 'account'">從帳號選擇</button>
            <button :class="{ on: toTdataSource === 'paste' }" @click="toTdataSource = 'paste'">貼上 session</button>
          </div>
          <n-select
            v-if="toTdataSource === 'account'"
            v-model:value="selectedAccountId"
            :options="accountOptions"
            placeholder="選擇要轉出的帳號"
            filterable
          />
          <n-input
            v-else
            v-model:value="pasteSession"
            type="textarea"
            :rows="3"
            placeholder="貼上單一 GramJS / Telethon session 字串"
            class="font-mono"
          />
          <button class="nc-btn nc-btn--primary mt-3" :disabled="converting1" @click="convertToTdata">
            <Loader2 v-if="converting1" :size="15" class="animate-spin" />
            <FolderOutput v-else :size="15" />
            {{ converting1 ? '產生中…' : '選擇資料夾並產生 tdata' }}
          </button>
          <div v-if="tdataResult" class="mt-3 nc-card p-3 flex items-center gap-2">
            <Check :size="16" class="text-ok flex-none" />
            <span class="text-[12px] text-ink2 truncate flex-1">{{ tdataResult.path }}</span>
            <button class="nc-btn nc-btn--icon" title="開啟資料夾" @click="revealTdata"><FolderInput :size="14" /></button>
          </div>
        </div>

        <!-- 卡片 3:直登號(tdata) → 協議號 -->
        <div class="nc-card p-4">
          <div class="flex items-center gap-2 mb-2">
            <ArrowRightLeft :size="17" class="text-accent" />
            <h2 class="text-[15px] font-semibold text-ink">直登號(tdata) → 協議號</h2>
          </div>
          <p class="text-[12px] text-muted mb-3">
            選擇一個 tdata 資料夾(內含 <code class="text-ink2">key_datas</code>),取出成 GramJS session 字串,可複製或直接導入為帳號。
          </p>
          <button class="nc-btn nc-btn--primary" :disabled="converting2" @click="convertFromTdata">
            <Loader2 v-if="converting2" :size="15" class="animate-spin" />
            <FolderInput v-else :size="15" />
            {{ converting2 ? '讀取中…' : '選擇 tdata 資料夾' }}
          </button>
          <div v-if="tdataSession" class="mt-3">
            <n-input :value="tdataSession" type="textarea" :rows="4" readonly class="font-mono" />
            <div class="flex gap-2 mt-2">
              <button class="nc-btn flex-1" @click="copySession"><Copy :size="14" />複製 session</button>
              <button class="nc-btn nc-btn--primary flex-1" :disabled="importingBack" @click="importBack">
                <Loader2 v-if="importingBack" :size="14" class="animate-spin" />
                <DownloadIcon v-else :size="14" />驗證並導入為帳號
              </button>
            </div>
          </div>
          <div class="mt-3 flex items-start gap-2 text-[11.5px] text-muted">
            <Info :size="14" class="flex-none mt-0.5" />
            <span>若該 tdata 設有本機密碼(passcode)則無法讀取;僅支援未加鎖的 tdata。</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
