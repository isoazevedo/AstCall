<script setup lang="ts">
/**
 * Sino dos alertas de desconexão (cabeçalho do painel): mostra quantos estão em alerta e
 * abre as configurações — ligar/desligar, som, notificação do navegador, repetição,
 * tolerância e quais ramais/troncos vigiar.
 *
 * Conceitos de Vue usados aqui:
 * - a prop `alerts` é o objeto devolvido pelo composable useDisconnectAlerts: os `ref`
 *   dentro dele continuam reativos, então `alerts.prefs.value.sound = true` já salva e
 *   reflete na tela;
 * - `v-model` em checkbox, select e radio liga o campo direto à preferência.
 */
import { computed, ref } from 'vue';
import { Bell, BellOff, Volume2 } from 'lucide-vue-next';
import type { DisconnectAlerts } from '../composables/useDisconnectAlerts';
import { useMonitorStore } from '../stores/monitor';

const props = defineProps<{ alerts: DisconnectAlerts }>();
const store = useMonitorStore();

const open = ref(false);
const search = ref('');
const notifyDenied = ref(false);

const prefs = computed(() => props.alerts.prefs.value);
const count = computed(() => props.alerts.alerting.value.length);

const repeatOptions = [
  { value: 0, label: 'Não repetir' },
  { value: 1, label: 'A cada 1 minuto' },
  { value: 2, label: 'A cada 2 minutos' },
  { value: 5, label: 'A cada 5 minutos' },
  { value: 10, label: 'A cada 10 minutos' },
  { value: 15, label: 'A cada 15 minutos' },
];
const graceOptions = [
  { value: 0, label: 'Avisar na hora' },
  { value: 15, label: '15 segundos' },
  { value: 30, label: '30 segundos' },
  { value: 60, label: '1 minuto' },
  { value: 120, label: '2 minutos' },
];

/** "Todos" ou uma lista escolhida. */
const watchMode = computed({
  get: () => (prefs.value.watch === null ? 'all' : 'some'),
  set: (mode: string) => {
    prefs.value.watch = mode === 'all' ? null : store.endpoints.map((e) => e.id);
  },
});

/** Endpoints para escolher (troncos primeiro), filtrados pela busca. */
const choices = computed(() => {
  const term = search.value.trim().toLowerCase();
  return [...store.endpoints]
    .filter((e) => !term || e.id.toLowerCase().includes(term))
    .sort((a, b) => Number(b.trunk) - Number(a.trunk));
});

function toggleWatch(id: string, on: boolean): void {
  const list = new Set(prefs.value.watch ?? []);
  if (on) list.add(id);
  else list.delete(id);
  prefs.value.watch = [...list];
}

async function onNotifyChange(e: Event): Promise<void> {
  const checked = (e.target as HTMLInputElement).checked;
  notifyDenied.value = false;
  if (!checked) {
    prefs.value.notify = false;
    return;
  }
  const ok = await props.alerts.enableNotifications();
  notifyDenied.value = !ok;
}
</script>

<template>
  <button
    type="button"
    class="bell"
    :class="{ on: prefs.enabled, alerting: prefs.enabled && count > 0 }"
    :title="prefs.enabled ? 'Alertas de desconexão ligados' : 'Alertas de desconexão desligados'"
    :aria-label="`Alertas de desconexão${count ? `: ${count} em alerta` : ''}`"
    @click="open = true"
  >
    <Bell v-if="prefs.enabled" :size="16" aria-hidden="true" />
    <BellOff v-else :size="16" aria-hidden="true" />
    <span v-if="prefs.enabled && count > 0" class="bell-count">{{ count }}</span>
  </button>

  <div v-if="open" class="dlg-backdrop" @click.self="open = false">
    <form
      class="dlg ast-card alerts-dlg"
      role="dialog"
      aria-modal="true"
      aria-label="Alertas de desconexão"
      @submit.prevent="open = false"
      @keydown.esc="open = false"
    >
      <h5 class="ast-card-title"><Bell :size="18" aria-hidden="true" /> Alertas de desconexão</h5>
      <p class="hint">
        Avisa quando um ramal ou tronco que estava online fica fora do ar. As configurações valem
        para este navegador.
      </p>

      <label class="check strong">
        <input v-model="prefs.enabled" type="checkbox" />
        Ativar alertas de desconexão
      </label>

      <fieldset :disabled="!prefs.enabled" class="alerts-opts">
        <div class="row">
          <label class="check">
            <input v-model="prefs.sound" type="checkbox" />
            Tocar som
          </label>
          <button type="button" class="link" @click="alerts.testSound()">
            <Volume2 :size="14" aria-hidden="true" /> testar
          </button>
        </div>
        <label class="check">
          <input type="checkbox" :checked="prefs.notify" @change="onNotifyChange" />
          Notificação do navegador (aparece mesmo com a aba em segundo plano)
        </label>
        <p v-if="notifyDenied" class="warn">
          O navegador bloqueou as notificações deste site. Libere nas configurações do navegador
          (ícone de cadeado ao lado do endereço).
        </p>

        <label class="field">
          <span>Enquanto continuar fora do ar</span>
          <select v-model.number="prefs.repeatMin" class="ast-input">
            <option v-for="o in repeatOptions" :key="o.value" :value="o.value">
              {{ o.label }}
            </option>
          </select>
        </label>
        <label class="field">
          <span>Tolerância (quedas mais curtas não avisam)</span>
          <select v-model.number="prefs.graceSec" class="ast-input">
            <option v-for="o in graceOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </label>

        <div class="field">
          <span>Vigiar</span>
          <label class="check">
            <input v-model="watchMode" type="radio" value="all" /> Todos os ramais e troncos
          </label>
          <label class="check">
            <input v-model="watchMode" type="radio" value="some" /> Só os escolhidos
            <small v-if="prefs.watch">({{ prefs.watch.length }})</small>
          </label>
        </div>
        <div v-if="prefs.watch" class="watch-list">
          <input
            v-model="search"
            class="ast-input"
            type="search"
            placeholder="Buscar ramal ou tronco…"
            aria-label="Buscar ramal ou tronco"
          />
          <ul>
            <li v-for="e in choices" :key="e.id">
              <label class="check">
                <input
                  type="checkbox"
                  :checked="prefs.watch.includes(e.id)"
                  @change="toggleWatch(e.id, ($event.target as HTMLInputElement).checked)"
                />
                {{ e.id }}
                <span v-if="e.trunk" class="ast-badge tone-danger tag">tronco</span>
              </label>
            </li>
          </ul>
        </div>
      </fieldset>

      <div class="dlg-actions">
        <button type="submit" class="btn btn-primary">Fechar</button>
      </div>
    </form>
  </div>
</template>

<style>
.bell {
  position: relative;
  display: inline-grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border: 0;
  border-radius: var(--ast-radius);
  background: rgba(var(--ast-secondary-rgb), 0.16);
  color: var(--ast-secondary);
  cursor: pointer;
}
.bell.on {
  background: rgba(var(--ast-primary-rgb), 0.16);
  color: var(--ast-primary);
}
.bell.alerting {
  background: rgba(var(--ast-danger-rgb), 0.16);
  color: var(--ast-danger);
}
.bell-count {
  position: absolute;
  top: -0.35rem;
  right: -0.35rem;
  min-width: 1.1rem;
  padding: 0 0.25rem;
  border-radius: 1rem;
  background: var(--ast-danger);
  color: #fff;
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1.1rem;
  text-align: center;
}
.alerts-dlg {
  max-width: 30rem;
  max-height: calc(100vh - 2rem);
  overflow: auto;
}
.alerts-dlg .hint {
  font-size: 0.875rem;
  color: var(--ast-text-muted);
}
.alerts-dlg .check.strong {
  font-weight: 600;
  color: var(--ast-heading);
}
.alerts-opts {
  margin: 0;
  padding: 0;
  border: 0;
  display: grid;
  gap: 0.75rem;
}
.alerts-opts:disabled {
  opacity: 0.5;
}
.alerts-opts .row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.alerts-dlg .link {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--ast-primary);
  cursor: pointer;
}
.alerts-dlg .warn {
  font-size: 0.8125rem;
  color: var(--ast-warning);
}
.watch-list {
  display: grid;
  gap: 0.5rem;
}
.watch-list ul {
  list-style: none;
  margin: 0;
  padding: 0.25rem 0.5rem;
  max-height: 12rem;
  overflow: auto;
  border: 1px solid var(--ast-border);
  border-radius: var(--ast-radius);
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
}
.watch-list .tag {
  font-size: 0.6875rem;
  padding: 0.1rem 0.35rem;
}
</style>
