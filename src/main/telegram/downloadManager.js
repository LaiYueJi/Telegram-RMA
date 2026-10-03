/**
 * 下載管理器(主程序側門面)。
 *
 * 真正的下載 + MTProto 解密 + 寫檔在 downloadWorker.js(獨立 worker 執行緒)。主執行緒只負責:
 *   1) 前置檢查:去重、磁碟已存在跳過;
 *   2) 解析檔案位置(dcId + InputFileLocation)與存檔路徑,序列化後丟給 worker;
 *   3) 把 worker 回報的進度轉給 UI(sink)與網速計(addDown)。
 *
 * 這樣高吞吐下載完全不佔用主執行緒 → UI 順、切對話不會因主執行緒被卡而報「尚未連線」。
 * worker 綁定「目前 session + 代理」;帳號/代理/登出變更時以簽章比對自動重建(或由 client.js 主動收掉)。
 */
import fs from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { utils } from 'telegram'
import { getCachedTitle } from './dialogs.js'
import { getRawMessage, fetchRawMessage } from './messages.js'
import { getMediaInfo, getDownloadableMedia } from './media.js'
import { config } from '../store/config.js'
import { addDown } from '../net/speedmeter.js'
import { sanitize, buildFileName } from './download.js'
import { buildProxy, resolveCredentials } from './client.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MAX_SEGMENTS = 32
// 代理下載:改用「單一連線 + 管線化多個 in-flight 請求」。
// 多條 TCP 走 FakeTLS 代理會互相搶握手、被代理限流、斷線就一起自動重連 → ClientHello 風暴 +
// 事件塞車 + 取消失效 + 打爆代理。單一連線把這些全消除;靠同一連線上多個 in-flight GetFile
// 管線化來隱藏高延遲、維持吞吐(不需要多條 TCP)。
const PROXY_PIPELINE = 8 // 單一代理連線上的 in-flight 請求數(= 分段數)

/** key(`dialogId:msgId`) → 主程序側輕量任務狀態(實際下載在 worker)。 */
const tasks = new Map()
function keyOf(dialogId, msgId) {
  return `${dialogId}:${msgId}`
}

/** 進度推播 sink,由 ipc 注入。 */
let sink = null
export function setProgressSink(fn) {
  sink = fn
}

/* ---------- worker 生命週期 ---------- */
let worker = null
let workerSig = ''

/** 目前「session + 代理 + 帳號」的簽章,用來偵測需不需要重建 worker。 */
function currentSig() {
  const p = config.getActiveProxy()
  return JSON.stringify({
    acc: config.getActiveAccountId(),
    proxy: p ? p.id : '',
    sess: (config.getSession() || '').slice(-24)
  })
}

function onWorkerMessage(m) {
  if (!m || m.type !== 'progress') return
  const p = m.payload
  const key = keyOf(p.dialogId, p.msgId)
  const task = tasks.get(key)
  if (task) {
    // 已要求取消 → 忽略殘留的中間進度,只等 worker 的最終 canceled
    if (task.status === 'canceled' && p.status !== 'canceled') return
    // 已在主程序端標記暫停(如切換代理)→ 忽略 worker 殘留的「下載中」進度,避免 UI 又跳回下載中而卡死
    if (task.status === 'paused' && p.status === 'downloading') return
    const delta = (p.downloaded || 0) - (task.lastDownloaded || 0)
    if (delta > 0) addDown(delta) // 餵網速計
    task.lastDownloaded = p.downloaded || 0
    task.status = p.status
    if (p.status === 'done' || p.status === 'error' || p.status === 'canceled') tasks.delete(key)
  }
  sink?.(p)
}

/** worker 崩潰 → 把現存任務全部標記錯誤,讓 UI 收尾。 */
function failAll(error) {
  for (const [key, task] of tasks) {
    sink?.({
      dialogId: task.dialogId,
      msgId: task.msgId,
      status: 'error',
      downloaded: task.lastDownloaded || 0,
      total: task.total || 0,
      path: task.path,
      error
    })
    tasks.delete(key)
  }
}

/** 取得(或依目前 session/代理重建)下載 worker。 */
function ensureWorker() {
  const sig = currentSig()
  if (worker && sig === workerSig) return worker
  if (worker) {
    try {
      worker.terminate()
    } catch {
      /* ignore */
    }
    worker = null
  }
  const { apiId, apiHash } = resolveCredentials()
  const wd = { session: config.getSession() || '', apiId, apiHash, proxy: buildProxy() || null }
  const w = new Worker(join(__dirname, 'downloadWorker.js'), { workerData: wd })
  w.on('message', onWorkerMessage)
  w.on('error', (e) => failAll(String(e?.message || e)))
  w.on('exit', () => {
    if (worker === w) worker = null
  })
  worker = w
  workerSig = sig
  return w
}

/**
 * 換代理 / 換帳號 / 登出時呼叫:收掉下載 worker(下次下載會以新設定重建)。
 * 進行中的下載改標記為「暫停」而非報錯 —— .part 與進度檔(.part.json)都保留在磁碟,
 * 使用者按「繼續」即可從斷點續傳(檔案位元組與走哪條代理無關,沒必要丟掉已下載的進度)。
 * worker 是硬終止的,但進度檔在下載途中已節流落地(最多差幾秒),續傳時會讀它還原分段。
 */
export function resetDownloadWorker() {
  const w = worker
  worker = null
  workerSig = ''
  if (w) {
    // 先移除監聽器再終止:避免 terminate 前佇列裡殘留的「下載中」進度事件在標記暫停「之後」才被處理,
    // 把 UI 又翻回下載中 → 與主程序端的 paused 狀態不一致而卡死(按暫停/繼續都沒反應)。
    try {
      w.removeAllListeners()
    } catch {
      /* ignore */
    }
    try {
      w.terminate()
    } catch {
      /* ignore */
    }
  }
  for (const task of tasks.values()) {
    if (task.status !== 'downloading') continue
    task.status = 'paused'
    task.segs = null // worker 記憶體斷點已隨終止失效;續傳時改讀磁碟進度檔
    sink?.({
      dialogId: task.dialogId,
      msgId: task.msgId,
      status: 'paused',
      downloaded: task.lastDownloaded || 0,
      total: task.total || 0,
      path: task.path
    })
  }
}

/* ---------- 路徑 / 並發規劃 ---------- */
function finalPathFor(dialogId, msg, media) {
  const root = config.getPaths().saveRoot
  const dir = join(root, sanitize(getCachedTitle(dialogId)))
  return { dir, path: join(dir, buildFileName(msg, media)) }
}

/** 想要的連線數(各自一條 TCP)。預設 4,可由偏好調 1~8。 */
function connectionCount() {
  const pref = Number(config.getPreferences().downloadConnections) || 4
  return Math.max(1, Math.min(8, pref))
}

/**
 * 規劃並發:連線數 + 分段數(= 總在途請求數)。全自動:
 *  - 代理:**單一連線**(避免 FakeTLS 多連線重連風暴 / 打爆代理),分段數 = 管線深度(同一連線多個
 *    in-flight 隱藏高延遲)。使用者調 downloadThreads>1 則以其值當管線深度。
 *  - 直連:多連線各一段(穩定、真加速);連線數用偏好(預設 4)。
 * 全都在 worker 執行緒跑,不影響主執行緒順暢。
 */
function planConcurrency() {
  const userThreads = Number(config.getPreferences().downloadThreads) || 1
  if (config.getActiveProxy()) {
    const depth = userThreads > 1 ? Math.min(MAX_SEGMENTS, userThreads) : PROXY_PIPELINE
    return { connections: 1, segments: Math.max(1, depth) }
  }
  const conns = connectionCount()
  const segments = userThreads > 1 ? Math.min(MAX_SEGMENTS, userThreads) : conns
  return { connections: conns, segments: Math.max(1, segments) }
}

/** 把 InputFileLocation 序列化成可跨執行緒傳的純資料。 */
function serializeLocation(loc) {
  return {
    className: loc.className,
    id: loc.id.toString(),
    accessHash: loc.accessHash.toString(),
    fileReference: Buffer.from(loc.fileReference || []).toString('base64'),
    thumbSize: loc.thumbSize || ''
  }
}

/** 由 raw message 解析媒體的 dcId + location(可序列化)。 */
function resolveFromMsg(msg) {
  const media = getMediaInfo(msg)
  if (!media) return { error: '此訊息沒有可下載的媒體' }
  // 服務訊息頭像 / 連結預覽圖有 photo 但沒有可下載位置,先擋掉才不會拋 cast fail
  const fileLoc = getDownloadableMedia(msg)
  if (!fileLoc) return { error: '這則訊息沒有可下載的檔案(服務訊息頭像或連結預覽圖)' }
  let info
  try {
    info = utils.getFileInfo(fileLoc)
  } catch (e) {
    return { error: '無法解析檔案位置:' + String(e?.message || e) }
  }
  if (!info?.dcId || !info?.location) return { error: '此媒體無法定位下載來源' }
  return { msg, media, dcId: info.dcId, location: serializeLocation(info.location) }
}

/** 解析某訊息媒體的 dcId + location(供派工用);僅查記憶體快取,失敗回 error。 */
function resolveFileInfo(dialogId, msgId) {
  const msg = getRawMessage(dialogId, msgId)
  if (!msg) return { error: '訊息不在快取中,請重新整理對話' }
  return resolveFromMsg(msg)
}

/**
 * 同上,但快取沒有時(如關程式重開後的續傳)會向伺服器補抓一次該訊息。
 * fileReference 會過期,續傳前本就需要重新解析位置,順便解決跨重啟快取為空的問題。
 */
async function resolveFileInfoAsync(dialogId, msgId, { force = false } = {}) {
  // force=true(續傳):一律向伺服器重抓,因為 fileReference 只活幾十分鐘,
  // 用快取裡那份舊的會直接吃 FILE_REFERENCE_EXPIRED。抓不到才退回快取。
  let msg = force ? await fetchRawMessage(dialogId, msgId) : getRawMessage(dialogId, msgId)
  if (!msg) msg = force ? getRawMessage(dialogId, msgId) : await fetchRawMessage(dialogId, msgId)
  if (!msg) return { error: '無法取得訊息(請確認已連線;必要時開啟該對話後再續傳)' }
  return resolveFromMsg(msg)
}

/* ---------- 對外 API(介面與舊版一致,ipc/download.js 不需改) ---------- */

/** 啟動下載。已存在→skipped、進行中→忽略、暫停中→續傳。 */
export async function startDownload(dialogId, msgId) {
  const key = keyOf(dialogId, msgId)
  const existing = tasks.get(key)
  if (existing) {
    if (existing.status === 'paused') return resumeDownload(dialogId, msgId)
    return { ok: true, already: true }
  }

  const fi = resolveFileInfo(dialogId, msgId)
  if (fi.error) return { ok: false, error: fi.error }

  const { dir, path } = finalPathFor(dialogId, fi.msg, fi.media)
  const total = fi.media.size || 0

  // 已存在且大小相符 → 跳過
  try {
    const st = fs.statSync(path)
    if (total && st.size === total) {
      sink?.({ dialogId, msgId, status: 'done', downloaded: total, total, path, skipped: true })
      return { ok: true, path, skipped: true }
    }
  } catch {
    /* 不存在,繼續 */
  }

  fs.mkdirSync(dir, { recursive: true })
  const { connections, segments } = planConcurrency()
  const task = {
    dialogId,
    msgId,
    path,
    partPath: path + '.part',
    total,
    status: 'downloading',
    lastDownloaded: 0
  }
  tasks.set(key, task)
  const w = ensureWorker()
  w.postMessage({
    cmd: 'start',
    task: {
      key,
      dialogId,
      msgId,
      dcId: fi.dcId,
      location: fi.location,
      total,
      partPath: task.partPath,
      path,
      connections,
      segments
    }
  })
  return { ok: true, started: true }
}

export function pauseDownload(dialogId, msgId) {
  const key = keyOf(dialogId, msgId)
  const task = tasks.get(key)
  if (!task) return { ok: false }
  if (task.status !== 'downloading') {
    // UI 顯示下載中但實際已非下載中(如剛出錯轉暫停)→ 回報真實狀態讓 UI 同步,避免卡在「下載中」按不動
    sink?.({
      dialogId,
      msgId,
      status: task.status,
      downloaded: task.lastDownloaded || 0,
      total: task.total || 0,
      path: task.path
    })
    return { ok: false }
  }
  task.status = 'paused'
  worker?.postMessage({ cmd: 'pause', key })
  // 樂觀更新:立刻回報暫停,不等 worker 把在途請求排空 → UI 立即反應(殘留的下載中事件已被 onWorkerMessage 擋掉)
  sink?.({
    dialogId,
    msgId,
    status: 'paused',
    downloaded: task.lastDownloaded || 0,
    total: task.total || 0,
    path: task.path
  })
  return { ok: true }
}

/** 從磁碟上的 .part.json 讀回分段斷點(worker 記憶體已失效時,如跨重啟 / 代理切換後)。 */
function readMetaSegs(partPath) {
  try {
    const meta = JSON.parse(fs.readFileSync(partPath + '.json', 'utf8'))
    if (Array.isArray(meta.segments) && meta.segments.length) return meta.segments
  } catch {
    /* 沒有進度檔 → 只能從 0 重下 */
  }
  return null
}

export async function resumeDownload(dialogId, msgId) {
  const key = keyOf(dialogId, msgId)
  const task = tasks.get(key)
  if (!task || task.status !== 'paused') return { ok: false }
  // 重新解析位置:fileReference 一定要重抓(暫停多久就過期多久),跨重啟時快取為空也一併解決
  const fi = await resolveFileInfoAsync(dialogId, msgId, { force: true })
  if (fi.error) return { ok: false, error: fi.error }
  // worker 曾被收掉(代理切換 / 跨重啟)→ 記憶體沒有分段了,改讀落地的進度檔,才不會從 0 重下
  if (!task.segs) task.segs = readMetaSegs(task.partPath)
  task.status = 'downloading'
  // 樂觀更新:立刻回報「下載中」→ UI 立即反應,不等 worker 建連線
  sink?.({
    dialogId,
    msgId,
    status: 'downloading',
    downloaded: task.lastDownloaded || 0,
    total: task.total || 0,
    path: task.path
  })
  const { connections, segments } = planConcurrency()
  const w = ensureWorker()
  w.postMessage({
    cmd: 'resume',
    task: {
      key,
      dialogId,
      msgId,
      dcId: fi.dcId,
      location: fi.location,
      total: task.total,
      partPath: task.partPath,
      path: task.path,
      connections,
      segments,
      resumeSegs: task.segs || null
    }
  })
  return { ok: true }
}

/** 刪掉 .part 與其進度檔(主程序端;供 worker 沒有該任務時直接清理)。 */
function deletePartFiles(partPath) {
  if (!partPath) return
  try {
    fs.unlinkSync(partPath)
  } catch {
    /* 不存在或正被 worker 佔用(下載中)→ 由 worker 端關檔後刪 */
  }
  try {
    fs.unlinkSync(partPath + '.json')
  } catch {
    /* ignore */
  }
}

export function cancelDownload(dialogId, msgId) {
  const key = keyOf(dialogId, msgId)
  const task = tasks.get(key)
  if (!task) return { ok: false }
  const wasActive = task.status === 'downloading'
  task.status = 'canceled' // 之後殘留進度會被 onWorkerMessage 忽略,等 worker 最終 canceled
  worker?.postMessage({ cmd: 'cancel', key })
  // 立刻回報 canceled → 通知中心與訊息即時消失,不用等 worker 關檔(1.5~5 秒)。
  // 殘留的下載中事件會被 onWorkerMessage 的 canceled 守衛擋掉,不會又冒回來。
  sink?.({ dialogId, msgId, status: 'canceled', downloaded: 0, total: task.total || 0, path: task.path })
  if (!wasActive) {
    // 暫停中 / 開機還原的任務:worker 通常沒有它(不會刪檔)→ 主程序端直接刪掉 .part 與進度檔、移除任務。
    deletePartFiles(task.partPath)
    tasks.delete(key)
  }
  return { ok: true }
}

/**
 * 開機還原可續傳的 .part:上次關程式 / 當掉時,只要旁邊有吻合的進度檔(.part.json),
 * 就把它還原成「已暫停」任務登記在記憶體,顯示在通知中心 → 使用者按「繼續」即可跨重啟續傳。
 * 沒有(或不吻合)進度檔的孤兒 .part 才刪掉(無斷點可續,只佔空間)。
 * 有限深度遞迴掃 saveRoot(下載都在 saveRoot/<對話標題>/檔名.part),同步、best-effort。
 */
export function restoreResumableParts() {
  const root = config.getPaths()?.saveRoot
  if (!root) return
  const walk = (dir, depth) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (depth < 3) walk(full, depth + 1)
        continue
      }
      // 殘留的孤兒進度檔(對應 .part 已不在)→ 清掉
      if (ent.name.endsWith('.part.json')) {
        if (!fs.existsSync(full.slice(0, -5))) {
          try {
            fs.unlinkSync(full)
          } catch {
            /* ignore */
          }
        }
        continue
      }
      // 批量下載的半成品(有 .part.batch.json 標記)歸批量任務自己管,別在這裡刪掉
      if (ent.name.endsWith('.part.batch.json')) {
        if (!fs.existsSync(full.slice(0, -'.batch.json'.length))) {
          try {
            fs.unlinkSync(full)
          } catch {
            /* ignore */
          }
        }
        continue
      }
      if (!ent.name.endsWith('.part')) continue
      if (fs.existsSync(full + '.batch.json')) continue
      const metaFull = full + '.json'
      let meta = null
      try {
        meta = JSON.parse(fs.readFileSync(metaFull, 'utf8'))
      } catch {
        meta = null
      }
      // 驗證進度檔與 .part 是否吻合(.part 已預先 truncate 到 total)
      let ok = false
      if (meta && meta.v === 1 && Array.isArray(meta.segments) && meta.total > 0 && meta.path === full.slice(0, -5)) {
        try {
          ok = fs.statSync(full).size === meta.total
        } catch {
          ok = false
        }
      }
      if (!ok) {
        // 孤兒 / 不吻合 → 無法續傳,刪掉半殘檔與殘留進度檔
        try {
          fs.unlinkSync(full)
        } catch {
          /* ignore */
        }
        try {
          fs.unlinkSync(metaFull)
        } catch {
          /* ignore */
        }
        continue
      }
      const key = keyOf(meta.dialogId, meta.msgId)
      if (tasks.has(key)) continue
      // 用 Number 而非 |0:大檔(>2GB)偏移會被 32 位元截斷而算錯已下載量
      const downloaded = meta.segments.reduce((s, g) => s + Math.max(0, Number(g.next) - Number(g.start)), 0)
      tasks.set(key, {
        dialogId: meta.dialogId,
        msgId: meta.msgId,
        path: meta.path,
        partPath: full,
        total: meta.total,
        segs: meta.segments,
        status: 'paused',
        lastDownloaded: downloaded,
        restored: true,
        name: meta.path.split(/[\\/]/).pop()
      })
    }
  }
  walk(root, 0)
}

/** 目前記憶體中「已暫停/可續傳」的下載清單(供 renderer 開機時種進通知中心)。 */
export function listResumable() {
  const out = []
  for (const task of tasks.values()) {
    if (task.status !== 'paused') continue
    out.push({
      dialogId: task.dialogId,
      msgId: task.msgId,
      name: task.name || (task.path ? task.path.split(/[\\/]/).pop() : `訊息 ${task.msgId}`),
      status: 'paused',
      downloaded: task.lastDownloaded || 0,
      total: task.total || 0,
      path: task.path
    })
  }
  return out
}

/** 磁碟實檢:回傳哪些 msgId 已完整下載(檔案存在且大小相符)。 */
export function checkDownloaded(dialogId, msgIds) {
  const out = {}
  for (const msgId of msgIds || []) {
    const msg = getRawMessage(dialogId, msgId)
    if (!msg) continue
    const media = getMediaInfo(msg)
    if (!media) continue
    const { path } = finalPathFor(dialogId, msg, media)
    try {
      const st = fs.statSync(path)
      if (media.size && st.size === media.size) out[msgId] = { done: true, path }
    } catch {
      /* 未下載 */
    }
  }
  return out
}
