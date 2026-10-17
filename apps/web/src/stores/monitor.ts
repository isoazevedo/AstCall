import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import type {
  ActionName,
  ActionParams,
  ActionResultMessage,
  Permission,
  ServerMessage,
} from '@astcall/shared';
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

  /** Avisos rápidos no canto da tela (resultado das ações). */
  const toasts = ref<Toast[]>([]);
  let toastSeq = 0;

  /** Diálogo de ação aberto (desligar, transferir, ligar, pausar...) ou null. */
  const dialog = ref<ActionDialog | null>(null);

  // ---------------------------------------------------------------- derivados
  const serverList = computed(() => Object.values(servers));
  const active = computed(() => (activeServerId.value ? servers[activeServerId.value] : undefined));

  /** Ramais do servidor ativo, prontos para exibir e ordenados. */
  const endpoints = computed(() =>
    Object.values(active.value?.endpoints ?? {})
      .map(endpointView)
      .sort((a, b) => compareEndpointIds(a.id, b.id)),
  );

  /** Chamadas do servidor ativo, das mais antigas para as mais novas. */
  const calls = computed(() => {
    const s = active.value;
    if (!s) return [];
    return Object.values(s.calls)
      .map((c) => callView(c, s.channels))
      .sort((a, b) => a.startedAt - b.startedAt);
  });

  /** Filas do servidor ativo, em ordem alfabética, com membros e chamadores aguardando. */
  const queues = computed(() => {
    const s = active.value;
    if (!s) return [];
    return Object.values(s.queues)
      .map((q) => queueView(q, s.queueMembers, s.queueEntries))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  });

  /** Total de chamadores aguardando em todas as filas. */
  const waitingTotal = computed(() => Object.keys(active.value?.queueEntries ?? {}).length);

  /** Dados na tela podem estar desatualizados (sem conexão ou sincronizando). */
  const stale = computed(
    () =>
      connection.value !== 'online' ||
      !active.value?.hasSnapshot ||
      active.value.status !== 'ready',
  );

  /** O usuário tem a permissão no servidor ativo? (só para mostrar botões; o backend revalida) */
  function can(perm: Permission): boolean {
    return active.value?.permissions.includes(perm) ?? false;
  }

  // ---------------------------------------------------------------- ações
  function connect(wsUrl: string, tokenUrl: string): void {
    conn?.stop();
    conn = new MonitorConnection({
      wsUrl,
      tokenUrl,
      onState: (s) => (connection.value = s),
      onMessage: handleMessage,
    });
    conn.start();
  }

  function disconnect(): void {
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
    if (result.ok) notify('success', successText);
    return result;
  }

  function notify(tone: Toast['tone'], text: string): void {
    const id = ++toastSeq;
    toasts.value.push({ id, tone, text });
    setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), 4000);
  }

  function openDialog(d: ActionDialog): void {
    dialog.value = d;
  }

  function closeDialog(): void {
    dialog.value = null;
  }

  function selectServer(id: string): void {
    if (servers[id]) activeServerId.value = id;
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
          }
        }
        for (const id of Object.keys(servers)) if (!visible.has(id)) delete servers[id];
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
    handleMessage,
  };
});

export interface Toast {
  id: number;
  tone: 'success' | 'danger' | 'info';
  text: string;
}

/** Qual diálogo de ação está aberto e sobre o quê. */
export type ActionDialog =
  | { kind: 'hangup'; uniqueid: string; label: string }
  | { kind: 'transfer'; uniqueid: string; label: string }
  | { kind: 'originate'; from: string }
  | { kind: 'spy'; uniqueid: string; label: string }
  | { kind: 'pause'; queue: string; interface: string; label: string; pause: boolean }
  /** Adicionar membro: `members` = ramais que já estão na fila (saem da lista de opções). */
  | { kind: 'queueAdd'; queue: string; members: string[] }
  | { kind: 'queueRemove'; queue: string; interface: string; label: string }
  | {
      kind: 'penalty';
      queue: string;
      interface: string;
      label: string;
      penalty: number;
      dynamic: boolean;
    };
