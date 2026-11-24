// main.ts is mend, the CLI SPEC.md specifies (MIT). The kit's starter covered sections 1 to 4, 9 and 10 of SPEC.md:
// the command line, the output and exit codes, safe paths, format detection, JSON edits and the all-or-nothing
// write. Added here: three-tier line matching (section 5), the unified-diff reader (section 6), SEARCH/REPLACE
// blocks (section 7), V4A patches (section 8), and the `R` lines section 2 requires for moves, which the starter's
// output did not print. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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
  readonly moves: Array<readonly [string, string]> = [];
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

// ---- Section 5: files as lines, and matching at three tiers ----

interface FileState {
  br: string;
  lines: string[];
  fin: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { br, lines: parts, fin };
}

function joinFile(fs: FileState): string {
  if (fs.lines.length === 0) return '';
  return fs.lines.join(fs.br) + (fs.fin ? fs.br : '');
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const trimTrailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => trimTrailWs(s.replace(/^[ \t]+/, ''));

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrailWs(a) === trimTrailWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

function tierList(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

function occurrences(lines: string[], o: string[], tier: number): number[] {
  const res: number[] = [];
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  for (const t of tierList(strict)) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One body line of a hunk or chunk: context, old-only or new-only. */
interface BEnt {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noNl: boolean;
  emptyRaw: boolean;
}

/** One line the replacement writes; ctx >= 0 names the line of O it is a context line of. */
interface NEnt {
  text: string;
  ctx: number;
}

function oTexts(body: BEnt[]): string[] {
  return body.filter((b) => b.kind !== 'add').map((b) => b.text);
}

function nEnts(body: BEnt[]): NEnt[] {
  const out: NEnt[] = [];
  let oi = 0;
  for (const b of body) {
    if (b.kind === 'ctx') {
      out.push({ text: b.text, ctx: oi });
      oi += 1;
    } else if (b.kind === 'del') oi += 1;
    else out.push({ text: b.text, ctx: -1 });
  }
  return out;
}

/** Whether a `\` line follows the body's last context or new line. */
function lastNoNl(body: BEnt[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) if (body[i]!.kind !== 'del') return body[i]!.noNl;
  return false;
}

/** The lines a replacement writes at pos: context lines are the file's own; at tier 2 the rest are re-indented. */
function buildN(ents: NEnt[], fileLines: string[], pos: number, o: string[], tier: number): string[] {
  const f = leadWs(fileLines[pos] ?? '');
  const p = leadWs(o[0] ?? '');
  return ents.map((e) => {
    if (e.ctx >= 0) return fileLines[pos + e.ctx]!;
    if (tier === 2 && e.text.trim() !== '' && e.text.startsWith(p)) return f + e.text.slice(p.length);
    return e.text;
  });
}

// ---- Section 6: unified diffs ----

interface UHunk {
  a: number;
  body: BEnt[];
}

interface USec {
  gitOld?: string;
  gitNew?: string;
  hdrOld?: string | null;
  hdrNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  create: boolean;
  del: boolean;
  hunks: UHunk[];
}

function headerPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdit(s: USec, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.hdrOld !== undefined ? s.hdrOld : s.renameFrom !== undefined ? s.renameFrom : s.gitOld;
    const newP = s.hdrNew !== undefined ? s.hdrNew : s.renameTo !== undefined ? s.renameTo : s.gitNew;
    if (s.create || oldP === null) {
      const target = newP ?? oldP;
      if (target === null || target === undefined) throw new Exit2('error: parse 1');
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const adds = s.hunks.flatMap((h) => h.body.filter((b) => b.kind === 'add'));
      const texts = adds.map((b) => b.text);
      const fin = adds.length > 0 && !adds[adds.length - 1]!.noNl;
      tree.now.set(target, texts.length === 0 ? '' : texts.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (s.del || newP === null) {
      const target = oldP;
      if (target === null || target === undefined) throw new Exit2('error: parse 1');
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const src = oldP ?? newP;
    const dst = newP ?? oldP;
    if (src === null || src === undefined) throw new Exit2('error: parse 1');
    if (!safe(src)) throw new Fail('unsafe', src);
    const isMove = dst !== undefined && dst !== null && dst !== src;
    if (isMove && !safe(dst)) throw new Fail('unsafe', dst);
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    if (isMove && tree.get(dst) !== null) throw new Fail('exists', dst);
    const fs = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const o = oTexts(h.body);
      const ne = nEnts(h.body);
      if (o.length === 0) {
        const at = Math.max(0, Math.min(h.a + d, fs.lines.length));
        const texts = ne.map((e) => e.text);
        const atEnd = at === fs.lines.length;
        fs.lines.splice(at, 0, ...texts);
        if (atEnd) fs.fin = !lastNoNl(h.body);
        d += texts.length;
        continue;
      }
      const found = findTier(fs.lines, o, strict);
      if (found === null) throw new Fail('no-match', src);
      const targetPos = h.a - 1 + d;
      let pos = found.occ[0]!;
      let best = Math.abs(pos - targetPos);
      for (const cand of found.occ) {
        const dd = Math.abs(cand - targetPos);
        if (dd < best) {
          best = dd;
          pos = cand;
        }
      }
      const built = buildN(ne, fs.lines, pos, o, found.tier);
      const reachesEnd = pos + o.length === fs.lines.length;
      fs.lines.splice(pos, o.length, ...built);
      if (reachesEnd) fs.fin = !lastNoNl(h.body);
      d += built.length - o.length;
    }
    const text = joinFile(fs);
    if (isMove) {
      tree.now.set(src, null);
      tree.now.set(dst!, text);
      tree.moves.push([src, dst!]);
    } else if (text !== before) tree.now.set(src, text);
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const secs: USec[] = [];
  let cur: USec | null = null;
  const newSec = (): USec => {
    const s: USec = { create: false, del: false, hunks: [] };
    secs.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSec();
      s.gitOld = m[1];
      s.gitNew = m[2];
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BEnt[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') {
          body.push({ kind: 'ctx', text: '', noNl: false, emptyRaw: true });
          j += 1;
          continue;
        }
        const c = l[0]!;
        if (c === ' ') body.push({ kind: 'ctx', text: l.slice(1), noNl: false, emptyRaw: false });
        else if (c === '-') body.push({ kind: 'del', text: l.slice(1), noNl: false, emptyRaw: false });
        else if (c === '+') body.push({ kind: 'add', text: l.slice(1), noNl: false, emptyRaw: false });
        else if (c === '\\') {
          const last = body[body.length - 1];
          if (last !== undefined) last.noNl = true;
          j += 1;
          continue;
        } else break;
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.emptyRaw) body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && cur.hdrOld === undefined) {
        cur.hdrOld = headerPath(line.slice(4));
        cur.hdrNew = headerPath(lines[i + 1]!.slice(4));
      } else {
        const s = newSec();
        s.hdrOld = headerPath(line.slice(4));
        s.hdrNew = headerPath(lines[i + 1]!.slice(4));
      }
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10);
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.del = true;
    }
    i += 1;
  }
  if (secs.length === 0) throw new Exit2('error: parse 1');
  return secs.map((s) => unifiedEdit(s, strict));
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (!blank(l) && !l.trim().startsWith('```')) {
        path = l.trim();
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    let k = i + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '=======') k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    let m = k + 1;
    while (m < lines.length && lines[m]!.trimEnd() !== '>>>>>>> REPLACE') m += 1;
    if (m >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    const oldLines = lines.slice(i + 1, k);
    const newLines = lines.slice(k + 1, m);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const fs = splitFile(before);
      const found = findTier(fs.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const built = buildN(
        newLines.map((t) => ({ text: t, ctx: -1 })),
        fs.lines,
        pos,
        oldLines,
        found.tier,
      );
      fs.lines.splice(pos, oldLines.length, ...built);
      tree.now.set(p, joinFile(fs));
    });
    prevPath = path;
    prevEnd = m + 1;
    i = m + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  body: BEnt[];
  eof: boolean;
}

function v4aEdit(kind: 'add' | 'del' | 'upd', path: string, secIn: { n: number; text: string }[], secLineNo: number, strict: boolean): Edit {
  // Blank lines at the end of a section are not part of it (section 8).
  const sec = [...secIn];
  while (sec.length > 0 && blank(sec[sec.length - 1]!.text)) sec.pop();
  if (kind === 'add') {
    const content: string[] = [];
    for (const l of sec) {
      if (l.text === '') content.push('');
      else if (l.text.startsWith('+')) content.push(l.text.slice(1));
      else throw new Exit2(`error: parse ${l.n}`);
    }
    while (content.length > 0 && content[content.length - 1] === '') content.pop();
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, content.length === 0 ? '' : `${content.join('\n')}\n`);
    };
  }
  if (kind === 'del') {
    for (const l of sec) if (l.text !== '') throw new Exit2(`error: parse ${l.n}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  const sec2 = sec;
  let moveTo: string | null = null;
  let idx = 0;
  if (sec2.length > 0 && sec2[0]!.text.startsWith('*** Move to: ')) {
    moveTo = sec2[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (; idx < sec2.length; idx += 1) {
    const l = sec2[idx]!;
    const t = l.text;
    if (t.startsWith('@@')) {
      const anchor = t.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      chunks.push(cur);
      continue;
    }
    if (t === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${l.n}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${l.n}`);
        cur = { anchor: null, body: [], eof: false };
        chunks.push(cur);
      }
      const kind2 = t === '' || t[0] === ' ' ? 'ctx' : t[0] === '-' ? 'del' : 'add';
      cur.body.push({ kind: kind2, text: t === '' ? '' : t.slice(1), noNl: false, emptyRaw: t === '' });
      continue;
    }
    throw new Exit2(`error: parse ${l.n}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLineNo}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const fs = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let posA = -1;
        for (const t of tierList(strict)) {
          for (let k = cursor; k < fs.lines.length; k += 1) {
            if (lineEq(fs.lines[k]!, ch.anchor, t)) {
              posA = k;
              break;
            }
          }
          if (posA >= 0) break;
        }
        if (posA < 0) throw new Fail('no-match', path);
        cursor = posA + 1;
      }
      const o = oTexts(ch.body);
      const ne = nEnts(ch.body);
      if (o.length === 0) {
        const at = ch.eof ? fs.lines.length : Math.min(cursor, fs.lines.length);
        const texts = ne.map((e) => e.text);
        fs.lines.splice(at, 0, ...texts);
        cursor = at + texts.length;
        continue;
      }
      let placed: { tier: number; pos: number } | null = null;
      for (const t of tierList(strict)) {
        const occ = occurrences(fs.lines, o, t).filter((p) => p >= cursor && (!ch.eof || p + o.length === fs.lines.length));
        if (occ.length > 0) {
          placed = { tier: t, pos: occ[0]! };
          break;
        }
      }
      if (placed === null) throw new Fail('no-match', path);
      const built = buildN(ne, fs.lines, placed.pos, o, placed.tier);
      fs.lines.splice(placed.pos, o.length, ...built);
      cursor = placed.pos + built.length;
    }
    const text = joinFile(fs);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else if (text !== before) tree.now.set(path, text);
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secStart = (l: string): 'add' | 'del' | 'upd' | null =>
    l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : l.startsWith('*** Update File: ') ? 'upd' : null;
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = secStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'del' ? '*** Delete File: ' : '*** Update File: ';
    const path = line.slice(prefix.length).trim();
    const sec: { n: number; text: string }[] = [];
    let j = i + 1;
    while (j < last && secStart(lines[j]!) === null) {
      sec.push({ n: j + 1, text: lines[j]! });
      j += 1;
    }
    edits.push(v4aEdit(kind, path, sec, i + 1, strict));
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const rPairs = tree.moves.filter(([o, n]) => tree.original(o) !== null && finalOf(o) === null && tree.original(n) === null && finalOf(n) !== null);
  const rOld = new Set(rPairs.map(([o]) => o));
  const rNew = new Set(rPairs.map(([, n]) => n));
  const rows: { key: string; text: string }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOld.has(p) || rNew.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of rPairs) rows.push({ key: n, text: `R ${o} -> ${n}` });
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
