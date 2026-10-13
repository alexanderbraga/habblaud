// O Codex atrás do AgentRuntime. Sessões hospedadas pelo Habblaud rodam num `codex app-server` por CODEX_HOME:
// Novo agente abre um thread; "Assumir daqui" encerra o TUI conferido e retoma a conversa; encerrar interrompe e larga.
// Mensagens hospedadas vão pelo app-server; as sessões do TUI continuam usando `codex queue`. Pedidos do agente
// entram no PermissionRegistry; sem resposta (ou sem ninguém olhando), recusam/cancelam.
import { randomUUID } from 'node:crypto';
import type { AgentInfo } from '../../shared/types';
import { ASK_TOOL } from '../../shared/answers';
import { tr } from '../../shared/i18n';
import type { CodexQueueRunner } from '../messages/codex';
import type { WaitResult } from '../permissions/registry';
import type { SpawnSubmit } from '../spawn/spawn';
import { findCodexTui, stopCodexTui } from './codex-tui';
import type { CodexAgentReply, CodexAgentRequest, CodexAppServer } from './protocol/codex-app';
import { RuntimeError, type AgentRuntime, type RuntimeCapabilities, type TakeoverResult } from './runtime';

export type CodexAppServerLike = Pick<CodexAppServer, 'startThread' | 'resumeThread' | 'send' | 'interrupt' | 'release' | 'hosts'>;

export interface CodexRuntimeOptions {
  homeOf: (account: string) => string | undefined;
  agent: (id: string) => AgentInfo | undefined;
  accounts: () => string[];
  app: (codexHome: string) => CodexAppServerLike;
  queue?: CodexQueueRunner;
  permissions?: {
    register(raw: unknown): { id: string; expiresAt: number } | { skip: string };
    wait(id: string, ms: number): { result: Promise<WaitResult> } | undefined;
  };
  tui?: { find: typeof findCodexTui; stop: typeof stopCodexTui };
  /** No container, o auxiliar do host assume e encerra a sessão inteira (inclusive o TUI). */
  delegate?: boolean;
  /** Caminho real da sala; sem resolução, usa roomId para os runtimes sem Office. */
  cwdOf?: (a: AgentInfo) => string | undefined;
  agentIdOf: (account: string, threadId: string) => string;
}

const ANSWER_WAIT_MS = 300_000;

export class CodexRuntime implements AgentRuntime {
  readonly provider = 'codex' as const;

  constructor(private readonly opts: CodexRuntimeOptions) {}

  capabilities(a: AgentInfo): RuntimeCapabilities {
    const home = this.opts.homeOf(a.account);
    const ok = a.kind === 'main' && !!home;
    return { stop: ok, takeover: ok && !this.opts.app(home!).hosts(a.sessionId), spawn: this.opts.accounts().length > 0 };
  }

  readonly deliver: CodexQueueRunner = async (job) => {
    const app = this.opts.app(job.codexHome);
    if (this.opts.delegate || app.hosts(job.thread)) {
      try {
        await app.send(job.thread, job.text);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    if (!this.opts.queue) return { ok: false, error: tr('não há como entregar ao Codex agora') };
    return this.opts.queue(job);
  };

  async spawn(req: { folder: string; prompt: string; account?: string }): Promise<SpawnSubmit> {
    const account = req.account ?? this.opts.accounts()[0];
    const home = account ? this.opts.homeOf(account) : undefined;
    if (!home) return { error: 'unavailable', reason: tr('nenhuma conta do Codex encontrada') };
    try {
      await this.opts.app(home).startThread({ cwd: req.folder, prompt: req.prompt || undefined });
      return { spawn: { id: randomUUID(), folder: req.folder, status: 'opened' } };
    } catch (err) {
      return { error: 'unavailable', reason: (err as Error).message };
    }
  }

  async takeover(agentId: string): Promise<TakeoverResult> {
    const a = this.main(agentId);
    const home = this.homeOrFail(a);
    const app = this.opts.app(home);
    if (this.opts.delegate) {
      await app.resumeThread(a.sessionId);
      return { kind: 'hosted', agentId };
    }
    if (app.hosts(a.sessionId)) return { kind: 'hosted', agentId };
    const tui = await this.findTui(home, a.sessionId);
    if (tui) {
      const result = await (this.opts.tui?.stop ?? stopCodexTui)(tui);
      if (result === 'changed') throw new RuntimeError(409, tr('o processo do Codex mudou; nada foi encerrado'));
      if (result === 'stuck') throw new RuntimeError(409, tr('o Codex não encerrou a tempo; feche a sessão no terminal e tente de novo'));
    }
    try {
      await app.resumeThread(a.sessionId);
    } catch (err) {
      throw new RuntimeError(502, tr('não consegui retomar a conversa ({0}); para continuar no terminal: codex resume {1}', [(err as Error).message, a.sessionId]));
    }
    return { kind: 'hosted', agentId };
  }

  async stop(agentId: string): Promise<void> {
    const a = this.main(agentId);
    const home = this.homeOrFail(a);
    const app = this.opts.app(home);
    if (this.opts.delegate) return app.release(a.sessionId);
    if (app.hosts(a.sessionId)) {
      await app.interrupt(a.sessionId).catch(() => undefined);
      await app.release(a.sessionId);
      return;
    }
    const tui = await this.findTui(home, a.sessionId);
    if (!tui) throw new RuntimeError(404, tr('não achei o processo desta sessão do Codex'));
    const result = await (this.opts.tui?.stop ?? stopCodexTui)(tui);
    if (result === 'changed' || result === 'stuck') throw new RuntimeError(409, tr('não consegui encerrar a sessão do Codex'));
  }

  async onAgentRequest(account: string, r: CodexAgentRequest): Promise<CodexAgentReply> {
    const fail: CodexAgentReply = r.kind === 'question' ? { kind: 'question', answers: null } : { kind: 'approval', allow: false };
    const perms = this.opts.permissions;
    if (!perms) return fail;
    // Perguntas não trazem cwd no protocolo; o Office resolve o id da sala para o caminho da sessão.
    const a = r.kind === 'question' ? this.opts.agent(this.opts.agentIdOf(account, r.threadId)) : undefined;
    const cwd = r.kind === 'approval' ? r.cwd : a ? (this.opts.cwdOf ? this.opts.cwdOf(a) : a.roomId) : undefined;
    const raw = r.kind === 'question'
      ? { provider: 'codex', account, session_id: r.threadId, tool_name: ASK_TOOL, tool_input: { questions: r.questions.map((q) => ({ question: q.question, header: q.header, multiSelect: false, options: q.options })) }, cwd, timeout_ms: ANSWER_WAIT_MS }
      : { provider: 'codex', account, session_id: r.threadId, tool_name: r.tool, tool_input: r.input, cwd, timeout_ms: ANSWER_WAIT_MS };
    const reg = perms.register(raw);
    if ('skip' in reg) return fail;
    const deadline = Math.min(reg.expiresAt, Date.now() + ANSWER_WAIT_MS);
    let res: WaitResult;
    // O registro limita cada long-poll a 25 s; pending renova a espera, até o prazo total do pedido.
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return fail;
      const w = perms.wait(reg.id, remaining);
      if (!w) return fail;
      res = await w.result;
      if (res.status !== 'pending') break;
    }
    if (res.status !== 'decided') return fail;
    if (r.kind === 'approval') return { kind: 'approval', allow: res.behavior === 'allow' };
    if (res.behavior !== 'answer') return fail;
    const answers: Record<string, string[]> = {};
    for (const a of res.answers) {
      const q = r.questions[a.question];
      if (!q) continue;
      answers[q.id] = [...(a.options ?? []).map((i) => q.options[i]?.label).filter((x): x is string => !!x), ...(a.other ? [a.other] : [])];
    }
    return { kind: 'question', answers };
  }

  /** TUI dono do thread; não deu para conferir quem segura o lock = 409 com o motivo (nunca "já saiu"). */
  private async findTui(home: string, thread: string) {
    try {
      return await (this.opts.tui?.find ?? findCodexTui)(home, thread);
    } catch (err) {
      throw new RuntimeError(409, (err as Error).message);
    }
  }

  private main(agentId: string): AgentInfo {
    const a = this.opts.agent(agentId);
    if (!a || a.kind !== 'main') throw new RuntimeError(404, tr('agente não encontrado'));
    return a;
  }

  private homeOrFail(a: AgentInfo): string {
    const home = this.opts.homeOf(a.account);
    if (!home) throw new RuntimeError(404, tr('conta do Codex desconhecida'));
    return home;
  }
}
