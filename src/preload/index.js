/** Preload:透過 contextBridge 暴露安全的 window.api。 */
import { contextBridge, ipcRenderer } from 'electron'

/** 允許 renderer 訂閱的事件頻道白名單。 */
const EVENT_CHANNELS = new Set([
  'win:maximized',
  'auth:qrToken',
  'auth:qrNeedPassword',
  'download:progress',
  'download:item',
  'forward:progress',
  'net:speed',
  'message:new',
  'task:update',
  'accounts:progress',
  'shared:pollProgress', // 投票只能掃歷史,過程回報進度
  'win:askClose' // 主程序問「按 X 要怎麼關」→ renderer 自繪對話框回答
])

const api = {
  // 視窗控制
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized')
  },

  // 登入 / 帳號
  auth: {
    getCredentials: () => ipcRenderer.invoke('auth:getCredentials'),
    setCredentials: (c) => ipcRenderer.invoke('auth:setCredentials', c),
    status: () => ipcRenderer.invoke('auth:status'),
    autoConnect: () => ipcRenderer.invoke('auth:autoConnect'),
    sendCode: (phoneNumber) => ipcRenderer.invoke('auth:sendCode', { phoneNumber }),
    signIn: (code) => ipcRenderer.invoke('auth:signIn', { code }),
    checkPassword: (password) => ipcRenderer.invoke('auth:checkPassword', { password }),
    qrStart: () => ipcRenderer.invoke('auth:qrStart'),
    qrSubmitPassword: (password) => ipcRenderer.invoke('auth:qrSubmitPassword', { password }),
    logout: () => ipcRenderer.invoke('auth:logout'),
    avatar: () => ipcRenderer.invoke('auth:avatar'),
    // 多帳號
    list: () => ipcRenderer.invoke('auth:list'),
    switchAccount: (id) => ipcRenderer.invoke('auth:switch', { id }),
    beginAdd: () => ipcRenderer.invoke('auth:beginAdd'),
    cancelAdd: () => ipcRenderer.invoke('auth:cancelAdd'),
    removeAccount: (id) => ipcRenderer.invoke('auth:remove', { id })
  },

  // 協議號 / 直登號 帳號工具箱
  accounts: {
    import: (session, label, note) => ipcRenderer.invoke('accounts:import', { session, label, note }),
    importBatch: (text) => ipcRenderer.invoke('accounts:importBatch', { text }),
    export: (id) => ipcRenderer.invoke('accounts:export', { id }),
    health: (id) => ipcRenderer.invoke('accounts:health', { id }),
    healthAll: (ids) => ipcRenderer.invoke('accounts:healthAll', { ids }),
    setProfile: (id, profile) => ipcRenderer.invoke('accounts:setProfile', { id, profile }),
    setTwoFa: (id, params) => ipcRenderer.invoke('accounts:setTwoFa', { id, params }),
    terminateOthers: (id) => ipcRenderer.invoke('accounts:terminateOthers', { id }),
    setMeta: (id, patch) => ipcRenderer.invoke('accounts:setMeta', { id, patch }),
    // 協議號 ↔ 直登號(tdata)轉換
    sessionToTdata: (opts) => ipcRenderer.invoke('accounts:sessionToTdata', opts),
    tdataToSession: (tdataDir, accountIdx) => ipcRenderer.invoke('accounts:tdataToSession', { tdataDir, accountIdx })
  },

  // 代理
  proxy: {
    list: () => ipcRenderer.invoke('proxy:list'),
    save: (proxy) => ipcRenderer.invoke('proxy:save', proxy),
    remove: (id) => ipcRenderer.invoke('proxy:delete', { id }),
    setActive: (id) => ipcRenderer.invoke('proxy:setActive', { id }),
    test: (ip, port) => ipcRenderer.invoke('proxy:test', { ip, port }),
    ping: () => ipcRenderer.invoke('proxy:ping'),
    parseLink: (link) => ipcRenderer.invoke('proxy:parseLink', { link }),
    autodetect: () => ipcRenderer.invoke('proxy:autodetect')
  },

  // 系統設定
  settings: {
    getPreferences: () => ipcRenderer.invoke('settings:getPreferences'),
    setPreferences: (p) => ipcRenderer.invoke('settings:setPreferences', p),
    getPaths: () => ipcRenderer.invoke('settings:getPaths'),
    setPaths: (p) => ipcRenderer.invoke('settings:setPaths', p),
    pickFolder: (defaultPath) => ipcRenderer.invoke('settings:pickFolder', { defaultPath }),
    pickImage: () => ipcRenderer.invoke('settings:pickImage'),
    cacheInfo: () => ipcRenderer.invoke('settings:cacheInfo'),
    clearCache: () => ipcRenderer.invoke('settings:clearCache'),
    appInfo: () => ipcRenderer.invoke('settings:appInfo'),
    exportData: () => ipcRenderer.invoke('settings:exportData'),
    importData: () => ipcRenderer.invoke('settings:importData')
  },

  // 對話清單
  dialogs: {
    list: (opts) => ipcRenderer.invoke('dialogs:list', opts || {}),
    folders: () => ipcRenderer.invoke('dialogs:folders'),
    avatar: (peerId) => ipcRenderer.invoke('dialogs:avatar', { peerId }),
    addDialog: (username) => ipcRenderer.invoke('dialogs:addDialog', { username })
  },

  // 訊息流
  messages: {
    load: (dialogId, opts) => ipcRenderer.invoke('messages:load', { dialogId, ...(opts || {}) }),
    loadAround: (dialogId, msgId, limit) =>
      ipcRenderer.invoke('messages:loadAround', { dialogId, msgId, limit }),
    loadOldest: (dialogId, limit) => ipcRenderer.invoke('messages:loadOldest', { dialogId, limit }),
    loadNewer: (dialogId, opts) => ipcRenderer.invoke('messages:loadNewer', { dialogId, ...(opts || {}) }),
    thumb: (dialogId, msgId) => ipcRenderer.invoke('messages:thumb', { dialogId, msgId })
  },

  // 共享媒體(照片/影片/檔案/音訊/連結/語音/GIF/置頂)+ 共同群組 + 禮物
  shared: {
    kinds: () => ipcRenderer.invoke('shared:kinds'),
    counters: (dialogId) => ipcRenderer.invoke('shared:counters', { dialogId }),
    list: (dialogId, kind, opts) =>
      ipcRenderer.invoke('shared:list', { dialogId, kind, ...(opts || {}) }),
    calendar: (dialogId, kind, offsetId) =>
      ipcRenderer.invoke('shared:calendar', { dialogId, kind, offsetId }),
    scanPolls: (dialogId, maxScan) => ipcRenderer.invoke('shared:scanPolls', { dialogId, maxScan }),
    cancelPollScan: (dialogId) => ipcRenderer.invoke('shared:cancelPollScan', { dialogId }),
    commonChats: (peerId, limit) => ipcRenderer.invoke('shared:commonChats', { peerId, limit }),
    gifts: (peerId, offset, limit) => ipcRenderer.invoke('shared:gifts', { peerId, offset, limit })
  },

  // 下載
  download: {
    single: (dialogId, msgId) => ipcRenderer.invoke('download:single', { dialogId, msgId }),
    pause: (dialogId, msgId) => ipcRenderer.invoke('download:pause', { dialogId, msgId }),
    resume: (dialogId, msgId) => ipcRenderer.invoke('download:resume', { dialogId, msgId }),
    cancel: (dialogId, msgId) => ipcRenderer.invoke('download:cancel', { dialogId, msgId }),
    check: (dialogId, msgIds) => ipcRenderer.invoke('download:check', { dialogId, msgIds }),
    pending: () => ipcRenderer.invoke('download:pending'),
    reveal: (path) => ipcRenderer.invoke('download:reveal', { path }),
    openPath: (path) => ipcRenderer.invoke('shell:openPath', { path })
  },

  /** 用系統預設瀏覽器開連結(僅 http/https)。 */
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', { url }),

  // 消息檢索
  search: {
    run: (params) => ipcRenderer.invoke('search:run', params || {})
  },

  // 自動化
  automation: {
    list: () => ipcRenderer.invoke('automation:list'),
    create: (cfg) => ipcRenderer.invoke('automation:create', cfg),
    update: (id, patch) => ipcRenderer.invoke('automation:update', { id, patch }),
    toggle: (id, enabled) => ipcRenderer.invoke('automation:toggle', { id, enabled }),
    remove: (id) => ipcRenderer.invoke('automation:remove', { id })
  },

  // 文本導出
  export: {
    pickSave: (defaultName, format) => ipcRenderer.invoke('export:pickSave', { defaultName, format }),
    rows: (rows, format, outPath, meta) =>
      ipcRenderer.invoke('export:rows', { rows, format, outPath, meta }),
    dialog: (params) => ipcRenderer.invoke('export:dialog', params || {})
  },

  // 任務台(批量下載)
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    createDownload: (cfg) => ipcRenderer.invoke('tasks:createDownload', cfg),
    createForward: (cfg) => ipcRenderer.invoke('tasks:createForward', cfg),
    detail: (id) => ipcRenderer.invoke('tasks:detail', { id }),
    pause: (id) => ipcRenderer.invoke('tasks:pause', { id }),
    resume: (id) => ipcRenderer.invoke('tasks:resume', { id }),
    cancel: (id) => ipcRenderer.invoke('tasks:cancel', { id }),
    retry: (id) => ipcRenderer.invoke('tasks:retry', { id }),
    remove: (id, deleteFiles) => ipcRenderer.invoke('tasks:remove', { id, deleteFiles })
  },

  // 關閉視窗詢問(主程序問 → renderer 自繪對話框 → 回答)
  closeAck: () => ipcRenderer.invoke('win:closeAck'),
  closeAnswer: (ans) => ipcRenderer.invoke('win:closeAnswer', ans),

  /**
   * 訂閱事件。回傳取消訂閱函式。
   * @param {string} channel
   * @param {(payload:any)=>void} cb
   */
  on(channel, cb) {
    if (!EVENT_CHANNELS.has(channel)) throw new Error('未授權的事件頻道: ' + channel)
    const listener = (_e, payload) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
