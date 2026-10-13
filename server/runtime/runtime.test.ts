import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../shared/types';
import { PtyManager, type PtyProcess } from '../pty/manager';
import { SpawnService } from '../spawn/spawn';
import { createClaudeRuntime } from './claude';
import { RuntimeError, RuntimeSet, type AgentRuntime } from './runtime';

const agent = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  id: 'acc:1',
  kind: 'main',
  account: 'acc',
  sessionId: 's',
  roomId: '/p/loja',
  status: 'idle',
  name: 'A',
  look: 'f',
  role: 'Agente principal',
  recent: [],
  tasks: [],
  startedAt: 0,
  lastEventAt: 0,
  statusSince: 0,
  stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
  seed: 0,
  ...over,
});

describe('ClaudeRuntime', () => {
  it('sem terminal ou Novo agente: capacidades desligadas e ações recusadas (403)', async () => {
    const runtime = createClaudeRuntime({});
    expect(runtime.provider).toBe('claude');
    expect(runtime.capabilities(agent())).toEqual({ stop: false, takeover: false, spawn: false });
    expect(() => runtime.spawn({ folder: '/p/loja', prompt: '' })).toThrow(RuntimeError);
    expect(() => runtime.spawn({ folder: '/p/loja', prompt: '' })).toThrow('novo agente pelo escritório desligado');
    await expect(runtime.takeover('acc:1')).rejects.toMatchObject({ status: 403, message: 'terminal interativo desligado' });
    await expect(runtime.stop('acc:1')).rejects.toMatchObject({ status: 403, message: 'terminal interativo desligado' });
  });

  it('usa o terminal existente e o mesmo serviço de Novo agente; só principais têm controle de terminal', async () => {
    let exited: (event: { exitCode: number }) => void = () => {};
    const proc: PtyProcess = {
      pid: 9001,
      onData: () => {},
      onExit: (cb) => void (exited = cb),
      write: () => {},
      resize: () => {},
      kill: () => exited({ exitCode: 0 }),
    };
    const ptys = new PtyManager({
      spawn: () => proc,
      claudeBin: process.execPath,
      accounts: () => [{ id: 'acc', dir: tmpdir(), isDefault: true }],
      agent: () => undefined,
      onChange: () => {},
    });
    const spawn = new SpawnService({ newId: () => 'novo' });
    spawn.poll();
    const runtime = createClaudeRuntime({ ptys, spawn });
    expect(runtime.capabilities(agent())).toEqual({ stop: true, takeover: true, spawn: true });
    expect(runtime.capabilities(agent({ kind: 'sub' }))).toEqual({ stop: false, takeover: false, spawn: true });
    const disabled = new PtyManager({ spawn: null, claudeBin: process.execPath, accounts: () => [], agent: () => undefined, onChange: () => {} });
    expect(createClaudeRuntime({ ptys: disabled, spawn }).capabilities(agent())).toEqual({ stop: false, takeover: false, spawn: true });

    try {
      const pty = ptys.create({ cwd: tmpdir() });
      await expect(runtime.takeover(pty.agentId)).resolves.toEqual({ kind: 'pty', pty });
      await runtime.stop(pty.agentId);
      expect(ptys.list()[0]).toMatchObject({ exitCode: 0, exitedAt: expect.any(Number) });
      expect(runtime.spawn({ folder: '/p/loja', prompt: 'rode os testes' })).toEqual({ spawn: { id: 'novo', folder: '/p/loja', status: 'queued' } });
      expect(spawn.poll()).toEqual([{ id: 'novo', folder: '/p/loja', prompt: 'rode os testes', files: [] }]);
    } finally {
      ptys.stopAll();
    }
  });
});

function fakeRuntime(provider: 'claude' | 'codex'): AgentRuntime & { calls: string[] } {
  const calls: string[] = [];
  return {
    provider,
    calls,
    capabilities: () => ({ stop: true, takeover: true, spawn: true }),
    spawn: (req) => (calls.push(`spawn:${req.folder}`), { spawn: { id: 'n1', folder: req.folder, status: 'queued' } }),
    takeover: async (id) => (calls.push(`takeover:${id}`), { kind: 'hosted', agentId: id }),
    stop: async (id) => void calls.push(`stop:${id}`),
  };
}

describe('RuntimeSet', () => {
  it('cada agente vai para o runtime do seu provedor (ausente = claude)', async () => {
    const claude = fakeRuntime('claude');
    const codex = fakeRuntime('codex');
    const agents = new Map([
      ['acc:1', agent()],
      ['.codex:t', agent({ id: '.codex:t', provider: 'codex' })],
    ]);
    const set = new RuntimeSet([claude, codex], { agent: (id) => agents.get(id), cwdOf: (a) => a.roomId });
    await set.stop('acc:1');
    await expect(set.takeover('.codex:t')).resolves.toEqual({ kind: 'hosted', agentId: '.codex:t' });
    expect(claude.calls).toEqual(['stop:acc:1']);
    expect(codex.calls).toEqual(['takeover:.codex:t']);
  });

  it('fora do filtro por pasta: capacidades desligadas e ações recusadas (403); agente que não existe: 404', async () => {
    const claude = fakeRuntime('claude');
    const a = agent({ roomId: '/outra' });
    const set = new RuntimeSet([claude], {
      agent: (id) => (id === a.id ? a : undefined),
      cwdOf: (x) => x.roomId,
      inScope: (c) => c.startsWith('/p/'),
    });
    expect(set.capabilities(a)).toEqual({ stop: false, takeover: false, spawn: false });
    await expect(set.stop(a.id)).rejects.toMatchObject({ status: 403 });
    await expect(set.takeover(a.id)).rejects.toMatchObject({ status: 403 });
    await expect(set.stop('nada')).rejects.toBeInstanceOf(RuntimeError);
    await expect(set.stop('nada')).rejects.toMatchObject({ status: 404 });
    await expect(set.takeover('nada')).rejects.toMatchObject({ status: 404 });
    await expect(set.spawn('claude', { folder: '/outra', prompt: '' })).rejects.toMatchObject({ status: 403 });
    expect(claude.calls).toEqual([]);
  });

  it('provedor sem runtime: capacidades desligadas, ação 501', async () => {
    const set = new RuntimeSet([], { agent: () => agent({ provider: 'codex' }), cwdOf: (x) => x.roomId });
    expect(set.of('codex')).toBeUndefined();
    expect(set.capabilities(agent({ provider: 'codex' }))).toEqual({ stop: false, takeover: false, spawn: false });
    await expect(set.stop('x')).rejects.toMatchObject({ status: 501 });
    await expect(set.takeover('x')).rejects.toMatchObject({ status: 501 });
    await expect(set.spawn('codex', { folder: '/p/loja', prompt: '' })).rejects.toMatchObject({ status: 501 });
  });
});
