<script setup lang="ts">
/**
 * Tela "Usuários" do modo standalone: lista, cria, edita (nome e permissões), troca a senha,
 * ativa/desativa e remove usuários. As permissões valem para todos os servidores.
 *
 * Conceitos de Vue usados aqui:
 * - `ref` com objeto (form): os campos do formulário ficam num só lugar e o `v-model` de cada
 *   input aponta para um campo dele (ex.: v-model="form.name").
 * - `v-model` em vários checkboxes ligados ao mesmo array: o Vue adiciona/remove o valor do
 *   array conforme o checkbox é marcado (form.perms vira a lista de permissões marcadas).
 * - `computed` para regras da tela (ex.: o próprio usuário não pode se desativar).
 */
import { computed, onMounted, ref } from 'vue';
import { KeyRound, Pencil, Plus, Power, Trash2 } from 'lucide-vue-next';
import { PERMISSION_LABELS, PERMISSIONS, type AdminUser, type Permission } from '@astcall/shared';
import { adminApi, SessionExpiredError } from './session';

const props = defineProps<{ me: string }>();
const emit = defineEmits<{ 'session-expired': [] }>();

/** Permissões que ainda não têm função no painel (aparecem marcadas como futuras). */
const FUTURE: Permission[] = ['record', 'conference'];

const users = ref<AdminUser[]>([]);
const loading = ref(true);
const error = ref('');
const notice = ref('');

type Mode = 'create' | 'edit' | 'password' | 'remove';
const dialog = ref<{ mode: Mode; user?: AdminUser } | null>(null);
const form = ref({
  username: '',
  name: '',
  password: '',
  confirm: '',
  perms: [] as Permission[],
});
const busy = ref(false);
const dialogError = ref('');

async function call<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SessionExpiredError) emit('session-expired');
    else throw err;
    return undefined;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    users.value = (await call(() => adminApi<AdminUser[]>('/admin/users'))) ?? [];
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function open(mode: Mode, user?: AdminUser): void {
  form.value = {
    username: user?.username ?? '',
    name: user?.name ?? '',
    password: '',
    confirm: '',
    perms: user ? [...user.perms] : ['view'],
  };
  dialogError.value = '';
  dialog.value = { mode, user };
}

const allChecked = computed(() => form.value.perms.length === PERMISSIONS.length);
function toggleAll(): void {
  form.value.perms = allChecked.value ? [] : [...PERMISSIONS];
}

const needsPassword = computed(
  () => dialog.value?.mode === 'create' || dialog.value?.mode === 'password',
);

/** Validação do formulário antes de enviar (o backend valida de novo). */
const formProblem = computed(() => {
  const f = form.value;
  if (dialog.value?.mode === 'create' && !/^[a-z0-9._@-]+$/i.test(f.username)) {
    return 'Usuário: use letras, números e . _ @ - (sem espaços).';
  }
  if (needsPassword.value) {
    if (f.password.length < 10) return 'A senha deve ter pelo menos 10 caracteres.';
    if (f.password !== f.confirm) return 'As senhas não conferem.';
  }
  return '';
});

async function submit(): Promise<void> {
  const d = dialog.value;
  if (!d || busy.value) return;
  if (formProblem.value) {
    dialogError.value = formProblem.value;
    return;
  }
  busy.value = true;
  dialogError.value = '';
  const f = form.value;
  try {
    let msg = '';
    if (d.mode === 'create') {
      await call(() =>
        adminApi('/admin/users', {
          username: f.username.trim(),
          name: f.name.trim(),
          password: f.password,
          perms: f.perms,
        }),
      );
      msg = `Usuário ${f.username} criado.`;
    } else if (d.mode === 'edit') {
      await call(() =>
        adminApi('/admin/users/update', {
          username: d.user!.username,
          name: f.name.trim(),
          perms: f.perms,
        }),
      );
      msg = `Usuário ${d.user!.username} atualizado. Permissões valem no próximo login ou renovação (até 10 min).`;
    } else if (d.mode === 'password') {
      await call(() =>
        adminApi('/admin/users/password', { username: d.user!.username, password: f.password }),
      );
      msg = `Senha de ${d.user!.username} alterada; as sessões abertas dele foram encerradas.`;
    } else {
      await call(() => adminApi('/admin/users/remove', { username: d.user!.username }));
      msg = `Usuário ${d.user!.username} removido.`;
    }
    dialog.value = null;
    notice.value = msg;
    await load();
  } catch (err) {
    dialogError.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}

async function toggleActive(u: AdminUser): Promise<void> {
  notice.value = '';
  error.value = '';
  try {
    await call(() => adminApi('/admin/users/update', { username: u.username, active: !u.active }));
    notice.value = u.active
      ? `Usuário ${u.username} desativado; as sessões dele foram encerradas.`
      : `Usuário ${u.username} ativado.`;
    await load();
  } catch (err) {
    error.value = (err as Error).message;
  }
}

const permsText = (u: AdminUser) =>
  u.perms.length === PERMISSIONS.length
    ? 'Todas'
    : u.perms.map((p) => PERMISSION_LABELS[p]).join(', ') || 'Nenhuma';

const title: Record<Mode, string> = {
  create: 'Novo usuário',
  edit: 'Editar usuário',
  password: 'Trocar senha',
  remove: 'Remover usuário',
};
</script>

<template>
  <section class="users">
    <header class="users-head">
      <div>
        <h4>Usuários</h4>
        <p class="muted">
          Acesso ao AstCall no modo standalone. As permissões valem para todos os servidores.
        </p>
      </div>
      <button type="button" class="btn btn-primary" @click="open('create')">
        <Plus :size="16" aria-hidden="true" /> Novo usuário
      </button>
    </header>

    <p v-if="notice" class="alert ok" role="status">{{ notice }}</p>
    <p v-if="error" class="alert danger" role="alert">{{ error }}</p>

    <div class="card">
      <p v-if="loading" class="muted pad">Carregando…</p>
      <table v-else class="table">
        <thead>
          <tr>
            <th>Usuário</th>
            <th>Nome</th>
            <th>Permissões</th>
            <th>Situação</th>
            <th class="right">Ações</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.username" :class="{ inactive: !u.active }">
            <td>
              <strong>{{ u.username }}</strong>
              <small v-if="u.username === props.me" class="muted"> (você)</small>
            </td>
            <td>{{ u.name }}</td>
            <td class="perms">{{ permsText(u) }}</td>
            <td>
              <span class="badge" :class="u.active ? 'ok' : 'off'">
                {{ u.active ? 'Ativo' : 'Inativo' }}
              </span>
            </td>
            <td class="right actions">
              <button type="button" class="icon" title="Editar" @click="open('edit', u)">
                <Pencil :size="15" />
              </button>
              <button type="button" class="icon" title="Trocar senha" @click="open('password', u)">
                <KeyRound :size="15" />
              </button>
              <button
                type="button"
                class="icon"
                :title="
                  u.username === props.me
                    ? 'Você não pode desativar a si mesmo'
                    : u.active
                      ? 'Desativar'
                      : 'Ativar'
                "
                :disabled="u.username === props.me"
                @click="toggleActive(u)"
              >
                <Power :size="15" />
              </button>
              <button
                type="button"
                class="icon danger"
                :title="u.username === props.me ? 'Você não pode remover a si mesmo' : 'Remover'"
                :disabled="u.username === props.me"
                @click="open('remove', u)"
              >
                <Trash2 :size="15" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Diálogo único: criar, editar, trocar senha ou remover -->
    <div v-if="dialog" class="backdrop" @click.self="dialog = null">
      <form class="dialog card" @submit.prevent="submit" @keydown.esc="dialog = null">
        <h5>{{ title[dialog.mode] }}</h5>

        <p v-if="dialog.mode === 'remove'">
          Remover o usuário <strong>{{ dialog.user!.username }}</strong
          >? Esta ação não pode ser desfeita.
        </p>

        <template v-else>
          <label v-if="dialog.mode === 'create'" class="field">
            <span>Usuário</span>
            <input v-model="form.username" autocomplete="off" required :disabled="busy" />
          </label>
          <p v-else class="muted">
            Usuário: <strong>{{ dialog.user!.username }}</strong>
          </p>

          <label v-if="dialog.mode !== 'password'" class="field">
            <span>Nome de exibição</span>
            <input v-model="form.name" :placeholder="form.username" :disabled="busy" />
          </label>

          <template v-if="needsPassword">
            <label class="field">
              <span>Senha (mínimo 10 caracteres)</span>
              <input
                v-model="form.password"
                type="password"
                autocomplete="new-password"
                :disabled="busy"
              />
            </label>
            <label class="field">
              <span>Repita a senha</span>
              <input
                v-model="form.confirm"
                type="password"
                autocomplete="new-password"
                :disabled="busy"
              />
            </label>
          </template>

          <fieldset v-if="dialog.mode !== 'password'" class="perms-box">
            <legend>
              Permissões
              <button type="button" class="link" @click="toggleAll">
                {{ allChecked ? 'desmarcar todas' : 'marcar todas' }}
              </button>
            </legend>
            <label v-for="p in PERMISSIONS" :key="p" class="check">
              <input
                v-model="form.perms"
                type="checkbox"
                :value="p"
                :disabled="busy || (p === 'users' && dialog.user?.username === props.me)"
              />
              {{ PERMISSION_LABELS[p] }}
              <small v-if="FUTURE.includes(p)" class="muted">(ainda sem uso)</small>
            </label>
          </fieldset>
        </template>

        <p v-if="dialogError" class="alert danger" role="alert">{{ dialogError }}</p>

        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" :disabled="busy" @click="dialog = null">
            Cancelar
          </button>
          <button
            type="submit"
            class="btn"
            :class="dialog.mode === 'remove' ? 'btn-danger' : 'btn-primary'"
            :disabled="busy"
          >
            {{ busy ? 'Aguarde…' : dialog.mode === 'remove' ? 'Remover' : 'Salvar' }}
          </button>
        </div>
      </form>
    </div>
  </section>
</template>

<style scoped>
.users {
  display: grid;
  gap: 1.25rem;
}
.users-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
h4,
h5 {
  margin: 0 0 0.25rem;
  font-family: 'Rubik', var(--bs-body-font-family);
  font-weight: 500;
  color: var(--bs-heading-color);
}
h4 {
  font-size: 1.375rem;
}
.muted {
  margin: 0;
  color: var(--bs-secondary-color);
}
.pad {
  padding: 1.5rem;
}
.card {
  background: var(--app-card-bg);
  border-radius: 1.3125rem;
  box-shadow: var(--app-card-shadow);
}
.table {
  width: 100%;
  border-collapse: collapse;
}
.table th,
.table td {
  padding: 0.75rem 1.25rem;
  text-align: left;
  border-bottom: 1px solid var(--bs-border-color);
  vertical-align: middle;
}
.table th {
  font-size: 0.8125rem;
  font-weight: 500;
  text-transform: uppercase;
  color: var(--bs-heading-color);
}
.table tbody tr:last-child td {
  border-bottom: 0;
}
.table strong {
  color: var(--bs-heading-color);
  font-weight: 500;
}
tr.inactive td {
  opacity: 0.6;
}
.perms {
  max-width: 28rem;
  font-size: 0.875rem;
}
.right {
  text-align: right !important;
}
.actions {
  white-space: nowrap;
}
.badge {
  padding: 0.25rem 0.55rem;
  border-radius: var(--bs-border-radius);
  font-size: 0.8125rem;
  font-weight: 500;
}
.badge.ok {
  background: rgba(var(--bs-success-rgb), 0.16);
  color: var(--bs-success);
}
.badge.off {
  background: rgba(var(--bs-secondary-rgb), 0.16);
  color: var(--bs-secondary);
}
.icon {
  display: inline-grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  margin-left: 0.25rem;
  border: 0;
  border-radius: var(--bs-border-radius);
  background: rgba(var(--bs-primary-rgb), 0.12);
  color: var(--bs-primary);
  cursor: pointer;
}
.icon.danger {
  background: rgba(var(--bs-danger-rgb), 0.12);
  color: var(--bs-danger);
}
.icon:disabled {
  opacity: 0.35;
  cursor: default;
}
.alert {
  margin: 0;
  padding: 0.75rem 1rem;
  border-radius: var(--bs-border-radius);
  font-weight: 500;
}
.alert.ok {
  background: rgba(var(--bs-success-rgb), 0.16);
  color: var(--bs-success);
}
.alert.danger {
  background: rgba(var(--bs-danger-rgb), 0.16);
  color: var(--bs-danger);
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font: inherit;
  font-weight: 500;
  padding: 0.5rem 1rem;
  border: 0;
  border-radius: var(--bs-border-radius);
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.btn-primary {
  background: var(--bs-primary);
  color: #fff;
}
.btn-danger {
  background: var(--bs-danger);
  color: #fff;
}
.btn-secondary {
  background: rgba(var(--bs-secondary-rgb), 0.16);
  color: var(--bs-secondary);
}
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: 1rem;
  background: rgba(38, 60, 85, 0.45);
}
.dialog {
  width: 100%;
  max-width: 30rem;
  max-height: calc(100vh - 2rem);
  overflow: auto;
  padding: 1.5rem;
  display: grid;
  gap: 0.85rem;
}
.dialog p {
  margin: 0;
}
.field {
  display: grid;
  gap: 0.3rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--bs-heading-color);
}
.field input {
  font: inherit;
  font-weight: 400;
  padding: 0.45rem 0.85rem;
  border: 1px solid var(--bs-border-color);
  border-radius: var(--bs-border-radius);
  background: transparent;
  color: var(--bs-body-color);
}
.field input:focus {
  outline: none;
  border-color: var(--bs-primary);
}
.perms-box {
  margin: 0;
  padding: 0.75rem 1rem;
  border: 1px solid var(--bs-border-color);
  border-radius: var(--bs-border-radius);
  display: grid;
  gap: 0.35rem;
}
.perms-box legend {
  padding: 0 0.35rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--bs-heading-color);
}
.link {
  margin-left: 0.5rem;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  font-weight: 400;
  color: var(--bs-primary);
  cursor: pointer;
}
.check {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  cursor: pointer;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
</style>
