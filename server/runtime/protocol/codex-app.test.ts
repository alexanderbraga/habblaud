import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_CODEX_APP_RUNS, writeFakeCodexApp } from '../../test/fake-codex-app';
import { tempDir } from '../../test/fixtures';
import { approvalResponse, CodexAppServer, type CodexAgentReply, type CodexAgentRequest } from './codex-app';

const run = FAKE_CODEX_APP_RUNS ? describe : describe.skip;

run('CodexAppServer', () => {
  let tmp: { dir: string; cleanup: () => void };
  let server: CodexAppServer | undefined;
  afterEach(() => {
    server?.stop();
    tmp?.cleanup();
  });
  function setup(onAgentRequest: (r: CodexAgentRequest) => Promise<CodexAgentReply> = async () => ({ kind: 'approval', allow: false }), extra: { env?: Record<string, string>; timeoutMs?: number } = {}) {
    tmp = tempDir();
    const log = join(tmp.dir, 'calls.jsonl');
    const closed: Array<{ threads: string[]; reason: string }> = [];
    server = new CodexAppServer({
      bin: writeFakeCodexApp(tmp.dir),
      codexHome: join(tmp.dir, '.codex'),
      env: { ...process.env, FAKE_CODEX_APP_LOG: log, ...extra.env },
      onAgentRequest,
      onClosed: (threads, reason) => closed.push({ threads, reason }),
      requestTimeoutMs: extra.timeoutMs ?? 2_000,
    });
    const calls = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { method?: string; params?: unknown; codexHome?: string; approval?: unknown; answers?: unknown });
    return { server, calls, closed };
  }
  const settle = () => new Promise((r) => setTimeout(r, 80));

  it('abre um thread em always-approve, com o CODEX_HOME da conta, e manda o primeiro pedido', async () => {
    const { server, calls } = setup();
    const id = await server.startThread({ cwd: '/p/loja', prompt: 'olá' });
    expect(server.hosts(id)).toBe(true);
    const start = calls().find((c) => c.method === 'thread/start');
    expect(start?.params).toMatchObject({ cwd: '/p/loja', approvalPolicy: 'never', sandbox: 'danger-full-access' });
    expect(start?.codexHome).toMatch(/\.codex$/);
    expect(calls().find((c) => c.method === 'turn/start')?.params).toMatchObject({ threadId: id, input: [{ type: 'text', text: 'olá' }] });
  });

  it('mensagem com o turno aberto vai por turn/steer; sem turno, turn/start', async () => {
    const { server, calls } = setup();
    const id = await server.startThread({ cwd: '/p', prompt: 'demorar' });
    await settle();
    await server.send(id, 'mais uma');
    const steer = calls().find((c) => c.method === 'turn/steer');
    expect(steer?.params).toMatchObject({ threadId: id, expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'mais uma' }] });
    await server.interrupt(id);
    await settle();
    await server.send(id, 'outra');
    expect(calls().filter((c) => c.method === 'turn/start')).toHaveLength(2);
  });

  it('aprovação e pergunta do agente passam pelo handler e a resposta volta no formato do Codex', async () => {
    const asked: CodexAgentRequest[] = [];
    const { server, calls } = setup(async (r) => {
      asked.push(r);
      return r.kind === 'approval' ? { kind: 'approval', allow: true } : { kind: 'question', answers: { q1: ['SQLite'] } };
    });
    const id = await server.startThread({ cwd: '/p', prompt: 'pedir-aprovacao' });
    await settle();
    await server.send(id, 'perguntar');
    await settle();
    expect(asked[0]).toMatchObject({ kind: 'approval', threadId: id, tool: 'Bash', input: { command: 'rm -rf build' } });
    expect(asked[1]).toMatchObject({ kind: 'question', questions: [{ id: 'q1', question: 'Qual banco?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] });
    expect(calls().find((c) => c.approval)).toEqual({ approval: { decision: 'accept' } });
    expect(calls().find((c) => c.answers)).toEqual({ answers: { answers: { q1: { answers: ['SQLite'] } } } });
  });

  it('resume de thread que não existe: erro com o motivo; processo que morre: avisa os threads hospedados e sobe de novo depois', async () => {
    const { server, closed } = setup();
    await expect(server.resumeThread('0199aaaa-0000-7000-8000-000000000000')).rejects.toThrow(/no rollout/);
    const id = await server.startThread({ cwd: '/p' });
    await server.send(id, 'morrer').catch(() => undefined);
    await settle();
    expect(closed[0]?.threads).toEqual([id]);
    expect(server.hosts(id)).toBe(false);
    const again = await server.startThread({ cwd: '/p' });
    expect(server.hosts(again)).toBe(true);
  });

  it('initialize pede a API experimental (a pergunta do agente é um método experimental)', async () => {
    const { server, calls } = setup();
    await server.startThread({ cwd: '/p' });
    expect(calls().find((c) => c.method === 'initialize')?.params).toMatchObject({ capabilities: { experimentalApi: true } });
  });

  it('initialize que estoura o prazo: o processo é descartado e o pedido seguinte sobe outro', async () => {
    const marker = join(tempDir().dir, 'init-once');
    const { server } = setup(undefined, { env: { FAKE_CODEX_APP_HANG_INIT_ONCE: marker }, timeoutMs: 300 });
    await expect(server.startThread({ cwd: '/p' })).rejects.toThrow(/initialize/);
    const id = await server.startThread({ cwd: '/p' });
    expect(server.hosts(id)).toBe(true);
  });

  it('turn/steer que estoura o prazo falha a entrega, sem mandar de novo por turn/start', async () => {
    const { server, calls } = setup(undefined, { timeoutMs: 1_000 });
    const id = await server.startThread({ cwd: '/p', prompt: 'demorar' });
    // Espera o turno abrir (notificação turn/started) antes de mandar: senão a mensagem iria por turn/start.
    for (let i = 0; i < 50 && !calls().some((c) => c.method === 'turn/start'); i++) await settle();
    await new Promise((r) => setTimeout(r, 300));
    await expect(server.send(id, 'devagar')).rejects.toThrow(/prazo/);
    expect(calls().filter((c) => c.method === 'turn/start')).toHaveLength(1);
  });

  it('stop seguido de um processo novo: a saída atrasada do antigo não apaga as sessões do novo', async () => {
    const { server, closed } = setup();
    const old = await server.startThread({ cwd: '/p' });
    server.stop();
    expect(server.hosts(old)).toBe(false);
    expect(closed).toHaveLength(1);
    const fresh = await server.startThread({ cwd: '/p' });
    await settle();
    expect(server.hosts(fresh)).toBe(true);
    expect(closed).toHaveLength(1);
  });
});

describe('approvalResponse: cada método do Codex com o formato de resposta dele', () => {
  it('novos: accept/decline; antigos: approved/denied; permissões: as pedidas (ou nenhuma) só neste turno', () => {
    expect(approvalResponse('item/commandExecution/requestApproval', {}, true)).toEqual({ decision: 'accept' });
    expect(approvalResponse('item/fileChange/requestApproval', {}, false)).toEqual({ decision: 'decline' });
    expect(approvalResponse('execCommandApproval', {}, true)).toEqual({ decision: 'approved' });
    expect(approvalResponse('applyPatchApproval', {}, false)).toEqual({ decision: { denied: { rejection: 'recusado no Habblaud' } } });
    const permissions = { network: { enabled: true } };
    expect(approvalResponse('item/permissions/requestApproval', { permissions }, true)).toEqual({ permissions, scope: 'turn' });
    expect(approvalResponse('item/permissions/requestApproval', { permissions }, false)).toEqual({ permissions: {}, scope: 'turn' });
  });
});
