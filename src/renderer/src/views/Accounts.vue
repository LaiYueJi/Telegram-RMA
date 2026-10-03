<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage, useDialog } from 'naive-ui'
import {
  Plus,
  KeyRound,
  Layers,
  Activity,
  Search as SearchIcon,
  RefreshCw,
  Settings2,
  ArrowLeftRight,
  Trash2,
  ShieldCheck,
  Loader2
} from 'lucide-vue-next'
import Avatar from '../components/Avatar.vue'
import AccountManageDrawer from '../components/AccountManageDrawer.vue'
import { useAccountStore, accountName } from '../stores/account.js'

const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const account = useAccountStore()

const showDrawer = ref(false)
const drawerId = ref('')
const query = ref('')
const typeFilter = ref('all') // all | protocol | direct
const healthFilter = ref('all') // all | ok | warn | bad | unknown
const rowBusy = ref('') // 單卡檢測中的 id
const checkingAll = ref(false)
const checkProgress = ref({ index: 0, total: 0 })

onMounted(() => {
  if (!account.loaded) account.refresh()
  else account.loadAccounts()
})

const counts = computed(() => account.counts)

const stats = computed(() => [
  { key: 'total', label: '帳號總數', value: counts.value.total, cls: 'text-ink' },
  { key: 'protocol', label: '協議號', value: counts.value.protocol, cls: 'text-accent' },
  { key: 'direct', label: '直登號', value: counts.value.direct, cls: 'text-ink2' },
  { key: 'ok', label: '正常', value: counts.value.ok, cls: 'text-ok' },
  { key: 'warn', label: '受限', value: counts.value.warn, cls: 'text-warn' },
  { key: 'bad', label: '異常', value: counts.value.bad, cls: 'text-bad' }
])

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return account.accounts.filter((a) => {
    if (typeFilter.value !== 'all' && (a.type || 'direct') !== typeFilter.value) return false
    if (healthFilter.value !== 'all' && (a.health?.state || 'unknown') !== healthFilter.value) return false
    if (q) {
      const hay = [accountName(a), a.user?.username, a.phone, a.label, a.note].filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
})

function healthMeta(a) {
  const st = a.health?.state || 'unknown'
  return (
    {
      ok: { cls: 'nc-pill--ok', text: '正常' },
      warn: { cls: 'nc-pill--warn', text: '受限' },
      bad: { cls: 'nc-pill--bad', text: '異常' },
      unknown: { cls: 'nc-pill--idle', text: '未檢測' }
    }[st] || { cls: 'nc-pill--idle', text: '未檢測' }
  )
}

// ---- 動作 ----
async function addDirect() {
  const r = await account.addAccount()
  if (r && r.busy) return message.warning(r.error || '目前無法新增')
  if (r && r.ok) router.push({ name: 'login', query: { add: '1' } })
}

function openManage(a) {
  drawerId.value = a.id
  showDrawer.value = true
}

async function quickHealth(a) {
  rowBusy.value = a.id
  const r = await account.healthCheck(a.id)
  rowBusy.value = ''
  if (r?.ok) message.success(`${accountName(a)} 檢測完成`)
  else message.warning(r?.error || '檢測未通過')
}

async function checkAll() {
  if (!account.accounts.length) return
  checkingAll.value = true
  checkProgress.value = { index: 0, total: account.accounts.length }
  const off = window.api.on('accounts:progress', (p) => {
    if (p.kind !== 'health') return
    checkProgress.value = { index: p.index + 1, total: p.total }
  })
  await account.healthCheckAll()
  off?.()
  checkingAll.value = false
  message.success('全部檢測完成')
}

async function switchTo(a) {
  if (a.active) return
  const r = await account.switchAccount(a.id)
  if (r && r.busy) message.warning(r.error || '目前無法切換')
  else if (r && !r.ok) message.error(r.error || '切換失敗')
  else message.success('已切換至 ' + accountName(a))
}

function removeAcc(a) {
  dialog.warning({
    title: '移除帳號',
    content: `確定移除「${accountName(a)}」?僅從本機清單移除,不會登出 Telegram 端;協議號可用 session 重新導入。`,
    positiveText: '移除',
    negativeText: '取消',
    onPositiveClick: async () => {
      const r = await account.removeAccount(a.id)
      if (r && r.busy) message.warning(r.error || '目前無法移除')
    }
  })
}
</script>

<template>
  <div class="acc-view">
    <!-- 標題 + 統計 -->
    <div class="px-5 pt-4">
      <div class="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 class="text-[19px] font-bold text-ink">帳號管理</h1>
          <p class="text-[12.5px] text-muted mt-0.5">協議號(session 導入) + 直登號(驗證碼)統一管理與養護</p>
        </div>
        <div class="flex items-center gap-2">
          <button class="nc-btn" :disabled="checkingAll || !account.accounts.length" @click="checkAll">
            <Loader2 v-if="checkingAll" :size="15" class="animate-spin" />
            <Activity v-else :size="15" />
            <template v-if="checkingAll">檢測 {{ checkProgress.index }}/{{ checkProgress.total }}</template>
            <template v-else>全部檢測</template>
          </button>
          <button class="nc-btn" @click="addDirect"><Plus :size="15" />登入新帳號</button>
          <button class="nc-btn nc-btn--primary" @click="router.push({ name: 'protocol-tool' })"><KeyRound :size="15" />協議號工具</button>
        </div>
      </div>

      <div class="grid grid-cols-3 sm:grid-cols-6 gap-2.5 mt-4">
        <div v-for="s in stats" :key="s.key" class="nc-stat">
          <div class="k">{{ s.label }}</div>
          <div class="v" :class="s.cls">{{ s.value }}</div>
        </div>
      </div>
    </div>

    <!-- 工具列 -->
    <div class="px-5 mt-4 flex items-center gap-2 flex-wrap">
      <div class="relative flex-1 min-w-[180px] max-w-xs">
        <SearchIcon :size="15" class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <input
          v-model="query"
          placeholder="搜尋名稱 / 用戶名 / 標籤"
          class="w-full h-8 pl-8 pr-3 rounded-lg bg-surface2 border border-line text-ink text-[13px] outline-none focus:border-accent"
        />
      </div>
      <div class="nc-seg">
        <button :class="{ on: typeFilter === 'all' }" @click="typeFilter = 'all'">全部</button>
        <button :class="{ on: typeFilter === 'protocol' }" @click="typeFilter = 'protocol'">協議</button>
        <button :class="{ on: typeFilter === 'direct' }" @click="typeFilter = 'direct'">直登</button>
      </div>
      <div class="nc-seg">
        <button :class="{ on: healthFilter === 'all' }" @click="healthFilter = 'all'">不限</button>
        <button :class="{ on: healthFilter === 'ok' }" @click="healthFilter = 'ok'">正常</button>
        <button :class="{ on: healthFilter === 'warn' }" @click="healthFilter = 'warn'">受限</button>
        <button :class="{ on: healthFilter === 'bad' }" @click="healthFilter = 'bad'">異常</button>
      </div>
    </div>

    <!-- 卡片格 -->
    <div class="flex-1 overflow-y-auto px-5 py-4">
      <div v-if="!filtered.length" class="h-full grid place-items-center text-center">
        <div>
          <div class="mx-auto w-16 h-16 rounded-2xl grid place-items-center mb-3" style="background: var(--accent-grad)">
            <Layers :size="30" class="text-white" />
          </div>
          <p class="text-ink2 mb-1">{{ account.accounts.length ? '沒有符合條件的帳號' : '還沒有帳號' }}</p>
          <p class="text-[12.5px] text-muted mb-4">導入協議號 session,或新增一個直登號開始管理</p>
          <div class="flex justify-center gap-2">
            <button class="nc-btn" @click="addDirect"><Plus :size="15" />登入新帳號</button>
            <button class="nc-btn nc-btn--primary" @click="router.push({ name: 'protocol-tool' })"><KeyRound :size="15" />協議號工具</button>
          </div>
        </div>
      </div>

      <div v-else class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(290px, 1fr))">
        <div
          v-for="a in filtered"
          :key="a.id"
          class="nc-card nc-hover p-3.5"
          :style="a.active ? 'border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); box-shadow: var(--shadow-card), inset 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent)' : ''"
        >
          <div class="flex items-start gap-3">
            <Avatar :title="accountName(a)" :url="a.active ? account.avatarUrl : ''" :has-photo="false" :size="44" />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="font-semibold text-ink truncate">{{ accountName(a) }}</span>
                <span v-if="a.active" class="nc-pill nc-pill--ok !h-[18px] !px-1.5">使用中</span>
              </div>
              <div class="text-[12px] text-muted truncate">
                {{ a.user?.username ? '@' + a.user.username : a.phone || a.user?.id || '—' }}
              </div>
              <div v-if="a.label" class="text-[11px] text-accent truncate mt-0.5">#{{ a.label }}</div>
            </div>
          </div>

          <div class="flex items-center gap-1.5 mt-3 flex-wrap">
            <span class="nc-pill" :class="a.type === 'protocol' ? 'nc-pill--accent' : 'nc-pill--idle'">
              {{ a.type === 'protocol' ? '協議號' : '直登號' }}
            </span>
            <span class="nc-pill" :class="healthMeta(a).cls"><span class="dot" />{{ healthMeta(a).text }}</span>
            <span v-if="a.health?.has2fa" class="nc-pill nc-pill--idle"><ShieldCheck :size="11" />2FA</span>
            <span v-if="a.health?.dc" class="nc-pill nc-pill--idle">DC{{ a.health.dc }}</span>
            <span v-if="a.health?.sessionsCount != null" class="nc-pill nc-pill--idle">{{ a.health.sessionsCount }} 裝置</span>
          </div>

          <div class="flex items-center gap-1.5 mt-3 pt-3 border-t border-line">
            <button class="nc-btn nc-btn--icon" title="健康檢測" :disabled="rowBusy === a.id" @click="quickHealth(a)">
              <RefreshCw :size="14" :class="{ 'animate-spin': rowBusy === a.id }" />
            </button>
            <button class="nc-btn flex-1" title="管理" @click="openManage(a)"><Settings2 :size="14" />管理</button>
            <button v-if="!a.active" class="nc-btn nc-btn--icon" title="切換為使用中" @click="switchTo(a)">
              <ArrowLeftRight :size="14" />
            </button>
            <button class="nc-btn nc-btn--icon nc-btn--danger" title="移除" @click="removeAcc(a)">
              <Trash2 :size="14" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <AccountManageDrawer v-model:show="showDrawer" :account-id="drawerId" />
  </div>
</template>

<style scoped>
.acc-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-0);
  min-height: 0;
}
</style>
