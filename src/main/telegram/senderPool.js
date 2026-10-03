/**
 * 多連線下載池:對同一個 media DC 開「多條獨立 MTProtoSender(各自一條 TCP)」。
 *
 * 為什麼需要:Telegram 的下載限速是「每連線」的。GramJS 高階層每個 DC 只保留
 * 一個 exported sender(telegramBaseClient 的 _exportedSenderPromises 以 dcId 為 key),
 * 所以同一檔案再怎麼分段並發,也全擠在同一條 socket 上、撞到單連線頻寬上限。
 * 官方客戶端的作法是對同一個 DC 開多條連線各抓不同 offset — 這個模組就是做這件事:
 * 自己持有連線池、繞過 GramJS 那個「每 DC 單 sender」的限制。
 *
 * 建立方式與 GramJS 的 _borrowExportedSender 完全一致(_createExportedSender +
 * _connectSender),非主 DC 會自動 ExportAuthorization/ImportAuthorization,所以安全。
 *
 * 生命週期:池以「目前的 client 實例」為界。client 被重建(換代理/換帳號/登出)時,
 * 舊池自動作廢並斷線(resetSenderPool 或下次取用時偵測 client 變更)。
 */

const DL_DEBUG = process.env.TRMA_DL_DEBUG === '1'
function dlog(...a) {
  if (DL_DEBUG) console.log('[DL]', ...a)
}

let poolClient = null
/** dcId -> Promise<MTProtoSender[]> */
const pools = new Map()

/**
 * 建立單一 exported sender,失敗自動重試。
 * 慢代理常在握手/ImportAuthorization 逾時,一次失敗不代表建不起來 → 退避重試幾次再放棄。
 */
async function connectOne(client, dcId, attempts = 3) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      const sender = client._createExportedSender(dcId)
      await client._connectSender(sender, dcId)
      return sender
    } catch (e) {
      lastErr = e
      dlog(`連線建立第 ${i + 1}/${attempts} 次失敗:`, String(e?.errorMessage || e?.message || e))
      await new Promise((r) => setTimeout(r, 600))
    }
  }
  throw lastErr
}

/** 同步搶下目前所有池、立即清空,再非同步把舊連線斷掉(避免與新池互相覆蓋)。 */
function disconnectAll() {
  const old = [...pools.values()]
  pools.clear()
  poolClient = null
  ;(async () => {
    for (const p of old) {
      try {
        const senders = await p
        for (const s of senders) {
          try {
            await s.disconnect()
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* 建池本身就失敗,沒有連線要斷 */
      }
    }
  })()
}

/** 換 client / 換代理 / 登出時呼叫:斷掉所有下載連線。 */
export function resetSenderPool() {
  disconnectAll()
}

async function buildPool(client, dcId, count) {
  const senders = []
  // 逐條建立(序列化授權匯入,避免同 DC 多連線同時 export/import 互相干擾),每條失敗會自動重試。
  // 優雅降級:若某條重試後仍建不起來(代理限制同時連線數等),就用「已建起的這幾條」而不是整池放棄
  // 退回單條 —— 3 條也比 1 條快。連一條都建不起來才算真失敗。
  for (let i = 0; i < count; i++) {
    try {
      senders.push(await connectOne(client, dcId))
    } catch (e) {
      if (senders.length) {
        dlog(`只建起 ${senders.length}/${count} 條連線,第 ${senders.length + 1} 條放棄:`, String(e?.errorMessage || e?.message || e))
        break
      }
      throw e
    }
  }
  dlog(`連線池建立完成:${senders.length}/${count} 條 @ DC${dcId}`)
  return senders
}

function startPool(client, dcId, count) {
  const p = buildPool(client, dcId, Math.max(1, count))
  pools.set(dcId, p)
  // 建失敗 → 移除快取,下次重建
  p.catch(() => {
    if (pools.get(dcId) === p) pools.delete(dcId)
  })
  return p
}

/**
 * 取得某 DC 的下載連線池(首次建立、之後快取重用)。
 * 會驗證快取的連線是否仍在線;若有任何一條已斷(網路抖動後殘留死連線),整池重建。
 * @param {import('telegram').TelegramClient} client 目前 client(由呼叫端傳入,避免循環相依)
 * @param {number} dcId media 所在 DC
 * @param {number} count 想要的連線數
 * @returns {Promise<object[]>} 已連線的 MTProtoSender 陣列(長度可能 < count,但至少 1)
 */
export async function getSenders(client, dcId, count) {
  if (client !== poolClient) {
    disconnectAll() // 會把 poolClient 設回 null
    poolClient = client
  }
  let p = pools.get(dcId)
  if (p) {
    try {
      const senders = await p
      // 需求連線數 <= 既有池且全部在線 → 重用;需求變多(如把設定 4→8)則重建,避免只拿到舊的 4 條。
      if (senders.length >= count && senders.every((s) => s.isConnected())) return senders
      // 死連線 / 數量不足 → 全部斷掉重建
      for (const s of senders) {
        try {
          await s.disconnect()
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* 上次建池就失敗,直接重建 */
    }
    if (pools.get(dcId) === p) pools.delete(dcId)
    p = null
  }
  return startPool(client, dcId, count)
}
