/**
 * FakeTLS(偽 TLS / ee secret)MTProto 代理傳輸層。
 *
 * GramJS 原生只支援純 16-byte / dd secret 的 MTProxy,不支援 FakeTLS(mtg、官方 MTProxy
 * 的 TLS 偽裝模式)。本檔提供一個包在 GramJS PromisedNetSockets 外的 socket:
 *   1) 連線後先送出偽造的 TLS ClientHello、收下並驗證 ServerHello(消化掉握手位元組);
 *   2) 之後對外送出的位元組全部包進 TLS application-data record(0x17 0x03 0x03 len data),
 *      收進來的 record 拆封後交給內層(GramJS 的 MTProxy 混淆層原封不動沿用)。
 *
 * 透過 TelegramClient 的 `networkSocket` 參數注入(僅在啟用的代理為 FakeTLS 時)。
 * 演算法移植自 telethon-faketls(MIT, RevEngine3r),與 mtg / 官方 MTProxy 相容。
 */
import crypto from 'node:crypto'
import { PromisedNetSockets } from 'telegram/extensions/index.js'

const closeError = new Error('NetSocket was closed')

const DEBUG = process.env.TRMA_FAKETLS_DEBUG === '1'
function dbg(...a) {
  if (DEBUG) console.log('[FakeTLS]', ...a)
}

/** 16 組 cipher suites(固定樣板,共 32 bytes)。 */
const CIPHER_SUITES = Buffer.from(
  'fafa130113021303c02bc02fc02cc030cca9cca8c013c014009c009d002f0035',
  'hex'
)

/** 產生一個「看起來合法」的 x25519 公鑰(32 bytes,小端)。只需通過外觀檢查,不做真正金鑰交換。 */
function fakeX25519PublicKey() {
  const P = (1n << 255n) - 19n
  const rnd = BigInt('0x' + crypto.randomBytes(32).toString('hex')) % P
  let v = (rnd * rnd) % P
  const buf = Buffer.alloc(32)
  for (let i = 0; i < 32; i++) {
    buf[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return buf
}

function u16(n) {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n & 0xffff, 0)
  return b
}

/**
 * 組出 ClientHello(固定總長 517 bytes)。
 * @returns {{hello:Buffer, sessionId:Buffer, digest:Buffer}}
 */
function buildClientHello(secret16, domain) {
  const sessionId = crypto.randomBytes(32)
  const keyShare = fakeX25519PublicKey()
  const dLen = domain.length

  // 先用空 padding 組一次,算出要補多少 padding 才剛好 517
  const assemble = (randomField, paddingField, paddingLenField) =>
    Buffer.concat([
      Buffer.from([0x16]), // content_type: handshake
      Buffer.from([0x03, 0x01]), // version TLS 1.0
      Buffer.from([0x02, 0x00]), // record len 512
      Buffer.from([0x01]), // handshake_type: client hello
      Buffer.from([0x00, 0x01, 0xfc]), // handshake_len 508
      Buffer.from([0x03, 0x03]), // handshake_version TLS 1.2
      randomField, // random(32)
      Buffer.from([0x20]), // session_id_len
      sessionId, // session_id(32)
      Buffer.from([0x00, 0x20]), // cipher_suites_len 32
      CIPHER_SUITES, // cipher_suites(32)
      Buffer.from([0x01]), // compression_methods_len
      Buffer.from([0x00]), // compression_methods: null
      Buffer.from([0x01, 0x93]), // extensions_len 403
      Buffer.from([0x4a, 0x4a, 0x00, 0x00]), // GREASE
      // SNI
      Buffer.from([0x00, 0x00]), // server_name(0)
      u16(2 + 1 + 2 + dLen), // ext data len
      u16(1 + 2 + dLen), // server name list len
      Buffer.from([0x00]), // host_name(0)
      u16(dLen), // name len
      domain, // domain
      // 其餘擴充(固定)
      Buffer.from([0x00, 0x17, 0x00, 0x00]), // extended_master_secret
      Buffer.from([0xff, 0x01, 0x00, 0x01, 0x00]), // renegotiation_info
      Buffer.from([0x00, 0x0a, 0x00, 0x0a, 0x00, 0x08, 0xba, 0xba, 0x00, 0x1d, 0x00, 0x17, 0x00, 0x18]), // supported_groups
      Buffer.from([0x00, 0x0b, 0x00, 0x02, 0x01, 0x00]), // ec_point_formats
      Buffer.from([0x00, 0x23, 0x00, 0x00]), // session_ticket
      Buffer.from([0x00, 0x10, 0x00, 0x0e, 0x00, 0x0c, 0x02, 0x68, 0x32, 0x08, 0x68, 0x74, 0x74, 0x70, 0x2f, 0x31, 0x2e, 0x31]), // alpn h2/http1.1
      Buffer.from([0x00, 0x05, 0x00, 0x05, 0x01, 0x00, 0x00, 0x00, 0x00]), // status_request
      Buffer.from([0x00, 0x0d, 0x00, 0x12, 0x00, 0x10, 0x04, 0x03, 0x08, 0x04, 0x04, 0x01, 0x05, 0x03, 0x08, 0x05, 0x05, 0x01, 0x08, 0x06, 0x06, 0x01]), // signature_algorithms
      Buffer.from([0x00, 0x12, 0x00, 0x00]), // signed_certificate_timestamp
      // key share x25519
      Buffer.from([0x00, 0x33]), // key_share(51)
      Buffer.from([0x00, 0x2b]), // len 43
      Buffer.from([0x00, 0x29]), // client key len 41
      Buffer.from([0xba, 0xba, 0x00, 0x01, 0x00]), // GREASE
      Buffer.from([0x00, 0x1d]), // group x25519
      Buffer.from([0x00, 0x20]), // exchange len 32
      keyShare, // x25519 public(32)
      Buffer.from([0x00, 0x2d, 0x00, 0x02, 0x01, 0x01]), // psk_key_exchange_modes
      Buffer.from([0x00, 0x2b, 0x00, 0x0b, 0x0a, 0x9a, 0x9a, 0x03, 0x04, 0x03, 0x03, 0x03, 0x02, 0x03, 0x01]), // supported_versions
      Buffer.from([0x00, 0x1b, 0x00, 0x03, 0x02, 0x00, 0x02]), // compress_certificate
      Buffer.from([0x1a, 0x1a, 0x00, 0x01, 0x00]), // GREASE
      // padding
      Buffer.from([0x00, 0x15]), // padding(21)
      paddingLenField, // padding len
      paddingField // padding(zeros)
    ])

  const zero32 = Buffer.alloc(32)
  const base = assemble(zero32, Buffer.alloc(0), Buffer.from([0x00, 0x00]))
  const padLen = 517 - base.length
  const padding = Buffer.alloc(Math.max(0, padLen))
  const helloZeroRandom = assemble(zero32, padding, u16(padLen))

  // digest = HMAC-SHA256(secret16, 整包 random 為零),最後 4 bytes XOR unixtime(小端)
  const digest = crypto.createHmac('sha256', secret16).update(helloZeroRandom).digest()
  const t = Math.floor(Date.now() / 1000) >>> 0
  const timeLE = Buffer.alloc(4)
  timeLE.writeUInt32LE(t, 0)
  for (let i = 0; i < 4; i++) digest[28 + i] ^= timeLE[i]

  // 把 digest 寫回 random 欄位(offset 11),其餘不變
  const hello = Buffer.from(helloZeroRandom)
  digest.copy(hello, 11)
  return { hello, sessionId, digest }
}

/** 驗證 ServerHello。結構錯誤丟例外(代表對方非 FakeTLS / 拒絕);digest 不符僅警告。 */
function verifyServerHello(resp, sessionId, clientDigest, secret16) {
  if (resp.length < 133) throw new Error('ServerHello 太短(可能不是 FakeTLS 代理)')
  if (!(resp[0] === 0x16 && resp[1] === 0x03 && resp[2] === 0x03)) {
    throw new Error('ServerHello 非合法 TLS 封包')
  }
  const ccs = Buffer.from([0x14, 0x03, 0x03, 0x00, 0x01, 0x01, 0x17, 0x03, 0x03])
  if (!resp.subarray(127, 136).equals(ccs)) {
    throw new Error('ServerHello 結構不符(ChangeCipherSpec 位置錯誤)')
  }
  if (!resp.subarray(44, 76).equals(sessionId)) {
    throw new Error('ServerHello session id 不符')
  }
  const serverDigest = resp.subarray(11, 43)
  const zeroed = Buffer.concat([resp.subarray(0, 11), Buffer.alloc(32), resp.subarray(43)])
  const computed = crypto
    .createHmac('sha256', secret16)
    .update(Buffer.concat([clientDigest, zeroed]))
    .digest()
  if (!serverDigest.equals(computed)) {
    dbg('警告:server digest 不符(secret 可能不對,仍嘗試續連)')
  }
}

export class FakeTlsSocket extends PromisedNetSockets {
  constructor(proxy) {
    super(proxy)
    this._secret16 = Buffer.from(proxy.secret, 'hex')
    this._domain = Buffer.from(proxy.tlsDomain || '', 'hex')
    this._tlsReady = false
    // 待讀的內層資料用「chunk 佇列」而非單一會長大的 Buffer。
    // 舊作法(this._inner = Buffer.concat([this._inner, payload]))在代理一次倒大量資料時,
    // 每收一個 16KB record 就把整包已累積緩衝重複製一次 → O(n²) memcpy(16MB 爆量 ≈ 8GB 搬運),
    // 主執行緒被卡死數秒、UI 點不動、下一批請求發不出去(吞吐反而更慢)。佇列讓收/讀都是 O(1)。
    this._chunks = []
    this._innerCanRead = new Promise((res) => (this._innerResolve = res))
  }

  /** 從原始 socket 串流(super 的 this.stream)精確讀 n bytes。 */
  async _rawReadExactly(n) {
    let buf = Buffer.alloc(0)
    while (buf.length < n) {
      const chunk = await super.read(n - buf.length)
      if (!chunk || chunk.length === 0) throw closeError
      buf = Buffer.concat([buf, chunk])
    }
    return buf
  }

  async connect(port, ip, testServers) {
    await super.connect(port, ip, testServers)
    // 關閉 Nagle:下載是「送小請求→等大回應」的乒乓模式,Nagle 會把每個請求延遲送出 → 拖慢吞吐
    try {
      this.client?.setNoDelay?.(true)
      // GramJS 每次 read 會在 socket 掛短暫的 data/error 監聽器;管線化多個 in-flight 時會超過
      // 預設 10 上限而噴 MaxListenersExceededWarning。拉高門檻(單連線本就不會真的洩漏)。
      this.client?.setMaxListeners?.(64)
    } catch {
      /* ignore */
    }
    dbg('TCP connected, sending ClientHello…', ip + ':' + port)

    const { hello, sessionId, digest } = buildClientHello(this._secret16, this._domain)
    super.write(hello)

    // ServerHello: 先讀 138 bytes,末 2 bytes 是 application-data record 長度,再讀完它
    const head = await this._rawReadExactly(138)
    const httpLen = head.readUInt16BE(136)
    const rest = httpLen ? await this._rawReadExactly(httpLen) : Buffer.alloc(0)
    verifyServerHello(Buffer.concat([head, rest]), sessionId, digest, this._secret16)
    dbg('ServerHello ok, handshake done')

    this._tlsReady = true
    this._chunks = []
    this._innerCanRead = new Promise((res) => (this._innerResolve = res))
    this._pump()
    return this
  }

  /** 背景:不斷拆 TLS record,把 application-data payload 餵進內層緩衝。 */
  async _pump() {
    try {
      while (!this.closed) {
        const recHead = await this._rawReadExactly(5) // type(1)+version(2)+len(2)
        const type = recHead[0]
        const len = recHead.readUInt16BE(3)
        const payload = len ? await this._rawReadExactly(len) : Buffer.alloc(0)
        if (type === 0x17 && payload.length) {
          this._chunks.push(payload) // O(1):不再每次重組整包
          if (this._innerResolve) this._innerResolve(true)
        }
        // 0x14 change_cipher_spec 等其他 record 直接忽略
      }
    } catch {
      this.closed = true
      if (this._innerResolve) this._innerResolve(false)
    }
  }

  async read(number) {
    if (!this._tlsReady) return super.read(number)
    if (this.closed) throw closeError
    // 等到佇列有資料(while 防偽喚醒,並在 await 前先檢查長度 → 避開與 _pump 推入的競態)。
    while (this._chunks.length === 0) {
      await this._innerCanRead
      if (this.closed) throw closeError
    }
    // 一次只回最前一個 chunk(最多 number bytes);GramJS 的 readExactly 會自行迴圈補足,
    // 所以不需要把多個 chunk concat 起來 → 完全避免複製。
    const head = this._chunks[0]
    let toReturn
    if (head.length <= number) {
      this._chunks.shift()
      toReturn = head
    } else {
      toReturn = head.subarray(0, number)
      this._chunks[0] = head.subarray(number)
    }
    if (this._chunks.length === 0) {
      this._innerCanRead = new Promise((res) => (this._innerResolve = res))
    }
    return toReturn
  }

  write(data) {
    if (!this._tlsReady) return super.write(data)
    const MAX = 16384
    const out = []
    for (let off = 0; off < data.length; off += MAX) {
      const chunk = data.subarray(off, Math.min(off + MAX, data.length))
      out.push(Buffer.from([0x17, 0x03, 0x03]), u16(chunk.length), chunk)
    }
    super.write(Buffer.concat(out))
  }

  async close() {
    await super.close()
    if (this._innerResolve) this._innerResolve(false)
  }
}
