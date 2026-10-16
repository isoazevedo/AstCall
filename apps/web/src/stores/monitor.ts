import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import type { ServerMessage } from '@astcall/shared';
import { MonitorConnection, type ConnectionState } from '../lib/MonitorConnection';
import { applyDelta, applySnapshot, createServerState, type ServerState } from '../lib/serverState';
import { callView, compareEndpointIds, endpointView } from '../lib/view';

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
  const user = ref<{ sub: string; name: string } | null>(null);
  /** Estado de cada servidor, por id. `reactive` torna as alterações internas reativas. */
  const servers = reactive<Record<string, ServerState>>({});
  const activeServerId = ref<string | null>(null);
  let conn: MonitorConnection | undefined;

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

  /** Dados na tela podem estar desatualizados (sem conexão ou sincronizando). */
  const stale = computed(
    () =>
      connection.value !== 'online' ||
      !active.value?.hasSnapshot ||
      active.value.status !== 'ready',
  );

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

  function selectServer(id: string): void {
    if (servers[id]) activeServerId.value = id;
  }

  function handleMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'auth_ok': {
        user.value = msg.user;
        const visible = new Set(msg.servers.map((s) => s.id));
        for (const info of msg.servers) {
          if (!servers[info.id]) servers[info.id] = createServerState(info);
          else servers[info.id]!.status = info.status;
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
    stale,
    connect,
    disconnect,
    selectServer,
    handleMessage,
  };
});
