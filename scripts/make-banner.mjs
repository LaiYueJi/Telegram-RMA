/**
 * 產生 README 橫幅:docs/banner.png(左邊 app 圖示+名稱+功能標籤,右邊示意介面)。
 * 用 @resvg/resvg-js 把 SVG 轉 PNG,字型吃系統的微軟正黑體 / Segoe UI。
 * 執行:node scripts/make-banner.mjs
 */
import { Resvg } from '@resvg/resvg-js'
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, '..', 'docs')
fs.mkdirSync(outDir, { recursive: true })

const W = 1280
const H = 440
const CJK = 'Microsoft JhengHei'
const LATIN = 'Segoe UI'
const PLANE = 'M498.1 5.6c10.1 7 15.4 19.1 13.5 31.2l-64 416c-1.5 9.7-7.4 18.2-16 23s-18.9 5.4-28 1.6L284 427.7l-68.5 74.1c-8.9 9.7-22.9 12.9-35.2 8.1S160 493.2 160 480V396.4c0-4 1.5-7.8 4.2-10.7L331.8 202.8c5.8-6.3 5.6-16-.4-22s-15.7-6.4-22-.7L106 360.8 17.7 316.6C7.1 311.3.3 300.7 0 288.9s5.9-22.8 16.1-28.7l448-256c10.5-6 23.4-5.3 33 1.4z'

// 功能標籤(兩排)
const chipRows = [
  ['對話瀏覽', '批量下載', '批量轉發', '消息檢索'],
  ['多格式匯出', '自動化', '多帳號', 'MTProto 代理']
]
function chips(x0, y0) {
  const fs = 17
  let out = ''
  chipRows.forEach((row, ri) => {
    let x = x0
    const y = y0 + ri * 46
    for (const label of row) {
      const cjk = [...label].filter((c) => c.charCodeAt(0) > 0x2e80).length
      const latin = [...label].length - cjk
      const w = Math.round(cjk * fs + latin * fs * 0.56 + 30)
      out += `<rect x="${x}" y="${y}" width="${w}" height="34" rx="17" fill="#ffffff" fill-opacity="0.07" stroke="#aab4ff" stroke-opacity="0.28"/>`
      out += `<text x="${x + w / 2}" y="${y + 23}" text-anchor="middle" font-family="${CJK}" font-size="${fs}" fill="#dfe3ff">${label}</text>`
      x += w + 10
    }
  })
  return out
}

// 右側示意介面(純裝飾,不含任何真實資料)
function mockup(x, y) {
  const w = 330
  const h = 300
  let s = `<g transform="translate(${x} ${y})">`
  s += `<rect width="${w}" height="${h}" rx="18" fill="#161b3d" stroke="#ffffff" stroke-opacity="0.10" filter="url(#shadow)"/>`
  // 標題列
  s += `<path d="M0 18a18 18 0 0 1 18-18h${w - 36}a18 18 0 0 1 18 18v16H0z" fill="#1d2350"/>`
  ;['#ff6b81', '#ffc75f', '#3ee6a0'].forEach((c, i) => (s += `<circle cx="${20 + i * 16}" cy="17" r="5" fill="${c}"/>`))
  s += `<rect x="${w - 92}" y="12" width="72" height="10" rx="5" fill="#ffffff" fill-opacity="0.10"/>`
  // 側欄
  s += `<rect x="0" y="34" width="54" height="${h - 34}" fill="#121633"/>`
  for (let i = 0; i < 5; i++) {
    s += `<rect x="15" y="${52 + i * 44}" width="24" height="24" rx="7" fill="${i === 1 ? 'url(#brand)' : '#ffffff'}" fill-opacity="${i === 1 ? 1 : 0.09}"/>`
  }
  // 對話列
  const avatars = ['#5b6cff', '#ff8a65', '#3ee6a0', '#c77dff']
  avatars.forEach((c, i) => {
    const ry = 50 + i * 40
    s += `<circle cx="80" cy="${ry + 12}" r="12" fill="${c}" fill-opacity="0.9"/>`
    s += `<rect x="100" y="${ry + 3}" width="${70 + ((i * 37) % 50)}" height="8" rx="4" fill="#ffffff" fill-opacity="0.55"/>`
    s += `<rect x="100" y="${ry + 16}" width="${120 + ((i * 23) % 60)}" height="6" rx="3" fill="#ffffff" fill-opacity="0.18"/>`
  })
  // 縮圖格
  const grads = ['url(#t1)', 'url(#t2)', 'url(#t3)', 'url(#t4)']
  grads.forEach((g, i) => {
    s += `<rect x="${70 + i * 62}" y="214" width="54" height="40" rx="7" fill="${g}"/>`
  })
  // 下載進度條
  s += `<rect x="70" y="268" width="240" height="8" rx="4" fill="#ffffff" fill-opacity="0.10"/>`
  s += `<rect x="70" y="268" width="172" height="8" rx="4" fill="url(#brand)"/>`
  s += '</g>'
  // 浮動通知卡
  const nx = x - 46
  const ny = y + h - 70
  s += `<g transform="translate(${nx} ${ny})" filter="url(#shadow)">`
  s += `<rect width="196" height="56" rx="14" fill="#202759" stroke="#3ee6a0" stroke-opacity="0.45"/>`
  s += `<circle cx="28" cy="28" r="13" fill="#3ee6a0" fill-opacity="0.18"/>`
  s += `<path d="M21.5 28.5l4.5 4.5 9-10" stroke="#3ee6a0" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
  s += `<text x="52" y="25" font-family="${CJK}" font-size="15" font-weight="700" fill="#ffffff">下載完成</text>`
  s += `<text x="52" y="43" font-family="${LATIN}" font-size="12" fill="#9aa3d9">128 files · 4.2 GB</text>`
  s += '</g>'
  return s
}

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b0e22"/>
      <stop offset="1" stop-color="#171c44"/>
    </linearGradient>
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5b6cff"/>
      <stop offset="1" stop-color="#7c5cff"/>
    </linearGradient>
    <radialGradient id="glowL" cx="0.16" cy="0.30" r="0.42">
      <stop offset="0" stop-color="#5b6cff" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#5b6cff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowR" cx="0.84" cy="0.75" r="0.40">
      <stop offset="0" stop-color="#9b5cff" stop-opacity="0.38"/>
      <stop offset="1" stop-color="#9b5cff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="hi" cx="0.32" cy="0.24" r="0.85">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.30"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="t1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9a8b"/><stop offset="1" stop-color="#ff6a88"/></linearGradient>
    <linearGradient id="t2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#43e97b"/><stop offset="1" stop-color="#38f9d7"/></linearGradient>
    <linearGradient id="t3" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4facfe"/><stop offset="1" stop-color="#00f2fe"/></linearGradient>
    <linearGradient id="t4" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6d365"/><stop offset="1" stop-color="#fda085"/></linearGradient>
    <pattern id="dots" width="26" height="26" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1.2" fill="#ffffff" fill-opacity="0.07"/>
    </pattern>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000000" flood-opacity="0.45"/>
    </filter>
  </defs>

  <rect width="${W}" height="${H}" rx="28" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" rx="28" fill="url(#dots)"/>
  <rect width="${W}" height="${H}" rx="28" fill="url(#glowL)"/>
  <rect width="${W}" height="${H}" rx="28" fill="url(#glowR)"/>

  <!-- app 圖示 -->
  <g transform="translate(86 92)" filter="url(#shadow)">
    <rect width="132" height="132" rx="30" fill="url(#brand)"/>
    <rect width="132" height="132" rx="30" fill="url(#hi)"/>
    <g transform="translate(25 26) scale(0.158)" fill="#ffffff"><path d="${PLANE}"/></g>
  </g>

  <!-- 名稱 -->
  <text x="250" y="150" font-family="${CJK}" font-size="54" font-weight="700" fill="#ffffff">Telegram 資源管理助手</text>
  <text x="252" y="194" font-family="${LATIN}" font-size="22" fill="#aab4ff" letter-spacing="1.5">Telegram Resource Management Assistant</text>
  <text x="252" y="232" font-family="${CJK}" font-size="18" fill="#8a93c7">Windows 桌面版 · 瀏覽、下載、轉發、整理你的 Telegram 資源</text>

  ${chips(86, 280)}

  ${mockup(910, 70)}
</svg>`

const png = new Resvg(svg, {
  fitTo: { mode: 'width', value: W * 2 },
  font: { loadSystemFonts: true, defaultFontFamily: CJK }
})
  .render()
  .asPng()
fs.writeFileSync(join(outDir, 'banner.png'), png)
console.log('docs/banner.png 已產生')
