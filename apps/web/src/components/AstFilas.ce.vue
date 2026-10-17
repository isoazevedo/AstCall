<script setup lang="ts">
/**
 * Widget <ast-filas>: os cards de fila, para montar telas sob medida (ex.: dashboard).
 *
 *   <ast-filas token-url="/astcall/token" ws-url="/astcall/monitor-ws"
 *              queues="suporte-1,vendas-1" readonly></ast-filas>
 *
 * - queues: filas a mostrar, separadas por vírgula (sem o atributo: todas as do usuário);
 * - readonly: sem ações (pausar, adicionar membro...).
 * Compartilha a conexão com os outros elementos da página.
 */
import { computed } from 'vue';
import { useWidgetRoot } from '../composables/useWidget';
import { listAttr } from '../lib/attrs';
import { useMonitorStore } from '../stores/monitor';
import ActionDialog from './ActionDialog.ce.vue';
import AstWidgetStatus from './AstWidgetStatus.ce.vue';
import QueuePanel from './QueuePanel.ce.vue';
import ToastHost from './ToastHost.ce.vue';

const props = withDefaults(
  defineProps<{ wsUrl?: string; tokenUrl: string; readonly?: boolean; queues?: string }>(),
  { wsUrl: '/monitor-ws', readonly: false, queues: '' },
);
const emit = defineEmits<{ 'auth-required': [] }>();
useWidgetRoot(props, () => emit('auth-required'));

const store = useMonitorStore();
const wanted = computed(() => listAttr(props.queues));
const shown = computed(() =>
  wanted.value.size ? store.queues.filter((q) => wanted.value.has(q.name)) : store.queues,
);
</script>

<template>
  <div class="ast-widget">
    <AstWidgetStatus />
    <QueuePanel
      :queues="shown"
      :loading="!store.active?.hasSnapshot"
      :searchable="wanted.size === 0"
    />
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
