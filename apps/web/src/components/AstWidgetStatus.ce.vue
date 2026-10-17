<script setup lang="ts">
/**
 * Aviso de conexão dos widgets (<ast-filas>, <ast-ramais>, <ast-chamadas>). Eles não têm
 * cabeçalho próprio: só aparece algo quando há problema (sessão expirada, conexão instável).
 */
import { computed } from 'vue';
import { useMonitorStore } from '../stores/monitor';

const store = useMonitorStore();

const message = computed(() => {
  if (store.connection === 'auth-required') return 'Sessão expirada — entre novamente.';
  if (store.active?.hasSnapshot && store.stale) {
    return 'Conexão instável — os dados podem estar desatualizados.';
  }
  return '';
});
</script>

<template>
  <div v-if="message" class="ast-alert" role="alert">{{ message }}</div>
</template>
