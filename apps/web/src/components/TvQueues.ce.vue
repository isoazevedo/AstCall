<script setup lang="ts">
/**
 * Tela "Filas" do modo TV: um bloco grande por fila, para ler de longe.
 *
 * Mostra o que importa num wallboard: quantos aguardam, a maior espera (relógio ao vivo,
 * muda de cor nos limites), atendidas, abandonadas, nível de serviço e os agentes por estado.
 * As filas ficam em ordem alfabética — posição fixa ajuda quem olha a TV todo dia.
 */
import { useNow } from '../composables/useNow';
import { abandonRate, oldestWaitingSince } from '../lib/tv';
import { formatDuration, waitTone, type QueueView } from '../lib/view';

defineProps<{ queues: QueueView[]; loading: boolean }>();

const now = useNow();

/** Segundos desde a entrada do chamador mais antigo (0 se ninguém aguarda). */
function longestWait(q: QueueView): number {
  const since = oldestWaitingSince(q);
  return since === null ? 0 : Math.max(0, (now.value - since) / 1000);
}
</script>

<template>
  <div v-if="loading" class="ast-empty ast-pulse">Carregando filas…</div>
  <div v-else-if="queues.length === 0" class="ast-empty">Nenhuma fila configurada.</div>

  <section v-else class="tv-queues">
    <article
      v-for="q in queues"
      :key="q.name"
      class="ast-card tv-queue"
      :class="`edge-${q.waiting.length ? waitTone(longestWait(q)) : 'none'}`"
    >
      <h3 class="tv-queue-name">{{ q.name }}</h3>

      <div class="tv-queue-main">
        <div class="tv-big">
          <span class="tv-big-value" :class="{ 'tone-text-warning': q.waiting.length > 0 }">
            {{ q.waiting.length }}
          </span>
          <span class="tv-big-label">Aguardando</span>
        </div>
        <div class="tv-big">
          <span
            class="tv-big-value"
            :class="q.waiting.length ? `tone-text-${waitTone(longestWait(q))}` : 'muted'"
          >
            {{ q.waiting.length ? formatDuration(longestWait(q)) : '—' }}
          </span>
          <span class="tv-big-label">Maior espera</span>
        </div>
      </div>

      <dl class="tv-queue-stats">
        <div>
          <dt>Atendidas</dt>
          <dd class="tone-text-success">{{ q.completed }}</dd>
        </div>
        <div>
          <dt>Abandonadas</dt>
          <dd :class="{ 'tone-text-danger': q.abandoned > 0 }">
            {{ q.abandoned }}
            <small v-if="q.abandoned > 0">{{ abandonRate(q).toFixed(0) }}%</small>
          </dd>
        </div>
        <div>
          <dt>Espera média</dt>
          <dd>{{ formatDuration(q.holdtime) }}</dd>
        </div>
        <div v-if="q.serviceLevel > 0">
          <dt>NS ({{ q.serviceLevel }}s)</dt>
          <dd>{{ q.serviceLevelPerf.toFixed(0) }}%</dd>
        </div>
      </dl>

      <!-- Agentes por estado -->
      <div class="tv-agents">
        <span class="ast-badge tone-success">
          {{ q.available }} {{ q.available === 1 ? 'livre' : 'livres' }}
        </span>
        <span class="ast-badge tone-primary">{{ q.busy }} em atendimento</span>
        <span v-if="q.paused" class="ast-badge tone-warning">
          {{ q.paused }} {{ q.paused === 1 ? 'pausado' : 'pausados' }}
        </span>
        <span v-if="q.offline" class="ast-badge tone-secondary">{{ q.offline }} offline</span>
      </div>
    </article>
  </section>
</template>

<style>
.tv-queues {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 22rem), 1fr));
  gap: 1.5rem;
}
.tv-queue {
  display: grid;
  gap: 1.25rem;
  padding: 1.5rem 1.75rem;
  border-left: 0.5rem solid transparent;
}
/* Faixa lateral colorida: chama atenção para a fila com espera alta */
.tv-queue.edge-secondary {
  border-left-color: var(--ast-info);
}
.tv-queue.edge-warning {
  border-left-color: var(--ast-warning);
}
.tv-queue.edge-danger {
  border-left-color: var(--ast-danger);
}
.tv-queue-name {
  margin: 0;
  font-family: var(--ast-font-heading);
  font-weight: 500;
  font-size: 1.6rem;
  color: var(--ast-heading);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-queue-main {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}
.tv-big {
  display: flex;
  flex-direction: column;
}
.tv-big-value {
  font-family: var(--ast-font-heading);
  font-size: 3.5rem;
  font-weight: 500;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--ast-heading);
}
.tv-big-label {
  margin-top: 0.35rem;
  font-size: 1rem;
  color: var(--ast-text-muted);
}
.tv-queue-stats {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(6.5rem, 1fr));
  gap: 0.75rem;
}
.tv-queue-stats dt {
  font-size: 0.9rem;
  color: var(--ast-text-muted);
}
.tv-queue-stats dd {
  margin: 0;
  font-family: var(--ast-font-heading);
  font-size: 1.6rem;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--ast-heading);
}
.tv-queue-stats small {
  font-size: 0.9rem;
  font-weight: 400;
}
.tv-agents {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.tv-agents .ast-badge {
  font-size: 1rem;
  padding: 0.45rem 0.75rem;
}
.muted {
  color: var(--ast-text-muted);
}
.tone-text-danger {
  color: var(--ast-danger);
}
.tone-text-secondary {
  color: var(--ast-heading);
}
</style>
