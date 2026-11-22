// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a patch made, as [old, new] pairs, in the patch's order. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A file as lines: its line break, its lines and whether it ends with a line break (SPEC.md section 3). */
interface FileDoc {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function parseDoc(text: string): FileDoc {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  const parts = text.split(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function writeDoc(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.finalBreak ? d.br : '');
}

function leadOf(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m === null ? '' : m[0];
}

/** One line of a hunk or chunk: context (in both old and new), deleted (old only), added (new only). */
interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}

function opsOld(ops: Op[]): string[] {
  return ops.filter((o) => o.kind !== 'add').map((o) => o.text);
}
function opsNew(ops: Op[]): string[] {
  return ops.filter((o) => o.kind !== 'del').map((o) => o.text);
}

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O occurs in the file's lines at one tier, from `from` on (section 5). */
function occurrencesAt(fileLines: string[], o: string[], tier: number, from: number): number[] {
  const pos: number[] = [];
  if (o.length === 0) return pos;
  const on = o.map((l) => normLine(l, tier));
  const fn = fileLines.map((l) => normLine(l, tier));
  outer: for (let i = from; i + o.length <= fn.length; i++) {
    for (let j = 0; j < o.length; j++) {
      if (fn[i + j] !== on[j]) continue outer;
    }
    pos.push(i);
  }
  return pos;
}

/** The first tier at which O occurs (from `from` on), with its positions; null when none. */
function findTierFrom(fileLines: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrencesAt(fileLines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** Re-indent one new line at tier 2 (section 5): its P prefix becomes F. */
function reindent(line: string, fLead: string, pLead: string): string {
  if (line === '' || line.trim() === '') return line;
  if (!line.startsWith(pLead)) return line;
  return fLead + line.slice(pLead.length);
}

/** Replace the lines at `pos` by the ops: context lines are the file's own, added lines re-indented at tier 2. */
function applyOps(doc: FileDoc, pos: number, ops: Op[], tier: number): void {
  const o = opsOld(ops);
  const fLead = pos < doc.lines.length ? leadOf(doc.lines[pos]!) : '';
  const pLead = o.length > 0 ? leadOf(o[0]!) : '';
  const out: string[] = [];
  let fi = pos;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(doc.lines[fi]!);
      fi += 1;
    } else if (op.kind === 'del') {
      fi += 1;
    } else if (tier === 2) {
      out.push(reindent(op.text, fLead, pLead));
    } else {
      out.push(op.text);
    }
  }
  doc.lines.splice(pos, o.length, ...out);
}

/** One unified hunk: A is the old start (1-based), ops its body lines. */
interface Hunk {
  a: number;
  ops: Op[];
  /** A `\` line follows the hunk's last context or `+` line: the result has no final break. */
  noFinal: boolean;
  /** The same, for the hunk's last `+` line; null when the hunk has no `+` line. */
  plusNoFinal: boolean | null;
}

function parseHunkBody(a: number, body: string[]): Hunk {
  const ops: Op[] = [];
  for (const l of body) {
    if (l === '') ops.push({ kind: 'ctx', text: '' });
    else if (l.startsWith(' ')) ops.push({ kind: 'ctx', text: l.slice(1) });
    else if (l.startsWith('-')) ops.push({ kind: 'del', text: l.slice(1) });
    else if (l.startsWith('+')) ops.push({ kind: 'add', text: l.slice(1) });
    // a `\` line is a marker only: it marks the line before it.
  }
  let lastCtxAdd = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l === '' || l.startsWith(' ') || l.startsWith('+')) lastCtxAdd = k;
    if (l.startsWith('+')) lastPlus = k;
  }
  const after = (k: number): boolean => k + 1 < body.length && body[k + 1]!.startsWith('\\');
  return {
    a,
    ops,
    noFinal: lastCtxAdd >= 0 && after(lastCtxAdd),
    plusNoFinal: lastPlus < 0 ? null : after(lastPlus),
  };
}

interface UniSection {
  diffOld: string | null;
  diffNew: string | null;
  /** undefined: no `---` line; null: `/dev/null`. */
  oldPath: string | null | undefined;
  /** undefined: no `+++` line; null: `/dev/null`. */
  newPath: string | null | undefined;
  sawPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `, up to the first tab, spaces removed, `a/`/`b/` stripped. */
function diffPath(text: string): string | null {
  const cut = text.split('\t')[0]!.trim();
  if (cut === '/dev/null') return null;
  if (cut.startsWith('a/') || cut.startsWith('b/')) return cut.slice(2);
  return cut;
}

/** Apply a section's hunks in order to the doc; d is the running line shift (section 6). */
function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, failPath: string): void {
  let d = 0;
  for (const h of hunks) {
    const o = opsOld(h.ops);
    const n = opsNew(h.ops);
    if (o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, doc.lines.length));
      const atEnd = at === doc.lines.length;
      doc.lines.splice(at, 0, ...n);
      if (atEnd) doc.finalBreak = !h.noFinal;
    } else {
      const found = findTierFrom(doc.lines, o, 0, strict);
      if (found === null) throw new Fail('no-match', failPath);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (let k = 1; k < found.pos.length; k++) {
        const p = found.pos[k]!;
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const toEnd = best + o.length === doc.lines.length;
      applyOps(doc, best, h.ops, found.tier);
      if (toEnd) doc.finalBreak = !h.noFinal;
    }
    d += n.length - o.length;
  }
}

function uniEdit(sec: UniSection, strict: boolean): Edit {
  const oldP = sec.oldPath !== undefined ? sec.oldPath : sec.renameFrom ?? sec.diffOld;
  const newP = sec.newPath !== undefined ? sec.newPath : sec.renameTo ?? sec.diffNew;
  const isCreate = sec.newFile || (oldP === null && newP !== null);
  const isDelete = sec.deletedFile || (newP === null && oldP !== null);
  if (isCreate && newP !== null) {
    return (tree) => {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noFinal = false;
      for (const h of sec.hunks) {
        for (const op of h.ops) if (op.kind === 'add') plus.push(op.text);
        if (h.plusNoFinal !== null) noFinal = h.plusNoFinal;
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noFinal ? '' : '\n'));
    };
  }
  if (isDelete && oldP !== null) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
    };
  }
  if (oldP !== null && newP !== null && oldP !== newP) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const doc = parseDoc(before);
      applyHunks(doc, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, writeDoc(doc));
      tree.moves.push([oldP, newP]);
    };
  }
  if (oldP !== null && newP !== null) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      const doc = parseDoc(before);
      applyHunks(doc, sec.hunks, strict, oldP);
      tree.now.set(oldP, writeDoc(doc));
    };
  }
  return () => {
    // Both paths are /dev/null: the section names no file.
  };
}

/** Read a patch as a unified diff (SPEC.md section 6). */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  const n = lines.length;
  let cur: UniSection | null = null;
  let inHeader = false;
  const startSection = (s: UniSection): void => {
    if (cur !== null) sections.push(cur);
    cur = s;
    inHeader = true;
  };
  const blankSection = (): UniSection => ({
    diffOld: null,
    diffNew: null,
    oldPath: undefined,
    newPath: undefined,
    sawPair: false,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = blankSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      startSection(s);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.sawPair) {
        cur.oldPath = diffPath(line.slice(4));
        cur.newPath = diffPath(lines[i + 1]!.slice(4));
        cur.sawPair = true;
        i += 2;
        continue;
      }
      const s = blankSection();
      s.oldPath = diffPath(line.slice(4));
      s.newPath = diffPath(lines[i + 1]!.slice(4));
      s.sawPair = true;
      startSection(s);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(parseHunkBody(parseInt(m[1]!, 10), body));
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.newPath = diffPath(line.slice(4));
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.deletedFile = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  if (cur !== null) sections.push(cur);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => uniEdit(s, strict));
}

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srEdit(b: SrBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const doc = parseDoc(before);
    const found = findTierFrom(doc.lines, b.oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
    const ops: Op[] = [
      ...b.oldLines.map((t): Op => ({ kind: 'del', text: t })),
      ...b.newLines.map((t): Op => ({ kind: 'add', text: t })),
    ];
    applyOps(doc, found.pos[0]!, ops, found.tier);
    tree.now.set(b.path, writeDoc(doc));
  };
}

/** Read a patch as SEARCH/REPLACE blocks (SPEC.md section 7). */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  const n = lines.length;
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let k = s - 1; k > prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = s + 1; k < n; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let end = -1;
    for (let k = eq + 1; k < n; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, end) });
    prevEnd = end;
    prevPath = path;
    i = end + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b, strict));
}

/** One V4A chunk: anchor null means no `@@` line; eof means a `*** End of File` closed it. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}

type VSection =
  | { kind: 'add'; path: string; content: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: VChunk[] };

function v4aEdit(sec: VSection, strict: boolean): Edit {
  if (sec.kind === 'add') {
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.content.length === 0 ? '' : sec.content.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
    };
  }
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const doc = parseDoc(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const anchorAt = findTierFrom(doc.lines, [ch.anchor], cursor, strict);
        if (anchorAt === null) throw new Fail('no-match', sec.path);
        cursor = anchorAt.pos[0]! + 1;
      }
      const o = opsOld(ch.ops);
      const n = opsNew(ch.ops);
      if (o.length === 0) {
        const at = ch.eof ? doc.lines.length : cursor;
        doc.lines.splice(at, 0, ...n);
        cursor = at + n.length;
      } else {
        const found = findTierFrom(doc.lines, o, cursor, strict);
        if (found === null) throw new Fail('no-match', sec.path);
        let pos = found.pos[0]!;
        if (ch.eof) {
          const ok = found.pos.filter((p) => p + o.length === doc.lines.length);
          if (ok.length === 0) throw new Fail('no-match', sec.path);
          pos = ok[0]!;
        }
        applyOps(doc, pos, ch.ops, found.tier);
        cursor = pos + n.length;
      }
    }
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, writeDoc(doc));
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, writeDoc(doc));
    }
  };
}

/** Read a patch in the V4A format (SPEC.md section 8). */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  /** The section's raw lines, as [line, 1-based number], with trailing blank lines removed. */
  const rawSection = (from: number): { raw: Array<[string, number]>; next: number } => {
    const raw: Array<[string, number]> = [];
    let j = from;
    while (j < last) {
      const l = lines[j]!;
      if (isSectionStart(l) || l.trim() === '*** End Patch') break;
      raw.push([l, j + 1]);
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]![0])) raw.pop();
    return { raw, next: j };
  };
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const { raw, next } = rawSection(i + 1);
      const content: string[] = [];
      for (const [l, no] of raw) {
        if (l.startsWith('+')) content.push(l.slice(1));
        else if (l === '') content.push('');
        else throw new Exit2(`error: parse ${no}`);
      }
      sections.push({ kind: 'add', path, content });
      i = next;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      sections.push({ kind: 'delete', path: line.slice('*** Delete File: '.length).trim() });
      i += 1;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j += 1;
      }
      const { raw, next } = rawSection(j);
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (const [l, no] of raw) {
        if (l.startsWith('@@')) {
          closeChunk();
          cur = { anchor: l.slice(2).trim(), eof: false, ops: [] };
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${no}`);
          cur.eof = true;
          closeChunk();
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${no}`);
            cur = { anchor: null, eof: false, ops: [] };
          }
          if (l === '') cur.ops.push({ kind: 'ctx', text: '' });
          else if (l.startsWith(' ')) cur.ops.push({ kind: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) cur.ops.push({ kind: 'del', text: l.slice(1) });
          else cur.ops.push({ kind: 'add', text: l.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${no}`);
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      sections.push({ kind: 'update', path, moveTo, chunks });
      i = next;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const rowByPath = new Map<string, { key: string; line: string }>();
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const row = { key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` };
    rows.push(row);
    rowByPath.set(p, row);
  }
  for (const [oldP, newP] of tree.moves) {
    const dRow = rowByPath.get(oldP);
    const aRow = rowByPath.get(newP);
    if (dRow !== undefined && dRow.line.startsWith('D ') && aRow !== undefined && aRow.line.startsWith('A ')) {
      rows.splice(rows.indexOf(dRow), 1);
      rows.splice(rows.indexOf(aRow), 1);
      rowByPath.delete(oldP);
      rowByPath.delete(newP);
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.line);
  for (const r of rows) {
    if (check) continue;
    const p = r.key;
    const now = tree.now.get(p)!;
    if (r.line.startsWith('R ')) {
      const oldP = r.line.slice(2, r.line.indexOf(' -> '));
      rmSync(oldP, { force: true });
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    } else if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
