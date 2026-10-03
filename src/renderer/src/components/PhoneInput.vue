<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { COUNTRIES, flagOf } from '../data/countries.js'

const props = defineProps({ modelValue: { type: String, default: '' } })
const emit = defineEmits(['update:modelValue'])

const countryIso = ref('TW')
const national = ref('')

const options = COUNTRIES.map((c) => ({
  label: `${flagOf(c.iso)} ${c.name} +${c.dial}`,
  value: c.iso,
  dial: c.dial,
  name: c.name,
  flag: flagOf(c.iso)
}))

const dial = computed(() => COUNTRIES.find((c) => c.iso === countryIso.value)?.dial || '')

const full = computed(() => '+' + dial.value + national.value.replace(/\D/g, ''))

watch(full, (v) => emit('update:modelValue', v), { immediate: false })
onMounted(() => emit('update:modelValue', full.value))

// 可用「國家名 / 國碼數字 / ISO」過濾,例如打 88 → 定位到 +886
function filter(pattern, option) {
  const p = String(pattern).trim().toLowerCase().replace(/^\+/, '')
  if (!p) return true
  return (
    option.dial.includes(p) ||
    option.name.includes(pattern.trim()) ||
    String(option.value).toLowerCase().includes(p)
  )
}

// 收合顯示用:旗 + 國碼(下拉清單仍顯示完整國名)
function renderTag({ option }) {
  return `${option.flag} +${option.dial}`
}
</script>

<template>
  <div class="phone-input">
    <n-select
      v-model:value="countryIso"
      :options="options"
      filterable
      :filter="filter"
      :consistent-menu-width="false"
      :render-tag="renderTag"
      class="country"
      placeholder="國碼"
    />
    <n-input
      :value="national"
      @update:value="(v) => (national = v.replace(/\D/g, ''))"
      placeholder="手機號碼(不含國碼)"
      class="num"
    >
      <template #prefix>
        <span class="dialpfx">+{{ dial }}</span>
      </template>
    </n-input>
  </div>
</template>

<style scoped>
.phone-input {
  display: flex;
  gap: 8px;
}
.country {
  width: 150px;
  flex: none;
}
.num {
  flex: 1;
}
.dialpfx {
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}
</style>
