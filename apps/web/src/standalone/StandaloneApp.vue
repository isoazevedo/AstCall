<script setup lang="ts">
/**
 * Casca da SPA standalone. Três situações:
 * - "checking": verificando se já existe sessão (cookie de renovação);
 * - "login": mostra o formulário;
 * - "app": mostra a barra superior + o <ast-monitor>.
 *
 * Conceito: `v-if` / `v-else-if` / `v-else` mostram um bloco ou outro conforme a condição.
 */
import { onMounted, ref } from 'vue';
import { LogOut } from 'lucide-vue-next';
import type { TokenResponse } from '@astcall/shared';
import LoginView from './LoginView.vue';

const view = ref<'checking' | 'login' | 'app'>('checking');
const userName = ref('');

/** Lê o nome de exibição do token (só para mostrar; quem valida é o backend). */
function nameFromToken(token: string): string {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    return payload.name || payload.sub || '';
  } catch {
    return '';
  }
}

onMounted(async () => {
  // Já existe sessão? O refresh responde 200 com um token se o cookie for válido.
  try {
    const res = await fetch('/auth/refresh', { method: 'POST', credentials: 'same-origin' });
    if (res.ok) {
      userName.value = nameFromToken(((await res.json()) as TokenResponse).token);
      view.value = 'app';
      return;
    }
  } catch {
    // backend fora do ar: cai no login, que mostrará o erro ao tentar entrar
  }
  view.value = 'login';
});

function onLoggedIn(name: string): void {
  userName.value = name;
  view.value = 'app';
}

async function logout(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  view.value = 'login';
}
</script>

<template>
  <div v-if="view === 'checking'" class="center muted">Carregando…</div>

  <LoginView v-else-if="view === 'login'" @logged-in="onLoggedIn" />

  <div v-else class="layout">
    <nav class="navbar">
      <div class="brand"><span class="logo">A</span> AstCall</div>
      <div class="user">
        <span>{{ userName }}</span>
        <button type="button" class="btn-ghost" title="Sair" @click="logout">
          <LogOut :size="18" aria-hidden="true" /> Sair
        </button>
      </div>
    </nav>
    <main class="content">
      <!-- O mesmo Web Component usado no AzCall; o token vem do /auth/refresh (cookie) -->
      <ast-monitor ws-url="/monitor-ws" token-url="/auth/refresh" @auth-required="logout" />
    </main>
  </div>
</template>

<style scoped>
.center {
  min-height: 100vh;
  display: grid;
  place-items: center;
}
.muted {
  color: var(--bs-secondary-color);
}
.layout {
  min-height: 100vh;
}
/* Barra superior no estilo da navbar do Frest: card flutuante com cantos arredondados */
.navbar {
  position: sticky;
  top: 0.75rem;
  z-index: 10;
  margin: 0.75rem 1.625rem 0;
  padding: 0.6rem 1.25rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--app-card-bg);
  border-radius: 1.3125rem;
  box-shadow: var(--app-card-shadow);
}
.brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-family: 'Rubik', var(--bs-body-font-family);
  font-weight: 500;
  font-size: 1.25rem;
  color: var(--bs-heading-color);
}
.logo {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border-radius: 0.5rem;
  background: var(--bs-primary);
  color: #fff;
  font-size: 1rem;
}
.user {
  display: flex;
  align-items: center;
  gap: 1rem;
}
.btn-ghost {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font: inherit;
  padding: 0.4rem 0.75rem;
  border: 0;
  border-radius: var(--bs-border-radius);
  background: rgba(var(--bs-secondary-rgb), 0.12);
  color: var(--bs-body-color);
  cursor: pointer;
}
.btn-ghost:hover {
  background: rgba(var(--bs-danger-rgb), 0.12);
  color: var(--bs-danger);
}
.content {
  padding: 1.5rem 1.625rem 2rem;
}
</style>
