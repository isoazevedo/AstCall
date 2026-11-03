<script setup lang="ts">
/**
 * Bloco "Previsão" do card de fila: situação para os próximos minutos (dentro da meta, abaixo
 * da meta ou vai estourar), nível de serviço previsto, atendentes necessários × disponíveis,
 * ritmo de entrada com tendência e tempo médio de atendimento.
 *
 * Conceito: `computed` transforma o dado bruto do backend (QueueForecast) em textos prontos
 * — a lógica fica em lib/forecast.ts, testada sem navegador.
 */
import { computed } from 'vue';
import { Minus, TrendingDown, TrendingUp, UserPlus } from 'lucide-vue-next';
import type { QueueForecast } from '@astcall/shared';
import { forecastView } from '../lib/forecast';

const props = defineProps<{ forecast: QueueForecast }>();
const v = computed(() => forecastView(props.forecast));
const trendIcon = computed(
  () => ({ up: TrendingUp, down: TrendingDown, stable: Minus })[v.value.trend],
);
const trendLabel = computed(
  () => ({ up: 'subindo', down: 'caindo', stable: 'estável' })[v.value.trend],
);
</script>

<template>
  <section class="q-forecast" :class="`risk-${forecast.risk}`">
    <header class="q-forecast-head">
      <h6>Previsão</h6>
      <span class="ast-badge" :class="`tone-${v.tone}`">{{ v.riskLabel }}</span>
    </header>
    <p v-if="v.slText" class="q-forecast-sl">{{ v.slText }}</p>
    <p v-if="v.shortage" class="q-forecast-short">
      <UserPlus :size="14" aria-hidden="true" /> {{ v.shortage }}
    </p>
    <p class="q-forecast-meta">
      <span>
        Entrada {{ v.arrivals }}
        <component :is="trendIcon" :size="13" aria-hidden="true" class="trend" />
        <span class="sr-trend">{{ trendLabel }}</span>
      </span>
      <span v-if="v.aht">· atendimento médio {{ v.aht }}</span>
    </p>
    <p v-if="v.note" class="q-forecast-note">{{ v.note }}</p>
  </section>
</template>

<style>
.q-forecast {
  display: grid;
  gap: 0.35rem;
  padding: 0.75rem 0.9rem;
  border-radius: var(--ast-radius);
  border-left: 0.25rem solid var(--ast-success);
  background: rgba(var(--ast-success-rgb), 0.06);
}
.q-forecast.risk-warn {
  border-left-color: var(--ast-warning);
  background: rgba(var(--ast-warning-rgb), 0.08);
}
.q-forecast.risk-high {
  border-left-color: var(--ast-danger);
  background: rgba(var(--ast-danger-rgb), 0.08);
}
.q-forecast p {
  margin: 0;
}
.q-forecast-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.q-forecast-head h6 {
  margin: 0;
  font-family: var(--ast-font-heading);
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--ast-heading);
}
.q-forecast-sl {
  font-weight: 500;
  color: var(--ast-heading);
}
.q-forecast-short {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--ast-danger);
}
.q-forecast.risk-warn .q-forecast-short {
  color: var(--ast-warning);
}
.q-forecast-meta,
.q-forecast-note {
  font-size: 0.75rem;
  color: var(--ast-text-muted);
}
.q-forecast-meta .trend {
  vertical-align: -2px;
}
.sr-trend {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
