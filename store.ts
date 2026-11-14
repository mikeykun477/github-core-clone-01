// The forge's store and its git object model: hashing, trees, commits, tags,
// packfiles (read and write, with OFS/REF delta resolution), reachability,
// tree updates and diffs, and the squash-merge used by REST, GraphQL and MCP.
// Everything is in memory; only the standard library is used.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { inflateSync as zlibInflateSync } from 'node:zlib';

// ------------------------------------------------------------------ identities

/** The login the trial's bearer token names (the seeded scenario's viewer). */
export const VIEWER_LOGIN = 'adaiversen';
/** The scenario's stranger login (owns nothing here). */
export const STRANGER_LOGIN = 'olgabauer';
/** The viewer as a git identity line. */
export const VIEWER_IDENT = 'ada iversen <adaiversen@example.invalid>';
/** The default branch every repository is born with. */
export const DEFAULT_BRANCH = 'main';
export const ZERO_OID = '0'.repeat(40);
const SHA40 = /^[0-9a-f]{40}$/;
export function isOid(v) {
  return typeof v === 'string' && SHA40.test(v);
}

// ------------------------------------------------------------------ hashing

export function hashObject(type, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const head = Buffer.from(`${type} ${buf.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(buf).digest('hex');
}

export function sha1Hex(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

// ------------------------------------------------------------------ trees

export function parseTree(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries = [];
  let off = 0;
  while (off < buf.length) {
    const sp = buf.indexOf(0x20, off);
    const nul = buf.indexOf(0x00, sp + 1);
    entries.push({
      mode: buf.subarray(off, sp).toString('ascii'),
      name: buf.subarray(sp + 1, nul).toString('utf8'),
      oid: buf.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function compareTreeNames(a, b) {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}

export function buildTree(entries) {
  const sorted = [...entries].sort(compareTreeNames);
  const parts = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ commits / tags

export function parseCommit(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const headEnd = blank < 0 ? buf.length : blank;
  const message = blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents = [];
  let author = '';
  let committer = '';
  for (const line of buf.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v;
    else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v;
    else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit({ tree, parents = [], message, author, committer, timestamp }) {
  const who = `${author} ${timestamp} +0000`;
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${committer ? `${committer} ${timestamp} +0000` : who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export function parseTag(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const headEnd = blank < 0 ? buf.length : blank;
  const headers = new Map();
  for (const line of buf.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8'),
  };
}

export function buildTag({ object, type, tag, message, tagger, timestamp }) {
  return Buffer.from(
    `object ${object}\ntype ${type}\ntag ${tag}\ntagger ${tagger} ${timestamp} +0000\n\n${message}`,
    'utf8',
  );
}

// ------------------------------------------------------------------ packfiles

function readVarintSize(buf, start) {
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buf[off++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

function readOfsDeltaBase(buf, start) {
  let byte = buf[start];
  let off = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[off++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: off };
}

function inflateAt(buf, offset) {
  const view = buf.subarray(offset);
  let result;
  try {
    result = zlibInflateSync(view, { info: true });
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${err.message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

export function applyDelta(base, delta) {
  const b = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const d = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let off = 0;
  const readSize = () => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const byte = d[off++];
      v += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return v;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== b.length) throw new Error(`delta expects a ${srcSize}-byte base, got ${b.length}`);
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < d.length) {
    const op = d[off++];
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit++) {
        if (op & (1 << bit)) copyOff += d[off++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit++) {
        if (op & (1 << bit)) copySize += d[off++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      b.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      const lit = op & 0x7f;
      d.copy(out, written, off, off + lit);
      off += lit;
      written += lit;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== tgtSize) throw new Error(`delta produced ${written} of ${tgtSize} bytes`);
  return out;
}

const CODE_TYPE = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODE = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Read a packfile and resolve every object (OFS_DELTA/REF_DELTA included). */
export function readPack(pack, resolveBase) {
  const buf = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buf.length < 32) throw new Error(`pack is ${buf.length} bytes, too short`);
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const raw = [];
  const byOffset = new Map();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = off;
    const header = readVarintSize(buf, off);
    off = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buf, off);
      off = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${i} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buf.subarray(0, trailerStart), off);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    off = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (off !== trailerStart) throw new Error(`pack has ${trailerStart - off} stray bytes before its trailer`);
  const objects = new Map();
  const resolvedByOid = new Map();
  const resolving = new Set();
  const resolve = (entry) => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type;
    let data;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase ? resolveBase(entry.baseOid) : undefined;
        if (!external) throw new Error(`ref-delta base ${entry.baseOid} is neither in the pack nor in the store`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = { type, data, oid };
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return entry.resolved;
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return { version, count, objects };
}

function writePackObjectHeader(type, size) {
  const code = TYPE_CODE[type];
  const bytes = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). */
export function writePack(objects) {
  const list = [...objects];
  const parts = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const o of list) {
    const data = Buffer.isBuffer(o.data) ? o.data : Buffer.from(o.data);
    parts.push(writePackObjectHeader(o.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export function verifyPackChecksum(pack) {
  const buf = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buf.length < 20) return false;
  const actual = buf.subarray(buf.length - 20).toString('hex');
  const expected = sha1Hex(buf.subarray(0, buf.length - 20));
  return actual === expected;
}

// ------------------------------------------------------------------ reachability

/** Every object reachable from `roots` (commit -> tree + parents, tag -> target). */
export function collectReachable(roots, lookup, { allowMissing = false } = {}) {
  const seen = new Set();
  const queue = [];
  for (const r of roots) if (isOid(r)) queue.push(r);
  while (queue.length) {
    const oid = queue.pop();
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) {
      if (allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode === '160000') continue;
        queue.push(e.oid);
      }
    }
  }
  return seen;
}

/** Is `ancestor` reachable from `tip` (i.e. is tip a descendant of ancestor)? */
export function isAncestor(lookup, ancestor, tip) {
  if (ancestor === tip) return true;
  const seen = new Set();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop();
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      for (const p of c.parents) {
        if (p === ancestor) return true;
        queue.push(p);
      }
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    }
  }
  return false;
}

/** Peel a tag (recursively) to the non-tag object it names. */
export function peelToNonTag(lookup, oid) {
  let cur = oid;
  for (let i = 0; i < 16; i++) {
    const obj = lookup(cur);
    if (!obj || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
  return cur;
}

// ------------------------------------------------------------------ trees: update & diff

/** The blob oid at `path` in the tree `rootOid` (or null). */
export function treeLookup(lookup, rootOid, path) {
  if (!rootOid) return null;
  const segments = path.split('/').filter((s) => s !== '');
  let oid = rootOid;
  for (let i = 0; i < segments.length; i++) {
    const obj = lookup(oid);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
    oid = entry.oid;
  }
  return null;
}

/** Is `path` a directory in the tree `rootOid`? */
export function treeIsDir(lookup, rootOid, path) {
  if (!rootOid || path === '' || path === '/') return true;
  const segments = path.split('/').filter((s) => s !== '');
  let oid = rootOid;
  for (let i = 0; i < segments.length; i++) {
    const obj = lookup(oid);
    if (!obj || obj.type !== 'tree') return false;
    const entry = parseTree(obj.data).find((e) => e.name === segments[i]);
    if (!entry) return false;
    if (i === segments.length - 1) return entry.mode === '40000';
    oid = entry.oid;
  }
  return false;
}

/** The direct entries of the directory `path` in the tree `rootOid` (or null). */
export function treeListDir(lookup, rootOid, path) {
  if (!rootOid) return null;
  const segments = path.split('/').filter((s) => s !== '');
  let oid = rootOid;
  for (const seg of segments) {
    const obj = lookup(oid);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === seg);
    if (!entry || entry.mode !== '40000') return null;
    oid = entry.oid;
  }
  const obj = lookup(oid);
  if (!obj || obj.type !== 'tree') return null;
  return parseTree(obj.data);
}

/**
 * A new root tree with `path` set to `blobOid` (or removed when null). New tree
 * objects are written into `objects` (a Map oid -> {type, data}) and the new
 * root oid is returned (null when the tree becomes empty).
 */
export function updateTree(objects, rootOid, path, blobOid) {
  const segments = path.split('/').filter((s) => s !== '');
  const put = (type, data) => {
    const oid = hashObject(type, data);
    if (!objects.has(oid)) objects.set(oid, { type, data });
    return oid;
  };
  const walk = (treeOid, depth) => {
    const list = treeOid && objects.has(treeOid) ? parseTree(objects.get(treeOid).data) : [];
    const name = segments[depth];
    const idx = list.findIndex((e) => e.name === name);
    if (depth === segments.length - 1) {
      if (blobOid === null) {
        if (idx < 0) return list.length ? put('tree', buildTree(list)) : null;
        const next = list.filter((_, i) => i !== idx);
        return next.length ? put('tree', buildTree(next)) : null;
      }
      const next = [...list];
      const entry = { mode: '100644', name, oid: blobOid };
      if (idx >= 0) next[idx] = entry;
      else next.push(entry);
      return put('tree', buildTree(next));
    }
    const childOid = idx >= 0 ? list[idx].oid : null;
    const newChild = walk(childOid, depth + 1);
    const next = [...list];
    if (newChild === null) {
      if (idx >= 0) next.splice(idx, 1);
    } else if (idx >= 0) {
      next[idx] = { mode: '40000', name, oid: newChild };
    } else {
      next.push({ mode: '40000', name, oid: newChild });
    }
    return next.length ? put('tree', buildTree(next)) : null;
  };
  return walk(rootOid, 0);
}

/** Flatten a tree into path -> {oid, mode} for blobs. */
export function flattenTree(lookup, rootOid, prefix = '', out = new Map()) {
  if (!rootOid) return out;
  const obj = lookup(rootOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const p = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(lookup, e.oid, p, out);
    else out.set(p, { oid: e.oid, mode: e.mode });
  }
  return out;
}

/** Diff two trees: path -> {old: oid|null, new: oid|null} for changed blobs. */
export function diffTrees(lookup, oldRoot, newRoot) {
  const a = flattenTree(lookup, oldRoot);
  const b = flattenTree(lookup, newRoot);
  const diff = new Map();
  for (const [p, entry] of a) {
    const other = b.get(p);
    if (!other || other.oid !== entry.oid) diff.set(p, { old: entry.oid, new: other ? other.oid : null });
  }
  for (const [p, entry] of b) {
    if (!a.has(p)) diff.set(p, { old: null, new: entry.oid });
  }
  return diff;
}

/** Line counts for a blob diff (multiset difference, good enough for text). */
export function lineDiff(oldData, newData) {
  const oldLines = oldData ? oldData.toString('utf8').split('\n') : [];
  const newLines = newData ? newData.toString('utf8').split('\n') : [];
  // Drop the trailing empty element a trailing newline produces.
  if (oldLines.length && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length && newLines[newLines.length - 1] === '') newLines.pop();
  const count = (lines) => {
    const m = new Map();
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const a = count(oldLines);
  const b = count(newLines);
  let additions = 0;
  let deletions = 0;
  for (const [l, n] of b) additions += Math.max(0, n - (a.get(l) ?? 0));
  for (const [l, n] of a) deletions += Math.max(0, n - (b.get(l) ?? 0));
  return { additions, deletions };
}

// ------------------------------------------------------------------ opaque ids

function b64url(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(text) {
  try {
    return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

export function repoGlobalId(owner, name) {
  return `R_${b64url(`repo:${owner}/${name}`)}`;
}
export function issueGlobalId(owner, repo, number) {
  return `I_${b64url(`issue:${owner}/${repo}:${number}`)}`;
}
export function pullGlobalId(owner, repo, number) {
  return `P_${b64url(`pr:${owner}/${repo}:${number}`)}`;
}
export function commentGlobalId(owner, repo, issueNumber, commentId) {
  return `C_${b64url(`comment:${owner}/${repo}:${issueNumber}:${commentId}`)}`;
}
/** Decode an opaque id back to {kind, owner, repo, number, commentId} or null. */
export function decodeGlobalId(id) {
  if (typeof id !== 'string') return null;
  const m = /^([RIPC])_(.+)$/.exec(id);
  if (!m) return null;
  const text = unb64url(m[2]);
  const parts = text.split(':');
  const kind = m[1];
  if (kind === 'R' && parts[0] === 'repo') {
    const [owner, repo] = (parts[1] ?? '').split('/');
    if (owner && repo) return { kind: 'repo', owner, repo };
  }
  if (kind === 'I' && parts[0] === 'issue') {
    const [owner, repo] = (parts[1] ?? '').split('/');
    const number = Number(parts[2]);
    if (owner && repo && Number.isInteger(number)) return { kind: 'issue', owner, repo, number };
  }
  if (kind === 'P' && parts[0] === 'pr') {
    const [owner, repo] = (parts[1] ?? '').split('/');
    const number = Number(parts[2]);
    if (owner && repo && Number.isInteger(number)) return { kind: 'pull', owner, repo, number };
  }
  if (kind === 'C' && parts[0] === 'comment') {
    const [owner, repo] = (parts[1] ?? '').split('/');
    const number = Number(parts[2]);
    const commentId = Number(parts[3]);
    if (owner && repo && Number.isInteger(number)) return { kind: 'comment', owner, repo, number, commentId };
  }
  return null;
}

// ------------------------------------------------------------------ the store

export class Repo {
  constructor(store, owner, name, { description = '', isPrivate = false } = {}) {
    this.store = store;
    this.id = store.nextRepoId++;
    this.owner = owner;
    this.name = name;
    this.fullName = `${owner}/${name}`;
    this.description = description;
    this.private = isPrivate;
    this.defaultBranch = DEFAULT_BRANCH;
    this.createdSeq = store.nextSeq();
    /** oid -> {type, data} */
    this.objects = new Map();
    /** refName -> oid */
    this.refs = new Map();
    /** number -> issue */
    this.issues = new Map();
    /** number -> pull request */
    this.pulls = new Map();
    /** shared issue + PR numbering, GitHub style */
    this.numberSeq = 0;
    /** label name -> {name, color, description} */
    this.labels = new Map();
    /** issue number -> [{id, body, ...}] */
    this.comments = new Map();
    this.commentSeq = 0;
  }

  get key() {
    return `${this.owner}/${this.name}`;
  }

  lookup(oid) {
    return this.objects.get(oid);
  }

  putObject(type, data) {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  refTip(branch) {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The commit object at a branch tip (or null). */
  branchCommit(branch) {
    const tip = this.refTip(branch);
    if (!tip) return null;
    const obj = this.objects.get(tip);
    return obj && obj.type === 'commit' ? { oid: tip, ...parseCommit(obj.data) } : null;
  }

  /** Resolve a ref-ish (branch name, full ref, or oid) to a commit oid. */
  resolveRef(ref) {
    if (!ref) return null;
    if (isOid(ref)) {
      const obj = this.objects.get(ref);
      return obj && obj.type === 'commit' ? ref : null;
    }
    if (ref.startsWith('refs/')) return this.refs.get(ref) ?? null;
    return this.refs.get(`refs/heads/${ref}`) ?? null;
  }

  /** Create a commit on `branch` (creating the branch from the default tip when new). */
  commitOnBranch({ branch, message, changes, parentTip }) {
    const refName = `refs/heads/${branch}`;
    let tip = this.refs.get(refName);
    if (tip === undefined && parentTip !== undefined) tip = parentTip;
    if (tip === undefined) tip = this.refs.get(`refs/heads/${this.defaultBranch}`) ?? null;
    const baseTree = tip ? parseCommit(this.objects.get(tip).data).tree : null;
    let root = baseTree;
    for (const change of changes) {
      root = updateTree(this.objects, root, change.path, change.blobOid);
    }
    const commitData = buildCommit({
      tree: root ?? this.putObject('tree', buildTree([])),
      parents: tip ? [tip] : [],
      // The message is stored verbatim: REST callers expect the exact
      // message they sent back from GET /commits (no trailing newline added).
      message,
      author: VIEWER_IDENT,
      committer: VIEWER_IDENT,
      timestamp: this.store.nextTimestamp(),
    });
    const commitOid = this.putObject('commit', commitData);
    this.refs.set(refName, commitOid);
    return { commitOid, treeOid: root, parentTip: tip };
  }

  /** The files a pull request changes, base tip tree vs head tip tree. */
  pullFiles(pr) {
    const baseTip = this.resolveRef(pr.base.ref);
    const headTip = this.resolveRef(pr.head.ref);
    const baseTree = baseTip ? parseCommit(this.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree : null;
    const headTree = headTip ? parseCommit(this.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree : null;
    const diff = diffTrees(this.lookup.bind(this), baseTree, headTree);
    const files = [];
    for (const [filename, change] of [...diff.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const oldData = change.old ? this.objects.get(change.old)?.data : null;
      const newData = change.new ? this.objects.get(change.new)?.data : null;
      const { additions, deletions } = lineDiff(oldData, newData);
      files.push({
        filename,
        status: change.old === null ? 'added' : change.new === null ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return files;
  }

  /** Would merging `pr` conflict? (three-way, against the tip it was opened on.) */
  mergeConflict(pr) {
    const baseTip = this.resolveRef(pr.base.ref);
    const headTip = this.resolveRef(pr.head.ref);
    if (!baseTip || !headTip) return true;
    const baseTree = pr.baseShaAtCreation ? parseCommit(this.objects.get(pr.baseShaAtCreation)?.data ?? Buffer.alloc(0)).tree : null;
    const headTree = parseCommit(this.objects.get(headTip).data).tree;
    const curTree = parseCommit(this.objects.get(baseTip).data).tree;
    const headDiff = diffTrees(this.lookup.bind(this), baseTree, headTree);
    const curDiff = diffTrees(this.lookup.bind(this), baseTree, curTree);
    for (const [path, change] of headDiff) {
      const other = curDiff.get(path);
      if (!other) continue;
      // Both sides changed the same path: conflict unless they agree.
      if (other.new !== change.new) return true;
    }
    return false;
  }

  /** Squash-merge an open pull request onto its base branch. Returns {ok, sha?, reason?}. */
  mergePull(pr, method = 'squash') {
    if (pr.state !== 'open' || pr.merged) return { ok: false, status: 405, message: 'Pull request is already closed' };
    const baseTip = this.resolveRef(pr.base.ref);
    const headTip = this.resolveRef(pr.head.ref);
    if (!baseTip || !headTip) return { ok: false, status: 422, message: 'Head or base branch is missing' };
    if (this.mergeConflict(pr)) return { ok: false, status: 405, message: 'Merge conflict' };
    const baseTree = pr.baseShaAtCreation ? parseCommit(this.objects.get(pr.baseShaAtCreation)?.data ?? Buffer.alloc(0)).tree : null;
    const headTree = parseCommit(this.objects.get(headTip).data).tree;
    const curTree = parseCommit(this.objects.get(baseTip).data).tree;
    const headDiff = diffTrees(this.lookup.bind(this), baseTree, headTree);
    let root = curTree;
    for (const [path, change] of headDiff) {
      root = updateTree(this.objects, root, path, change.new);
    }
    const message = `Merge pull request #${pr.number} from ${this.owner}/${pr.head.ref}\n\n${pr.title}\n`;
    const commitData = buildCommit({
      tree: root ?? this.putObject('tree', buildTree([])),
      parents: [baseTip],
      message,
      author: VIEWER_IDENT,
      committer: VIEWER_IDENT,
      timestamp: this.store.nextTimestamp(),
    });
    const sha = this.putObject('commit', commitData);
    this.refs.set(`refs/heads/${pr.base.ref}`, sha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = new Date().toISOString();
    pr.mergeCommitSha = sha;
    pr.closedAt = pr.mergedAt;
    return { ok: true, sha, message: 'Pull request successfully merged' };
  }
}

export class Store {
  constructor() {
    /** "owner/name" -> Repo */
    this.repos = new Map();
    this.nextRepoId = 1;
    this.nextIssueId = 1;
    this.nextCommentId = 1;
    this.seq = 0;
    this.ts = 1700000000;
  }

  nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  nextTimestamp() {
    this.ts += 1;
    return this.ts;
  }

  getRepo(owner, name) {
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  createRepo(owner, name, opts = {}) {
    const repo = new Repo(this, owner, name, opts);
    this.repos.set(repo.key, repo);
    return repo;
  }

  deleteRepo(owner, name) {
    return this.repos.delete(`${owner}/${name}`);
  }

  /** All repositories owned by `owner`, in creation order. */
  reposOf(owner) {
    return [...this.repos.values()].filter((r) => r.owner === owner);
  }

  createIssue(repo, { title, body = '', labels = [] }) {
    const number = ++repo.numberSeq;
    const issue = {
      id: this.nextIssueId++,
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      user: VIEWER_LOGIN,
      createdSeq: this.nextSeq(),
      updatedSeq: this.seq,
      commentsCount: 0,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(repo, { title, body = '', head, base }) {
    const number = ++repo.numberSeq;
    const pr = {
      id: this.nextIssueId++,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: { ref: head, sha: repo.refTip(head) },
      base: { ref: base, sha: repo.refTip(base) },
      baseShaAtCreation: repo.refTip(base),
      headShaAtCreation: repo.refTip(head),
      user: VIEWER_LOGIN,
      createdSeq: this.nextSeq(),
      closedAt: null,
    };
    repo.pulls.set(number, pr);
    return pr;
  }

  addComment(repo, issueNumber, body) {
    const id = ++repo.commentSeq;
    const comment = {
      id: this.nextCommentId++,
      repoCommentId: id,
      issueNumber,
      body,
      user: VIEWER_LOGIN,
      createdSeq: this.nextSeq(),
    };
    if (!repo.comments.has(issueNumber)) repo.comments.set(issueNumber, []);
    repo.comments.get(issueNumber).push(comment);
    const issue = repo.issues.get(issueNumber);
    if (issue) issue.commentsCount = repo.comments.get(issueNumber).length;
    return comment;
  }
}
