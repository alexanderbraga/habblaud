// O Claude Code atrás do AgentRuntime: o mesmo terminal interativo (PtyManager) e o mesmo Novo agente (SpawnService)
// de antes, sem mudança de comportamento.
import type { AgentInfo } from '../../shared/types';
import type { PtyManager } from '../pty/manager';
import type { SpawnService } from '../spawn/spawn';
import { tr } from '../../shared/i18n';
import { RuntimeError, type AgentRuntime } from './runtime';

export function createClaudeRuntime(deps: { ptys?: PtyManager; spawn?: SpawnService }): AgentRuntime {
  return {
    provider: 'claude',
    capabilities: (a: AgentInfo) => {
      const pty = !!deps.ptys && deps.ptys.status().enabled && a.kind === 'main';
      return { stop: pty, takeover: pty, spawn: !!deps.spawn };
    },
    spawn: (req) => {
      if (!deps.spawn) throw new RuntimeError(403, tr('novo agente pelo escritório desligado'));
      return deps.spawn.submit(req);
    },
    takeover: async (agentId, size) => {
      if (!deps.ptys) throw new RuntimeError(403, tr('terminal interativo desligado'));
      return { kind: 'pty', pty: await deps.ptys.takeover(agentId, size ?? {}) };
    },
    stop: async (agentId) => {
      if (!deps.ptys) throw new RuntimeError(403, tr('terminal interativo desligado'));
      await deps.ptys.stop(agentId);
    },
  };
}
