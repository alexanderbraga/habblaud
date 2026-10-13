// Rotas comuns: cada ação chega ao runtime da ferramenta, com os erros e as travas da API.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { AccountsService } from '../accounts/service';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { RuntimeError, RuntimeSet, type AgentRuntime } from '../runtime/runtime';
import { tempDir } from './fixtures';

setQuiet(true);

async function serve(runtime: AgentRuntime, projectRoots?: string[], opts: { inDocker?: boolean; remoteAddress?: string; terminal?: boolean } = {}) {
  const tmp = tempDir();
  let runtimes: RuntimeSet;
  const office = new Office({
    names: new NameStore(null), projectRoots, version: 't', startedAt: Date.now(),
    accounts: () => [], sources: () => [], accountName: () => undefined, terminal: opts.terminal ?? true,
    capabilities: (a) => runtimes.capabilities(a),
  });
  const hub = new Hub(office, { throttleMs: 10 });
  const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => {} });
  runtimes = new RuntimeSet([runtime], { agent: (id) => office.get(id), cwdOf: (a) => office.roomPath(a.roomId), inScope: projectRoots ? office.inScope : undefined });
  const api = createApiHandler({ office, hub, accounts, sources: () => [], version: 't', inDocker: opts.inDocker ?? false, terminal: opts.terminal ?? true, runtimes });
  const guard = createRequestGuard({ allowedHosts: new Set(['habblaud.lan']) });
  const server = http.createServer((req, res) => {
    if (opts.remoteAddress) Object.defineProperty(req.socket, 'remoteAddress', { configurable: true, value: opts.remoteAddress });
    if (guard(req, res)) return;
    if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const sessionId of ['t', 'x']) office.addMain({ id: `.codex:${sessionId}`, provider: 'codex', account: '.codex', sessionId, cwd: '/p/loja', role: 'Agente principal', startedAt: 0, status: 'idle' });
  return {
    snapshot: async () => (await fetch(`${base}/api/snapshot`)).json(),
    post: (path: string, body: unknown = {}, headers: Record<string, string> = {}) => new Promise<Response>((ok, fail) => {
      // http.request mantém o Host informado; fetch o substitui pelo endereço real do servidor.
      const req = http.request(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { text += chunk; });
        res.on('error', fail);
        res.on('end', () => ok(new Response(res.statusCode === 204 ? null : text, { status: res.statusCode })));
      });
      req.on('error', fail);
      req.end(JSON.stringify(body));
    }),
    close: () => new Promise<void>((ok) => {
      hub.stop();
      server.closeAllConnections();
      server.close(() => { tmp.cleanup(); ok(); });
    }),
  };
}

describe('rotas pelo RuntimeSet', () => {
  it('sem o runtime do Codex (HABBLAUD_PTY desligado): Novo agente do Codex responde 501 com o motivo, não 500', async () => {
    const claude: AgentRuntime = {
      provider: 'claude', capabilities: () => ({ stop: false, takeover: false, spawn: false }),
      takeover: async (id) => ({ kind: 'hosted', agentId: id }), stop: async () => {},
      spawn: async () => ({ error: 'unavailable', reason: 'x' }),
    };
    const s = await serve(claude, ['/p/loja']);
    try {
      const r = await s.post('/api/spawn', { provider: 'codex', folder: '/p/loja', prompt: 'x' });
      expect(r.status).toBe(501);
      expect((await r.json()).error).toMatch(/Novo agente/);
    } finally { await s.close(); }
  });

  it('spawn do Codex exige uma pasta absoluta válida antes de chamar o runtime e preserva erro de disponibilidade', async () => {
    const calls: string[] = [];
    const runtime: AgentRuntime = {
      provider: 'codex', capabilities: () => ({ stop: true, takeover: true, spawn: true }),
      takeover: async (id) => ({ kind: 'hosted', agentId: id }), stop: async () => {},
      spawn: async (req) => { calls.push(req.folder); return { error: 'unavailable', reason: 'sem conta' }; },
    };
    const s = await serve(runtime, ['/p/loja']);
    try {
      for (const folder of ['', 'relativa', '/p/loja\0']) expect((await s.post('/api/spawn', { provider: 'codex', folder, prompt: 'x' })).status).toBe(400);
      expect(calls).toEqual([]);
      const unavailable = await s.post('/api/spawn', { provider: 'codex', folder: '/p/loja', prompt: 'x' });
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toEqual({ error: 'sem conta' });
      expect(calls).toEqual(['/p/loja']);
    } finally { await s.close(); }
  });

  it('Docker aceita ações pelo gateway com Host local; pty, origem externa e terminal desligado continuam recusados', async () => {
    const runtime: AgentRuntime = {
      provider: 'codex', capabilities: () => ({ stop: true, takeover: true, spawn: true }),
      takeover: async (id) => ({ kind: 'hosted', agentId: id }), stop: async () => {},
      spawn: async () => ({ error: 'unavailable', reason: 'sem conta' }),
    };
    const s = await serve(runtime, undefined, { inDocker: true, remoteAddress: '172.17.0.1' });
    try {
      const headers = { Host: 'localhost', Origin: 'http://localhost' };
      expect((await s.post('/api/agents/.codex%3At/takeover', {}, headers)).status).toBe(201);
      expect((await s.post('/api/agents/.codex%3At/stop', {}, headers)).status).toBe(204);
      expect((await s.post('/api/pty/x/input', { data: 'x' }, headers)).status).toBe(403);
      expect((await s.post('/api/agents/.codex%3At/takeover', {}, { ...headers, Origin: 'https://fora.example' })).status).toBe(403);
      expect((await s.post('/api/agents/.codex%3At/takeover', {}, { ...headers, 'Sec-Fetch-Site': 'same-site' })).status).toBe(403);
    } finally { await s.close(); }
    const off = await serve(runtime, undefined, { inDocker: true, terminal: false, remoteAddress: '172.17.0.1' });
    try { expect((await off.post('/api/agents/.codex%3At/takeover', {}, { Host: 'localhost' })).status).toBe(403); }
    finally { await off.close(); }
  });

  it('snapshot informa as capacidades atuais do runtime e bloqueia ações fora do filtro por pasta', async () => {
    let hosted = false;
    const runtime: AgentRuntime = {
      provider: 'codex', capabilities: () => ({ stop: true, takeover: !hosted, spawn: true }),
      takeover: async (id) => { hosted = true; return { kind: 'hosted', agentId: id }; },
      stop: async () => {}, spawn: async () => ({ error: 'unavailable', reason: 'sem conta' }),
    };
    const s = await serve(runtime, ['/p/loja']);
    try {
      expect((await s.snapshot()).agents).toEqual(expect.arrayContaining([expect.objectContaining({ id: '.codex:t', canStop: true, canTakeover: true })]));
      await s.post('/api/agents/.codex%3At/takeover');
      expect((await s.snapshot()).agents).toEqual(expect.arrayContaining([expect.objectContaining({ id: '.codex:t', canStop: true, canTakeover: false })]));
      const outside = await s.post('/api/spawn', { provider: 'codex', folder: '/p/outra', prompt: 'x' });
      expect(outside.status).toBe(403);
    } finally { await s.close(); }
  });

  it('stop e takeover do Codex chegam ao runtime dele; erro do runtime vira o status; spawn recebe o provedor', async () => {
    const calls: unknown[] = [];
    const runtime: AgentRuntime = {
      provider: 'codex', capabilities: () => ({ stop: true, takeover: true, spawn: true }),
      takeover: async (id, size) => { calls.push(['takeover', id, size]); return { kind: 'hosted', agentId: id }; },
      stop: async (id) => { calls.push(['stop', id]); if (id === '.codex:x') throw new RuntimeError(409, 'mudou'); },
      spawn: async (req) => { calls.push(['spawn', req]); return { spawn: { id: 'novo', folder: req.folder, status: 'opened' } }; },
    };
    const s = await serve(runtime);
    try {
      const takeover = await s.post('/api/agents/.codex%3At/takeover', { cols: 90, rows: 30 });
      expect(takeover.status).toBe(201);
      expect(await takeover.json()).toEqual({ kind: 'hosted', agentId: '.codex:t' });
      const stop = await s.post('/api/agents/.codex%3Ax/stop');
      expect(stop.status).toBe(409);
      expect(await stop.json()).toEqual({ error: 'mudou' });
      expect((await s.post('/api/agents/.codex%3At/stop')).status).toBe(204);
      const spawn = await s.post('/api/spawn', { provider: 'codex', folder: '/p/loja', prompt: 'x' });
      expect(spawn.status).toBe(201);
      expect(await spawn.json()).toEqual({ id: 'novo', folder: '/p/loja', status: 'opened' });
      expect(calls).toEqual([
        ['takeover', '.codex:t', { cols: 90, rows: 30 }], ['stop', '.codex:x'], ['stop', '.codex:t'],
        ['spawn', { folder: '/p/loja', prompt: 'x', account: undefined, attachments: undefined }],
      ]);
    } finally { await s.close(); }
  });
});
