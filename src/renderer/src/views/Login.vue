<script setup>
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useMessage } from 'naive-ui'
import QRCode from 'qrcode'
import { useAccountStore } from '../stores/account.js'
import { useProxyStore } from '../stores/proxy.js'
import ProxyDialog from '../components/ProxyDialog.vue'
import PhoneInput from '../components/PhoneInput.vue'

const router = useRouter()
const route = useRoute()
const message = useMessage()
const account = useAccountStore()
const proxy = useProxyStore()

// 新增帳號模式(從標題列「➕ 新增帳號」進來):已建立空 placeholder 帳號為 active,登入會寫進它
const isAddMode = computed(() => route.query.add === '1')
async function backFromAdd() {
  await account.cancelAdd()
  router.push({ name: 'chat' })
}

const mode = ref('qr') // 'qr' | 'phone'
const loading = ref(false)
const showProxy = ref(false)
const showAdvanced = ref(false)
const reconnecting = ref(false)
const forceNewLogin = ref(false)
// 本機仍有 session = 只是連不上(代理失效),不是登出 → 顯示「重新連線」面板,不自動掃碼。
// 自動掃碼會清掉現有登入,是「代理死掉害你被迫重登」的元凶。新增帳號(add 模式)為空 placeholder,hasSession=false 照常登入。
const showLogin = computed(() => !account.hasSession || forceNewLogin.value)

// QR 狀態
const qrDataUrl = ref('')
const qrNeedPassword = ref(false)
const qrPassword = ref('')
const qrError = ref('')
let qrStarted = false
let offToken = null
let offNeedPwd = null

// 手機流程
const phoneStep = ref('phone') // phone | code | password
const form = ref({ apiId: '', apiHash: '', phone: '', code: '', password: '' })

const activeProxy = computed(() => proxy.active)

// 代理實際可達性:'idle' | 'testing' | 'ok' | 'fail'。只看設定會讓死掉的代理一直顯示綠燈,
// 這裡實際 TCP 測一次(proxy.test),代理關機/沒續費就標紅「無法連線」。
const proxyStatus = ref('idle')
const proxyPing = ref(-1)
async function checkProxy() {
  const a = activeProxy.value
  if (!a) {
    proxyStatus.value = 'idle'
    return
  }
  proxyStatus.value = 'testing'
  const r = await proxy.test(a.ip, a.port)
  // 測試期間可能已切換代理,避免舊結果覆蓋
  if (proxy.active !== a) return
  proxyStatus.value = r.ok ? 'ok' : 'fail'
  proxyPing.value = r.ok ? r.ping : -1
}
// 關掉設定代理對話框後重測;若已透過切換代理/直連重新連上,直接進聊天
watch(showProxy, async (v) => {
  if (v) return
  await checkProxy()
  await account.refresh()
  if (account.authorized) router.push({ name: 'chat' })
})

onMounted(async () => {
  if (!proxy.loaded) await proxy.load()
  checkProxy()
  await account.refresh() // 取得 hasSession / authorized
  if (account.authorized) return router.push({ name: 'chat' })
  const c = await window.api.auth.getCredentials()
  form.value.apiId = c.apiId || ''
  form.value.apiHash = c.apiHash || ''
  if (showLogin.value) startQr() // 只有真的要登入(無 session)才自動掃碼
})

// 有 session 但連不上:用現有 session 重連,免重新掃碼
async function reconnect() {
  reconnecting.value = true
  try {
    const st = await account.autoConnect()
    if (st.authorized) {
      message.success('已重新連線,登入資料仍有效')
      return router.push({ name: 'chat' })
    }
    message.error('仍連不上,請改用其他代理或直連後再試')
  } catch (e) {
    message.error('重新連線失敗:' + (e.message || e))
  } finally {
    reconnecting.value = false
  }
}
// 明確改用新帳號登入(此時才允許掃碼、成功後覆蓋現有登入)
function startNewLogin() {
  forceNewLogin.value = true
  startQr()
}

onUnmounted(() => {
  offToken?.()
  offNeedPwd?.()
})

// ---------- 掃碼登入 ----------
async function startQr() {
  if (qrStarted) return
  qrStarted = true
  qrError.value = ''
  qrDataUrl.value = ''
  qrNeedPassword.value = false

  offToken = window.api.on('auth:qrToken', async ({ url }) => {
    qrDataUrl.value = await QRCode.toDataURL(url, {
      width: 220,
      margin: 1,
      color: { dark: '#0b1220', light: '#ffffff' }
    })
  })
  offNeedPwd = window.api.on('auth:qrNeedPassword', () => {
    qrNeedPassword.value = true
  })

  const r = await window.api.auth.qrStart()
  qrStarted = false
  if (r.ok) return finish()
  qrError.value = r.error || '掃碼登入失敗'
}

async function submitQrPassword() {
  if (!qrPassword.value) return message.warning('請輸入兩步驗證密碼')
  await window.api.auth.qrSubmitPassword(qrPassword.value)
}

function retryQr() {
  offToken?.()
  offNeedPwd?.()
  startQr()
}

// ---------- 手機驗證碼 ----------
async function sendCode() {
  if (!form.value.phone) return message.warning('請輸入手機號(含國碼,如 +886912345678)')
  loading.value = true
  const r = await window.api.auth.sendCode(form.value.phone.trim())
  loading.value = false
  if (r.ok) {
    message.success('驗證碼已寄出' + (r.isCodeViaApp ? '(請看 Telegram App)' : '(簡訊)'))
    phoneStep.value = 'code'
  } else {
    message.error('寄送失敗:' + r.error)
  }
}

async function signIn() {
  if (!form.value.code) return message.warning('請輸入驗證碼')
  loading.value = true
  const r = await window.api.auth.signIn(form.value.code.trim())
  loading.value = false
  if (r.ok) return finish()
  if (r.needPassword) {
    message.info('此帳號開啟了兩步驗證,請輸入密碼')
    phoneStep.value = 'password'
    return
  }
  message.error('登入失敗:' + r.error)
}

async function checkPassword() {
  if (!form.value.password) return message.warning('請輸入兩步驗證密碼')
  loading.value = true
  const r = await window.api.auth.checkPassword(form.value.password)
  loading.value = false
  if (r.ok) return finish()
  message.error('密碼錯誤:' + r.error)
}

// ---------- 進階憑證 ----------
async function saveCredentials() {
  await window.api.auth.setCredentials({
    apiId: form.value.apiId || null,
    apiHash: form.value.apiHash || ''
  })
  message.success(
    form.value.apiId ? '已套用自訂 api 憑證,重新嘗試登入' : '已清除,使用內建預設憑證'
  )
  // 套用後重啟掃碼
  if (mode.value === 'qr') retryQr()
}

async function finish() {
  // 剛登入的可能是另一個帳號(新增帳號 / 覆蓋登入)→ 舊帳號的對話列表與已開對話全部作廢。
  // reload:false = 只清空,導頁後由 DialogList 掛載時自己去載,不必卡在這裡等網路。
  await account.applyAccountChange({ reload: false })
  message.success('登入成功')
  router.push({ name: 'chat' })
}

function switchMode(m) {
  mode.value = m
  if (m === 'qr') startQr()
}
</script>

<template>
  <div class="login-wrap">
    <div class="card">
      <div class="head">
        <div class="logo">TG</div>
        <div style="flex: 1">
          <div class="title">{{ isAddMode ? '新增帳號' : 'Telegram 資源管理助手' }}</div>
          <div class="subtitle">
            {{ isAddMode ? '登入另一個 Telegram 帳號(現有帳號保留)' : '本機登入,資料只存在你的電腦' }}
          </div>
        </div>
        <a v-if="isAddMode" class="back" @click="backFromAdd">← 返回</a>
      </div>

      <!-- 代理狀態列 -->
      <div class="proxy-row" @click="showProxy = true">
        <span class="dot" :class="{ on: proxyStatus === 'ok', bad: proxyStatus === 'fail' }" />
        <template v-if="activeProxy">
          <span>使用代理 {{ activeProxy.ip }}:{{ activeProxy.port }}</span>
          <span v-if="proxyStatus === 'testing'" class="muted"> · 測試中…</span>
          <span v-else-if="proxyStatus === 'fail'" class="bad"> · 無法連線,請改代理或直連</span>
          <span v-else-if="proxyStatus === 'ok'" class="okc"> · {{ proxyPing }}ms</span>
        </template>
        <span v-else class="muted">未設代理(直連)— 連不上請先設定代理</span>
        <span class="link">設定代理</span>
      </div>

      <!-- 有 session 只是連不上(代理失效)= 不是登出 → 重新連線,免重掃碼 -->
      <div v-if="!showLogin" class="reconnect">
        <div class="rc-title">你仍在登入狀態,只是連不上</div>
        <p class="rc-desc">
          本機還留著登入資料,不需要重新掃碼。代理主機失效時常會這樣 —— 重試連線,或改用其他代理 / 直連即可恢復。
        </p>
        <n-button type="primary" block :loading="reconnecting" @click="reconnect">重試連線</n-button>
        <n-button block class="rc-proxy" @click="showProxy = true">設定代理 / 改直連</n-button>
        <a class="rc-relogin" @click="startNewLogin">改用其他帳號重新登入(會覆蓋目前登入)</a>
      </div>

      <!-- 登入方式切換 -->
      <div v-if="showLogin" class="seg">
        <button :class="{ on: mode === 'qr' }" @click="switchMode('qr')">掃碼登入</button>
        <button :class="{ on: mode === 'phone' }" @click="switchMode('phone')">手機驗證碼</button>
      </div>

      <!-- 掃碼登入 -->
      <div v-if="showLogin && mode === 'qr'" class="qr-pane">
        <template v-if="!qrNeedPassword">
          <div class="qr-box">
            <img v-if="qrDataUrl" :src="qrDataUrl" alt="QR" />
            <n-spin v-else size="medium" />
          </div>
          <ol class="qr-tip">
            <li>手機開 Telegram → <b>設定</b></li>
            <li>→ <b>裝置 / Devices</b> → <b>連接桌面裝置</b></li>
            <li>掃描上方 QR Code 即可登入</li>
          </ol>
          <div v-if="qrError" class="err">
            {{ qrError }} <a @click="retryQr">重試</a>
          </div>
        </template>
        <template v-else>
          <p class="muted">此帳號開啟了兩步驗證,請輸入密碼完成登入。</p>
          <n-input
            v-model:value="qrPassword"
            type="password"
            show-password-on="click"
            placeholder="2FA 密碼"
            @keyup.enter="submitQrPassword"
          />
          <n-button type="primary" block style="margin-top: 12px" @click="submitQrPassword"
            >完成登入</n-button
          >
        </template>
      </div>

      <!-- 手機驗證碼 -->
      <div v-else-if="showLogin && mode === 'phone'" class="phone-pane">
        <template v-if="phoneStep === 'phone'">
          <n-form label-placement="top">
            <n-form-item label="手機號碼">
              <PhoneInput v-model="form.phone" />
            </n-form-item>
          </n-form>
          <p class="phone-hint">選國家(可直接打數字,如「88」定位台灣 +886),再輸入手機號碼。</p>
          <n-button type="primary" block :loading="loading" @click="sendCode">取得驗證碼</n-button>
        </template>
        <template v-else-if="phoneStep === 'code'">
          <n-form label-placement="top">
            <n-form-item label="登入驗證碼">
              <n-input v-model:value="form.code" placeholder="Telegram 傳來的 5 位數字" />
            </n-form-item>
          </n-form>
          <div class="row">
            <n-button quaternary @click="phoneStep = 'phone'">上一步</n-button>
            <n-button type="primary" :loading="loading" @click="signIn">登入</n-button>
          </div>
        </template>
        <template v-else>
          <n-form label-placement="top">
            <n-form-item label="兩步驗證密碼">
              <n-input
                v-model:value="form.password"
                type="password"
                show-password-on="click"
                placeholder="你的 2FA 密碼"
              />
            </n-form-item>
          </n-form>
          <div class="row">
            <n-button quaternary @click="phoneStep = 'code'">上一步</n-button>
            <n-button type="primary" :loading="loading" @click="checkPassword">完成登入</n-button>
          </div>
        </template>
      </div>

      <!-- 進階:自訂 api 憑證 -->
      <div v-if="showLogin" class="adv">
        <a class="adv-toggle" @click="showAdvanced = !showAdvanced">
          {{ showAdvanced ? '▾' : '▸' }} 進階:自訂 api_id / api_hash(預設用內建,免申請)
        </a>
        <div v-if="showAdvanced" class="adv-body">
          <n-input v-model:value="form.apiId" placeholder="api_id(留空=內建預設)" />
          <n-input v-model:value="form.apiHash" placeholder="api_hash(留空=內建預設)" />
          <n-button size="small" @click="saveCredentials">套用</n-button>
          <p class="hint">到 my.telegram.org → API development tools 申請。只存本機。</p>
        </div>
      </div>
    </div>

    <ProxyDialog v-model:show="showProxy" />
  </div>
</template>

<style scoped>
.login-wrap {
  height: 100vh;
  display: grid;
  place-items: center;
  background: radial-gradient(1200px 600px at 50% -10%, #15224080, transparent), var(--bg-0);
}
.card {
  width: 430px;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 26px;
  box-shadow: var(--shadow-pop);
}
.head {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
}
.logo {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  display: grid;
  place-items: center;
  font-weight: 700;
}
.title {
  font-size: 18px;
  font-weight: 700;
}
.subtitle {
  font-size: 12px;
  color: var(--text-2);
}
.back {
  color: var(--accent);
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
}
.proxy-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 8px 10px;
  margin-bottom: 14px;
  cursor: pointer;
}
.proxy-row .link {
  margin-left: auto;
  color: var(--accent);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-2);
}
.dot.on {
  background: var(--green);
}
.dot.bad {
  background: var(--red);
}
.bad {
  color: var(--red);
}
.okc {
  color: var(--green);
}
.muted {
  color: var(--text-2);
}
.reconnect {
  text-align: center;
  padding: 4px 0 2px;
}
.rc-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 6px;
}
.rc-desc {
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.6;
  margin: 0 0 16px;
}
.rc-proxy {
  margin-top: 10px;
}
.rc-relogin {
  display: inline-block;
  margin-top: 16px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
}
.rc-relogin:hover {
  color: var(--accent);
}
.seg {
  display: flex;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 3px;
  margin-bottom: 18px;
}
.seg button {
  flex: 1;
  height: 32px;
  border: none;
  background: transparent;
  color: var(--text-1);
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}
.seg button.on {
  background: var(--accent-grad);
  color: #fff;
}
.qr-pane {
  text-align: center;
}
.qr-box {
  width: 236px;
  height: 236px;
  margin: 0 auto 14px;
  background: #fff;
  border-radius: 12px;
  display: grid;
  place-items: center;
  overflow: hidden;
}
.qr-box img {
  width: 220px;
  height: 220px;
}
.qr-tip {
  text-align: left;
  font-size: 12.5px;
  color: var(--text-1);
  line-height: 1.7;
  margin: 0 auto;
  padding-left: 20px;
  max-width: 300px;
}
.err {
  color: var(--red);
  font-size: 12px;
  margin-top: 10px;
}
.err a,
.adv-toggle {
  color: var(--accent);
  cursor: pointer;
}
.row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}
.phone-hint {
  font-size: 11.5px;
  color: var(--text-2);
  margin: -4px 0 14px;
  line-height: 1.5;
}
.adv {
  margin-top: 18px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.adv-toggle {
  font-size: 12px;
}
.adv-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}
.hint {
  font-size: 11px;
  color: var(--text-2);
  margin: 2px 0 0;
}
</style>
