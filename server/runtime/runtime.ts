// O que o escritório (e, depois, o orquestrador) faz com um agente, sem saber de qual ferramenta ele é: abrir um novo,
// assumir, encerrar. Cada provedor tem um AgentRuntime; o RuntimeSet escolhe pelo `provider` do agente (ausente =
// claude) e aplica o filtro por pasta antes de qualquer ação. Mensagens e respostas seguem pelo MessageRegistry e pelo
// PermissionRegistry, que já são comuns aos provedores.
import type { AgentInfo, Provider, PtyInfo } from '../../shared/types';
import type { SpawnSubmit } from '../spawn/spawn';
import { tr } from '../../shared/i18n';

export interface RuntimeCapabilities {
  stop: boolean;
  takeover: boolean;
  spawn: boolean;
}

export type TakeoverResult = { kind: 'pty'; pty: PtyInfo } | { kind: 'hosted'; agentId: string };

export interface AgentRuntime {
  readonly provider: Provider;
  capabilities(agent: AgentInfo): RuntimeCapabilities;
  spawn(req: { folder: string; prompt: string; account?: string; attachments?: unknown }): SpawnSubmit | Promise<SpawnSubmit>;
  takeover(agentId: string, size?: { cols?: unknown; rows?: unknown }): Promise<TakeoverResult>;
  stop(agentId: string): Promise<void>;
}

export class RuntimeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const NONE: RuntimeCapabilities = { stop: false, takeover: false, spawn: false };

export class RuntimeSet {
  private readonly byProvider = new Map<Provider, AgentRuntime>();

  constructor(
    runtimes: AgentRuntime[],
    private readonly deps: { agent: (id: string) => AgentInfo | undefined; inScope?: (cwd: string) => boolean; cwdOf: (agent: AgentInfo) => string | undefined },
  ) {
    for (const r of runtimes) this.byProvider.set(r.provider, r);
  }

  of(provider: Provider): AgentRuntime | undefined {
    return this.byProvider.get(provider);
  }

  capabilities(agent: AgentInfo): RuntimeCapabilities {
    const r = this.byProvider.get(agent.provider ?? 'claude');
    if (!r || !this.allowed(agent)) return NONE;
    return r.capabilities(agent);
  }

  async spawn(provider: Provider, raw: unknown): Promise<SpawnSubmit> {
    const r = this.byProvider.get(provider);
    if (!r) throw new RuntimeError(501, tr('Novo agente não disponível para esta ferramenta'));
    const req = (raw && typeof raw === 'object' ? raw : {}) as { folder?: unknown; prompt?: unknown; account?: unknown; attachments?: unknown };
    const folder = typeof req.folder === 'string' ? req.folder.trim() : '';
    if (this.deps.inScope && folder && !this.deps.inScope(folder)) throw new RuntimeError(403, tr('pasta fora das pastas deste escritório'));
    return r.spawn({
      folder,
      prompt: typeof req.prompt === 'string' ? req.prompt : '',
      account: typeof req.account === 'string' ? req.account : undefined,
      attachments: req.attachments,
    });
  }

  async takeover(agentId: string, size?: { cols?: unknown; rows?: unknown }): Promise<TakeoverResult> {
    return this.route(agentId).takeover(agentId, size);
  }

  async stop(agentId: string): Promise<void> {
    return this.route(agentId).stop(agentId);
  }

  private allowed(agent: AgentInfo): boolean {
    if (!this.deps.inScope) return true;
    const cwd = this.deps.cwdOf(agent);
    return !!cwd && this.deps.inScope(cwd);
  }

  private route(agentId: string): AgentRuntime {
    const agent = this.deps.agent(agentId);
    if (!agent) throw new RuntimeError(404, tr('agente não encontrado'));
    const r = this.byProvider.get(agent.provider ?? 'claude');
    if (!r) throw new RuntimeError(501, tr('ação não disponível para esta ferramenta'));
    if (!this.allowed(agent)) throw new RuntimeError(403, tr('agente fora das pastas deste escritório'));
    return r;
  }
}
