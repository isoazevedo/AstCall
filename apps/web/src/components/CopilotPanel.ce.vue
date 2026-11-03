<script setup lang="ts">
/**
 * Card "Sugestões" (copiloto do supervisor): a partir da previsão das filas, sugere retomar
 * atendentes pausados, adicionar ramais livres a uma fila em risco e avisa pausas longas.
 * Nada é executado sozinho: o botão abre o mesmo diálogo de confirmação das outras ações.
 *
 * Conceitos: `ref(new Map())` deixa o Map reativo (o Vue percebe `set`), e `computed`
 * recalcula as sugestões quando as filas, os ramais, o relógio ou as preferências mudam.
 * As regras ficam em lib/copilot.ts, testadas sem navegador.
 */
import { computed, ref } from 'vue';
import { CircleAlert, Info, Lightbulb, Settings2, TriangleAlert, X } from 'lucide-vue-next';
import {
  DISMISS_MS,
  loadCopilotPrefs,
  saveCopilotPrefs,
  suggestions,
  type Suggestion,
} from '../lib/copilot';
import { useNow } from '../composables/useNow';
import { useWidget } from '../composables/useWidget';
import { useMonitorStore } from '../stores/monitor';

const store = useMonitorStore();
const { can, open } = useWidget();
const now = useNow();

const prefs = ref(loadCopilotPrefs());
/** Sugestões dispensadas: id → até quando ficam escondidas (só nesta aba do navegador). */
const dismissed = ref(new Map<string, number>());
const showSettings = ref(false);

const list = computed(() =>
  suggestions({
    queues: store.queues,
    endpoints: store.endpoints,
    can: { queue: can('queue'), manage: can('queue_manage') },
    prefs: prefs.value,
    dismissed: dismissed.value,
    now: now.value,
  }),
);

const icons = { high: CircleAlert, warn: TriangleAlert, info: Info };

function run(s: Suggestion): void {
  const a = s.action;
  if (!a) return;
  if (a.kind === 'resume') {
    open({ kind: 'pause', queue: a.queue, interface: a.interface, label: a.label, pause: false });
  } else {
    open({ kind: 'queueAdd', queue: a.queue, members: a.members, preset: a.endpoint });
  }
}

function dismiss(s: Suggestion): void {
  dismissed.value.set(s.id, Date.now() + DISMISS_MS);
}

/** Campos das preferências: minutos e motivos separados por vírgula. */
const pauseMin = computed({
  get: () => prefs.value.longPauseMin,
  set: (v: number) => save({ longPauseMin: Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0 }),
});
const reasons = computed({
  get: () => prefs.value.ignoreReasons.join(', '),
  set: (v: string) =>
    save({
      ignoreReasons: v
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean),
    }),
});
function save(patch: Partial<typeof prefs.value>): void {
  prefs.value = { ...prefs.value, ...patch };
  saveCopilotPrefs(prefs.value);
}
</script>

<template>
  <section class="ast-card copilot" aria-live="polite">
    <header class="ast-card-header">
      <h5 class="ast-card-title">
        <Lightbulb :size="18" aria-hidden="true" /> Sugestões
        <span v-if="list.length" class="ast-badge tone-primary">{{ list.length }}</span>
      </h5>
      <button
        type="button"
        class="copilot-icon-btn"
        :aria-expanded="showSettings"
        title="Configurar sugestões"
        @click="showSettings = !showSettings"
      >
        <Settings2 :size="16" aria-hidden="true" />
        <span class="sr-only">Configurar sugestões</span>
      </button>
    </header>
    <div class="ast-card-body">
      <form v-if="showSettings" class="copilot-settings" @submit.prevent="showSettings = false">
        <label>
          Avisar pausas a partir de (min, 0 = não avisar)
          <input v-model.lazy.number="pauseMin" type="number" min="0" class="ast-input" />
        </label>
        <label>
          Motivos de pausa que não geram aviso (separados por vírgula)
          <input
            v-model.lazy="reasons"
            type="text"
            class="ast-input"
            placeholder="Ex.: Treinamento, Reunião"
          />
        </label>
      </form>

      <p v-if="!list.length" class="copilot-empty">
        Tudo em ordem: nenhuma sugestão agora. As sugestões aparecem quando uma fila corre risco de
        ficar abaixo da meta ou quando alguém está em pausa há muito tempo.
      </p>
      <ul v-else class="copilot-list">
        <li v-for="s in list" :key="s.id" :class="`sev-${s.severity}`">
          <component :is="icons[s.severity]" :size="18" aria-hidden="true" class="copilot-icon" />
          <div class="copilot-text">
            <strong>{{ s.title }}</strong>
            <span>{{ s.detail }}</span>
          </div>
          <div class="copilot-actions">
            <button v-if="s.action" type="button" class="copilot-btn" @click="run(s)">
              {{ s.actionLabel }}
            </button>
            <button
              type="button"
              class="copilot-icon-btn"
              title="Dispensar por 10 minutos"
              @click="dismiss(s)"
            >
              <X :size="16" aria-hidden="true" />
              <span class="sr-only">Dispensar por 10 minutos</span>
            </button>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>

<style>
.copilot {
  border-left: 0.35rem solid var(--ast-primary);
}
.copilot .ast-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.copilot .ast-card-body {
  padding-top: 1rem;
  display: grid;
  gap: 0.75rem;
}
.copilot-settings {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  gap: 0.75rem;
  padding: 0.75rem;
  border: 1px dashed var(--ast-border);
  border-radius: var(--ast-radius);
}
.copilot-settings label {
  display: grid;
  gap: 0.3rem;
  font-size: 0.8125rem;
  color: var(--ast-text-muted);
}
.copilot-empty {
  margin: 0;
  font-size: 0.875rem;
  color: var(--ast-text-muted);
}
.copilot-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.4rem;
}
.copilot-list li {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.55rem 0.85rem;
  border: 1px solid var(--ast-border);
  border-radius: var(--ast-radius);
}
.copilot-list li.sev-high {
  background: rgba(var(--ast-danger-rgb), 0.06);
  border-color: rgba(var(--ast-danger-rgb), 0.35);
}
.copilot-list li.sev-high .copilot-icon {
  color: var(--ast-danger);
}
.copilot-list li.sev-warn .copilot-icon {
  color: var(--ast-warning);
}
.copilot-list li.sev-info .copilot-icon {
  color: var(--ast-info, var(--ast-primary));
}
.copilot-icon {
  flex-shrink: 0;
}
.copilot-text {
  display: grid;
  gap: 0.1rem;
  min-width: 0;
}
.copilot-text strong {
  font-weight: 500;
  color: var(--ast-heading);
}
.copilot-text span {
  font-size: 0.8125rem;
  color: var(--ast-text-muted);
}
.copilot-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex-shrink: 0;
}
.copilot-btn {
  padding: 0.3rem 0.8rem;
  border: 1px solid var(--ast-primary);
  border-radius: var(--ast-radius);
  background: var(--ast-primary);
  color: #fff;
  font: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
}
.copilot-btn:hover {
  filter: brightness(1.08);
}
.copilot-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 0;
  border-radius: var(--ast-radius);
  background: none;
  color: var(--ast-text-muted);
  cursor: pointer;
}
.copilot-icon-btn:hover {
  background: rgba(var(--ast-secondary-rgb), 0.12);
  color: var(--ast-heading);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
@media (max-width: 576px) {
  .copilot-list li {
    flex-wrap: wrap;
  }
}
</style>
