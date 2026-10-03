/**
 * 文本導出:把訊息(檢索結果或整個對話)匯出成 xlsx / csv / txt / json / html。
 * 欄位:訊息ID / 日期 / 寄件者 / 文字 / 媒體類型 / 檔名 / 大小 / 回覆 / 轉發自 / 連結。
 * - 文字保留完整多行內容(csv 以引號包住、xlsx 開自動換行)。
 * - json = 網頁檢視器索引格式(TGRMA-EXPORT/1),可直接丟給 tgview 檢視器。
 * - html = 單檔離線聊天記錄(自帶樣式,雙擊即可看)。
 */
import fsp from 'node:fs/promises'
import ExcelJS from 'exceljs'
import { getClient } from './client.js'
import { getCachedEntity, getCachedTitle } from './dialogs.js'
import { normalizeMessage } from './messages.js'
import { getMediaInfo } from './media.js'

export const EXPORT_FORMATS = ['xlsx', 'csv', 'txt', 'json', 'html']

const COLUMNS = [
  { header: '訊息ID', key: 'id', width: 12 },
  { header: '日期', key: 'date', width: 20 },
  { header: '寄件者', key: 'sender', width: 18 },
  { header: '文字', key: 'text', width: 60 },
  { header: '媒體類型', key: 'mediaType', width: 12 },
  { header: '檔名', key: 'fileName', width: 28 },
  { header: '大小', key: 'sizeText', width: 12 },
  { header: '回覆', key: 'replyTo', width: 10 },
  { header: '轉發自', key: 'forwardFrom', width: 18 },
  { header: '連結', key: 'link', width: 38 }
]

function two(n) {
  return String(n).padStart(2, '0')
}
function fmtDate(unix) {
  if (!unix) return ''
  const d = new Date(unix * 1000)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}
function fmtSize(n) {
  if (!n) return ''
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = Number(n)
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

/** 正規化訊息 → 匯出列(文字保留換行)。 */
function toRow(r) {
  return {
    id: r.id,
    date: fmtDate(r.date),
    sender: r.senderName || (r.out ? '我' : ''),
    text: r.text || '',
    mediaType: r.media?.kind || (r.service ? '系統' : ''),
    fileName: r.media?.fileName || '',
    sizeText: fmtSize(r.media?.size),
    replyTo: r.replyTo || '',
    forwardFrom: r.forwardFrom || '',
    link: r.link || ''
  }
}

function csvEscape(v) {
  const s = String(v ?? '')
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

async function writeXlsx(rows, outPath) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: outPath })
  const ws = wb.addWorksheet('messages')
  ws.columns = COLUMNS
  ws.getRow(1).font = { bold: true }
  const textCol = COLUMNS.findIndex((c) => c.key === 'text') + 1
  for (const r of rows) {
    const row = ws.addRow(r)
    // 多行文字開自動換行,Excel 才看得到完整內容
    row.getCell(textCol).alignment = { wrapText: true, vertical: 'top' }
    row.commit()
  }
  await wb.commit()
}
async function writeCsv(rows, outPath) {
  const header = COLUMNS.map((c) => c.header).join(',')
  const lines = rows.map((r) => COLUMNS.map((c) => csvEscape(r[c.key])).join(','))
  await fsp.writeFile(outPath, '﻿' + [header, ...lines].join('\r\n'), 'utf8') // BOM 讓 Excel 正確顯示中文
}
async function writeTxt(rows, outPath) {
  const blocks = rows.map((r) => {
    const head = `[${r.date}] ${r.sender || '(未知)'}${r.replyTo ? ` (回覆 #${r.replyTo})` : ''}${r.forwardFrom ? ` (轉發自 ${r.forwardFrom})` : ''}`
    const media = r.mediaType
      ? `<${r.mediaType}${r.fileName ? ' : ' + r.fileName : ''}${r.sizeText ? ' , ' + r.sizeText : ''}>`
      : ''
    const parts = [head]
    if (r.text) parts.push(r.text)
    if (media) parts.push(media)
    if (r.link) parts.push(r.link)
    return parts.join('\r\n')
  })
  await fsp.writeFile(outPath, blocks.join('\r\n\r\n') + '\r\n', 'utf8')
}

/** 網頁檢視器索引(tgview 可直接讀)。 */
export function buildManifest(records, meta = {}) {
  return {
    app: 'Telegram-RMA',
    format: 'TGRMA-EXPORT/1',
    exportedAt: Math.floor(Date.now() / 1000),
    chat: { id: meta.dialogId ? String(meta.dialogId) : '', title: meta.dialogTitle || '' },
    count: records.length,
    messages: records.map((r) => ({
      id: r.id,
      date: r.date || 0,
      out: !!r.out,
      service: !!r.service,
      senderId: r.senderId || '',
      senderName: r.senderName || '',
      text: r.text || '',
      replyTo: r.replyTo || null,
      forwardFrom: r.forwardFrom || '',
      grouped: r.grouped || null,
      views: r.views || 0,
      link: r.link || '',
      media: r.media
        ? {
            kind: r.media.kind,
            fileName: r.media.fileName || '',
            size: r.media.size || 0,
            duration: r.media.duration || 0,
            width: r.media.width || 0,
            height: r.media.height || 0,
            mime: r.media.mime || '',
            // 相對檔案路徑(批量下載寫索引時才有;純文本導出為空)
            file: r.media.file || ''
          }
        : null
    }))
  }
}

async function writeJson(records, outPath, meta) {
  await fsp.writeFile(outPath, JSON.stringify(buildManifest(records, meta), null, 2), 'utf8')
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 單檔離線 HTML 聊天記錄。 */
async function writeHtml(records, outPath, meta) {
  const title = meta.dialogTitle || '聊天記錄'
  const data = JSON.stringify(buildManifest(records, meta)).replace(/</g, '\\u003c')
  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - Telegram-RMA 匯出</title>
<style>
:root{--bg:#0e1621;--panel:#17212b;--bub:#182533;--bub-out:#2b5278;--tx:#e7edf3;--tx2:#8d9aa8;--ac:#5288c1;--line:#22303f}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.6 "Microsoft JhengHei","Segoe UI",system-ui,sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--panel);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
header h1{font-size:16px;margin:0;font-weight:600}
header .meta{color:var(--tx2);font-size:12px}
header input{flex:1;min-width:180px;background:var(--bg);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:7px 10px;outline:none}
header input:focus{border-color:var(--ac)}
main{max-width:900px;margin:0 auto;padding:16px 12px 60px}
.day{text-align:center;margin:18px 0 10px}
.day span{background:#0008;color:var(--tx2);font-size:12px;padding:3px 12px;border-radius:12px}
.msg{display:flex;margin:6px 0}
.msg.out{justify-content:flex-end}
.bub{background:var(--bub);border-radius:12px;padding:8px 12px;max-width:78%;box-shadow:0 1px 2px #0004}
.msg.out .bub{background:var(--bub-out)}
.who{color:var(--ac);font-weight:600;font-size:12px;margin-bottom:2px}
.msg.out .who{color:#9ec6ef}
.tx{white-space:pre-wrap;word-break:break-word}
.tx mark{background:#e0a536;color:#000;border-radius:2px}
.med{display:inline-flex;gap:6px;align-items:center;margin-top:6px;background:#0003;border:1px solid var(--line);border-radius:8px;padding:5px 9px;font-size:12px;color:var(--tx2)}
.med b{color:var(--tx);font-weight:500}
.foot{color:var(--tx2);font-size:11px;text-align:right;margin-top:4px}
.foot a{color:var(--ac);text-decoration:none}
.sys{text-align:center;color:var(--tx2);font-size:12px;margin:8px 0}
.reply{border-left:3px solid var(--ac);padding-left:7px;color:var(--tx2);font-size:12px;margin-bottom:4px}
.empty{text-align:center;color:var(--tx2);padding:40px}
</style>
</head>
<body>
<header>
  <h1>${esc(title)}</h1>
  <span class="meta" id="cnt"></span>
  <input id="q" placeholder="搜尋文字 / 檔名…">
</header>
<main id="list"></main>
<script id="data" type="application/json">${data}</script>
<script>
var DATA = JSON.parse(document.getElementById('data').textContent);
var list = document.getElementById('list'), q = document.getElementById('q'), cnt = document.getElementById('cnt');
function two(n){return String(n).padStart(2,'0')}
function dstr(t){var d=new Date(t*1000);return d.getFullYear()+'-'+two(d.getMonth()+1)+'-'+two(d.getDate())}
function tstr(t){var d=new Date(t*1000);return two(d.getHours())+':'+two(d.getMinutes())}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function hl(s,k){ if(!k) return esc(s);
  var out='',low=s.toLowerCase(),lk=k.toLowerCase(),i=0,p;
  while((p=low.indexOf(lk,i))>=0){out+=esc(s.slice(i,p))+'<mark>'+esc(s.slice(p,p+k.length))+'</mark>';i=p+k.length}
  return out+esc(s.slice(i));
}
function sizeText(n){if(!n)return '';var u=['B','KB','MB','GB'],i=0,v=n;while(v>=1024&&i<3){v/=1024;i++}return (v<10&&i?v.toFixed(1):Math.round(v))+' '+u[i]}
function render(){
  var k = q.value.trim(), day='', h='';
  var ms = DATA.messages.filter(function(m){
    if(!k) return true;
    var s=(m.text||'')+' '+(m.media&&m.media.fileName||'')+' '+(m.senderName||'');
    return s.toLowerCase().indexOf(k.toLowerCase())>=0;
  });
  cnt.textContent = ms.length + ' / ' + DATA.messages.length + ' 則';
  if(!ms.length){ list.innerHTML='<div class="empty">沒有符合的訊息</div>'; return }
  ms.forEach(function(m){
    var d = dstr(m.date);
    if(d!==day){ day=d; h+='<div class="day"><span>'+d+'</span></div>' }
    if(m.service){ h+='<div class="sys">'+esc(m.text)+'</div>'; return }
    h+='<div class="msg'+(m.out?' out':'')+'"><div class="bub">';
    if(m.senderName||m.out) h+='<div class="who">'+esc(m.out?'我':m.senderName)+'</div>';
    if(m.replyTo) h+='<div class="reply">回覆 #'+m.replyTo+'</div>';
    if(m.forwardFrom) h+='<div class="reply">轉發自 '+esc(m.forwardFrom)+'</div>';
    if(m.text) h+='<div class="tx">'+hl(m.text,k)+'</div>';
    if(m.media){
      var f=m.media.file||m.media.fileName;
      h+='<div class="med">'+esc(m.media.kind)+(f?' · <b>'+esc(f)+'</b>':'')+(m.media.size?' · '+sizeText(m.media.size):'')+'</div>';
    }
    h+='<div class="foot">'+tstr(m.date)+' · #'+m.id+(m.link?' · <a href="'+esc(m.link)+'" target="_blank">原文</a>':'')+'</div>';
    h+='</div></div>';
  });
  list.innerHTML=h;
}
var t; q.addEventListener('input',function(){clearTimeout(t);t=setTimeout(render,180)});
render();
</script>
</body>
</html>`
  await fsp.writeFile(outPath, html, 'utf8')
}

/** 匯出已備好的列(檢索結果 / 掃描結果)。 */
export async function exportRows({ rows = [], format = 'xlsx', outPath, meta = {} }) {
  if (!outPath) throw new Error('缺少輸出路徑')
  if (format === 'json') {
    await writeJson(rows, outPath, meta)
    return { ok: true, path: outPath, count: rows.length }
  }
  if (format === 'html') {
    await writeHtml(rows, outPath, meta)
    return { ok: true, path: outPath, count: rows.length }
  }
  const data = rows.map(toRow)
  if (format === 'csv') await writeCsv(data, outPath)
  else if (format === 'txt') await writeTxt(data, outPath)
  else await writeXlsx(data, outPath)
  return { ok: true, path: outPath, count: data.length }
}

/** 由對話 id + 訊息組出 t.me 連結。 */
export function buildLink(msgId, dialogId) {
  try {
    const entity = getCachedEntity(dialogId)
    if (entity?.username) return `https://t.me/${entity.username}/${msgId}`
    const s = String(dialogId)
    if (s.startsWith('-100')) return `https://t.me/c/${s.slice(4)}/${msgId}`
  } catch {
    /* ignore */
  }
  return ''
}

/**
 * 掃描整個對話(可帶篩選)→ 匯出。
 * @param {{withMediaOnly?:boolean, withTextOnly?:boolean, includeService?:boolean}} options
 */
export async function exportDialogToFile({
  dialogId,
  format = 'xlsx',
  outPath,
  filter = {},
  options = {},
  cap = 30000,
  onProgress
}) {
  const client = getClient()
  if (!client.connected) throw new Error('尚未連線(請檢查代理 / 網路)')
  const entity = getCachedEntity(dialogId)
  if (!entity) throw new Error('對話未載入,請先在對話頁開啟一次')

  const opts = {}
  if (filter.keyword) opts.search = filter.keyword
  if (filter.endDate) opts.offsetDate = filter.endDate

  const rows = []
  let scanned = 0
  for await (const msg of client.iterMessages(entity, opts)) {
    scanned++
    if (scanned > 200000) break
    if (scanned % 500 === 0) onProgress?.({ scanned, matched: rows.length })
    if (filter.startDate && msg.date < filter.startDate) break
    if (filter.endDate && msg.date > filter.endDate) continue
    const media = getMediaInfo(msg)
    if (filter.types?.length) {
      const ok =
        filter.types.includes(media?.kind) ||
        (filter.types.includes('url') && /https?:\/\//.test(msg.message || ''))
      if (!ok) continue
    }
    if (options.withMediaOnly && !media) continue
    if (options.withTextOnly && !(msg.message || '').trim()) continue
    const norm = normalizeMessage(msg, { withThumb: false })
    if (!norm) continue
    if (norm.service && !options.includeService) continue
    norm.link = buildLink(norm.id, dialogId)
    rows.push(norm)
    if (rows.length >= cap) break
  }
  // 由舊到新才符合閱讀順序
  rows.reverse()
  return exportRows({
    rows,
    format,
    outPath,
    meta: { dialogId, dialogTitle: getCachedTitle(dialogId) }
  })
}
