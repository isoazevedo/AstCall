<script setup lang="ts">
/**
 * Diálogo único para as ações (desligar, transferir, ligar, pausar/retomar, escutar e
 * gestão de membros de fila: adicionar, remover, penalidade).
 * Abre quando o store recebe `openDialog(...)` e fecha com `closeDialog()`.
 *
 * Conceitos: `watch` reinicia os campos sempre que um diálogo novo abre; `computed`
 * decide título e texto do botão conforme o tipo; `@keydown.esc` fecha pelo teclado.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { DIAL_TARGET, PENALTY_MAX, type SpyMode } from '@astcall/shared';
import { useWidget } from '../composables/useWidget';
import { useMonitorStore } from '../stores/monitor';

const store = useMonitorStore();
/** Com vários elementos na página, só o elemento de onde a ação partiu desenha o diálogo. */
const { owner } = useWidget();

const number = ref('');
const reason = ref('');
const allQueues = ref(false);
const spyMode = ref<SpyMode>('listen');
/** Gestão de membros: ramal escolhido, penalidade e "já entrar pausado". */
const endpoint = ref('');
const penalty = ref(0);
const startPaused = ref(false);

/** Último ramal usado para escutar, lembrado neste navegador (só uma sugestão editável). */
const LISTENER_KEY = 'astcall.spyListener';
function lastListener(): string {
  try {
    return localStorage.getItem(LISTENER_KEY) ?? '';
  } catch {
    return '';
  }
}
function rememberListener(v: string): void {
  try {
    localStorage.setItem(LISTENER_KEY, v);
  } catch {
    // navegador sem armazenamento: só não lembra
  }
}

const spyModes: { value: SpyMode; label: string; hint: string }[] = [
  { value: 'listen', label: 'Ouvir', hint: 'escuta em silêncio' },
  { value: 'whisper', label: 'Sussurrar', hint: 'fala só com o ramal monitorado' },
  { value: 'barge', label: 'Intervir', hint: 'fala com os dois lados' },
];
const busy = ref(false);
const error = ref('');
const firstInput = ref<HTMLInputElement | null>(null);

watch(
  () => store.dialog,
  async (d) => {
    // Escuta: último ramal usado neste navegador; senão, o ramal do usuário (vem do token)
    number.value = d?.kind === 'spy' ? lastListener() || store.user?.extension || '' : '';
    reason.value = '';
    allQueues.value = false;
    spyMode.value = 'listen';
    endpoint.value = '';
    penalty.value = d?.kind === 'penalty' ? d.penalty : 0;
    startPaused.value = false;
    error.value = '';
    busy.value = false;
    if (d) {
      await nextTick();
      firstInput.value?.focus();
      firstInput.value?.select();
    }
  },
);

const view = computed(() => {
  const d = store.dialog;
  if (!d) return null;
  switch (d.kind) {
    case 'hangup':
      return { title: 'Desligar', confirm: 'Desligar', danger: true, text: `Desligar ${d.label}?` };
    case 'transfer':
      return {
        title: 'Transferir',
        confirm: 'Transferir',
        danger: false,
        text: `Transferir ${d.label} para:`,
      };
    case 'originate':
      return {
        title: 'Ligar',
        confirm: 'Ligar',
        danger: false,
        text: `O ramal ${d.from} vai tocar; ao atender, a ligação segue para:`,
      };
    case 'spy':
      return {
        title: 'Escutar',
        confirm: 'Escutar',
        danger: false,
        text: `Escutar ${d.label}. Informe o ramal que vai tocar para quem vai ouvir (pode ser outro ramal, como o de um diretor):`,
      };
    case 'queueAdd':
      return {
        title: 'Adicionar membro',
        confirm: 'Adicionar',
        danger: false,
        text: `Adicionar um ramal à fila ${d.queue}. Ele entra como membro dinâmico: fica na fila (mesmo após reiniciar o Asterisk) até ser removido, mas não aparece no cadastro de filas.`,
      };
    case 'queueRemove':
      return {
        title: 'Remover membro',
        confirm: 'Remover',
        danger: true,
        text: `Remover ${d.label} da fila ${d.queue}?`,
      };
    case 'penalty':
      return {
        title: 'Penalidade',
        confirm: 'Salvar',
        danger: false,
        text: d.dynamic
          ? `Penalidade de ${d.label} na fila ${d.queue} (0 = recebe primeiro; quanto maior, mais tarde recebe).`
          : `Penalidade de ${d.label} na fila ${d.queue} (0 = recebe primeiro). Membro fixo: volta ao valor do cadastro quando as filas forem recarregadas.`,
      };
    case 'pause':
      return d.pause
        ? {
            title: 'Pausar',
            confirm: 'Pausar',
            danger: false,
            text: `Pausar ${d.label} na fila ${d.queue}.`,
          }
        : {
            title: 'Retomar',
            confirm: 'Retomar',
            danger: false,
            text: `Retomar ${d.label} na fila ${d.queue}.`,
          };
  }
  return null;
});

/** Ramais que podem entrar na fila: os visíveis que ainda não são membros dela. */
const candidates = computed(() => {
  const d = store.dialog;
  if (d?.kind !== 'queueAdd') return [];
  const taken = new Set(d.members);
  return store.endpoints.filter((e) => !taken.has(e.id));
});

const penaltyValid = computed(
  () => Number.isInteger(penalty.value) && penalty.value >= 0 && penalty.value <= PENALTY_MAX,
);

/** O botão de confirmar fica desligado enquanto falta algo obrigatório. */
const incomplete = computed(() => {
  const kind = store.dialog?.kind;
  if (needsNumber.value) return !numberValid.value;
  if (kind === 'queueAdd') return !endpoint.value || !penaltyValid.value;
  if (kind === 'penalty') return !penaltyValid.value;
  return false;
});

const needsNumber = computed(
  () =>
    store.dialog?.kind === 'transfer' ||
    store.dialog?.kind === 'originate' ||
    store.dialog?.kind === 'spy',
);
const numberValid = computed(() => DIAL_TARGET.test(number.value.trim()));

async function submit(): Promise<void> {
  const d = store.dialog;
  if (!d || busy.value) return;
  if (needsNumber.value && !numberValid.value) {
    error.value = 'Informe um número (dígitos, *, # ou +).';
    return;
  }
  if (incomplete.value) return;
  busy.value = true;
  error.value = '';
  const to = number.value.trim();
  let result;
  switch (d.kind) {
    case 'hangup':
      result = await store.act('hangup', { uniqueid: d.uniqueid }, `${d.label} desligado`);
      break;
    case 'transfer':
      result = await store.act(
        'transfer',
        { uniqueid: d.uniqueid, to },
        `${d.label} transferido para ${to}`,
      );
      break;
    case 'originate':
      result = await store.act(
        'originate',
        { from: d.from, to },
        `Ramal ${d.from} tocando para ligar a ${to}`,
      );
      break;
    case 'spy': {
      const mode = spyModes.find((m) => m.value === spyMode.value)!;
      result = await store.act(
        'spy',
        { uniqueid: d.uniqueid, listener: to, mode: spyMode.value },
        `Ramal ${to} vai tocar para ${mode.label.toLowerCase()} ${d.label}`,
      );
      if (result.ok) rememberListener(to);
      break;
    }
    case 'queueAdd':
      result = await store.act(
        'queueAdd',
        {
          queue: d.queue,
          endpoint: endpoint.value,
          penalty: penalty.value,
          paused: startPaused.value,
        },
        `Ramal ${endpoint.value} adicionado à fila ${d.queue}`,
      );
      break;
    case 'queueRemove':
      result = await store.act(
        'queueRemove',
        { queue: d.queue, interface: d.interface },
        `${d.label} removido da fila ${d.queue}`,
      );
      break;
    case 'penalty':
      result = await store.act(
        'queuePenalty',
        { queue: d.queue, interface: d.interface, penalty: penalty.value },
        `Penalidade de ${d.label} na fila ${d.queue}: ${penalty.value}`,
      );
      break;
    case 'pause': {
      const scope = allQueues.value ? 'em todas as filas' : `na fila ${d.queue}`;
      result = await store.act(
        'queuePause',
        {
          queue: allQueues.value ? null : d.queue,
          interface: d.interface,
          paused: d.pause,
          reason: d.pause ? reason.value.trim() || undefined : undefined,
        },
        `${d.label} ${d.pause ? 'pausado' : 'retomado'} ${scope}`,
      );
      break;
    }
  }
  busy.value = false;
  if (result.ok) store.closeDialog();
  else error.value = result.error ?? 'Não foi possível executar a ação.';
}
</script>

<template>
  <div
    v-if="store.dialog && store.dialog.owner === owner && view"
    class="dlg-backdrop"
    @click.self="store.closeDialog()"
  >
    <form
      class="dlg ast-card"
      role="dialog"
      aria-modal="true"
      :aria-label="view.title"
      @submit.prevent="submit"
      @keydown.esc="store.closeDialog()"
    >
      <h5 class="ast-card-title">{{ view.title }}</h5>
      <p>{{ view.text }}</p>

      <input
        v-if="needsNumber"
        ref="firstInput"
        v-model="number"
        class="ast-input"
        inputmode="tel"
        :placeholder="
          store.dialog.kind === 'spy'
            ? 'Ramal que vai ouvir (ex.: 9005)'
            : 'Número ou ramal (ex.: 9005)'
        "
        aria-label="Número de destino"
        :disabled="busy"
      />

      <fieldset v-if="store.dialog.kind === 'spy'" class="modes">
        <legend>Modo</legend>
        <label v-for="m in spyModes" :key="m.value" class="mode">
          <input v-model="spyMode" type="radio" name="spy-mode" :value="m.value" :disabled="busy" />
          <span>
            <strong>{{ m.label }}</strong> <small>{{ m.hint }}</small>
          </span>
        </label>
      </fieldset>

      <template v-if="store.dialog.kind === 'pause'">
        <input
          v-if="store.dialog.pause"
          ref="firstInput"
          v-model="reason"
          class="ast-input"
          maxlength="64"
          placeholder="Motivo (opcional)"
          aria-label="Motivo da pausa"
          :disabled="busy"
        />
        <label class="check">
          <input v-model="allQueues" type="checkbox" :disabled="busy" />
          Aplicar em todas as filas deste ramal
        </label>
      </template>

      <!-- Adicionar membro: ramal + penalidade + entrar pausado -->
      <template v-if="store.dialog.kind === 'queueAdd'">
        <p v-if="candidates.length === 0" class="dlg-hint">
          Todos os ramais visíveis já são membros desta fila.
        </p>
        <label v-else class="field">
          <span>Ramal</span>
          <select v-model="endpoint" class="ast-input" :disabled="busy">
            <option value="" disabled>Escolha o ramal</option>
            <option v-for="e in candidates" :key="e.id" :value="e.id">
              {{ e.id }} — {{ e.label }}
            </option>
          </select>
        </label>
      </template>

      <label
        v-if="store.dialog.kind === 'queueAdd' || store.dialog.kind === 'penalty'"
        class="field"
      >
        <span>Penalidade</span>
        <input
          ref="firstInput"
          v-model.number="penalty"
          type="number"
          min="0"
          :max="PENALTY_MAX"
          step="1"
          class="ast-input"
          :disabled="busy"
        />
      </label>

      <label v-if="store.dialog.kind === 'queueAdd'" class="check">
        <input v-model="startPaused" type="checkbox" :disabled="busy" />
        Entrar pausado
      </label>

      <p v-if="error" class="dlg-error" role="alert">{{ error }}</p>

      <div class="dlg-actions">
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="busy"
          @click="store.closeDialog()"
        >
          Cancelar
        </button>
        <button
          type="submit"
          class="btn"
          :class="view.danger ? 'btn-danger' : 'btn-primary'"
          :disabled="busy || incomplete"
        >
          {{ busy ? 'Aguarde…' : view.confirm }}
        </button>
      </div>
    </form>
  </div>
</template>

<style>
.dlg-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 1rem;
  background: rgba(38, 60, 85, 0.45);
}
.dlg {
  width: 100%;
  max-width: 26rem;
  padding: 1.5rem;
  display: grid;
  gap: 0.85rem;
}
.dlg p {
  margin: 0;
}
.dlg .ast-input {
  width: 100%;
}
.modes {
  margin: 0;
  padding: 0;
  border: 0;
  display: grid;
  gap: 0.35rem;
}
.modes legend {
  margin-bottom: 0.35rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--ast-heading);
}
.mode {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--ast-border);
  border-radius: var(--ast-radius);
  cursor: pointer;
}
.mode:has(input:checked) {
  border-color: var(--ast-primary);
  background: rgba(var(--ast-primary-rgb), 0.08);
}
.mode small {
  color: var(--ast-text-muted);
}
.check {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  cursor: pointer;
}
.field {
  display: grid;
  gap: 0.3rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--ast-heading);
}
.dlg-hint {
  font-size: 0.875rem;
  color: var(--ast-text-muted);
}
.dlg-error {
  padding: 0.5rem 0.75rem;
  border-radius: var(--ast-radius);
  background: rgba(var(--ast-danger-rgb), 0.16);
  color: var(--ast-danger);
}
.dlg-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
.btn {
  font: inherit;
  font-weight: 500;
  padding: 0.5rem 1rem;
  border: 0;
  border-radius: var(--ast-radius);
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.btn-primary {
  background: var(--ast-primary);
  color: #fff;
  box-shadow: 0 2px 4px rgba(var(--ast-primary-rgb), 0.4);
}
.btn-danger {
  background: var(--ast-danger);
  color: #fff;
  box-shadow: 0 2px 4px rgba(var(--ast-danger-rgb), 0.4);
}
.btn-secondary {
  background: rgba(var(--ast-secondary-rgb), 0.16);
  color: var(--ast-secondary);
}
</style>
