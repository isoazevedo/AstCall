/**
 * Gera os prints da documentação (docs/img) com o Edge/Chrome em modo headless.
 *
 * Pré-requisitos (três terminais, na raiz do repositório):
 *   npm run demo        → PBX simulado + backend (nada real aparece nos prints)
 *   npm run dev:web     → painel em http://localhost:5173
 *   npm run screenshots → este script
 *
 * Login: um usuário do standalone com todas as permissões, informado por variáveis de
 * ambiente (SHOT_USER / SHOT_PASSWORD). Opções:
 *   --out docs/img       pasta de saída
 *   --copy <pasta>       copia os PNGs também para outra pasta
 *   --url http://localhost:5173
 *   --browser <caminho>  Edge/Chrome (detectado automaticamente)
 *
 * Funciona pelo Chrome DevTools Protocol (CDP), sem dependências novas: o navegador é
 * aberto com --remote-debugging-port e controlado por WebSocket.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { WebSocket } from 'ws';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'docs/img' },
    copy: { type: 'string' },
    url: { type: 'string', default: 'http://localhost:5173' },
    browser: { type: 'string' },
  },
});

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const OUT = resolve(ROOT, values.out);
const BASE = values.url;
const USER = process.env.SHOT_USER;
const PASSWORD = process.env.SHOT_PASSWORD;
if (!USER || !PASSWORD) {
  console.error(
    'Defina SHOT_USER e SHOT_PASSWORD (usuário do standalone com todas as permissões).',
  );
  process.exit(1);
}

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browserPath = values.browser ?? BROWSERS.find((p) => existsSync(p));
if (!browserPath) {
  console.error('Edge/Chrome não encontrado; informe --browser <caminho>.');
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ CDP mínimo

class Cdp {
  private seq = 0;
  private readonly pending = new Map<number, (r: { result?: unknown; error?: unknown }) => void>();
  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { id?: number; result?: unknown; error?: unknown };
      if (msg.id !== undefined) this.pending.get(msg.id)?.(msg);
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    await new Promise((r, j) => ws.once('open', r).once('error', j));
    return new Cdp(ws);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) =>
      this.pending.set(id, (r) =>
        r.error
          ? reject(new Error(`${method}: ${JSON.stringify(r.error)}`))
          : resolve(r.result as T),
      ),
    );
  }

  /** Executa JS na página (aceita await) e devolve o valor. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string } }>(
      'Runtime.evaluate',
      { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true },
    );
    if (r.exceptionDetails) throw new Error(`erro no JS da página: ${r.exceptionDetails.text}`);
    return r.result.value;
  }

  close(): void {
    this.ws.close();
  }
}

// ------------------------------------------------------------------ roteiro dos prints

/** Funções usadas dentro da página (o painel vive no Shadow DOM do <ast-monitor>). */
const HELPERS = `
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const root = (tag = 'ast-monitor') => document.querySelector(tag)?.shadowRoot;
  const byText = (scope, sel, text) => [...scope.querySelectorAll(sel)].find((e) => e.textContent.includes(text));
  async function until(fn, ms = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await wait(200); }
    throw new Error('tempo esgotado esperando a tela');
  }
`;

interface Shot {
  file: string;
  path: string;
  theme: 'dark' | 'light';
  /** Captura a página inteira (altura medida depois de preparar a tela). */
  fullPage?: boolean;
  /** Tamanho da tela (padrão 1440×900); o modo TV usa Full HD, como numa TV. */
  size?: [number, number];
  /** JS executado depois de carregar (prepara a tela: abas, menus, diálogos). */
  prepare?: string;
  /** localStorage antes de carregar (ex.: preferência do modo TV). */
  storage?: Record<string, string>;
  desc: string;
}

const MONITOR_READY = `await until(() => root()?.querySelector('.ast-stat'));
  await until(() => root().querySelector('.calls tbody tr'));`;

const SHOTS: Shot[] = [
  { file: 'login.png', path: '/', theme: 'light', desc: 'tela de login', prepare: '' },
  {
    file: 'painel-escuro.png',
    path: '/',
    theme: 'dark',
    fullPage: true,
    desc: 'visão geral (tema escuro)',
    prepare: MONITOR_READY,
  },
  {
    file: 'painel-claro.png',
    path: '/',
    theme: 'light',
    fullPage: true,
    desc: 'visão geral (tema claro)',
    prepare: MONITOR_READY,
  },
  {
    file: 'menu-chamada.png',
    path: '/',
    theme: 'dark',
    desc: 'menu de ações de uma chamada',
    prepare: `${MONITOR_READY}
      const row = await until(() => byText(root(), '.calls tbody tr', 'Em conversa'));
      row.querySelector('.am-trigger').click(); await wait(400);`,
  },
  {
    file: 'escuta.png',
    path: '/',
    theme: 'dark',
    desc: 'diálogo de escuta',
    prepare: `${MONITOR_READY}
      const row = await until(() => byText(root(), '.calls tbody tr', 'Em conversa'));
      row.querySelector('.am-trigger').click(); await wait(300);
      byText(root(), '.am-item', 'Escutar').click(); await wait(400);
      const input = root().querySelector('.dlg .ast-input'); input.value = '2010';
      input.dispatchEvent(new Event('input')); await wait(200);`,
  },
  {
    file: 'filas.png',
    path: '/',
    theme: 'dark',
    fullPage: true,
    desc: 'aba Filas',
    prepare: `${MONITOR_READY}
      byText(root(), '.ast-tab', 'Filas').click();
      await until(() => root().querySelector('.queue .members li')); await wait(500);`,
  },
  {
    file: 'menu-membro.png',
    path: '/',
    theme: 'dark',
    desc: 'menu de ações de um membro de fila',
    prepare: `${MONITOR_READY}
      byText(root(), '.ast-tab', 'Filas').click();
      const li = await until(() => root().querySelector('.queue .members li'));
      li.querySelector('.am-trigger').click(); await wait(400);`,
  },
  {
    file: 'adicionar-membro.png',
    path: '/',
    theme: 'dark',
    desc: 'diálogo para adicionar membro',
    prepare: `${MONITOR_READY}
      byText(root(), '.ast-tab', 'Filas').click();
      (await until(() => root().querySelector('.m-btn.add'))).click(); await wait(400);`,
  },
  {
    file: 'tv-filas.png',
    path: '/?tv',
    theme: 'dark',
    desc: 'modo TV — filas',
    size: [1920, 1080],
    storage: { 'astcall.tv': JSON.stringify({ rotate: false, screen: 'queues' }) },
    prepare: `await until(() => root()?.querySelector('.tv-queue')); await wait(1500);`,
  },
  {
    file: 'tv-chamadas.png',
    path: '/?tv',
    theme: 'dark',
    desc: 'modo TV — chamadas e ramais',
    size: [1920, 1080],
    storage: { 'astcall.tv': JSON.stringify({ rotate: false, screen: 'calls' }) },
    prepare: `await until(() => root()?.querySelector('.tv-call')); await wait(1500);`,
  },
  {
    file: 'widgets.png',
    path: '/?widgets=suporte',
    theme: 'light',
    fullPage: true,
    desc: 'página de exemplo com widgets',
    prepare: `await until(() => root('ast-filas')?.querySelector('.queue'));
      await until(() => root('ast-chamadas')?.querySelector('.calls tbody tr')); await wait(800);`,
  },
  {
    file: 'usuarios.png',
    path: '/#usuarios',
    theme: 'light',
    desc: 'tela de usuários',
    prepare: `await until(() => document.querySelector('tbody tr')); await wait(300);`,
  },
];

// ------------------------------------------------------------------ execução

const profile = mkdtempSync(join(tmpdir(), 'astcall-shots-'));
const PORT = 9333;
const browser = spawn(
  browserPath,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-extensions',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

try {
  // espera o navegador abrir a porta de depuração
  let pageWs = '';
  for (let i = 0; i < 50 && !pageWs; i++) {
    await sleep(200);
    try {
      const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as {
        type: string;
        webSocketDebuggerUrl: string;
      }[];
      pageWs = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? '';
    } catch {
      // ainda abrindo
    }
  }
  if (!pageWs) throw new Error('não foi possível controlar o navegador');
  const cdp = await Cdp.connect(pageWs);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const go = async (path: string) => {
    await cdp.send('Page.navigate', { url: BASE + path });
    await sleep(1500);
  };

  // Primeiro o print da tela de login (antes de entrar)
  mkdirSync(OUT, { recursive: true });
  const saved: string[] = [];
  for (const shot of SHOTS) {
    const [width, height] = shot.size ?? [1440, 900];
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: shot.theme }],
    });

    if (shot.file !== 'login.png' && saved.length === 1) {
      // entra uma vez (o cookie de sessão fica no perfil temporário do navegador)
      await go('/');
      const ok = await cdp.eval<boolean>(`
        const r = await fetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASSWORD)} }) });
        return r.ok;`);
      if (!ok) throw new Error('login falhou (confira SHOT_USER e SHOT_PASSWORD)');
    }

    if (shot.storage) {
      await go('/');
      for (const [k, v] of Object.entries(shot.storage)) {
        await cdp.eval(`localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`);
      }
    }
    await go(shot.path);
    if (shot.file === 'login.png') {
      await cdp.eval(
        `${HELPERS} await until(() => document.querySelector('input[type=password]'));`,
      );
    } else if (shot.prepare) {
      await cdp.eval(`${HELPERS} ${shot.prepare}`);
    }
    if (shot.fullPage) {
      const h = await cdp.eval<number>('return document.documentElement.scrollHeight;');
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: Math.min(Math.max(h, 900), 3000),
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
    await sleep(300);
    const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    const file = join(OUT, shot.file);
    writeFileSync(file, Buffer.from(data, 'base64'));
    saved.push(file);
    console.log(`✓ ${shot.file.padEnd(22)} ${shot.desc}`);
  }

  if (values.copy) {
    mkdirSync(values.copy, { recursive: true });
    for (const f of saved) copyFileSync(f, join(values.copy, f.split(/[\\/]/).pop()!));
    console.log(`\nCopiados também para ${values.copy}`);
  }
  cdp.close();
} finally {
  browser.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
