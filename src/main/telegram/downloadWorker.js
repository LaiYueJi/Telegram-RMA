/**
 * 下載工作執行緒(worker_thread)。
 *
 * 目的:把「下載 + MTProto 解密 + 寫檔」整包搬離 Electron 主執行緒。過去主執行緒要同步解密高吞吐的
 * 下載資料 → UI 卡死、連主連線 keepalive 都跑不動 → client.connected 變 false、切對話報「尚未連線」。
 * 移到這條獨立執行緒後,主執行緒零負擔:UI 全程順、互動連線不被餓死,且可放心開大管線衝速度。
 *
 * 這裡自建一個「只負責下載」的 GramJS client(同一份 session + 同一組代理),開它自己的連線、自己
 * 解密、直接寫 .part 檔,只把進度 postMessage 回主程序。刻意不 import client.js / config.js —— 那些
 * 相依 electron,worker 執行緒取用不到;所有設定改由 workerData / 訊息帶入。
 */
import { parentPort, workerData } from 'node:worker_threads'
import fsp from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import bigInt from 'big-integer'
import { Api, TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { FakeTlsSocket } from './fakeTlsSocket.js'
import { getSenders, resetSenderPool } from './senderPool.js'

// GramJS 每條連線會在 socket 上掛多個監聽器;放寬預設上限,避免代理抖動重連時噴
// MaxListenersExceededWarning(單一連線下本就不多,這只是拉高門檻消警告)。
EventEmitter.defaultMaxListeners = 64

const REQUEST_SIZE = 1024 * 1024 // upload.GetFile 單請求上限(1MB,MTProto 允許的最大值 → 高延遲代理少一半往返)
const EMIT_INTERVAL = 150 // ms,進度節流
const META_INTERVAL = 2000 // ms,進度檔(.part.json)落地節流:下載中最多每 2 秒寫一次
const GETFILE_TIMEOUT = 40000 // ms,單一 GetFile 牆鐘逾時(代理靜默卡死時強制中斷,不讓下載無限凍結)
const GETFILE_MAX_RETRY = 4 // 逾時後重試次數,連續超過才放棄(保留 .part 可續傳)
const MAX_SEGMENTS = 32
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 下載診斷:設環境變數 TRMA_DL_DEBUG=1 啟動。worker 的 console 會透傳到主程序終端機。
// 重點看「連線=N」:若 N < 分段所需連線數,代表多連線池只建起部分/單條 → 那才是速度上不去的主因;
// 若 N 已達設定卻仍慢,則是代理本身的天花板(換低延遲代理才有感)。
const DL_DEBUG = process.env.TRMA_DL_DEBUG === '1'
function dlog(...a) {
  if (DL_DEBUG) console.log('[DL]', ...a)
}
// 只印「有意義的停頓(間隔>200ms = 代理批次延遲)」與每 32 塊一次心跳,避免每塊都印拖慢 worker。
function logChunk(task, seg) {
  if (!DL_DEBUG) return
  const now = Date.now()
  const gap = now - (task._lastChunkAt || now)
  task._lastChunkAt = now
  task._chunkN = (task._chunkN || 0) + 1
  if (gap > 200 || task._chunkN % 32 === 0) {
    dlog(`chunk seg@${seg.start} 累計=${task.downloaded}/${task.total} 間隔=${gap}ms #${task._chunkN}`)
  }
}

const { session, apiId, apiHash, proxy } = workerData || {}

/** worker 專用 client(單例,worker 生命週期內共用)。 */
let client = null
async function ensureClient() {
  if (!client) {
    // 慢代理的連線握手容易撞 15s 逾時 → 下載 worker 放寬到 30s,讓多連線池的第 2 條以後也建得起來
    const px = proxy ? { ...proxy, timeout: Math.max(Number(proxy.timeout) || 0, 30) } : undefined
    const opts = {
      connectionRetries: 5,
      useWSS: false,
      autoReconnect: true,
      proxy: px,
      deviceModel: 'Telegram-RMA-DL',
      systemVersion: process.platform,
      appVersion: '0.1.0'
    }
    if (proxy && proxy.fakeTls) opts.networkSocket = FakeTlsSocket
    client = new TelegramClient(new StringSession(session || ''), Number(apiId), String(apiHash), opts)
    try {
      client.setLogLevel('none')
    } catch {
      /* 某些版本無此方法 */
    }
  }
  if (!client.connected) await client.connect()
  return client
}

/**
 * 把 worker 的 client 與連線池整個重建。
 * 用於下載遇到連線類錯誤(如「Cannot send requests while disconnected」)後 —— GramJS 的
 * client.connected 斷線後常回報過時的 true,導致續傳一直用死連線立刻再錯、卡在暫停。
 * 直接丟掉舊 client,下次 ensureClient 會建全新連線,續傳才接得回去。
 */
async function resetClient() {
  const c = client
  client = null
  resetSenderPool()
  if (c) {
    try {
      await c.disconnect()
    } catch {
      /* ignore */
    }
  }
}

/** 主程序把 InputFileLocation 序列化成純資料,這裡還原成 TL 物件。 */
function rebuildLocation(s) {
  const args = {
    id: bigInt(s.id),
    accessHash: bigInt(s.accessHash),
    fileReference: Buffer.from(s.fileReference || '', 'base64'),
    thumbSize: s.thumbSize || ''
  }
  return s.className === 'InputPhotoFileLocation'
    ? new Api.InputPhotoFileLocation(args)
    : new Api.InputDocumentFileLocation(args)
}

/** key -> task */
const tasks = new Map()

function post(task) {
  parentPort.postMessage({
    type: 'progress',
    payload: {
      dialogId: task.dialogId,
      msgId: task.msgId,
      status: task.status,
      downloaded: task.downloaded,
      total: task.total,
      path: task.path,
      error: task.error || '',
      skipped: false
    }
  })
}
function emit(task, force = false) {
  const now = Date.now()
  if (!force && task.status === 'downloading' && now - task._lastEmit < EMIT_INTERVAL) return
  task._lastEmit = now
  post(task)
  if (task.status === 'downloading') maybeWriteMeta(task)
}

/* ---------- 續傳進度檔(.part.json)---------- */
// 目的:.part 已預先 truncate 成完整大小(補零),光看檔案無法得知哪些位元組是真的。
// 因此把「各分段目前寫到哪個 offset」落地成 sidecar,讓程式關掉/當掉後重開仍能從斷點續傳。
function metaPathOf(partPath) {
  return partPath + '.json'
}
/** 把目前分段進度寫入 .part.json(temp+rename 原子寫;以旗標序列化避免併發互踩)。 */
async function writeMeta(task) {
  if (!task || !task.total || task.total <= 0 || !task.segs) return
  if (task._metaWriting) return
  task._metaWriting = true
  const metaPath = metaPathOf(task.partPath)
  const tmp = metaPath + '.tmp'
  try {
    const data = JSON.stringify({
      v: 1,
      dialogId: task.dialogId,
      msgId: task.msgId,
      total: task.total,
      path: task.path,
      segments: task.segs.map((s) => ({ start: s.start, end: s.end, next: s.next })),
      updatedAt: Date.now()
    })
    await fsp.writeFile(tmp, data)
    await fsp.rename(tmp, metaPath)
    task._lastMeta = Date.now()
  } catch {
    /* best-effort;寫不進不影響下載本身 */
  } finally {
    task._metaWriting = false
  }
}
/** 節流版:下載途中定期落地。 */
function maybeWriteMeta(task) {
  if (!task.total || task.total <= 0) return
  if (Date.now() - (task._lastMeta || 0) < META_INTERVAL) return
  void writeMeta(task)
}
async function deleteMeta(task) {
  try {
    await fsp.unlink(metaPathOf(task.partPath))
  } catch {
    /* ignore */
  }
}

/** 依檔案大小與分段數切段(起點對齊 REQUEST_SIZE,避免 GramJS 未對齊重抓)。 */
function buildSegments(total, threads) {
  if (!total || total <= 0) return [{ start: 0, end: -1, next: 0 }]
  if (total < 1024 * 1024 || threads === 1) return [{ start: 0, end: total - 1, next: 0 }]
  let segSize = Math.ceil(total / threads)
  segSize = Math.ceil(segSize / REQUEST_SIZE) * REQUEST_SIZE
  const segs = []
  for (let i = 0; i < threads; i++) {
    const start = i * segSize
    if (start >= total) break
    const end = Math.min(total - 1, start + segSize - 1)
    segs.push({ start, end, next: start })
  }
  return segs
}

async function writeAt(fd, buf, position) {
  await fd.write(buf, 0, buf.length, position)
}
async function openPart(partPath) {
  try {
    return await fsp.open(partPath, 'r+') // 保留既有 .part(續傳)
  } catch {
    return await fsp.open(partPath, 'w+')
  }
}
async function closeFd(task) {
  if (task.fd) {
    try {
      await task.fd.close()
    } catch {
      /* ignore */
    }
    task.fd = null
  }
}

/** 帶牆鐘逾時的 GetFile:避免代理靜默卡死時 invokeWithSender 永遠不 resolve → 整個下載凍結。 */
async function invokeGetFile(req, sender) {
  let timer
  try {
    return await Promise.race([
      client.invokeWithSender(req, sender),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error('GETFILE_TIMEOUT')), GETFILE_TIMEOUT)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 跑單一分段:用指定 sender(獨立連線)直接 upload.GetFile,從 seg.next 寫到 seg.end。 */
async function runSegment(task, seg, fd, sender) {
  if (seg.end >= 0 && seg.next > seg.end) return
  let timeouts = 0
  while (!task.abort) {
    if (seg.end >= 0 && seg.next > seg.end) break
    const req = new Api.upload.GetFile({
      location: task.location,
      offset: bigInt(seg.next),
      limit: REQUEST_SIZE
    })
    let result
    try {
      result = await invokeGetFile(req, sender)
    } catch (e) {
      const msg = String(e?.errorMessage || e?.message || e)
      // 逾時(含代理靜默卡死):退避後重試數次;連續失敗才拋出,交由上層保留 .part 標記可續傳
      if ((msg === 'TIMEOUT' || msg === 'GETFILE_TIMEOUT') && timeouts < GETFILE_MAX_RETRY) {
        timeouts++
        await sleep(1000 * timeouts)
        continue
      }
      throw e
    }
    timeouts = 0
    if (task.abort) break
    let buf = Buffer.from(result.bytes)
    if (!buf.length) break // 檔尾
    if (seg.end >= 0) {
      const room = seg.end - seg.next + 1
      if (buf.length > room) buf = buf.subarray(0, room)
    }
    await writeAt(fd, buf, seg.next)
    seg.next += buf.length
    task.downloaded += buf.length
    emit(task)
    logChunk(task, seg)
    if (result.bytes.length < REQUEST_SIZE) break // 不足一塊 → 檔尾
    if (seg.end >= 0 && seg.next > seg.end) break
  }
}

/**
 * 啟動/續傳的唯一入口:保證同一 task 不會同時跑兩個 driveTaskInner。
 * 快速「暫停→續傳」時,前一輪可能還在收尾(排空在途請求),此時只記下想續傳,
 * 等它在 finally 收尾後接手,避免兩輪並存造成 fd/分段/寫檔錯亂。
 */
async function driveTask(task) {
  if (task._running) {
    task._resumeWanted = true
    return
  }
  task._running = true
  task._resumeWanted = false
  task.abort = false
  task.status = 'downloading' // 一啟動就標記,讓建連線期間按暫停也能生效
  try {
    await driveTaskInner(task)
  } finally {
    task._running = false
    // 收尾期間有人要求續傳,且仍是暫停中、任務還在 → 現在安全地接手下一輪(不會與前一輪並存)
    if (task._resumeWanted && task.status === 'paused' && tasks.has(task.key)) {
      driveTask(task)
    }
  }
}

/** 驅動任務跑到底(或被暫停/取消)。 */
async function driveTaskInner(task) {
  try {
    await ensureClient()
    await closeFd(task) // 保險:重跑前先關掉可能殘留的 fd,避免 FileHandle 洩漏被 GC 警告
    const fd = await openPart(task.partPath)
    task.fd = fd
    if (task.total > 0) await fd.truncate(task.total)
    if (!task.segs) task.segs = buildSegments(task.total, task.segments)
    await writeMeta(task) // 開跑先落地一次進度檔(即使馬上當掉也留得住斷點)

    // 對 media DC 建多連線池;失敗退回單連線
    let senders = null
    const want = Math.max(1, Math.min(task.connections, task.segs.length))
    try {
      senders = await getSenders(client, task.dcId, want)
    } catch (e) {
      dlog('建多連線池失敗,退回單連線:', String(e?.message || e))
      senders = null
    }
    if (!senders || !senders.length) senders = await getSenders(client, task.dcId, 1)

    // 不在此覆寫 abort/status:建連線期間若已被按暫停/取消,交給下方 Promise.all 後的收尾分支處理
    dlog(
      `開始下載 size=${task.total} 代理=${proxy ? '是' : '否'} 想要連線=${want} ` +
        `實際連線=${senders.length} 分段=${task.segs.length} requestSize=${REQUEST_SIZE}`
    )
    emit(task, true)

    // allSettled(非 all):任一段失敗也等其餘段全部收斂,避免留下孤兒 runSegment 對已關閉的 fd 亂寫。
    const results = await Promise.allSettled(
      task.segs.map((seg, i) => runSegment(task, seg, fd, senders[i % senders.length]))
    )

    if (task.abort) {
      await closeFd(task)
      if (task.status === 'paused') {
        await writeMeta(task) // 暫停:把最新斷點寫死,供(跨程序)續傳
        emit(task, true)
        return // 留著 task 等 resume
      }
      // canceled → 刪掉半殘 .part、不保存
      await unlinkPart(task)
      task.status = 'canceled'
      emit(task, true)
      tasks.delete(task.key)
      idlePoolCheck()
      return
    }

    // 有分段失敗(非中止,如代理斷線/連續逾時)→ 拋給下方 catch:保留 .part、標記可續傳(不刪檔)
    const failed = results.find((r) => r.status === 'rejected')
    if (failed) {
      const reason = failed.reason
      throw reason instanceof Error ? reason : new Error(String(reason?.message || reason))
    }

    // 全段完成 → 用「實際下載位元組」驗證完整性。
    // 注意:.part 已預先 truncate 到 total,所以檔案 size 恆等於 total、不能拿來驗證;
    // 必須看真正寫入的 task.downloaded。未達 total(例如代理中途短讀)→ 視為未完成。
    const st = await fd.stat()
    await closeFd(task)
    if (task.total > 0 && task.downloaded !== task.total) {
      // 不刪檔:保留 .part 與進度檔,標記為暫停可續傳(續傳會從各段斷點補齊剩餘位元組)
      await writeMeta(task)
      task.status = 'paused'
      task.error = ''
      emit(task, true)
      idlePoolCheck()
      return // 留著 task 供續傳
    }
    await fsp.rename(task.partPath, task.path)
    await deleteMeta(task) // 完成:.part 已改名,清掉進度檔
    task.status = 'done'
    task.downloaded = task.total || st.size
    emit(task, true)
    tasks.delete(task.key)
    idlePoolCheck()
  } catch (e) {
    await closeFd(task)
    if (task.abort && task.status === 'paused') {
      await writeMeta(task) // 暫停:保留 .part + 進度檔供(跨程序)續傳
      emit(task, true)
      return
    }
    if (task.abort && task.status === 'canceled') {
      await unlinkPart(task)
      tasks.delete(task.key)
      idlePoolCheck()
      return
    }
    // 真正的錯誤(代理中途斷線 / 連續逾時等):不刪檔!保留 .part 與進度檔,標記為暫停可續傳。
    // 這符合「只有完成或使用者取消才刪」的原則 —— 網路/代理問題不該丟掉已下載的進度。
    dlog('下載錯誤,保留 .part 標記可續傳:', String(e?.message || e))
    await writeMeta(task)
    task.status = 'paused'
    task.error = ''
    // 連線類錯誤 → 重建 client,否則續傳會一直用死連線立刻再錯。只有沒有其他下載時才重建(避免拖累其他任務)。
    const otherDownloading = [...tasks.values()].some((t) => t.key !== task.key && t.status === 'downloading')
    if (!otherDownloading) await resetClient()
    emit(task, true)
    // 不從 tasks 刪除:留著供續傳
  }
}

/** 刪掉未完成的 .part 與其進度檔(取消 / 錯誤時呼叫,不保存半殘檔)。 */
async function unlinkPart(task) {
  try {
    await fsp.unlink(task.partPath)
  } catch {
    /* ignore */
  }
  await deleteMeta(task)
}

/** 沒有進行中的下載了 → 斷掉下載連線池,避免閒置連線在 FakeTLS 代理上自動重連(ClientHello 風暴)。 */
function idlePoolCheck() {
  const stillDownloading = [...tasks.values()].some((t) => t.status === 'downloading')
  if (!stillDownloading) resetSenderPool()
}

function startTask(t) {
  const existing = tasks.get(t.key)
  if (existing) {
    if (existing.status === 'paused') {
      if (existing._running) existing._resumeWanted = true // 前一輪收尾中 → 交給 finally 接手
      else driveTask(existing)
    }
    return // downloading 中,忽略重複
  }
  // 續傳(可能來自跨程序重啟 / 代理切換後):帶著已落地的分段斷點進來,直接沿用、不從 0 重切。
  let segs = null
  let downloaded = 0
  if (Array.isArray(t.resumeSegs) && t.resumeSegs.length) {
    // 用 Number 而非 |0:位元組偏移可能 > 2GB,|0 會被截成 32 位元整數而毀掉大檔的斷點
    segs = t.resumeSegs.map((s) => ({
      start: Number(s.start) || 0,
      end: s.end == null ? -1 : Number(s.end),
      next: Number(s.next) || 0
    }))
    for (const s of segs) downloaded += Math.max(0, s.next - s.start)
  }
  const task = {
    key: t.key,
    dialogId: t.dialogId,
    msgId: t.msgId,
    dcId: t.dcId,
    location: rebuildLocation(t.location),
    total: t.total || 0,
    partPath: t.partPath,
    path: t.path,
    connections: Math.max(1, t.connections || 1),
    segments: Math.max(1, Math.min(MAX_SEGMENTS, t.segments || 1)),
    abort: false,
    status: 'downloading',
    downloaded,
    error: '',
    segs,
    fd: null,
    _lastEmit: 0
  }
  tasks.set(t.key, task)
  driveTask(task)
}

function pauseTask(key) {
  const task = tasks.get(key)
  if (!task || task.status !== 'downloading') return
  task.status = 'paused'
  task.abort = true
  // 立即中斷在途 GetFile,讓暫停即時生效(否則得等慢代理把當前請求跑完 / 逾時,暫停會拖很久甚至像卡住)。
  // 只有在沒有其他下載時才收掉共用連線池,避免拖累其他任務;續傳時 driveTask 會重建連線。
  const otherDownloading = [...tasks.values()].some((t) => t.key !== key && t.status === 'downloading')
  if (!otherDownloading) resetSenderPool()
}

function resumeTask(t) {
  const task = tasks.get(t.key)
  if (task && task.status === 'paused') {
    // fileReference 可能已過期,主程序會帶新的 location 進來
    if (t.location) task.location = rebuildLocation(t.location)
    if (task._running) task._resumeWanted = true // 前一輪(暫停)收尾中 → 交給 driveTask 的 finally 接手
    else driveTask(task)
    return
  }
  startTask(t) // worker 曾被重建 → 當新任務(從既有 .part 續)
}

async function cancelTask(key) {
  const task = tasks.get(key)
  if (!task) return
  const wasPaused = task.status === 'paused'
  task.status = 'canceled'
  task.abort = true
  if (wasPaused) {
    await closeFd(task)
    await unlinkPart(task)
    emit(task, true)
    tasks.delete(key)
    idlePoolCheck()
    return
  }
  // 進行中:若沒有其他下載,立刻斷掉下載連線池 → 在途 GetFile 立即被中斷、取消即時生效,
  // 且不會留下連線在代理上自動重連(這正是「按停止後 FakeTLS ClientHello 狂噴」的根因)。
  const otherDownloading = [...tasks.values()].some((t) => t.key !== key && t.status === 'downloading')
  if (!otherDownloading) resetSenderPool()
  // 保底看門狗:1.5s 內若 driveTask 還沒把它收掉(在途請求卡在慢代理不 reject),就強制收尾 ——
  // 關 fd(免 FileHandle GC 警告)、刪 .part(不留半殘檔)、發最終 canceled(UI 立刻恢復,不用切對話)。
  setTimeout(() => forceFinalizeCancel(task), 1500)
}

/** 強制收尾一個已請求取消的任務(driveTask 卡住時的保底)。 */
async function forceFinalizeCancel(task) {
  if (!tasks.has(task.key)) return // driveTask 已正常收尾
  task.status = 'canceled'
  await closeFd(task)
  await unlinkPart(task)
  emit(task, true)
  tasks.delete(task.key)
  idlePoolCheck()
}

parentPort.on('message', (m) => {
  try {
    if (!m || !m.cmd) return
    if (m.cmd === 'start') startTask(m.task)
    else if (m.cmd === 'pause') pauseTask(m.key)
    else if (m.cmd === 'resume') resumeTask(m.task)
    else if (m.cmd === 'cancel') cancelTask(m.key)
  } catch {
    /* 單一命令失敗不拖垮 worker */
  }
})
