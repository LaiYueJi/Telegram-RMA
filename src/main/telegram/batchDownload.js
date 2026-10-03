/**
 * 批量下載引擎:掃描對話 → 篩選 → 多檔並行下載(真加速)→ 大小驗證 → 任務級暫停/續傳/停止。
 * 任務持久化於 db(downloadTasks);明細(success/failed/pending)留記憶體。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { join, relative } from 'node:path'
import bigInt from 'big-integer'
import { getClient } from './client.js'
import { getCachedEntity, getCachedTitle } from './dialogs.js'
import { getMediaInfo, getDownloadableMedia, extForKind } from './media.js'
import { sanitize, buildFileName } from './download.js'
import { normalizeMessage, fetchRawMessage, fetchRawMessages } from './messages.js'
import { buildManifest, buildLink } from './exporter.js'
import { config } from '../store/config.js'
import { addDown } from '../net/speedmeter.js'
import { db } from '../store/db.js'

// upload.GetFile 單請求上限(1MB,MTProto 允許的最大值 → 高延遲代理少一半往返)
const REQUEST_SIZE = 1024 * 1024
const EMIT_INTERVAL = 350
const HARD_SCAN_CAP = 200000 // 掃描上限保護
const INDEX_MSG_CAP = 50000 // index.json 最多記幾則訊息(含純文字/系統訊息)

/** id → runtime task */
const tasks = new Map()
let sink = null
export function setTaskSink(fn) {
  sink = fn
}

function genId() {
  return 't' + Math.random().toString(36).slice(2, 9) + (db.get('downloadTasks')?.length || 0)
}

// —— 序列化 / 持久化 ——
// 明細也一起存,關掉程式再開啟時「詳情」才不會整片空白(上限保護,避免 db json 爆掉)
const PERSIST_CAP = 5000

function serialize(t, withDetail = false) {
  const base = {
    id: t.id,
    kind: 'download',
    accountId: t.accountId || null,
    title: t.title,
    dialogId: t.dialogId,
    dialogTitle: t.dialogTitle,
    filter: t.filter,
    output: t.output,
    status: t.status,
    error: t.error || '',
    stats: t.stats,
    createdAt: t.createdAt
  }
  if (!withDetail) return base
  return {
    ...base,
    stats: { ...t.stats, current: [] }, // 進行中的清單重開就沒意義了
    success: t._success.slice(0, PERSIST_CAP),
    failed: t._failed.slice(0, PERSIST_CAP),
    // 待下載只留顯示用的輕量資訊(raw message 沒辦法序列化),續傳時會重新掃描
    pendingInfo: t._pending.slice(0, PERSIST_CAP).map((m) => {
      const media = getMediaInfo(m)
      return {
        msgId: Number(m.id),
        name: nameOf(t, m),
        size: media?.size || 0,
        kind: media?.kind || '',
        date: m.date || 0
      }
    })
  }
}
function persist() {
  db.set(
    'downloadTasks',
    [...tasks.values()].map((t) => serialize(t, true))
  )
}
function emit(t, force = false) {
  const now = nowMs()
  if (!force && now - (t._lastEmit || 0) < EMIT_INTERVAL) return

  // 任務總速率:用兩次 emit 之間的位元組增量,EMA 平滑(代理是一陣一陣到的,不平滑會亂跳)
  const dt = t._lastEmit ? (now - t._lastEmit) / 1000 : 0
  if (dt > 0.05) {
    const inst = Math.max(0, t.stats.bytes - (t._lastBytes || 0)) / dt
    t.stats.speed = t.stats.speed ? t.stats.speed * 0.6 + inst * 0.4 : inst
    const remain = Math.max(0, (t.stats.totalBytes || 0) - doneBytes(t))
    t.stats.eta = t.stats.speed > 1024 ? Math.round(remain / t.stats.speed) : 0
  }
  if (t.status !== 'downloading') {
    t.stats.speed = 0
    t.stats.eta = 0
  }
  t._lastBytes = t.stats.bytes
  t._lastEmit = now

  t.stats.current = [...t._active.values()]
  t.stats.doneBytes = doneBytes(t)
  sink?.(serialize(t))
  persist()
}

/**
 * 已完成的位元組 = 成功清單的大小總和 + 進行中已收到的。
 * ⚠️ 不能用「這次執行累加了多少」——那個重開程式就歸零,但檔案數(stats.downloaded)是存檔的,
 * 兩邊基準不同就會出現「11/11 完成但只顯示 8.32/11.17 GB」。成功清單有存檔,拿它算才對得起來。
 */
function doneBytes(t) {
  let n = t._doneBytes || 0
  for (const c of t._active.values()) n += c.loaded || 0
  return n
}

/** 加一筆成功(依 msgId 去重,重掃同一個任務不會重複計算)。 */
function addSuccess(t, entry) {
  if (t._successIds.has(entry.msgId)) return false
  t._successIds.add(entry.msgId)
  t._success.push(entry)
  recount(t)
  return true
}
/** 加一筆失敗(同樣去重)。 */
function addFailed(t, entry, rawMsg) {
  if (rawMsg) t._failedMsgs.set(entry.msgId, rawMsg)
  const i = t._failed.findIndex((f) => f.msgId === entry.msgId)
  if (i >= 0) t._failed[i] = entry
  else t._failed.push(entry)
  recount(t)
}
/** 由清單重算統計(冪等 → 重掃/續傳/重開程式都不會算錯)。 */
function recount(t) {
  // 1.0.7 之前的任務沒有存明細,沒有清單就無從重算 —— 保留舊數字別歸零,
  // 等使用者按「重新掃描補下載」跑一次(已存在的檔案會被略過)清單才會補齊。
  if (t._legacyStats && !t._success.length && !t._failed.length) {
    t._doneBytes = t.stats.doneBytes || 0
    return
  }
  t._legacyStats = false
  let dl = 0
  let sk = 0
  let bytes = 0
  let allSized = true
  for (const s of t._success) {
    if (s.skipped) sk++
    else dl++
    bytes += s.size || 0
    if (!s.size) allSized = false
  }
  t.stats.downloaded = dl
  t.stats.skipped = sk
  t.stats.failed = t._failed.length
  t._doneBytes = bytes
  // 這裡就寫回 stats,已完成的任務重開程式後不會再 emit,不寫的話畫面永遠是舊的錯數字
  t.stats.doneBytes = bytes

  // 修正舊版留下的 totalBytes:
  // 以前相片大小算錯、重掃又會把 totalBytes 疊加,導致「檔案全好了進度條卻不滿」。
  // 任務已完成且沒有失敗 → 成功清單的總和就是真正的總容量,直接對齊。
  const finished = t.status === 'done' && !t._failed.length && !t._pending.length
  if (finished && allSized && bytes > 0) t.stats.totalBytes = bytes
  else if (bytes > (t.stats.totalBytes || 0)) t.stats.totalBytes = bytes // 下載量不可能超過總量
}
// Date.now() 在某些環境受限,用 performance 後援
function nowMs() {
  try {
    return Date.now()
  } catch {
    return 0
  }
}

// —— 啟動載入(把上次中斷的任務標記) ——
export function initTasks() {
  const saved = db.get('downloadTasks') || []
  for (const s of saved) {
    const t = makeRuntime(s)
    if (['scanning', 'downloading', 'queued'].includes(t.status)) {
      t.status = 'interrupted'
    }
    tasks.set(t.id, t)
  }
}
function blankStats() {
  return {
    matched: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    bytes: 0, // 實際下載的位元組(網路量)
    total: 0, // 檔案數
    totalBytes: 0, // 掃描到的檔案總大小 → 「已下載 / 共 X GB」
    doneBytes: 0, // 已完成的位元組(含略過的既有檔、進行中已收到的)
    speed: 0, // bytes/sec
    eta: 0, // 秒
    current: []
  }
}
function makeRuntime(s) {
  const t = {
    ...s,
    stats: { ...blankStats(), ...(s.stats || {}) },
    _doneBytes: 0, // 由 recount() 依 _success 算出來
    _lastBytes: 0,
    _pending: [],
    _active: new Map(), // msgId → { name, pct }
    // 明細從 db 還原(關掉程式再開,詳情不會整片空白)
    _success: s.success || [],
    _failed: s.failed || [],
    _pendingInfo: s.pendingInfo || [], // 上次還沒下載的(只有顯示用資訊,續傳時重新掃描才會有 raw)
    _failedMsgs: new Map(), // msgId → raw message,供「重試失敗項目」用
    _records: [], // (保留欄位,實際索引改用 _allMsgs)
    _allMsgs: new Map(), // 網頁檢視器索引:整段對話(含純文字/系統訊息),id → 正規化訊息
    _abort: false,
    _paused: false,
    _lastEmit: 0
  }
  // 舊版任務(1.0.7 之前)沒有存明細清單,recount 要能認出來別把數字歸零
  t._legacyStats = !Array.isArray(s.success)
  t._successIds = new Set(t._success.map((x) => x.msgId))
  // 舊版存的成功項目沒有 size,補一次(用實際檔案大小),不然進度條永遠差一截
  let repaired = 0
  for (const s2 of t._success) {
    if (s2.size || !s2.path || repaired > 2000) continue
    try {
      s2.size = fs.statSync(s2.path).size
      repaired++
    } catch {
      /* 檔案被移走就算了 */
    }
  }
  recount(t)
  return t
}

export function hasTask(id) {
  return tasks.has(id)
}
/** 是否有進行中的下載任務(切換/新增帳號前用來擋下)。 */
export function hasActiveDownloadTasks() {
  return [...tasks.values()].some((t) => ['scanning', 'downloading', 'queued'].includes(t.status))
}
export function listTasks() {
  return [...tasks.values()].map(serialize).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
}
export function taskDetail(id) {
  const t = tasks.get(id)
  if (!t) return { ok: false }
  return {
    ok: true,
    dialogId: t.dialogId, // 讓前端能跳回對話裡的那則訊息
    dialogTitle: t.dialogTitle,
    current: [...t._active.values()].map((c) => ({
      msgId: c.msgId,
      name: c.name,
      size: c.size || 0,
      loaded: c.loaded || 0,
      pct: c.pct || 0,
      speed: c.speed || 0,
      kind: c.kind || ''
    })),
    // 記憶體裡有 raw 就用 raw;重開程式後還沒重掃 → 用上次存下來的輕量清單
    pending: t._pending.length
      ? t._pending.map((m) => {
          const media = getMediaInfo(m)
          return {
            msgId: Number(m.id),
            name: nameOf(t, m),
            size: media?.size || 0,
            kind: media?.kind || '',
            date: m.date || 0
          }
        })
      : t._pendingInfo,
    success: t._success,
    failed: t._failed
  }
}

// —— 建立任務 ——
export function createDownloadTask(cfg) {
  const t = makeRuntime({
    id: genId(),
    accountId: config.getActiveAccountId() || null,
    title: cfg.title || `批量下載 ${new Date().toLocaleString?.() || ''}`.trim(),
    dialogId: String(cfg.dialogId),
    dialogTitle: cfg.dialogTitle || getCachedTitle(cfg.dialogId),
    filter: cfg.filter || {},
    output: cfg.output || {},
    status: 'queued',
    stats: blankStats(),
    createdAt: cfg.createdAt || 0
  })
  tasks.set(t.id, t)
  emit(t, true)
  runTask(t).catch((e) => {
    t.status = 'error'
    t.error = String(e?.message || e)
    emit(t, true)
  })
  return { ok: true, id: t.id }
}

// —— 篩選 ——
function passFilter(msg, f) {
  // downloadableOnly:擋掉服務訊息的換頭像圖、連結預覽縮圖 —— 它們有 photo 但沒有可下載的位置
  const media = getMediaInfo(msg, { downloadableOnly: true })
  if (!media) return null
  if (f.types?.length && !f.types.includes(media.kind)) return null
  if (f.startDate && msg.date < f.startDate) return null
  if (f.endDate && msg.date > f.endDate) return null
  const text = msg.message || ''
  if (f.keyword && !text.includes(f.keyword)) return null
  if (f.reverseKeyword && text.includes(f.reverseKeyword)) return null
  if (f.minSize && (media.size || 0) < f.minSize) return null
  if (f.maxSize && media.size && media.size > f.maxSize) return null
  if (f.minDuration && (media.duration || 0) < f.minDuration) return null
  if (f.maxDuration && media.duration && media.duration > f.maxDuration) return null
  if (f.fromId && String(msg.senderId || '') !== String(f.fromId)) return null
  return media
}

// —— 輸出路徑 ——
function two(n) {
  return String(n).padStart(2, '0')
}
function dateFolder(unix) {
  const d = new Date(unix * 1000)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}
function nameOf(t, msg) {
  const media = getMediaInfo(msg)
  if (!media) return String(msg.id)
  const o = t.output || {}
  const ext = extForKind(media.kind, media.mime)
  if (o.nameRule === 'dateId') {
    const d = new Date(msg.date * 1000)
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}_${msg.id}.${ext}`
  }
  if (o.nameRule === 'content' && (msg.message || '').trim()) {
    return sanitize(msg.message.slice(0, o.maxNameLen || 50)) + '.' + ext
  }
  return buildFileName(msg, media)
}
/** 該任務的輸出根目錄(索引 index.json 就放這裡)。 */
function rootDirOf(t) {
  const o = t.output || {}
  const base = o.root || config.getPaths().saveRoot
  return join(base, sanitize(t.dialogTitle || getCachedTitle(t.dialogId)))
}
function outPathOf(t, msg) {
  const o = t.output || {}
  let dir = rootDirOf(t)
  const media = getMediaInfo(msg)
  if (o.subfolderByType && media) dir = join(dir, media.kind)
  if (o.subfolderByDate) dir = join(dir, dateFolder(msg.date))
  return join(dir, nameOf(t, msg))
}

// —— .part 標記檔:告訴開機時的孤兒清理「這個半成品是批量任務的,別刪」——
function markPath(partPath) {
  return partPath + '.batch.json'
}
function writePartMark(partPath, info) {
  try {
    fs.writeFileSync(markPath(partPath), JSON.stringify({ v: 1, ...info }))
  } catch {
    /* 寫不進去頂多是下次不能續傳,不影響本次下載 */
  }
}
function readPartMark(partPath) {
  try {
    return JSON.parse(fs.readFileSync(markPath(partPath), 'utf8'))
  } catch {
    return null
  }
}
function clearPartMark(partPath) {
  try {
    fs.unlinkSync(markPath(partPath))
  } catch {
    /* 不存在就算了 */
  }
}

/** 記一筆給網頁檢視器索引用(相對路徑,才能整包搬走)。 */
function record(t, msg, outPath) {
  if (!t.output?.writeIndex) return
  const id = Number(msg.id)
  const rel = relative(rootDirOf(t), outPath).split('\\').join('/')
  // 掃描時已經把整段對話都放進 _allMsgs 了,這裡只要把「下載到的檔案路徑」補上去
  const existing = t._allMsgs.get(id)
  if (existing) {
    if (existing.media) existing.media.file = rel
    return
  }
  const norm = normalizeMessage(msg, { withThumb: false }) // base64 縮圖會把 index.json 撐爆
  if (!norm) return
  norm.link = buildLink(norm.id, t.dialogId)
  if (norm.media) norm.media.file = rel
  t._allMsgs.set(id, norm)
}

/** 寫出 index.json(tgview 網頁檢視器可直接讀)。 */
async function writeIndexFile(t) {
  if (!t.output?.writeIndex || !t._allMsgs.size) return
  try {
    const dir = rootDirOf(t)
    await fsp.mkdir(dir, { recursive: true })
    // 依訊息 id 排序 = Telegram 原本的對話順序(同一組相簿的多張圖 date 相同,只有 id 分得出先後)
    const records = [...t._allMsgs.values()].sort((a, b) => (a.id || 0) - (b.id || 0))
    const manifest = buildManifest(records, {
      dialogId: t.dialogId,
      dialogTitle: t.dialogTitle || getCachedTitle(t.dialogId)
    })
    await fsp.writeFile(join(dir, 'index.json'), JSON.stringify(manifest, null, 2), 'utf8')
  } catch (e) {
    t.error = t.error || '索引寫入失敗:' + String(e?.message || e)
  }
}

// —— 主流程:掃描 → 下載 ——
async function runTask(t) {
  const entity = getCachedEntity(t.dialogId)
  if (!entity) {
    t.status = 'error'
    t.error = '對話未載入,請先在對話頁開啟一次'
    emit(t, true)
    return
  }
  const client = getClient()
  if (!client.connected) {
    t.status = 'error'
    t.error = '尚未連線'
    emit(t, true)
    return
  }

  t.status = 'scanning'
  t._records = [] // 重掃就重建索引,避免重複
  t._allMsgs = new Map()
  // 重掃時總容量要歸零重算,否則會疊加上一輪的數字(進度條直接爆掉)
  t.stats.totalBytes = 0
  t.stats.matched = 0
  emit(t, true)

  const f = t.filter || {}
  const opts = {}
  if (f.keyword) opts.search = f.keyword
  if (f.endDate) opts.offsetDate = f.endDate
  const cap = config.getPreferences().batchDownloadLimit || 5000

  let scanned = 0
  try {
    for await (const msg of client.iterMessages(entity, opts)) {
      if (t._abort) return finishCanceled(t)
      scanned++
      if (scanned > HARD_SCAN_CAP) break
      if (f.startDate && msg.date < f.startDate) break // 已過開始日期,停止往更舊掃
      // 索引要記「整段對話」,不是只記下載到的檔案 ——
      // 純文字訊息、系統訊息、沒下載的媒體都留一筆,檢視器才看得到完整脈絡與正確順序
      if (t.output?.writeIndex && t._allMsgs.size < INDEX_MSG_CAP) {
        const norm = normalizeMessage(msg, { withThumb: false })
        if (norm) {
          norm.link = buildLink(norm.id, t.dialogId)
          t._allMsgs.set(Number(msg.id), norm)
        }
      }
      const media = passFilter(msg, f)
      if (media) {
        t._pending.push(msg)
        t.stats.matched = t._pending.length
        t.stats.totalBytes += media.size || 0 // 先算總容量,使用者才知道要下載多少
        if (t._pending.length >= cap) break
      }
      if (scanned % 100 === 0) emit(t)
    }
  } catch (e) {
    t.status = 'error'
    t.error = '掃描失敗:' + String(e?.message || e)
    emit(t, true)
    return
  }

  t.stats.total = t.stats.matched
  if (!t._pending.length) {
    t.status = 'done'
    emit(t, true)
    return
  }
  await runDownloads(t)
}

async function runDownloads(t) {
  t.status = 'downloading'
  emit(t, true)
  const concurrency = Math.max(1, Math.min(16, config.getPreferences().batchConcurrency || 4))
  const worker = async () => {
    while (true) {
      if (t._abort || t._paused) return
      const msg = t._pending.shift()
      if (!msg) return
      await downloadOne(t, msg)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))

  if (t._abort) return finishCanceled(t)
  if (t._paused) {
    t.status = 'paused'
    await writeIndexFile(t)
    emit(t, true)
    return
  }
  await writeIndexFile(t)
  t.status = 'done'
  recount(t) // 收尾再算一次:狀態變 done 後總容量才會對齊實際下載總量,進度條才會真的到底
  emit(t, true)
}

function finishCanceled(t) {
  t.status = 'canceled'
  t._pending = []
  t._active.clear()
  emit(t, true)
}

async function downloadOne(t, msg) {
  const media = getMediaInfo(msg)
  if (!media) return
  let fileLoc = getDownloadableMedia(msg)
  if (!fileLoc) {
    // 理論上 passFilter 就擋掉了,這裡是保險:寧可標一筆失敗,也不要整個任務被例外打斷
    addFailed(t, {
      msgId: Number(msg.id),
      name: nameOf(t, msg),
      size: media.size || 0,
      error: '這則訊息沒有可下載的檔案(服務訊息頭像或連結預覽圖)'
    })
    emit(t)
    return
  }
  const id = Number(msg.id)
  const name = nameOf(t, msg)
  const outPath = outPathOf(t, msg)
  // 相片的 size 是推估的,不能拿來做嚴格比對(見 media.js#photoByteSize)
  const isPhoto = fileLoc.className === 'MessageMediaPhoto'

  // 已存在就略過。檔案是 .part 驗證通過才 rename 過來的,所以「存在」本身就代表下載完整;
  // 文件再多比一次 size 當保險,相片只要不是空檔就算數。
  try {
    const st = fs.statSync(outPath)
    if (isPhoto ? st.size > 0 : media.size && st.size === media.size) {
      addSuccess(t, { msgId: id, name, path: outPath, size: st.size || media.size, skipped: true })
      record(t, msg, outPath) // 已存在的檔案也要進索引
      emit(t)
      return
    }
  } catch {
    /* 不存在 */
  }

  fs.mkdirSync(join(outPath, '..'), { recursive: true })
  const partPath = outPath + '.part'
  t._active.set(id, {
    msgId: id,
    name,
    pct: 0,
    loaded: 0,
    size: media.size || 0,
    speed: 0,
    kind: media.kind,
    _ts: nowMs(),
    _b: 0
  })

  const MAX_RETRY = 3
  const MAX_REFRESH = 3 // fileReference 過期最多重抓幾次(大檔下到一半過期是常態)
  let refreshes = 0
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    let fd
    try {
      // —— 續傳:上次留下的 .part 從中斷點接著下,不用整個重來 ——
      // 起點必須對齊 REQUEST_SIZE,否則 GramJS 會走未對齊路徑多抓一輪(專案裡踩過)
      let resumeAt = 0
      try {
        const pst = fs.statSync(partPath)
        // 檔案大小要跟標記檔對得上,才敢接著寫(不然可能是別的檔案留下的同名殘骸)
        const mark = readPartMark(partPath)
        const sameFile = !mark || !media.size || mark.total === media.size
        if (pst.size > 0 && sameFile && (!media.size || pst.size < media.size)) {
          resumeAt = Math.floor(pst.size / REQUEST_SIZE) * REQUEST_SIZE
        }
      } catch {
        /* 沒有 .part = 全新下載 */
      }
      // 標記這個 .part 屬於批量任務,開機時的孤兒清理才不會把它刪掉
      writePartMark(partPath, { taskId: t.id, dialogId: t.dialogId, msgId: id, total: media.size || 0 })

      fd = await fsp.open(partPath, resumeAt > 0 ? 'r+' : 'w')
      if (resumeAt > 0) await fd.truncate(resumeAt) // 砍掉未對齊的尾巴,從乾淨的邊界接
      let pos = resumeAt
      const cur0 = t._active.get(id)
      if (cur0) {
        cur0.loaded = resumeAt
        cur0._b = resumeAt
        if (media.size) cur0.pct = Math.min(100, Math.round((resumeAt / media.size) * 100))
      }

      const iter = getClient().iterDownload({
        file: fileLoc,
        offset: bigInt(resumeAt),
        fileSize: bigInt(media.size || 0),
        requestSize: REQUEST_SIZE
      })
      try {
        for await (const chunk of iter) {
          if (t._abort || t._paused) {
            try {
              await iter.return?.()
            } catch {
              /* ignore */
            }
            await fd.close()
            t._active.delete(id)
            if (t._abort) {
              // 使用者按停止 → 半成品清掉,不要在硬碟上留一堆 .part
              try {
                await fsp.unlink(partPath)
              } catch {
                /* ignore */
              }
              clearPartMark(partPath)
            } else {
              // 暫停 → 保留 .part,放回佇列等續傳
              t._pending.unshift(msg)
            }
            return
          }
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          await fd.write(buf, 0, buf.length, pos)
          pos += buf.length
          t.stats.bytes += buf.length
          addDown(buf.length)
          const cur = t._active.get(id)
          if (cur) {
            cur.loaded = pos
            if (media.size) cur.pct = Math.min(100, Math.round((pos / media.size) * 100))
            // 單檔速率:兩次取樣間的增量,EMA 平滑
            const now = nowMs()
            const dt = (now - (cur._ts || now)) / 1000
            if (dt > 0.25) {
              const inst = (pos - (cur._b || 0)) / dt
              cur.speed = cur.speed ? cur.speed * 0.6 + inst * 0.4 : inst
              cur._ts = now
              cur._b = pos
            }
          }
          emit(t)
        }
      } finally {
        try {
          await iter.return?.()
        } catch {
          /* ignore */
        }
      }
      await fd.close()
      fd = null

      // 大小驗證:document.size 是伺服器給的精確值,不符就是沒下完 → 判失敗;
      // 相片沒有精確 size(是從 PhotoSize 推的),只要有內容就算成功,否則會被誤判。
      const st = await fsp.stat(partPath)
      if (isPhoto) {
        if (st.size <= 0) throw new Error('下載到空檔案')
      } else if (media.size && st.size !== media.size) {
        throw new Error(`大小不符(${st.size}/${media.size})`)
      }
      await fsp.rename(partPath, outPath)
      clearPartMark(partPath)

      // 訊息文字另存
      if (t.output?.saveText && (msg.message || '').trim()) {
        fsp.writeFile(outPath + '.txt', msg.message).catch(() => {})
      }

      addSuccess(t, { msgId: id, name, path: outPath, size: st.size || media.size || 0 })
      record(t, msg, outPath)
      t._active.delete(id)
      emit(t)
      return
    } catch (e) {
      if (fd) {
        try {
          await fd.close()
        } catch {
          /* ignore */
        }
      }
      const errMsg = String(e?.errorMessage || e?.message || e)

      // fileReference 過期:Telegram 給的檔案憑證只活幾十分鐘,大檔下到一半過期是常態。
      // 重新抓一次那則訊息就會拿到新的 reference,.part 保留著所以是接續下載、不是重來。
      if (/FILE_REFERENCE_(EXPIRED|INVALID)/.test(errMsg) && refreshes < MAX_REFRESH && !t._abort) {
        refreshes++
        const fresh = await fetchRawMessage(t.dialogId, id)
        const nextLoc = fresh ? getDownloadableMedia(fresh) : null
        if (nextLoc) {
          msg = fresh
          fileLoc = nextLoc
          attempt-- // 換憑證不算失敗,不消耗一般重試次數
          continue
        }
      }

      // FloodWait 退避重試
      const flood = /FLOOD_WAIT_(\d+)/.exec(errMsg) || (e?.seconds ? [null, e.seconds] : null)
      if (flood && attempt < MAX_RETRY) {
        const wait = Math.min(60, Number(flood[1]) || 5)
        await sleep((wait + 1) * 1000)
        continue
      }
      if (attempt < MAX_RETRY && !t._abort && !t._paused) {
        await sleep(1500 * (attempt + 1))
        continue
      }
      // 失敗:大小不符代表這個 .part 壞了,砍掉重來;其他(斷線/逾時)保留半成品,
      // 之後按「重試失敗」或續傳就能從中斷點接下去,不用整檔重抓。
      if (/大小不符/.test(errMsg)) {
        try {
          await fsp.unlink(partPath)
        } catch {
          /* ignore */
        }
        clearPartMark(partPath)
      }
      addFailed(t, { msgId: id, name, size: media.size || 0, error: friendlyError(errMsg) }, msg)
      t._active.delete(id)
      emit(t)
      return
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Telegram 的原始錯誤碼翻成看得懂的說明(後面保留原文方便對照)。 */
function friendlyError(raw) {
  const map = [
    [/FILE_REFERENCE_(EXPIRED|INVALID)/, '檔案憑證過期,重抓訊息後仍失敗(可按「重試失敗」再試一次)'],
    [/FLOOD_WAIT_(\d+)/, '被 Telegram 限流,請稍後再試'],
    [/TIMEOUT/, '連線逾時(代理可能過慢或不穩)'],
    [/FILE_ID_INVALID/, '檔案 ID 無效(訊息可能已被刪除或編輯)'],
    [/MSG_ID_INVALID|MESSAGE_IDS_EMPTY/, '訊息已不存在'],
    [/AUTH_KEY|SESSION_REVOKED/, '登入階段失效,請重新登入'],
    [/大小不符/, '下載完成但檔案大小不符,已捨棄重來']
  ]
  for (const [re, msg] of map) {
    if (re.test(raw)) return `${msg}(${raw})`
  }
  return raw
}

// —— 控制 ——
export function pauseTask(id) {
  const t = tasks.get(id)
  if (!t || t.status !== 'downloading') return { ok: false }
  t._paused = true
  return { ok: true }
}
export async function resumeTask(id) {
  const t = tasks.get(id)
  if (!t) return { ok: false }
  if (t.accountId && t.accountId !== (config.getActiveAccountId() || null)) {
    return { ok: false, error: '此任務屬於其他帳號,請先切回該帳號再續傳' }
  }
  if (t.status === 'interrupted') {
    // 中斷的任務重新執行(重新掃描)
    t._abort = false
    t._paused = false
    t._pending = []
    runTask(t).catch(() => {})
    return { ok: true }
  }
  if (t.status !== 'paused') return { ok: false }
  t._paused = false
  runDownloads(t).catch(() => {})
  return { ok: true }
}
/**
 * 重試這個任務裡失敗的檔案。
 * 三層後援:
 *   1. 記憶體還有原始訊息 → 直接放回佇列(最快)
 *   2. 重開過程式 → 依 msgId 向伺服器補抓(順便拿到新的 fileReference)
 *   3. 連失敗明細都沒有(舊版任務)→ 整個任務重掃一次;已下載好的檔案會被大小比對略過
 */
export async function retryFailedTask(id) {
  const t = tasks.get(id)
  if (!t) return { ok: false, error: '找不到任務' }
  if (['scanning', 'downloading'].includes(t.status)) {
    return { ok: false, error: '任務進行中,請等結束或先暫停' }
  }
  if (t.accountId && t.accountId !== (config.getActiveAccountId() || null)) {
    return { ok: false, error: '此任務屬於其他帳號,請先切回該帳號' }
  }

  let msgs = [...t._failedMsgs.values()]

  // 2) 記憶體沒有(重開程式後)→ 用存下來的失敗清單去補抓
  if (!msgs.length && t._failed.length) {
    if (!getClient()?.connected) return { ok: false, error: '尚未連線,無法重新取得訊息' }
    msgs = await fetchRawMessages(
      t.dialogId,
      t._failed.map((f) => f.msgId)
    )
  }

  const resetCounters = () => {
    t._failed = []
    t._failedMsgs = new Map()
    t.error = ''
    t._abort = false
    t._paused = false
    recount(t) // stats.failed / downloaded / skipped / doneBytes 一律由清單重算
  }

  // 3) 什麼明細都沒有 → 重掃整個任務(已完成的檔案會被略過,只補沒下到的)
  if (!msgs.length) {
    if (!t.stats.failed && !t._failed.length) {
      return { ok: false, error: '這個任務沒有失敗的項目' }
    }
    if (!getClient()?.connected) return { ok: false, error: '尚未連線,無法重新掃描' }
    resetCounters()
    t._pending = []
    emit(t, true)
    runTask(t).catch((e) => {
      t.status = 'error'
      t.error = String(e?.message || e)
      emit(t, true)
    })
    return { ok: true, count: 0, rescanned: true }
  }

  const n = msgs.length
  resetCounters()
  t._pending.push(...msgs)
  emit(t, true)
  runDownloads(t).catch((e) => {
    t.status = 'error'
    t.error = String(e?.message || e)
    emit(t, true)
  })
  return { ok: true, count: n }
}

export function cancelTask(id) {
  const t = tasks.get(id)
  if (!t) return { ok: false }
  t._abort = true
  t._paused = false
  return { ok: true }
}
/**
 * 移除任務。
 * @param {string} id
 * @param {{deleteFiles?:boolean}} opts deleteFiles=true 會連同這個任務下載到的檔案一起刪掉
 *        (只刪成功清單裡記錄的路徑 + 對應的 .txt/.part,不會亂刪別的東西)
 */
export function removeTask(id, opts = {}) {
  const t = tasks.get(id)
  if (t) t._abort = true

  let deleted = 0
  let freed = 0
  if (t && opts.deleteFiles) {
    for (const s of t._success) {
      if (!s.path) continue
      try {
        const st = fs.statSync(s.path)
        fs.unlinkSync(s.path)
        deleted++
        freed += st.size || 0
      } catch {
        /* 檔案已不在就跳過 */
      }
      for (const extra of [s.path + '.txt', s.path + '.part', s.path + '.part.batch.json']) {
        try {
          fs.unlinkSync(extra)
        } catch {
          /* 沒有就算了 */
        }
      }
    }
    // 連索引與空掉的資料夾一起收乾淨
    try {
      fs.unlinkSync(join(rootDirOf(t), 'index.json'))
    } catch {
      /* ignore */
    }
    removeEmptyDirs(rootDirOf(t))
  }

  tasks.delete(id)
  persist()
  return { ok: true, deleted, freed }
}

/** 由深往淺刪掉空資料夾(只在使用者選了「同時刪除檔案」時用)。 */
function removeEmptyDirs(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isDirectory()) removeEmptyDirs(join(dir, e.name))
  }
  try {
    if (!fs.readdirSync(dir).length) fs.rmdirSync(dir)
  } catch {
    /* 還有東西就留著 */
  }
}
