<script setup>
import { ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { Search } from 'lucide-vue-next'
import { useProxyStore } from '../stores/proxy.js'
import { useAccountStore } from '../stores/account.js'
import { useDialogsStore } from '../stores/dialogs.js'
import { useConversationStore } from '../stores/conversation.js'

const props = defineProps({ show: Boolean })
const emit = defineEmits(['update:show'])
const message = useMessage()
const proxy = useProxyStore()
const account = useAccountStore()
const dialogs = useDialogsStore()
const conversation = useConversationStore()

const blank = () => ({
  id: null,
  type: 'mtproto',
  ip: '',
  port: '',
  secret: '',
  username: '',
  password: '',
  socksType: 5,
  label: ''
})
const form = ref(blank())
const linkMode = ref(false)
const link = ref('')
const testing = ref(false)
const switching = ref(false)

// active 代理實際可達性:null=測試中/未測、-1=連不上、>=0=延遲(ms)。
// 「使用中」只代表「被選中」,不代表通;死掉的代理(主機關機)在此標紅「無法連線」。
const activePing = ref(null)
async function checkActive() {
  const a = proxy.active
  if (!a) {
    activePing.value = null
    return
  }
  activePing.value = null
  const r = await proxy.test(a.ip, a.port)
  if (proxy.active !== a) return // 測試期間已切換,丟棄舊結果
  activePing.value = r.ok ? r.ping : -1
}

watch(
  () => props.show,
  async (v) => {
    if (!v) return
    if (!proxy.loaded) await proxy.load()
    checkActive()
  }
)

// —— 連結 ↔ 表單 雙向同步 ——
function buildLink(f) {
  if (!f.ip || !f.port) return ''
  if (f.type === 'mtproto') {
    return `https://t.me/proxy?server=${f.ip}&port=${f.port}&secret=${f.secret || ''}`
  }
  let s = `https://t.me/socks?server=${f.ip}&port=${f.port}`
  if (f.username) s += `&user=${encodeURIComponent(f.username)}`
  if (f.password) s += `&pass=${encodeURIComponent(f.password)}`
  return s
}
function parseLinkLocal(s) {
  const m = String(s)
    .trim()
    .match(/(?:tg:\/\/|https?:\/\/t\.me\/)(proxy|socks)\?(.*)$/i)
  if (!m) return null
  const qs = new URLSearchParams(m[2])
  const ip = qs.get('server') || qs.get('ip')
  const port = qs.get('port')
  if (!ip || !port) return null
  if (m[1].toLowerCase() === 'proxy') {
    return { type: 'mtproto', ip, port, secret: qs.get('secret') || '' }
  }
  return {
    type: 'socks',
    ip,
    port,
    socksType: 5,
    username: qs.get('user') || '',
    password: qs.get('pass') || ''
  }
}

let syncing = false
watch(
  () => [form.value.ip, form.value.port, form.value.secret, form.value.type, form.value.username, form.value.password],
  () => {
    if (!linkMode.value || syncing) return
    syncing = true
    link.value = buildLink(form.value)
    syncing = false
  },
  { deep: true }
)
watch(link, (v) => {
  if (!linkMode.value || syncing) return
  const p = parseLinkLocal(v)
  if (!p) return
  syncing = true
  form.value = { ...form.value, ...p }
  syncing = false
})
watch(linkMode, (on) => {
  if (on) {
    syncing = true
    link.value = buildLink(form.value)
    syncing = false
  }
})

function newProxy() {
  form.value = blank()
  link.value = ''
}
function loadToForm(p) {
  form.value = { ...blank(), ...p }
  if (linkMode.value) link.value = buildLink(form.value)
}

async function save() {
  if (!form.value.ip || !form.value.port) return message.warning('請填 IP 與 Port')
  if (form.value.type === 'mtproto' && !form.value.secret)
    return message.warning('MTProto 需要密鑰 secret')
  const payload = { ...form.value }
  if (!payload.label) payload.label = `${payload.type.toUpperCase()} ${payload.ip}:${payload.port}`
  const r = await proxy.save(payload)
  form.value.id = r.id
  message.success('已儲存')
  if (r.fakeTls) {
    message.info(
      '此為 FakeTLS(secret 以 ee 開頭、偽裝 TLS)MTProto 代理,本程式已支援(實驗性)。若啟用後仍連不上,請改用 SOCKS5 代理。',
      { duration: 8000 }
    )
  }
}

/** 切換啟用(id=null 為直連),並刷新連線狀態 + 重載對話。 */
async function applyActive(id) {
  switching.value = true
  try {
    const r = await proxy.setActive(id)
    await account.refresh()
    if (r.ok && r.authorized) {
      message.success(id ? '已切換代理並重新連線' : '已停用代理(直連)')
      dialogs.load(true)
      if (conversation.current) conversation.reload()
    } else if (r.ok && !r.authorized) {
      message.warning('已連線但尚未授權,請重新登入')
    } else {
      message.error('連線失敗:' + (r.error || '代理無法使用'))
    }
  } catch (e) {
    message.error('切換代理時發生錯誤:' + (e.message || e))
  } finally {
    switching.value = false
    checkActive()
  }
}

async function useIt(p) {
  if (!p.id) {
    const r = await proxy.save({ ...p })
    p.id = r.id
  }
  await applyActive(p.id)
}
function disableProxy() {
  applyActive(null)
}
async function removeProxy(p) {
  await proxy.remove(p.id)
  if (form.value.id === p.id) newProxy()
}

async function testForm() {
  if (!form.value.ip || !form.value.port) return message.warning('請填 IP 與 Port')
  testing.value = true
  const r = await proxy.test(form.value.ip, form.value.port)
  testing.value = false
  message[r.ok ? 'success' : 'error'](r.ok ? `連線正常 ${r.ping}ms` : '無法連線')
}
async function autodetect() {
  const r = await proxy.autodetect()
  if (!r.found.length) return message.info('未偵測到本機常見代理埠')
  const f = r.found[0]
  form.value = { ...blank(), ...f }
  if (linkMode.value) link.value = buildLink(form.value)
  message.success(`偵測到 ${f.label} (${f.ping}ms),已填入表單`)
}
</script>

<template>
  <n-modal
    :show="show"
    @update:show="(v) => emit('update:show', v)"
    preset="card"
    title="設置代理"
    style="width: 760px"
    :bordered="false"
  >
    <div class="proxy-body">
      <!-- 已存代理:點整張即切換 -->
      <div class="saved">
        <div class="saved-head">
          <span>已儲存代理</span>
          <n-button size="tiny" @click="newProxy">新增</n-button>
        </div>

        <div class="pitem" :class="{ active: !proxy.activeId }" @click="disableProxy">
          <div class="ptop">
            <span class="pmain">不啟用代理</span>
            <span v-if="!proxy.activeId" class="curr">● 使用中</span>
            <span v-else class="enable">啟用</span>
          </div>
          <div class="psub">保持直連網路</div>
        </div>

        <div
          v-for="p in proxy.proxies"
          :key="p.id"
          class="pitem"
          :class="{ active: proxy.activeId === p.id }"
          @click="useIt(p)"
        >
          <div class="ptop">
            <span class="tag">{{ p.type === 'mtproto' ? 'MTProto' : 'SOCKS' }}</span>
            <span v-if="p.fakeTls" class="tag tls" title="FakeTLS(ee)偽裝 TLS 代理 — 本程式已支援(實驗性)">FakeTLS</span>
            <template v-if="proxy.activeId === p.id">
              <span v-if="activePing === -1" class="curr dead" title="此代理已設為使用中,但目前連不上(主機可能關機或位址失效)">● 無法連線</span>
              <span v-else-if="activePing === null" class="curr">● 使用中·測試中…</span>
              <span v-else class="curr">● 使用中·{{ activePing }}ms</span>
            </template>
            <span v-else class="enable">啟用</span>
          </div>
          <div class="pmain">{{ p.ip }}:{{ p.port }}</div>
          <div class="pbtns">
            <n-button size="tiny" @click.stop="loadToForm(p)">載入表單</n-button>
            <n-button size="tiny" type="error" ghost @click.stop="removeProxy(p)">刪除</n-button>
          </div>
        </div>
      </div>

      <!-- 編輯代理 -->
      <div class="editor">
        <div class="ed-head">編輯代理 <span v-if="switching" class="sw">切換中…</span></div>

        <n-button-group class="seg">
          <n-button :type="form.type === 'socks' ? 'primary' : 'default'" @click="form.type = 'socks'">
            SOCKS
          </n-button>
          <n-button :type="form.type === 'mtproto' ? 'primary' : 'default'" @click="form.type = 'mtproto'">
            MTProto
          </n-button>
        </n-button-group>

        <!-- 連結方式(與表單雙向同步) -->
        <div v-if="linkMode" class="linkbox">
          <n-input
            v-model:value="link"
            type="textarea"
            :rows="2"
            placeholder="貼上 tg://proxy?... 或 https://t.me/proxy?...(與下方表單即時同步)"
          />
        </div>

        <n-form label-placement="top" size="small">
          <n-form-item label="IP 位址">
            <n-input v-model:value="form.ip" placeholder="例如 1.2.3.4 或 proxy.example.com" />
          </n-form-item>
          <n-form-item label="埠 Port">
            <n-input v-model:value="form.port" placeholder="443" />
          </n-form-item>
          <n-form-item v-if="form.type === 'mtproto'" label="密鑰 Secret">
            <n-input v-model:value="form.secret" placeholder="ee… / dd… / hex 或 base64" />
          </n-form-item>
          <template v-else>
            <n-form-item label="使用者(選填)">
              <n-input v-model:value="form.username" />
            </n-form-item>
            <n-form-item label="密碼(選填)">
              <n-input v-model:value="form.password" type="password" show-password-on="click" />
            </n-form-item>
          </template>
        </n-form>

        <n-checkbox v-model:checked="linkMode" class="linkchk">使用連結方式輸入</n-checkbox>

        <div class="ed-foot">
          <n-button size="small" tertiary :loading="testing" @click="testForm"><Search :size="14" style="margin-right:4px" /> 測試連線</n-button>
          <n-button size="small" tertiary @click="autodetect">偵測本機代理</n-button>
          <div class="grow" />
          <n-button size="small" @click="emit('update:show', false)">取消</n-button>
          <n-button size="small" type="primary" @click="save">儲存</n-button>
        </div>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.proxy-body {
  display: flex;
  gap: 16px;
}
.saved {
  width: 280px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 460px;
  overflow-y: auto;
}
.saved-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: var(--text-1);
  font-size: 12px;
}
.pitem {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px;
  cursor: pointer;
  background: var(--bg-2);
  transition: border-color 0.12s, background 0.12s;
}
.pitem:hover {
  border-color: var(--accent);
}
.pitem.active {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
  background: rgba(91, 108, 255, 0.08);
}
.ptop {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 4px;
}
.tag {
  font-size: 10px;
  background: var(--bg-3);
  padding: 1px 6px;
  border-radius: 5px;
}
.tag.tls {
  background: rgba(91, 108, 255, 0.18);
  color: var(--accent);
}
.curr {
  font-size: 11px;
  color: var(--green);
  margin-left: auto;
}
.curr.dead {
  color: var(--red);
}
.enable {
  font-size: 11px;
  color: var(--accent);
  margin-left: auto;
}
.pmain {
  font-weight: 600;
}
.psub {
  font-size: 11px;
  color: var(--text-2);
}
.pbtns {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.editor {
  flex: 1;
  min-width: 0;
}
.ed-head {
  font-size: 13px;
  color: var(--text-1);
  margin-bottom: 10px;
}
.ed-head .sw {
  color: var(--accent);
  font-size: 12px;
  margin-left: 6px;
}
.seg {
  margin-bottom: 12px;
}
.linkbox {
  margin-bottom: 10px;
}
.linkchk {
  margin-top: 4px;
}
.ed-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
}
.grow {
  flex: 1;
}
</style>
