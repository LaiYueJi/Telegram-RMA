const fs = require('fs')
const items = require(process.argv[2]) // gradients.json
const zh = {
  'Warm Flame': '溫暖火焰', 'Night Fade': '夜幕漸隱', 'Spring Warmth': '春日暖意', 'Juicy Peach': '多汁蜜桃',
  'Young Passion': '青春熱情', 'Lady Lips': '淑女紅唇', 'Sunny Morning': '陽光清晨', 'Rainy Ashville': '雨中艾許維',
  'Frozen Dreams': '冰封夢境', 'Winter Neva': '涅瓦寒冬', 'Dusty Grass': '塵草', 'Tempting Azure': '誘人蔚藍',
  'Heavy Rain': '傾盆大雨', 'Amy Crisp': '艾米清脆', 'Mean Fruit': '酸果', 'Deep Blue': '深邃藍',
  'Ripe Malinka': '熟覆盆莓', 'Cloudy Knoxville': '諾克斯雲霧', 'Malibu Beach': '馬里布海灘', 'New Life': '新生',
  'True Sunset': '真實日落', 'Morpheus Den': '睡神之穴', 'Rare Wind': '稀有之風', 'Near Moon': '近月',
  'Wild Apple': '野蘋果', 'Saint Petersburg': '聖彼得堡', 'Plum Plate': '梅子盤', 'Everlasting Sky': '永恆天空',
  'Happy Fisher': '快樂漁夫', 'Blessing': '祝福', 'Sharpeye Eagle': '鷹眼', 'Ladoga Bottom': '拉多加湖底',
  'Lemon Gate': '檸檬之門', 'Itmeo Branding': 'Itmeo 品牌', 'Zeus Miracle': '宙斯奇蹟', 'Star Wine': '星酒',
  'Сoup de Grace': '致命一擊', 'Happy Acid': '迷幻酸彩', 'Awesome Pine': '蒼松', 'New York': '紐約',
  'Mixed Hopes': '交織希望', 'Fly High': '高飛', 'Strong Bliss': '極樂', 'Fresh Milk': '鮮奶',
  'Snow Again': '再度飄雪', 'February Ink': '二月墨色', 'Kind Steel': '溫柔鋼鐵', 'Soft Grass': '柔軟青草',
  'Grown Early': '早熟', 'Sharp Blues': '銳藍', 'Shady Water': '蔭涼之水', 'Dirty Beauty': '塵世之美',
  'Great Whale': '巨鯨', 'Teen Notebook': '少年筆記', 'Polite Rumors': '溫柔流言', 'Sweet Period': '甜蜜時光',
  'Wide Matrix': '廣闊矩陣', 'Soft Cherish': '溫柔珍惜', 'Red Salvation': '赤色救贖', 'Night Party': '夜之派對',
  'Sky Glider': '天際滑翔', 'Heaven Peach': '天堂蜜桃', 'Purple Division': '紫色分界', 'Aqua Splash': '水花飛濺',
  'Above Clouds': '雲端之上', 'Spiky Naga': '尖刺娜迦', 'Love Kiss': '愛之吻', 'Sharp Glass': '銳利玻璃',
  'Clean Mirror': '明鏡', 'Premium Dark': '高級暗黑', 'Cold Evening': '寒夜', 'Cochiti Lake': '科奇蒂湖',
  'Summer Games': '夏日運動', 'Passionate Bed': '熱情之床', 'Mountain Rock': '山岩', 'Desert Hump': '沙漠駝峰',
  'Jungle Day': '叢林之日', 'Phoenix Start': '鳳凰初生', 'October Silenceiver': '十月靜默', 'Faraway River': '遠方之河',
  'Alchemist Lab': '煉金實驗室', 'Over Sun': '烈日之上', 'Premium White': '高級純白', 'Mars Party': '火星派對',
  'Eternal Constance': '永恆不變', 'Japan Blush': '日本緋紅', 'Smiling Rain': '微笑細雨', 'Cloudy Apple': '雲霧蘋果',
  'Big Mango': '大芒果', 'Healthy Water': '健康之水', 'Amour Amour': '愛戀', 'Risky Concrete': '冷冽混凝土',
  'Strong Stick': '堅木', 'Vicious Stance': '兇險之姿', 'Palo Alto': '帕羅奧圖', 'Happy Memories': '美好回憶',
  'Midnight Bloom': '午夜綻放', 'Crystalline': '晶瑩', 'Raccoon Back': '浣熊之背', 'Party Bliss': '派對極樂',
  'Confident Cloud': '自信之雲', 'Le Cocktail': '雞尾酒', 'River City': '河畔之城', 'Frozen Berry': '冰凍莓果',
  'Child Care': '童趣呵護', 'Flying Lemon': '飛檸', 'New Retrowave': '新復古浪潮', 'Hidden Jaguar': '隱匿美洲豹',
  'Above The Sky': '天空之上', 'Nega': '負片', 'Dense Water': '濃稠之水', 'Chemic Aqua': '化學水藍',
  'Seashore': '海濱', 'Marble Wall': '大理石牆', 'Cheerful Caramel': '歡快焦糖', 'Night Sky': '夜空',
  'Magic Lake': '魔幻之湖', 'Young Grass': '嫩草', 'Colorful Peach': '繽紛蜜桃', 'Gentle Care': '溫柔呵護',
  'Plum Bath': '梅子浴', 'Happy Unicorn': '快樂獨角獸', 'Full Metal': '全金屬', 'African Field': '非洲原野',
  'Solid Stone': '堅石', 'Orange Juice': '柳橙汁', 'Glass Water': '玻璃之水', 'Slick Carbon': '光滑碳纖',
  'North Miracle': '北方奇蹟', 'Fruit Blend': '水果調和', 'Millennium Pine': '千年松', 'High Flight': '高空飛行',
  'Mole Hall': '幽暗廳堂', 'Earl Gray': '伯爵灰', 'Space Shift': '太空躍遷', 'Forest Inei': '森林霜華',
  'Royal Garden': '皇家花園', 'Rich Metal': '濃郁金屬', 'Juicy Cake': '多汁蛋糕', 'Smart Indigo': '靛藍雅致',
  'Sand Strike': '沙擊', 'Norse Beauty': '北歐之美', 'Aqua Guidance': '水藍指引', 'Sun Veggie': '陽光蔬果',
  'Sea Lord': '海之王', 'Black Sea': '黑海', 'Grass Shampoo': '青草洗禮', 'Landing Aircraft': '降落之翼',
  'Witch Dance': '女巫之舞', 'Sleepless Night': '不眠之夜', 'Angel Care': '天使呵護', 'Crystal River': '水晶之河',
  'Soft Lipstick': '柔彩唇膏', 'Salt Mountain': '鹽山', 'Perfect White': '完美純白', 'Fresh Oasis': '清新綠洲',
  'Strict November': '肅穆十一月', 'Morning Salad': '晨間沙拉', 'Deep Relief': '深層舒緩', 'Sea Strike': '海擊',
  'Night Call': '夜之呼喚', 'Supreme Sky': '至高天空', 'Light Blue': '淺藍', 'Mind Crawl': '思緒蔓延',
  'Lily Meadow': '百合草原', 'Sugar Lollipop': '糖果棒棒糖', 'Sweet Dessert': '甜點', 'Magic Ray': '魔幻光線',
  'Teen Party': '青春派對', 'Frozen Heat': '冰火', 'Gagarin View': '加加林視角', 'Fabled Sunset': '傳說日落',
  'Perfect Blue': '完美藍'
}
const esc = (s) => s.replace(/'/g, "\\'")
const lines = items.map((i) => {
  const name = zh[i.en] || i.en
  return `  { id: 'wg${i.num}', name: '${esc(name)}', en: '${esc(i.en)}', css: '${i.css}' }`
})
const header = `/**
 * 背景漸層主題:WebGradients 完整 174 組(由官方 Sketch 檔精準萃取,不連外)。
 * 名稱為繁體中文(原始英文),排序同 webgradients.com 編號。
 * 套用在「整個介面」的背景畫布(--app-bg);頂部列/側欄/內容區啟用漸層時改半透明毛玻璃透出漸層,
 * 卡片/氣泡維持不透明保可讀。亮/暗模式各疊一層遮罩維持文字對比。default → 回內建純色底。
 *
 * ⚠️ 本檔由 scripts 從 Sketch 產生,勿手改;要調整改產生器。
 */
export const BG_THEMES = [
  { id: 'default', name: '預設', en: 'Default', css: '' },
`
const footer = `]

// 遮罩:亮/暗模式各一;值越大越壓、漸層越不鮮豔(但文字越好讀)。
const SCRIM_DARK = 'rgba(10, 14, 26, 0.42)'
const SCRIM_LIGHT = 'rgba(248, 250, 253, 0.5)'

/** 挑主題用的預覽底色(顯示原始鮮豔漸層;default 用內建純色底)。 */
export function bgSwatch(t) {
  return t.css || 'var(--bg-0)'
}

/**
 * 套用背景漸層主題到 <html>:
 *   - --app-bg = 遮罩(依亮/暗模式) + 漸層(供 .shell 當整個視窗底色)
 *   - data-bgtheme = 'on' → 讓 styles.css 把頂部列/側欄/內容區改半透明,漸層透出來
 * default → 清除覆寫,回到 styles.css 內建純色底。
 * @param {string} id 主題 id
 * @param {boolean} isDark 目前是否為深色模式
 */
export function applyBackgroundTheme(id, isDark = true) {
  const root = document.documentElement
  const t = BG_THEMES.find((g) => g.id === id)
  if (!t || !t.css) {
    root.style.removeProperty('--app-bg')
    delete root.dataset.bgtheme
    return
  }
  const scrim = isDark ? SCRIM_DARK : SCRIM_LIGHT
  root.style.setProperty('--app-bg', \`linear-gradient(\${scrim}, \${scrim}), \${t.css}\`)
  root.dataset.bgtheme = 'on'
}
`
fs.writeFileSync(process.argv[3], header + lines.join(',\n') + '\n' + footer)
console.log('wrote', items.length + 1, 'themes to', process.argv[3])
