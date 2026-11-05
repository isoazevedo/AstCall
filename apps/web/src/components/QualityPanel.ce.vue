<script setup lang="ts">
/**
 * Seção "Qualidade de voz": troncos cuja nota média ficou abaixo do limite (70) por pelo menos
 * 2 minutos — áudio picotando, atraso ou eco para quem liga pela operadora. Some sozinha quando a
 * qualidade volta. Sem tronco degradado, não aparece.
 *
 * Conceito: o componente só desenha (`v-if` na raiz); a regra de quando avisar fica em
 * lib/quality.ts, testada sem navegador.
 */
import { computed } from 'vue';
import { AudioLines } from 'lucide-vue-next';
import { useNow } from '../composables/useNow';
import { sinceText } from '../lib/disconnects';
import { degradedTrunks, qualityLevel } from '../lib/quality';
import { useMonitorStore } from '../stores/monitor';

const store = useMonitorStore();
const now = useNow();
const items = computed(() => degradedTrunks(store.endpoints, now.value));
</script>

<template>
  <section v-if="items.length" class="ast-card voice-panel" aria-live="polite">
    <header class="ast-card-header">
      <h5 class="ast-card-title">
        <AudioLines :size="18" aria-hidden="true" /> Qualidade de voz
        <span class="ast-badge tone-warning">{{ items.length }}</span>
      </h5>
    </header>
    <div class="ast-card-body">
      <ul class="voice-list">
        <li v-for="d in items" :key="d.id" :class="`lvl-${qualityLevel(d.mes)}`">
          <AudioLines :size="18" aria-hidden="true" />
          <strong class="voice-id">{{ d.id }}</strong>
          <span class="ast-badge tone-danger">Tronco</span>
          <span class="voice-text">
            qualidade degradada {{ sinceText(d.since, now) }} · nota média {{ Math.round(d.mes) }}
          </span>
          <span class="voice-meta">
            {{ d.channels }} {{ d.channels === 1 ? 'conversa medida' : 'conversas medidas' }}
          </span>
        </li>
      </ul>
    </div>
  </section>
</template>

<style>
.voice-panel {
  border-left: 0.35rem solid var(--ast-warning);
}
.voice-panel .ast-card-body {
  padding-top: 1rem;
}
.voice-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.4rem;
}
.voice-list li {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding: 0.55rem 0.85rem;
  border: 1px solid rgba(var(--ast-warning-rgb), 0.4);
  border-radius: var(--ast-radius);
  background: rgba(var(--ast-warning-rgb), 0.08);
  color: var(--ast-warning);
}
.voice-list li.lvl-poor {
  border-color: rgba(var(--ast-danger-rgb), 0.4);
  background: rgba(var(--ast-danger-rgb), 0.08);
  color: var(--ast-danger);
}
.voice-id {
  min-width: 4rem;
  font-weight: 600;
  color: var(--ast-heading);
}
.voice-text {
  font-weight: 500;
}
.voice-meta {
  margin-left: auto;
  font-size: 0.8125rem;
  color: var(--ast-text-muted);
}
</style>
