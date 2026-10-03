/**
 * 網速計:累計上/下行 bytes,定期算速率 → 推播 net:speed 給 renderer。
 * 由下載佇列(download.js)與媒體串流(mediaServer.js)餵入位元組數。
 *
 * 平滑化:代理下載的位元組是「一陣一陣」到的(一批 chunk 後停頓數秒),若每秒取原始 delta
 * 會忽高忽低、進度條一頓一頓。改成每 250ms 取樣、用滑動視窗平均,讓顯示的速率平順、更新更跟手。
 *
 * 窗長取捨:1.5s 窗太短,會剛好抓到「爆量」那一瞬間(代理把整批 16MB 在 ~250ms 內倒完)→ 顯示
 * 22~30MB/s,但真實持續吞吐其實每隔數秒才進一批(<幾 MB/s),數字嚴重灌水、誤導。爆量間隔約 3~14s,
 * 故把窗拉到 4s:rate = 窗內總 bytes ÷ 窗長,等於把一次爆量攤平到它真正涵蓋的時間,顯示≈真實持續速率。
 */
const TICK_MS = 250
const WINDOW = 16 // 取樣數 × TICK_MS = 4s 滑動視窗

let downTotal = 0
let upTotal = 0
let lastDown = 0
let lastUp = 0
let timer = null
let getWindow = null
const downSamples = [] // 每次取樣的 byte delta
const upSamples = []

/** 啟動定期回報。getWindow 回傳目前 BrowserWindow(可能為 null)。 */
export function startSpeedmeter(getWin) {
  getWindow = getWin
  if (timer) return
  timer = setInterval(tick, TICK_MS)
  if (timer.unref) timer.unref()
}

export function stopSpeedmeter() {
  if (timer) clearInterval(timer)
  timer = null
}

function pushSample(arr, delta) {
  arr.push(delta)
  if (arr.length > WINDOW) arr.shift()
}

/** 滑動視窗內的平均速率(bytes/sec)。 */
function rate(arr) {
  if (!arr.length) return 0
  const sum = arr.reduce((a, b) => a + b, 0)
  return Math.round((sum / arr.length) * (1000 / TICK_MS))
}

function tick() {
  pushSample(downSamples, Math.max(0, downTotal - lastDown))
  pushSample(upSamples, Math.max(0, upTotal - lastUp))
  lastDown = downTotal
  lastUp = upTotal
  const win = getWindow?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send('net:speed', { up: rate(upSamples), down: rate(downSamples) })
  }
}

/** 累加下行位元組(下載 / 串流)。 */
export function addDown(n) {
  if (n > 0) downTotal += n
}

/** 累加上行位元組(轉發 / 上傳,後續里程碑用)。 */
export function addUp(n) {
  if (n > 0) upTotal += n
}
