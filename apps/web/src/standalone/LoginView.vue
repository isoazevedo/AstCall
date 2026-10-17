<script setup lang="ts">
/**
 * Tela de login (no estilo das páginas de autenticação do Frest).
 *
 * Conceitos: `v-model` liga cada campo ao seu `ref`; `@submit.prevent` trata o envio do
 * formulário sem recarregar a página; `defineEmits` avisa o componente pai do login.
 */
import { ref } from 'vue';
import type { LoginResponse } from '@astcall/shared';

const emit = defineEmits<{ 'logged-in': [response: LoginResponse] }>();

const username = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

async function submit(): Promise<void> {
  error.value = '';
  loading.value = true;
  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.value, password: password.value }),
    });
    if (res.ok) {
      const body = (await res.json()) as LoginResponse;
      password.value = '';
      emit('logged-in', body);
      return;
    }
    const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error;
    error.value =
      res.status === 429
        ? 'Muitas tentativas. Aguarde alguns minutos e tente novamente.'
        : (msg ?? 'Não foi possível entrar.');
  } catch {
    error.value = 'Servidor indisponível. Verifique se o backend está rodando.';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="auth">
    <form class="card" @submit.prevent="submit">
      <div class="brand"><span class="logo">A</span> AstCall</div>
      <h4>Bem-vindo! 👋</h4>
      <p class="muted">Entre com seu usuário para acessar o monitor.</p>

      <label for="username">Usuário</label>
      <input
        id="username"
        v-model="username"
        autocomplete="username"
        autofocus
        required
        :disabled="loading"
      />

      <label for="password">Senha</label>
      <input
        id="password"
        v-model="password"
        type="password"
        autocomplete="current-password"
        required
        :disabled="loading"
      />

      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <button type="submit" :disabled="loading">{{ loading ? 'Entrando…' : 'Entrar' }}</button>
    </form>
  </div>
</template>

<style scoped>
.auth {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 1.5rem;
}
.card {
  width: 100%;
  max-width: 25rem;
  padding: 2.5rem 2rem;
  background: var(--app-card-bg);
  border-radius: 1.3125rem;
  box-shadow: var(--app-card-shadow);
  display: flex;
  flex-direction: column;
}
.brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  margin-bottom: 1.75rem;
  font-family: 'Rubik', var(--bs-body-font-family);
  font-weight: 500;
  font-size: 1.5rem;
  color: var(--bs-heading-color);
}
.logo {
  display: grid;
  place-items: center;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 0.5rem;
  background: var(--bs-primary);
  color: #fff;
  font-size: 1.1rem;
}
h4 {
  margin: 0 0 0.35rem;
  font-size: 1.25rem;
}
.muted {
  margin: 0 0 1.5rem;
  color: var(--bs-secondary-color);
}
label {
  margin-bottom: 0.35rem;
  font-size: 0.8125rem;
  font-weight: 500;
  text-transform: uppercase;
  color: var(--bs-heading-color);
}
input {
  font: inherit;
  margin-bottom: 1rem;
  padding: 0.5rem 0.875rem;
  border: 1px solid var(--bs-border-color);
  border-radius: var(--bs-border-radius);
  background: transparent;
  color: var(--bs-body-color);
}
input:focus {
  outline: none;
  border-color: var(--bs-primary);
  box-shadow: 0 0 0.25rem 0.05rem rgba(var(--bs-primary-rgb), 0.1);
}
.error {
  margin: 0 0 1rem;
  padding: 0.6rem 0.85rem;
  border-radius: var(--bs-border-radius);
  background: rgba(var(--bs-danger-rgb), 0.16);
  color: var(--bs-danger);
}
button {
  font: inherit;
  font-weight: 500;
  padding: 0.6rem 1rem;
  border: 0;
  border-radius: var(--bs-border-radius);
  background: var(--bs-primary);
  color: #fff;
  cursor: pointer;
  box-shadow: 0 2px 4px rgba(var(--bs-primary-rgb), 0.4);
}
button:disabled {
  opacity: 0.65;
  cursor: default;
}
</style>
