// Funções puras de scripts/docker-up.ts (importar o módulo não sobe nada).
import { describe, expect, it } from 'vitest';
import type { DetectedAccount } from '../accounts/detect';
import { legacyEnvWarning } from '../legacy';
import {
  accountsPayload,
  CODEX_MOUNTED_SUBDIRS,
  codexAccountsPayload,
  codexDisabled,
  composeArgs,
  copyVolumeArgs,
  type DockerState,
  envFileKeys,
  hostTimeZone,
  instanceNames,
  instanceProblem,
  instancesWith,
  parseArgs,
  planCodexMounts,
  planGrokMount,
  planMounts,
  planUp,
  projectRootsOf,
  renderOverride,
  sanitizeCachedUsage,
  yamlString,
} from '../../scripts/docker-up';

const acc = (id: string, extra: Partial<DetectedAccount> = {}): DetectedAccount => ({
  id,
  configDir: `/Users/fulano/${id}`,
  short: id === '.claude' ? 'C' : 'D',
  name: id === '.claude' ? 'Conta C' : 'Conta D',
  color: '#000000',
  ...extra,
});

/** Os caminhos do host aqui são escritos com `/`; no Windows, o join do planMounts os devolve com `\`. */
const slash = (p: string) => p.replaceAll('\\', '/');

describe('docker-up', () => {
  it('argumentos', () => {
    expect(parseArgs([])).toEqual({ down: false, build: true, help: false, mod: true });
    expect(parseArgs(['--no-build'])).toEqual({ down: false, build: false, help: false, mod: true });
    expect(parseArgs(['--no-mod'])).toMatchObject({ mod: false });
    expect(parseArgs(['--down'])).toMatchObject({ down: true });
    expect(() => parseArgs(['--xyz'])).toThrow(/opção desconhecida/);
  });

  it('monta só projects/ e sessions/ que existem', () => {
    const dirs = ['/Users/fulano/.claude', '/Users/fulano/.claude-conta2'];
    const exists = new Set(['/Users/fulano/.claude/projects', '/Users/fulano/.claude/sessions', '/Users/fulano/.claude-conta2/sessions']);
    const mounts = planMounts(dirs, [acc('.claude'), acc('.claude-conta2')], (p) => (exists.has(slash(p)) ? `/real${slash(p)}` : undefined));
    expect(mounts.map((m) => m.binds)).toEqual([
      [
        { source: '/real/Users/fulano/.claude/projects', target: '/claude/.claude/projects' },
        { source: '/real/Users/fulano/.claude/sessions', target: '/claude/.claude/sessions' },
      ],
      [{ source: '/real/Users/fulano/.claude-conta2/sessions', target: '/claude/.claude-conta2/sessions' }],
    ]);
  });

  it('cache de uso: só data e percentuais/reinícios das janelas exibidas', () => {
    expect(sanitizeCachedUsage(null)).toBeUndefined();
    expect(
      sanitizeCachedUsage({
        fetchedAtMs: 5,
        accountUuid: 'nao',
        utilization: { five_hour: { utilization: 10, resets_at: null }, seven_day: { utilization: 20, resets_at: 'x' }, extra_usage: { monthly_limit: 99 } },
      }),
    ).toEqual({ fetchedAtMs: 5, utilization: { five_hour: { utilization: 10 }, seven_day: { utilization: 20, resets_at: 'x' } } });
  });

  it('override: somente leitura, sem criar pastas no host, `$` escapado e a pasta do statusline em /usage', () => {
    const mounts = planMounts(['/Users/fu$lano/.claude'], [acc('.claude', { email: 'a@b.c', cachedUsage: { fetchedAtMs: 1, utilization: {} } })], slash);
    const yml = renderOverride(mounts, new Date('2026-10-06T00:00:00Z'), '/Users/fulano/.habblaud/usage');
    expect(yml).toContain('source: "/Users/fu$$lano/.claude/projects"');
    expect(yml).toContain('HABBLAUD_USAGE_DIR: "/usage"');
    expect(yml).toContain('source: "/Users/fulano/.habblaud/usage"\n        target: "/usage"\n        read_only: true');
    const binds = yml.split('- type: bind').length - 1;
    expect(binds).toBe(3);
    expect(yml.match(/read_only: true/g)).toHaveLength(3);
    expect(yml.match(/create_host_path: false/g)).toHaveLength(3);
    // Payload das contas: sem cache vazio, sem campos que não existem.
    expect(accountsPayload(mounts)).toEqual([{ id: '.claude', configDir: '/Users/fulano/.claude', mountDir: '/claude/.claude', short: 'C', name: 'Conta C', color: '#000000', email: 'a@b.c' }]);
    // Sem a pasta do statusline: nada de /usage.
    expect(renderOverride(mounts)).not.toContain('/usage');
    expect(yamlString('a"b$c')).toBe('"a\\"b$$c"');
  });

  it('Codex: monta SÓ sessions/, archived_sessions/ e thread-writer-locks/ (somente leitura) e passa as contas com a pasta do host', () => {
    expect([...CODEX_MOUNTED_SUBDIRS]).toEqual(['sessions', 'archived_sessions', 'thread-writer-locks']);
    const host = '/Users/fulano/.codex';
    // Existem no host também auth.json, config.toml, history.jsonl, shell_snapshots/, logs e SQLite: nada disso entra.
    const exists = new Set([`${host}/sessions`, `${host}/thread-writer-locks`, `${host}/auth.json`, `${host}/config.toml`, `${host}/shell_snapshots`, `${host}/history.jsonl`]);
    const codexAcc: DetectedAccount = { id: '.codex', provider: 'codex', configDir: host, short: 'CX', name: 'Codex', color: '#5cc97b', plan: 'Plus' };
    const codex = planCodexMounts([host, '/Users/fulano/.codex-vazia'], [codexAcc, { ...codexAcc, id: '.codex-vazia' }], (p) => (exists.has(slash(p)) ? `/real${slash(p)}` : undefined));
    expect(codex.map((m) => m.binds)).toEqual([
      [
        { source: `/real${host}/sessions`, target: '/codex/.codex/sessions' },
        { source: `/real${host}/thread-writer-locks`, target: '/codex/.codex/thread-writer-locks' },
      ],
    ]);
    expect(codexAccountsPayload(codex)).toEqual([
      { id: '.codex', provider: 'codex', configDir: host, mountDir: '/codex/.codex', short: 'CX', name: 'Codex', color: '#5cc97b', plan: 'Plus' },
    ]);
    const claude = planMounts(['/Users/fulano/.claude'], [acc('.claude')], slash);
    const yml = renderOverride(claude, new Date(0), undefined, undefined, codex);
    expect(yml).toContain('HABBLAUD_CODEX_DIRS: "/codex/.codex"');
    expect(yml).toContain(`source: "/real${host}/thread-writer-locks"\n        target: "/codex/.codex/thread-writer-locks"\n        read_only: true`);
    expect(yml.match(/read_only: true/g)).toHaveLength(4);
    for (const secret of ['auth.json', 'config.toml', 'history.jsonl', 'shell_snapshots', 'sqlite', 'logs_']) expect(yml).not.toContain(secret);
    const accounts = JSON.parse(JSON.parse(/HABBLAUD_ACCOUNTS: (".*")/.exec(yml)![1]) as string) as Array<Record<string, unknown>>;
    expect(accounts.map((a) => [a.id, a.provider, a.configDir])).toEqual([
      ['.claude', undefined, '/Users/fulano/.claude'],
      ['.codex', 'codex', host],
    ]);
    // Sem Codex: nada de HABBLAUD_CODEX_DIRS.
    expect(renderOverride(claude)).not.toContain('HABBLAUD_CODEX_DIRS');
    expect(codexDisabled({ HABBLAUD_CODEX: '0' })).toBe(true);
    expect(codexDisabled({ HABBLAUD_CODEX: 'off' })).toBe(true);
    expect(codexDisabled({ HABBLAUD_CODEX: '1' })).toBe(false);
    expect(codexDisabled({})).toBe(false);
  });

  it('fuso do host vai para o container como TZ', () => {
    const mounts = planMounts(['/Users/fulano/.claude'], [acc('.claude')], slash);
    expect(renderOverride(mounts, new Date(0), undefined, 'America/Sao_Paulo')).toContain('TZ: "America/Sao_Paulo"');
    expect(renderOverride(mounts)).not.toContain('TZ:');
    expect(hostTimeZone({ TZ: 'America/Sao_Paulo' })).toBe('America/Sao_Paulo');
    expect(hostTimeZone({ TZ: ':Europe/Lisbon' })).toBe('Europe/Lisbon');
    expect(hostTimeZone({ TZ: 'x"; rm -rf' })).toBeUndefined();
    expect(hostTimeZone({})).toMatch(/^[A-Za-z]/);
  });

  it('escopo por pasta: HABBLAUD_PROJECT_ROOTS expandido no host (no container o ~ seria outro) e repassado', () => {
    const roots = projectRootsOf({ HABBLAUD_PROJECT_ROOTS: '~/Claude/empresa-a, /srv/b/' }, '/Users/fulano');
    expect(roots).toEqual(['/Users/fulano/Claude/empresa-a', '/srv/b']);
    expect(projectRootsOf({}, '/Users/fulano')).toEqual([]);
    // Uma vírgula no caminho (do HOME, por exemplo) partiria a lista dentro do container: recusa.
    expect(() => projectRootsOf({ HABBLAUD_PROJECT_ROOTS: '~/empresa-a' }, '/Users/eu,teste')).toThrow(/vírgula/);
    const mounts = planMounts(['/Users/fulano/.claude'], [acc('.claude')], slash);
    expect(renderOverride(mounts, new Date(0), undefined, undefined, [], undefined, [], roots)).toContain('HABBLAUD_PROJECT_ROOTS: "/Users/fulano/Claude/empresa-a,/srv/b"');
    expect(renderOverride(mounts)).not.toContain('HABBLAUD_PROJECT_ROOTS');
  });

  it('Grok: monta só <GROK_HOME>/sessions em /grok/sessions; HABBLAUD_GROK=0 desliga', () => {
    const grok = planGrokMount({}, '/Users/fulano', (p) => (p === '/Users/fulano/.grok/sessions' ? p : undefined));
    expect(grok).toEqual({ hostDir: '/Users/fulano/.grok', binds: [{ source: '/Users/fulano/.grok/sessions', target: '/grok/sessions' }] });
    expect(planGrokMount({ HABBLAUD_GROK: '0' }, '/Users/fulano', (p) => p)).toBeUndefined();
    expect(planGrokMount({ GROK_HOME: '~/g' }, '/Users/fulano', (p) => p)?.hostDir).toBe('/Users/fulano/g');
    expect(planGrokMount({}, '/Users/fulano', () => undefined)).toBeUndefined();
    // sessions -> . (ou uma pasta acima): montaria a pasta inteira do Grok, com auth.json.
    expect(planGrokMount({}, '/Users/fulano', (p) => (p.endsWith('/sessions') ? '/Users/fulano/.grok' : p))).toBeUndefined();
    expect(planGrokMount({}, '/Users/fulano', (p) => (p.endsWith('/sessions') ? '/Users' : p))).toBeUndefined();
    const mounts = planMounts(['/Users/fulano/.claude'], [acc('.claude')], slash);
    const yml = renderOverride(mounts, new Date(0), undefined, undefined, [], undefined, [], [], grok);
    expect(yml).toContain('HABBLAUD_GROK_DIR: "/grok"');
    expect(yml).toContain('HABBLAUD_GROK_HOST_DIR: "/Users/fulano/.grok"');
    expect(yml).toContain('target: "/grok/sessions"');
    expect(yml).not.toContain('auth.json');
    expect(renderOverride(mounts)).not.toContain('HABBLAUD_GROK');
  });
});

describe('docker-up: migração do nome antigo (CodeTown)', () => {
  const none: DockerState = { legacyContainer: false, legacyNetwork: false, legacyVolume: false, legacyImage: false, dataVolume: false };
  const upBuild = { kind: 'compose', args: ['up', '-d', '--build'] };

  it('sem nada do CodeTown: só o compose up de sempre', () => {
    expect(planUp(none, true)).toEqual({ steps: [upBuild], cleanup: [] });
    expect(planUp(none, false)).toEqual({ steps: [{ kind: 'compose', args: ['up', '-d'] }], cleanup: [] });
  });

  it('primeira subida depois do rename: tira container e rede, o Compose cria o volume e os dados são copiados', () => {
    const plan = planUp({ legacyContainer: true, legacyNetwork: true, legacyVolume: true, legacyImage: true, dataVolume: false }, true);
    expect(plan.steps).toEqual([
      { kind: 'remove-container', name: 'codetown' },
      { kind: 'remove-network', name: 'codetown_default' },
      { kind: 'compose', args: ['up', '--no-start', '--build'] },
      { kind: 'copy-volume', from: 'codetown_codetown-data', to: 'habblaud_habblaud-data' },
      { kind: 'compose', args: ['up', '-d'] },
    ]);
    // O volume antigo nunca é apagado: só vira dica no fim, junto com a imagem.
    expect(plan.cleanup).toEqual(['docker volume rm codetown_codetown-data', 'docker image rm codetown:local']);
  });

  it('--no-build e container antigo já derrubado: cria parado sem reconstruir, copia e sobe', () => {
    expect(planUp({ ...none, legacyVolume: true }, false)).toEqual({
      steps: [
        { kind: 'compose', args: ['up', '--no-start'] },
        { kind: 'copy-volume', from: 'codetown_codetown-data', to: 'habblaud_habblaud-data' },
        { kind: 'compose', args: ['up', '-d'] },
      ],
      cleanup: ['docker volume rm codetown_codetown-data'],
    });
  });

  it('volume novo já existe: não copia por cima', () => {
    // Já migrado antes: o volume antigo ficou, mas não há o que fazer nem lembrar.
    expect(planUp({ ...none, legacyVolume: true, legacyImage: true, dataVolume: true }, true)).toEqual({ steps: [upBuild], cleanup: [] });
    // Container antigo de pé com os dois volumes: sai o container, sem cópia.
    expect(planUp({ ...none, legacyContainer: true, legacyVolume: true, dataVolume: true }, true)).toEqual({
      steps: [{ kind: 'remove-container', name: 'codetown' }, upBuild],
      cleanup: ['docker volume rm codetown_codetown-data'],
    });
  });

  it('sobra só a rede ou a imagem: tira a rede, sem dica', () => {
    expect(planUp({ ...none, legacyNetwork: true, legacyImage: true }, true)).toEqual({
      steps: [{ kind: 'remove-network', name: 'codetown_default' }, upBuild],
      cleanup: [],
    });
  });

  it('cópia: imagem do Habblaud como root, sem rede, volume antigo só leitura', () => {
    const args = copyVolumeArgs('velho', 'novo');
    expect(args[0]).toBe('run');
    expect(args).toContain('--rm');
    expect(args.join(' ')).toContain('--user 0:0 --entrypoint sh');
    expect(args.join(' ')).toContain('--network none');
    expect(args.join(' ')).toContain('-v velho:/from:ro -v novo:/to habblaud:local -c ');
    const script = args.at(-1)!;
    expect(script).toMatch(/^set -e; cp -a \/from\/\. \/to\/;/);
    expect(script).toContain('chown "$(stat -c %u:%g /from)" /to');
  });

  it('.env: só os nomes das variáveis, nunca os valores', () => {
    const text = [
      '# CODETOWN_COMENTADA=1',
      'CODETOWN_BIND=0.0.0.0',
      '  export CODETOWN_PORT = 4848',
      'HABBLAUD_DEMO=1',
      '',
      'SEM_IGUAL',
      '1INVALIDA=x',
      'SEGREDO=CODETOWN_X=y\r',
    ].join('\n');
    const keys = envFileKeys(text);
    expect(keys).toEqual(['CODETOWN_BIND', 'CODETOWN_PORT', 'HABBLAUD_DEMO', 'SEGREDO']);
    const msg = legacyEnvWarning(keys, 'no .env');
    expect(msg).toBe('variáveis do nome antigo ignoradas no .env: CODETOWN_BIND → HABBLAUD_BIND, CODETOWN_PORT → HABBLAUD_PORT. Renomeie para valer de novo.');
    expect(msg).not.toContain('0.0.0.0');
    expect(envFileKeys('')).toEqual([]);
  });
});

describe('docker-up: uma instância por pasta (HABBLAUD_INSTANCE)', () => {
  it('sem instância: os nomes de sempre e o compose de sempre (com o override automático)', () => {
    const names = instanceNames({});
    expect(names).toEqual({ project: 'habblaud', container: 'habblaud', overrideFile: 'docker-compose.override.yml', dataVolume: 'habblaud_habblaud-data' });
    expect(composeArgs(names, ['up', '-d'])).toEqual(['up', '-d']);
  });

  it('com instância: projeto, container, volume e override próprios, para subir lado a lado', () => {
    const names = instanceNames({ HABBLAUD_INSTANCE: 'empresa-a' });
    expect(names).toEqual({
      instance: 'empresa-a',
      project: 'habblaud-empresa-a',
      container: 'habblaud-empresa-a',
      overrideFile: 'docker-compose.empresa-a.override.yml',
      dataVolume: 'habblaud-empresa-a_habblaud-data',
    });
    expect(composeArgs(names, ['up', '-d'])).toEqual(['-p', 'habblaud-empresa-a', '-f', 'docker-compose.yml', '-f', 'docker-compose.empresa-a.override.yml', 'up', '-d']);
  });

  it('nome inválido (vira nome de container, de arquivo e de domínio .localhost): erro', () => {
    for (const bad of ['Empresa A', '../x', '-a', 'a_b', 'x'.repeat(41)]) expect(() => instanceNames({ HABBLAUD_INSTANCE: bad })).toThrow(/HABBLAUD_INSTANCE/);
  });

  it('docker:down só precisa do projeto (o override pode ter sumido)', () => {
    const names = instanceNames({ HABBLAUD_INSTANCE: 'empresa-a' });
    expect(composeArgs(names, ['down'], false)).toEqual(['-p', 'habblaud-empresa-a', '-f', 'docker-compose.yml', 'down']);
  });

  it('antes de subir: instância sem pasta, porta de outra instância ou porta já ocupada por outro Habblaud = erro', () => {
    const a = instanceNames({ HABBLAUD_INSTANCE: 'empresa-a' });
    const plain = instanceNames({});
    const reg = { instances: [{ name: 'empresa-b', port: 4802, roots: ['/b'] }, { name: 'empresa-a', port: 4801, roots: ['/a'] }] };
    expect(instanceProblem(a, 4801, [], reg, false)).toMatch(/HABBLAUD_PROJECT_ROOTS/);
    expect(instanceProblem(a, 4802, ['/a'], reg, true)).toMatch(/empresa-b/);
    expect(instanceProblem(plain, 4802, [], reg, false)).toMatch(/empresa-b/);
    // Subir de novo a mesma instância na mesma porta (já no ar): ok.
    expect(instanceProblem(a, 4801, ['/a'], reg, true)).toBeUndefined();
    // Porta respondendo e sem ser desta instância: outro Habblaud (a padrão, por exemplo).
    expect(instanceProblem(a, 4747, ['/a'], reg, true)).toMatch(/4747/);
    expect(instanceProblem(a, 4811, ['/a'], reg, false)).toBeUndefined();
    expect(instanceProblem(plain, 4747, [], reg, true)).toBeUndefined();
  });

  it('registro das instâncias (~/.habblaud/instances.json): entra ou troca pelo nome; sem porta, sai', () => {
    const a = { name: 'empresa-a', port: 4801, roots: ['/Users/f/Claude/empresa-a'] };
    const b = { name: 'empresa-b', port: 4802, roots: ['/Users/f/Claude/empresa-b'] };
    let reg = instancesWith(undefined, a);
    reg = instancesWith(reg, b);
    expect(reg).toEqual({ instances: [a, b] });
    expect(instancesWith(reg, { ...a, port: 4811 })).toEqual({ instances: [b, { ...a, port: 4811 }] });
    expect(instancesWith(reg, { name: 'empresa-a' })).toEqual({ instances: [b] });
    // Arquivo estranho: recomeça sem quebrar.
    expect(instancesWith('lixo', a)).toEqual({ instances: [a] });
  });
});
