/**
 * 產生 app 圖示:漸層圓角方塊 + 白色紙飛機(Telegram 意象)。
 * 用 @resvg/resvg-js 把 SVG 轉多尺寸 PNG,再用 png-to-ico 打包成 Windows .ico。
 * 輸出:resources/icon.png(512,給 mac/linux/開發視窗)、resources/icon.ico(Windows 打包)。
 * 執行:node scripts/make-icon.mjs
 */
import { Resvg } from '@resvg/resvg-js'
import pngToIco from 'png-to-ico'
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, '..', 'resources')
fs.mkdirSync(outDir, { recursive: true })

const svg = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5b6cff"/>
      <stop offset="1" stop-color="#7c5cff"/>
    </linearGradient>
    <radialGradient id="hi" cx="0.32" cy="0.24" r="0.85">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.30"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect x="0" y="0" width="512" height="512" rx="116" fill="url(#g)"/>
  <rect x="0" y="0" width="512" height="512" rx="116" fill="url(#hi)"/>
  <g transform="translate(97 100) scale(0.615)" fill="#ffffff">
    <path d="M498.1 5.6c10.1 7 15.4 19.1 13.5 31.2l-64 416c-1.5 9.7-7.4 18.2-16 23s-18.9 5.4-28 1.6L284 427.7l-68.5 74.1c-8.9 9.7-22.9 12.9-35.2 8.1S160 493.2 160 480V396.4c0-4 1.5-7.8 4.2-10.7L331.8 202.8c5.8-6.3 5.6-16-.4-22s-15.7-6.4-22-.7L106 360.8 17.7 316.6C7.1 311.3.3 300.7 0 288.9s5.9-22.8 16.1-28.7l448-256c10.5-6 23.4-5.3 33 1.4z"/>
  </g>
</svg>`

function renderPng(size) {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: size } })
  return r.render().asPng()
}

// 512 PNG(開發視窗 / mac / linux)
fs.writeFileSync(join(outDir, 'icon.png'), renderPng(512))

// Windows .ico(多尺寸)
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const pngBuffers = icoSizes.map(renderPng)
const ico = await pngToIco(pngBuffers)
fs.writeFileSync(join(outDir, 'icon.ico'), ico)

console.log('icon.png + icon.ico 已產生於 resources/')
