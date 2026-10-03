/**
 * 輕量 JSON 資料庫(取代 lowdb,免 ESM 相依問題)。
 * 存:下載任務、下載/轉發歷史、自動化規則、增量 offset。
 * 寫入採延遲合併(debounce),避免頻繁進度更新狂寫磁碟。
 */
import fs from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

let file
let data = null
let writeTimer = null

const DEFAULTS = {
  downloadTasks: [], // 下載任務(含項目摘要)
  forwardTasks: [], // 轉發任務
  automations: [], // 自動化規則
  offsets: {} // dialogId → lastMessageId(增量)
}

export function initDb() {
  file = join(app.getPath('userData'), 'tgff-db.json')
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
    // 補預設鍵
    for (const k of Object.keys(DEFAULTS)) if (!(k in data)) data[k] = DEFAULTS[k]
  } catch {
    data = structuredClone(DEFAULTS)
    flushNow()
  }
  return data
}

function flushNow() {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 0))
  } catch {
    /* ignore */
  }
}

/** 延遲寫入(800ms 內多次變更只寫一次)。 */
export function scheduleFlush() {
  clearTimeout(writeTimer)
  writeTimer = setTimeout(flushNow, 800)
}

export const db = {
  get(key) {
    return data[key]
  },
  set(key, value) {
    data[key] = value
    scheduleFlush()
  },
  all() {
    return data
  },
  /** 立即寫入(關閉前用)。 */
  flush: flushNow
}
