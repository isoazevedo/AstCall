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
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { LayoutDashboard, ListOrdered, Radio, Wifi, WifiOff } from 'lucide-vue-next';
import { useMonitorStore } from '../stores/monitor';
import CallList from './CallList.ce.vue';
import EndpointGrid from './EndpointGrid.ce.vue';
import ActionDialog from './ActionDialog.ce.vue';
import QueuePanel from './QueuePanel.ce.vue';
import ToastHost from './ToastHost.ce.vue';

const props = withDefaults(defineProps<{ wsUrl?: string; tokenUrl: string }>(), {
  wsUrl: '/monitor-ws',
});
const emit = defineEmits<{ 'auth-required': [] }>();

const store = useMonitorStore();

onMounted(() => store.connect(props.wsUrl, props.tokenUrl));
onUnmounted(() => store.disconnect());

// Sessão expirou: avisa a página que hospeda o componente (SPA volta ao login, AzCall redireciona)
watch(
  () => store.connection,
  (state) => {
    if (state === 'auth-required') emit('auth-required');
  },
);

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

/** Aba de conteúdo selecionada. */
const view = ref<'overview' | 'queues'>('overview');

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
  <div class="ast-root">
    <header class="ast-header">
      <div>
        <h4 class="ast-title">Monitor em tempo real</h4>
        <p class="ast-subtitle">
          {{ store.active?.name ?? 'Aguardando servidor…' }}
          <span v-if="store.user"> · {{ store.user.name || store.user.sub }}</span>
        </p>
      </div>
      <span class="ast-badge" :class="`tone-${badge.tone}`" role="status">
        <component :is="badge.icon" :size="14" aria-hidden="true" />
        {{ badge.text }}
      </span>
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

    <!-- Abas de conteúdo. v-if/v-else monta só a aba ativa (a outra sai da página). -->
    <nav class="ast-tabs" aria-label="Seções">
      <button
        type="button"
        class="ast-tab"
        :class="{ active: view === 'overview' }"
        @click="view = 'overview'"
      >
        <LayoutDashboard :size="16" aria-hidden="true" /> Visão geral
      </button>
      <button
        type="button"
        class="ast-tab"
        :class="{ active: view === 'queues' }"
        @click="view = 'queues'"
      >
        <ListOrdered :size="16" aria-hidden="true" /> Filas
        <span v-if="store.queues.length" class="tab-count">{{ store.queues.length }}</span>
      </button>
    </nav>

    <template v-if="view === 'overview'">
      <CallList :calls="store.calls" :loading="!store.active?.hasSnapshot" />
      <EndpointGrid :endpoints="store.endpoints" :loading="!store.active?.hasSnapshot" />
    </template>
    <QueuePanel v-else :queues="store.queues" :loading="!store.active?.hasSnapshot" />

    <ActionDialog />
    <ToastHost />
  </div>
</template>

<style>
/*
 * Tokens visuais. Cada um usa a variável do tema Frest/Bootstrap do AzCall (--bs-*) quando
 * existir na página — variáveis CSS atravessam o Shadow DOM — e cai no valor do Frest
 * quando o componente roda fora do AzCall. Para personalizar, defina --ast-* na tag.
 */
:host {
  --ast-primary: var(--bs-primary, #5a8dee);
  --ast-primary-rgb: var(--bs-primary-rgb, 90, 141, 238);
  --ast-success: var(--bs-success, #39da8a);
  --ast-success-rgb: var(--bs-success-rgb, 57, 218, 138);
  --ast-warning: var(--bs-warning, #fdac41);
  --ast-warning-rgb: var(--bs-warning-rgb, 253, 172, 65);
  --ast-danger: var(--bs-danger, #ff5b5c);
  --ast-danger-rgb: var(--bs-danger-rgb, 255, 91, 92);
  --ast-info: var(--bs-info, #00cfdd);
  --ast-info-rgb: var(--bs-info-rgb, 0, 207, 221);
  --ast-secondary: var(--bs-secondary, #69809a);
  --ast-secondary-rgb: var(--bs-secondary-rgb, 105, 128, 154);

  --ast-text: var(--bs-body-color, #677788);
  --ast-text-muted: var(--bs-secondary-color, rgba(103, 119, 136, 0.75));
  --ast-heading: var(--bs-heading-color, #516377);
  --ast-border: var(--bs-border-color, #d4d8dd);
  --ast-card-bg: #fff; /* o tema não expõe a cor do card na raiz: ajuste no modo escuro */
  --ast-card-radius: 1.3125rem;
  --ast-radius: var(--bs-border-radius, 0.25rem);
  --ast-card-shadow: 0 2px 14px rgba(38, 60, 85, 0.16);
  --ast-font: var(
    --bs-body-font-family,
    'IBM Plex Sans',
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    sans-serif
  );
  --ast-font-heading: 'Rubik', var(--ast-font);

  display: block;
  font-family: var(--ast-font);
  font-size: 0.9375rem;
  color: var(--ast-text);
  line-height: 1.47;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

.ast-root {
  display: grid;
  gap: 1.5rem;
}

.ast-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.ast-title {
  margin: 0 0 0.25rem;
  font-family: var(--ast-font-heading);
  font-weight: 500;
  font-size: 1.375rem;
  line-height: 1.1;
  color: var(--ast-heading);
}
.ast-subtitle {
  margin: 0;
  color: var(--ast-text-muted);
}

/* Cards no estilo Frest: sem borda, cantos arredondados, sombra suave */
.ast-card {
  background: var(--ast-card-bg);
  border-radius: var(--ast-card-radius);
  box-shadow: var(--ast-card-shadow);
}
.ast-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  padding: 1.375rem 1.375rem 0;
}
.ast-card-title {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--ast-font-heading);
  font-weight: 500;
  font-size: 1.125rem;
  color: var(--ast-heading);
}
.ast-card-body {
  padding: 1.375rem;
}
.ast-empty {
  padding: 2rem 1rem;
  text-align: center;
  color: var(--ast-text-muted);
}

/* "Badge label" do Frest: fundo claro tingido + texto na cor */
.ast-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.6rem;
  border-radius: var(--ast-radius);
  font-size: 0.8125rem;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}
.tone-success {
  background: rgba(var(--ast-success-rgb), 0.16);
  color: var(--ast-success);
}
.tone-primary {
  background: rgba(var(--ast-primary-rgb), 0.16);
  color: var(--ast-primary);
}
.tone-warning {
  background: rgba(var(--ast-warning-rgb), 0.16);
  color: var(--ast-warning);
}
.tone-danger {
  background: rgba(var(--ast-danger-rgb), 0.16);
  color: var(--ast-danger);
}
.tone-info {
  background: rgba(var(--ast-info-rgb), 0.16);
  color: var(--ast-info);
}
.tone-secondary {
  background: rgba(var(--ast-secondary-rgb), 0.16);
  color: var(--ast-secondary);
}
.tone-text-success {
  color: var(--ast-success);
}
.tone-text-primary {
  color: var(--ast-primary);
}
.tone-text-warning {
  color: var(--ast-warning);
}

.ast-tabs {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.ast-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font: inherit;
  padding: 0.45rem 1rem;
  border: 0;
  border-radius: var(--ast-radius);
  background: transparent;
  color: var(--ast-text);
  cursor: pointer;
}
.ast-tab:hover {
  background: rgba(var(--ast-primary-rgb), 0.08);
}
.tab-count {
  padding: 0 0.4rem;
  border-radius: 1rem;
  font-size: 0.75rem;
  background: rgba(var(--ast-secondary-rgb), 0.16);
}
.ast-tab.active .tab-count {
  background: rgba(255, 255, 255, 0.25);
}
.ast-tab.active {
  background: var(--ast-primary);
  color: #fff;
  box-shadow: 0 2px 4px rgba(var(--ast-primary-rgb), 0.4);
}

.ast-alert {
  padding: 0.75rem 1rem;
  border-radius: var(--ast-radius);
  background: rgba(var(--ast-warning-rgb), 0.16);
  color: var(--ast-warning);
  font-weight: 500;
}

.ast-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 1.5rem;
}
.ast-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 1.25rem 1rem;
  text-align: center;
}
.ast-stat-value {
  font-family: var(--ast-font-heading);
  font-size: 1.75rem;
  font-weight: 500;
  color: var(--ast-heading);
}
.ast-stat-label {
  color: var(--ast-text-muted);
  font-size: 0.8125rem;
}

.ast-input {
  font: inherit;
  padding: 0.45rem 0.85rem;
  border: 1px solid var(--ast-border);
  border-radius: var(--ast-radius);
  background: transparent;
  color: var(--ast-text);
  min-width: 12rem;
}
.ast-input:focus {
  outline: none;
  border-color: var(--ast-primary);
  box-shadow: 0 0 0.25rem 0.05rem rgba(var(--ast-primary-rgb), 0.1);
}

@media (prefers-reduced-motion: no-preference) {
  .ast-pulse {
    animation: ast-pulse 1.4s ease-in-out infinite;
  }
}
@keyframes ast-pulse {
  50% {
    opacity: 0.45;
  }
}
</style>
