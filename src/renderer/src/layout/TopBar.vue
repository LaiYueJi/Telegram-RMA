<script setup>
import { ref, computed, h, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage, useDialog } from 'naive-ui'
import { Settings, Shield, Check, X, Plus, LogOut, Moon, Sun } from 'lucide-vue-next'
import { useAccountStore, accountName } from '../stores/account.js'
import { useProxyStore } from '../stores/proxy.js'
import { useSettingsStore } from '../stores/settings.js'
import ProxyDialog from '../components/ProxyDialog.vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import WindowControls from '../components/WindowControls.vue'
import NotificationBell from '../components/NotificationBell.vue'
import Avatar from '../components/Avatar.vue'

const account = useAccountStore()
const proxy = useProxyStore()
const settings = useSettingsStore()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()

const showProxy = ref(false)
const showSettings = ref(false)
const appVersion = ref('')

const isLight = computed(() => settings.preferences?.theme === 'light')
function toggleTheme() {
  settings.savePreferences({ theme: isLight.value ? 'dark' : 'light' })
}
const ping = ref(null)
const speed = ref({ up: 0, down: 0 })

const glowClass = computed(() => {
  const style = settings.preferences?.glowStyle || 'breathe'
  return style === 'none' ? '' : 'glow-' + style
})

const accountLabel = computed(() => (account.authorized ? account.displayName : '未登入'))
const accountSub = computed(() =>
  account.switching ? '切換中…' : account.authorized ? '已連線' : '未連線'
)

const activeProxy = computed(() => proxy.active)
const proxyLabel = computed(() =>
  activeProxy.value ? `${activeProxy.value.ip}:${activeProxy.value.port}` : '未啟用代理'
)

let pingTimer = null
async function refreshPing() {
  if (!activeProxy.value) {
    ping.value = null
    return
  }
  // active 代理已連線:量真正的 MTProto 往返(與官方客戶端同定義)。
  // 失敗(尚未連上)再退回 TCP 握手測延遲(只到代理門口,僅供參考)。
  const r = await proxy.ping()
  if (r.ok) {
    ping.value = r.ping
    return
  }
  const t = await proxy.test(activeProxy.value.ip, activeProxy.value.port)
  ping.value = t.ok ? t.ping : -1
}

function fmtSpeed(n) {
  if (n < 1024) return n + ' B/s'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB/s'
  return (n / 1024 / 1024).toFixed(1) + ' MB/s'
}

let offSpeed
onMounted(async () => {
  offSpeed = window.api.on('net:speed', (s) => (speed.value = s))
  refreshPing()
  pingTimer = setInterval(refreshPing, 12000)
  try {
    const info = await window.api.settings.appInfo()
    appVersion.value = info?.version || ''
  } catch {
    /* ignore */
  }
})
onUnmounted(() => {
  clearInterval(pingTimer)
  offSpeed?.()
})

function renderAccountLabel(a) {
  return h('div', { style: 'display:flex;align-items:center;gap:8px;min-width:158px' }, [
    h('div', { style: 'flex:1;line-height:1.2;overflow:hidden' }, [
      h(
        'div',
        { style: 'font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' },
        accountName(a)
      ),
      h('div', { style: 'font-size:10.5px;color:var(--text-2)' }, a.active ? '使用中' : '點擊切換')
    ]),
    a.active
      ? h(Check, { size: 14, style: { color: 'var(--green)' } })
      : h(
          X,
          {
            size: 14,
            style: { color: 'var(--text-2)', cursor: 'pointer', padding: '0 4px' },
            title: '移除帳號',
            onClick: (e) => {
              e.stopPropagation()
              onRemove(a)
            }
          }
        )
  ])
}

const dropdownOptions = computed(() => {
  const opts = account.accounts.map((a) => ({
    key: 'sw:' + a.id,
    icon: () =>
      h(Avatar, {
        title: accountName(a),
        url: a.active ? account.avatarUrl : '',
        hasPhoto: false,
        size: 26
      }),
    label: () => renderAccountLabel(a)
  }))
  if (opts.length) opts.push({ type: 'divider', key: 'd1' })
  opts.push({ label: '新增帳號', key: 'add', icon: () => h(Plus, { size: 18 }) })
  if (account.authorized) opts.push({ label: '登出目前帳號', key: 'logout', icon: () => h(LogOut, { size: 18 }) })
  return opts
})

async function onAccountSelect(key) {
  if (key === 'add') return onAddAccount()
  if (key === 'logout') return onLogoutCurrent()
  if (key.startsWith('sw:')) {
    const id = key.slice(3)
    if (id === account.activeAccountId) return
    const r = await account.switchAccount(id)
    if (r && r.busy) message.warning(r.error || '目前無法切換')
    else if (r && !r.ok) message.error(r.error || '切換失敗')
  }
}

async function onAddAccount() {
  const r = await account.addAccount()
  if (r && r.busy) return message.warning(r.error || '目前無法新增')
  if (r && r.ok) router.push({ name: 'login', query: { add: '1' } })
}

function onLogoutCurrent() {
  const id = account.activeAccountId
  if (!id) return
  dialog.warning({
    title: '登出目前帳號',
    content: '將從 Telegram 端登出此帳號並從清單移除。確定?',
    positiveText: '登出',
    negativeText: '取消',
    onPositiveClick: async () => {
      const r = await account.removeAccount(id)
      if (r && r.busy) return message.warning(r.error || '目前無法登出')
      if (!account.authorized) router.push({ name: 'login' })
    }
  })
}

function onRemove(a) {
  dialog.warning({
    title: '移除帳號',
    content: `確定移除「${accountName(a)}」?僅從本機移除,不會登出 Telegram 端;需要時可重新登入加回。`,
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
  <header class="topbar drag">
    <div class="brand no-drag">
      <div class="logo">TG</div>
      <span class="name">Telegram 資源管理助手</span>
      <span v-if="appVersion" class="ver">v{{ appVersion }}</span>
    </div>

    <n-dropdown trigger="click" :options="dropdownOptions" @select="onAccountSelect" placement="bottom-start">
      <div class="chip no-drag" :class="[glowClass, { live: account.authorized }]">
        <Avatar v-if="account.authorized" :title="account.displayName" :url="account.avatarUrl" :has-photo="false" :size="24" />
        <span v-else class="dot" />
        <div class="chip-text">
          <div class="chip-main">{{ accountLabel }}</div>
          <div class="chip-sub">{{ accountSub }}</div>
        </div>
        <span class="caret">▾</span>
      </div>
    </n-dropdown>

    <div class="chip proxy no-drag" :class="[glowClass, { live: activeProxy && ping >= 0, danger: activeProxy && ping < 0 }]" @click="showProxy = true">
      <Shield class="ic" :size="14" />
      <div class="chip-text">
        <div class="chip-main">{{ proxyLabel }}</div>
        <div class="chip-sub">
          <template v-if="activeProxy">
            <span v-if="ping === null" class="muted">測試中…</span>
            <span v-else-if="ping < 0" class="bad">無法連線</span>
            <span v-else class="ok">代理已啟用 · {{ ping }}ms</span>
          </template>
          <span v-else class="muted">直連網路</span>
        </div>
      </div>
    </div>

    <div class="chip net no-drag" :class="[glowClass, { live: account.connected }]">
      <span class="dot" :class="[glowClass, { on: account.connected }]" />
      <div class="chip-text">
        <div class="chip-main">{{ account.connected ? '網路正常' : '未連線' }}</div>
        <div class="chip-sub">↑ {{ fmtSpeed(speed.up) }} &nbsp; ↓ {{ fmtSpeed(speed.down) }}</div>
      </div>
    </div>

    <div class="spacer drag" />

    <div class="actions no-drag">
      <NotificationBell placement="bottom-end" />
      <button class="iconbtn theme-btn" :title="isLight ? '切換到深色' : '切換到淺色'" @click="toggleTheme">
        <component :is="isLight ? Sun : Moon" class="icon-theme" :class="{ light: isLight }" :size="17" />
      </button>
      <button class="iconbtn" title="設定" @click="showSettings = true"><Settings class="icon-settings" :size="17" /></button>
    </div>

    <WindowControls class="no-drag" />

    <ProxyDialog v-model:show="showProxy" />
    <SettingsDialog v-model:show="showSettings" />
  </header>
</template>

<style scoped>
.topbar {
  height: 48px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 4px 0 12px;
  /* 立體感:上緣高光 + 微漸層 + 下方投影,讓標題列像浮在內容上方 */
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg-1) 90%, #fff 10%), var(--bg-1) 70%);
  border-bottom: 1px solid var(--border);
  box-shadow: 0 8px 22px -10px rgba(0, 0, 0, 0.6), inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent);
  position: relative;
  z-index: 10;
  user-select: none;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-right: 6px;
}
.logo {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 12px;
}
.brand .name { font-weight: 600; }
.brand .ver {
  font-size: 11px;
  color: var(--text-2);
  background: var(--bg-3);
  padding: 1px 6px;
  border-radius: 6px;
}
.chip {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 10px;
  /* 立體:上緣高光漸層 + 內外投影,做出實體按鈕的浮起感 */
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg-2) 88%, #fff 12%), var(--bg-2));
  border: 1px solid var(--border);
  border-radius: 9px;
  cursor: pointer;
  max-width: 230px;
  position: relative;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35), inset 0 1px 0 color-mix(in srgb, #fff 7%, transparent);
  transition: transform 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
}
.chip:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
  box-shadow: 0 5px 14px -6px rgba(0, 0, 0, 0.55), inset 0 1px 0 color-mix(in srgb, #fff 9%, transparent);
}
.chip.net { cursor: default; }

/* 霓虹呼吸:綠色狀態燈用亮綠色霓虹 */
.chip.live {
  --glow: var(--neon);
  border-color: color-mix(in srgb, var(--glow) 70%, var(--border));
  box-shadow: 0 0 10px -1px color-mix(in srgb, var(--glow) 45%, transparent),
    inset 0 0 7px color-mix(in srgb, var(--glow) 12%, transparent);
}
.chip.proxy.live { --glow: var(--accent); }
.chip.net.live {}
.chip.danger {
  --glow: var(--red);
  border-color: color-mix(in srgb, var(--glow) 60%, var(--border));
  animation: chip-breathe 1.5s ease-in-out infinite;
}
.chip.live.glow-breathe { animation: chip-breathe 2.8s ease-in-out infinite; }

@keyframes chip-breathe {
  0%, 100% {
    border-color: color-mix(in srgb, var(--glow) 45%, var(--border));
    box-shadow: 0 0 7px -1px color-mix(in srgb, var(--glow) 30%, transparent), inset 0 0 5px color-mix(in srgb, var(--glow) 10%, transparent);
  }
  50% {
    border-color: color-mix(in srgb, var(--glow) 100%, transparent);
    box-shadow: 0 0 18px 2px color-mix(in srgb, var(--glow) 60%, transparent), inset 0 0 11px color-mix(in srgb, var(--glow) 26%, transparent);
  }
}

.dot.on.glow-breathe { animation: dot-breathe 2.4s ease-in-out infinite; }
@keyframes dot-breathe {
  0%, 100% { box-shadow: 0 0 5px var(--neon), 0 0 9px color-mix(in srgb, var(--neon) 40%, transparent); }
  50% { box-shadow: 0 0 11px 1px var(--neon), 0 0 20px color-mix(in srgb, var(--neon) 60%, transparent); }
}

@media (prefers-reduced-motion: reduce) {
  .chip.live, .chip.danger, .dot.on { animation: none; }
}

.chip-text { line-height: 1.15; overflow: hidden; }
.chip-main { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip-sub { font-size: 10.5px; color: var(--text-2); white-space: nowrap; }
.chip-sub .ok { color: var(--green); }
.chip-sub .bad { color: var(--red); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-2); flex: none; }
.dot.on { background: var(--neon); box-shadow: 0 0 6px var(--neon), 0 0 12px color-mix(in srgb, var(--neon) 50%, transparent); }
.ic { /* lucide shield svg */ }
.caret { color: var(--text-2); font-size: 10px; }
.spacer { flex: 1; }
.actions { display: flex; gap: 2px; }
.iconbtn {
  width: 34px; height: 34px;
  border: none; background: transparent; color: var(--text-1);
  border-radius: 8px; cursor: pointer;
  display: grid; place-items: center;
  transition: transform 0.2s ease, background 0.15s;
  position: relative;
}
.iconbtn:hover { background: var(--bg-2); }
.icon-settings { transition: transform 0.3s ease; }
.iconbtn:hover .icon-settings { transform: rotate(45deg); }

/* 主題切換鈕:月亮(深色)/ 太陽(淺色)皆靜止向右轉 45 度;hover 再向右 15 度(到 60 度) */
.icon-theme {
  color: #8b96ff;
  transform: rotate(45deg);
  transition: transform 0.35s ease, color 0.2s ease;
}
.icon-theme.light { color: #f5a623; }
.theme-btn:hover .icon-theme { transform: rotate(60deg); }

.muted { color: var(--text-2); }
</style>
