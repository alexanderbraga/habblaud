import { describe, expect, it } from 'vitest';
import { ptyControllable } from './ptyapi';

describe('ações pelo escritório', () => {
  it('Codex pode assumir ou encerrar conforme as capacidades; Claude sem capacidades fica desligado', () => {
    expect(ptyControllable({ id: '.codex:t', kind: 'main', provider: 'codex', canTakeover: true })).toBe(true);
    expect(ptyControllable({ id: '.codex:t', kind: 'main', provider: 'codex', canStop: true })).toBe(true);
    expect(ptyControllable({ id: '.claude:t', kind: 'main', provider: 'claude' })).toBe(false);
    expect(ptyControllable({ id: 'demo:.codex:t', kind: 'main', provider: 'codex', canTakeover: true })).toBe(false);
    expect(ptyControllable({ id: '.codex:sub', kind: 'sub', provider: 'codex', canStop: true })).toBe(false);
    expect(ptyControllable(null)).toBe(false);
  });
});
