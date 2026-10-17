<script setup lang="ts">
/**
 * Widget <ast-ramais>: o mapa de ramais com filtros por situação.
 *
 *   <ast-ramais token-url="/astcall/token" endpoints="9001,9002,9005"></ast-ramais>
 *
 * - endpoints: ramais a mostrar, separados por vírgula (sem o atributo: todos do usuário);
 * - readonly: sem a ação "Ligar".
 * Compartilha a conexão com os outros elementos da página.
 */
import { computed } from 'vue';
import { useWidgetRoot } from '../composables/useWidget';
import { listAttr } from '../lib/attrs';
import { useMonitorStore } from '../stores/monitor';
import ActionDialog from './ActionDialog.ce.vue';
import AstWidgetStatus from './AstWidgetStatus.ce.vue';
import EndpointGrid from './EndpointGrid.ce.vue';
import ToastHost from './ToastHost.ce.vue';

const props = withDefaults(
  defineProps<{ wsUrl?: string; tokenUrl: string; readonly?: boolean; endpoints?: string }>(),
  { wsUrl: '/monitor-ws', readonly: false, endpoints: '' },
);
const emit = defineEmits<{ 'auth-required': [] }>();
useWidgetRoot(props, () => emit('auth-required'));

const store = useMonitorStore();
const shown = computed(() => {
  const wanted = listAttr(props.endpoints);
  return wanted.size ? store.endpoints.filter((e) => wanted.has(e.id)) : store.endpoints;
});
</script>

<template>
  <div class="ast-widget">
    <AstWidgetStatus />
    <EndpointGrid :endpoints="shown" :loading="!store.active?.hasSnapshot" />
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
