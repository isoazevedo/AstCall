<script setup lang="ts">
/**
 * Widget <ast-chamadas>: a lista de chamadas em andamento.
 *
 *   <ast-chamadas token-url="/astcall/token" readonly></ast-chamadas>
 *
 * - readonly: sem as ações (escutar, transferir, desligar).
 * Compartilha a conexão com os outros elementos da página.
 */
import { useWidgetRoot } from '../composables/useWidget';
import { useMonitorStore } from '../stores/monitor';
import ActionDialog from './ActionDialog.ce.vue';
import AstWidgetStatus from './AstWidgetStatus.ce.vue';
import CallList from './CallList.ce.vue';
import ToastHost from './ToastHost.ce.vue';

const props = withDefaults(
  defineProps<{ wsUrl?: string; tokenUrl: string; readonly?: boolean }>(),
  { wsUrl: '/monitor-ws', readonly: false },
);
const emit = defineEmits<{ 'auth-required': [] }>();
useWidgetRoot(props, () => emit('auth-required'));

const store = useMonitorStore();
</script>

<template>
  <div class="ast-widget">
    <AstWidgetStatus />
    <CallList :calls="store.calls" :loading="!store.active?.hasSnapshot" />
    <ActionDialog />
    <ToastHost />
  </div>
</template>

<style src="../styles/base.css"></style>
<style>
.ast-widget {
  display: grid;
  gap: 1rem;
}
</style>
