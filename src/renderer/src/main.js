import { createApp } from 'vue'
import { createPinia } from 'pinia'
import naive from 'naive-ui'
import App from './App.vue'
import router from './router.js'
import { initIconAnim } from './iconAnim.js'
import './styles.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(naive)
app.mount('#app')

initIconAnim() // Lucide 圖示:hover 才動,移開跑完當前這輪才停
