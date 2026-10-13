// Escopo por pasta (HABBLAUD_PROJECT_ROOTS) de um arquivo inteiro: transcript do Claude Code, rollout do Codex ou
// conversa do Grok (`grok`: conta também o `current_dir`, ver cwdsInText).
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { cwdsInText } from '../model/rooms';

/** O que o arquivo inteiro diz sobre o escopo por pasta (fileScope). */
export type FileScope = { status: 'in' } | { status: 'out'; cwd: string } | { status: 'unknown' };

const SCAN_CHUNK = 4 * 1024 * 1024;
/** Sobra do bloco anterior relida no seguinte: um "cwd" cortado na divisa ainda é achado. */
const SCAN_OVERLAP = 8 * 1024;
/** ponytail: cache simples por caminho, zerado inteiro ao passar do teto (LRU se um dia fizer falta). */
const SCAN_CACHE_MAX = 2_000;
const scanCache = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; scope: (cwd: string) => boolean; grok: boolean; result: FileScope }>();

/**
 * Escopo por pasta do arquivo inteiro: 'in' só se ele cita alguma pasta e todas estão no escopo; 'out' com a
 * primeira de fora; 'unknown' sem nenhuma (ainda sem linha com cwd, ou ilegível). Lê o arquivo todo em blocos (só o
 * que mudou de tamanho ou de mtime é relido), para nada de outra pasta escapar por estar fora da janela lida.
 */
export function fileScope(path: string, scope: (cwd: string) => boolean, grok = false): FileScope {
  let size: number;
  let mtimeMs: number;
  // ctime também: o mtime dá para voltar com utimes, o ctime não.
  let ctimeMs: number;
  try {
    ({ size, mtimeMs, ctimeMs } = statSync(path));
  } catch {
    return { status: 'unknown' };
  }
  const hit = scanCache.get(path);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs && hit.ctimeMs === ctimeMs && hit.scope === scope && hit.grok === grok) return hit.result;
  let result: FileScope = { status: 'unknown' };
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(SCAN_CHUNK);
      // StringDecoder: um caractere de vários bytes cortado na divisa dos blocos sai inteiro no bloco seguinte.
      const decoder = new StringDecoder('utf8');
      let carry = '';
      for (let pos = 0; pos < size; ) {
        const n = readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        pos += n;
        const text = carry + decoder.write(buf.subarray(0, n));
        for (const cwd of cwdsInText(text, grok)) {
          if (!scope(cwd)) {
            result = { status: 'out', cwd };
            break;
          }
          result = { status: 'in' };
        }
        if (result.status === 'out') break;
        // A sobra começa no último "cwd" (ou "current_dir") se ele está perto do fim (o valor pode vir só no bloco seguinte, depois de
        // espaços); senão, os últimos bytes, para uma chave cortada no meio.
        const last = Math.max(text.lastIndexOf('"cwd"'), grok ? text.lastIndexOf('"current_dir"') : -1);
        carry = text.slice(last >= 0 && last >= text.length - SCAN_CHUNK / 4 ? Math.min(last, text.length - SCAN_OVERLAP) : -SCAN_OVERLAP);
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return { status: 'unknown' };
  }
  if (scanCache.size >= SCAN_CACHE_MAX) scanCache.clear();
  scanCache.set(path, { size, mtimeMs, ctimeMs, scope, grok, result });
  return result;
}
