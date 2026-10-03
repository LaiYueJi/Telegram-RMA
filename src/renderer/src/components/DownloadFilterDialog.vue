<script setup>
import { ref, watch, computed } from 'vue'
import { useSettingsStore } from '../stores/settings.js'
import { useTasksStore } from '../stores/tasks.js'
import { notify } from '../notify.js'

const props = defineProps({
  show: Boolean,
  dialogId: String,
  dialogTitle: String
})
const emit = defineEmits(['update:show', 'created'])

const settings = useSettingsStore()
const tasks = useTasksStore()

const tab = ref('basic')
const submitting = ref(false)

const TYPES = [
  { label: '圖片', value: 'photo' },
  { label: '影片', value: 'video' },
  { label: 'GIF', value: 'gif' },
  { label: '音訊', value: 'audio' },
  { label: '語音', value: 'voice' },
  { label: '文件', value: 'document' }
]

const form = ref(blank())
function blank() {
  return {
    title: '',
    root: '',
    startDate: null, // ms
    endDate: null,
    keyword: '',
    reverseKeyword: '',
    fromId: '',
    types: [],
    minSizeMB: null,
    maxSizeMB: null,
    minDuration: null,
    maxDuration: null,
    subfolderByType: false,
    subfolderByDate: false,
    nameRule: 'original',
    maxNameLen: 50,
    saveText: false,
    writeIndex: true
  }
}

watch(
  () => props.show,
  (v) => {
    if (v) {
      tab.value = 'basic'
      form.value = blank()
      form.value.title = `批量下載 - ${props.dialogTitle || ''}`
      form.value.root = settings.paths.saveRoot || ''
    }
  }
)

async function pickRoot() {
  const r = await settings.pickFolder(form.value.root)
  if (!r.canceled) form.value.root = r.path
}

const canSubmit = computed(() => !!props.dialogId)

async function submit() {
  if (!props.dialogId) return notify.warning({ title: '請先在對話頁選擇一個對話' })
  submitting.value = true
  const f = form.value
  const cfg = {
    title: f.title.trim() || `批量下載 - ${props.dialogTitle || ''}`,
    dialogId: props.dialogId,
    dialogTitle: props.dialogTitle,
    filter: {
      startDate: f.startDate ? Math.floor(f.startDate / 1000) : null,
      endDate: f.endDate ? Math.floor(f.endDate / 1000) + 86399 : null,
      keyword: f.keyword.trim(),
      reverseKeyword: f.reverseKeyword.trim(),
      fromId: f.fromId.trim() || null,
      types: f.types.slice(),
      minSize: f.minSizeMB ? Math.round(f.minSizeMB * 1024 * 1024) : null,
      maxSize: f.maxSizeMB ? Math.round(f.maxSizeMB * 1024 * 1024) : null,
      minDuration: f.minDuration || null,
      maxDuration: f.maxDuration || null
    },
    output: {
      root: f.root,
      subfolderByType: f.subfolderByType,
      subfolderByDate: f.subfolderByDate,
      nameRule: f.nameRule,
      maxNameLen: f.maxNameLen || 50,
      saveText: f.saveText,
      writeIndex: f.writeIndex
    }
  }
  const r = await tasks.createDownload(cfg)
  submitting.value = false
  if (r?.ok) {
    notify.success({ title: '已建立批量下載任務', content: '可到「任務台」查看進度' })
    emit('created', r.id)
    emit('update:show', false)
  } else {
    notify.error({ title: '建立失敗', content: r?.error || '' })
  }
}
</script>

<template>
  <n-modal
    :show="show"
    @update:show="(v) => emit('update:show', v)"
    preset="card"
    title="批量下載"
    style="width: 680px"
    :bordered="false"
  >
    <div class="target">
      目標對話:<b>{{ dialogTitle || '(未選擇)' }}</b>
    </div>

    <n-tabs v-model:value="tab" type="line" size="small">
      <!-- 基礎信息 -->
      <n-tab-pane name="basic" tab="基礎信息">
        <n-form label-placement="top" size="small">
          <n-form-item label="任務標題">
            <n-input v-model:value="form.title" placeholder="批量下載任務" />
          </n-form-item>
          <n-form-item label="保存根目錄">
            <n-input-group>
              <n-input v-model:value="form.root" placeholder="預設下載目錄" />
              <n-button @click="pickRoot">選擇</n-button>
            </n-input-group>
          </n-form-item>
        </n-form>
      </n-tab-pane>

      <!-- 篩選條件 -->
      <n-tab-pane name="filter" tab="篩選條件">
        <n-form label-placement="top" size="small">
          <div class="two">
            <n-form-item label="開始日期">
              <n-date-picker v-model:value="form.startDate" type="date" clearable style="width: 100%" />
            </n-form-item>
            <n-form-item label="結束日期">
              <n-date-picker v-model:value="form.endDate" type="date" clearable style="width: 100%" />
            </n-form-item>
          </div>
          <n-form-item label="內容關鍵詞(含)">
            <n-input v-model:value="form.keyword" placeholder="只下載含此關鍵詞的訊息" />
          </n-form-item>
          <n-form-item label="反向關鍵詞(排除)">
            <n-input v-model:value="form.reverseKeyword" placeholder="含此關鍵詞的訊息略過" />
          </n-form-item>
          <n-form-item label="指定成員 ID(選填)">
            <n-input v-model:value="form.fromId" placeholder="只下載某成員發的(填數字 user id)" />
          </n-form-item>
        </n-form>
      </n-tab-pane>

      <!-- 文件限制 -->
      <n-tab-pane name="file" tab="文件限制">
        <n-form label-placement="top" size="small">
          <n-form-item label="媒體型別(不選=全部)">
            <n-checkbox-group v-model:value="form.types">
              <div class="types">
                <n-checkbox v-for="t in TYPES" :key="t.value" :value="t.value" :label="t.label" />
              </div>
            </n-checkbox-group>
          </n-form-item>
          <div class="two">
            <n-form-item label="最小檔案 (MB)">
              <n-input-number v-model:value="form.minSizeMB" :min="0" clearable style="width: 100%" />
            </n-form-item>
            <n-form-item label="最大檔案 (MB)">
              <n-input-number v-model:value="form.maxSizeMB" :min="0" clearable style="width: 100%" />
            </n-form-item>
          </div>
          <div class="two">
            <n-form-item label="最短時長 (秒)">
              <n-input-number v-model:value="form.minDuration" :min="0" clearable style="width: 100%" />
            </n-form-item>
            <n-form-item label="最長時長 (秒)">
              <n-input-number v-model:value="form.maxDuration" :min="0" clearable style="width: 100%" />
            </n-form-item>
          </div>
        </n-form>
      </n-tab-pane>

      <!-- 輸出與目錄 -->
      <n-tab-pane name="output" tab="輸出與目錄">
        <n-form label-placement="top" size="small">
          <n-form-item label="資料夾結構">
            <n-space vertical>
              <n-checkbox v-model:checked="form.subfolderByType">依媒體型別分子資料夾</n-checkbox>
              <n-checkbox v-model:checked="form.subfolderByDate">依日期分子資料夾</n-checkbox>
            </n-space>
          </n-form-item>
          <n-form-item label="檔名規則">
            <n-radio-group v-model:value="form.nameRule">
              <n-space vertical>
                <n-radio value="original">原檔名(無則 日期_ID)</n-radio>
                <n-radio value="dateId">日期_訊息ID</n-radio>
                <n-radio value="content">訊息內容前 N 字</n-radio>
              </n-space>
            </n-radio-group>
          </n-form-item>
          <n-form-item v-if="form.nameRule === 'content'" label="內容檔名最大長度">
            <n-input-number v-model:value="form.maxNameLen" :min="5" :max="120" style="width: 160px" />
          </n-form-item>
          <n-form-item label="其他">
            <n-space vertical :size="4">
              <n-checkbox v-model:checked="form.saveText">把訊息文字另存為 .txt</n-checkbox>
              <n-checkbox v-model:checked="form.writeIndex">
                輸出網頁檢視器索引 index.json(含完整文字/寄件者/日期)
              </n-checkbox>
              <div class="tip">
                勾選後,整個資料夾丟進 tgview 檢視器的 data/ 就能離線瀏覽圖片、影片與原始文字。
              </div>
            </n-space>
          </n-form-item>
        </n-form>
      </n-tab-pane>
    </n-tabs>

    <template #footer>
      <div class="foot">
        <span class="hint">並行下載多檔(加速),完成需檔案大小一致才算成功</span>
        <div class="grow" />
        <n-button @click="emit('update:show', false)">取消</n-button>
        <n-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="submit">
          開始下載
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.target {
  font-size: 13px;
  color: var(--text-1);
  margin-bottom: 8px;
}
.two {
  display: flex;
  gap: 12px;
}
.two > * {
  flex: 1;
}
.types {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
}
.foot {
  display: flex;
  align-items: center;
  gap: 10px;
}
.foot .hint {
  font-size: 11px;
  color: var(--text-2);
}
.tip {
  font-size: 11px;
  color: var(--text-2);
  line-height: 1.6;
  padding-left: 22px;
}
.grow {
  flex: 1;
}
</style>
