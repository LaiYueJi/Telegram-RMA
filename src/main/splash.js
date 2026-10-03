/**
 * 啟動畫面(Splash):綠色漸層進度 UI + 旋轉載入動畫。
 * 自包含 HTML(inline CSS/JS),用 data URL 載入,免額外打包設定。
 */
import { app, BrowserWindow } from 'electron'

const SPLASH_HTML = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; font-family: 'Microsoft JhengHei', 'Noto Sans TC', sans-serif; }
  body {
    background:
      radial-gradient(ellipse at 30% 20%, rgba(43, 147, 174, 0.25), transparent 60%),
      radial-gradient(ellipse at 80% 80%, rgba(59, 178, 208, 0.18), transparent 55%),
      linear-gradient(135deg, #0a1f1c 0%, #0c2422 45%, #0a1c20 100%);
    color: #e8f4f2;
    position: relative;
  }
  /* 網格底紋 */
  body::before {
    content: '';
    position: absolute; inset: 0;
    background-image:
      linear-gradient(rgba(59, 178, 208, 0.06) 1px, transparent 1px),
      linear-gradient(90deg, rgba(59, 178, 208, 0.06) 1px, transparent 1px);
    background-size: 36px 36px;
    mask-image: radial-gradient(ellipse at center, #000 40%, transparent 85%);
  }

  /* ── 進度階段 ── */
  .stage-view {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 0 56px;
    transition: opacity 0.5s ease;
  }
  .logo {
    width: 84px; height: 84px; border-radius: 22px;
    background: linear-gradient(135deg, #2a93ae, #3bb2d0);
    display: grid; place-items: center;
    box-shadow: 0 8px 40px rgba(59, 178, 208, 0.45);
    margin-bottom: 20px;
    animation: logo-float 3s ease-in-out infinite;
  }
  .logo svg { width: 46px; height: 46px; }
  @keyframes logo-float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
  .title { font-size: 26px; font-weight: 800; letter-spacing: 1px; }
  .ver {
    margin-top: 10px; font-size: 13px; font-weight: 700;
    color: #0a1f1c; background: linear-gradient(135deg, #3bb2d0, #69d3ea);
    padding: 3px 14px; border-radius: 20px;
  }
  .sub { margin-top: 14px; font-size: 13px; color: #9fc4c0; }
  .progress-wrap { width: 100%; max-width: 540px; margin-top: 42px; }
  .pbar-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
  .pbar-label { font-size: 11px; letter-spacing: 2px; color: #6fa39e; text-transform: uppercase; }
  .pbar-pct { font-size: 17px; font-weight: 800; color: #3bb2d0; }
  .pbar-stage { font-size: 14px; color: #cfe8e4; margin-bottom: 10px; min-height: 20px; }
  .pbar-track { height: 7px; border-radius: 4px; background: rgba(255,255,255,0.08); overflow: hidden; }
  .pbar-fill {
    height: 100%; width: 0%;
    background: linear-gradient(90deg, #2a93ae, #3bb2d0 55%, #f5d76e);
    border-radius: 4px; transition: width 0.4s ease;
    box-shadow: 0 0 12px rgba(59, 178, 208, 0.6);
  }
  .foot { margin-top: 26px; font-size: 11px; color: #5e827e; }

  /* ── 旋轉載入動畫 ── */
  .loader-view {
    position: absolute; inset: 0;
    display: none; align-items: center; justify-content: center;
    flex-direction: column;
    opacity: 0; transition: opacity 0.5s ease;
  }
  .ring-holder { position: relative; width: 200px; height: 200px; }
  .ring {
    position: absolute; top: 50%; left: 50%;
    border-radius: 50%; transform: translate(-50%,-50%);
    border: 4px solid transparent;
  }
  .ring.r1 { width: 200px; height: 200px; border-top-color: #3bb2d0; border-right-color: #3bb2d0; animation: spin 1.4s linear infinite; }
  .ring.r2 { width: 154px; height: 154px; border-bottom-color: #69d3ea; border-left-color: #69d3ea; animation: spin 1.8s linear infinite reverse; }
  .ring.r3 { width: 108px; height: 108px; border-top-color: #2a93ae; border-left-color: #2a93ae; animation: spin 1.1s linear infinite; }
  .ring-core {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
    width: 70px; height: 70px; border-radius: 50%;
    background: linear-gradient(135deg, #2a93ae, #3bb2d0);
    display: grid; place-items: center;
    box-shadow: 0 0 30px rgba(59, 178, 208, 0.7);
    animation: pulse 1.4s ease-in-out infinite;
  }
  .ring-core svg { width: 34px; height: 34px; }
  @keyframes spin { to { transform: translate(-50%,-50%) rotate(360deg); } }
  @keyframes pulse { 0%,100% { box-shadow: 0 0 20px rgba(59,178,208,0.5); } 50% { box-shadow: 0 0 40px rgba(59,178,208,0.9); } }
  .loader-text { margin-top: 30px; font-size: 15px; color: #cfe8e4; letter-spacing: 1px; animation: blink 1.2s ease-in-out infinite; }
  @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
</style>
</head>
<body>
  <div class="stage-view" id="stageView">
    <div class="logo">
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21.5 4.5 2.5 12.5l6 2 2 6 3-4 5 4 3-16z"/>
      </svg>
    </div>
    <div class="title">Telegram 資源管理助手</div>
    <div class="ver">__APP_VERSION__</div>
    <div class="sub">正在載入核心運行時與主介面資源,請稍候片刻。</div>
    <div class="progress-wrap">
      <div class="pbar-head">
        <span class="pbar-label">Current Stage</span>
        <span class="pbar-pct" id="pct">0%</span>
      </div>
      <div class="pbar-stage" id="stageText">正在初始化…</div>
      <div class="pbar-track"><div class="pbar-fill" id="fill"></div></div>
    </div>
    <div class="foot">啟動流程正在推進,完成後將自動進入主介面。</div>
  </div>

  <div class="loader-view" id="loaderView">
    <div class="ring-holder">
      <div class="ring r1"></div>
      <div class="ring r2"></div>
      <div class="ring r3"></div>
      <div class="ring-core">
        <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21.5 4.5 2.5 12.5l6 2 2 6 3-4 5 4 3-16z"/>
        </svg>
      </div>
    </div>
    <div class="loader-text">正在進入主介面…</div>
  </div>

<script>
  const stages = [
    { p: 22, t: '正在載入核心運行時…' },
    { p: 40, t: '正在準備主介面資源…' },
    { p: 58, t: '主介面預加載完成…' },
    { p: 74, t: '正在初始化登入環境…' },
    { p: 88, t: '帳戶認證完成,正在進入主介面…' },
    { p: 100, t: '檢測完成,正在進入主介面…' }
  ];
  let i = 0;
  const fill = document.getElementById('fill');
  const pct = document.getElementById('pct');
  const stageText = document.getElementById('stageText');
  function step() {
    if (i >= stages.length) return;
    const s = stages[i++];
    fill.style.width = s.p + '%';
    pct.textContent = s.p + '%';
    stageText.textContent = s.t;
    if (i < stages.length) setTimeout(step, 360 + Math.random() * 220);
  }
  step();

  // 主程序通知:可開始顯示載入動畫 → 切換到旋轉 loader
  window.__showLoader = function () {
    fill.style.width = '100%';
    pct.textContent = '100%';
    const sv = document.getElementById('stageView');
    const lv = document.getElementById('loaderView');
    sv.style.opacity = '0';
    setTimeout(() => {
      sv.style.display = 'none';
      lv.style.display = 'flex';
      requestAnimationFrame(() => { lv.style.opacity = '1'; });
    }, 500);
  };
</script>
</body>
</html>`

/** 建立並顯示 splash 視窗。回傳 BrowserWindow。 */
export function createSplashWindow() {
  const splash = new BrowserWindow({
    width: 520,
    height: 420, // 內容(logo+標題+進度條+頁尾)約 360px,360 視窗會把置中內容的頂部 logo 切掉;留足高度
    frame: false,
    resizable: false,
    transparent: false,
    backgroundColor: '#0a1f1c',
    alwaysOnTop: true,
    center: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  // 版本號跟隨應用版本(package.json / 打包版本),不再寫死
  const html = SPLASH_HTML.replace('__APP_VERSION__', 'v' + app.getVersion())
  splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  splash.once('ready-to-show', () => splash.show())
  return splash
}

/** 通知 splash 切換到旋轉載入動畫。 */
export function splashShowLoader(splash) {
  try {
    splash?.webContents.executeJavaScript('window.__showLoader && window.__showLoader()')
  } catch {
    /* ignore */
  }
}
