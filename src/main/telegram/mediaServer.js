/**
 * 自訂協定 tgmedia://media/<dialogId>/<msgId>
 * 供 renderer 的 <img>/<video> 直接點開原始媒體:
 *   - 相片/貼圖:downloadMedia 取完整 buffer(小、落地快取)→ 200。
 *   - 影片/GIF/音訊/文件:iterDownload(msg.media) 邊載邊送,支援 HTTP Range(206)→ 可邊載邊播、可拖動進度。
 * 每送出一段就餵 speedmeter,讓頂部網速在「看影片」時也會動。
 */
import { protocol } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import bigInt from 'big-integer'
import { getClient } from './client.js'
import { getRawMessage } from './messages.js'
import { getMediaInfo, getDownloadableMedia, extForKind } from './media.js'
import { config } from '../store/config.js'
import { addDown } from '../net/speedmeter.js'

export const MEDIA_SCHEME = 'tgmedia'

const REQUEST_SIZE = 512 * 1024 // GramJS 上限,影片串流用最大段省往返

/** 解析 tgmedia://media/<dialogId>/<msgId> → { dialogId, msgId } */
function parseUrl(rawUrl) {
  const u = new URL(rawUrl)
  const parts = u.pathname.split('/').filter(Boolean)
  return { dialogId: decodeURIComponent(parts[0] || ''), msgId: Number(parts[1] || 0) }
}

/** 相片:完整下載 + 落地快取,回完整 buffer。 */
async function loadPhotoBuffer(dialogId, msgId, msg, media) {
  const cacheDir = join(config.getPaths().cacheDir, 'media')
  fs.mkdirSync(cacheDir, { recursive: true })
  const ext = extForKind(media.kind, media.mime)
  const file = join(cacheDir, `${String(dialogId).replace(/[^\d-]/g, '_')}_${msgId}.${ext}`)
  try {
    const st = await fsp.stat(file)
    if (st.size > 0) return await fsp.readFile(file)
  } catch {
    /* 未快取 */
  }
  const buf = await getClient().downloadMedia(msg, {})
  const out = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
  if (out.length) {
    addDown(out.length)
    fsp.writeFile(file, out).catch(() => {})
  }
  return out
}

/** 解析 Range 標頭 → { start, end } (end 含)。無 Range 回 null。 */
function parseRange(header, size) {
  if (!header) return null
  const m = /bytes=(\d*)-(\d*)/.exec(header)
  if (!m) return null
  let start = m[1] ? parseInt(m[1], 10) : 0
  let end = m[2] ? parseInt(m[2], 10) : size - 1
  if (Number.isNaN(start)) start = 0
  if (Number.isNaN(end) || end >= size) end = size - 1
  if (start > end) start = 0
  return { start, end }
}

/** 影片/文件:用 iterDownload 從 offset 串流到所需長度,pull-based 背壓。 */
function streamDocument(msg, media, range) {
  const size = media.size || 0
  const r = range || { start: 0, end: size - 1 }
  const need = r.end - r.start + 1

  const iter = getClient().iterDownload({
    file: getDownloadableMedia(msg) || msg.media,
    offset: bigInt(r.start),
    fileSize: bigInt(size),
    requestSize: REQUEST_SIZE
  })
  const ait = iter[Symbol.asyncIterator]()
  let sent = 0
  let closed = false
  const stopIter = async () => {
    try {
      await ait.return?.()
    } catch {
      /* ignore */
    }
  }

  const body = new ReadableStream({
    async pull(controller) {
      if (closed) return
      try {
        if (sent >= need) {
          closed = true
          controller.close()
          await stopIter()
          return
        }
        const { value, done } = await ait.next()
        if (done || !value) {
          closed = true
          controller.close()
          return
        }
        let chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        if (sent + chunk.length > need) chunk = chunk.subarray(0, need - sent)
        controller.enqueue(new Uint8Array(chunk))
        addDown(chunk.length)
        sent += chunk.length
        if (sent >= need) {
          closed = true
          controller.close()
          await stopIter()
        }
      } catch (e) {
        closed = true
        controller.error(e)
        await stopIter()
      }
    },
    async cancel() {
      closed = true
      await stopIter()
    }
  })

  const headers = {
    'Content-Type': media.mime || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(need),
    'Cache-Control': 'no-store'
  }
  if (range) {
    headers['Content-Range'] = `bytes ${r.start}-${r.end}/${size}`
    return new Response(body, { status: 206, headers })
  }
  return new Response(body, { status: 200, headers })
}

/** 註冊協定處理器(須在 app ready 後)。 */
export function registerMediaProtocol() {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const { dialogId, msgId } = parseUrl(request.url)
      const msg = getRawMessage(dialogId, msgId)
      if (!msg) return new Response('message not in cache', { status: 404 })
      const media = getMediaInfo(msg)
      if (!media) return new Response('no media', { status: 404 })

      // 相片/貼圖:完整 buffer
      if (media.kind === 'photo' || media.kind === 'sticker') {
        const buf = await loadPhotoBuffer(dialogId, msgId, msg, media)
        if (!buf.length) return new Response('empty', { status: 500 })
        return new Response(new Uint8Array(buf), {
          status: 200,
          headers: { 'Content-Type': media.mime || 'image/jpeg', 'Cache-Control': 'no-store' }
        })
      }

      // 影片/GIF/音訊/文件:Range 串流
      const range = parseRange(request.headers.get('range'), media.size || 0)
      return streamDocument(msg, media, range)
    } catch (e) {
      return new Response('error: ' + String(e?.message || e), { status: 500 })
    }
  })
}
