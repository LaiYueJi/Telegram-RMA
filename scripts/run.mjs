/**
 * electron-vite 啟動包裝。
 * 用途:某些環境(含本開發沙箱)會把 ELECTRON_RUN_AS_NODE=1 設成全域變數,
 * 導致 Electron 被當成純 Node 執行、require('electron') 回傳路徑字串而非 API。
 * 這裡在 spawn electron-vite 前先移除該變數,確保 Electron 以 GUI 主程序模式啟動。
 * 一般使用者機器沒有此變數,此包裝無副作用。
 */
import { spawn, execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cli = join(__dirname, '..', 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')

// Windows 主控台預設碼頁多為 950(Big5),會把主程序輸出的 UTF-8 中文判讀成 Big5 → 後台日誌亂碼
// (例:「累計」變「蝝航」)。啟動前把這個共用主控台切到 UTF-8(65001);下面 spawn 用 stdio:'inherit'
// 共用同一個主控台,故 electron 主程序之後印的中文就正常了。非 Windows / 非主控台環境直接略過。
if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore' })
  } catch {
    /* 沒有可切換的主控台(被導向檔案/管線)時忽略 */
  }
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const sub = process.argv[2] || 'dev'
// `node scripts/run.mjs dev debug` → 開下載/FakeTLS 診斷日誌(終端會印 [DL]/[FakeTLS])
if (process.argv[3] === 'debug') {
  env.TRMA_DL_DEBUG = '1'
  env.TRMA_FAKETLS_DEBUG = '1'
}
const cp = spawn(process.execPath, [cli, sub], { stdio: 'inherit', env })
cp.on('exit', (code) => process.exit(code ?? 0))
