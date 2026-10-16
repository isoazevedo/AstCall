/**
 * Registro do Web Component <ast-monitor>.
 *
 * `defineCustomElement` transforma um componente Vue em um elemento HTML nativo, que funciona
 * em qualquer página (PHP do AzCall, SPA standalone...). O CSS fica isolado no Shadow DOM.
 * `configureApp` instala o Pinia na mini-aplicação Vue de cada <ast-monitor> (Vue 3.5+).
 *
 * Uso numa página qualquer:
 *   <script type="module" src="/assets/ast-monitor.js"></script>
 *   <ast-monitor ws-url="/monitor-ws" token-url="/azcall/monitor/token"></ast-monitor>
 */
import { createPinia } from 'pinia';
import { defineCustomElement } from 'vue';
import AstMonitor from '../components/AstMonitor.ce.vue';

export const AstMonitorElement = defineCustomElement(AstMonitor, {
  configureApp(app) {
    app.use(createPinia());
  },
});

/** Registra a tag (idempotente: pode ser chamado mais de uma vez). */
export function registerAstMonitor(tag = 'ast-monitor'): void {
  if (!customElements.get(tag)) customElements.define(tag, AstMonitorElement);
}

registerAstMonitor();
