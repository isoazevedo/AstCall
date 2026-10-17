import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError, type RouteHandler } from './server.js';

/** Tipos de conteúdo dos arquivos servidos (lista fechada). */
const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serve arquivos estáticos de uma pasta, por NOME (sem subpastas, sem "..").
 * Usado para entregar o Web Component (`ast-monitor.js`) ao AzCall: assim a versão do painel
 * acompanha a do backend que o atende.
 *
 * Cache: ETag baseado em tamanho + data de modificação; o navegador revalida a cada carga.
 */
export function staticRoutes(
  dir: string,
  files: string[],
  prefix = '/static/',
): Record<string, RouteHandler> {
  const routes: Record<string, RouteHandler> = {};
  for (const file of files) {
    const ext = file.slice(file.lastIndexOf('.'));
    const type = TYPES[ext];
    if (!type || file.includes('/') || file.includes('\\') || file.includes('..')) {
      throw new Error(`arquivo estático não permitido: ${file}`);
    }
    routes[`GET ${prefix}${file}`] = async ({ req, res }) => {
      const path = join(dir, file);
      let info;
      try {
        info = await stat(path);
      } catch {
        throw new HttpError(404, 'não encontrado (o frontend foi compilado?)');
      }
      const etag = `"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
      // Este arquivo pode ser cacheado (diferente das respostas de API)
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('ETag', etag);
      if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', type);
      res.end(await readFile(path));
    };
  }
  return routes;
}
