// Fonte do Grok: um GROK_HOME temporário (active_sessions.json, sessions/<cwd>/<id>/updates.jsonl e summary.json
// sintéticos), o AccountsService e o Office; mais o parser das linhas, o terminal e o histórico.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { HistorySet } from '../source';
import { discoverGrokDir, findSessionDir, readActiveSessions, readSummary } from './files';
import { GrokHistory } from './history';
import { grokPidAlive, GrokSource, isGrokExecutable } from './source';
import { cwdsInText } from '../../model/rooms';
import { createGrokState, createGrokTerminalParser, parseGrokLine } from './updates';

setQuiet(true);

const S1 = '01a130a5-b15b-76a1-b90b-84e2e6186734';
const S2 = '01a12b53-81ae-7c41-b2b9-148d30d36fc5';
const CWD = '/work/acme/app';
const OTHER = '/work/outra/app';
const KEY = `.grok:${S1}`;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

let seq = 0;
/** Uma linha de updates.jsonl no formato do Grok. */
function line(update: Record<string, unknown>, ms: number): string {
  seq++;
  return JSON.stringify({ timestamp: Math.floor(ms / 1000), method: 'session/update', params: { sessionId: S1, update, _meta: { eventId: `ev-${seq}`, agentTimestampMs: ms } } });
}
const prompt = (text: string, ms: number) => line({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }, ms);
const reply = (text: string, ms: number) => line({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, ms);
const tool = (id: string, name: string, rawInput: Record<string, unknown>, ms: number) =>
  line({ sessionUpdate: 'tool_call', toolCallId: id, title: name, rawInput, _meta: { 'x.ai/tool': { name } } }, ms);
const toolDone = (id: string, text: string, ms: number, status = 'completed') =>
  line({ sessionUpdate: 'tool_call_update', toolCallId: id, status, content: [{ type: 'content', content: { type: 'text', text } }] }, ms);
const turnDone = (ms: number) => line({ sessionUpdate: 'turn_completed', stop_reason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } }, ms);

function grokHome() {
  const dir = mkdtempSync(join(tmpdir(), 'habblaud-grok-'));
  mkdirSync(join(dir, 'sessions'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    active(list: Array<{ id: string; cwd: string; pid?: number }>) {
      writeFileSync(join(dir, 'active_sessions.json'), JSON.stringify(list.map((s) => ({ session_id: s.id, pid: s.pid ?? 4242, cwd: s.cwd, opened_at: new Date().toISOString() }))));
    },
    session(id: string, cwd: string, lines: string[], summary: Record<string, unknown> = {}) {
      const d = join(dir, 'sessions', encodeURIComponent(cwd), id);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'updates.jsonl'), lines.map((l) => `${l}\n`).join(''));
      writeFileSync(join(d, 'summary.json'), JSON.stringify({ info: { id, cwd }, generated_title: 'Revisão do pagamento', current_model_id: 'grok-4.7', created_at: new Date().toISOString(), ...summary }));
      return d;
    },
    append(id: string, cwd: string, lines: string[]) {
      appendFileSync(join(dir, 'sessions', encodeURIComponent(cwd), id, 'updates.jsonl'), lines.map((l) => `${l}\n`).join(''));
    },
  };
}

function setup(opts: { projectRoots?: string[]; alive?: Set<number>; inDocker?: boolean } = {}) {
  const home = grokHome();
  let clock = Date.now();
  const now = () => clock;
  const accounts = new AccountsService({ dirs: [], home: home.dir, env: {}, now, onChange: () => undefined });
  const office = new Office({
    names: new NameStore(null),
    projectRoots: opts.projectRoots,
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  const alive = opts.alive;
  const source = new GrokSource({ accounts, office, dir: home.dir, inDocker: opts.inDocker ?? false, now, isAlive: (pid) => (alive ? alive.has(pid) : true) });
  cleanups.unshift(() => source.stop());
  return {
    home,
    accounts,
    office,
    source,
    now,
    advance(ms: number) {
      clock += ms;
    },
    poll() {
      source.poll();
      office.tick();
      office.commit();
    },
    agent(id = KEY): AgentInfo | undefined {
      return office.commit().snapshot.agents.find((a) => a.id === id);
    },
  };
}

describe('Grok: linhas de updates.jsonl', () => {
  it('instrução abre o turno, ferramentas viram atividades no vocabulário do Claude Code, turn_completed fecha', () => {
    const s = createGrokState();
    const ctx = { idPrefix: 'k', now: 0 };
    const p = parseGrokLine(s, prompt('Revise o fluxo de pagamento', 1_000), ctx);
    expect(p.signals).toEqual([{ type: 'turnStart' }]);
    expect(p.activities[0].activity).toMatchObject({ kind: 'prompt', at: 1_000 });
    expect(s.firstPrompt).toBe('Revise o fluxo de pagamento');
    const r = parseGrokLine(s, tool('c1', 'read_file', { target_file: '/work/acme/app/src/pay.ts' }, 2_000), ctx);
    expect(r.activities[0].activity).toMatchObject({ id: 'k#c1', kind: 'read', tool: 'Read' });
    expect(r.activities[0].activity.text).toContain('pay.ts');
    const b = parseGrokLine(s, tool('c2', 'run_terminal_command', { command: 'npm test', description: 'Rodar os testes' }, 3_000), ctx);
    expect(b.activities[0].activity.tool).toBe('Bash');
    const e = parseGrokLine(s, tool('c3', 'search_replace', { file_path: '/work/acme/app/src/pay.ts', old_string: 'a', new_string: 'b' }, 4_000), ctx);
    expect(e.activities[0].activity).toMatchObject({ kind: 'edit', tool: 'Edit' });
    const f = parseGrokLine(s, toolDone('c2', 'erro: 1 teste falhou', 5_000, 'failed'), ctx);
    expect(f.activities[0].activity).toMatchObject({ kind: 'error', error: true });
    const d = parseGrokLine(s, turnDone(6_000), ctx);
    expect(d.signals).toEqual([{ type: 'turnEnd' }]);
    expect(s.turnOpen).toBe(false);
    expect(s.stats).toMatchObject({ toolCalls: 3, tokensIn: 100, tokensOut: 20 });
  });

  it('plan vira a lista de tarefas; linha inválida não quebra', () => {
    const s = createGrokState();
    const ctx = { idPrefix: 'k', now: 0 };
    parseGrokLine(s, line({ sessionUpdate: 'plan', entries: [{ content: 'Ler o código', status: 'completed' }, { content: 'Corrigir', status: 'in_progress' }] }, 1_000), ctx);
    expect(s.tasks).toEqual([
      { id: '1', title: 'Ler o código', status: 'completed' },
      { id: '2', title: 'Corrigir', status: 'in_progress' },
    ]);
    expect(parseGrokLine(s, '{quebrado', ctx).activities).toEqual([]);
  });

  it('terminal: instrução, ferramenta com título no estilo do Claude Code, resultado e resposta; segredo mascarado', () => {
    const t = createGrokTerminalParser(() => 0);
    expect(t.push(prompt('rode os testes', 1_000))).toMatchObject([{ kind: 'user', text: 'rode os testes' }]);
    expect(t.push(tool('c1', 'run_terminal_command', { command: 'npm test', variant: 'x' }, 2_000))).toMatchObject([{ kind: 'tool', id: 'c1', tool: 'Bash', title: 'Bash(npm test)', input: 'npm test' }]);
    expect(t.push(toolDone('c1', 'ok', 3_000))).toMatchObject([{ kind: 'result', toolUseId: 'c1', text: 'ok' }]);
    const [r] = t.push(reply('token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 4_000));
    expect(r.kind).toBe('assistant');
    expect((r as { text: string }).text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });
});

describe('Grok: arquivos', () => {
  it('lê active_sessions.json, acha a pasta da sessão e o summary.json; sem sessions/ nem a lista = sem Grok', () => {
    const home = grokHome();
    home.active([{ id: S1, cwd: CWD }, { id: '../fora', cwd: CWD }]);
    home.session(S1, CWD, [prompt('oi', 1_000)], { session_kind: 'subagent' });
    expect(readActiveSessions(home.dir)?.map((s) => s.sessionId)).toEqual([S1]);
    const d = findSessionDir(home.dir, S1, CWD);
    expect(d).toBeDefined();
    expect(findSessionDir(home.dir, S1)).toBe(d);
    expect(readSummary(d!)).toMatchObject({ title: 'Revisão do pagamento', cwd: CWD, model: 'grok-4.7', kind: 'subagent' });
    expect(discoverGrokDir({ GROK_HOME: home.dir }, '/nada')).toBe(home.dir);
    expect(discoverGrokDir({ GROK_HOME: join(home.dir, 'nao-existe') }, '/nada')).toBeUndefined();
  });
});

describe('Grok: fonte de agentes', () => {
  it('sessão aberta entra na sala do projeto com título, modelo e status; atividade nova chega ao vivo; fechada sai', () => {
    const ctx = setup();
    const t0 = ctx.now();
    ctx.home.active([{ id: S1, cwd: CWD }]);
    ctx.home.session(S1, CWD, [prompt('Revise o pagamento', t0 - 5_000), tool('c1', 'read_file', { target_file: `${CWD}/pay.ts` }, t0 - 4_000)]);
    ctx.source.start();
    const a = ctx.agent();
    expect(a).toMatchObject({ provider: 'grok', roomId: CWD, status: 'working', title: 'Revisão do pagamento', model: 'grok-4.7', account: '.grok' });
    expect(a?.activity?.tool).toBe('Read');
    ctx.home.append(S1, CWD, [tool('c2', 'grep', { pattern: 'charge' }, t0 + 1_000), turnDone(t0 + 2_000)]);
    ctx.advance(1_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
    expect(ctx.agent()?.recent.some((x) => x.tool === 'Grep')).toBe(true);
    ctx.home.active([]);
    ctx.poll();
    ctx.advance(2_000);
    ctx.poll();
    const gone = ctx.agent();
    expect(gone === undefined || gone.status === 'offline').toBe(true);
    expect(ctx.source.sources()[0]).toMatchObject({ provider: 'grok', sessions: 0, ok: true });
  });

  it('Docker: presença pela conversa modificada há pouco (sem active_sessions.json)', () => {
    const ctx = setup({ inDocker: true });
    const d = ctx.home.session(S1, CWD, [prompt('oi', ctx.now())]);
    ctx.home.session(S2, OTHER, [prompt('velha', ctx.now())]);
    ctx.home.session('01a12b72-2b94-7dd0-a593-d4ddc796b9ef', CWD, [prompt('grok -p', ctx.now())], { session_kind: 'headless' });
    const old = new Date(ctx.now() - 2 * 3600_000);
    utimesSync(join(d, '..', '..', encodeURIComponent(OTHER), S2, 'updates.jsonl'), old, old);
    ctx.source.start();
    expect(ctx.agent()).toMatchObject({ roomId: CWD });
    expect(ctx.agent(`.grok:${S2}`)).toBeUndefined();
    expect(ctx.agent('.grok:01a12b72-2b94-7dd0-a593-d4ddc796b9ef')).toBeUndefined();
  });

  it('pid morto não conta (fora do Docker); subagente fica de fora', () => {
    const ctx = setup({ alive: new Set([1]) });
    ctx.home.active([{ id: S1, cwd: CWD, pid: 2 }, { id: S2, cwd: CWD, pid: 1 }]);
    ctx.home.session(S1, CWD, [prompt('oi', ctx.now())]);
    ctx.home.session(S2, CWD, [prompt('oi', ctx.now())], { session_kind: 'subagent' });
    ctx.source.start();
    expect(ctx.agent()).toBeUndefined();
    expect(ctx.agent(`.grok:${S2}`)).toBeUndefined();
  });

  it('escopo por pasta: sessão de fora não entra; linha nova de outra pasta tira a sessão; terminal com o parser do Grok', () => {
    const ctx = setup({ projectRoots: ['/work/acme'] });
    const t0 = ctx.now();
    ctx.home.active([{ id: S1, cwd: CWD }, { id: S2, cwd: OTHER }]);
    ctx.home.session(S1, CWD, [prompt('dentro', t0)]);
    ctx.home.session(S2, OTHER, [prompt('fora', t0)]);
    ctx.source.start();
    expect(ctx.agent()).toBeDefined();
    expect(ctx.agent(`.grok:${S2}`)).toBeUndefined();
    expect(ctx.source.transcriptPathOf(KEY)).toContain('updates.jsonl');
    expect(ctx.source.terminalParser(KEY)).toBeDefined();
    const bg = line({ sessionUpdate: 'task_backgrounded', task_id: 't1', command: 'ls', cwd: OTHER }, t0 + 1_000);
    ctx.home.append(S1, CWD, [bg]);
    ctx.advance(1_000);
    ctx.poll();
    expect(ctx.agent()).toBeUndefined();
  });

  it('escopo por pasta: arquivo que já passou por outra pasta não entra', () => {
    const ctx = setup({ projectRoots: ['/work/acme'] });
    const t0 = ctx.now();
    ctx.home.active([{ id: S1, cwd: CWD }]);
    ctx.home.session(S1, CWD, [line({ sessionUpdate: 'task_backgrounded', cwd: OTHER }, t0), prompt('dentro', t0)]);
    ctx.source.start();
    expect(ctx.agent()).toBeUndefined();
  });
});

describe('Grok: histórico do terminal', () => {
  it('lista as sessões recentes (sem subagentes) e resolve a conversa; com escopo, a pasta do summary.json decide', async () => {
    const home = grokHome();
    const t0 = Date.now();
    home.session(S1, CWD, [prompt('dentro', t0)]);
    home.session(S2, OTHER, [prompt('fora', t0)]);
    home.session('01a12b72-2b94-7dd0-a593-d4ddc796b9ef', CWD, [prompt('sub', t0)], { session_kind: 'subagent' });
    const account = () => ({ id: '.grok', dir: home.dir });
    const all = new GrokHistory({ account, openAgentOf: () => undefined });
    expect((await all.list()).map((s) => s.sessionId).sort()).toEqual([S2, S1].sort());
    const inScope = (p: string) => p.startsWith('/work/acme/') || p === '/work/acme';
    const set = new HistorySet([new GrokHistory({ account, openAgentOf: () => undefined, inScope })], undefined, inScope);
    const listed = await set.list();
    expect(listed.map((s) => [s.sessionId, s.provider, s.project, s.title])).toEqual([[S1, 'grok', CWD, 'Revisão do pagamento']]);
    expect('path' in set.resolve('.grok', S1)).toBe(true);
    expect(set.resolve('.grok', S2)).toEqual({ status: 404, error: 'sessão não encontrada' });
    expect(set.resolve('.grok', '../x')).toMatchObject({ status: 400 });
  });
});

describe('Grok: verificação cruzada (achados do Codex)', () => {
  it('mesmo id em outra pasta nunca serve; id ambíguo sem cwd = nada; cwd relativo recusado', () => {
    const home = grokHome();
    home.session(S1, OTHER, [prompt('PRIVADO', Date.now())]);
    expect(findSessionDir(home.dir, S1, CWD)).toBeUndefined();
    expect(findSessionDir(home.dir, S1)).toBeDefined();
    home.session(S1, CWD, [prompt('dentro', Date.now())]);
    expect(findSessionDir(home.dir, S1)).toBeUndefined();
    expect(findSessionDir(home.dir, S1, '..')).toBeUndefined();
    writeFileSync(join(home.dir, 'active_sessions.json'), JSON.stringify([{ session_id: S2, pid: 1, cwd: '..' }, { session_id: S1, pid: 1, cwd: '/a/../b' }]));
    expect(readActiveSessions(home.dir)).toEqual([]);
  });

  it('sessão registrada numa pasta com a conversa só em outra não entra (nem o título)', () => {
    const ctx = setup({ projectRoots: ['/work/acme'] });
    ctx.home.active([{ id: S1, cwd: CWD }]);
    ctx.home.session(S1, OTHER, [prompt('PRIVADO', ctx.now())]);
    ctx.source.start();
    const a = ctx.agent();
    expect(a?.title).toBeUndefined();
    expect(JSON.stringify(ctx.office.commit().snapshot)).not.toContain('PRIVADO');
    expect(ctx.source.transcriptPathOf(KEY)).toBeUndefined();
  });

  it('a mesma sessão mudando de pasta no registro: sai na hora se a nova for de fora', () => {
    const ctx = setup({ projectRoots: ['/work/acme'] });
    ctx.home.active([{ id: S1, cwd: CWD }]);
    ctx.home.session(S1, CWD, [prompt('dentro', ctx.now())]);
    ctx.source.start();
    expect(ctx.agent()).toBeDefined();
    ctx.home.active([{ id: S1, cwd: OTHER }]);
    ctx.poll();
    expect(ctx.agent()).toBeUndefined();
  });

  it('updates.jsonl como link para fora de sessions/ é ignorado (fonte e histórico)', () => {
    const ctx = setup();
    const d = ctx.home.session(S1, CWD, []);
    const outside = join(ctx.home.dir, 'fora.jsonl');
    writeFileSync(outside, `${prompt('SEGREDO_FORA', ctx.now())}\n`);
    rmSync(join(d, 'updates.jsonl'));
    symlinkSync(outside, join(d, 'updates.jsonl'));
    ctx.home.active([{ id: S1, cwd: CWD }]);
    ctx.source.start();
    expect(ctx.source.transcriptPathOf(KEY)).toBeUndefined();
    const hist = new GrokHistory({ account: () => ({ id: '.grok', dir: ctx.home.dir }), openAgentOf: () => undefined });
    expect(hist.resolve('.grok', S1)).toMatchObject({ status: 404 });
  });

  it('segredos: título do resumo, nome de ferramenta sem metadado e chave xai- solta saem mascarados', () => {
    const home = grokHome();
    const d = home.session(S1, CWD, [], { generated_title: 'deploy com ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
    expect(readSummary(d).title).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    const key = `xai-${'a1B2'.repeat(20)}`;
    const t = createGrokTerminalParser(() => 0);
    const noName = line({ sessionUpdate: 'tool_call', toolCallId: 'c9', title: `curl -H 'X: ${key}' https://x`, rawInput: { command: `curl ${key}` } }, 1_000);
    const out = JSON.stringify([...t.push(noName), ...t.push(prompt(`minha chave é ${key}`, 2_000))]);
    expect(out).not.toContain(key);
    const s = createGrokState();
    const r = parseGrokLine(s, noName, { idPrefix: 'k', now: 0 });
    expect(r.activities[0].activity.tool).toBe('ferramenta');
    expect(JSON.stringify(r)).not.toContain(key);
  });

  it('histórico: conversa que passou por outra pasta fica fora da lista; sem cwd no resumo vale a do grupo', async () => {
    const home = grokHome();
    const t0 = Date.now();
    home.session(S1, CWD, [line({ sessionUpdate: 'task_backgrounded', cwd: OTHER }, t0), prompt('x', t0)]);
    home.session(S2, CWD, [prompt('ok', t0)], { info: { id: S2 } });
    const inScope = (p: string) => p.startsWith('/work/acme/');
    const set = new HistorySet([new GrokHistory({ account: () => ({ id: '.grok', dir: home.dir }), openAgentOf: () => undefined, inScope })], undefined, inScope);
    expect((await set.list()).map((x) => x.sessionId)).toEqual([S2]);
    expect('path' in set.resolve('.grok', S2)).toBe(true);
  });

  it('Docker: sem summary.json ainda (pode ser um grok -p) a sessão espera', () => {
    const ctx = setup({ inDocker: true });
    const d = ctx.home.session(S1, CWD, [prompt('oi', ctx.now())]);
    rmSync(join(d, 'summary.json'));
    ctx.source.start();
    expect(ctx.agent()).toBeUndefined();
  });

  it('resultados reais: rawOutput (ListDir) e diff do search_replace; o terminal mantém as quebras de linha', () => {
    const t = createGrokTerminalParser(() => 0);
    const listDir = line({ sessionUpdate: 'tool_call_update', toolCallId: 'l1', status: 'completed', rawOutput: { type: 'ListDir', Content: { content: 'a.ts\nb.ts' } } }, 1_000);
    expect(t.push(listDir)).toMatchObject([{ kind: 'result', text: 'a.ts\nb.ts' }]);
    const diff = line({ sessionUpdate: 'tool_call_update', toolCallId: 'e1', status: 'completed', content: [{ type: 'diff', path: '/w/a.ts', oldText: 'x', newText: 'y' }] }, 2_000);
    expect(t.push(diff)).toMatchObject([{ kind: 'result', text: '/w/a.ts\n- x\n+ y' }]);
    expect(t.push(prompt('linha 1\n  linha 2', 3_000))).toMatchObject([{ kind: 'user', text: 'linha 1\n  linha 2' }]);
  });

  it('janela sem a instrução, mas com ferramenta recente: trabalhando', () => {
    const ctx = setup();
    ctx.home.active([{ id: S1, cwd: CWD }]);
    ctx.home.session(S1, CWD, [tool('c1', 'read_file', { target_file: `${CWD}/a.ts` }, ctx.now() - 1_000)]);
    ctx.source.start();
    expect(ctx.agent()?.status).toBe('working');
  });

  it('pid vivo de outro programa não conta como sessão do Grok', () => {
    expect(grokPidAlive(process.pid)).toBe(false);
  });

  it('current_dir de outra pasta num resultado do Bash tira a sessão', () => {
    const ctx = setup({ projectRoots: ['/work/acme'] });
    ctx.home.active([{ id: S1, cwd: CWD }]);
    ctx.home.session(S1, CWD, [prompt('dentro', ctx.now())]);
    ctx.source.start();
    expect(ctx.agent()).toBeDefined();
    ctx.home.append(S1, CWD, [line({ sessionUpdate: 'tool_call_update', toolCallId: 'b1', status: 'completed', rawOutput: { type: 'Bash', current_dir: OTHER, output: 'PRIVADO' } }, ctx.now() + 1)]);
    ctx.advance(1_000);
    ctx.poll();
    expect(ctx.agent()).toBeUndefined();
  });

  it('linha repetida (mesmo eventId) não conta duas vezes nos números', () => {
    const s = createGrokState();
    const ctx = { idPrefix: 'k', now: 0 };
    const tc = tool('c1', 'grep', { pattern: 'x' }, 1_000);
    const done = turnDone(2_000);
    for (const l of [tc, tc, done, done]) parseGrokLine(s, l, ctx);
    expect(s.stats).toMatchObject({ toolCalls: 1, tokensIn: 100, tokensOut: 20 });
  });
});

describe('Grok: segunda rodada da verificação', () => {
  it('conversa trocada por um link depois de aberta: a sessão sai e nada do link aparece', () => {
    const ctx = setup();
    ctx.home.active([{ id: S1, cwd: CWD }]);
    const d = ctx.home.session(S1, CWD, [prompt('dentro', ctx.now())]);
    ctx.source.start();
    expect(ctx.agent()).toBeDefined();
    const outside = join(ctx.home.dir, 'fora.jsonl');
    writeFileSync(outside, `${prompt('PRIVADO_LINK', ctx.now())}\n`);
    rmSync(join(d, 'updates.jsonl'));
    symlinkSync(outside, join(d, 'updates.jsonl'));
    ctx.advance(4_000);
    ctx.poll();
    expect(JSON.stringify(ctx.office.commit().snapshot)).not.toContain('PRIVADO_LINK');
    expect(ctx.source.transcriptPathOf(KEY)).toBeUndefined();
  });

  it('grupo que é link para o grupo de outra pasta não serve', () => {
    const home = grokHome();
    home.session(S1, OTHER, [prompt('PRIVADO_ALIAS', Date.now())], { info: { id: S1 } });
    symlinkSync(join(home.dir, 'sessions', encodeURIComponent(OTHER)), join(home.dir, 'sessions', encodeURIComponent(CWD)));
    expect(findSessionDir(home.dir, S1, CWD)).toBeUndefined();
  });

  it('nome de ferramenta com cara de token ou vindo do use_tool sai como rótulo fixo', () => {
    const token = `ghp_${'C'.repeat(36)}`;
    const t = createGrokTerminalParser(() => 0);
    const a = line({ sessionUpdate: 'tool_call', toolCallId: 'n1', rawInput: {}, _meta: { 'x.ai/tool': { name: token } } }, 1_000);
    const b = tool('n2', 'use_tool', { tool_name: `curl ${token}` }, 2_000);
    const s = createGrokState();
    const out = JSON.stringify([...t.push(a), ...t.push(b), parseGrokLine(s, a, { idPrefix: 'k', now: 0 }), parseGrokLine(s, b, { idPrefix: 'k', now: 0 })]);
    expect(out).not.toContain(token);
  });

  it('current_dir só conta na conversa do Grok (no Claude Code e no Codex é dado de ferramenta)', () => {
    const l = JSON.stringify({ cwd: '/work/acme/app', input: { current_dir: 'archive' } });
    expect(cwdsInText(l)).toEqual(['/work/acme/app']);
    expect(cwdsInText(l, true)).toEqual(['/work/acme/app', 'archive']);
  });

  it('mudança de pasta dentro do escopo: o agente vai para a sala nova, sem as atividades da antiga', () => {
    const ctx = setup({ projectRoots: ['/work/acme'] });
    const NEW = '/work/acme/outra';
    ctx.home.active([{ id: S1, cwd: CWD }]);
    ctx.home.session(S1, CWD, [prompt('ANTIGA', ctx.now())]);
    ctx.source.start();
    ctx.home.active([{ id: S1, cwd: NEW }]);
    ctx.home.session(S1, NEW, [prompt('nova', ctx.now())]);
    ctx.advance(4_000);
    ctx.poll();
    const a = ctx.agent();
    expect(a?.roomId).toBe(NEW);
    expect(JSON.stringify(a?.recent)).not.toContain('ANTIGA');
  });

  it('Docker: summary.json ilegível não classifica a sessão (pode ser um grok -p)', () => {
    const ctx = setup({ inDocker: true });
    const d = ctx.home.session(S1, CWD, [prompt('oi', ctx.now())]);
    writeFileSync(join(d, 'summary.json'), '{');
    ctx.source.start();
    expect(ctx.agent()).toBeUndefined();
  });

  it('executável do Grok pelo nome exato', () => {
    expect(isGrokExecutable('grok')).toBe(true);
    expect(isGrokExecutable('/Users/x/.grok/downloads/grok-1.0.50-macos-aarch64')).toBe(true);
    expect(isGrokExecutable('/tmp/not-grok')).toBe(false);
    expect(isGrokExecutable('grokker')).toBe(false);
  });
});

describe('Grok: terceira rodada da verificação', () => {
  it('grupo trocado por um link com só o summary.json: título e modelo de lá não aparecem', () => {
    const ctx = setup();
    ctx.home.active([{ id: S1, cwd: CWD }]);
    ctx.home.session(S1, CWD, [prompt('dentro', ctx.now())]);
    ctx.source.start();
    expect(ctx.agent()).toBeDefined();
    const group = join(ctx.home.dir, 'sessions', encodeURIComponent(CWD));
    const fake = join(ctx.home.dir, 'fora', S1);
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, 'summary.json'), JSON.stringify({ generated_title: 'TITULO_PRIVADO', current_model_id: 'MODELO_PRIVADO' }));
    rmSync(group, { recursive: true });
    symlinkSync(join(ctx.home.dir, 'fora'), group);
    ctx.advance(4_000);
    ctx.poll();
    const snap = JSON.stringify(ctx.office.commit().snapshot);
    expect(snap).not.toContain('TITULO_PRIVADO');
    expect(snap).not.toContain('MODELO_PRIVADO');
  });

  it('summary.json com um array não vale como resumo (Docker não admite)', () => {
    const ctx = setup({ inDocker: true });
    const d = ctx.home.session(S1, CWD, [prompt('oi', ctx.now())]);
    writeFileSync(join(d, 'summary.json'), '[]');
    expect(readSummary(d).ok).toBeUndefined();
    ctx.source.start();
    expect(ctx.agent()).toBeUndefined();
  });

  it('transcriptOk: o terminal recusa a conversa trocada por link', () => {
    const ctx = setup();
    const d = ctx.home.session(S1, CWD, [prompt('oi', ctx.now())]);
    const p = join(d, 'updates.jsonl');
    expect(ctx.source.transcriptOk(p)).toBe(true);
    const outside = join(ctx.home.dir, 'fora.jsonl');
    writeFileSync(outside, 'x\n');
    rmSync(p);
    symlinkSync(outside, p);
    expect(ctx.source.transcriptOk(p)).toBe(false);
    expect(ctx.source.transcriptOk(outside)).toBe(false);
  });
});

describe('Grok: consumo (usage.json)', () => {
  const usage = (turns: Array<{ endedAt: number; cost: number; tokens: number }>) =>
    JSON.stringify({ sessionId: 'x', turns: turns.map((t, i) => ({ turnNumber: i + 1, endedAt: new Date(t.endedAt).toISOString(), totalTokens: t.tokens, costUsdTicks: t.cost * 1e10 })) });

  it('soma custo e tokens dos turnos das últimas 5 h e dos últimos 7 dias, de todas as sessões, e empurra para a conta', () => {
    const ctx = setup();
    const t0 = ctx.now();
    const d1 = ctx.home.session(S1, CWD, [prompt('a', t0)]);
    const d2 = ctx.home.session(S2, OTHER, [prompt('b', t0)]);
    writeFileSync(join(d1, 'usage.json'), usage([{ endedAt: t0 - 60_000, cost: 1.5, tokens: 1000 }, { endedAt: t0 - 6 * 3600_000, cost: 2, tokens: 500 }]));
    writeFileSync(join(d2, 'usage.json'), usage([{ endedAt: t0 - 2 * 3600_000, cost: 0.25, tokens: 100 }, { endedAt: t0 - 8 * 86400_000, cost: 9, tokens: 9 }]));
    ctx.source.start();
    const acc = ctx.office.commit().snapshot.accounts.find((a) => a.id === '.grok');
    expect(acc?.usageStatus).toBe('ok');
    expect(acc?.usage).toMatchObject({ source: 'grok', spend: { fiveHour: { costUsd: 1.75, tokens: 1100 }, sevenDay: { costUsd: 3.75, tokens: 1600 } } });
  });

  it('usage.json como link para fora de sessions/ não conta', () => {
    const ctx = setup();
    const t0 = ctx.now();
    const d1 = ctx.home.session(S1, CWD, [prompt('a', t0)]);
    const fora = join(ctx.home.dir, 'fora.json');
    writeFileSync(fora, usage([{ endedAt: t0 - 60_000, cost: 5, tokens: 5 }]));
    symlinkSync(fora, join(d1, 'usage.json'));
    ctx.source.start();
    const acc = ctx.office.commit().snapshot.accounts.find((a) => a.id === '.grok');
    expect(acc?.usage?.spend?.fiveHour.costUsd ?? 0).toBe(0);
  });
});
