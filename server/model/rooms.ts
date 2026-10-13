// Salas do escritório: identidade (cwd normalizado), nome exibido e posição (slot) no prédio.
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

/** cwd normalizado: sem barras repetidas nem barra final. */
export function normalizeCwd(cwd: string): string {
  const p = cwd.trim().replace(/\/{2,}/g, '/');
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/**
 * O cwd está numa das raízes (a própria pasta ou algo dentro dela)? Sem raízes, tudo vale. Compara só o texto
 * (normalizado): no Docker os caminhos são do host e não existem no container, então não dá para usar realpath.
 */
export function inRoots(cwd: string, roots: readonly string[]): boolean {
  if (!roots.length) return true;
  // posix.normalize resolve `.` e `..` pelo texto (o destino é o que conta); symlinks ficam como estão.
  const c = normalizeCwd(posix.normalize(cwd));
  return roots.some((root) => {
    const r = normalizeCwd(posix.normalize(root));
    return c === r || c.startsWith(r === '/' ? r : `${r}/`);
  });
}

/** Todo `"cwd"` de um texto de JSONL (Claude Code: em cada linha; Codex: session_meta, turn_context e comandos). */
const CWD_RE = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/g;
/**
 * Na conversa do Grok também o `"current_dir"` (a pasta onde um comando rodou, no resultado dele). Só nela: no Claude
 * Code e no Codex um campo com esse nome pode ser dado de uma ferramenta (um registro com `current_dir: "archive"`).
 */
const GROK_CWD_RE = /"(?:cwd|current_dir)"\s*:\s*("(?:[^"\\]|\\.)*")/g;

/**
 * Os cwds citados no texto, já como caminho (uma URI file:// do Codex vira o caminho dela). Busca no texto cru, sem
 * parse da linha inteira: barato para rodar em toda linha e em arquivos grandes. Um valor ilegível vira '?' (fora).
 * ponytail: casa a chave em qualquer nível (um argumento de ferramenta chamado cwd também conta) e só a grafia comum
 * ("cwd", sem escapes); é o que o Claude Code e o Codex gravam.
 */
export function cwdsInText(text: string, grok = false): string[] {
  if (!text.includes('"cwd"') && !(grok && text.includes('"current_dir"'))) return [];
  const out: string[] = [];
  for (const m of text.matchAll(grok ? GROK_CWD_RE : CWD_RE)) {
    let v: unknown;
    try {
      v = JSON.parse(m[1]);
    } catch {
      out.push('?');
      continue;
    }
    if (typeof v !== 'string') {
      out.push('?');
      continue;
    }
    if (v.startsWith('file://')) {
      try {
        v = fileURLToPath(v);
      } catch {
        out.push('?');
        continue;
      }
    }
    out.push(v as string);
  }
  return out;
}

/** A primeira pasta fora do escopo citada na linha, ou undefined. */
export function cwdOutOfScope(line: string, scope: (cwd: string) => boolean, grok = false): string | undefined {
  return cwdsInText(line, grok).find((cwd) => !scope(cwd));
}

function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

/**
 * Nome de cada sala: o basename do caminho; salas com o mesmo basename ganham o(s) diretório(s)
 * pai até ficarem distintas (ex.: "applications/app" e "outro/app").
 */
export function roomDisplayNames(rooms: ReadonlyMap<string, string>): Map<string, string> {
  const segs = new Map([...rooms].map(([id, path]) => [id, segments(path)]));
  const depth = new Map([...rooms.keys()].map((id) => [id, 1]));
  const nameOf = (id: string) => {
    const s = segs.get(id)!;
    return s.length ? s.slice(-depth.get(id)!).join('/') : rooms.get(id) || '/';
  };
  for (let guard = 0; guard < 16; guard++) {
    const groups = new Map<string, string[]>();
    for (const id of rooms.keys()) {
      const n = nameOf(id);
      groups.set(n, [...(groups.get(n) ?? []), id]);
    }
    let grew = false;
    for (const ids of groups.values()) {
      if (ids.length < 2) continue;
      for (const id of ids) {
        if (depth.get(id)! < segs.get(id)!.length) {
          depth.set(id, depth.get(id)! + 1);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }
  return new Map([...rooms.keys()].map((id) => [id, nameOf(id)]));
}

/**
 * Distribui slots: a sala nova pega o menor slot livre que não esteja em espera.
 * Um slot liberado só volta a ser usado após `cooldownMs` (tempo da animação de saída).
 */
export class SlotAllocator {
  private slots = new Map<string, number>();
  private freedAt = new Map<number, number>();

  constructor(private readonly cooldownMs = 30_000) {}

  /** Ajusta as alocações ao conjunto atual de salas. Devolve true se algo mudou. */
  sync(ids: Iterable<string>, now: number): boolean {
    const live = new Set(ids);
    let changed = false;
    for (const [id, slot] of [...this.slots]) {
      if (live.has(id)) continue;
      this.slots.delete(id);
      this.freedAt.set(slot, now);
      changed = true;
    }
    for (const id of live) {
      if (this.slots.has(id)) continue;
      this.slots.set(id, this.firstFree(now));
      changed = true;
    }
    return changed;
  }

  slotOf(id: string): number | undefined {
    return this.slots.get(id);
  }

  private firstFree(now: number): number {
    const used = new Set(this.slots.values());
    for (let slot = 0; ; slot++) {
      if (used.has(slot)) continue;
      const freed = this.freedAt.get(slot);
      if (freed !== undefined && now - freed < this.cooldownMs) continue;
      this.freedAt.delete(slot);
      return slot;
    }
  }
}
