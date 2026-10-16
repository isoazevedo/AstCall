<script setup lang="ts">
/**
 * Diálogo único para as ações (desligar, transferir, ligar, pausar/retomar).
 * Abre quando o store recebe `openDialog(...)` e fecha com `closeDialog()`.
 *
 * Conceitos: `watch` reinicia os campos sempre que um diálogo novo abre; `computed`
 * decide título e texto do botão conforme o tipo; `@keydown.esc` fecha pelo teclado.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { DIAL_TARGET } from '@astcall/shared';
import { useMonitorStore } from '../stores/monitor';

const store = useMonitorStore();

const number = ref('');
const reason = ref('');
const allQueues = ref(false);
const busy = ref(false);
const error = ref('');
const firstInput = ref<HTMLInputElement | null>(null);

watch(
  () => store.dialog,
  async (d) => {
    number.value = '';
    reason.value = '';
    allQueues.value = false;
    error.value = '';
    busy.value = false;
    if (d) {
      await nextTick();
      firstInput.value?.focus();
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

const needsNumber = computed(
  () => store.dialog?.kind === 'transfer' || store.dialog?.kind === 'originate',
);
const numberValid = computed(() => DIAL_TARGET.test(number.value.trim()));

async function submit(): Promise<void> {
  const d = store.dialog;
  if (!d || busy.value) return;
  if (needsNumber.value && !numberValid.value) {
    error.value = 'Informe um número (dígitos, *, # ou +).';
    return;
  }
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
  <div v-if="store.dialog && view" class="dlg-backdrop" @click.self="store.closeDialog()">
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
        placeholder="Número ou ramal (ex.: 9005)"
        aria-label="Número de destino"
        :disabled="busy"
      />

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
          :disabled="busy || (needsNumber && !numberValid)"
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
.check {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  cursor: pointer;
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
