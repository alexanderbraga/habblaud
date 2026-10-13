// Histórico do terminal do Grok (o HistoryProvider 'grok', ver sources/source.ts): as sessões recentes (abertas ou já
// encerradas) de sessions/<cwd>/<id>/, pelo summary.json de cada uma (título, cwd, horários) e o tamanho de
// updates.jsonl. Sessões de subagente ficam de fora, como os subagentes do Claude Code.
import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { RecentSession } from '../../../shared/types';
import { HISTORY_LIMIT, HISTORY_MAX_AGE_MS } from '../history';
import type { HistoryProvider, HistoryResolveResult } from '../source';
import { fileScope } from '../scope';
import { findSessionDir, groupCwd, isGrokSessionId, readSummary, SESSIONS_DIR, SUMMARY_FILE, updatesPathOf, updatesPathOk, type GrokSummary } from './files';
import { createGrokTerminalParser } from './updates';
import { tr } from '../../../shared/i18n';

export interface GrokHistoryOptions {
  /** A conta do Grok (id no AccountsService e pasta lida por este processo); undefined = sem Grok. */
  account: () => { id: string; dir: string } | undefined;
  openAgentOf: (account: string, sessionId: string) => string | undefined;
  now?: () => number;
  maxAgeMs?: number;
  limit?: number;
  /** Escopo por pasta: só sessões com cwd aceito entram, antes do limite. */
  inScope?: (project: string) => boolean;
}

export class GrokHistory implements HistoryProvider {
  readonly provider = 'grok' as const;
  private cache = new Map<string, { mtimeMs: number; summary: GrokSummary }>();
  private readonly now: () => number;

  constructor(private readonly opts: GrokHistoryOptions) {
    this.now = opts.now ?? Date.now;
  }

  hasAccount(account: string): boolean {
    return this.opts.account()?.id === account;
  }

  async list(): Promise<RecentSession[]> {
    const acc = this.opts.account();
    if (!acc) return [];
    const root = join(acc.dir, SESSIONS_DIR);
    const since = this.now() - (this.opts.maxAgeMs ?? HISTORY_MAX_AGE_MS);
    const out: RecentSession[] = [];
    let groups: string[];
    try {
      groups = readdirSync(root);
    } catch {
      return [];
    }
    for (const g of groups) {
      const groupDir = join(root, g);
      let ids: string[];
      try {
        ids = readdirSync(groupDir);
      } catch {
        continue;
      }
      for (const id of ids) {
        if (!isGrokSessionId(id)) continue;
        const dir = join(groupDir, id);
        const updatesPath = updatesPathOf(acc.dir, dir);
        if (!updatesPath) continue;
        let updates;
        try {
          updates = statSync(updatesPath);
        } catch {
          continue;
        }
        if (updates.mtimeMs < since) continue;
        const summary = this.summaryOf(dir);
        if (summary.kind === 'subagent') continue;
        const project = summary.cwd ?? groupCwd(groupDir, g);
        const inScope = this.opts.inScope;
        if (inScope && !(project && inScope(project))) continue;
        // A conversa inteira também: uma que passou por outra pasta não entra nem com título.
        if (inScope && fileScope(updatesPath, inScope, true).status === 'out') continue;
        const agentId = this.opts.openAgentOf(acc.id, id);
        const s: RecentSession = { account: acc.id, provider: 'grok', sessionId: id, projectDir: g, lastAt: updates.mtimeMs, size: updates.size, open: !!agentId };
        if (project) s.project = project;
        if (summary.title) s.title = summary.title;
        if (summary.createdAt !== undefined) s.firstAt = summary.createdAt;
        if (agentId) s.agentId = agentId;
        out.push(s);
      }
    }
    return out.sort((a, b) => b.lastAt - a.lastAt).slice(0, this.opts.limit ?? HISTORY_LIMIT);
  }

  resolve(account: string, sessionId: string): HistoryResolveResult {
    const acc = this.opts.account();
    if (!acc || acc.id !== account) return { status: 404, error: tr('conta desconhecida') };
    if (!isGrokSessionId(sessionId)) return { status: 400, error: tr('id de sessão inválido') };
    const dir = findSessionDir(acc.dir, sessionId);
    const path = dir && updatesPathOf(acc.dir, dir);
    if (!dir || !path) return { status: 404, error: tr('sessão não encontrada') };
    const found: HistoryResolveResult = { path, createParser: () => createGrokTerminalParser(this.now), grok: true, check: (p) => updatesPathOk(acc.dir, p) };
    // A pasta da sessão nem sempre aparece no updates.jsonl: o escopo confere a do summary.json (ou a do grupo), a
    // mesma que a listagem mostra.
    const groupDir = dirname(dir);
    const cwd = this.summaryOf(dir).cwd ?? groupCwd(groupDir, basename(groupDir));
    if (cwd) found.cwd = cwd;
    return found;
  }

  private summaryOf(dir: string): GrokSummary {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(join(dir, SUMMARY_FILE)).mtimeMs;
    } catch {
      return {};
    }
    const hit = this.cache.get(dir);
    if (hit && hit.mtimeMs === mtimeMs) return hit.summary;
    const summary = readSummary(dir);
    this.cache.set(dir, { mtimeMs, summary });
    return summary;
  }
}
