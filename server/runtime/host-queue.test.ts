// server/runtime/host-queue.test.ts
import { describe, expect, it } from 'vitest';
import { HostQueue } from './host-queue';

describe('HostQueue', () => {
  it('ação vai para o auxiliar no poll e resolve com o ack; a lista hosted vale para hosted()', async () => {
    const q = new HostQueue({ timeoutMs: 1_000 });
    const p = q.submit({ op: 'takeover', account: '.codex', codexHome: '/h/.codex', thread: 't1' });
    const [a] = q.poll();
    expect(a).toMatchObject({ op: 'takeover', thread: 't1' });
    expect(q.poll()).toEqual([]);
    q.ack({ results: [{ id: a.id, ok: true, hosted: ['t1'] }] });
    await expect(p).resolves.toMatchObject({ ok: true });
    expect(q.hosted('/h/.codex', 't1')).toBe(true);
    expect(q.present()).toBe(true);
  });

  it('sem ack no prazo: falha com o motivo; ack de id desconhecido é ignorado', async () => {
    let now = 0;
    const q = new HostQueue({ timeoutMs: 100, now: () => now });
    const p = q.submit({ op: 'stop', account: '.codex', codexHome: '/h', thread: 't' });
    q.ack({ results: [{ id: 'outro', ok: true }] });
    now = 200;
    q.poll();
    await expect(p).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/auxiliar/) });
  });
});

describe('HostQueue sem o auxiliar', () => {
  it('pedido que ninguém busca falha no prazo, mesmo sem nenhum poll', async () => {
    const q = new HostQueue({ timeoutMs: 30 });
    const r = await q.submit({ op: 'stop', account: '.codex', codexHome: '/h', thread: 't' });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/auxiliar/) });
  });
});
