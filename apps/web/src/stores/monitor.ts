import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import type {
  ActionName,
  ActionParams,
  ActionResultMessage,
  Permission,
  ServerMessage,
} from '@astcall/shared';
import { frozenAt } from '../composables/useNow';
import { MonitorConnection, type ConnectionState } from '../lib/MonitorConnection';
import { applyDelta, applySnapshot, createServerState, type ServerState } from '../lib/serverState';
import { callView, compareEndpointIds, endpointView, queueView } from '../lib/view';

/**
 * Store Pinia do painel.
 *
 * Conceito de Vue/Pinia: um store é um estado compartilhado e reativo. Este usa a forma
 * "setup" — igual a um componente com <script setup>: `ref`/`reactive` viram o estado,
 * `computed` viram valores derivados (recalculados só quando o que eles usam muda) e
 * funções comuns viram ações.
 */
export const useMonitorStore = defineStore('monitor', () => {
  // ---------------------------------------------------------------- estado
  const connection = ref<ConnectionState>('idle');
  const user = ref<{ sub: string; name: string; extension?: string } | null>(null);
  /** Estado de cada servidor, por id. `reactive` torna as alterações internas reativas. */
  const servers = reactive<Record<string, ServerState>>({});
  const activeServerId = ref<string | null>(null);
  let conn: MonitorConnection | undefined;
  /** Elementos da página usando a conexão (ela é compartilhada; fecha quando o último sai). */
  let users = 0;

  /** Avisos rápidos no canto da tela (resultado das ações). */
  const toasts = ref<Toast[]>([]);
  let toastSeq = 0;

  /** Diálogo de ação aberto (desligar, transferir, ligar, pausar...) ou null. */
  const dialog = ref<(ActionDialog & { owner: string }) | null>(null);

  /**
   * Histórico (máquina do tempo): com `at` definido, a tela mostra o estado daquele horário
   * (`state`) em vez do ao vivo. O ao vivo continua chegando e sendo aplicado por baixo.
   */
  const history = reactive({
    at: null as number | null,
    state: null as ServerState | null,
    /** Horário mais antigo disponível (vem na resposta do backend). */
    from: null as number | null,
    loading: false,
    /** Motivo de não ter o estado do horário (sem dados, sem conexão...), ou null. */
    error: null as string | null,
  });
  /** Só a resposta do pedido mais recente vale (o usuário arrasta a barra rápido). */
  let historySeq = 0;

  // ---------------------------------------------------------------- derivados
  const serverList = computed(() => Object.values(servers));
  const active = computed(() => (activeServerId.value ? servers[activeServerId.value] : undefined));
  /** Está revendo um horário passado? */
  const inHistory = computed(() => history.at !== null);
  /** O que a tela mostra: o estado do histórico, ou o ao vivo. */
  const shown = computed(() => (inHistory.value ? (history.state ?? undefined) : active.value));

  /** Ramais e troncos AO VIVO (os alertas de desconexão nunca olham o histórico). */
  const liveEndpoints = computed(() => endpointsOf(active.value));

  /** Ramais e troncos do servidor ativo (ou do horário do histórico), ordenados. */
  const endpoints = computed(() => endpointsOf(shown.value));
  function endpointsOf(s: ServerState | undefined) {
    const trunks = new Set(s?.trunks ?? []);
    return Object.values(s?.endpoints ?? {})
      .map((ep) => endpointView(ep, trunks.has(ep.id)))
      .sort((a, b) => compareEndpointIds(a.id, b.id));
  }

  /** Chamadas do servidor ativo, das mais antigas para as mais novas. */
  const calls = computed(() => {
    const s = shown.value;
    if (!s) return [];
    return Object.values(s.calls)
      .map((c) => callView(c, s.channels))
      .sort((a, b) => a.startedAt - b.startedAt);
  });

  /** Filas do servidor ativo, em ordem alfabética, com membros e chamadores aguardando. */
  const queues = computed(() => {
    const s = shown.value;
    if (!s) return [];
    return Object.values(s.queues)
      .map((q) => queueView(q, s.queueMembers, s.queueEntries, s.queueForecasts[q.name] ?? null))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  });

  /** Total de chamadores aguardando em todas as filas. */
  const waitingTotal = computed(() => Object.keys(shown.value?.queueEntries ?? {}).length);

  /** Dados na tela podem estar desatualizados (sem conexão ou sincronizando). */
  const stale = computed(
    () =>
      !inHistory.value &&
      (connection.value !== 'online' ||
        !active.value?.hasSnapshot ||
        active.value.status !== 'ready'),
  );

  /**
   * O usuário tem a permissão no servidor ativo? (só para mostrar botões; o backend revalida)
   * No histórico nenhuma ação aparece: o que está na tela já passou.
   */
  function can(perm: Permission): boolean {
    if (inHistory.value) return false;
    return active.value?.permissions.includes(perm) ?? false;
  }

  // ---------------------------------------------------------------- ações
  /**
   * Um elemento (<ast-monitor>, <ast-filas>...) passa a usar a conexão. Todos os elementos da
   * página compartilham o mesmo store e o mesmo WebSocket: só o primeiro abre a conexão (os
   * demais reaproveitam, mesmo que informem outros endereços — vale o do primeiro).
   */
  function connect(wsUrl: string, tokenUrl: string): void {
    users++;
    if (conn) return;
    conn = new MonitorConnection({
      wsUrl,
      tokenUrl,
      onState: (s) => (connection.value = s),
      onMessage: handleMessage,
    });
    conn.start();
  }

  /** O elemento saiu da página; o último a sair fecha a conexão. */
  function disconnect(): void {
    users = Math.max(0, users - 1);
    if (users > 0) return;
    conn?.stop();
    conn = undefined;
  }

  /** Executa uma ação no servidor ativo e mostra o resultado num aviso. */
  async function act<K extends ActionName>(
    name: K,
    params: ActionParams[K],
    successText: string,
  ): Promise<ActionResultMessage> {
    const server = activeServerId.value;
    const result =
      conn && server
        ? await conn.sendAction(server, name, params)
        : ({
            t: 'action_result',
            reqId: '',
            ok: false,
            error: 'sem conexão',
          } as ActionResultMessage);
    // o aviso aparece no elemento de onde a ação partiu (o dono do diálogo)
    if (result.ok) notify('success', successText, dialog.value?.owner);
    return result;
  }

  function notify(tone: Toast['tone'], text: string, owner = DEFAULT_OWNER): void {
    const id = ++toastSeq;
    toasts.value.push({ id, tone, text, owner });
    setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), 4000);
  }

  /** Abre um diálogo de ação no elemento `owner` (só ele desenha o diálogo). */
  function openDialog(d: ActionDialog, owner = DEFAULT_OWNER): void {
    dialog.value = { ...d, owner };
  }

  function closeDialog(): void {
    dialog.value = null;
  }

  function selectServer(id: string): void {
    if (!servers[id]) return;
    if (id !== activeServerId.value) exitHistory();
    activeServerId.value = id;
  }

  /**
   * Mostra o estado do servidor ativo no horário `at` (ms). Pode ser chamado várias vezes
   * seguidas (barra arrastada): vale a resposta do último pedido.
   */
  async function showHistory(at: number): Promise<void> {
    const server = active.value;
    if (!conn || !server) return;
    const seq = ++historySeq;
    history.at = at;
    frozenAt.value = at;
    history.loading = true;
    const res = await conn.requestHistory(server.id, at);
    if (seq !== historySeq || history.at === null) return; // pedido mais novo, ou saiu do histórico
    history.loading = false;
    if (res.from !== null) history.from = res.from;
    if (!res.ok || !res.data) {
      history.state = null;
      history.error = HISTORY_ERRORS[res.code ?? ''] ?? 'Não foi possível carregar o histórico.';
      return;
    }
    const s = createServerState({
      id: server.id,
      name: server.name,
      status: res.status ?? 'ready',
      permissions: [],
      trunks: server.trunks,
    });
    applySnapshot(s, { t: 'snapshot', server: server.id, epoch: 0, seq: 0, data: res.data });
    history.state = s;
    history.error = null;
  }

  /** Volta ao ao vivo. */
  function exitHistory(): void {
    historySeq++;
    history.at = null;
    history.state = null;
    history.error = null;
    history.loading = false;
    frozenAt.value = null;
  }

  function handleMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'auth_ok': {
        user.value = msg.user;
        const visible = new Set(msg.servers.map((s) => s.id));
        for (const info of msg.servers) {
          const existing = servers[info.id];
          if (!existing) servers[info.id] = createServerState(info);
          else {
            existing.status = info.status;
            existing.permissions = info.permissions ?? [];
            existing.trunks = info.trunks ?? [];
            existing.history = info.history ?? false;
          }
        }
        for (const id of Object.keys(servers)) if (!visible.has(id)) delete servers[id];
        // perdeu a permissão do histórico (token renovado): volta ao ao vivo
        if (inHistory.value && !servers[activeServerId.value ?? '']?.history) exitHistory();
        if (!activeServerId.value || !visible.has(activeServerId.value)) {
          activeServerId.value = msg.servers[0]?.id ?? null;
        }
        break;
      }
      case 'server_status': {
        const s = servers[msg.server];
        if (s) s.status = msg.status;
        break;
      }
      case 'snapshot': {
        const s = servers[msg.server];
        if (s) applySnapshot(s, msg);
        break;
      }
      case 'delta': {
        const s = servers[msg.server];
        if (s && applyDelta(s, msg) === 'gap') conn?.resync(msg.server);
        break;
      }
      case 'error':
        console.warn(`[ast-monitor] ${msg.code}: ${msg.message}`);
        break;
    }
  }

  return {
    connection,
    user,
    servers,
    activeServerId,
    serverList,
    active,
    history,
    inHistory,
    liveEndpoints,
    endpoints,
    calls,
    queues,
    waitingTotal,
    stale,
    toasts,
    dialog,
    can,
    act,
    notify,
    openDialog,
    closeDialog,
    connect,
    disconnect,
    selectServer,
    showHistory,
    exitHistory,
    handleMessage,
  };
});

/** Mensagens para os códigos de erro do histórico. */
const HISTORY_ERRORS: Record<string, string> = {
  not_found: 'Sem histórico neste horário (antes do início da gravação ou além do prazo guardado).',
  forbidden: 'Sem permissão para ver o histórico deste servidor.',
  unavailable: 'O histórico está desligado neste servidor.',
  disconnected: 'Sem conexão com o servidor.',
  timeout: 'O servidor não respondeu a tempo.',
};

/** Dono padrão de diálogos e avisos (quando o componente não está dentro de um elemento). */
export const DEFAULT_OWNER = 'default';

export interface Toast {
  id: number;
  tone: 'success' | 'danger' | 'info';
  text: string;
  /** Elemento da página que mostra o aviso. */
  owner: string;
}

/** Qual diálogo de ação está aberto e sobre o quê. */
export type ActionDialog =
  | { kind: 'hangup'; uniqueid: string; label: string }
  | { kind: 'transfer'; uniqueid: string; label: string }
  | { kind: 'originate'; from: string }
  | { kind: 'spy'; uniqueid: string; label: string }
  | { kind: 'pause'; queue: string; interface: string; label: string; pause: boolean }
  /**
   * Adicionar membro: `members` = ramais que já estão na fila (saem da lista de opções);
   * `preset` = ramal já escolhido ao abrir (sugestão do copiloto).
   */
  | { kind: 'queueAdd'; queue: string; members: string[]; preset?: string }
  | { kind: 'queueRemove'; queue: string; interface: string; label: string }
  | {
      kind: 'penalty';
      queue: string;
      interface: string;
      label: string;
      penalty: number;
      dynamic: boolean;
    };
