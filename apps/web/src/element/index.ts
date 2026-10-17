/**
 * Registro dos Web Components do AstCall:
 *
 *   <ast-monitor>   painel completo (ou modo TV com mode="tv")
 *   <ast-filas>     só os cards de fila        (atributo opcional queues="a,b")
 *   <ast-ramais>    só o mapa de ramais        (atributo opcional endpoints="9001,9002")
 *   <ast-chamadas>  só as chamadas em andamento
 *
 * Todos aceitam ws-url, token-url e readonly. `defineCustomElement` transforma um componente
 * Vue em um elemento HTML nativo; o CSS fica isolado no Shadow DOM de cada um.
 *
 * Uma página pode ter vários elementos: todos usam o MESMO Pinia (estado) e, por ele, a mesma
 * conexão WebSocket — `configureApp` instala essa instância única em cada mini-aplicação Vue.
 *
 * Uso numa página qualquer:
 *   <script type="module" src="/astcall/static/ast-monitor.js"></script>
 *   <ast-filas ws-url="/astcall/monitor-ws" token-url="/astcall/token"></ast-filas>
 */
import { createPinia } from 'pinia';
import { defineCustomElement, type App } from 'vue';
import AstChamadas from '../components/AstChamadas.ce.vue';
import AstFilas from '../components/AstFilas.ce.vue';
import AstMonitor from '../components/AstMonitor.ce.vue';
import AstRamais from '../components/AstRamais.ce.vue';

/** Estado compartilhado por todos os elementos da página. */
const pinia = createPinia();
const options = {
  configureApp(app: App) {
    app.use(pinia);
  },
};

export const AstMonitorElement = defineCustomElement(AstMonitor, options);
export const AstFilasElement = defineCustomElement(AstFilas, options);
export const AstRamaisElement = defineCustomElement(AstRamais, options);
export const AstChamadasElement = defineCustomElement(AstChamadas, options);

const TAGS: Record<string, CustomElementConstructor> = {
  'ast-monitor': AstMonitorElement,
  'ast-filas': AstFilasElement,
  'ast-ramais': AstRamaisElement,
  'ast-chamadas': AstChamadasElement,
};

/** Registra as tags (idempotente: pode ser chamado mais de uma vez). */
export function registerAstElements(): void {
  for (const [tag, ctor] of Object.entries(TAGS)) {
    if (!customElements.get(tag)) customElements.define(tag, ctor);
  }
}

/** Compatibilidade: nome antigo do registro. */
export const registerAstMonitor = registerAstElements;

registerAstElements();
