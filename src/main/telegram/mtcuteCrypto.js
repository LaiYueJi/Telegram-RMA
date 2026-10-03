/**
 * 給 @mtcute/convert 用的加密提供者(IExtendedCryptoProvider)。
 *
 * 為什麼自寫:@mtcute/convert 的預設 crypto 走 `@mtcute/node`,而後者相依
 * `better-sqlite3`(原生模組,Electron 需重編)—— 我們只需 tdata 轉換,不想背這包。
 * 這裡用 Node 內建 `crypto` + 自實作 AES-IGE(Node/OpenSSL 未暴露 ige 模式)湊齊介面。
 * 已用 GramJS session ↔ tdata 來回轉換驗證 authKey/DC 完整保留。
 */
import crypto from 'node:crypto'
import zlib from 'node:zlib'

function xor(a, b) {
  const o = Buffer.allocUnsafe(a.length)
  for (let i = 0; i < a.length; i++) o[i] = a[i] ^ b[i]
  return o
}
function ecbEncrypt(key, block) {
  const c = crypto.createCipheriv('aes-' + key.length * 8 + '-ecb', key, null)
  c.setAutoPadding(false)
  return Buffer.concat([c.update(block), c.final()])
}
function ecbDecrypt(key, block) {
  const d = crypto.createDecipheriv('aes-' + key.length * 8 + '-ecb', key, null)
  d.setAutoPadding(false)
  return Buffer.concat([d.update(block), d.final()])
}

/** AES-IGE 加密。iv 為 32 bytes(前 16 = c_{-1},後 16 = p_{-1})。 */
function igeEncrypt(data, key, iv) {
  const n = data.length / 16
  let prevC = Buffer.from(iv.subarray(0, 16))
  let prevP = Buffer.from(iv.subarray(16, 32))
  const out = Buffer.allocUnsafe(data.length)
  for (let i = 0; i < n; i++) {
    const m = Buffer.from(data.subarray(i * 16, i * 16 + 16))
    const c = xor(ecbEncrypt(key, xor(m, prevC)), prevP)
    c.copy(out, i * 16)
    prevC = c
    prevP = m
  }
  return out
}
/** AES-IGE 解密。 */
function igeDecrypt(data, key, iv) {
  const n = data.length / 16
  let prevC = Buffer.from(iv.subarray(0, 16))
  let prevP = Buffer.from(iv.subarray(16, 32))
  const out = Buffer.allocUnsafe(data.length)
  for (let i = 0; i < n; i++) {
    const c = Buffer.from(data.subarray(i * 16, i * 16 + 16))
    const m = xor(ecbDecrypt(key, xor(c, prevP)), prevC)
    m.copy(out, i * 16)
    prevC = c
    prevP = m
  }
  return out
}

/** @type {object|null} */
let provider = null

/** 取得(記憶化)給 @mtcute/convert 的加密提供者。 */
export function getConvertCrypto() {
  if (provider) return provider
  provider = {
    sha1: (d) => crypto.createHash('sha1').update(d).digest(),
    sha256: (d) => crypto.createHash('sha256').update(d).digest(),
    pbkdf2: (pw, salt, iterations, keylen = 64, algo = 'sha512') =>
      crypto.pbkdf2Sync(pw, salt, iterations, keylen, algo),
    hmacSha256: (d, key) => crypto.createHmac('sha256', key).update(d).digest(),
    createAesCtr: (key, iv) => {
      const c = crypto.createCipheriv('aes-' + key.length * 8 + '-ctr', key, iv)
      return { process: (d) => c.update(d) }
    },
    createAesIge: (key, iv) => ({
      encrypt: (d) => igeEncrypt(Buffer.from(d), Buffer.from(key), Buffer.from(iv)),
      decrypt: (d) => igeDecrypt(Buffer.from(d), Buffer.from(key), Buffer.from(iv))
    }),
    // tdata 轉換用不到 PQ 分解;保留介面完整性
    factorizePQ: () => {
      throw new Error('factorizePQ 未實作(tdata 轉換不需要)')
    },
    gzip: (d, maxSize) => {
      const r = zlib.gzipSync(d)
      return r.length > maxSize ? null : r
    },
    gunzip: (d) => zlib.gunzipSync(d),
    randomFill: (b) => crypto.randomFillSync(b),
    randomBytes: (n) => crypto.randomBytes(n),
    // IExtendedCryptoProvider 的擴充:tdata 檔名雜湊(md5)與本機金鑰(sha512)
    createHash: (algo) => {
      const h = crypto.createHash(algo)
      return { update: (d) => h.update(d), digest: () => h.digest() }
    }
  }
  return provider
}
