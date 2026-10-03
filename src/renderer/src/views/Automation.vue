<script setup>
import { ref, onMounted } from 'vue'
import { RefreshCw, Clock } from 'lucide-vue-next'
import { useAutomationStore } from '../stores/automation.js'
import { useSettingsStore } from '../stores/settings.js'
import { notify } from '../notify.js'
import ChatSelector from '../components/ChatSelector.vue'

const auto = useAutomationStore()
const settings = useSettingsStore()

const TYPES = [
  { label: '圖片', value: 'photo' },
  { label: '影片', value: 'video' },
  { label: '文件', value: 'document' },
  { label: '音訊', value: 'audio' }
]

const show = ref(false)
const form = ref(blank())
const targetTitle = ref('')
const submitting = ref(false)

function blank() {
  return {
    name: '',
    type: 'newmsg', // newmsg | cron
    dialogId: '',
    types: [],
    keyword: '',
    cron: '0 * * * *',
    root: ''
  }
}

onMounted(() => auto.load())

function openCreate() {
  form.value = blank()
  form.value.root = settings.paths.saveRoot || ''
  targetTitle.value = ''
  show.value = true
}
function onPick(d) {
  targetTitle.value = d.title
}

async function submit() {
  if (!form.value.dialogId) return notify.warning({ title: '請選擇對話' })
  submitting.value = true
  const f = form.value
  const cfg = {
    name: f.name.trim() || (f.type === 'cron' ? '排程下載' : '新訊息自動下載'),
    type: f.type,
    dialogId: f.dialogId,
    dialogTitle: targetTitle.value,
    filter: { types: f.types.slice(), keyword: f.keyword.trim() },
    output: { root: f.root },
    cron: f.type === 'cron' ? f.cron.trim() : ''
  }
  const r = await auto.create(cfg)
  submitting.value = false
  if (r?.ok) {
    notify.success({ title: '已建立自動化規則' })
    show.value = false
  } else {
    notify.error({ title: '建立失敗', content: r?.error || '' })
  }
}

function ruleDesc(r) {
  const parts = []
  if (r.filter?.types?.length) parts.push(r.filter.types.join('/'))
  else parts.push('全部媒體')
  if (r.filter?.keyword) parts.push('關鍵字:' + r.filter.keyword)
  if (r.type === 'cron') parts.push('排程:' + r.cron)
  return parts.join(' · ')
}
</script>

<template>
  <div class="auto">
    <div class="head">
      <div class="head-title">
        <div class="head-icon"><Clock :size="20" /></div>
        <div>
          <h3>自動化</h3>
          <p class="head-sub">新訊息自動下載 · 排程批量下載</p>
        </div>
      </div>
      <div class="grow" />
      <n-button size="small" tertiary @click="auto.load"><RefreshCw :size="14" style="margin-right:4px" /> 重新整理</n-button>
      <n-button size="small" type="primary" @click="openCreate">＋ 新增規則</n-button>
    </div>

    <div v-if="!auto.rules.length" class="empty">
      <div class="emoji"><Clock :size="48" /></div>
      <p>尚無自動化規則。可建立「新訊息自動下載」或「排程批量下載」。</p>
      <n-button size="small" @click="openCreate">新增規則</n-button>
    </div>

    <div v-else class="list">
      <div v-for="r in auto.rules" :key="r.id" class="card">
        <span class="ty" :class="r.type">{{ r.type === 'cron' ? '排程' : '新訊息' }}</span>
        <div class="info">
          <div class="nm">{{ r.name }}</div>
          <div class="sub">{{ r.dialogTitle }} · {{ ruleDesc(r) }}</div>
        </div>
        <n-switch :value="r.enabled" @update:value="(v) => auto.toggle(r.id, v)" />
        <n-button size="tiny" quaternary @click="auto.remove(r.id)">移除</n-button>
      </div>
    </div>

    <!-- 新增規則 -->
    <n-modal :show="show" @update:show="(v) => (show = v)" preset="card" title="新增自動化規則" style="width: 540px; max-width: 92vw" :bordered="false">
      <div class="modal-body">
      <n-form label-placement="top" size="small">
        <n-form-item label="類型">
          <n-radio-group v-model:value="form.type">
            <n-radio-button value="newmsg">新訊息自動下載</n-radio-button>
            <n-radio-button value="cron">排程批量下載</n-radio-button>
          </n-radio-group>
        </n-form-item>
        <n-form-item label="名稱(選填)">
          <n-input v-model:value="form.name" placeholder="規則名稱" />
        </n-form-item>
        <n-form-item label="對話">
          <ChatSelector v-model="form.dialogId" @pick="onPick" />
        </n-form-item>
        <n-form-item label="媒體型別(不選=全部)">
          <n-checkbox-group v-model:value="form.types">
            <n-checkbox v-for="t in TYPES" :key="t.value" :value="t.value" :label="t.label" />
          </n-checkbox-group>
        </n-form-item>
        <n-form-item label="關鍵字(選填)">
          <n-input v-model:value="form.keyword" placeholder="只處理含此關鍵字的訊息" />
        </n-form-item>
        <n-form-item v-if="form.type === 'cron'" label="cron 表達式">
          <n-input v-model:value="form.cron" placeholder="0 * * * * (每小時) / 0 9 * * * (每天9點)" />
        </n-form-item>
      </n-form>
      <div class="note">
        新訊息:監聽該對話,符合條件的新媒體自動下載到預設保存目錄。<br />
        排程:到點建立一個批量下載任務(可在任務台看)。
      </div>
      </div>
      <template #footer>
        <div class="foot">
          <div class="grow" />
          <n-button @click="show = false">取消</n-button>
          <n-button type="primary" :loading="submitting" :disabled="!form.dialogId" @click="submit">建立</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.auto {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px 20px;
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}
.head-title {
  display: flex;
  align-items: center;
  gap: 12px;
}
.head-icon {
  width: 42px;
  height: 42px;
  border-radius: 13px;
  background: var(--accent-grad);
  color: #fff;
  display: grid;
  place-items: center;
  flex: none;
  box-shadow: var(--shadow-card);
}
.head h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}
.head-sub {
  margin: 2px 0 0;
  font-size: 12.5px;
  color: var(--text-2);
}
.grow {
  flex: 1;
}
.empty {
  flex: 1;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 10px;
  color: var(--text-2);
}
.empty .emoji {
  font-size: 44px;
}
.list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}
.card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 13px 15px;
  box-shadow: var(--shadow-card);
  transition: border-color 0.16s ease, transform 0.16s ease;
}
.card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--card-hi);
  pointer-events: none;
}
.card:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  transform: translateY(-1px);
}
.card > * {
  position: relative;
}
.ty {
  font-size: 11px;
  padding: 3px 9px;
  border-radius: 8px;
  font-weight: 600;
  flex: none;
}
.ty.newmsg {
  background: rgba(43, 191, 122, 0.18);
  color: var(--green);
}
.ty.cron {
  background: rgba(124, 92, 255, 0.18);
  color: #a98bff;
}
.info {
  flex: 1;
  min-width: 0;
}
.nm {
  font-weight: 600;
  font-size: 14px;
}
.sub {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 2px;
}
.modal-body {
  max-height: calc(85vh - 130px);
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 4px;
}
.note {
  font-size: 11.5px;
  color: var(--text-2);
  margin-top: 8px;
  line-height: 1.6;
}
.foot {
  display: flex;
  gap: 8px;
}
</style>
