<script setup>
import { ref, computed, watch } from 'vue'
import { useMessage, useDialog } from 'naive-ui'
import {
  Activity,
  UserPen,
  ShieldCheck,
  MonitorSmartphone,
  KeyRound,
  Copy,
  RefreshCw,
  Image as ImageIcon,
  Check
} from 'lucide-vue-next'
import Avatar from './Avatar.vue'
import { useAccountStore, accountName } from '../stores/account.js'

const props = defineProps({ show: Boolean, accountId: String })
const emit = defineEmits(['update:show'])

const message = useMessage()
const dialog = useDialog()
const account = useAccountStore()

const acc = computed(() => account.accounts.find((a) => a.id === props.accountId) || null)
const isActive = computed(() => acc.value?.active)

const tab = ref('overview')
const busy = ref('') // 目前進行中的動作名

// 標註
const meta = ref({ label: '', note: '' })
// 改資料
const profile = ref({ firstName: '', lastName: '', bio: '', username: '', avatarPath: '' })
const avatarName = ref('')
// 2FA
const twofa = ref({ current: '', next: '', confirm: '', hint: '' })
// 匯出
const exported = ref('')

watch(
  () => props.show,
  (v) => {
    if (v && acc.value) hydrate()
  }
)
watch(
  () => props.accountId,
  () => {
    if (props.show && acc.value) hydrate()
  }
)

function hydrate() {
  tab.value = 'overview'
  const a = acc.value
  const u = a?.user || {}
  meta.value = { label: a?.label || '', note: a?.note || '' }
  profile.value = {
    firstName: u.firstName || '',
    lastName: u.lastName || '',
    bio: '',
    username: u.username || '',
    avatarPath: ''
  }
  avatarName.value = ''
  twofa.value = { current: '', next: '', confirm: '', hint: '' }
  exported.value = ''
}

const healthPill = computed(() => {
  const st = acc.value?.health?.state || 'unknown'
  return (
    {
      ok: { cls: 'nc-pill--ok', text: '正常' },
      warn: { cls: 'nc-pill--warn', text: '受限' },
      bad: { cls: 'nc-pill--bad', text: '異常 / 封禁' },
      unknown: { cls: 'nc-pill--idle', text: '未檢測' }
    }[st] || { cls: 'nc-pill--idle', text: '未檢測' }
  )
})

function fmtTime(sec) {
  if (!sec) return '從未'
  const d = new Date(sec * 1000)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ---- 動作 ----
async function doHealth() {
  busy.value = 'health'
  const r = await account.healthCheck(props.accountId)
  busy.value = ''
  if (r?.ok) message.success('檢測完成')
  else message.warning(r?.error || '檢測未通過(帳號可能異常)')
}

async function saveMeta() {
  busy.value = 'meta'
  await account.setMeta(props.accountId, { label: meta.value.label, note: meta.value.note })
  busy.value = ''
  message.success('已儲存標註')
}

async function pickAvatar() {
  const r = await window.api.settings.pickImage()
  if (r && !r.canceled) {
    profile.value.avatarPath = r.path
    avatarName.value = r.path.split(/[\\/]/).pop()
  }
}

async function applyProfile() {
  busy.value = 'profile'
  const p = { ...profile.value }
  // 用戶名沒填就不動它;空字串會清除,故未變更時移除該鍵
  if (!p.username && !(acc.value?.user?.username)) delete p.username
  const r = await account.setProfile(props.accountId, p)
  busy.value = ''
  if (r?.ok) {
    message.success('資料已更新' + (r.done?.length ? `(${r.done.join('、')})` : ''))
    profile.value.avatarPath = ''
    avatarName.value = ''
  } else message.error(r?.error || '更新失敗')
}

async function applyTwoFa(remove = false) {
  const t = twofa.value
  if (!remove) {
    if (!t.next) return message.warning('請輸入新密碼')
    if (t.next !== t.confirm) return message.warning('兩次新密碼不一致')
  }
  if (acc.value?.health?.has2fa && !t.current)
    return message.warning('此帳號已有兩步驗證,請先輸入目前密碼')
  busy.value = 'twofa'
  const r = await account.setTwoFa(props.accountId, {
    current: t.current,
    newPassword: remove ? '' : t.next,
    hint: t.hint
  })
  busy.value = ''
  if (r?.ok) {
    message.success(remove ? '已移除兩步驗證' : '兩步驗證已設定')
    twofa.value = { current: '', next: '', confirm: '', hint: '' }
  } else message.error(r?.error || '操作失敗')
}

function confirmTerminate() {
  dialog.warning({
    title: '踢掉其他裝置',
    content: '將登出此帳號在其他所有裝置的登入(常用於防止協議號賣家收回)。目前這個工具的連線會保留。確定?',
    positiveText: '踢掉其他裝置',
    negativeText: '取消',
    onPositiveClick: async () => {
      busy.value = 'terminate'
      const r = await account.terminateOthers(props.accountId)
      busy.value = ''
      if (r?.ok) message.success(`完成,目前剩 ${r.sessionsCount ?? '?'} 個裝置`)
      else message.error(r?.error || '操作失敗')
    }
  })
}

async function doExport() {
  busy.value = 'export'
  const r = await account.exportSession(props.accountId)
  busy.value = ''
  if (r?.ok) exported.value = r.session
  else message.error(r?.error || '匯出失敗')
}

async function copyExported() {
  try {
    await navigator.clipboard.writeText(exported.value)
    message.success('已複製到剪貼簿')
  } catch {
    message.error('複製失敗')
  }
}

const tabs = [
  { key: 'overview', label: '概覽', icon: Activity },
  { key: 'profile', label: '改資料', icon: UserPen },
  { key: 'twofa', label: '兩步驗證', icon: ShieldCheck },
  { key: 'security', label: '裝置安全', icon: MonitorSmartphone },
  { key: 'export', label: '匯出', icon: KeyRound }
]
</script>

<template>
  <n-drawer
    :show="show"
    @update:show="(v) => emit('update:show', v)"
    :width="440"
    placement="right"
  >
    <n-drawer-content :native-scrollbar="false" body-style="padding:0">
      <div v-if="acc" class="flex flex-col h-full">
        <!-- 頭部 -->
        <div class="p-4 border-b border-line">
          <div class="flex items-center gap-3">
            <Avatar :title="accountName(acc)" :url="isActive ? account.avatarUrl : ''" :has-photo="false" :size="46" />
            <div class="min-w-0 flex-1">
              <div class="font-semibold text-ink truncate">{{ accountName(acc) }}</div>
              <div class="text-[12px] text-muted truncate">
                {{ acc.user?.username ? '@' + acc.user.username : acc.phone || acc.user?.id || '—' }}
              </div>
            </div>
          </div>
          <div class="flex items-center gap-2 mt-3">
            <span class="nc-pill" :class="acc.type === 'protocol' ? 'nc-pill--accent' : 'nc-pill--idle'">
              {{ acc.type === 'protocol' ? '協議號' : '直登號' }}
            </span>
            <span class="nc-pill" :class="healthPill.cls"><span class="dot" />{{ healthPill.text }}</span>
            <span v-if="isActive" class="nc-pill nc-pill--ok"><Check :size="12" />使用中</span>
          </div>
        </div>

        <!-- 分頁 -->
        <div class="px-3 pt-3">
          <div class="nc-seg w-full flex">
            <button
              v-for="t in tabs"
              :key="t.key"
              class="flex-1 !px-1"
              :class="{ on: tab === t.key }"
              @click="tab = t.key"
              :title="t.label"
            >
              <component :is="t.icon" :size="15" class="inline" />
            </button>
          </div>
        </div>

        <div class="flex-1 overflow-y-auto p-4">
          <!-- 概覽 -->
          <div v-if="tab === 'overview'" class="space-y-4">
            <div class="grid grid-cols-2 gap-2">
              <div class="nc-stat"><div class="k">資料中心 DC</div><div class="v">{{ acc.health?.dc ?? '—' }}</div></div>
              <div class="nc-stat"><div class="k">登入裝置</div><div class="v">{{ acc.health?.sessionsCount ?? '—' }}</div></div>
              <div class="nc-stat">
                <div class="k">兩步驗證</div>
                <div class="v" :class="acc.health?.has2fa ? 'text-ok' : 'text-muted'">
                  {{ acc.health?.has2fa == null ? '—' : acc.health.has2fa ? '已開' : '未開' }}
                </div>
              </div>
              <div class="nc-stat"><div class="k">來源</div><div class="v !text-base pt-1">{{ acc.importedFormat || (acc.type === 'protocol' ? 'session' : '登入') }}</div></div>
            </div>

            <div v-if="acc.health?.spamText" class="nc-card p-3">
              <div class="text-[11.5px] text-muted mb-1">@SpamBot 檢測回覆</div>
              <div class="text-[12px] text-ink2 leading-relaxed whitespace-pre-wrap">{{ acc.health.spamText }}</div>
            </div>

            <div class="flex items-center justify-between text-[11.5px] text-muted">
              <span>上次檢測:{{ fmtTime(acc.health?.checkedAt) }}</span>
              <button class="nc-btn" :disabled="busy === 'health'" @click="doHealth">
                <RefreshCw :size="14" :class="{ 'animate-spin': busy === 'health' }" />健康檢測
              </button>
            </div>

            <div class="border-t border-line pt-3 space-y-2">
              <div class="text-[12px] text-ink2">標籤與備註</div>
              <n-input v-model:value="meta.label" size="small" placeholder="標籤(如:主號 / 客服 / 備用)" />
              <n-input v-model:value="meta.note" type="textarea" :rows="2" placeholder="備註(自用)" />
              <button class="nc-btn nc-btn--primary" :disabled="busy === 'meta'" @click="saveMeta">儲存標註</button>
            </div>
          </div>

          <!-- 改資料 -->
          <div v-else-if="tab === 'profile'" class="space-y-3">
            <p class="text-[12px] text-muted leading-relaxed">修改此帳號的公開資料。留空的名字/姓氏會被清空;用戶名須全域唯一。</p>
            <div class="grid grid-cols-2 gap-2">
              <div>
                <div class="lbl">名字</div>
                <n-input v-model:value="profile.firstName" size="small" placeholder="First name" />
              </div>
              <div>
                <div class="lbl">姓氏</div>
                <n-input v-model:value="profile.lastName" size="small" placeholder="Last name" />
              </div>
            </div>
            <div>
              <div class="lbl">用戶名 @</div>
              <n-input v-model:value="profile.username" size="small" placeholder="username(留空=清除)" />
            </div>
            <div>
              <div class="lbl">簡介 Bio</div>
              <n-input v-model:value="profile.bio" type="textarea" :rows="2" placeholder="關於我(About)" />
            </div>
            <div>
              <div class="lbl">頭像</div>
              <div class="flex items-center gap-2">
                <button class="nc-btn" @click="pickAvatar"><ImageIcon :size="14" />選擇圖片</button>
                <span class="text-[12px] text-muted truncate">{{ avatarName || '未選擇(不變更)' }}</span>
              </div>
            </div>
            <button class="nc-btn nc-btn--primary w-full" :disabled="busy === 'profile'" @click="applyProfile">
              {{ busy === 'profile' ? '套用中…' : '套用變更' }}
            </button>
          </div>

          <!-- 兩步驗證 -->
          <div v-else-if="tab === 'twofa'" class="space-y-3">
            <p class="text-[12px] text-muted leading-relaxed">
              買到協議號後,建議<b class="text-ink2">立即設定自己的兩步驗證密碼</b>以鎖定帳號。
              修改/移除需先輸入目前密碼。此運算可能較慢,請耐心等待。
            </p>
            <div v-if="acc.health?.has2fa">
              <div class="lbl">目前密碼</div>
              <n-input v-model:value="twofa.current" type="password" show-password-on="click" size="small" placeholder="目前的 2FA 密碼" />
            </div>
            <div>
              <div class="lbl">新密碼</div>
              <n-input v-model:value="twofa.next" type="password" show-password-on="click" size="small" placeholder="新的 2FA 密碼" />
            </div>
            <div>
              <div class="lbl">確認新密碼</div>
              <n-input v-model:value="twofa.confirm" type="password" show-password-on="click" size="small" placeholder="再輸入一次" />
            </div>
            <div>
              <div class="lbl">提示(選填)</div>
              <n-input v-model:value="twofa.hint" size="small" placeholder="密碼提示" />
            </div>
            <div class="flex gap-2">
              <button class="nc-btn nc-btn--primary flex-1" :disabled="busy === 'twofa'" @click="applyTwoFa(false)">
                {{ acc.health?.has2fa ? '修改密碼' : '設定密碼' }}
              </button>
              <button v-if="acc.health?.has2fa" class="nc-btn nc-btn--danger" :disabled="busy === 'twofa'" @click="applyTwoFa(true)">
                移除
              </button>
            </div>
          </div>

          <!-- 裝置安全 -->
          <div v-else-if="tab === 'security'" class="space-y-3">
            <div class="nc-card p-4 text-center">
              <div class="text-[34px] font-bold text-ink leading-none">{{ acc.health?.sessionsCount ?? '—' }}</div>
              <div class="text-[12px] text-muted mt-1">目前登入的裝置數</div>
            </div>
            <p class="text-[12px] text-muted leading-relaxed">
              「踢掉其他裝置」會登出此帳號在所有其他地方的登入(含賣家原本的登入),只保留目前這個工具的連線 ——
              這是拿到協議號後<b class="text-ink2">最重要的一步</b>。
            </p>
            <button class="nc-btn nc-btn--danger w-full" :disabled="busy === 'terminate'" @click="confirmTerminate">
              <MonitorSmartphone :size="15" />踢掉其他所有裝置
            </button>
          </div>

          <!-- 匯出 -->
          <div v-else-if="tab === 'export'" class="space-y-3">
            <p class="text-[12px] text-muted leading-relaxed">
              匯出此帳號的 GramJS session 字串,可備份或配合你的雲端同步。<b class="text-bad">請妥善保管,等同帳號登入權。</b>
            </p>
            <button class="nc-btn nc-btn--primary w-full" :disabled="busy === 'export'" @click="doExport">
              {{ exported ? '重新匯出' : '匯出 session 字串' }}
            </button>
            <div v-if="exported">
              <n-input :value="exported" type="textarea" :rows="5" readonly class="font-mono" />
              <button class="nc-btn w-full mt-2" @click="copyExported"><Copy :size="14" />複製</button>
            </div>
          </div>
        </div>
      </div>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.lbl {
  font-size: 11.5px;
  color: var(--text-2);
  margin-bottom: 4px;
}
</style>
