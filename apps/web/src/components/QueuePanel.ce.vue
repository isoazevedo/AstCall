<script setup lang="ts">
/** Aba "Filas": um card por fila, com busca pelo nome. */
import { computed, ref } from 'vue';
import type { QueueView } from '../lib/view';
import QueueCard from './QueueCard.ce.vue';

const props = withDefaults(
  defineProps<{ queues: QueueView[]; loading: boolean; searchable?: boolean }>(),
  { searchable: true },
);

const search = ref('');
const visible = computed(() => {
  const term = search.value.trim().toLowerCase();
  return term ? props.queues.filter((q) => q.name.toLowerCase().includes(term)) : props.queues;
});
</script>

<template>
  <div class="q-panel">
    <div v-if="searchable" class="q-toolbar">
      <input
        v-model="search"
        class="ast-input"
        type="search"
        placeholder="Buscar fila…"
        aria-label="Buscar fila"
      />
    </div>
    <div v-if="loading" class="ast-card ast-empty">Carregando…</div>
    <div v-else-if="queues.length === 0" class="ast-card ast-empty">
      Nenhuma fila configurada neste servidor.
    </div>
    <div v-else-if="visible.length === 0" class="ast-card ast-empty">Nenhuma fila encontrada.</div>
    <div v-else class="q-grid">
      <QueueCard v-for="q in visible" :key="q.name" :queue="q" />
    </div>
  </div>
</template>

<style>
.q-panel {
  display: grid;
  gap: 1rem;
}
.q-toolbar {
  display: flex;
  justify-content: flex-end;
}
.q-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr));
  gap: 1.5rem;
  align-items: start;
}
</style>
