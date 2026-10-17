import { inject, onMounted, onUnmounted, provide, watch, type InjectionKey } from 'vue';
import type { Permission } from '@astcall/shared';
import { DEFAULT_OWNER, useMonitorStore, type ActionDialog } from '../stores/monitor';

/**
 * Contexto de cada elemento da página (<ast-monitor>, <ast-filas>, <ast-ramais>,
 * <ast-chamadas>), passado aos componentes internos por provide/inject.
 *
 * Conceito de Vue: `provide` disponibiliza um valor para todos os descendentes de um
 * componente; `inject` lê esse valor em qualquer descendente, sem passar props de nível em
 * nível. Aqui ele diz "de qual elemento você faz parte" e "este elemento é só leitura?".
 */
interface WidgetContext {
  /** Identifica o elemento: diálogos e avisos aparecem só nele. */
  owner: string;
  /** Atributo `readonly`: esconde todas as ações. */
  readonly: () => boolean;
}

const WIDGET_KEY: InjectionKey<WidgetContext> = Symbol('ast-widget');
let seq = 0;

/** Chamado pela raiz de cada elemento. Devolve o identificador do elemento. */
export function provideWidget(readonly: () => boolean): string {
  const owner = `w${++seq}`;
  provide(WIDGET_KEY, { owner, readonly });
  return owner;
}

/** Usado pelos componentes que oferecem ações (cards de fila, chamadas, ramais). */
export function useWidget() {
  const ctx = inject(WIDGET_KEY, { owner: DEFAULT_OWNER, readonly: () => false });
  const store = useMonitorStore();
  return {
    owner: ctx.owner,
    /** Pode mostrar a ação? Permissão no servidor (o backend revalida) e elemento não só leitura. */
    can: (perm: Permission) => !ctx.readonly() && store.can(perm),
    /** Abre o diálogo de ação neste elemento. */
    open: (d: ActionDialog) => store.openDialog(d, ctx.owner),
  };
}

/** Atributos comuns a todos os elementos. */
export interface WidgetRootProps {
  wsUrl?: string;
  tokenUrl: string;
  readonly?: boolean;
}

/**
 * Ciclo de vida da raiz de um elemento: usa a conexão compartilhada enquanto estiver na
 * página, avisa a página quando a sessão expira (evento `auth-required`) e define o contexto
 * (dono dos diálogos, só leitura) para os componentes internos.
 */
export function useWidgetRoot(props: WidgetRootProps, onAuthRequired: () => void): string {
  const store = useMonitorStore();
  const owner = provideWidget(() => props.readonly === true);
  onMounted(() => store.connect(props.wsUrl ?? '/monitor-ws', props.tokenUrl));
  onUnmounted(() => store.disconnect());
  watch(
    () => store.connection,
    (state) => {
      if (state === 'auth-required') onAuthRequired();
    },
  );
  return owner;
}
