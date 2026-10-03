<script setup>
import { ref, watch, computed } from 'vue'
import { notify } from '../notify.js'

const props = defineProps({
  show: Boolean,
  rows: { type: Array, default: null }, // 檢索結果(有則可匯出結果)
  dialogId: String, // 有則可掃描整個對話
  dialogTitle: String,
  defaultName: String
})
const emit = defineEmits(['update:show'])

const format = ref('xlsx')
const range = ref('results')
const busy = ref(false)
const opt = ref({ withMediaOnly: false, withTextOnly: false, includeService: false })

const hasRows = computed(() => Array.isArray(props.rows) && props.rows.length > 0)
const canDialog = computed(() => !!props.dialogId)
const isDialogRange = computed(() => range.value === 'dialog')

const NOTE = {
  xlsx: '欄位:訊息ID / 日期 / 寄件者 / 完整文字 / 媒體類型 / 檔名 / 大小 / 回覆 / 轉發自 / 連結。多行文字會自動換行顯示。',
  csv: '同 Excel 欄位,含 BOM;多行文字以引號包住,Excel 開啟不亂碼、不斷行。',
  txt: '每則一段:時間+寄件者、完整原始文字(保留換行)、媒體資訊、連結。',
  json: '網頁檢視器索引格式,可放進 tgview 檢視器目錄(檔名建議 index.json),與下載的媒體一起離線瀏覽。',
  html: '單一 HTML 離線聊天記錄,雙擊即可用瀏覽器看,內建搜尋與日期分隔。'
}

watch(
  () => props.show,
  (v) => {
    if (v) {
      format.value = 'xlsx'
      range.value = hasRows.value ? 'results' : 'dialog'
      opt.value = { withMediaOnly: false, withTextOnly: false, includeService: false }
    }
  }
)

async function run() {
  const name = props.defaultName || props.dialogTitle || '導出'
  busy.value = true
  const pick = await window.api.export.pickSave(name, format.value)
  if (pick.canceled) {
    busy.value = false
    return
  }
  let r
  if (range.value === 'results') {
    r = await window.api.export.rows(props.rows || [], format.value, pick.path, {
      dialogId: props.dialogId || '',
      dialogTitle: props.dialogTitle || props.defaultName || ''
    })
  } else {
    r = await window.api.export.dialog({
      dialogId: props.dialogId,
      format: format.value,
      outPath: pick.path,
      filter: {},
      options: { ...opt.value }
    })
  }
  busy.value = false
  if (r?.ok) {
    notify.success({ title: '已匯出', content: `${r.count} 筆 → ${pick.path.split(/[\\/]/).pop()}` })
    window.api.download.reveal(r.path)
    emit('update:show', false)
  } else {
    notify.error({ title: '匯出失敗', content: r?.error || '' })
  }
}
</script>

<template>
  <n-modal
    :show="show"
    @update:show="(v) => emit('update:show', v)"
    preset="card"
    title="文本導出"
    style="width: 500px"
    :bordered="false"
  >
    <n-form label-placement="top" size="small">
      <n-form-item label="格式">
        <n-radio-group v-model:value="format">
          <n-space vertical :size="6">
            <n-space :size="6">
              <n-radio-button value="xlsx">Excel</n-radio-button>
              <n-radio-button value="csv">CSV</n-radio-button>
              <n-radio-button value="txt">純文字</n-radio-button>
            </n-space>
            <n-space :size="6">
              <n-radio-button value="json">JSON(檢視器索引)</n-radio-button>
              <n-radio-button value="html">HTML(離線記錄)</n-radio-button>
            </n-space>
          </n-space>
        </n-radio-group>
      </n-form-item>
      <n-form-item label="範圍">
        <n-radio-group v-model:value="range">
          <n-space vertical>
            <n-radio v-if="hasRows" value="results">檢索結果({{ rows.length }} 筆)</n-radio>
            <n-radio v-if="canDialog" value="dialog">掃描整個對話「{{ dialogTitle }}」</n-radio>
          </n-space>
        </n-radio-group>
      </n-form-item>
      <n-form-item v-if="isDialogRange" label="內容過濾">
        <n-space vertical :size="4">
          <n-checkbox v-model:checked="opt.withTextOnly">只匯出有文字的訊息</n-checkbox>
          <n-checkbox v-model:checked="opt.withMediaOnly">只匯出有媒體的訊息</n-checkbox>
          <n-checkbox v-model:checked="opt.includeService">包含系統訊息(入群/釘選…)</n-checkbox>
        </n-space>
      </n-form-item>
    </n-form>
    <div class="note">{{ NOTE[format] }}</div>
    <template #footer>
      <div class="foot">
        <div class="grow" />
        <n-button @click="emit('update:show', false)">取消</n-button>
        <n-button type="primary" :loading="busy" @click="run">選擇位置並匯出</n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.note {
  font-size: 11px;
  color: var(--text-2);
  margin-top: 6px;
  line-height: 1.7;
}
.foot {
  display: flex;
  gap: 8px;
}
.grow {
  flex: 1;
}
</style>
