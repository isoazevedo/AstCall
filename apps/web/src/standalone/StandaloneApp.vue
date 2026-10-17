<script setup lang="ts">
/**
 * Casca da SPA standalone. Três situações:
 * - "checking": verificando se já existe sessão (cookie de renovação);
 * - "login": mostra o formulário;
 * - "app": mostra a barra superior + o <ast-monitor> (ou só o <ast-monitor> no modo TV).
 *   Com a permissão "users", a barra tem o link "Usuários" (endereço #usuarios).
 *
 * Conceito: `v-if` / `v-else-if` / `v-else` mostram um bloco ou outro conforme a condição.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { LayoutDashboard, LogOut, Tv, Users } from 'lucide-vue-next';
import type { LoginResponse } from '@astcall/shared';
import LoginView from './LoginView.vue';
import { decodeToken, refresh, setSession, type SessionInfo } from './session';
import UsersView from './UsersView.vue';

const view = ref<'checking' | 'login' | 'app'>('checking');

/** Endereço com "?tv" abre o modo TV (wallboard), sem a barra superior. "?tv&rotate=30" muda o intervalo. */
const params = new URLSearchParams(window.location.search);
const tv = params.has('tv');
/** "?widgets": página de demonstração dos widgets (<ast-filas>, <ast-chamadas>, <ast-ramais>). */
const widgets = params.has('widgets');
const rotate = params.get('rotate') ?? undefined;
const me = ref<SessionInfo>({ sub: '', name: '', perms: [] });
const canManageUsers = computed(() => me.value.perms.includes('users'));

/** Página atual pelo endereço: "#usuarios" = tela de usuários; o resto = painel. */
const page = ref(pageFromHash());
function pageFromHash(): 'monitor' | 'users' {
  return window.location.hash === '#usuarios' ? 'users' : 'monitor';
}
const onHash = () => (page.value = pageFromHash());
onMounted(() => window.addEventListener('hashchange', onHash));
onUnmounted(() => window.removeEventListener('hashchange', onHash));

onMounted(async () => {
  // Já existe sessão? O refresh responde 200 com um token se o cookie for válido.
  try {
    const t = await refresh();
    if (t) {
      me.value = decodeToken(t.token);
      view.value = 'app';
      return;
    }
  } catch {
    // backend fora do ar: cai no login, que mostrará o erro ao tentar entrar
  }
  view.value = 'login';
});

function onLoggedIn(res: LoginResponse): void {
  setSession({ token: res.token, expiresAt: res.expiresAt });
  me.value = decodeToken(res.token);
  view.value = 'app';
}

async function logout(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  setSession(null);
  view.value = 'login';
}
</script>

<template>
  <div v-if="view === 'checking'" class="center muted">Carregando…</div>

  <LoginView v-else-if="view === 'login'" @logged-in="onLoggedIn" />

  <!-- Modo TV: só o componente, ocupando a tela toda -->
  <ast-monitor
    v-else-if="tv"
    ws-url="/monitor-ws"
    token-url="/auth/refresh"
    mode="tv"
    :rotate="rotate"
    @auth-required="logout"
  />

  <div v-else class="layout">
    <nav class="navbar">
      <div class="brand"><span class="logo">A</span> AstCall</div>
      <div class="user">
        <span>{{ me.name }}</span>
        <!-- Alterna entre o painel e a tela de usuários (só para quem tem a permissão "users") -->
        <template v-if="canManageUsers">
          <a v-if="page === 'users'" href="#" class="btn-ghost btn-nav" title="Voltar ao painel">
            <LayoutDashboard :size="18" aria-hidden="true" /> Painel
          </a>
          <a v-else href="#usuarios" class="btn-ghost btn-nav" title="Gerenciar usuários">
            <Users :size="18" aria-hidden="true" /> Usuários
          </a>
        </template>
        <!-- Abre o modo TV numa nova aba (para levar à TV/monitor da equipe) -->
        <a href="/?tv" target="_blank" class="btn-ghost btn-tv" title="Abrir o modo TV">
          <Tv :size="18" aria-hidden="true" /> Modo TV
        </a>
        <button type="button" class="btn-ghost" title="Sair" @click="logout">
          <LogOut :size="18" aria-hidden="true" /> Sair
        </button>
      </div>
    </nav>
    <!--
      Demonstração dos widgets: exemplo de tela montada sob medida. Os três elementos
      compartilham uma única conexão WebSocket. Os ramais estão em modo só leitura.
    -->
    <main v-if="page === 'users' && canManageUsers" class="content">
      <UsersView :me="me.sub" @session-expired="logout" />
    </main>
    <main v-else-if="widgets" class="content demo">
      <section>
        <h5 class="demo-title">&lt;ast-chamadas&gt;</h5>
        <ast-chamadas ws-url="/monitor-ws" token-url="/auth/refresh" @auth-required="logout" />
      </section>
      <section>
        <h5 class="demo-title">&lt;ast-filas queues="suporte-default"&gt;</h5>
        <ast-filas
          ws-url="/monitor-ws"
          token-url="/auth/refresh"
          queues="suporte-default"
          @auth-required="logout"
        />
      </section>
      <section class="demo-wide">
        <h5 class="demo-title">&lt;ast-ramais readonly&gt;</h5>
        <ast-ramais
          ws-url="/monitor-ws"
          token-url="/auth/refresh"
          readonly
          @auth-required="logout"
        />
      </section>
    </main>
    <main v-else class="content">
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
.btn-ghost.btn-tv,
.btn-ghost.btn-nav {
  text-decoration: none;
}
.btn-ghost.btn-tv:hover,
.btn-ghost.btn-nav:hover {
  background: rgba(var(--bs-primary-rgb), 0.12);
  color: var(--bs-primary);
}
.demo {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr));
  gap: 1.5rem;
  align-items: start;
}
.demo-wide {
  grid-column: 1 / -1;
}
.demo-title {
  margin: 0 0 0.6rem;
  font-family: ui-monospace, monospace;
  font-weight: 500;
  color: var(--bs-secondary-color);
}
.content {
  padding: 1.5rem 1.625rem 2rem;
}
</style>
