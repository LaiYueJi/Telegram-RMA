<script setup>
import { computed, ref, watch } from 'vue'
import { ChevronUp, ChevronDown } from 'lucide-vue-next'
import SquareThumb from './SquareThumb.vue'

/**
 * 共享媒體的日曆:一次顯示一個月,有東西的日子畫成縮圖圓點,點下去就把方格分頁
 * 捲到那一天。資料來自 messages.GetSearchResultsCalendar(伺服器直接給每天幾則 +
 * 當天第一則 id),所以不用自己翻歷史。
 */
const props = defineProps({
  dialogId: String,
  periods: { type: Array, default: () => [] }, // [{ date, minMsgId, maxMsgId, count }]
  minDate: { type: Number, default: 0 }, // 整個對話最早那則的日期(判斷還有沒有更舊的可抓)
  kind: { type: String, default: '' },
  loading: Boolean
})
const emit = defineEmits(['pick', 'close', 'needOlder'])

const WEEK = ['週日', '週一', '週二', '週三', '週四', '週五', '週六']

/** unix → 本地日期鍵 YYYY-M-D */
function dayKey(unix) {
  const d = new Date(unix * 1000)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}
function monthKey(unix) {
  const d = new Date(unix * 1000)
  return `${d.getFullYear()}-${d.getMonth()}`
}

/** 日期鍵 → period,查格子用。 */
const byDay = computed(() => {
  const m = new Map()
  for (const p of props.periods) m.set(dayKey(p.date), p)
  return m
})

/** 有資料的月份,由新到舊。 */
const months = computed(() => {
  const seen = new Map()
  for (const p of props.periods) {
    const k = monthKey(p.date)
    if (!seen.has(k)) {
      const d = new Date(p.date * 1000)
      seen.set(k, { key: k, year: d.getFullYear(), month: d.getMonth(), oldest: p })
    } else {
      seen.get(k).oldest = p // periods 由新到舊,最後一筆就是該月最舊
    }
  }
  return [...seen.values()]
})

const idx = ref(0) // 0 = 最新的月份
let pendingOlder = false // 剛跟伺服器要了更舊的一段 → 拿到就自動翻過去
watch(
  () => props.periods.length,
  () => {
    if (pendingOlder) {
      pendingOlder = false
      if (idx.value < months.value.length - 1) idx.value++
    }
    if (idx.value >= months.value.length) idx.value = Math.max(0, months.value.length - 1)
  }
)

const current = computed(() => months.value[idx.value] || null)
const title = computed(() =>
  current.value ? `${current.value.year}年${current.value.month + 1}月` : ''
)

/** 還有更舊的月份沒抓回來嗎? */
const canLoadOlder = computed(() => {
  const last = props.periods[props.periods.length - 1]
  return !!(last && props.minDate && last.date > props.minDate)
})
const hasOlder = computed(() => idx.value < months.value.length - 1 || canLoadOlder.value)
const hasNewer = computed(() => idx.value > 0)

function older() {
  if (idx.value < months.value.length - 1) {
    idx.value++
    return
  }
  // 已經在載進來的最舊那個月 → 跟伺服器再要更早的一段
  const last = props.periods[props.periods.length - 1]
  if (canLoadOlder.value && last) {
    pendingOlder = true
    emit('needOlder', last.minMsgId)
  }
}
function newer() {
  if (idx.value > 0) idx.value--
}

/** 目前這個月的格子:補滿前後空白,讓每週對齊星期。 */
const cells = computed(() => {
  const c = current.value
  if (!c) return []
  const first = new Date(c.year, c.month, 1)
  const start = new Date(first)
  start.setDate(1 - first.getDay()) // 往前補到週日
  const out = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const inMonth = d.getMonth() === c.month && d.getFullYear() === c.year
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    out.push({ date: d, day: d.getDate(), inMonth, period: byDay.value.get(key) || null })
    // 該月排完且已經跨到下個月的週日就收工(最後一整週空白不畫)
    if (i >= 27 && d.getDay() === 6 && d > new Date(c.year, c.month + 1, 0)) break
  }
  return out
})

const todayKey = `${new Date().getFullYear()}-${new Date().getMonth()}-${new Date().getDate()}`
function isToday(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` === todayKey
}
</script>

<template>
  <div class="cal">
    <div class="cal-head">
      <span class="cal-title">{{ title }}</span>
      <div class="grow" />
      <button class="navbtn" :disabled="!hasOlder || loading" title="上個月" @click="older">
        <ChevronUp :size="16" />
      </button>
      <button class="navbtn" :disabled="!hasNewer" title="下個月" @click="newer">
        <ChevronDown :size="16" />
      </button>
    </div>

    <div class="week">
      <span v-for="w in WEEK" :key="w">{{ w }}</span>
    </div>

    <div class="grid">
      <template v-for="(c, i) in cells" :key="i">
        <button
          v-if="c.period"
          class="cell has"
          :class="{ today: isToday(c.date) }"
          :title="`${c.date.getFullYear()}/${c.date.getMonth() + 1}/${c.day} · ${c.period.count} 則`"
          @click="emit('pick', c.period)"
        >
          <SquareThumb
            :dialog-id="dialogId"
            :msg-id="c.period.minMsgId"
            :kind="kind"
            round
            :dim="!c.inMonth"
          />
          <span class="num">{{ c.day }}</span>
        </button>
        <span v-else class="cell empty" :class="{ out: !c.inMonth, today: isToday(c.date) }">
          {{ c.day }}
        </span>
      </template>
    </div>

    <div class="cal-foot">
      <span v-if="loading" class="hint">載入中…</span>
      <div class="grow" />
      <button class="txtbtn" @click="emit('close')">關閉</button>
    </div>
  </div>
</template>

<style scoped>
.cal {
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-pop);
  padding: 10px 12px 8px;
}
.cal-head {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 8px;
}
.cal-title {
  font-size: 13.5px;
  font-weight: 600;
}
.grow {
  flex: 1;
}
.navbtn {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  color: var(--text-1);
  border-radius: 6px;
  cursor: pointer;
}
.navbtn:hover:not(:disabled) {
  background: var(--bg-3);
  color: var(--text-0);
}
.navbtn:disabled {
  opacity: 0.3;
  cursor: default;
}
.week {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
  margin-bottom: 6px;
}
.week span {
  text-align: center;
  font-size: 10.5px;
  color: var(--text-2);
}
.grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}
.cell {
  position: relative;
  aspect-ratio: 1;
  border: none;
  background: transparent;
  padding: 0;
  display: grid;
  place-items: center;
  font-size: 12px;
  color: var(--text-1);
  border-radius: 50%;
}
.cell.has {
  cursor: pointer;
}
.cell .num {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.9);
  pointer-events: none;
}
.cell.empty {
  color: var(--text-2);
}
.cell.empty.out {
  opacity: 0.35;
}
.cell.today {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.cell.empty.today {
  background: var(--accent);
  color: #fff;
  font-weight: 700;
}
.cal-foot {
  display: flex;
  align-items: center;
  margin-top: 8px;
}
.hint {
  font-size: 11.5px;
  color: var(--text-2);
}
.txtbtn {
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 12.5px;
  cursor: pointer;
  padding: 4px 2px;
}
.txtbtn:hover {
  text-decoration: underline;
}
</style>
