import { describe, expect, it } from 'vitest';
import { amiEnvName, buildConfig, ConfigError } from '../src/config/index.js';

const ROOT = '/raiz';

/** Simula a leitura de arquivos a partir de um dicionário caminho → conteúdo. */
function fakeFs(files: Record<string, unknown>) {
  return (path: string): string => {
    const key = path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
    if (!(key in files)) throw new Error('arquivo não encontrado');
    return JSON.stringify(files[key]);
  };
}

const servers = {
  servers: [
    { id: 'pbx1', name: 'Principal', host: '10.0.0.1' },
    { id: 'pbx-2', name: 'Filial', host: '10.0.0.2', port: 5039, enabled: false },
  ],
};

const baseEnv = { AMI_PBX1_USERNAME: 'astcall', AMI_PBX1_SECRET: 'segredo' };

describe('amiEnvName', () => {
  it('converte o id do servidor em nome de variável', () => {
    expect(amiEnvName('pbx-2', 'SECRET')).toBe('AMI_PBX_2_SECRET');
  });
});

describe('buildConfig', () => {
  it('monta a configuração com padrões e ignora servidores desabilitados', () => {
    const cfg = buildConfig(baseEnv, fakeFs({ '/raiz/config/servers.json': servers }), ROOT);
    expect(cfg.http).toEqual({ host: '127.0.0.1', port: 8090, trustProxy: false });
    expect(cfg.auth.local.cookieSecure).toBe(false); // desenvolvimento
    expect(cfg.auth.mode).toBe('local');
    expect(cfg.servers).toHaveLength(1);
    expect(cfg.servers[0]).toMatchObject({ id: 'pbx1', port: 5038, username: 'astcall' });
  });

  it('exige credenciais AMI no ambiente', () => {
    expect(() => buildConfig({}, fakeFs({ '/raiz/config/servers.json': servers }), ROOT)).toThrow(
      /AMI_PBX1_USERNAME, AMI_PBX1_SECRET/,
    );
  });

  it('explica quando o arquivo de servidores não existe', () => {
    expect(() => buildConfig(baseEnv, fakeFs({}), ROOT)).toThrow(ConfigError);
  });

  it('rejeita id de servidor inválido', () => {
    const bad = { servers: [{ id: 'PBX 1', name: 'x', host: 'h' }] };
    expect(() => buildConfig(baseEnv, fakeFs({ '/raiz/config/servers.json': bad }), ROOT)).toThrow(
      /servers\.0\.id/,
    );
  });

  it('exige a chave pública externa quando AUTH_MODE não é local', () => {
    expect(() =>
      buildConfig(
        { ...baseEnv, AUTH_MODE: 'both' },
        fakeFs({ '/raiz/config/servers.json': servers }),
        ROOT,
      ),
    ).toThrow(/EXTERNAL_JWT_PUBLIC_KEY_FILE/);
  });
});
