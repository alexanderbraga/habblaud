// JSON-RPC 2.0 por linhas (uma mensagem JSON por linha), o transporte do `codex app-server` e do `grok agent stdio`.
// Pedidos com prazo, notificações e pedidos vindos do outro lado (aprovações, perguntas). Linha ilegível é ignorada;
// o fim do stream fecha o peer e rejeita o que estava pendente. Textos dos pedidos e respostas nunca vão para log.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tr } from '../../../shared/i18n';

export class JsonRpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
  }
}

export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

export interface JsonRpcPeerOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  onRequest?: RequestHandler;
  onNotification?: (method: string, params: unknown) => void;
  defaultTimeoutMs?: number;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);

export class JsonRpcPeer {
  private seq = 0;
  private readonly pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closeReason: string | undefined;
  private readonly closers: Array<(reason: string) => void> = [];
  private readonly rl: ReturnType<typeof createInterface>;

  constructor(private readonly opts: JsonRpcPeerOptions) {
    this.rl = createInterface({ input: opts.input });
    this.rl.on('line', (line) => this.onLine(line));
    this.rl.on('close', () => this.close(tr('o processo fechou a conexão')));
  }

  get closed(): boolean {
    return this.closeReason !== undefined;
  }

  onClose(cb: (reason: string) => void): void {
    this.closers.push(cb);
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.opts.defaultTimeoutMs ?? 30_000): Promise<T> {
    if (this.closeReason !== undefined) return Promise.reject(new JsonRpcError(this.closeReason));
    const id = ++this.seq;
    return new Promise<T>((ok, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new JsonRpcError(tr('sem resposta de {0} no prazo', [method])));
      }, timeoutMs);
      this.pending.set(id, { ok: ok as (v: unknown) => void, fail, timer });
      this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closeReason === undefined) this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  close(reason = tr('conexão fechada')): void {
    if (this.closeReason !== undefined) return;
    this.closeReason = reason;
    this.rl.close();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.fail(new JsonRpcError(reason));
    }
    this.pending.clear();
    for (const cb of this.closers) cb(reason);
  }

  private write(msg: Rec): void {
    if (this.closed) return;
    try {
      this.opts.output.write(`${JSON.stringify(msg)}\n`);
    } catch {
      this.close(tr('não consegui escrever para o processo'));
    }
  }

  private onLine(line: string): void {
    let m: Rec | undefined;
    try {
      m = rec(JSON.parse(line));
    } catch {
      return;
    }
    if (!m) return;
    const method = typeof m.method === 'string' ? m.method : undefined;
    if (method && m.id !== undefined) return void this.answer(m.id, method, m.params);
    if (method) return void this.opts.onNotification?.(method, m.params);
    if (typeof m.id !== 'number') return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    const err = rec(m.error);
    if (err) p.fail(new JsonRpcError(typeof err.message === 'string' ? err.message : tr('erro'), typeof err.code === 'number' ? err.code : undefined, err.data));
    else p.ok(m.result);
  }

  private async answer(id: unknown, method: string, params: unknown): Promise<void> {
    if (!this.opts.onRequest) return this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: tr('método desconhecido: {0}', [method]) } });
    try {
      const result = await this.opts.onRequest(method, params);
      this.write({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (err) {
      const e = err instanceof JsonRpcError ? err : new JsonRpcError(String((err as Error)?.message ?? err));
      this.write({ jsonrpc: '2.0', id, error: { code: e.code ?? -32603, message: e.message, ...(e.data === undefined ? {} : { data: e.data }) } });
    }
  }
}

/** Sobe `bin args` e liga um peer ao stdin/stdout dele; a saída do processo fecha o peer. */
export function spawnJsonRpc(
  bin: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; onRequest?: RequestHandler; onNotification?: (m: string, p: unknown) => void; defaultTimeoutMs?: number },
): { peer: JsonRpcPeer; pid: number | undefined; kill: () => void } {
  const child = spawn(bin, args, { env: opts.env, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const peer = new JsonRpcPeer({ input: child.stdout, output: child.stdin, onRequest: opts.onRequest, onNotification: opts.onNotification, defaultTimeoutMs: opts.defaultTimeoutMs });
  child.on('error', (err) => peer.close(tr('não consegui rodar {0}: {1}', [bin, err.message])));
  child.on('exit', (code, signal) => peer.close(tr('o processo saiu ({0})', [signal ?? code])));
  child.stdin.on('error', () => peer.close(tr('o processo fechou a entrada')));
  return { peer, pid: child.pid, kill: () => void child.kill() };
}
