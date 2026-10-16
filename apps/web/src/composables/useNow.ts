import { onUnmounted, ref, type Ref } from 'vue';

/**
 * Composable: função que encapsula estado reativo + ciclo de vida para reutilizar em
 * componentes (convenção: nome começa com "use").
 *
 * Devolve o horário atual (ms) atualizado a cada segundo — usado para as durações ao vivo.
 * Todos os componentes compartilham um único timer; ele para quando ninguém mais usa.
 */
const now = ref(Date.now());
let users = 0;
let timer: ReturnType<typeof setInterval> | undefined;

export function useNow(): Ref<number> {
  if (users++ === 0) timer = setInterval(() => (now.value = Date.now()), 1000);
  onUnmounted(() => {
    if (--users === 0) clearInterval(timer);
  });
  return now;
}
