<script setup lang="ts">
/**
 * Botão "⋮" que abre um menu de ações (dropdown, ou dropup quando falta espaço embaixo).
 *
 * O menu usa `position: fixed` calculada a partir do botão: assim não é cortado pelo card
 * nem empurra o layout. Fecha ao escolher uma opção, clicar fora, apertar Esc, rolar a
 * página ou redimensionar a janela.
 *
 * Conceitos de Vue usados aqui:
 * - `ref` em elemento do template (ref="trigger"): acesso ao botão para medir a posição.
 * - `nextTick`: espera o Vue desenhar o menu antes de medir a altura dele.
 * - `<component :is>`: desenha o ícone que vem em cada item.
 */
import { nextTick, onUnmounted, ref, type Component } from 'vue';
import { MoreVertical } from 'lucide-vue-next';

export interface MenuItem {
  label: string;
  icon?: Component;
  /** "danger" pinta a opção de vermelho (ex.: remover). */
  tone?: 'danger';
  disabled?: boolean;
  /** Texto pequeno embaixo do rótulo (ex.: por que está desabilitado). */
  hint?: string;
  run: () => void;
}

const props = defineProps<{ items: MenuItem[]; label: string }>();

const WIDTH = 230; // px
const open = ref(false);
const placed = ref(false);
const pos = ref({ top: 0, left: 0 });
const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);

async function toggle(): Promise<void> {
  if (open.value) return close();
  open.value = true;
  placed.value = false;
  await nextTick();
  place();
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
  menu.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
}

/** Abaixo do botão; se não couber e houver espaço em cima, acima (dropup). */
function place(): void {
  const r = trigger.value!.getBoundingClientRect();
  const h = menu.value?.offsetHeight ?? 0;
  const up = r.bottom + h + 8 > window.innerHeight && r.top - h - 8 > 0;
  pos.value = {
    top: up ? r.top - h - 4 : r.bottom + 4,
    // alinhado pela direita do botão; sem espaço à esquerda, alinha pela esquerda dele
    left: Math.max(
      8,
      Math.min(r.right - WIDTH >= 8 ? r.right - WIDTH : r.left, window.innerWidth - WIDTH - 8),
    ),
  };
  placed.value = true;
}

function close(): void {
  open.value = false;
  document.removeEventListener('pointerdown', onOutside, true);
  window.removeEventListener('scroll', close, true);
  window.removeEventListener('resize', close);
}

/** Clique fora. Dentro do Shadow DOM o alvo do evento é o host; composedPath() vê o caminho real. */
function onOutside(e: PointerEvent): void {
  const path = e.composedPath();
  if (menu.value && path.includes(menu.value)) return;
  if (trigger.value && path.includes(trigger.value)) return;
  close();
}

function select(item: MenuItem): void {
  if (item.disabled) return;
  close();
  item.run();
}

function escape(): void {
  close();
  trigger.value?.focus();
}

onUnmounted(close);
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="am-trigger"
    :class="{ active: open }"
    aria-haspopup="menu"
    :aria-expanded="open"
    :aria-label="props.label"
    :title="props.label"
    @click="toggle"
  >
    <MoreVertical :size="16" aria-hidden="true" />
  </button>

  <div
    v-if="open"
    ref="menu"
    class="am-menu ast-card"
    role="menu"
    :aria-label="props.label"
    :style="{
      top: `${pos.top}px`,
      left: `${pos.left}px`,
      width: `${WIDTH}px`,
      visibility: placed ? 'visible' : 'hidden',
    }"
    @keydown.esc.stop="escape"
  >
    <button
      v-for="(item, i) in items"
      :key="i"
      type="button"
      role="menuitem"
      class="am-item"
      :class="{ danger: item.tone === 'danger' }"
      :disabled="item.disabled"
      @click="select(item)"
    >
      <component :is="item.icon" v-if="item.icon" :size="15" aria-hidden="true" />
      <span class="am-text">
        <span>{{ item.label }}</span>
        <small v-if="item.hint">{{ item.hint }}</small>
      </span>
    </button>
  </div>
</template>

<style>
.am-trigger {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 1.75rem;
  height: 1.75rem;
  padding: 0;
  border: 0;
  border-radius: var(--ast-radius);
  background: transparent;
  color: var(--ast-text-muted);
  cursor: pointer;
}
.am-trigger:hover,
.am-trigger.active {
  background: rgba(var(--ast-secondary-rgb), 0.16);
  color: var(--ast-heading);
}
.am-menu {
  position: fixed;
  z-index: 900;
  display: grid;
  padding: 0.35rem;
  border-radius: 0.5rem;
  box-shadow: 0 0.25rem 1rem rgba(0, 0, 0, 0.25);
}
.am-item {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  width: 100%;
  padding: 0.5rem 0.65rem;
  font: inherit;
  font-size: 0.875rem;
  text-align: left;
  border: 0;
  border-radius: var(--ast-radius);
  background: transparent;
  color: var(--ast-text);
  cursor: pointer;
}
.am-item svg {
  flex: none;
  margin-top: 0.15rem;
}
.am-item:hover:not(:disabled),
.am-item:focus-visible {
  outline: none;
  background: rgba(var(--ast-primary-rgb), 0.1);
  color: var(--ast-primary);
}
.am-item.danger {
  color: var(--ast-danger);
}
.am-item.danger:hover:not(:disabled),
.am-item.danger:focus-visible {
  background: rgba(var(--ast-danger-rgb), 0.1);
  color: var(--ast-danger);
}
.am-item:disabled {
  opacity: 0.55;
  cursor: default;
}
.am-text {
  display: grid;
  line-height: 1.3;
}
.am-text small {
  font-size: 0.75rem;
  color: var(--ast-text-muted);
}
</style>
