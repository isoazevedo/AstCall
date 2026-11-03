import { computed, ref, watch } from 'vue';
import {
  downItems,
  dueAlerts,
  loadAlertPrefs,
  saveAlertPrefs,
  sinceText,
  type AlertPrefs,
  type DownItem,
} from '../lib/disconnects';
import { useMonitorStore } from '../stores/monitor';
import { useNow } from './useNow';

/**
 * Alertas de desconexão do painel: a cada segundo confere quem caiu e, quando um alerta
 * vence (passou a tolerância, ou chegou a hora de repetir), toca o bipe, mostra a
 * notificação do navegador e um aviso na tela.
 *
 * As preferências (ligado, som, notificação, repetição, tolerância, quem vigiar) ficam
 * salvas neste navegador. `owner` é o elemento da página onde os avisos aparecem.
 */
export function useDisconnectAlerts(owner: string) {
  const store = useMonitorStore();
  const now = useNow();
  const prefs = ref<AlertPrefs>(loadAlertPrefs());
  watch(prefs, (p) => saveAlertPrefs(p), { deep: true });

  /** Vigiados fora do ar (com ou sem alerta). */
  const items = computed<DownItem[]>(() => downItems(store.endpoints, prefs.value, now.value));
  /** Os que estão em alerta (o número no sino). */
  const alerting = computed(() => items.value.filter((i) => i.alerting));

  // Quantos alertas já tocaram por endpoint. A primeira passada só registra (não toca o que
  // já estava vencido ao abrir a página); com os alertas desligados também só registra, para
  // não disparar tudo de uma vez quando forem ligados.
  const fired = new Map<string, number>();
  let initialized = false;
  watch(items, (list) => {
    if (!store.active?.hasSnapshot) return;
    const quiet = !initialized || !prefs.value.enabled;
    initialized = true;
    const due = dueAlerts(list, fired, quiet);
    if (due.length > 0) fire(due);
  });

  function fire(due: DownItem[]): void {
    if (prefs.value.sound) beep(due.some((d) => d.trunk) ? 3 : 2);
    for (const d of due) {
      const what = d.trunk ? `Tronco ${d.id} fora do ar` : `Ramal ${d.id} desconectado`;
      const when = sinceText(d.since, now.value);
      const repeat = d.alertCount > 1 ? ` (alerta ${d.alertCount})` : '';
      store.notify('danger', `${what} — ${when}${repeat}`, owner);
      if (prefs.value.notify && notificationsGranted()) {
        try {
          new Notification(`⚠ ${what}`, {
            body: `Offline ${when}${repeat}.`,
            tag: `astcall-${d.id}`,
          });
        } catch {
          // navegador sem suporte a notificações nesta página
        }
      }
    }
  }

  /** Pede permissão de notificação (precisa de um clique do usuário). */
  async function enableNotifications(): Promise<boolean> {
    if (!('Notification' in globalThis)) return false;
    const perm = await Notification.requestPermission();
    prefs.value.notify = perm === 'granted';
    return prefs.value.notify;
  }

  return { prefs, items, alerting, enableNotifications, testSound: () => beep(2) };
}

export type DisconnectAlerts = ReturnType<typeof useDisconnectAlerts>;

function notificationsGranted(): boolean {
  return 'Notification' in globalThis && Notification.permission === 'granted';
}

// ---------------------------------------------------------------- bipe

let audio: AudioContext | undefined;

/** Bipes curtos (Web Audio, sem arquivo de som). O navegador exige um clique antes do 1º som. */
function beep(times: number): void {
  try {
    audio ??= new AudioContext();
    void audio.resume();
    for (let i = 0; i < times; i++) {
      const t = audio.currentTime + i * 0.28;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + 0.22);
    }
  } catch {
    // sem áudio disponível: segue só com aviso e notificação
  }
}
