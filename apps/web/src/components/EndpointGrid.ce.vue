<script setup lang="ts">
/**
 * Grade de ramais com busca e filtro por situação.
 *
 * Conceitos: `ref` guarda um valor reativo (o texto da busca e o filtro); `v-model` liga
 * o campo de texto a esse ref nos dois sentidos; `computed` refaz a lista filtrada só
 * quando a busca, o filtro ou os ramais mudam.
 */
import { computed, ref } from 'vue';
import { Phone } from 'lucide-vue-next';
import type { EndpointGroup, EndpointView } from '../lib/view';
import EndpointCard from './EndpointCard.ce.vue';

const props = defineProps<{ endpoints: EndpointView[]; loading: boolean }>();

const search = ref('');
const filter = ref<'all' | EndpointGroup>('all');

const filters: { value: 'all' | EndpointGroup; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'free', label: 'Livres' },
  { value: 'busy', label: 'Em uso' },
  { value: 'offline', label: 'Indisponíveis' },
];

const counts = computed(() => {
  const c: Record<string, number> = { all: props.endpoints.length, free: 0, busy: 0, offline: 0 };
  for (const e of props.endpoints) c[e.group] = (c[e.group] ?? 0) + 1;
  return c;
});

const visible = computed(() => {
  const term = search.value.trim().toLowerCase();
  return props.endpoints.filter(
    (e) =>
      (filter.value === 'all' || e.group === filter.value) &&
      (!term || e.id.toLowerCase().includes(term) || e.userAgent?.toLowerCase().includes(term)),
  );
});
</script>

<template>
  <div class="ast-card">
    <div class="ast-card-header">
      <h5 class="ast-card-title"><Phone :size="18" aria-hidden="true" /> Ramais</h5>
      <div class="tools">
        <div class="seg" role="group" aria-label="Filtrar por situação">
          <button
            v-for="f in filters"
            :key="f.value"
            type="button"
            :class="{ active: filter === f.value }"
            @click="filter = f.value"
          >
            {{ f.label }} <span class="count">{{ counts[f.value] }}</span>
          </button>
        </div>
        <input
          v-model="search"
          class="ast-input"
          type="search"
          placeholder="Buscar ramal…"
          aria-label="Buscar ramal"
        />
      </div>
    </div>
    <div class="ast-card-body">
      <div v-if="loading" class="ast-empty">Carregando…</div>
      <div v-else-if="visible.length === 0" class="ast-empty">Nenhum ramal encontrado.</div>
      <div v-else class="grid">
        <EndpointCard v-for="ep in visible" :key="ep.id" :endpoint="ep" />
      </div>
    </div>
  </div>
</template>

<style>
.tools {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.seg {
  display: inline-flex;
  padding: 0.2rem;
  border-radius: calc(var(--ast-radius) + 0.15rem);
  background: rgba(var(--ast-secondary-rgb), 0.1);
}
.seg button {
  font: inherit;
  font-size: 0.8125rem;
  padding: 0.35rem 0.75rem;
  border: 0;
  border-radius: var(--ast-radius);
  background: transparent;
  color: var(--ast-text);
  cursor: pointer;
}
.seg button.active {
  background: var(--ast-card-bg);
  color: var(--ast-primary);
  box-shadow: 0 1px 3px rgba(38, 60, 85, 0.15);
}
.seg .count {
  margin-left: 0.2rem;
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 1rem;
}
</style>
