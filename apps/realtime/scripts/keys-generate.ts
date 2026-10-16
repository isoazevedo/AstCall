/**
 * Gera o par de chaves RS256 do emissor local (modo standalone).
 *
 * Uso: npm run keys:generate [-- --force]
 *
 * Os caminhos vêm do .env (LOCAL_JWT_PRIVATE_KEY_FILE / LOCAL_JWT_PUBLIC_KEY_FILE).
 * Trocar as chaves invalida todos os tokens emitidos (os usuários renovam pelo cookie).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { loadAuthConfig } from '../src/config/index.js';

const force = process.argv.includes('--force');
const { privateKeyFile, publicKeyFile } = loadAuthConfig().local;

if (!force && (existsSync(privateKeyFile) || existsSync(publicKeyFile))) {
  console.error(
    `As chaves já existem:\n  ${privateKeyFile}\n  ${publicKeyFile}\n` +
      'Use --force para substituí-las (invalida os tokens atuais).',
  );
  process.exit(1);
}

const { privateKey, publicKey } = await generateKeyPair('RS256', {
  modulusLength: 2048,
  extractable: true,
});

mkdirSync(dirname(privateKeyFile), { recursive: true });
mkdirSync(dirname(publicKeyFile), { recursive: true });
// 0o600: só o dono lê a chave privada (no Windows o modo é ignorado)
writeFileSync(privateKeyFile, await exportPKCS8(privateKey), { mode: 0o600 });
writeFileSync(publicKeyFile, await exportSPKI(publicKey));

console.log(`Chaves geradas:\n  privada: ${privateKeyFile}\n  pública: ${publicKeyFile}`);
