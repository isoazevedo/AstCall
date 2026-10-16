<script setup lang="ts">
/** Avisos rápidos (resultado das ações) no canto inferior direito. */
import { useMonitorStore } from '../stores/monitor';

const store = useMonitorStore();
</script>

<template>
  <div class="toasts" aria-live="polite">
    <div v-for="t in store.toasts" :key="t.id" class="toast" :class="`tone-${t.tone}`">
      {{ t.text }}
    </div>
  </div>
</template>

<style>
.toasts {
  position: fixed;
  right: 1.25rem;
  bottom: 1.25rem;
  z-index: 1100;
  display: grid;
  gap: 0.5rem;
  max-width: min(24rem, calc(100vw - 2.5rem));
}
.toast {
  padding: 0.75rem 1rem;
  border-radius: var(--ast-radius);
  background: var(--ast-card-bg);
  box-shadow: var(--ast-card-shadow);
  font-weight: 500;
}
/* o tom vem das classes .tone-* (fundo tingido); aqui reforça o contraste sobre o card */
.toast.tone-success {
  border-left: 4px solid var(--ast-success);
}
.toast.tone-danger {
  border-left: 4px solid var(--ast-danger);
}
.toast.tone-info {
  border-left: 4px solid var(--ast-info);
}
</style>
