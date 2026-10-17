/**
 * Gestão de usuários do modo standalone (linha de comando).
 *
 * Uso (na raiz do repositório):
 *   npm run user add <usuario>        (pergunta nome, permissões e senha — funciona em qualquer terminal)
 *   npm run user -- add <usuario> --name "Nome" --perms view,hangup [--server pbx1]
 *   npm run user -- list
 *   npm run user -- passwd <usuario>
 *   npm run user -- perms <usuario> --perms view,spy [--server pbx1]
 *   npm run user -- disable <usuario> | enable <usuario> | remove <usuario>
 *
 * --server omitido = todos os servidores ("*"). --perms all = todas as permissões.
 * A senha é pedida no terminal (sem eco) ou lida da entrada padrão com --password-stdin.
 *
 * PowerShell (Windows): ele remove o `--` antes de chamar o npm, e então o npm "come" as
 * opções (--name, --perms...). Use a forma interativa (sem opções) ou escreva '--' entre aspas.
 */
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { ALL_SERVERS, PERMISSIONS, type Permission, type ServerPermissions } from '@astcall/shared';
import { UserRepository } from '../src/auth/UserRepository.js';
import { loadAuthConfig } from '../src/config/index.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    perms: { type: 'string' },
    server: { type: 'string' },
    'password-stdin': { type: 'boolean' },
  },
});
const [command, username, ...extra] = positionals;

function fail(message: string): never {
  console.error(`Erro: ${message}`);
  process.exit(1);
}

// Valores soltos a mais = as opções se perderam no caminho (PowerShell + npm sem o `--`)
if (extra.length > 0) {
  fail(
    [
      `argumentos inesperados: ${extra.join(' ')}`,
      '  As opções (--name, --perms...) não chegaram ao comando. No PowerShell, use a forma',
      `  interativa: npm run user ${command ?? 'add'} ${username ?? '<usuario>'}`,
      "  ou escreva o -- entre aspas: npm run user '--' add <usuario> --perms all",
    ].join('\n'),
  );
}

/** Pergunta algo no terminal (com valor padrão). Fora de um terminal, usa o padrão. */
async function ask(question: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) =>
    rl.question(`${question} [${fallback}]: `, resolve),
  );
  rl.close();
  return answer.trim() || fallback;
}

/** Permissões de --perms; sem a opção, pergunta no terminal. */
async function parsePerms(): Promise<ServerPermissions> {
  let raw = values.perms;
  if (!raw) {
    if (!process.stdin.isTTY) fail('informe --perms (ex.: view,hangup ou all)');
    console.log(`Permissões disponíveis: ${PERMISSIONS.join(', ')} (ou "all" para todas)`);
    raw = await ask('Permissões, separadas por vírgula', 'all');
  }
  const list = raw === 'all' ? [...PERMISSIONS] : raw.split(',').map((p) => p.trim());
  const invalid = list.filter((p) => !(PERMISSIONS as readonly string[]).includes(p));
  if (invalid.length)
    fail(`permissões inválidas: ${invalid.join(', ')} (válidas: ${PERMISSIONS.join(', ')})`);
  return { [values.server ?? ALL_SERVERS]: list as Permission[] };
}

/** Lê a senha sem mostrar no terminal (ou da entrada padrão com --password-stdin). */
async function readPassword(prompt: string): Promise<string> {
  if (values['password-stdin']) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\r?\n$/, '');
  }
  if (!process.stdin.isTTY) fail('terminal sem suporte a senha oculta; use --password-stdin');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const read = (q: string) =>
    new Promise<string>((resolve) => {
      process.stdout.write(q);
      // Silencia o eco do que é digitado
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
      rl.question('', (answer) => {
        process.stdout.write('\n');
        resolve(answer);
      });
    });
  const first = await read(prompt);
  const second = await read('Repita a senha: ');
  rl.close();
  if (first !== second) fail('as senhas não conferem');
  return first;
}

const auth = loadAuthConfig();
const repo = await UserRepository.open(auth.local.usersDbFile);

try {
  switch (command) {
    case 'add': {
      if (!username) fail('informe o usuário (ex.: npm run user add maria)');
      const name = values.name ?? (await ask('Nome de exibição', username));
      const perms = await parsePerms();
      const password = await readPassword(`Senha para ${username} (mínimo 10 caracteres): `);
      const user = repo.createUser({ username, name, password, perms });
      console.log(`Usuário criado: ${user.username} — ${JSON.stringify(user.perms)}`);
      break;
    }
    case 'list': {
      const users = repo.listUsers();
      if (users.length === 0) console.log('Nenhum usuário cadastrado.');
      for (const u of users) {
        console.log(
          `${u.active ? ' ' : 'x'} ${u.username.padEnd(20)} ${u.name.padEnd(25)} ${JSON.stringify(u.perms)}`,
        );
      }
      break;
    }
    case 'passwd': {
      if (!username) fail('informe o usuário');
      if (!repo.getByUsername(username)) fail(`usuário "${username}" não encontrado`);
      repo.setPassword(username, await readPassword(`Nova senha para ${username}: `));
      console.log('Senha alterada (sessões abertas foram encerradas).');
      break;
    }
    case 'perms': {
      if (!username) fail('informe o usuário');
      repo.setPerms(username, await parsePerms());
      console.log('Permissões alteradas (valem a partir da próxima renovação do token).');
      break;
    }
    case 'disable':
    case 'enable': {
      if (!username) fail('informe o usuário');
      repo.setActive(username, command === 'enable');
      console.log(command === 'enable' ? 'Usuário ativado.' : 'Usuário desativado.');
      break;
    }
    case 'remove': {
      if (!username) fail('informe o usuário');
      repo.removeUser(username);
      console.log('Usuário removido.');
      break;
    }
    default:
      fail('comando inválido. Use: add, list, passwd, perms, disable, enable ou remove');
  }
} catch (err) {
  fail((err as Error).message);
} finally {
  repo.close();
}
