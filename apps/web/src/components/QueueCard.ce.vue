<script setup lang="ts">
/**
 * Card de uma fila: números, chamadores aguardando (tempo ao vivo com alerta) e membros.
 *
 * Conceito: funções declaradas no <script setup> podem ser usadas direto no template —
 * aqui `wait()` e `ago()` usam o relógio compartilhado `now` (composable useNow), então o
 * Vue redesenha só esses textos a cada segundo.
 */
import {
  Clock,
  Pause,
  PauseCircle,
  Play,
  SlidersHorizontal,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-vue-next';
import ActionMenu, { type MenuItem } from './ActionMenu.ce.vue';
import { useNow } from '../composables/useNow';
import { formatDuration, strategyLabel, waitTone, type QueueView } from '../lib/view';
import { useMonitorStore } from '../stores/monitor';

const props = defineProps<{ queue: QueueView }>();
const store = useMonitorStore();

function togglePause(m: Member): void {
  store.openDialog({
    kind: 'pause',
    queue: props.queue.name,
    interface: m.interface,
    label: m.label,
    pause: !m.paused,
  });
}

type Member = QueueView['members'][number];

function addMember(): void {
  store.openDialog({
    kind: 'queueAdd',
    queue: props.queue.name,
    members: props.queue.members.map((m) => m.endpointId).filter((e): e is string => !!e),
  });
}

function editPenalty(m: Member): void {
  store.openDialog({
    kind: 'penalty',
    queue: props.queue.name,
    interface: m.interface,
    label: m.label,
    penalty: m.penalty,
    dynamic: m.dynamic,
  });
}

function removeMember(m: Member): void {
  store.openDialog({
    kind: 'queueRemove',
    queue: props.queue.name,
    interface: m.interface,
    label: m.label,
  });
}

/**
 * Ações do membro no menu "⋮", conforme as permissões. Membro fixo aparece com "Remover"
 * desabilitado e a explicação — fica claro por que não dá para remover pelo painel.
 */
function memberActions(m: Member): MenuItem[] {
  const items: MenuItem[] = [];
  if (store.can('queue') && m.rank !== 3) {
    items.push({
      label: m.paused ? 'Retomar' : 'Pausar',
      icon: m.paused ? Play : Pause,
      run: () => togglePause(m),
    });
  }
  if (store.can('queue_manage')) {
    items.push({
      label: 'Alterar penalidade',
      hint: `atual: ${m.penalty}`,
      icon: SlidersHorizontal,
      run: () => editPenalty(m),
    });
    items.push({
      label: 'Remover da fila',
      icon: UserMinus,
      tone: 'danger',
      disabled: !m.dynamic,
      hint: m.dynamic ? undefined : 'membro fixo: remova pelo cadastro de filas',
      run: () => removeMember(m),
    });
  }
  return items;
}

const now = useNow();

const seconds = (since: number) => Math.max(0, (now.value - since) / 1000);
const wait = (since: number) => formatDuration(seconds(since));

/** "há 5 min", "há 2 h" — para última chamada e início da pausa. */
function ago(since: number | null): string {
  if (!since) return '—';
  const s = seconds(since);
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return `há ${Math.floor(s / 86400)} d`;
}
</script>

<template>
  <article class="ast-card queue">
    <header class="ast-card-header">
      <h5 class="ast-card-title"><Users :size="18" aria-hidden="true" /> {{ queue.name }}</h5>
      <div class="q-header-actions">
        <span class="ast-badge tone-secondary">{{ strategyLabel(queue.strategy) }}</span>
        <button
          v-if="store.can('queue_manage')"
          type="button"
          class="m-btn add"
          title="Adicionar um ramal a esta fila"
          @click="addMember"
        >
          <UserPlus :size="14" aria-hidden="true" /> Adicionar
        </button>
      </div>
    </header>

    <div class="ast-card-body">
      <dl class="q-stats">
        <div>
          <dt>Aguardando</dt>
          <dd :class="{ 'tone-text-warning': queue.waiting.length > 0 }">
            {{ queue.waiting.length }}
          </dd>
        </div>
        <div>
          <dt>Atendidas</dt>
          <dd class="tone-text-success">{{ queue.completed }}</dd>
        </div>
        <div>
          <dt>Abandonadas</dt>
          <dd :class="{ 'tone-text-danger': queue.abandoned > 0 }">{{ queue.abandoned }}</dd>
        </div>
        <div>
          <dt>Espera média</dt>
          <dd>{{ formatDuration(queue.holdtime) }}</dd>
        </div>
        <div>
          <dt>Conversa média</dt>
          <dd>{{ formatDuration(queue.talktime) }}</dd>
        </div>
        <div v-if="queue.serviceLevel > 0">
          <dt>Nível de serviço ({{ queue.serviceLevel }}s)</dt>
          <dd>{{ queue.serviceLevelPerf.toFixed(0) }}%</dd>
        </div>
      </dl>

      <!-- Chamadores aguardando -->
      <section v-if="queue.waiting.length > 0" class="q-section">
        <h6><Clock :size="14" aria-hidden="true" /> Aguardando atendimento</h6>
        <ol class="waiting">
          <li v-for="e in queue.waiting" :key="e.id">
            <span class="pos">{{ e.position }}º</span>
            <span class="who">
              <strong>{{ e.callerId.num || 'Desconhecido' }}</strong>
              <small v-if="e.callerId.name && e.callerId.name !== e.callerId.num">
                {{ e.callerId.name }}
              </small>
            </span>
            <span class="ast-badge wait" :class="`tone-${waitTone(seconds(e.joinedAt))}`">
              {{ wait(e.joinedAt) }}
            </span>
          </li>
        </ol>
      </section>

      <!-- Membros -->
      <section class="q-section">
        <h6>
          Membros
          <small>
            {{ queue.available }} disponíve{{ queue.available === 1 ? 'l' : 'is' }} ·
            {{ queue.busy }} em atendimento · {{ queue.paused }} em pausa
          </small>
        </h6>
        <p v-if="queue.members.length === 0" class="ast-empty compact">Fila sem membros.</p>
        <ul v-else class="members">
          <li v-for="m in queue.members" :key="m.id" :class="{ dim: m.rank === 3 }">
            <span class="m-name" :title="m.interface">{{ m.label }}</span>
            <span
              v-if="m.dynamic"
              class="ast-badge tone-info m-kind"
              title="Membro dinâmico: adicionado pelo painel ou por login de agente (fora do cadastro)"
            >
              dinâmico
            </span>
            <span class="ast-badge" :class="`tone-${m.tone}`">
              <PauseCircle v-if="m.paused" :size="12" aria-hidden="true" />
              {{ m.stateLabel }}
            </span>
            <span class="m-info">
              <template v-if="m.paused">
                {{ m.pausedReason || 'sem motivo' }} · {{ ago(m.pausedSince) }}
              </template>
              <template v-else>
                {{ m.callsTaken }} atendida{{ m.callsTaken === 1 ? '' : 's' }} · última
                {{ ago(m.lastCall) }}
              </template>
              <template v-if="m.penalty > 0"> · penalidade {{ m.penalty }}</template>
            </span>
            <ActionMenu
              v-if="memberActions(m).length"
              :items="memberActions(m)"
              :label="`Ações de ${m.label}`"
            />
          </li>
        </ul>
      </section>
    </div>
  </article>
</template>

<style>
.queue .ast-card-body {
  display: grid;
  gap: 1.25rem;
}
.q-stats {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 0.75rem;
}
.q-stats div {
  padding: 0.6rem 0.75rem;
  border-radius: var(--ast-radius);
  background: rgba(var(--ast-secondary-rgb), 0.08);
}
.q-stats dt {
  font-size: 0.75rem;
  color: var(--ast-text-muted);
}
.q-stats dd {
  margin: 0.15rem 0 0;
  font-family: var(--ast-font-heading);
  font-size: 1.25rem;
  font-weight: 500;
  color: var(--ast-heading);
  font-variant-numeric: tabular-nums;
}
.tone-text-danger {
  color: var(--ast-danger) !important;
}
.q-section h6 {
  margin: 0 0 0.6rem;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  font-family: var(--ast-font-heading);
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--ast-heading);
}
.q-section h6 small {
  font-family: var(--ast-font);
  font-weight: 400;
  color: var(--ast-text-muted);
}
.waiting,
.members {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.4rem;
}
.waiting li,
.members li {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--ast-border);
  border-radius: var(--ast-radius);
}
.waiting .pos {
  min-width: 1.75rem;
  font-weight: 600;
  color: var(--ast-text-muted);
}
.waiting .who {
  flex: 1;
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}
.waiting .who strong,
.m-name {
  font-weight: 500;
  color: var(--ast-heading);
}
.waiting .who small {
  font-size: 0.75rem;
  color: var(--ast-text-muted);
}
.wait {
  font-variant-numeric: tabular-nums;
}
.m-name {
  min-width: 4.5rem;
}
.q-header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.m-kind {
  font-size: 0.6875rem;
  padding: 0.15rem 0.4rem;
}
/* Botão "Adicionar" do cabeçalho */
.m-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.2rem 0.5rem;
  font: inherit;
  font-size: 0.75rem;
  font-weight: 500;
  border: 0;
  border-radius: var(--ast-radius);
  background: rgba(var(--ast-secondary-rgb), 0.16);
  color: var(--ast-secondary);
  cursor: pointer;
  font-variant-numeric: tabular-nums;
}
.m-btn.add {
  padding: 0.3rem 0.6rem;
  background: rgba(var(--ast-primary-rgb), 0.16);
  color: var(--ast-primary);
}
/* A informação encolhe e quebra em duas linhas se precisar; nome, estado e menu ficam inteiros */
.m-info {
  flex: 1 1 0;
  min-width: 5rem;
  margin-left: auto;
  font-size: 0.75rem;
  color: var(--ast-text-muted);
  text-align: right;
}
.members li.dim {
  opacity: 0.6;
}
.ast-empty.compact {
  padding: 0.5rem 0;
  text-align: left;
}
</style>
