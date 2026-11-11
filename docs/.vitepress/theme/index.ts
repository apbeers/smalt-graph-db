import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import { defineAsyncComponent, h, type FunctionalComponent } from 'vue'
import './smaltdb.css'
import './smaltcy.css'
import { withSmaltworks } from './stage'
import { enableRunnable } from './runnable'

/** The wordmark: sm·alt·cy in Martian Mono, alt in smalt, until smaltcy has outlined logo files (ADR 0001). */
const wordmark = (cls = 'cy-wordmark') => h('span', { class: cls }, ['sm', h('span', { class: 'alt' }, 'alt'), 'cy'])

/** The default layout with the wordmark in the nav bar; the family's badges are added around it by stage.ts. */
const WithWordmark: FunctionalComponent = (_props, { slots }) =>
  h(DefaultTheme.Layout, null, { ...slots, 'nav-bar-title-before': () => wordmark() })

export default {
  extends: DefaultTheme,
  Layout: withSmaltworks({ Layout: WithWordmark }),
  enhanceApp({ app }) {
    if (typeof document !== 'undefined') enableRunnable(import.meta.env.BASE_URL)
    // The playground loads only on its page: it pulls in the engine and the GPU renderer.
    app.component('Playground', defineAsyncComponent(() => import('./components/Playground.vue')))
    app.component('TechDemo', defineAsyncComponent(() => import('./components/TechDemo.vue')))
    app.component('Wordmark', () => wordmark('cy-wordmark cy-wordmark-hero'))
  },
} satisfies Theme
