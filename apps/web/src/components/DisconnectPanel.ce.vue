<script setup lang="ts">
/**
 * Seção "Desconectados": ramais e troncos vigiados que caíram (passada a tolerância), com
 * há quanto tempo e quantos alertas já tocaram. Troncos aparecem primeiro, em vermelho.
 * Os que já estavam offline quando o monitoramento começou ficam recolhidos numa linha.
 */
import { computed, ref } from 'vue';
import { PhoneOff, ServerCrash } from 'lucide-vue-next';
import type { DisconnectAlerts } from '../composables/useDisconnectAlerts';
import { useNow } from '../composables/useNow';
import { sinceText } from '../lib/disconnects';

const props = defineProps<{ alerts: DisconnectAlerts }>();
const now = useNow({ live: true });
const showOld = ref(false);

const alerting = computed(() => props.alerts.alerting.value);
/** Já estavam fora do ar antes do monitoramento (sem alerta). */
const old = computed(() => props.alerts.items.value.filter((i) => i.since === null));

const clock = (ms: number | null) =>
  ms === null
    ? ''
    : new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
</script>

<template>
  <section class="ast-card down-panel" aria-live="polite">
    <header class="ast-card-header">
      <h5 class="ast-card-title">
        <PhoneOff :size="18" aria-hidden="true" /> Desconectados
        <span class="ast-badge tone-danger">{{ alerting.length }}</span>
      </h5>
    </header>
    <div class="ast-card-body">
      <ul class="down-list">
        <li v-for="d in alerting" :key="d.id" :class="{ trunk: d.trunk }">
          <component :is="d.trunk ? ServerCrash : PhoneOff" :size="18" aria-hidden="true" />
          <strong class="down-id">{{ d.id }}</strong>
          <span class="ast-badge" :class="d.trunk ? 'tone-danger' : 'tone-warning'">
            {{ d.trunk ? 'Tronco' : 'Ramal' }}
          </span>
          <span class="down-since">offline {{ sinceText(d.since, now) }}</span>
          <span class="down-meta">
            desde {{ clock(d.since) }} · {{ d.alertCount }}
            {{ d.alertCount === 1 ? 'alerta' : 'alertas' }}
          </span>
        </li>
      </ul>
      <p v-if="old.length" class="down-old">
        <button type="button" class="link" @click="showOld = !showOld">
          {{ showOld ? 'Ocultar' : 'Ver' }} {{ old.length }}
          {{ old.length === 1 ? 'que já estava offline' : 'que já estavam offline' }} quando o
          monitoramento começou
        </button>
        <span v-if="showOld" class="down-old-list">{{ old.map((o) => o.id).join(', ') }}</span>
      </p>
    </div>
  </section>
</template>

<style>
.down-panel {
  border-left: 0.35rem solid var(--ast-danger);
}
.down-panel .ast-card-body {
  padding-top: 1rem;
}
.down-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.4rem;
}
.down-list li {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding: 0.55rem 0.85rem;
  border: 1px solid var(--ast-border);
  border-radius: var(--ast-radius);
  color: var(--ast-warning);
}
.down-list li.trunk {
  color: var(--ast-danger);
  background: rgba(var(--ast-danger-rgb), 0.08);
  border-color: rgba(var(--ast-danger-rgb), 0.4);
}
.down-id {
  min-width: 4rem;
  font-weight: 600;
  color: var(--ast-heading);
}
.down-since {
  font-weight: 500;
}
.down-meta {
  margin-left: auto;
  font-size: 0.8125rem;
  color: var(--ast-text-muted);
}
.down-old {
  margin: 0.75rem 0 0;
  font-size: 0.8125rem;
  color: var(--ast-text-muted);
  display: grid;
  gap: 0.25rem;
}
.down-old .link {
  justify-self: start;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--ast-primary);
  cursor: pointer;
}
</style>
