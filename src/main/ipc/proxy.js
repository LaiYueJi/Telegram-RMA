/** 代理相關 IPC:清單 / 新增儲存 / 刪除 / 切換 / 測試 ping / 解析連結 / 自動偵測。 */
import net from 'node:net'
import dns from 'node:dns/promises'
import { config } from '../store/config.js'
import * as tg from '../telegram/client.js'
import { clearCaches } from '../telegram/dialogs.js'
import { clearRawCache } from '../telegram/messages.js'

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

/** 單次 TCP 三向交握耗時(ms),逾時/失敗回 -1。host 須為 IP(DNS 已在外層解析掉)。 */
function tcpConnectOnce(host, port, timeout) {
  return new Promise((resolve) => {
    const start = Date.now()
    const sock = new net.Socket()
    let done = false
    const finish = (val) => {
      if (done) return
      done = true
      sock.destroy()
      resolve(val)
    }
    sock.setTimeout(timeout)
    sock.once('connect', () => finish(Date.now() - start))
    sock.once('timeout', () => finish(-1))
    sock.once('error', () => finish(-1))
    sock.connect(Number(port), host)
  })
}

/**
 * 測代理延遲(ms),失敗回 -1。
 * 重點:① 先把網域 DNS 解析成 IP(很多 MTProto 代理 server 是網域,DNS 查詢時間不該算進延遲);
 * ② 連測數次取「最小值」,丟掉第一次冷連線與抖動 → 數字穩定且更接近真實 RTT。
 * 注意:這量的是「你 ↔ 代理」的 TCP 握手,與官方客戶端顯示的「完整路徑 MTProto 往返」定義不同,
 * 已連線的 active 代理請改用 proxy:ping(走 client.pingActive)。
 */
async function tcpPing(host, port, { timeout = 5000, samples = 3 } = {}) {
  let ip = host
  try {
    const r = await dns.lookup(host) // 是 IP 字面值時等同直接回傳,不會真的查 DNS
    ip = r.address
  } catch {
    return -1 // 連網域都解不出來
  }
  let best = -1
  for (let i = 0; i < samples; i++) {
    const ms = await tcpConnectOnce(ip, port, timeout)
    if (ms >= 0 && (best < 0 || ms < best)) best = ms
  }
  return best
}

/** 解析 tg://proxy / https://t.me/proxy / tg://socks 連結。 */
function parseProxyLink(link) {
  const s = String(link).trim()
  let kind, qs
  const m = s.match(/(?:tg:\/\/|https?:\/\/t\.me\/)(proxy|socks)\?(.*)$/i)
  if (!m) throw new Error('無法辨識的代理連結')
  kind = m[1].toLowerCase()
  qs = new URLSearchParams(m[2])
  const ip = qs.get('server') || qs.get('ip')
  const port = qs.get('port')
  if (!ip || !port) throw new Error('連結缺少 server / port')
  if (kind === 'proxy' && qs.get('secret')) {
    return { type: 'mtproto', ip, port, secret: qs.get('secret') }
  }
  return {
    type: 'socks',
    ip,
    port,
    socksType: 5,
    username: qs.get('user') || '',
    password: qs.get('pass') || ''
  }
}

export function registerProxy(ipcMain) {
  ipcMain.handle('proxy:list', () => ({
    proxies: config.getProxies().map((p) => ({
      ...p,
      fakeTls: p.type === 'mtproto' && tg.isFakeTlsSecret(p.secret)
    })),
    activeId: config.getActiveProxyId()
  }))

  ipcMain.handle('proxy:save', (_e, proxy) => {
    delete proxy.fakeTls // 衍生欄位,不落地
    const list = config.getProxies()
    if (proxy.id) {
      const i = list.findIndex((p) => p.id === proxy.id)
      if (i >= 0) list[i] = { ...list[i], ...proxy }
      else list.push(proxy)
    } else {
      proxy.id = genId()
      list.push(proxy)
    }
    config.setProxies(list)
    const fakeTls = proxy.type === 'mtproto' && tg.isFakeTlsSecret(proxy.secret)
    return { ok: true, id: proxy.id, proxies: list, fakeTls }
  })

  ipcMain.handle('proxy:delete', (_e, { id }) => {
    const list = config.getProxies().filter((p) => p.id !== id)
    config.setProxies(list)
    if (config.getActiveProxyId() === id) config.setActiveProxyId(null)
    return { ok: true, proxies: list, activeId: config.getActiveProxyId() }
  })

  ipcMain.handle('proxy:setActive', async (_e, { id }) => {
    config.setActiveProxyId(id) // id 可為 null = 不啟用代理
    // 代理變更會重建 client,舊 client 綁定的 entity / raw 訊息快取全部失效,必清
    // 否則切換代理後 loadMessages 會用舊 client 的 entity 而永久卡住
    clearCaches()
    clearRawCache()
    return await tg.rebuildAndReconnect() // { ok, authorized, user, error }
  })

  ipcMain.handle('proxy:test', async (_e, { ip, port }) => {
    const ms = await tcpPing(ip, port)
    return { ok: ms >= 0, ping: ms }
  })

  // 已連線中的 active 代理:量真正的 MTProto 往返(與官方客戶端同定義),最準。
  ipcMain.handle('proxy:ping', async () => {
    const ms = await tg.pingActive()
    return { ok: ms >= 0, ping: ms }
  })

  ipcMain.handle('proxy:parseLink', (_e, { link }) => {
    try {
      return { ok: true, proxy: parseProxyLink(link) }
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('proxy:autodetect', async () => {
    // 探測常見本機代理埠
    const candidates = [
      { type: 'socks', ip: '127.0.0.1', port: 7890, socksType: 5, label: 'Clash 7890' },
      { type: 'socks', ip: '127.0.0.1', port: 10808, socksType: 5, label: 'V2Ray 10808' },
      { type: 'socks', ip: '127.0.0.1', port: 1080, socksType: 5, label: 'SOCKS 1080' },
      { type: 'socks', ip: '127.0.0.1', port: 7891, socksType: 5, label: 'Clash 7891' }
    ]
    const found = []
    for (const c of candidates) {
      const ms = await tcpPing(c.ip, c.port, { timeout: 800, samples: 1 })
      if (ms >= 0) found.push({ ...c, ping: ms })
    }
    return { found }
  })
}
