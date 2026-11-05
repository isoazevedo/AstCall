<script setup lang="ts">
/**
 * Barra do histórico (máquina do tempo): aparece enquanto o painel mostra um horário
 * passado. Tem a barra deslizante (do início do histórico até agora), botões para andar
 * alguns minutos, um campo de data e hora e o botão para voltar ao vivo.
 *
 * Conceitos: o valor da barra deslizante muda na hora (`draft`), mas o pedido ao servidor
 * só sai quando o usuário para de arrastar por um instante (debounce com setTimeout) —
 * arrastar não dispara dezenas de pedidos.
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import { History, Radio, TriangleAlert } from 'lucide-vue-next';
import { useNow } from '../composables/useNow';
import {
  clampAt,
  formatAt,
  fromLocalInput,
  HISTORY_STEPS_MIN,
  stepLabel,
  toLocalInput,
} from '../lib/history';
import { useMonitorStore } from '../stores/monitor';

const store = useMonitorStore();
const liveNow = useNow({ live: true });

/** Horário na barra enquanto o usuário arrasta (antes de pedir ao servidor). */
const draft = ref(store.history.at ?? liveNow.value);
watch(
  () => store.history.at,
  (at) => {
    if (at !== null) draft.value = at;
  },
);

/** Início da barra: o começo do histórico (quando já conhecido) ou 1 h antes do horário. */
const min = computed(() => store.history.from ?? Math.min(draft.value, liveNow.value) - 3_600_000);

let timer: ReturnType<typeof setTimeout> | undefined;
onUnmounted(() => clearTimeout(timer));

/** Vai para o horário `at` (limitado ao que existe), com espera opcional (barra arrastada). */
function go(at: number, delayMs = 0): void {
  const target = clampAt(at, store.history.from, liveNow.value);
  draft.value = target;
  clearTimeout(timer);
  timer = setTimeout(() => void store.showHistory(target), delayMs);
}

function onSlide(ev: Event): void {
  go(Number((ev.target as HTMLInputElement).value), 200);
}

function onDate(ev: Event): void {
  const at = fromLocalInput((ev.target as HTMLInputElement).value);
  if (at !== null) go(at);
}

/** Situação do PBX naquele horário, quando não estava normal. */
const pbxWarning = computed(() => {
  const status = store.history.state?.status;
  if (!status || status === 'ready') return null;
  return status === 'disconnected'
    ? 'PBX desconectado neste horário: os dados podem estar incompletos.'
    : 'PBX sincronizando neste horário: os dados podem estar incompletos.';
});
</script>

<template>
  <section class="ast-card hist-bar" aria-label="Histórico">
    <div class="hist-top">
      <h5 class="ast-card-title">
        <History :size="18" aria-hidden="true" /> Histórico
        <span class="hist-time" aria-live="polite">{{ formatAt(draft, liveNow) }}</span>
        <span v-if="store.history.loading" class="ast-badge tone-secondary">Carregando…</span>
      </h5>
      <button type="button" class="hist-live" @click="store.exitHistory()">
        <Radio :size="16" aria-hidden="true" /> Voltar ao vivo
      </button>
    </div>

    <input
      class="hist-range"
      type="range"
      :min="min"
      :max="liveNow"
      step="1000"
      :value="draft"
      aria-label="Horário do histórico"
      @input="onSlide"
    />
    <div class="hist-scale">
      <span>{{ formatAt(min, liveNow) }}</span>
      <span>agora</span>
    </div>

    <div class="hist-controls">
      <button
        v-for="step in HISTORY_STEPS_MIN"
        :key="step"
        type="button"
        class="hist-step"
        @click="go(draft + step * 60_000)"
      >
        {{ stepLabel(step) }}
      </button>
      <label class="hist-date">
        <span>Ir para</span>
        <input
          type="datetime-local"
          step="1"
          class="ast-input"
          :value="toLocalInput(draft)"
          @change="onDate"
        />
      </label>
    </div>

    <p v-if="store.history.error" class="hist-msg error" role="alert">
      <TriangleAlert :size="16" aria-hidden="true" /> {{ store.history.error }}
    </p>
    <p v-else-if="pbxWarning" class="hist-msg" role="status">
      <TriangleAlert :size="16" aria-hidden="true" /> {{ pbxWarning }}
    </p>
    <p class="hist-note">
      O painel abaixo mostra este horário. As ações ficam desativadas até voltar ao vivo.
    </p>
  </section>
</template>

<style>
.hist-bar {
  display: grid;
  gap: 0.6rem;
  padding: 1rem 1.25rem;
  border-left: 0.35rem solid var(--ast-info);
  background: rgba(var(--ast-info-rgb), 0.06);
}
.hist-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
}
.hist-time {
  font-variant-numeric: tabular-nums;
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--ast-info);
}
.hist-live {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.9rem;
  border: 0;
  border-radius: var(--ast-radius);
  background: var(--ast-success);
  color: #fff;
  font: inherit;
  font-weight: 500;
  cursor: pointer;
}
.hist-range {
  width: 100%;
  accent-color: var(--ast-info);
}
.hist-scale {
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  color: var(--ast-text-muted);
}
.hist-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}
.hist-step {
  padding: 0.3rem 0.7rem;
  border: 1px solid var(--ast-border);
  border-radius: var(--ast-radius);
  background: none;
  color: var(--ast-heading);
  font: inherit;
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.hist-step:hover {
  border-color: var(--ast-info);
}
.hist-date {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
  color: var(--ast-text-muted);
}
.hist-date .ast-input {
  width: auto;
}
.hist-msg {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.875rem;
  color: var(--ast-warning);
}
.hist-msg.error {
  color: var(--ast-danger);
}
.hist-note {
  margin: 0;
  font-size: 0.75rem;
  color: var(--ast-text-muted);
}
@media (max-width: 576px) {
  .hist-date {
    margin-left: 0;
  }
}
</style>
