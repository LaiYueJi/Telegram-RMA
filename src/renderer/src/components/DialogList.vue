<script setup>
import { computed, onMounted, ref, h } from 'vue'
import { Search, RefreshCw, Plus, Archive, Star, Pin, List, ArrowLeft } from 'lucide-vue-next'
import { useDialogsStore } from '../stores/dialogs.js'
import { notify } from '../notify.js'
import { useConversationStore } from '../stores/conversation.js'
import Avatar from './Avatar.vue'

const dialogs = useDialogsStore()

// 添加對話:貼 @用戶名 / 電話 / t.me 連結 → 解析後加進左側清單
const add = ref({ show: false, value: '', busy: false })
function openAdd() {
  add.value = { show: true, value: '', busy: false }
}
async function submitAdd() {
  const v = add.value.value.trim()
  if (!v) return
  add.value.busy = true
  const r = await dialogs.addDialog(v)
  add.value.busy = false
  if (r?.ok) {
    add.value.show = false
    notify.success({ title: '已加入對話列表', content: v })
  } else {
    notify.error({ title: '找不到這個對象', content: r?.error || '請確認用戶名或連結是否正確' })
  }
}
const conversation = useConversationStore()

const typeFilters = [
  { key: 'all', label: '全部' },
  { key: 'user', label: '私聊' },
  { key: 'group', label: '群組' },
  { key: 'channel', label: '頻道' }
]

onMounted(() => {
  dialogs.load()
  dialogs.loadArchived()
})

function select(d) {
  conversation.open(d)
}

/** 進入封存子列表 */
function enterArchived() {
  dialogs.setFolder('archived')
}

/** 從封存返回 */
function leaveArchived() {
  dialogs.setFolder('all')
}

const listLoading = computed(() =>
  dialogs.activeFolder === 'archived' ? dialogs.archivedLoading : dialogs.loading
)

/** 目前選中的資料夾名稱(下拉按鈕顯示) */
const activeFolderLabel = computed(() => {
  if (dialogs.activeFolder === 'archived') return '封存'
  if (dialogs.activeFolder === 'all') return '全部'
  const f = dialogs.folders.find((x) => x.id === dialogs.activeFolder)
  if (f) return (f.emoticon ? f.emoticon + ' ' : '') + f.title
  return '全部'
})

/** 資料夾下拉選項(封存從這裡移除了,由列表項目入口取代) */
const folderOptions = computed(() => {
  const opts = [
    {
      key: 'all',
      icon: () => h(List, { size: 16 }),
      label: () => h('span', { style: { fontWeight: dialogs.activeFolder === 'all' ? 600 : 400 } }, '全部')
    }
  ]
  for (const f of dialogs.folders) {
    opts.push({
      key: String(f.id),
      icon: () => h('span', { style: { fontSize: '14px' } }, f.emoticon || '📁'),
      label: () => h('span', { style: { fontWeight: dialogs.activeFolder === f.id ? 600 : 400 } }, f.title)
    })
  }
  return opts
})

function onFolderSelect(key) {
  dialogs.setFolder(key === 'all' ? 'all' : Number(key))
}
</script>

<template>
  <div class="dialoglist">
    <div class="head">
      <n-input v-model:value="dialogs.search" placeholder="搜尋對話" clearable size="small">
        <template #prefix><Search :size="14" /></template>
      </n-input>
      <n-button size="small" tertiary title="重新整理" @click="dialogs.load(true)"><RefreshCw :size="15" /></n-button>
      <n-button size="small" tertiary title="添加對話" @click="openAdd"><Plus :size="15" /></n-button>
    </div>

    <!-- 封存子列表:返回按鈕 + 封存對話 -->
    <template v-if="dialogs.activeFolder === 'archived'">
      <div class="backbar">
        <n-button text @click="leaveArchived">
          <ArrowLeft :size="16" /><span style="margin-left:6px">封存的對話</span>
        </n-button>
      </div>
    </template>

    <!-- 主模式:資料夾下拉 -->
    <div v-else class="folderbar">
      <n-dropdown trigger="click" :options="folderOptions" @select="onFolderSelect" placement="bottom-start">
        <button class="folderbtn">
          <Archive v-if="dialogs.activeFolder === 'archived'" :size="14" />
          <List v-else-if="dialogs.activeFolder === 'all'" :size="14" />
          <span v-else class="emo">{{ dialogs.folders.find((x) => x.id === dialogs.activeFolder)?.emoticon || '📁' }}</span>
          <span>{{ activeFolderLabel }}</span>
          <span class="caret">▾</span>
        </button>
      </n-dropdown>
    </div>

    <!-- 型別子篩選(封存模式不顯示) -->
    <div v-if="dialogs.activeFolder !== 'archived'" class="filters">
      <button
        v-for="f in typeFilters"
        :key="f.key"
        :class="{ on: dialogs.typeFilter === f.key }"
        @click="dialogs.typeFilter = f.key"
      >
        {{ f.label }}
      </button>
    </div>

    <div class="list">
      <!-- 我的收藏:常駐置頂入口,所有清單(含封存)皆可見,不在搜尋時顯示 -->
      <div
        v-if="dialogs.savedDialog && !dialogs.search"
        class="item saved-entry"
        :class="{ active: conversation.current?.id === dialogs.savedDialog.id }"
        @click="select(dialogs.savedDialog)"
      >
        <div class="savedav"><Star :size="22" /></div>
        <div class="info">
          <div class="top">
            <span class="title"><span class="tag star">收藏</span> 我的收藏</span>
          </div>
          <div class="last">Saved Messages · 我的收藏</div>
        </div>
        <div class="right">
          <span v-if="dialogs.savedDialog.unreadCount" class="unread">{{ dialogs.savedDialog.unreadCount > 99 ? '99+' : dialogs.savedDialog.unreadCount }}</span>
        </div>
      </div>

      <!-- 封存入口:只在主模式(非封存)且不在搜尋時顯示,置於對話列表最上方 -->
      <div
        v-if="dialogs.activeFolder !== 'archived' && !dialogs.search && dialogs.archivedList.length"
        class="item archive-entry"
        @click="enterArchived"
      >
        <div class="archive-av"><Archive :size="22" /></div>
        <div class="info">
          <div class="top">
            <span class="title">封存的對話</span>
          </div>
        </div>
        <div class="right">
          <span v-if="dialogs.archivedUnread" class="unread">{{ dialogs.archivedUnread > 99 ? '99+' : dialogs.archivedUnread }}</span>
        </div>
      </div>

      <div v-if="listLoading" class="hint"><n-spin size="small" /> 載入對話中…</div>
      <div v-else-if="dialogs.error" class="hint err">{{ dialogs.error }}</div>
      <div v-else-if="!dialogs.filtered.length" class="hint">無對話</div>

      <div
        v-for="d in dialogs.filtered"
        :key="d.id"
        class="item"
        :class="{ active: conversation.current?.id === d.id, saved: d.isSaved }"
        @click="select(d)"
      >
        <Avatar v-if="!d.isSaved" :peer-id="d.id" :title="d.title" :has-photo="d.hasPhoto" :size="46" />
        <div v-else class="savedav"><Star :size="22" /></div>
        <div class="info">
          <div class="top">
            <span class="title">
              <span v-if="d.pinned && dialogs.activeFolder !== 'archived'" class="pin"><Pin :size="11" /></span>
              <span v-if="d.isSaved" class="tag star">收藏</span>
              <span v-else-if="d.type === 'channel'" class="tag">頻道</span>
              <span v-else-if="d.type === 'group'" class="tag">群</span>
              {{ d.title }}
            </span>
          </div>
          <div class="last">{{ d.isSaved ? 'Saved Messages · 我的收藏' : d.lastMessage }}</div>
        </div>
        <div class="right">
          <span v-if="d.unreadCount" class="unread">{{ d.unreadCount > 99 ? '99+' : d.unreadCount }}</span>
        </div>
      </div>
    </div>
  </div>

  <!-- 添加對話 -->
  <n-modal
    v-model:show="add.show"
    preset="card"
    title="添加對話"
    style="width: 460px"
    :bordered="false"
  >
    <p class="add-tip">
      貼上 <b>@用戶名</b>、<b>電話號碼</b>,或 <b>t.me/xxx</b> 邀請連結。<br />
      解析成功後,那個對象就會出現在左邊的對話列表,接著就能對它做批量下載 / 檢索。
    </p>
    <n-input
      v-model:value="add.value"
      placeholder="@durov 或 https://t.me/xxxxx"
      clearable
      autofocus
      @keydown.enter="submitAdd"
    />
    <p class="add-note">找不到的話,通常是打錯字、私密頻道未加入,或該帳號沒有公開用戶名。</p>
    <template #footer>
      <div class="add-foot">
        <div class="grow" />
        <n-button size="small" @click="add.show = false">取消</n-button>
        <n-button size="small" type="primary" :loading="add.busy" @click="submitAdd">加入</n-button>
      </div>
    </template>
  </n-modal>

</template>

<style scoped>
.dialoglist {
  width: 300px;
  flex: none;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  background: var(--bg-1);
  min-height: 0;
}
.head {
  display: flex;
  gap: 6px;
  padding: 10px;
}
.backbar {
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
}
.folderbar {
  padding: 0 10px 8px;
}
.folderbtn {
  width: 100%;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--border);
  background: var(--bg-2);
  color: var(--text-1);
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.folderbtn:hover {
  border-color: var(--accent);
}
.folderbtn .caret {
  font-size: 10px;
  color: var(--text-2);
}
.filters {
  display: flex;
  gap: 4px;
  padding: 0 10px 8px;
}
.filters button {
  flex: 1;
  height: 24px;
  border: none;
  background: var(--bg-2);
  color: var(--text-2);
  border-radius: 7px;
  cursor: pointer;
  font-size: 11.5px;
}
.filters button.on {
  background: var(--bg-3);
  color: var(--text-0);
}
.list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.hint {
  text-align: center;
  color: var(--text-2);
  padding: 20px;
  font-size: 13px;
}
.hint.err {
  color: var(--red);
}
/* 收藏 / 封存入口:與對話項目一致,常駐置頂 */
.saved-entry,
.archive-entry {
  border-bottom: 1px solid var(--border);
}
.archive-av {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  flex: none;
  display: grid;
  place-items: center;
  background: var(--bg-3);
  color: var(--text-1);
}
.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  cursor: pointer;
  border-left: 3px solid transparent;
}
.item:hover {
  background: var(--bg-2);
}
.item.active {
  background: var(--bg-2);
  border-left-color: var(--accent);
}
.savedav {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  flex: none;
  display: grid;
  place-items: center;
  font-size: 22px;
  background: linear-gradient(135deg, #f6c350, #f59e42);
}
.info {
  flex: 1;
  min-width: 0;
}
.top {
  display: flex;
  justify-content: space-between;
}
.title {
  font-size: 13.5px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pin {
  font-size: 11px;
  margin-right: 2px;
}
.tag {
  font-size: 10px;
  background: var(--bg-3);
  color: var(--text-2);
  padding: 0 4px;
  border-radius: 4px;
  margin-right: 2px;
}
.tag.star {
  background: rgba(245, 158, 66, 0.2);
  color: #f6c350;
}
.last {
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}
.right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
.unread {
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  min-width: 18px;
  height: 18px;
  border-radius: 9px;
  padding: 0 5px;
  display: grid;
  place-items: center;
}

.add-tip {
  font-size: 12.5px;
  color: var(--text-1);
  line-height: 1.8;
  margin: 0 0 12px;
}
.add-note {
  font-size: 11.5px;
  color: var(--text-2);
  margin: 10px 0 0;
  line-height: 1.7;
}
.add-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.add-foot .grow {
  flex: 1;
}
</style>
