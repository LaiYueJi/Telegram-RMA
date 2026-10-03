/**
 * 媒體相關純工具(只依賴 GramJS,不碰 electron,方便獨立測試)。
 * 負責:判斷媒體類型、取檔名/大小/時長/尺寸、抽取 stripped 縮圖。
 */
import { Api } from 'telegram'
import { strippedPhotoToJpg } from 'telegram/Utils.js'

/**
 * 取出「真的可以下載」的媒體物件(要餵給 iterDownload / getFileInfo 的那個)。
 *
 * ⚠️ GramJS 的 `message.photo` / `message.document` 是 getter,除了真正的媒體訊息之外,
 * 連「服務訊息的換頭像圖(MessageActionChatEditPhoto)」和「連結預覽的縮圖(webPreview)」
 * 也會回傳 Photo/Document —— 但這兩種的 `message.media` 分別是 undefined 與 MessageMediaWebPage,
 * 丟給 getFileInfo 會炸 `Cannot cast undefined to any kind of InputFileLocation`。
 * 所以凡是要下載的地方,一律用這個函式取檔案位置,取不到就別排進下載佇列。
 *
 * @returns {object|null} MessageMediaPhoto / MessageMediaDocument,或 null
 */
export function getDownloadableMedia(message) {
  const media = message?.media
  if (!media) return null
  if (media.className === 'MessageMediaPhoto' && media.photo?.className === 'Photo') return media
  if (media.className === 'MessageMediaDocument' && media.document?.className === 'Document') return media
  return null
}

/**
 * 判斷一則訊息的媒體種類與基本資訊。
 * @param {object} message
 * @param {{downloadableOnly?:boolean}} [opts] downloadableOnly=true 時,
 *        服務訊息頭像 / 連結預覽圖這類「看得到但下載不了」的一律回 null(下載流程要用這個)
 * @returns {null | {kind:string, fileName:string, size:number, duration:number, width:number, height:number, mime:string}}
 */
export function getMediaInfo(message, opts = {}) {
  if (!message) return null
  if (opts.downloadableOnly && !getDownloadableMedia(message)) return null

  // 相片
  if (message.photo && message.photo.className === 'Photo') {
    const sizes = message.photo.sizes || []
    const big = sizes[sizes.length - 1] || {}
    return {
      kind: 'photo',
      fileName: '',
      size: photoByteSize(sizes),
      duration: 0,
      width: big.w || 0,
      height: big.h || 0,
      mime: 'image/jpeg'
    }
  }

  // 文件 / 影片 / 音訊 / 貼圖 / GIF
  const doc = message.document
  if (doc && doc.className === 'Document') {
    const attrs = doc.attributes || []
    const fileAttr = attrs.find((a) => a.className === 'DocumentAttributeFilename')
    const videoAttr = attrs.find((a) => a.className === 'DocumentAttributeVideo')
    const audioAttr = attrs.find((a) => a.className === 'DocumentAttributeAudio')
    const stickerAttr = attrs.find((a) => a.className === 'DocumentAttributeSticker')
    const animated = attrs.find((a) => a.className === 'DocumentAttributeAnimated')
    const imageSize = attrs.find((a) => a.className === 'DocumentAttributeImageSize')
    const mime = doc.mimeType || ''

    let kind = 'document'
    if (stickerAttr) kind = 'sticker'
    else if (animated || mime === 'image/gif') kind = 'gif'
    else if (videoAttr) kind = 'video'
    else if (audioAttr) kind = audioAttr.voice ? 'voice' : 'audio'
    else if (mime.startsWith('image/')) kind = 'photo'

    return {
      kind,
      fileName: fileAttr?.fileName || '',
      size: Number(doc.size || 0),
      duration: Math.round(videoAttr?.duration || audioAttr?.duration || 0),
      width: videoAttr?.w || imageSize?.w || 0,
      height: videoAttr?.h || imageSize?.h || 0,
      mime
    }
  }

  // 其他(連結預覽 / 地理位置 / 投票…)暫不視為可下載媒體
  return null
}

/**
 * 相片大小。
 * ⚠️ 一定要跟 GramJS 的 `utils.getFileInfo` 同一套規則:它固定取 **sizes 的最後一項**
 * (`thumbSize: sizes[sizes.length-1].type`)去下載。以前這裡取「所有尺寸的最大值」,
 * 遇到最後一項不是最大的相片就會對不上,下載完變成「大小不符(61497/71796)」被誤判成失敗。
 */
function photoByteSize(sizes) {
  if (!sizes?.length) return 0
  return photoSizeByteCount(sizes[sizes.length - 1])
}

/** 單一 PhotoSize 物件的 byte 數(對齊 GramJS 的 _photoSizeByteCount)。 */
function photoSizeByteCount(s) {
  if (!s) return 0
  if (typeof s.size === 'number') return s.size // PhotoSize
  if (Array.isArray(s.sizes) && s.sizes.length) return s.sizes[s.sizes.length - 1] // PhotoSizeProgressive
  if (s.bytes?.length) {
    if (s.className === 'PhotoStrippedSize') {
      return s.bytes.length < 3 || s.bytes[0] !== 1 ? s.bytes.length : s.bytes.length + 622
    }
    return s.bytes.length // PhotoCachedSize
  }
  return 0
}

/** 取出 stripped 縮圖的原始 bytes(極小、可即時顯示模糊預覽)。 */
export function getStrippedBytes(message) {
  const container = message.photo || message.document
  if (!container) return null
  const sizes = message.photo ? message.photo.sizes : message.document.thumbs
  if (!sizes) return null
  const s = sizes.find((x) => x.className === 'PhotoStrippedSize')
  return s?.bytes || null
}

/** stripped 縮圖 → data URL(模糊即時預覽)。 */
export function getStrippedThumbDataUrl(message) {
  const bytes = getStrippedBytes(message)
  if (!bytes) return null
  try {
    const jpg = strippedPhotoToJpg(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))
    return 'data:image/jpeg;base64,' + Buffer.from(jpg).toString('base64')
  } catch {
    return null
  }
}

/** 從訊息的 thumbs/sizes 選一個適合當「清晰小縮圖」的 size 物件(供 downloadMedia thumb 用)。 */
export function pickThumbSize(message) {
  const sizes = message.photo ? message.photo.sizes : message.document?.thumbs
  if (!sizes || !sizes.length) return null
  // 只要真實點陣 size,挑寬度最小的那個(夠當縮圖、最省流量)
  const real = sizes.filter(
    (s) => s.className === 'PhotoSize' || s.className === 'PhotoSizeProgressive'
  )
  if (!real.length) return null
  real.sort((a, b) => (a.w || 0) - (b.w || 0))
  return real[0]
}

/** 是否有任何縮圖可顯示。 */
export function hasThumb(message) {
  return !!(getStrippedBytes(message) || pickThumbSize(message))
}

/** 由媒體種類推一個合理副檔名。 */
export function extForKind(kind, mime) {
  if (mime) {
    const map = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg'
    }
    if (map[mime]) return map[mime]
    const sub = mime.split('/')[1]
    if (sub) return sub.replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin'
  }
  const byKind = { photo: 'jpg', video: 'mp4', voice: 'ogg', audio: 'mp3', gif: 'mp4', sticker: 'webp' }
  return byKind[kind] || 'bin'
}
