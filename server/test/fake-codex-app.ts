// `codex app-server` falso para os testes: fala JSON-RPC por linhas e imita o necessário (initialize, thread/start,
// thread/resume, turn/start, turn/steer, turn/interrupt, thread/unsubscribe) e anota cada pedido em FAKE_CODEX_APP_LOG.
// Comandos de teste pelo texto do turno:
// - "pedir-aprovacao": manda item/commandExecution/requestApproval e escreve a decisão no log;
// - "perguntar": manda item/tool/requestUserInput e escreve as respostas no log;
// - "morrer": sai com código 3 no meio do turno;
// - "demorar": o turno fica aberto (sem turn/completed) até um turn/interrupt;
// - "devagar" num turn/steer: nunca responde (prazo do cliente).
// FAKE_CODEX_APP_HANG_INIT_ONCE=<arquivo>: o primeiro initialize nunca responde (cria o arquivo); os seguintes respondem.
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** O app-server falso roda aqui? É um script com shebang; no Windows o spawn sem shell não executa. */
export const FAKE_CODEX_APP_RUNS = process.platform !== 'win32';

const SCRIPT = `#!${process.execPath}
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
if (process.argv[2] !== 'app-server') {
  process.stderr.write('esperava app-server');
  process.exit(2);
}
const log = (o) => process.env.FAKE_CODEX_APP_LOG && fs.appendFileSync(process.env.FAKE_CODEX_APP_LOG, JSON.stringify(o) + '\\n');
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n');
let seq = 0, turnSeq = 0;
const threads = new Map(); // threadId -> turnId aberto | null
const waiting = new Map(); // id do nosso pedido -> função
function serverRequest(method, params, then) { const id = 'srv-' + (++seq); waiting.set(id, then); send({ id, method, params }); }
function endTurn(threadId) { const t = threads.get(threadId); if (!t) return; threads.set(threadId, null); send({ method: 'turn/completed', params: { threadId, turn: { id: t, status: 'completed', items: [] } } }); }
function startTurn(threadId, text) {
  const turnId = 'turn-' + (++turnSeq);
  threads.set(threadId, turnId);
  send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
  if (text === 'morrer') process.exit(3);
  if (text === 'pedir-aprovacao') serverRequest('item/commandExecution/requestApproval', { threadId, turnId, itemId: 'i1', startedAtMs: Date.now(), command: 'rm -rf build', cwd: '/p' }, (r) => { log({ approval: r.result }); endTurn(threadId); });
  else if (text === 'perguntar') serverRequest('item/tool/requestUserInput', { threadId, turnId, itemId: 'i2', isBlocking: true, questions: [{ id: 'q1', header: 'Banco', question: 'Qual banco?', isOther: false, isSecret: false, options: [{ label: 'Postgres', description: 'relacional' }, { label: 'SQLite', description: 'arquivo' }] }] }, (r) => { log({ answers: r.result ?? r.error }); endTurn(threadId); });
  else if (text !== 'demorar') setTimeout(() => endTurn(threadId), 20);
  return turnId;
}
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && !m.method) { const f = waiting.get(m.id); waiting.delete(m.id); if (f) f(m); return; }
  log({ method: m.method, params: m.params, codexHome: process.env.CODEX_HOME });
  const p = m.params || {};
  const ok = (result) => send({ id: m.id, result });
  const fail = (code, message) => send({ id: m.id, error: { code, message } });
  switch (m.method) {
    case 'initialize': { const once = process.env.FAKE_CODEX_APP_HANG_INIT_ONCE; if (once && !fs.existsSync(once)) { fs.writeFileSync(once, ''); return; } return ok({ userAgent: 'fake', codexHome: process.env.CODEX_HOME }); }
    case 'initialized': return;
    case 'thread/start': { const id = '01a2' + String(++seq).padStart(4, '0') + '-0000-7000-8000-000000000000'; threads.set(id, null); return ok({ thread: { id, cwd: p.cwd } }); }
    case 'thread/resume': if (String(p.threadId).startsWith('0199aaaa')) return fail(-32603, 'no rollout found for thread id ' + p.threadId); threads.set(p.threadId, null); return ok({ thread: { id: p.threadId } });
    case 'turn/start': if (!threads.has(p.threadId)) return fail(-32600, 'thread not loaded'); return ok({ turn: { id: startTurn(p.threadId, (p.input && p.input[0] && p.input[0].text) || ''), status: 'inProgress', items: [] } });
    case 'turn/steer': { const t = threads.get(p.threadId); if (!t || t !== p.expectedTurnId) return fail(-32600, 'no active turn'); if (p.input && p.input[0] && p.input[0].text === 'devagar') return; return ok({ turnId: t }); }
    case 'turn/interrupt': { endTurn(p.threadId); return ok({}); }
    case 'thread/unsubscribe': threads.delete(p.threadId); return ok({});
    default: return fail(-32601, 'unknown method ' + m.method);
  }
});
`;

/** Grava o app-server falso em <dir>/codex e devolve o caminho (o mesmo nome do binário de verdade). */
export function writeFakeCodexApp(dir: string): string {
  const path = join(dir, 'codex');
  writeFileSync(path, SCRIPT);
  chmodSync(path, 0o755);
  return path;
}
