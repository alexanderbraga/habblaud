import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo } from '../../shared/types';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { PermissionRegistry } from '../permissions/registry';
import { FAKE_CODEX_APP_RUNS, writeFakeCodexApp } from '../test/fake-codex-app';
import { tempDir } from '../test/fixtures';
import { CodexRuntime, type CodexAppServerLike, type CodexRuntimeOptions } from './codex';
import { CodexAppServer, type CodexAgentRequest } from './protocol/codex-app';
import { RuntimeSet } from './runtime';

setQuiet(true);

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
});

const T = '01a13637-1830-76f2-8819-4cbd073f98a4';
const ID = `.codex:${T}`;
const agent = (over: Partial<AgentInfo> = {}) => ({ id: ID, provider: 'codex', kind: 'main', account: '.codex', sessionId: T, roomId: '/p/loja', status: 'idle', ...over }) as AgentInfo;
const question = { kind: 'question', threadId: T, questions: [{ id: 'q1', header: 'Banco', question: 'Qual banco?', options: [{ label: 'Postgres', description: '' }, { label: 'SQLite', description: '' }], isOther: false }] } satisfies CodexAgentRequest;

function fakeApp() {
  const calls: string[] = [];
  const hosted = new Set<string>();
  const app: CodexAppServerLike = {
    startThread: async ({ cwd, prompt }) => (calls.push(`start:${cwd}:${prompt ?? ''}`), hosted.add('novo'), 'novo'),
    resumeThread: async (t) => void (calls.push(`resume:${t}`), hosted.add(t)),
    send: async (t, text) => void calls.push(`send:${t}:${text}`),
    interrupt: async (t) => void calls.push(`interrupt:${t}`),
    release: async (t) => void (calls.push(`release:${t}`), hosted.delete(t)),
    hosts: (t) => hosted.has(t),
  };
  return { app, calls };
}

function setup(over: { tuiPid?: number; stopResult?: 'stopped' | 'gone' | 'changed' | 'stuck'; runtime?: Partial<CodexRuntimeOptions> } = {}) {
  const { app, calls } = fakeApp();
  const queued: string[] = [];
  const stopped: number[] = [];
  const rt = new CodexRuntime({
    homeOf: () => '/h/.codex',
    agent: (id) => (id === ID ? agent() : undefined),
    accounts: () => ['.codex'],
    app: () => app,
    queue: async (job) => (queued.push(`${job.thread}:${job.text}`), { ok: true }),
    tui: { find: async () => (over.tuiPid ? { pid: over.tuiPid, startMs: 1 } : undefined), stop: async (t) => (stopped.push(t.pid), over.stopResult ?? 'stopped') },
    agentIdOf: (acc, t) => `${acc}:${t}`,
    ...over.runtime,
  });
  return { rt, calls, queued, stopped };
}

function setupPermissions(opts: { viewers?: number; projectRoots?: string[] } = {}) {
  let permissions: PermissionRegistry | undefined;
  const office = new Office({
    names: new NameStore(null), version: 't', startedAt: 0,
    accounts: () => [], sources: () => [], accountName: () => undefined,
    permissions: () => permissions?.snapshot() ?? new Map(), projectRoots: opts.projectRoots,
  });
  office.addMain({ id: ID, provider: 'codex', account: '.codex', sessionId: T, cwd: '/p/loja', role: 'Agente principal', startedAt: 0, status: 'working' });
  permissions = new PermissionRegistry({ office, viewers: () => opts.viewers ?? 1 });
  cleanups.push(() => permissions!.stop());
  return { office, permissions };
}

describe('CodexRuntime', () => {
  it('no container, delega assumir e encerrar ao auxiliar mesmo sem hospedagem; não consulta o TUI local', async () => {
    const find = vi.fn(async () => undefined);
    const stop = vi.fn(async () => 'gone' as const);
    const { rt, calls } = setup({ runtime: { delegate: true, tui: { find, stop } } });
    await expect(rt.stop(ID)).resolves.toBeUndefined();
    await expect(rt.takeover(ID)).resolves.toEqual({ kind: 'hosted', agentId: ID });
    await expect(rt.takeover(ID)).resolves.toEqual({ kind: 'hosted', agentId: ID });
    await rt.stop(ID);
    expect(calls).toEqual([`release:${T}`, `resume:${T}`, `resume:${T}`, `release:${T}`]);
    expect(find).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it('no container, mensagem de sessão ainda observada também vai ao auxiliar, que escolhe app-server ou queue no host', async () => {
    const { rt, calls, queued } = setup({ runtime: { delegate: true, queue: undefined } });
    await expect(rt.deliver({ codexHome: '/h/.codex', thread: T, text: 'oi' })).resolves.toEqual({ ok: true });
    expect(calls).toEqual([`send:${T}:oi`]);
    expect(queued).toEqual([]);
  });

  it('assumir: encerra o TUI conferido e retoma o thread no app-server; depois a mensagem vai pelo app-server', async () => {
    const { rt, calls, queued, stopped } = setup({ tuiPid: 18194 });
    await expect(rt.takeover(ID)).resolves.toEqual({ kind: 'hosted', agentId: ID });
    expect(stopped).toEqual([18194]);
    expect(calls).toEqual([`resume:${T}`]);
    await expect(rt.deliver({ codexHome: '/h/.codex', thread: T, text: 'oi' })).resolves.toEqual({ ok: true });
    expect(calls).toContain(`send:${T}:oi`);
    expect(queued).toEqual([]);
  });

  it('sessão do TUI (não hospedada): a mensagem segue pelo codex queue', async () => {
    const { rt, calls, queued } = setup();
    await expect(rt.deliver({ codexHome: '/h/.codex', thread: T, text: 'oi' })).resolves.toEqual({ ok: true });
    expect(queued).toEqual([`${T}:oi`]);
    expect(calls).toEqual([]);
  });

  it('assumir com o pid trocado: nada é retomado e o erro diz o motivo; sem TUI: retoma direto', async () => {
    const changed = setup({ tuiPid: 18194, stopResult: 'changed' });
    await expect(changed.rt.takeover(ID)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/processo.*mudou/) });
    expect(changed.calls).toEqual([]);
    const none = setup();
    await none.rt.takeover(ID);
    expect(none.calls).toEqual([`resume:${T}`]);
  });

  it('encerrar hospedado: interrompe e larga; Novo agente: abre o thread na pasta com o pedido', async () => {
    const { rt, calls } = setup();
    await rt.takeover(ID);
    await rt.stop(ID);
    expect(calls).toEqual([`resume:${T}`, `interrupt:${T}`, `release:${T}`]);
    await expect(rt.spawn({ folder: '/p/loja', prompt: 'faça X' })).resolves.toMatchObject({ spawn: { folder: '/p/loja', status: 'opened' } });
    expect(calls).toContain('start:/p/loja:faça X');
  });

  it('pergunta do agente sem ninguém olhando: cancela (não fica pendurada)', async () => {
    const { rt } = setup();
    const reply = await rt.onAgentRequest('.codex', { kind: 'question', threadId: T, questions: [{ id: 'q1', header: 'B', question: 'Qual?', options: [{ label: 'a', description: '' }], isOther: false }] });
    expect(reply).toEqual({ kind: 'question', answers: null });
  });

  it('pergunta usa o caminho resolvido da sala; sem resolução mantém roomId, aprovação mantém o cwd do protocolo', async () => {
    const register = vi.fn(() => ({ skip: 'sem página' }));
    const { rt } = setup({ runtime: {
      cwdOf: () => '/p/loja', agent: () => agent({ roomId: 'sala:loja' }),
      permissions: { register, wait: () => undefined },
    } });
    await rt.onAgentRequest('.codex', question);
    expect(register).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: '/p/loja' }));
    await rt.onAgentRequest('.codex', { kind: 'approval', threadId: T, tool: 'Bash', input: {}, cwd: '/p/outra' });
    expect(register).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: '/p/outra' }));
    const fallback = setup({ runtime: { permissions: { register, wait: () => undefined } } });
    await fallback.rt.onAgentRequest('.codex', question);
    expect(register).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: '/p/loja' }));
  });

  it('registro real sem página conectada cancela a pergunta e recusa aprovação imediatamente', async () => {
    const { permissions } = setupPermissions({ viewers: 0 });
    const { rt } = setup({ runtime: { permissions } });
    await expect(rt.onAgentRequest('.codex', question)).resolves.toEqual({ kind: 'question', answers: null });
    await expect(rt.onAgentRequest('.codex', { kind: 'approval', threadId: T, tool: 'Bash', input: { command: 'npm test' } })).resolves.toEqual({ kind: 'approval', allow: false });
    expect(permissions.size).toBe(0);
  });

  it('resposta do escritório volta com os ids das perguntas e os rótulos originais das opções', async () => {
    const { office, permissions } = setupPermissions();
    const { rt } = setup({ runtime: { permissions, agent: (id) => office.get(id) } });
    const reply = rt.onAgentRequest('.codex', {
      kind: 'question', threadId: T,
      questions: [
        { id: 'banco', header: 'Banco', question: 'Qual banco?', options: [{ label: 'Postgres', description: 'relacional' }, { label: 'SQLite', description: 'arquivo' }], isOther: false },
        { id: 'testes', header: 'Testes', question: 'Qual teste?', options: [{ label: 'Unidade', description: '' }], isOther: true },
      ],
    });
    const pending = permissions.snapshot().get(ID);
    expect(pending).toMatchObject({ provider: 'codex', tool: 'AskUserQuestion' });
    expect(permissions.decide(pending!.id, { behavior: 'answer', answers: [{ question: 1, other: 'E2E' }, { question: 0, options: [1] }] })).toBe('ok');
    await expect(reply).resolves.toEqual({ kind: 'question', answers: { banco: ['SQLite'], testes: ['E2E'] } });
  });

  it('aprovação usa o registro: allow aceita, deny e liberação recusam', async () => {
    const { permissions } = setupPermissions();
    const { rt } = setup({ runtime: { permissions } });
    for (const behavior of ['allow', 'deny', 'terminal'] as const) {
      const reply = rt.onAgentRequest('.codex', { kind: 'approval', threadId: T, tool: 'Bash', input: { command: 'npm test' }, cwd: '/p/loja' });
      const pending = permissions.snapshot().get(ID);
      expect(pending).toMatchObject({ provider: 'codex', tool: 'Bash' });
      expect(permissions.decide(pending!.id, { behavior })).toBe('ok');
      await expect(reply).resolves.toEqual({ kind: 'approval', allow: behavior === 'allow' });
    }
  });

  it('pergunta na pasta permitida é publicada com escopo; pedido de aprovação de fora é recusado', async () => {
    const { office, permissions } = setupPermissions({ projectRoots: ['/p/loja'] });
    const { rt } = setup({ runtime: { permissions, agent: (id) => office.get(id) } });
    const reply = rt.onAgentRequest('.codex', question);
    const pending = permissions.snapshot().get(ID);
    expect(pending).toMatchObject({ tool: 'AskUserQuestion' });
    expect(permissions.decide(pending!.id, { behavior: 'answer', answers: [{ question: 0, options: [1] }] })).toBe('ok');
    await expect(reply).resolves.toEqual({ kind: 'question', answers: { q1: ['SQLite'] } });
    await expect(rt.onAgentRequest('.codex', { kind: 'approval', threadId: T, tool: 'Bash', input: { command: 'npm test' }, cwd: '/p/outra' })).resolves.toEqual({ kind: 'approval', allow: false });
    expect(permissions.size).toBe(0);
  });

  it('pergunta continua esperando após os long-polls de 25 s e aceita a resposta dentro do prazo', async () => {
    vi.useFakeTimers();
    const { permissions } = setupPermissions();
    const { rt } = setup({ runtime: { permissions } });
    const reply = rt.onAgentRequest('.codex', question);
    const id = permissions.snapshot().get(ID)!.id;
    await vi.advanceTimersByTimeAsync(50_000);
    expect(permissions.decide(id, { behavior: 'answer', answers: [{ question: 0, options: [1] }] })).toBe('ok');
    await expect(reply).resolves.toEqual({ kind: 'question', answers: { q1: ['SQLite'] } });
  });

  it('pergunta sem resposta é cancelada ao completar o prazo de cinco minutos', async () => {
    vi.useFakeTimers();
    const { permissions } = setupPermissions();
    const { rt } = setup({ runtime: { permissions } });
    const reply = rt.onAgentRequest('.codex', question);
    await vi.advanceTimersByTimeAsync(300_000);
    await expect(reply).resolves.toEqual({ kind: 'question', answers: null });
  });

  it('encerrar sessão do TUI confere o processo; pid trocado ou preso falha, sessão ausente é 404', async () => {
    const tui = setup({ tuiPid: 18194 });
    await tui.rt.stop(ID);
    expect(tui.stopped).toEqual([18194]);
    expect(tui.calls).toEqual([]);
    for (const stopResult of ['changed', 'stuck'] as const) {
      const blocked = setup({ tuiPid: 18194, stopResult });
      await expect(blocked.rt.stop(ID)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/encerrar/) });
      expect(blocked.calls).toEqual([]);
    }
    const gone = setup({ tuiPid: 18194, stopResult: 'gone' });
    await expect(gone.rt.stop(ID)).resolves.toBeUndefined();
    await expect(setup().rt.stop(ID)).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/processo/) });
  });

  it('assumir já hospedado não encerra nem retoma novamente; TUI preso e falha do resume explicam o motivo', async () => {
    const hosted = setup({ tuiPid: 18194 });
    await hosted.rt.takeover(ID);
    await expect(hosted.rt.takeover(ID)).resolves.toEqual({ kind: 'hosted', agentId: ID });
    expect(hosted.stopped).toEqual([18194]);
    expect(hosted.calls).toEqual([`resume:${T}`]);
    const stuck = setup({ tuiPid: 18194, stopResult: 'stuck' });
    await expect(stuck.rt.takeover(ID)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/não encerrou a tempo/) });
    expect(stuck.calls).toEqual([]);
    const { app } = fakeApp();
    app.resumeThread = async () => { throw new Error('no rollout found'); };
    const failed = setup({ runtime: { app: () => app } });
    await expect(failed.rt.takeover(ID)).rejects.toMatchObject({ status: 502, message: expect.stringMatching(new RegExp(`no rollout found.*codex resume ${T}`)) });
  });

  it('capacidades dependem da conta e hospedagem; RuntimeSet bloqueia spawn e takeover fora das pastas', async () => {
    const { rt, calls, stopped } = setup({ tuiPid: 18194 });
    expect(rt.capabilities(agent())).toEqual({ stop: true, takeover: true, spawn: true });
    expect(rt.capabilities(agent({ kind: 'sub' }))).toEqual({ stop: false, takeover: false, spawn: true });
    const unavailable = setup({ runtime: { homeOf: () => undefined, accounts: () => [] } });
    expect(unavailable.rt.capabilities(agent())).toEqual({ stop: false, takeover: false, spawn: false });
    const runtimes = new RuntimeSet([rt], { agent: () => agent(), inScope: (cwd) => cwd === '/p/permitida', cwdOf: (a) => a.roomId });
    expect(runtimes.capabilities(agent())).toEqual({ stop: false, takeover: false, spawn: false });
    await expect(runtimes.spawn('codex', { folder: '/p/outra', prompt: 'faça X' })).rejects.toMatchObject({ status: 403 });
    await expect(runtimes.takeover(ID)).rejects.toMatchObject({ status: 403 });
    await expect(runtimes.stop(ID)).rejects.toMatchObject({ status: 403 });
    expect(calls).toEqual([]);
    expect(stopped).toEqual([]);
    await rt.takeover(ID);
    expect(rt.capabilities(agent())).toEqual({ stop: true, takeover: false, spawn: true });
  });

  it.runIf(FAKE_CODEX_APP_RUNS)('processo que morre falha a mensagem com motivo, solta a hospedagem e sobe de novo ao assumir', async () => {
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    const log = join(tmp.dir, 'calls.jsonl');
    const app = new CodexAppServer({
      bin: writeFakeCodexApp(tmp.dir), codexHome: tmp.dir,
      env: { ...process.env, FAKE_CODEX_APP_LOG: log },
      onAgentRequest: async () => ({ kind: 'approval', allow: false }), requestTimeoutMs: 2_000,
    });
    cleanups.push(() => app.stop());
    const { rt, queued } = setup({ runtime: { homeOf: () => tmp.dir, app: () => app } });
    await rt.takeover(ID);
    await expect(rt.deliver({ codexHome: tmp.dir, thread: T, text: 'morrer' })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/processo|conexão/) });
    expect(app.hosts(T)).toBe(false);
    expect(rt.capabilities(agent())).toMatchObject({ takeover: true });
    expect(queued).toEqual([]);
    await expect(rt.deliver({ codexHome: tmp.dir, thread: T, text: 'oi' })).resolves.toEqual({ ok: true });
    expect(queued).toEqual([`${T}:oi`]);
    await rt.takeover(ID);
    await expect(rt.deliver({ codexHome: tmp.dir, thread: T, text: 'oi de novo' })).resolves.toEqual({ ok: true });
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method?: string });
    expect(calls.filter((call) => call.method === 'initialize')).toHaveLength(2);
    expect(app.hosts(T)).toBe(true);
  });
});

describe('CodexRuntime: processo do TUI que não dá para conferir', () => {
  it('assumir e encerrar recusam com 409 e o motivo, sem retomar nem encerrar nada', async () => {
    const find = async () => {
      throw new Error('não consegui conferir o processo que está com esta sessão do Codex');
    };
    const { rt, calls } = setup({ runtime: { tui: { find, stop: async () => 'stopped' } } });
    await expect(rt.takeover(ID)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/conferir/) });
    await expect(rt.stop(ID)).rejects.toMatchObject({ status: 409 });
    expect(calls).toEqual([]);
  });
});
