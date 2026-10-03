/**
 * 協議號(GramJS session 字串)↔ 直登號(Telegram Desktop tdata 資料夾)互轉。
 * 底層用 @mtcute/convert(MIT,支援 GramJS session + tdata 讀寫)。
 *
 * @mtcute/convert 為純 ESM,主程序打包成 CJS;用動態 import() 載入(Node 允許
 * CJS 動態 import ESM),同時避開該套件對 CJS 版的棄用警告。加密提供者見 mtcuteCrypto.js。
 */
import fs from 'node:fs'
import path from 'node:path'
import { getConvertCrypto } from './mtcuteCrypto.js'

/** @type {Promise<any>|null} 記憶化的動態載入。 */
let mtPromise = null
function mt() {
  if (!mtPromise) mtPromise = import('@mtcute/convert')
  return mtPromise
}

/**
 * 協議號 → 直登號:把 GramJS session 字串寫成一個 tdata 資料夾(可直接匯入 Telegram Desktop 直登)。
 * @param {string} gramSession GramJS session 字串
 * @param {string} outTdataDir 目標 tdata 資料夾(會建立)
 */
export async function sessionToTdata(gramSession, outTdataDir) {
  const m = await mt()
  const sd = m.convertFromGramjsSession(String(gramSession).trim())
  fs.mkdirSync(outTdataDir, { recursive: true })
  await m.convertToTdata(sd, { path: outTdataDir, crypto: getConvertCrypto() })
  return { ok: true, path: outTdataDir }
}

/** 找出真正的 tdata 資料夾(使用者可能選到父層)。 */
function resolveTdataDir(dir) {
  const hasKey = (d) => fs.existsSync(path.join(d, 'key_datas')) || fs.existsSync(path.join(d, 'key_data'))
  if (hasKey(dir)) return dir
  const sub = path.join(dir, 'tdata')
  if (hasKey(sub)) return sub
  return dir // 交給 mtcute 嘗試;失敗會丟出可讀錯誤
}

/**
 * 直登號 → 協議號:讀 tdata 資料夾,輸出 GramJS session 字串。
 * @param {string} tdataDir tdata 資料夾(或其父層,會自動往下找)
 * @param {number} accountIdx tdata 內第幾個帳號(預設 0)
 */
export async function tdataToSession(tdataDir, accountIdx = 0) {
  const m = await mt()
  const dir = resolveTdataDir(tdataDir)
  const td = await m.Tdata.open({ path: dir, crypto: getConvertCrypto() })
  const sd = await m.convertFromTdata(td, accountIdx)
  const gram = m.convertToGramjsSession(sd)
  return { ok: true, session: gram }
}
