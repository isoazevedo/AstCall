<script setup lang="ts">
/**
 * Lista de chamadas em andamento.
 *
 * Conceitos: `v-for` repete um trecho para cada item; o `:key` identifica cada linha para
 * o Vue atualizar só o que mudou (sem recriar a lista inteira a cada delta).
 *
 * As ações (escutar, transferir, desligar) são de cada participante e ficam no menu "⋮"
 * ao lado do número; só aparecem as que o usuário pode usar naquela situação.
 */
import {
  ArrowLeftRight,
  CircleDot,
  Ear,
  Headphones,
  PhoneCall,
  PhoneForwarded,
  PhoneOff,
} from 'lucide-vue-next';
import { useNow } from '../composables/useNow';
import ActionMenu, { type MenuItem } from './ActionMenu.ce.vue';
import { formatDuration, type CallView, type Party } from '../lib/view';
import { useMonitorStore } from '../stores/monitor';

defineProps<{ calls: CallView[]; loading: boolean }>();

const store = useMonitorStore();
const partyLabel = (p: Party) => (p.name ? `${p.num} (${p.name})` : p.num);

/** Opções do menu de um participante, conforme permissões e situação da chamada. */
function partyActions(call: CallView, p: Party): MenuItem[] {
  const target = { uniqueid: p.uniqueid, label: partyLabel(p) };
  const items: MenuItem[] = [];
  if (
    store.can('spy') &&
    !call.spyTarget &&
    (call.status === 'talking' || call.status === 'held')
  ) {
    items.push({
      label: `Escutar ${p.num}`,
      hint: 'ouvir, sussurrar ou intervir',
      icon: Headphones,
      run: () => store.openDialog({ kind: 'spy', ...target }),
    });
  }
  if (store.can('transfer') && call.status === 'talking') {
    items.push({
      label: `Transferir ${p.num}`,
      icon: PhoneForwarded,
      run: () => store.openDialog({ kind: 'transfer', ...target }),
    });
  }
  if (store.can('hangup')) {
    items.push({
      label: `Desligar ${p.num}`,
      icon: PhoneOff,
      tone: 'danger',
      run: () => store.openDialog({ kind: 'hangup', ...target }),
    });
  }
  return items;
}

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
                    <span class="party-id">
                      <strong>{{ p.num }}</strong>
                      <small v-if="p.name">{{ p.name }}</small>
                    </span>
                    <ActionMenu
                      v-if="partyActions(call, p).length"
                      :items="partyActions(call, p)"
                      :label="`Ações de ${p.num}`"
                    />
                  </span>
                </template>
              </div>
              <div v-if="call.spyTarget" class="spy-target">
                <Ear :size="14" aria-hidden="true" /> escutando
                <strong>{{ call.spyTarget.num }}</strong>
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
              <span v-if="call.monitored" class="spied" title="Um supervisor está escutando">
                <Headphones :size="13" aria-hidden="true" /> Em escuta
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
  align-items: center;
  gap: 0.15rem;
}
.party-id {
  display: inline-flex;
  flex-direction: column;
  line-height: 1.2;
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
.spy-target {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  margin-top: 0.3rem;
  font-size: 0.8125rem;
  color: var(--ast-info);
}
.spy-target strong {
  color: var(--ast-heading);
}
.spied {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  margin-left: 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--ast-info);
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
