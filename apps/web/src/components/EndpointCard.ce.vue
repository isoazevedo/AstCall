<script setup lang="ts">
/** Cartão de um ramal: número, situação (cor do tema), aparelho e canais ativos. */
import { PhoneOutgoing } from 'lucide-vue-next';
import type { EndpointView } from '../lib/view';
import { useWidget } from '../composables/useWidget';

defineProps<{ endpoint: EndpointView }>();
const { can, open } = useWidget();
</script>

<template>
  <article class="ep" :class="`ep-${endpoint.tone}`">
    <div class="ep-top">
      <strong class="ep-id">{{ endpoint.id }}</strong>
      <span
        class="ast-badge"
        :class="[`tone-${endpoint.tone}`, { 'ast-pulse': endpoint.tone === 'warning' }]"
      >
        {{ endpoint.label }}
      </span>
    </div>
    <div class="ep-meta" :title="endpoint.address ?? undefined">
      {{ endpoint.userAgent ?? (endpoint.group === 'offline' ? 'Sem registro' : '—') }}
    </div>
    <div v-if="endpoint.activeChannels > 0" class="ep-calls">
      {{ endpoint.activeChannels }} {{ endpoint.activeChannels === 1 ? 'canal' : 'canais' }}
    </div>
    <button
      v-if="can('originate') && endpoint.group !== 'offline'"
      type="button"
      class="ep-call"
      :title="`Ligar a partir do ramal ${endpoint.id}`"
      @click="open({ kind: 'originate', from: endpoint.id })"
    >
      <PhoneOutgoing :size="13" aria-hidden="true" /> Ligar
    </button>
  </article>
</template>

<style>
.ep {
  position: relative;
  padding: 0.85rem 1rem 0.85rem 1.15rem;
  border: 1px solid var(--ast-border);
  border-radius: calc(var(--ast-card-radius) / 2);
  overflow: hidden;
}
/* Faixa colorida à esquerda indica a situação */
.ep::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 4px;
  background: var(--ep-color);
}
.ep-success {
  --ep-color: var(--ast-success);
}
.ep-primary {
  --ep-color: var(--ast-primary);
}
.ep-warning {
  --ep-color: var(--ast-warning);
}
.ep-danger {
  --ep-color: var(--ast-danger);
}
.ep-info {
  --ep-color: var(--ast-info);
}
.ep-secondary {
  --ep-color: var(--ast-secondary);
  opacity: 0.75;
}
.ep-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.ep-id {
  font-family: var(--ast-font-heading);
  font-weight: 500;
  font-size: 1.05rem;
  color: var(--ast-heading);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ep-meta {
  margin-top: 0.35rem;
  font-size: 0.75rem;
  color: var(--ast-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ep-call {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  margin-top: 0.5rem;
  padding: 0.2rem 0.55rem;
  font: inherit;
  font-size: 0.75rem;
  font-weight: 500;
  border: 0;
  border-radius: var(--ast-radius);
  background: rgba(var(--ast-primary-rgb), 0.12);
  color: var(--ast-primary);
  cursor: pointer;
}
.ep-call:hover {
  background: var(--ast-primary);
  color: #fff;
}
.ep-calls {
  margin-top: 0.25rem;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--ast-primary);
}
</style>
