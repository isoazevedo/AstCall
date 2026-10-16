<script setup lang="ts">
/**
 * Lista de chamadas em andamento.
 *
 * Conceitos: `v-for` repete um trecho para cada item; o `:key` identifica cada linha para
 * o Vue atualizar só o que mudou (sem recriar a lista inteira a cada delta).
 */
import { ArrowLeftRight, CircleDot, PhoneCall, PhoneForwarded, PhoneOff } from 'lucide-vue-next';
import { useNow } from '../composables/useNow';
import { formatDuration, type CallView, type Party } from '../lib/view';
import { useMonitorStore } from '../stores/monitor';

defineProps<{ calls: CallView[]; loading: boolean }>();

const store = useMonitorStore();
const partyLabel = (p: Party) => (p.name ? `${p.num} (${p.name})` : p.num);

const now = useNow();

/** Duração: desde o atendimento (em conversa) ou desde o início (tocando/discando). */
function duration(call: CallView): string {
  const from = call.answeredAt ?? call.startedAt;
  return formatDuration((now.value - from) / 1000);
}
</script>

<template>
  <div class="ast-card">
    <div class="ast-card-header">
      <h5 class="ast-card-title">
        <PhoneCall :size="18" aria-hidden="true" /> Chamadas em andamento
      </h5>
    </div>
    <div class="ast-card-body">
      <div v-if="loading" class="ast-empty">Carregando…</div>
      <div v-else-if="calls.length === 0" class="ast-empty">Nenhuma chamada no momento.</div>
      <table v-else class="calls">
        <thead>
          <tr>
            <th>Participantes</th>
            <th>Situação</th>
            <th class="num">Duração</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="call in calls" :key="call.id">
            <td>
              <div class="parties">
                <template v-for="(p, i) in call.parties" :key="p.uniqueid">
                  <ArrowLeftRight v-if="i > 0" :size="14" class="link" aria-label="ligado a" />
                  <span class="party">
                    <strong>{{ p.num }}</strong>
                    <small v-if="p.name">{{ p.name }}</small>
                    <span class="party-actions">
                      <button
                        v-if="store.can('transfer') && call.status === 'talking'"
                        type="button"
                        class="icon-btn"
                        :title="`Transferir ${p.num}`"
                        :aria-label="`Transferir ${p.num}`"
                        @click="
                          store.openDialog({
                            kind: 'transfer',
                            uniqueid: p.uniqueid,
                            label: partyLabel(p),
                          })
                        "
                      >
                        <PhoneForwarded :size="14" />
                      </button>
                      <button
                        v-if="store.can('hangup')"
                        type="button"
                        class="icon-btn danger"
                        :title="`Desligar ${p.num}`"
                        :aria-label="`Desligar ${p.num}`"
                        @click="
                          store.openDialog({
                            kind: 'hangup',
                            uniqueid: p.uniqueid,
                            label: partyLabel(p),
                          })
                        "
                      >
                        <PhoneOff :size="14" />
                      </button>
                    </span>
                  </span>
                </template>
              </div>
              <div v-for="(group, gi) in call.extraGroups" :key="gi" class="parties extra">
                <template v-for="(p, i) in group" :key="p.uniqueid">
                  <ArrowLeftRight v-if="i > 0" :size="12" class="link" aria-label="ligado a" />
                  <span>{{ p.num }}</span>
                </template>
              </div>
            </td>
            <td>
              <span
                class="ast-badge"
                :class="[`tone-${call.tone}`, { 'ast-pulse': call.status === 'ringing' }]"
              >
                {{ call.label }}
              </span>
              <span v-if="call.recording" class="rec" title="Chamada sendo gravada">
                <CircleDot :size="14" aria-hidden="true" /> REC
              </span>
              <div v-if="call.queue" class="via-queue">via fila {{ call.queue }}</div>
            </td>
            <td class="num">{{ duration(call) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style>
.calls {
  width: 100%;
  border-collapse: collapse;
}
.calls th {
  padding: 0.75rem 1rem;
  text-align: left;
  font-size: 0.8125rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--ast-heading);
  border-bottom: 1px solid var(--ast-border);
}
.calls td {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--ast-border);
  vertical-align: middle;
}
.calls tbody tr:last-child td {
  border-bottom: 0;
}
.calls tbody tr:hover {
  background: rgba(var(--ast-primary-rgb), 0.04);
}
.calls .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.parties {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.parties.extra {
  margin-top: 0.25rem;
  font-size: 0.8125rem;
  color: var(--ast-text-muted);
}
.party {
  display: inline-flex;
  flex-direction: column;
  line-height: 1.2;
}
.party-actions {
  display: inline-flex;
  gap: 0.25rem;
  margin-top: 0.3rem;
}
.icon-btn {
  display: inline-grid;
  place-items: center;
  width: 1.75rem;
  height: 1.75rem;
  border: 0;
  border-radius: var(--ast-radius);
  background: rgba(var(--ast-primary-rgb), 0.12);
  color: var(--ast-primary);
  cursor: pointer;
}
.icon-btn:hover {
  background: var(--ast-primary);
  color: #fff;
}
.icon-btn.danger {
  background: rgba(var(--ast-danger-rgb), 0.12);
  color: var(--ast-danger);
}
.icon-btn.danger:hover {
  background: var(--ast-danger);
  color: #fff;
}
.party strong {
  color: var(--ast-heading);
  font-weight: 500;
}
.party small {
  color: var(--ast-text-muted);
  font-size: 0.75rem;
}
.link {
  color: var(--ast-text-muted);
  flex-shrink: 0;
}
.via-queue {
  margin-top: 0.25rem;
  font-size: 0.75rem;
  color: var(--ast-text-muted);
}
.rec {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  margin-left: 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--ast-danger);
}
</style>
