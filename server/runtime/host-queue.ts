// Docker: o `codex app-server` precisa rodar no Mac (lá estão o Codex e as pastas). O CodexRuntime do container manda
// cada ação para esta fila; o auxiliar do host (npm run codex:bridge) busca em POST /api/host/runtime/poll, roda num
// CodexAppServer local e confirma em POST /api/host/runtime/ack, com a lista dos threads que ele hospeda.
import { randomUUID } from 'node:crypto';
import { tr } from '../../shared/i18n';
import type { CodexAppServerLike } from './codex';

export type HostAction =
  | { id: string; op: 'spawn'; account: string; codexHome: string; folder: string; prompt: string }
  | { id: string; op: 'takeover' | 'stop'; account: string; codexHome: string; thread: string }
  | { id: string; op: 'send'; account: string; codexHome: string; thread: string; text: string };
export type HostResult = { id: string; ok: true; hosted?: string[] } | { id: string; ok: false; error: string; status?: number };

/** `Omit` numa união só deixa as chaves comuns; isto tira `id` de cada ação. */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_PRESENCE_MS = 10_000;

export class HostQueue {
  private readonly waiting = new Map<string, { action: HostAction; sent: boolean; at: number; done: (r: HostResult) => void }>();
  private readonly hostedByHome = new Map<string, Set<string>>();
  private seenAt = -Infinity;
  private readonly now: () => number;

  constructor(private readonly opts: { now?: () => number; timeoutMs?: number; presenceMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  present(): boolean {
    return this.now() - this.seenAt <= (this.opts.presenceMs ?? DEFAULT_PRESENCE_MS);
  }

  hosted(codexHome: string, thread: string): boolean {
    return this.hostedByHome.get(codexHome)?.has(thread) ?? false;
  }

  /** Resolve com o ack, ou falha no prazo (o prazo é conferido quando o auxiliar busca). */
  submit(a: WithoutId<HostAction>): Promise<HostResult> {
    const action = { ...a, id: randomUUID() } as HostAction;
    return new Promise((done) => {
      this.waiting.set(action.id, { action, sent: false, at: this.now(), done });
      // Sem o auxiliar ninguém chama poll(): o prazo também corre sozinho, para o pedido não ficar pendurado.
      setTimeout(() => this.expire(), (this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 1).unref?.();
    });
  }

  poll(): HostAction[] {
    this.seenAt = this.now();
    this.expire();
    const out: HostAction[] = [];
    for (const w of this.waiting.values()) {
      if (w.sent) continue;
      w.sent = true;
      out.push(w.action);
    }
    return out;
  }

  ack(raw: unknown): void {
    const results = (raw as { results?: unknown })?.results;
    if (!Array.isArray(results)) return;
    for (const r of results as HostResult[]) {
      const w = r && typeof r.id === 'string' ? this.waiting.get(r.id) : undefined;
      if (!w) continue;
      this.waiting.delete(r.id);
      if (r.ok && Array.isArray(r.hosted)) this.hostedByHome.set(w.action.codexHome, new Set(r.hosted.filter((t) => typeof t === 'string')));
      w.done(r.ok ? { id: r.id, ok: true } : { id: r.id, ok: false, error: typeof r.error === 'string' ? r.error : tr('falhou no auxiliar'), status: r.status });
    }
  }

  private expire(): void {
    const limit = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    for (const [id, w] of this.waiting) {
      if (this.now() - w.at < limit) continue;
      this.waiting.delete(id);
      w.done({ id, ok: false, error: tr('o auxiliar do host não respondeu: o npm run codex:bridge está rodando no Mac?') });
    }
  }
}

/**
 * CodexAppServerLike que manda tudo pela fila (o CodexRuntime no container usa este, com `delegate`: achar e
 * encerrar o processo acontecem no auxiliar). `startThread` não devolve o id: quem abre de verdade é o host.
 */
export function hostAppServer(queue: HostQueue, account: () => string, codexHome: string): CodexAppServerLike {
  const run = async (a: WithoutId<HostAction>) => {
    const r = await queue.submit(a);
    if (!r.ok) throw new Error(r.error);
  };
  return {
    startThread: async ({ cwd, prompt }) => {
      await run({ op: 'spawn', account: account(), codexHome, folder: cwd, prompt: prompt ?? '' });
      return '';
    },
    resumeThread: (thread) => run({ op: 'takeover', account: account(), codexHome, thread }),
    send: (thread, text) => run({ op: 'send', account: account(), codexHome, thread, text }),
    interrupt: async () => undefined,
    release: (thread) => run({ op: 'stop', account: account(), codexHome, thread }),
    hosts: (thread) => queue.hosted(codexHome, thread),
  };
}
