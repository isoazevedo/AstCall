<script setup lang="ts">
/**
 * Raiz do painel: é o componente que vira o Web Component <ast-monitor>.
 *
 * Conceitos de Vue usados aqui:
 * - <script setup>: tudo declarado aqui fica disponível no <template>.
 * - defineProps: atributos recebidos. No Web Component, `ws-url` e `token-url` viram
 *   as props `wsUrl` e `tokenUrl` automaticamente.
 * - defineEmits: eventos disparados. No Web Component viram eventos DOM (CustomEvent).
 * - onMounted/onUnmounted: código que roda quando o componente entra/sai da página.
 * - computed: valor derivado, recalculado só quando o que ele usa muda.
 * - watch: reage a mudanças de um valor.
 */
import { computed, ref } from 'vue';
import {
  LayoutDashboard,
  ListOrdered,
  Phone,
  PhoneCall,
  Radio,
  Wifi,
  WifiOff,
} from 'lucide-vue-next';
import { useWidget, useWidgetRoot } from '../composables/useWidget';
import { useMonitorStore } from '../stores/monitor';
import CallList from './CallList.ce.vue';
import EndpointGrid from './EndpointGrid.ce.vue';
import ActionDialog from './ActionDialog.ce.vue';
import QueuePanel from './QueuePanel.ce.vue';
import ToastHost from './ToastHost.ce.vue';
import TvBoard from './TvBoard.ce.vue';
import DisconnectBell from './DisconnectBell.ce.vue';
import DisconnectPanel from './DisconnectPanel.ce.vue';
import CopilotPanel from './CopilotPanel.ce.vue';
import { useDisconnectAlerts } from '../composables/useDisconnectAlerts';

/**
 * Atributos da tag:
 * - ws-url / token-url: conexão (ver docs/INTEGRACAO_AZCALL.md);
 * - mode: "panel" (padrão, painel de operação) ou "tv" (wallboard só leitura);
 * - rotate: no modo TV, segundos entre as telas (padrão 15; "0" começa com o rodízio desligado);
 * - readonly: esconde todas as ações (só visualização).
 */
const props = withDefaults(
  defineProps<{
    wsUrl?: string;
    tokenUrl: string;
    mode?: string;
    rotate?: string;
    readonly?: boolean;
  }>(),
  { wsUrl: '/monitor-ws', mode: 'panel', rotate: undefined, readonly: false },
);
const tv = computed(() => props.mode === 'tv');
const emit = defineEmits<{ 'auth-required': [] }>();

const store = useMonitorStore();

// Conexão compartilhada com os outros elementos da página. Sessão expirada: avisa a página
// (a SPA volta ao login, o AzCall redireciona).
const owner = useWidgetRoot(props, () => emit('auth-required'));

/** Alertas de desconexão (sino no cabeçalho + seção "Desconectados"). */
const alerts = useDisconnectAlerts(owner);
const showDown = computed(() => alerts.prefs.value.enabled && alerts.alerting.value.length > 0);

/** Sugestões do copiloto: só para quem pode agir nas filas (pausar ou gerenciar membros). */
const { can } = useWidget();
const showCopilot = computed(() => can('queue') || can('queue_manage'));

/** Selo de conexão no canto superior. */
const badge = computed(() => {
  if (store.connection === 'online') {
    const status = store.active?.status;
    if (status === 'ready') return { tone: 'success', text: 'Tempo real', icon: Wifi };
    if (status === 'syncing') return { tone: 'warning', text: 'Sincronizando', icon: Radio };
    if (status) return { tone: 'danger', text: 'PBX desconectado', icon: WifiOff };
  }
  if (store.connection === 'auth-required') {
    return { tone: 'danger', text: 'Sessão expirada', icon: WifiOff };
  }
  return { tone: 'secondary', text: 'Conectando…', icon: Radio };
});

/** Aba de conteúdo selecionada. A Visão geral mostra o conteúdo de todas as outras. */
type View = 'overview' | 'endpoints' | 'calls' | 'queues';
const view = ref<View>('overview');
const shows = (section: View) => view.value === 'overview' || view.value === section;

/** Abas de conteúdo, com a quantidade de itens de cada uma (a Visão geral não tem contador). */
const tabs = computed(() => [
  { id: 'overview' as const, label: 'Visão geral', icon: LayoutDashboard, count: 0 },
  { id: 'endpoints' as const, label: 'Ramais', icon: Phone, count: store.endpoints.length },
  { id: 'calls' as const, label: 'Chamadas', icon: PhoneCall, count: store.calls.length },
  { id: 'queues' as const, label: 'Filas', icon: ListOrdered, count: store.queues.length },
]);

/** Números do topo. */
const stats = computed(() => {
  const eps = store.endpoints;
  return {
    calls: store.calls.length,
    talking: store.calls.filter((c) => c.status === 'talking').length,
    waiting: store.waitingTotal,
    online: eps.filter((e) => e.group !== 'offline').length,
    busy: eps.filter((e) => e.group === 'busy').length,
    total: eps.length,
  };
});
</script>

<template>
  <!-- Modo TV: outra tela, só leitura (sem diálogos de ação) -->
  <TvBoard v-if="tv" :rotate="rotate" :badge="badge" />

  <div v-else class="ast-root">
    <header class="ast-header">
      <div>
        <h4 class="ast-title">Monitor em tempo real</h4>
        <p class="ast-subtitle">
          {{ store.active?.name ?? 'Aguardando servidor…' }}
          <span v-if="store.user"> · {{ store.user.name || store.user.sub }}</span>
        </p>
      </div>
      <div class="ast-header-right">
        <DisconnectBell :alerts="alerts" />
        <span class="ast-badge" :class="`tone-${badge.tone}`" role="status">
          <component :is="badge.icon" :size="14" aria-hidden="true" />
          {{ badge.text }}
        </span>
      </div>
    </header>

    <!-- Abas de servidor: só aparecem se o usuário vê mais de um -->
    <nav v-if="store.serverList.length > 1" class="ast-tabs" aria-label="Servidores">
      <button
        v-for="s in store.serverList"
        :key="s.id"
        type="button"
        class="ast-tab"
        :class="{ active: s.id === store.activeServerId }"
        @click="store.selectServer(s.id)"
      >
        {{ s.name }}
      </button>
    </nav>

    <div v-if="store.stale && store.active?.hasSnapshot" class="ast-alert" role="alert">
      Conexão instável — os dados abaixo podem estar desatualizados.
    </div>

    <section class="ast-stats">
      <div class="ast-card ast-stat">
        <span class="ast-stat-value">{{ stats.calls }}</span>
        <span class="ast-stat-label">Chamadas ativas</span>
      </div>
      <div class="ast-card ast-stat">
        <span class="ast-stat-value tone-text-success">{{ stats.talking }}</span>
        <span class="ast-stat-label">Em conversa</span>
      </div>
      <div class="ast-card ast-stat">
        <span class="ast-stat-value" :class="{ 'tone-text-warning': stats.waiting > 0 }">
          {{ stats.waiting }}
        </span>
        <span class="ast-stat-label">Aguardando em fila</span>
      </div>
      <div class="ast-card ast-stat">
        <span class="ast-stat-value tone-text-primary">{{ stats.online }}</span>
        <span class="ast-stat-label">Ramais online de {{ stats.total }}</span>
      </div>
      <div class="ast-card ast-stat">
        <span class="ast-stat-value tone-text-warning">{{ stats.busy }}</span>
        <span class="ast-stat-label">Ramais ocupados</span>
      </div>
    </section>

    <!-- Abas de conteúdo. v-for repete o botão para cada item da lista `tabs`. -->
    <nav class="ast-tabs" aria-label="Seções">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        class="ast-tab"
        :class="{ active: view === tab.id }"
        @click="view = tab.id"
      >
        <component :is="tab.icon" :size="16" aria-hidden="true" /> {{ tab.label }}
        <span v-if="tab.count" class="tab-count">{{ tab.count }}</span>
      </button>
    </nav>

    <!-- v-if monta só o que a aba ativa mostra (o resto sai da página). -->
    <DisconnectPanel v-if="showDown && shows('endpoints')" :alerts="alerts" />
    <CallList v-if="shows('calls')" :calls="store.calls" :loading="!store.active?.hasSnapshot" />
    <EndpointGrid
      v-if="shows('endpoints')"
      :endpoints="store.endpoints"
      :loading="!store.active?.hasSnapshot"
    />
    <CopilotPanel v-if="showCopilot && shows('queues') && store.queues.length" />
    <QueuePanel
      v-if="shows('queues')"
      :queues="store.queues"
      :loading="!store.active?.hasSnapshot"
    />

    <ActionDialog />
    <ToastHost />
  </div>
</template>

<style src="../styles/base.css"></style>
