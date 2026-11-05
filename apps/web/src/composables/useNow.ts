import { computed, onUnmounted, ref, type Ref } from 'vue';

/**
 * Composable: função que encapsula estado reativo + ciclo de vida para reutilizar em
 * componentes (convenção: nome começa com "use").
 *
 * Devolve o horário atual (ms) atualizado a cada segundo — usado para as durações ao vivo.
 * Todos os componentes compartilham um único timer; ele para quando ninguém mais usa.
 *
 * No histórico (máquina do tempo), o relógio da tela fica parado no horário que está sendo
 * revisto (`frozenAt`): "em conversa há 3 min" passa a valer para aquele momento. Quem
 * precisa do horário real mesmo no histórico (os alertas de desconexão) pede `{ live: true }`.
 */
const now = ref(Date.now());
/** Horário do histórico que está na tela (null = ao vivo). Controlado pelo store. */
export const frozenAt = ref<number | null>(null);
const clock = computed(() => frozenAt.value ?? now.value);
let users = 0;
let timer: ReturnType<typeof setInterval> | undefined;

export function useNow(options: { live?: boolean } = {}): Readonly<Ref<number>> {
  if (users++ === 0) timer = setInterval(() => (now.value = Date.now()), 1000);
  onUnmounted(() => {
    if (--users === 0) clearInterval(timer);
  });
  return options.live ? now : clock;
}
