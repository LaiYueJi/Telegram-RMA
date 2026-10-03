/**
 * 設定持久化(electron-store v8)。
 * 存:API 憑證、多帳號(accounts[].session)、代理清單、偏好、路徑。
 * 注意:所有設定只存在本機,不連任何外部伺服器。
 * 多帳號:憑證與代理為全域共用;一次只連一個 activeAccount。
 */
import Store from 'electron-store'
import { app } from 'electron'
import { join } from 'node:path'

/** @type {import('electron-store')} */
let store

/** 產生帳號 id。 */
function genAccId() {
  return 'acc' + Math.random().toString(36).slice(2, 10)
}
function nowSec() {
  return Math.floor(Date.now() / 1000)
}

/**
 * 建一個標準帳號物件。
 * type:'direct'(直登號:手機驗證碼/QR 登入) | 'protocol'(協議號:session 導入)。
 * label/note/tags 為使用者標註;health 為最近一次健康檢測快照。
 */
function makeAccount(partial = {}) {
  return {
    id: genAccId(),
    session: '',
    user: null,
    phone: '',
    addedAt: nowSec(),
    type: 'direct',
    label: '',
    note: '',
    tags: [],
    importedFormat: '', // '' | 'gramjs' | 'telethon'
    health: null, // { state:'ok'|'warn'|'bad'|'unknown', dc, has2fa, sessionsCount, spamText, checkedAt }
    ...partial
  }
}

const defaults = {
  credentials: { apiId: null, apiHash: '' },
  session: '', // legacy 單帳號 session,遷移後恆為 ''(保留鍵供讀舊值)
  accounts: [], // [{ id, session, user:{id,firstName,lastName,username,phone,premium}|null, phone, addedAt }]
  activeAccountId: null,
  proxies: [], // { id, type:'socks'|'mtproto', ip, port, secret, username, password, socksType, label }
  activeProxyId: null,
  preferences: {
    theme: 'dark',
    backgroundTheme: 'default', // 背景漸層主題 id(見 renderer/src/data/gradients.js)
    glowStyle: 'breathe', // 'breathe' | 'flow' | 'none'
    downloadPopup: false, // 普通下載是否彈框
    gpuAcceleration: 'system', // 'system' | 'off'
    concurrency: 3, // 批量下載:同時下載幾個檔案(後續里程碑)
    downloadThreads: 1, // 單檔分段數(in-flight 並發度)。1=自動(直連 4 / 代理 8);>1 則尊重設定。配合多連線池才真正加速
    downloadConnections: 4, // 單檔對同一 DC 開幾條獨立連線。Telegram 限速是每連線,多連線才能突破單連線上限(同官方,預設 4)
    batchConcurrency: 4, // 批量下載真正的加速來源:多個檔案同時下載(後續里程碑用)
    batchDownloadLimit: 5000, // 批量下載單次上限
    forwardLimit: 2000, // 轉發任務單次上限
    searchLimit: 1000, // 消息檢索單次最多回傳幾筆命中(後端掃描上限 = 此值×6+500)
    closeAction: 'ask', // 按 X 的行為:'ask'=每次詢問 | 'tray'=縮到系統匣 | 'quit'=直接結束
    trayEnabled: true, // 是否顯示系統匣圖示(關掉時 closeAction 的 tray 會退回直接結束)
    trayHintShown: false // 「已縮到系統匣」的氣泡提示只跳第一次
  },
  paths: {
    saveRoot: '', // 預設下載根目錄(空 → 啟動時填 Downloads)
    cacheDir: '' // 縮圖/頭像快取目錄(空 → 啟動時填 userData/cache)
  }
}

/** 早期初始化(app ready 前即可呼叫,用來讀 GPU 加速等開機前設定)。 */
export function initConfig() {
  store = new Store({ name: 'tgff-config', defaults })
  migrateAccounts()
  return store
}

/**
 * 一次性把舊單帳號 session 轉成 accounts[0],並在開機時清掉空 session 殘留(中途取消新增的 placeholder)。
 * 冪等:遷移後 legacy session 為空且 accounts 非空,不再重跑遷移。
 */
function migrateAccounts() {
  let accounts = store.get('accounts') || []
  const legacy = store.get('session')
  if (accounts.length === 0 && legacy) {
    accounts = [makeAccount({ session: legacy, addedAt: 0 })]
    store.set('accounts', accounts)
    store.set('activeAccountId', accounts[0].id)
    store.set('session', '')
    return
  }
  // 開機 prune:刪掉空 session 帳號(force-quit 殘留的新增中 placeholder)
  const pruned = accounts.filter((a) => a.session)
  if (pruned.length !== accounts.length) {
    store.set('accounts', pruned)
    accounts = pruned
  }
  // 向後相容:替舊帳號補上新欄位(舊帳號皆為直登號)
  let backfilled = false
  for (const a of accounts) {
    if (a.type === undefined) {
      a.type = 'direct'
      a.label = a.label || ''
      a.note = a.note || ''
      a.tags = a.tags || []
      a.importedFormat = a.importedFormat || ''
      a.health = a.health || null
      backfilled = true
    }
  }
  if (backfilled) store.set('accounts', accounts)
  // activeAccountId 失效 → fallback 第一個
  const activeId = store.get('activeAccountId')
  if (!accounts.find((a) => a.id === activeId)) {
    store.set('activeAccountId', accounts[0]?.id ?? null)
  }
}

/** app ready 後補上需要 app 路徑的預設值。 */
export function ensureDefaultPaths() {
  const paths = store.get('paths')
  let changed = false
  if (!paths.saveRoot) {
    paths.saveRoot = join(app.getPath('downloads'), 'Telegram-RMA')
    changed = true
  }
  if (!paths.cacheDir) {
    paths.cacheDir = join(app.getPath('userData'), 'cache')
    changed = true
  }
  if (changed) store.set('paths', paths)
  return paths
}

/** 讀取整個設定值 */
export function get(key) {
  return store.get(key)
}
export function set(key, value) {
  store.set(key, value)
}

// ---- 具名便利存取 ----
export const config = {
  getCredentials: () => store.get('credentials'),
  setCredentials: (c) => store.set('credentials', c),

  // ---- 多帳號 ----
  // session 讀寫一律轉址到「目前 active 帳號」,client.js 既有 9 處讀寫不必改。
  getSession() {
    const id = store.get('activeAccountId')
    const acc = (store.get('accounts') || []).find((a) => a.id === id)
    return acc ? acc.session || '' : ''
  },
  setSession(s) {
    const accounts = store.get('accounts') || []
    const id = store.get('activeAccountId')
    let acc = accounts.find((a) => a.id === id)
    if (!acc) {
      // 沒有 active 帳號:清空則無事;要寫入有效 session 則自動建一個(全新安裝 / 帳號全移除後的一般登入)
      if (!s) return
      acc = makeAccount()
      accounts.push(acc)
      store.set('activeAccountId', acc.id)
    }
    acc.session = s || ''
    store.set('accounts', accounts)
  },
  getAccounts: () => store.get('accounts') || [],
  getActiveAccountId: () => store.get('activeAccountId'),
  setActiveAccountId: (id) => store.set('activeAccountId', id),
  getActiveAccount() {
    const id = store.get('activeAccountId')
    return (store.get('accounts') || []).find((a) => a.id === id) || null
  },
  /** 建一個空 session 的 placeholder 帳號並設為 active,回新 id(供「新增帳號」)。 */
  addAccountPlaceholder() {
    const accounts = store.get('accounts') || []
    const acc = makeAccount()
    accounts.push(acc)
    store.set('accounts', accounts)
    store.set('activeAccountId', acc.id)
    return acc.id
  },

  /**
   * 直接建立一個已帶 session 的「協議號」帳號(不經 placeholder、不改變 active)。
   * 供 session 導入使用。回新帳號 id。
   */
  addProtocolAccount({ session, user = null, label = '', note = '', importedFormat = 'gramjs' }) {
    const accounts = store.get('accounts') || []
    const acc = makeAccount({
      session: session || '',
      user,
      phone: (user && user.phone) || '',
      type: 'protocol',
      label,
      note,
      importedFormat
    })
    accounts.push(acc)
    store.set('accounts', accounts)
    return acc.id
  },

  /** 更新帳號的標註/健康等中繼資料(只覆寫傳入的鍵)。 */
  setAccountMeta(id, patch = {}) {
    const accounts = store.get('accounts') || []
    const acc = accounts.find((a) => a.id === id)
    if (!acc) return false
    const allow = ['type', 'label', 'note', 'tags', 'importedFormat', 'health']
    for (const k of allow) {
      if (k in patch) acc[k] = patch[k]
    }
    store.set('accounts', accounts)
    return true
  },

  /** 取回單一帳號(含 session)。 */
  getAccount(id) {
    return (store.get('accounts') || []).find((a) => a.id === id) || null
  },
  /** 登入/連線成功後把 user 快照寫回帳號(供下拉顯示名字)。 */
  setAccountUser(id, user) {
    const accounts = store.get('accounts') || []
    const acc = accounts.find((a) => a.id === id)
    if (acc) {
      acc.user = user || null
      if (user && user.phone) acc.phone = user.phone
      store.set('accounts', accounts)
    }
  },
  findAccountByUserId(uid) {
    if (!uid) return null
    return (store.get('accounts') || []).find((a) => a.user && String(a.user.id) === String(uid)) || null
  },
  /** 移除帳號;若移除的是 active 則 active fallback 第一個。 */
  removeAccount(id) {
    const accounts = (store.get('accounts') || []).filter((a) => a.id !== id)
    store.set('accounts', accounts)
    if (store.get('activeAccountId') === id) {
      store.set('activeAccountId', accounts[0]?.id ?? null)
    }
  },
  /** 精準刪除一個「空 session」的 placeholder(供取消新增,不誤刪有效帳號)。 */
  removeEmptyAccount(id) {
    const acc = (store.get('accounts') || []).find((a) => a.id === id)
    if (acc && !acc.session) {
      store.set('accounts', (store.get('accounts') || []).filter((a) => a.id !== id))
    }
  },

  getProxies: () => store.get('proxies'),
  setProxies: (p) => store.set('proxies', p),
  getActiveProxyId: () => store.get('activeProxyId'),
  setActiveProxyId: (id) => store.set('activeProxyId', id),
  getActiveProxy() {
    const id = store.get('activeProxyId')
    if (!id) return null
    return store.get('proxies').find((p) => p.id === id) || null
  },

  getPreferences: () => store.get('preferences'),
  setPreferences: (p) => store.set('preferences', { ...store.get('preferences'), ...p }),

  getPaths: () => store.get('paths'),
  setPaths: (p) => store.set('paths', { ...store.get('paths'), ...p })
}
