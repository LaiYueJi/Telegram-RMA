/**
 * 下載共用工具:檔名/資料夾名淨化、輸出檔名規則。
 * 實際下載邏輯在 downloadManager.js(多連線/暫停/續傳/驗證)。
 */
import { extForKind } from './media.js'

/** 清掉檔名/資料夾名中的非法字元。 */
export function sanitize(name) {
  return (
    String(name)
      .replace(/[<>:"/\\|?* -]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 150) || 'untitled'
  )
}

function two(n) {
  return String(n).padStart(2, '0')
}
function fmtDate(unix) {
  const d = new Date(unix * 1000)
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}` +
    `_${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
  )
}

/** 決定輸出檔名(無原始檔名時用 日期_id.副檔名)。 */
export function buildFileName(msg, media) {
  if (media.fileName) return sanitize(media.fileName)
  const ext = extForKind(media.kind, media.mime)
  return `${fmtDate(msg.date)}_${msg.id}.${ext}`
}
