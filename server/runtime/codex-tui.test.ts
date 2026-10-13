// server/runtime/codex-tui.test.ts
import { describe, expect, it } from 'vitest';
import { findCodexTui, stopCodexTui } from './codex-tui';

const T = '01a13637-1830-76f2-8819-4cbd073f98a4';

describe('TUI do Codex dono de um thread', () => {
  it('é o processo `codex` que segura o lock do thread (a VM do Docker também segura e não conta)', async () => {
    const holders = async (f: string) => (f.endsWith(`thread-writer-locks/${T}.lock`) ? [61843, 18194] : []);
    const proc = async (pid: number) => (pid === 18194 ? { name: 'codex', startMs: 1000 } : { name: 'com.apple.Virtualization.VirtualMachine', startMs: 5 });
    await expect(findCodexTui('/h/.codex', T, { holders, proc })).resolves.toEqual({ pid: 18194, startMs: 1000 });
    await expect(findCodexTui('/h/.codex', 'nao-e-uuid', { holders, proc })).resolves.toBeUndefined();
  });

  it('encerra só se o pid ainda for o mesmo processo; não saiu: stuck', async () => {
    const alive = new Set([18194]);
    const killed: number[] = [];
    const deps = { proc: async () => ({ name: 'codex', startMs: 1000 }), kill: (p: number) => (killed.push(p), alive.delete(p)), isAlive: (p: number) => alive.has(p), sleep: async () => {} };
    await expect(stopCodexTui({ pid: 18194, startMs: 1000 }, deps)).resolves.toBe('stopped');
    expect(killed).toEqual([18194]);
    await expect(stopCodexTui({ pid: 18194, startMs: 1000 }, { ...deps, proc: async () => ({ name: 'codex', startMs: 9999 }) })).resolves.toBe('changed');
    await expect(stopCodexTui({ pid: 7, startMs: 1 }, { ...deps, proc: async () => undefined })).resolves.toBe('gone');
    await expect(stopCodexTui({ pid: 18194, startMs: 1000 }, { ...deps, kill: () => {}, isAlive: () => true })).resolves.toBe('stuck');
  });
});

describe('TUI do Codex: processo que não dá para conferir', () => {
  it('lock com dono cujo ps não se lê: recusa (nunca trata como "o TUI já saiu")', async () => {
    const holders = async () => [18194];
    await expect(findCodexTui('/h/.codex', T, { holders, proc: async () => undefined })).rejects.toThrow(/conferir/);
    await expect(findCodexTui('/h/.codex', T, { holders: async () => [], proc: async () => undefined })).resolves.toBeUndefined();
  });

  it('o ps padrão roda em inglês (LC_ALL=C): o horário de início se lê em qualquer idioma do sistema', async () => {
    const { psProc } = await import('./codex-tui');
    const me = await psProc(process.pid);
    expect(me?.startMs).toBeGreaterThan(0);
  });
});
