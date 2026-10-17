<script setup lang="ts">
/**
 * Tela "Chamadas" do modo TV: chamadas em curso em letras grandes + mapa de ramais.
 *
 * Só leitura (sem botões de ação). A lista mostra até MAX_CALLS chamadas; as demais viram
 * um "+N" — na TV não há rolagem.
 * Conceito: `computed` com `slice` deriva a parte visível da lista sem copiar o estado.
 */
import { computed } from 'vue';
import { ArrowLeftRight, Circle, Ear, Mic, PhoneIncoming } from 'lucide-vue-next';
import { useNow } from '../composables/useNow';
import { formatDuration, type CallView, type EndpointView } from '../lib/view';

const props = defineProps<{ calls: CallView[]; endpoints: EndpointView[]; loading: boolean }>();

const MAX_CALLS = 10;
const visibleCalls = computed(() => props.calls.slice(0, MAX_CALLS));
const hiddenCalls = computed(() => Math.max(0, props.calls.length - MAX_CALLS));

const now = useNow();
/** Duração contada a partir do atendimento (ou do início, se ainda não atendeu). */
const duration = (c: CallView) =>
  formatDuration((now.value - (c.answeredAt ?? c.startedAt)) / 1000);

const partyText = (p: CallView['parties'][number]) => (p.name ? `${p.num} ${p.name}` : p.num);
</script>

<template>
  <div v-if="loading" class="ast-empty ast-pulse">Carregando chamadas…</div>

  <div v-else class="tv-calls-screen">
    <section class="ast-card tv-calls">
      <h3 class="tv-section-title">Chamadas em curso</h3>
      <p v-if="calls.length === 0" class="ast-empty tv-quiet">Nenhuma chamada no momento.</p>

      <ul v-else class="tv-call-list">
        <li v-for="c in visibleCalls" :key="c.id" class="tv-call">
          <span class="ast-badge tv-call-status" :class="`tone-${c.tone}`">
            <Ear v-if="c.spyTarget" :size="18" aria-hidden="true" />
            {{ c.label }}
          </span>

          <span class="tv-call-parties">
            <template v-for="(p, i) in c.parties" :key="p.uniqueid">
              <ArrowLeftRight v-if="i > 0" :size="22" class="tv-sep" aria-hidden="true" />
              <span class="tv-party">{{ partyText(p) }}</span>
            </template>
            <template v-if="c.spyTarget">
              <ArrowLeftRight :size="22" class="tv-sep" aria-hidden="true" />
              <span class="tv-party">{{ partyText(c.spyTarget) }}</span>
            </template>
          </span>

          <span class="tv-call-tags">
            <span v-if="c.queue" class="tv-tag" :title="`Fila ${c.queue}`">
              <PhoneIncoming :size="18" aria-hidden="true" /> {{ c.queue }}
            </span>
            <Mic v-if="c.recording" :size="20" class="tone-text-danger" aria-label="Gravando" />
            <Ear v-if="c.monitored" :size="20" class="tone-text-info" aria-label="Em escuta" />
          </span>

          <span class="tv-call-time">{{ duration(c) }}</span>
        </li>
      </ul>
      <p v-if="hiddenCalls > 0" class="tv-more">
        + {{ hiddenCalls }} {{ hiddenCalls === 1 ? 'chamada' : 'chamadas' }}
      </p>
    </section>

    <section class="ast-card tv-endpoints">
      <h3 class="tv-section-title">Ramais</h3>
      <p v-if="endpoints.length === 0" class="ast-empty tv-quiet">Nenhum ramal.</p>
      <ul v-else class="tv-ep-grid">
        <li
          v-for="e in endpoints"
          :key="e.id"
          class="tv-ep"
          :class="`tone-${e.tone}`"
          :title="`${e.id}: ${e.label}`"
        >
          <Circle :size="10" fill="currentColor" aria-hidden="true" />
          {{ e.id }}
        </li>
      </ul>
    </section>
  </div>
</template>

<style>
.tv-calls-screen {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: 1.5rem;
  align-items: start;
}
@media (max-width: 900px) {
  .tv-calls-screen {
    grid-template-columns: minmax(0, 1fr);
  }
}
.tv-section-title {
  margin: 0 0 1rem;
  font-family: var(--ast-font-heading);
  font-weight: 500;
  font-size: 1.5rem;
  color: var(--ast-heading);
}
.tv-calls,
.tv-endpoints {
  padding: 1.5rem 1.75rem;
}
.tv-quiet {
  font-size: 1.25rem;
}
.tv-call-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
}
.tv-call {
  display: grid;
  grid-template-columns: 10rem minmax(0, 1fr) auto 6rem;
  align-items: center;
  gap: 1rem;
  padding: 0.8rem 0;
  border-top: 1px solid var(--ast-border);
  font-size: 1.35rem;
}
.tv-call:first-child {
  border-top: 0;
}
.tv-call-status {
  justify-content: center;
  font-size: 1rem;
  padding: 0.45rem 0.6rem;
}
.tv-call-parties {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
  color: var(--ast-heading);
  font-weight: 500;
}
.tv-party {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-sep {
  flex: none;
  color: var(--ast-text-muted);
}
.tv-call-tags {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  color: var(--ast-text-muted);
}
.tv-tag {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 1.05rem;
}
.tv-call-time {
  text-align: right;
  font-family: var(--ast-font-heading);
  font-variant-numeric: tabular-nums;
  color: var(--ast-heading);
}
.tv-more {
  margin: 0.75rem 0 0;
  font-size: 1.1rem;
  color: var(--ast-text-muted);
}
.tv-ep-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(6.5rem, 1fr));
  gap: 0.5rem;
}
.tv-ep {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 0.6rem;
  border-radius: var(--ast-radius);
  font-size: 1.05rem;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tone-text-info {
  color: var(--ast-info);
}
</style>
