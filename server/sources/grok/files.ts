// Arquivos do Grok (CLI `grok`, GROK_HOME ou ~/.grok). Node puro e sem dependências do servidor: também é importado
// por scripts/docker-up.ts (via tsx) no host.
//
// - active_sessions.json: as sessões ABERTAS (session_id, pid, cwd, opened_at), mantido pelo próprio Grok;
// - sessions/<cwd codificado>/<session_id>/: uma pasta por sessão, agrupada pela pasta de trabalho (encodeURIComponent
//   do cwd; nome longo demais vira slug + hash, com o caminho original num arquivo `.cwd` do grupo). Dela o Habblaud
//   lê só `updates.jsonl` (a conversa, no formato de updates do ACP), `summary.json` (título, cwd, horários) e
//   `usage.json` (tokens e custo de cada turno, para o consumo da conta).
//
// Privacidade: NUNCA lê auth.json, config.toml nem nada fora de active_sessions.json e sessions/.
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { maskSecrets, truncate } from '../../../shared/activity';
import { expandHome } from '../../accounts/detect';

export const ACTIVE_FILE = 'active_sessions.json';
export const SESSIONS_DIR = 'sessions';
export const UPDATES_FILE = 'updates.jsonl';
export const SUMMARY_FILE = 'summary.json';
export const USAGE_FILE = 'usage.json';
/** O Grok grava o custo em "ticks": 1 dólar = 10^10 ticks (o mesmo da API da xAI). */
const USD_TICKS = 1e10;

/** Id de sessão aceito (UUID do Grok ou o `-s` de um cliente): nada de barra nem `..`. */
export function isGrokSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes('..');
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Pasta do Grok observada: HABBLAUD_GROK_DIR (no Docker, a montada) ou GROK_HOME ou ~/.grok. Só vale se tiver
 * sessions/ ou active_sessions.json (o Grok já rodou ali).
 */
export function discoverGrokDir(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string | undefined {
  const raw = env.HABBLAUD_GROK_DIR?.trim() || env.GROK_HOME?.trim();
  const dir = raw ? expandHome(raw, home) : join(home, '.grok');
  if (isDir(join(dir, SESSIONS_DIR))) return dir;
  try {
    statSync(join(dir, ACTIVE_FILE));
    return dir;
  } catch {
    return undefined;
  }
}

export interface ActiveSession {
  sessionId: string;
  pid?: number;
  cwd: string;
  openedAt?: number;
}

/** Sessões abertas segundo o Grok. null = arquivo ausente ou ilegível (escrita no meio): o chamador mantém o que tinha. */
export function readActiveSessions(dir: string): ActiveSession[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, ACTIVE_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const out: ActiveSession[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const sessionId = str(r.session_id);
    const cwd = str(r.cwd);
    if (!sessionId || !isAbsCwd(cwd) || !isGrokSessionId(sessionId)) continue;
    const s: ActiveSession = { sessionId, cwd };
    if (typeof r.pid === 'number' && Number.isInteger(r.pid) && r.pid > 0) s.pid = r.pid;
    const opened = str(r.opened_at) ? Date.parse(r.opened_at as string) : NaN;
    if (Number.isFinite(opened)) s.openedAt = opened;
    out.push(s);
  }
  return out;
}

/** Caminho absoluto, sem `.` nem `..` (o cwd de active_sessions.json, do summary.json ou de um `.cwd`). */
export function isAbsCwd(p: string | undefined): p is string {
  return !!p && p.startsWith('/') && !p.includes('\0') && !p.split('/').some((seg) => seg === '.' || seg === '..');
}

/** Raiz real de sessions/ (realpath), ou undefined. */
function realRoot(dir: string): string | undefined {
  try {
    return realpathSync(join(dir, SESSIONS_DIR));
  } catch {
    return undefined;
  }
}

/**
 * `p` existe, é do tipo pedido, nenhum componente entre sessions/ e ele é link simbólico (nem o grupo, nem a pasta da
 * sessão, nem o arquivo) e o caminho real fica dentro de `root` (a raiz real de sessions/): um link ou um `..` nunca
 * leva a leitura para fora das conversas nem para a conversa de outro grupo.
 */
function inside(root: string, base: string, p: string, kind: 'dir' | 'file'): boolean {
  try {
    const rel = relative(base, p);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
    let cur = base;
    const parts = rel.split(sep);
    for (let i = 0; i < parts.length; i++) {
      cur = join(cur, parts[i]);
      const st = lstatSync(cur);
      if (st.isSymbolicLink()) return false;
      const last = i === parts.length - 1;
      if (!last && !st.isDirectory()) return false;
      if (last && (kind === 'dir' ? !st.isDirectory() : !st.isFile())) return false;
    }
    return realpathSync(p).startsWith(`${root}${sep}`);
  } catch {
    return false;
  }
}

/** Pasta de trabalho de uma sessão: a do summary.json ou, sem ela, a do grupo. */
export function sessionCwd(sessionDir: string): string | undefined {
  const fromSummary = readSummary(sessionDir).cwd;
  if (fromSummary) return fromSummary;
  const groupDir = dirname(sessionDir);
  return groupCwd(groupDir, basename(groupDir));
}

/**
 * Pasta da sessão, sempre dentro de sessions/. Com `cwd`: o grupo dele (encodeURIComponent, o caso comum) ou outro
 * grupo cujo cwd (`.cwd` ou summary.json) seja exatamente esse (nome longo demais vira slug + hash): o mesmo id em
 * outra pasta nunca serve. Sem `cwd` (histórico): o único grupo com esse id; mais de um = ambíguo, undefined.
 */
export function findSessionDir(dir: string, sessionId: string, cwd?: string): string | undefined {
  if (!isGrokSessionId(sessionId)) return undefined;
  if (cwd !== undefined && !isAbsCwd(cwd)) return undefined;
  const root = realRoot(dir);
  if (!root) return undefined;
  const base = join(dir, SESSIONS_DIR);
  if (cwd) {
    const direct = join(base, encodeURIComponent(cwd), sessionId);
    if (inside(root, base, direct, 'dir')) return direct;
  }
  let groups: string[];
  try {
    groups = readdirSync(base);
  } catch {
    return undefined;
  }
  const found: string[] = [];
  for (const g of groups) {
    const p = join(base, g, sessionId);
    if (!inside(root, base, p, 'dir')) continue;
    if (cwd && sessionCwd(p) !== cwd) continue;
    found.push(p);
  }
  return found.length === 1 ? found[0] : undefined;
}

/** A pasta da sessão continua dentro de sessions/, sem link em nenhum componente (o grupo pode ter virado link). */
export function sessionDirOk(dir: string, sessionDir: string): boolean {
  const root = realRoot(dir);
  return !!root && inside(root, join(dir, SESSIONS_DIR), sessionDir, 'dir');
}

/** `path` é o updates.jsonl de uma sessão, dentro de sessions/ e sem links: o terminal confere antes de cada leitura. */
export function updatesPathOk(dir: string, path: string): boolean {
  return basename(path) === UPDATES_FILE && updatesPathOf(dir, dirname(path)) === path;
}

/** updates.jsonl da sessão, se for um arquivo de verdade dentro de sessions/. */
export function updatesPathOf(dir: string, sessionDir: string): string | undefined {
  const root = realRoot(dir);
  const p = join(sessionDir, UPDATES_FILE);
  return root && inside(root, join(dir, SESSIONS_DIR), p, 'file') ? p : undefined;
}

/** Pasta de trabalho de um grupo de sessions/: o `.cwd` de um nome longo demais, ou o nome decodificado. */
export function groupCwd(groupDir: string, name: string): string | undefined {
  try {
    const file = join(groupDir, '.cwd');
    if (lstatSync(file).isFile()) {
      const cwd = readFileSync(file, 'utf8').trim();
      return isAbsCwd(cwd) ? cwd : undefined;
    }
  } catch {
    // sem .cwd: o nome é o cwd codificado
  }
  try {
    const decoded = decodeURIComponent(name);
    return isAbsCwd(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sessões com a conversa modificada desde `since` (epoch ms), com o cwd do summary.json (ou do grupo). É a presença
 * no Docker: active_sessions.json é trocado por rename (active_sessions.json.tmp), e um bind de arquivo único ficaria
 * preso à versão antiga.
 */
export function recentSessions(dir: string, since: number): ActiveSession[] {
  const root = realRoot(dir);
  if (!root) return [];
  const base = join(dir, SESSIONS_DIR);
  const out: ActiveSession[] = [];
  let groups: string[];
  try {
    groups = readdirSync(base);
  } catch {
    return [];
  }
  for (const g of groups) {
    const groupDir = join(base, g);
    let ids: string[];
    try {
      ids = readdirSync(groupDir);
    } catch {
      continue;
    }
    for (const id of ids) {
      if (!isGrokSessionId(id)) continue;
      const sessionDir = join(groupDir, id);
      const updates = updatesPathOf(dir, sessionDir);
      if (!updates) continue;
      let mtime: number;
      try {
        mtime = statSync(updates).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < since) continue;
      const cwd = sessionCwd(sessionDir);
      if (cwd) out.push({ sessionId: id, cwd, openedAt: mtime });
    }
  }
  return out;
}

/**
 * Consumo de todas as sessões (os `usage.json`, só arquivos de verdade dentro de sessions/): custo e tokens dos turnos
 * que terminaram nas últimas 5 h e nos últimos 7 dias. Sessão cujo usage.json não muda há mais de 7 dias nem é lida.
 */
export function usageTotals(dir: string, now: number): { fiveHour: { costUsd: number; tokens: number }; sevenDay: { costUsd: number; tokens: number } } {
  const fiveHour = { costUsd: 0, tokens: 0 };
  const sevenDay = { costUsd: 0, tokens: 0 };
  const out = { fiveHour, sevenDay };
  const root = realRoot(dir);
  if (!root) return out;
  const base = join(dir, SESSIONS_DIR);
  const weekAgo = now - 7 * 86_400_000;
  const fiveAgo = now - 5 * 3_600_000;
  let groups: string[];
  try {
    groups = readdirSync(base);
  } catch {
    return out;
  }
  for (const g of groups) {
    let ids: string[];
    try {
      ids = readdirSync(join(base, g));
    } catch {
      continue;
    }
    for (const id of ids) {
      if (!isGrokSessionId(id)) continue;
      const file = join(base, g, id, USAGE_FILE);
      if (!inside(root, base, file, 'file')) continue;
      let turns: unknown;
      try {
        if (statSync(file).mtimeMs < weekAgo) continue;
        turns = (JSON.parse(readFileSync(file, 'utf8')) as { turns?: unknown }).turns;
      } catch {
        continue;
      }
      if (!Array.isArray(turns)) continue;
      for (const t of turns as Array<Record<string, unknown>>) {
        const at = typeof t?.endedAt === 'string' ? Date.parse(t.endedAt) : NaN;
        if (!(at >= weekAgo && at <= now)) continue;
        const cost = typeof t.costUsdTicks === 'number' && t.costUsdTicks > 0 ? t.costUsdTicks / USD_TICKS : 0;
        const tokens = typeof t.totalTokens === 'number' && t.totalTokens > 0 ? t.totalTokens : 0;
        sevenDay.costUsd += cost;
        sevenDay.tokens += tokens;
        if (at >= fiveAgo) {
          fiveHour.costUsd += cost;
          fiveHour.tokens += tokens;
        }
      }
    }
  }
  // Arredonda no centavo de centavo: a soma de frações não vira 1.7500000000000002.
  for (const w of [fiveHour, sevenDay]) w.costUsd = Math.round(w.costUsd * 1e4) / 1e4;
  return out;
}

export interface GrokSummary {
  title?: string;
  cwd?: string;
  model?: string;
  createdAt?: number;
  updatedAt?: number;
  /** `session_kind` ('subagent', 'headless'); ausente = sessão do TUI. Subagentes ficam fora do histórico. */
  kind?: string;
  /** O summary.json foi lido e é um objeto JSON (ausente, ilegível ou link = false): só então `kind` ausente é TUI. */
  ok?: boolean;
}

/** summary.json da sessão (o índice que o próprio Grok usa no /resume). */
export function readSummary(sessionDir: string): GrokSummary {
  let raw: Record<string, unknown>;
  try {
    const file = join(sessionDir, SUMMARY_FILE);
    if (!lstatSync(file).isFile()) return {};
    raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: GrokSummary = { ok: true };
  const info = raw.info && typeof raw.info === 'object' ? (raw.info as Record<string, unknown>) : {};
  const title = str(raw.generated_title) ?? str(raw.session_summary);
  if (title) out.title = truncate(maskSecrets(title.slice(0, 1_000)), 120);
  const cwd = str(info.cwd);
  if (isAbsCwd(cwd)) out.cwd = cwd;
  const model = str(raw.current_model_id);
  if (model) out.model = model;
  const created = str(raw.created_at) ? Date.parse(raw.created_at as string) : NaN;
  if (Number.isFinite(created)) out.createdAt = created;
  const updated = str(raw.updated_at) ? Date.parse(raw.updated_at as string) : NaN;
  if (Number.isFinite(updated)) out.updatedAt = updated;
  const kind = str(raw.session_kind);
  if (kind) out.kind = kind;
  return out;
}
