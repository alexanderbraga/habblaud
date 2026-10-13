import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonRpcError, JsonRpcPeer, spawnJsonRpc } from './jsonrpc';

const peers: JsonRpcPeer[] = [];
const children: Array<ReturnType<typeof spawnJsonRpc>> = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const peer of peers.splice(0)) peer.close();
});

/** Dois peers ligados por streams em memória (a = cliente, b = "processo"). */
function pair(opts: { onRequestB?: (m: string, p: unknown) => Promise<unknown>; onNotificationA?: (m: string, p: unknown) => void } = {}) {
  const ab = new PassThrough();
  const ba = new PassThrough();
  const a = new JsonRpcPeer({ input: ba, output: ab, onNotification: opts.onNotificationA, defaultTimeoutMs: 200 });
  const b = new JsonRpcPeer({ input: ab, output: ba, onRequest: opts.onRequestB });
  peers.push(a, b);
  return { a, b, ab, ba };
}

describe('JsonRpcPeer', () => {
  it('pedido e resposta; erro do outro lado vira JsonRpcError com código', async () => {
    const { a } = pair({
      onRequestB: async (m, p) => {
        if (m === 'falha') throw new JsonRpcError('não deu', -32001, { motivo: 'teste' });
        return { eco: p };
      },
    });
    await expect(a.request('eco', { x: 1 })).resolves.toEqual({ eco: { x: 1 } });
    await expect(a.request('falha')).rejects.toMatchObject({ message: 'não deu', code: -32001, data: { motivo: 'teste' } });
  });

  it('sem resposta no prazo: rejeita; pedido desconhecido do outro lado: -32601', async () => {
    const { a } = pair({ onRequestB: () => new Promise(() => {}) });
    await expect(a.request('nada', {}, 50)).rejects.toThrow(/prazo/);
    await expect(a.request('prazo padrão')).rejects.toThrow(/prazo/);
    const { a: c } = pair();
    await expect(c.request('qualquer', {}, 100)).rejects.toMatchObject({ code: -32601 });
  });

  it('notificações chegam; linha que não é JSON é ignorada', async () => {
    const got: Array<{ method: string; params: unknown }> = [];
    let received!: () => void;
    const notification = new Promise<void>((done) => { received = done; });
    const { a, b, ba } = pair({
      onNotificationA: (method, params) => {
        got.push({ method, params });
        received();
      },
    });
    ba.write('linha que não é JSON\nnull\n[]\n');
    b.notify('turn/started', { threadId: 't' });
    await notification;
    expect(got).toEqual([{ method: 'turn/started', params: { threadId: 't' } }]);
    expect(a.closed).toBe(false);
  });

  it('close rejeita os pendentes com o motivo e avisa onClose uma única vez', async () => {
    const { a } = pair({ onRequestB: () => new Promise(() => {}) });
    const reasons: string[] = [];
    a.onClose((reason) => reasons.push(reason));
    const p = a.request('demora', {}, 5_000);
    const q = a.request('outra demora', {}, 5_000);
    a.close('processo saiu');
    a.close('outro motivo');
    await expect(p).rejects.toBeInstanceOf(JsonRpcError);
    await expect(q).rejects.toThrow('processo saiu');
    expect(a.closed).toBe(true);
    expect(reasons).toEqual(['processo saiu']);
    await expect(a.request('depois')).rejects.toThrow('processo saiu');
  });

  it('fim do stream fecha o peer e rejeita o pedido pendente', async () => {
    const { a, ba } = pair({ onRequestB: () => new Promise(() => {}) });
    const p = a.request('demora', {}, 50);
    ba.end();
    await expect(p).rejects.toThrow(/processo fechou a conexão/);
    expect(a.closed).toBe(true);
  });

  it('falha ao escrever fecha o peer e rejeita com JsonRpcError', async () => {
    const peer = new JsonRpcPeer({
      input: new PassThrough(),
      output: new Writable({ write() { throw new Error('falha de escrita'); } }),
      defaultTimeoutMs: 50,
    });
    peers.push(peer);
    const p = peer.request('eco');
    await expect(p).rejects.toBeInstanceOf(JsonRpcError);
    await expect(p).rejects.toThrow('não consegui escrever para o processo');
    expect(peer.closed).toBe(true);
    expect(() => peer.notify('depois')).not.toThrow();
  });
});

describe('spawnJsonRpc', () => {
  it('liga o peer ao processo com env e cwd; a saída rejeita os pedidos pendentes', async () => {
    const cwd = process.cwd();
    const child = spawnJsonRpc(process.execPath, ['--input-type=module', '-e', `
      import { createInterface } from 'node:readline';
      createInterface({ input: process.stdin }).on('line', (line) => {
        const m = JSON.parse(line);
        if (m.method === 'sair') process.exit(7);
        if (m.method === 'eco') process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: m.id,
          result: { eco: m.params, cwd: process.cwd(), teste: process.env.HABBLAUD_RPC_TEST },
        }) + '\\n');
      });
    `], { env: { ...process.env, HABBLAUD_RPC_TEST: 'teste' }, cwd, defaultTimeoutMs: 5_000 });
    children.push(child);
    peers.push(child.peer);
    expect(typeof child.pid).toBe('number');
    await expect(child.peer.request('eco', { x: 1 })).resolves.toEqual({ eco: { x: 1 }, cwd, teste: 'teste' });
    const p = child.peer.request('demora');
    const rejected = expect(p).rejects.toThrow(/processo/);
    child.peer.notify('sair');
    await rejected;
    expect(child.peer.closed).toBe(true);
  }, 10_000);

  it('falha ao iniciar o processo fecha o peer com o motivo', async () => {
    const child = spawnJsonRpc(`${process.cwd()}/binario-jsonrpc-inexistente`, [], { defaultTimeoutMs: 1_000 });
    children.push(child);
    peers.push(child.peer);
    await expect(child.peer.request('eco')).rejects.toThrow(/não consegui rodar/);
    expect(child.peer.closed).toBe(true);
  });
});
