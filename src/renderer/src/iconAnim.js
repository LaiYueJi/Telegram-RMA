/**
 * Lucide 圖示的 hover 動畫。
 *
 * 規則(與網頁版檢視器一致):
 *   平常靜止 → 滑鼠移上去才播 → 移開時「把當前這一輪跑完」才停,
 *   不會停在動畫做到一半的角度。中途又移回來就取消待停止。
 *
 * 用事件委派做,不必去改每一顆按鈕:找到「直接包著 svg.lucide 的那層」當作 host,
 * 加 .ic-anim,實際的動畫在 styles.css 裡依 svg 的 lucide-xxx 類名決定。
 */

const STOP_FALLBACK_MS = 1600 // 沒有 animationiteration 事件時的保險(如 reduce-motion)

/** 從事件目標往上找「直接子層有 lucide svg」的元素。 */
function hostOf(node) {
  let el = node instanceof Element ? node : null
  let depth = 0
  while (el && depth++ < 6) {
    if (el.querySelector && el.querySelector(':scope > svg.lucide')) return el
    el = el.parentElement
  }
  return null
}

function start(host) {
  host._icLeaving = false
  host.classList.add('ic-anim')
}

function stopWhenCycleEnds(host) {
  if (!host.classList.contains('ic-anim')) return
  host._icLeaving = true
  const svg = host.querySelector(':scope > svg.lucide')
  if (!svg) {
    host.classList.remove('ic-anim')
    return
  }
  const done = () => {
    if (host._icLeaving) host.classList.remove('ic-anim')
  }
  svg.addEventListener('animationiteration', done, { once: true })
  setTimeout(done, STOP_FALLBACK_MS)
}

export function initIconAnim() {
  // pointerover/out 會冒泡,可以做委派(mouseenter/leave 不會)
  document.addEventListener(
    'pointerover',
    (e) => {
      const host = hostOf(e.target)
      if (!host) return
      // 從 host 內部移動到內部 → 不用重觸發
      if (host.contains(e.relatedTarget)) return
      start(host)
    },
    { passive: true }
  )

  document.addEventListener(
    'pointerout',
    (e) => {
      const host = hostOf(e.target)
      if (!host) return
      if (host.contains(e.relatedTarget)) return // 還在同一顆按鈕裡
      stopWhenCycleEnds(host)
    },
    { passive: true }
  )
}
