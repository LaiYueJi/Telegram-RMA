/**
 * 全域彈出公告(彩色卡片)。
 * 用 naive-ui createDiscreteApi,不依賴元件樹 → store/元件皆可直接呼叫。
 * 成功=綠、失敗=紅,與頂部狀態列同一套暗色主題。
 * 位置:右上(對話頁「保存到」下方、收起鈕左邊)。
 */
import { ref } from 'vue'
import { createDiscreteApi, darkTheme, zhTW, dateZhTW } from 'naive-ui'

const themeOverrides = {
  common: {
    primaryColor: '#5b6cff',
    primaryColorHover: '#6b7cff',
    primaryColorPressed: '#4a5be0',
    successColor: '#2bbf7a',
    errorColor: '#e5484d',
    borderRadius: '10px',
    popoverColor: '#16223c'
  }
}

const configProviderProps = ref({ theme: darkTheme, themeOverrides, locale: zhTW, dateLocale: dateZhTW })

// 位置由 styles.css 的 .n-notification-container 以 !important 強制(naive 的 containerStyle.top
// 會被它自己的定位覆寫,只有用全域 CSS !important 才吃得到)。
const notificationProviderProps = {
  placement: 'top-right'
}

const { notification } = createDiscreteApi(['notification'], {
  configProviderProps,
  notificationProviderProps
})

/** 統一介面:notify.success/error/info/warning({ title, content, duration }) */
export const notify = {
  success: (opts) => notification.success({ duration: 3500, ...opts }),
  error: (opts) => notification.error({ duration: 6000, ...opts }),
  info: (opts) => notification.info({ duration: 3500, ...opts }),
  warning: (opts) => notification.warning({ duration: 4500, ...opts })
}

export default notify
