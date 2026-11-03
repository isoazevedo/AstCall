<script setup lang="ts">
/**
 * Tela "Desconectados" do modo TV: ramais e troncos fora do ar em letras grandes, com há
 * quanto tempo. Troncos primeiro, em vermelho (a operação fica sem ligar para fora).
 */
import { PhoneOff, ServerCrash } from 'lucide-vue-next';
import { useNow } from '../composables/useNow';
import { sinceText, type DownItem } from '../lib/disconnects';

defineProps<{ items: DownItem[] }>();
const now = useNow();
</script>

<template>
  <section class="tv-down">
    <article
      v-for="d in items"
      :key="d.id"
      class="ast-card tv-down-card"
      :class="{ trunk: d.trunk }"
    >
      <component :is="d.trunk ? ServerCrash : PhoneOff" :size="40" aria-hidden="true" />
      <div>
        <h3>{{ d.id }}</h3>
        <p class="kind">{{ d.trunk ? 'Tronco fora do ar' : 'Ramal desconectado' }}</p>
      </div>
      <span class="since">{{ sinceText(d.since, now) }}</span>
    </article>
  </section>
</template>

<style>
.tv-down {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 26rem), 1fr));
  gap: 1.5rem;
}
.tv-down-card {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 1.25rem;
  padding: 1.5rem 1.75rem;
  border-left: 0.5rem solid var(--ast-warning);
  color: var(--ast-warning);
}
.tv-down-card.trunk {
  border-left-color: var(--ast-danger);
  color: var(--ast-danger);
  background: color-mix(in srgb, var(--ast-danger) 12%, var(--ast-card-bg));
}
.tv-down-card h3 {
  margin: 0;
  font-family: var(--ast-font-heading);
  font-size: 2.25rem;
  font-weight: 500;
  color: var(--ast-heading);
}
.tv-down-card .kind {
  margin: 0.2rem 0 0;
  font-size: 1.1rem;
}
.tv-down-card .since {
  font-family: var(--ast-font-heading);
  font-size: 1.35rem;
  font-weight: 500;
  text-align: right;
}
</style>
