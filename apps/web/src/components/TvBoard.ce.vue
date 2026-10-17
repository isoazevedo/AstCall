<script setup lang="ts">
/**
 * Modo TV (wallboard): tela escura, letras grandes, só leitura.
 *
 * - Duas telas, "Filas" e "Chamadas"; com o rodízio ligado, troca a cada N segundos
 *   (atributo `rotate`). Com o rodízio desligado, fica na tela escolhida.
 * - O rodízio e a tela escolhida ficam salvos no navegador (localStorage): a TV volta
 *   igual depois de recarregar.
 * - Os controles somem depois de alguns segundos sem mexer o mouse e voltam ao mexer.
 *
 * Conceitos de Vue usados aqui:
 * - `ref` no template (ref="rootEl"): acesso ao elemento HTML (para a tela cheia).
 * - `watch` com `{ immediate: true }`: roda já na montagem e depois a cada mudança —
 *   reinicia o timer do rodízio quando ele é ligado/desligado.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { Maximize, Minimize, Pause, Play } from 'lucide-vue-next';
import { useMonitorStore } from '../stores/monitor';
import { useNow } from '../composables/useNow';
import {
  loadTvPrefs,
  nextScreen,
  parseRotate,
  saveTvPrefs,
  TV_SCREEN_LABEL,
  TV_SCREENS,
  type TvScreen,
} from '../lib/tv';
import TvCalls from './TvCalls.ce.vue';
import TvQueues from './TvQueues.ce.vue';

const props = defineProps<{ rotate?: string | number; badge: { tone: string; text: string } }>();

const store = useMonitorStore();
const rotateCfg = parseRotate(props.rotate);

// Preferências: o atributo `rotate` é o padrão; o que o usuário escolheu na TV prevalece
const prefs = loadTvPrefs({ rotate: rotateCfg.enabled, screen: 'queues' });
const rotating = ref(prefs.rotate);
const screen = ref<TvScreen>(prefs.screen);

watch([rotating, screen], () => saveTvPrefs({ rotate: rotating.value, screen: screen.value }));

/** Sem filas no escopo (ex.: empresa sem fila): a tela de filas sai do rodízio. */
const available = computed<TvScreen[]>(() =>
  store.queues.length > 0 || !store.active?.hasSnapshot ? [...TV_SCREENS] : ['calls'],
);
watch(available, (list) => {
  if (!list.includes(screen.value)) screen.value = list[0]!;
});

// ---------------------------------------------------------------- rodízio
let timer: ReturnType<typeof setInterval> | undefined;
/** Incrementa a cada troca: reinicia a animação da barra de progresso. */
const cycle = ref(0);

function stopRotation(): void {
  clearInterval(timer);
  timer = undefined;
}

/** (Re)inicia a contagem do rodízio a partir de agora. */
function startRotation(): void {
  stopRotation();
  cycle.value++;
  timer = setInterval(() => {
    screen.value = nextScreen(available.value, screen.value);
    cycle.value++;
  }, rotateCfg.seconds * 1000);
}

watch(rotating, (on) => (on ? startRotation() : stopRotation()), { immediate: true });

/** Escolher uma tela na mão reinicia a contagem do rodízio (se estiver ligado). */
function choose(s: TvScreen): void {
  screen.value = s;
  if (rotating.value) startRotation();
}

// ---------------------------------------------------------------- tela cheia
const rootEl = ref<HTMLElement | null>(null);
const fullscreen = ref(false);

function syncFullscreen(): void {
  fullscreen.value = !!document.fullscreenElement;
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await rootEl.value?.requestFullscreen();
  } catch {
    // navegador recusou (ex.: sem gesto do usuário): segue sem tela cheia
  }
}

// ---------------------------------------------------------------- controles que somem
const idle = ref(false);
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function wake(): void {
  idle.value = false;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => (idle.value = true), 5000);
}

onMounted(() => {
  document.addEventListener('fullscreenchange', syncFullscreen);
  wake();
});
onUnmounted(() => {
  document.removeEventListener('fullscreenchange', syncFullscreen);
  stopRotation();
  clearTimeout(idleTimer);
});

// ---------------------------------------------------------------- cabeçalho
const now = useNow();
const clock = computed(() =>
  new Date(now.value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
);

const totals = computed(() => ({
  calls: store.calls.length,
  waiting: store.waitingTotal,
  online: store.endpoints.filter((e) => e.group !== 'offline').length,
  total: store.endpoints.length,
}));
</script>

<template>
  <div
    ref="rootEl"
    class="tv-root"
    :class="{ idle }"
    @mousemove="wake"
    @keydown="wake"
    @touchstart.passive="wake"
  >
    <!-- Barra de progresso do rodízio: a :key nova recria o elemento e reinicia a animação -->
    <div
      v-if="rotating && available.length > 1"
      :key="cycle"
      class="tv-progress"
      :style="{ animationDuration: `${rotateCfg.seconds}s` }"
    />

    <header class="tv-header">
      <div class="tv-heading">
        <h2 class="tv-title">{{ TV_SCREEN_LABEL[screen] }}</h2>
        <span class="tv-server">{{ store.active?.name ?? 'Aguardando servidor…' }}</span>
      </div>

      <div class="tv-totals">
        <span
          ><b>{{ totals.calls }}</b> {{ totals.calls === 1 ? 'chamada' : 'chamadas' }}</span
        >
        <span :class="{ 'tone-text-warning': totals.waiting > 0 }">
          <b>{{ totals.waiting }}</b> aguardando
        </span>
        <span
          ><b>{{ totals.online }}</b
          >/{{ totals.total }} ramais online</span
        >
      </div>

      <div class="tv-right">
        <span class="ast-badge" :class="`tone-${badge.tone}`" role="status">{{ badge.text }}</span>
        <span class="tv-clock">{{ clock }}</span>
      </div>
    </header>

    <!-- Controles: escolher tela, ligar/desligar rodízio, tela cheia -->
    <nav class="tv-controls" aria-label="Controles do modo TV">
      <button
        v-for="s in available"
        :key="s"
        type="button"
        class="ast-tab"
        :class="{ active: s === screen }"
        @click="choose(s)"
      >
        {{ TV_SCREEN_LABEL[s] }}
      </button>
      <button
        v-if="available.length > 1"
        type="button"
        class="ast-tab"
        :aria-pressed="rotating"
        :title="rotating ? 'Fixar a tela atual' : `Alternar as telas a cada ${rotateCfg.seconds}s`"
        @click="rotating = !rotating"
      >
        <Pause v-if="rotating" :size="16" aria-hidden="true" />
        <Play v-else :size="16" aria-hidden="true" />
        Rodízio {{ rotating ? 'ligado' : 'desligado' }}
      </button>
      <button type="button" class="ast-tab" @click="toggleFullscreen">
        <Minimize v-if="fullscreen" :size="16" aria-hidden="true" />
        <Maximize v-else :size="16" aria-hidden="true" />
        {{ fullscreen ? 'Sair da tela cheia' : 'Tela cheia' }}
      </button>
    </nav>

    <div v-if="store.stale && store.active?.hasSnapshot" class="ast-alert" role="alert">
      Conexão instável — os dados podem estar desatualizados.
    </div>

    <TvQueues
      v-if="screen === 'queues'"
      :queues="store.queues"
      :loading="!store.active?.hasSnapshot"
    />
    <TvCalls
      v-else
      :calls="store.calls"
      :endpoints="store.endpoints"
      :loading="!store.active?.hasSnapshot"
    />
  </div>
</template>

<style>
/*
 * Paleta escura fixa do modo TV (independe do tema da página). Personalizável pelas
 * variáveis --ast-tv-* na tag <ast-monitor>.
 */
.tv-root {
  --ast-card-bg: var(--ast-tv-card-bg, #1b2130);
  --ast-card-shadow: 0 0.25rem 1rem rgba(0, 0, 0, 0.35);
  --ast-text: var(--ast-tv-text, #c3cad6);
  --ast-text-muted: var(--ast-tv-text-muted, #8a96a8);
  --ast-heading: var(--ast-tv-heading, #f2f5f9);
  --ast-border: var(--ast-tv-border, #2c3446);

  position: relative;
  display: grid;
  align-content: start;
  gap: 1.5rem;
  min-height: 100vh;
  padding: 1.5rem 2rem 2rem;
  background: var(--ast-tv-bg, #11151f);
  color: var(--ast-text);
  font-size: 1.05rem;
}
/* Em tela cheia o elemento ocupa a tela toda e rola se precisar */
.tv-root:fullscreen {
  overflow: auto;
}

.tv-progress {
  position: absolute;
  top: 0;
  left: 0;
  height: 0.25rem;
  width: 100%;
  background: var(--ast-primary);
  transform-origin: left;
  animation-name: tv-progress;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}
@keyframes tv-progress {
  from {
    transform: scaleX(0);
  }
  to {
    transform: scaleX(1);
  }
}

.tv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  flex-wrap: wrap;
}
.tv-heading {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  flex-wrap: wrap;
}
.tv-title {
  margin: 0;
  font-family: var(--ast-font-heading);
  font-weight: 500;
  font-size: 2.25rem;
  color: var(--ast-heading);
}
.tv-server {
  font-size: 1.15rem;
  color: var(--ast-text-muted);
}
.tv-totals {
  display: flex;
  gap: 1.75rem;
  flex-wrap: wrap;
  font-size: 1.15rem;
}
.tv-totals b {
  font-family: var(--ast-font-heading);
  font-size: 1.6rem;
  font-weight: 500;
  color: var(--ast-heading);
}
.tv-totals .tone-text-warning b {
  color: var(--ast-warning);
}
.tv-right {
  display: flex;
  align-items: center;
  gap: 1rem;
}
.tv-clock {
  font-family: var(--ast-font-heading);
  font-size: 2.25rem;
  font-variant-numeric: tabular-nums;
  color: var(--ast-heading);
}

.tv-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  transition: opacity 0.4s ease;
}
.tv-controls .ast-tab:not(.active) {
  color: var(--ast-text);
}
/* Mouse parado: controles quase somem para não poluir a TV */
.tv-root.idle .tv-controls {
  opacity: 0.12;
}
.tv-root.idle {
  cursor: none;
}
</style>
