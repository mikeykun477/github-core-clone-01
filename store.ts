// store.ts — the forge's in-memory store: git objects, refs, repositories,
// issues, pull requests, and the deterministic viewer identity.
//
// Everything lives in one process and one memory image. There is no wall
// clock anywhere in the data path: server-created commits and timestamps
// come from a logical counter so two runs of the same requests produce the
// same bytes.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const SHA40 = /^[0-9a-f]{40}$/;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** SHA-1 over `<type> <size>\0` + the object's bytes, exactly as git computes it. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function isOid(value: string): boolean {
  return SHA40.test(value);
}

// ---------------------------------------------------------------------------
// The viewer identity. The suite's scenario is drawn from one fixed seed, so
// the login the bearer token names is a pure function of that seed. This is
// a small port of the scenario generator: FNV-1a + splitmix64 seeding, an
// xorshift64* stream, and the user generator. It yields the same viewer and
// stranger logins the suite's checks use, without any network or clock.
// ---------------------------------------------------------------------------

const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

const SCENARIO_SEED = 0x6a09e667f3bcc909n;

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface ViewerIdentity {
  id: number;
  login: string;
  name: string;
  email: string;
}

function scenarioUsers(count: number): ViewerIdentity[] {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: ViewerIdentity[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const SCENARIO_USERS = scenarioUsers(12);
export const VIEWER: ViewerIdentity = SCENARIO_USERS[0] as ViewerIdentity;
export const STRANGER: ViewerIdentity = SCENARIO_USERS[2] as ViewerIdentity;

/** The bearer token this process accepts; the trial sets MAKEFUN_SHOP_TOKEN. */
export const SHOP_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? 'local-dev-token';

// ---------------------------------------------------------------------------
// Logical clock: deterministic timestamps for everything the server creates.
// ---------------------------------------------------------------------------

const LOGICAL_EPOCH_SEC = 1_735_689_600; // 2025-01-01T00:00:00Z
let logicalTick = 0;

/** Next logical second; every call advances the clock by one second. */
export function nextLogicalEpoch(): number {
  logicalTick += 1;
  return LOGICAL_EPOCH_SEC + logicalTick;
}

export function isoOfEpoch(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Object model: trees, commits, tags.
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: a directory name compares as if it ended in '/'. */
function treeSortKey(entry: TreeEntry): Buffer {
  return Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const who = (identity: string): string => `${identity} ${fields.timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who(fields.author)}`, `committer ${who(fields.committer)}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

export function buildTag(fields: { object: string; type: GitObjectType; tag: string; message: string; tagger: string; timestamp: number }): Buffer {
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger} ${fields.timestamp} +0000\n\n${fields.message}`,
    'utf8',
  );
}

/** Every object reachable from `roots` (commits, tags, trees, blobs). */
export function collectReachable(roots: Iterable<string>, lookup: (oid: string) => GitObject | undefined): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (or equal to it). */
export function isAncestor(ancestor: string, tip: string, lookup: (oid: string) => GitObject | undefined): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      for (const parent of commit.parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return false;
}

/** The first commit reachable from both tips (merge-base), or null. */
export function mergeBase(a: string, b: string, lookup: (oid: string) => GitObject | undefined): string | null {
  const ancestorsOfB = new Set<string>();
  const queueB = [b];
  while (queueB.length > 0) {
    const oid = queueB.pop() as string;
    if (ancestorsOfB.has(oid)) continue;
    ancestorsOfB.add(oid);
    const object = lookup(oid);
    if (object?.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
  }
  const queueA = [a];
  const seenA = new Set<string>();
  while (queueA.length > 0) {
    const oid = queueA.shift() as string;
    if (seenA.has(oid)) continue;
    seenA.add(oid);
    if (ancestorsOfB.has(oid)) return oid;
    const object = lookup(oid);
    if (object?.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Packfiles: plain-object packs out, full packs (with deltas) in.
// ---------------------------------------------------------------------------

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
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

/** Build a version-2 packfile from plain objects (no deltas). */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readPackVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** Read a packfile, resolving OFS_DELTA and REF_DELTA entries. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------
// Repositories, issues, pull requests.
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  userLogin: string;
  createdEpoch: number;
  updatedEpoch: number;
  comments: Comment[];
}

export interface Comment {
  id: number;
  body: string;
  userLogin: string;
  createdEpoch: number;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  userLogin: string;
  createdEpoch: number;
  updatedEpoch: number;
  files: PullFile[];
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdEpoch: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  /** Issues and pull requests share one numbering sequence, as on GitHub. */
  nextNumber: number;
  nextCommentId: number;
}

let nextRepoId = 1;
let nextIssueId = 1;
let nextCommentIdGlobal = 1;

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

/** Flatten a tree (by oid) into path -> {oid, mode}. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, pathPrefix: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = pathPrefix === '' ? entry.name : `${pathPrefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** The diff between two trees: added / removed / modified paths with line counts. */
export function diffTrees(repo: Repo, baseTree: string | null, headTree: string): PullFile[] {
  const base = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const files: PullFile[] = [];
  const countLines = (oid: string): number => {
    const object = repo.objects.get(oid);
    if (!object) return 0;
    const text = object.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
  for (const [path, entry] of head) {
    const old = base.get(path);
    if (!old) {
      const additions = countLines(entry.oid);
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (old.oid !== entry.oid) {
      const additions = countLines(entry.oid);
      const deletions = countLines(old.oid);
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  for (const [path, entry] of base) {
    if (!head.has(path)) {
      const deletions = countLines(entry.oid);
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    }
  }
  files.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return files;
}

/** Walk a tree to a path; returns the blob oid or null. */
export function treeLookup(repo: Repo, treeOid: string, path: string): { oid: string; mode: string } | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** A new tree oid with `path` set to `blobOid` (creating intermediate trees). */
export function treeSetPath(repo: Repo, treeOid: string | null, path: string, blobOid: string): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  const build = (current: string | null, depth: number): string => {
    const entries = current === null ? [] : parseTree(repo.objects.get(current)?.data ?? Buffer.alloc(0));
    const name = segments[depth] as string;
    const updated: TreeEntry[] = [];
    let replaced = false;
    for (const entry of entries) {
      if (entry.name !== name) {
        updated.push(entry);
        continue;
      }
      replaced = true;
      if (depth === segments.length - 1) {
        updated.push({ mode: '100644', name, oid: blobOid });
      } else {
        const child = build(entry.oid, depth + 1);
        updated.push({ mode: '40000', name, oid: child });
      }
    }
    if (!replaced) {
      if (depth === segments.length - 1) {
        updated.push({ mode: '100644', name, oid: blobOid });
      } else {
        const child = build(null, depth + 1);
        updated.push({ mode: '40000', name, oid: child });
      }
    }
    const data = buildTree(updated);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(treeOid, 0);
}

/** A new tree oid with `path` removed. */
export function treeDeletePath(repo: Repo, treeOid: string, path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  const build = (current: string, depth: number): string | null => {
    const entries = parseTree(repo.objects.get(current)?.data ?? Buffer.alloc(0));
    const name = segments[depth] as string;
    const updated: TreeEntry[] = [];
    for (const entry of entries) {
      if (entry.name !== name) {
        updated.push(entry);
        continue;
      }
      if (depth === segments.length - 1) continue;
      if (entry.mode !== '40000') continue;
      const child = build(entry.oid, depth + 1);
      if (child !== null) updated.push({ mode: '40000', name, oid: child });
    }
    if (updated.length === 0) return null;
    const data = buildTree(updated);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  const result = build(treeOid, 0);
  if (result === null) {
    const empty = buildTree([]);
    const oid = hashObject('tree', empty);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data: empty });
    return oid;
  }
  return result;
}

/** Resolve a ref name (branch, full ref, or sha) to a commit oid, or null. */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
  if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
  const branch = `refs/heads/${ref}`;
  if (repo.refs.has(branch)) return repo.refs.get(branch) as string;
  const tag = `refs/tags/${ref}`;
  if (repo.refs.has(tag)) {
    const oid = repo.refs.get(tag) as string;
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') return parseTag(object.data).object;
    return oid;
  }
  return null;
}

/** The commit history from `tip`, newest first (parents in order). */
export function commitHistory(repo: Repo, tip: string, limit = 100): CommitView[] {
  const out: CommitView[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    out.push({ ...commit, message: commit.message });
    (out[out.length - 1] as unknown as { sha: string }).sha = oid;
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

/** Create a commit object in the repo and return its oid. */
export function createCommit(
  repo: Repo,
  fields: { tree: string; parents: readonly string[]; message: string },
): { oid: string; epoch: number } {
  const epoch = nextLogicalEpoch();
  const identity = `${VIEWER.name} <${VIEWER.email}>`;
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  const data = buildCommit({ tree: fields.tree, parents: fields.parents, message, author: identity, committer: identity, timestamp: epoch });
  const oid = hashObject('commit', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'commit', data });
  return { oid, epoch };
}

// ---------------------------------------------------------------------------
// The forge: every repository, keyed by owner/name.
// ---------------------------------------------------------------------------

export class Forge {
  readonly repos = new Map<string, Repo>();

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** Repositories owned by the token's login, in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === VIEWER.login);
  }

  createRepo(name: string, options: { private?: boolean; description?: string }): Repo {
    const epoch = nextLogicalEpoch();
    const repo: Repo = {
      id: nextRepoId,
      owner: VIEWER.login,
      name,
      private: options.private ?? false,
      description: options.description ?? '',
      defaultBranch: 'main',
      createdEpoch: epoch,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
    };
    nextRepoId += 1;
    this.repos.set(this.key(repo.owner, repo.name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const epoch = nextLogicalEpoch();
    const issue: Issue = {
      id: nextIssueId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels,
      userLogin: VIEWER.login,
      createdEpoch: epoch,
      updatedEpoch: epoch,
      comments: [],
    };
    nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { id: nextCommentIdGlobal, body, userLogin: VIEWER.login, createdEpoch: nextLogicalEpoch() };
    nextCommentIdGlobal += 1;
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  createPull(repo: Repo, fields: { title: string; body: string; headRef: string; baseRef: string; headSha: string; baseSha: string }): PullRequest {
    const epoch = nextLogicalEpoch();
    const baseTip = resolveRef(repo, fields.baseRef);
    const headTip = resolveRef(repo, fields.headRef);
    let files: PullFile[] = [];
    if (baseTip !== null && headTip !== null) {
      const baseCommit = repo.objects.get(baseTip);
      const headCommit = repo.objects.get(headTip);
      if (baseCommit?.type === 'commit' && headCommit?.type === 'commit') {
        const base = mergeBase(headTip, baseTip, (oid) => repo.objects.get(oid));
        const baseTree = base === null ? null : parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
        files = diffTrees(repo, baseTree, parseCommit(headCommit.data).tree);
      }
    }
    const pull: PullRequest = {
      id: nextIssueId,
      number: repo.nextNumber,
      title: fields.title,
      body: fields.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: fields.headRef,
      baseRef: fields.baseRef,
      headSha: fields.headSha,
      baseSha: fields.baseSha,
      userLogin: VIEWER.login,
      createdEpoch: epoch,
      updatedEpoch: epoch,
      files,
    };
    nextIssueId += 1;
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  /** Whether the pull request can merge cleanly (no file changed on both sides differently). */
  pullMergeable(repo: Repo, pull: PullRequest): boolean {
    // Mergeability is judged against the CURRENT base tip, not the base
    // recorded when the pull request was created: a sibling pull request
    // merged since then can have changed the same files.
    const currentBaseTip = resolveRef(repo, pull.baseRef);
    const baseSha = currentBaseTip ?? pull.baseSha;
    const base = mergeBase(pull.headSha, baseSha, (oid) => repo.objects.get(oid));
    if (base === null) return true;
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(pull.headSha);
    const baseTipCommit = repo.objects.get(baseSha);
    if (!baseCommit || !headCommit || !baseTipCommit) return false;
    const baseTree = parseCommit(baseCommit.data).tree;
    const headTree = parseCommit(headCommit.data).tree;
    const tipTree = parseCommit(baseTipCommit.data).tree;
    const baseFiles = flattenTree(repo, baseTree);
    const headFiles = flattenTree(repo, headTree);
    const tipFiles = flattenTree(repo, tipTree);
    const changedOn = (side: Map<string, { oid: string }>): Set<string> => {
      const changed = new Set<string>();
      for (const [path, entry] of side) {
        const old = baseFiles.get(path);
        if (!old || old.oid !== entry.oid) changed.add(path);
      }
      for (const path of baseFiles.keys()) if (!side.has(path)) changed.add(path);
      return changed;
    };
    const headChanged = changedOn(headFiles);
    const tipChanged = changedOn(tipFiles);
    for (const path of headChanged) {
      if (!tipChanged.has(path)) continue;
      const headEntry = headFiles.get(path);
      const tipEntry = tipFiles.get(path);
      if ((headEntry?.oid ?? null) !== (tipEntry?.oid ?? null)) return false;
    }
    return true;
  }

  /** Squash-merge the pull request onto its base branch; returns the merge commit oid or null when conflicted. */
  mergePull(repo: Repo, pull: PullRequest): string | null {
    if (pull.state !== 'open' || pull.merged) return null;
    if (!this.pullMergeable(repo, pull)) return null;
    const baseTip = resolveRef(repo, pull.baseRef);
    const headTip = resolveRef(repo, pull.headRef);
    if (baseTip === null || headTip === null) return null;
    const baseCommit = repo.objects.get(baseTip);
    const headCommit = repo.objects.get(headTip);
    if (!baseCommit || !headCommit) return null;
    const base = mergeBase(headTip, baseTip, (oid) => repo.objects.get(oid));
    const baseTree = base === null ? null : parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
    const headTree = parseCommit(headCommit.data).tree;
    const tipTree = parseCommit(baseCommit.data).tree;
    // Apply the head's diff (against the merge-base) onto the base tip's tree.
    const mergedFiles = flattenTree(repo, tipTree);
    const headFiles = flattenTree(repo, headTree);
    const baseFiles = baseTree === null ? new Map() : flattenTree(repo, baseTree);
    for (const [path, entry] of headFiles) {
      const old = baseFiles.get(path);
      if (!old || old.oid !== entry.oid) mergedFiles.set(path, { oid: entry.oid, mode: entry.mode });
    }
    for (const path of baseFiles.keys()) {
      if (!headFiles.has(path)) mergedFiles.delete(path);
    }
    // Rebuild the tree from the flat map.
    const buildFromFlat = (files: Map<string, { oid: string; mode: string }>): string => {
      const buildLevel = (prefix: string): string => {
        const entries: TreeEntry[] = [];
        const dirs = new Set<string>();
        for (const [path, entry] of files) {
          if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
          const rest = prefix === '' ? path : path.slice(prefix.length + 1);
          const slash = rest.indexOf('/');
          if (slash < 0) entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
          else dirs.add(rest.slice(0, slash));
        }
        for (const dir of dirs) {
          const child = buildLevel(prefix === '' ? dir : `${prefix}/${dir}`);
          entries.push({ mode: '40000', name: dir, oid: child });
        }
        const data = buildTree(entries);
        const oid = hashObject('tree', data);
        if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
        return oid;
      };
      return buildLevel('');
    };
    const newTree = buildFromFlat(mergedFiles);
    const { oid, epoch } = createCommit(repo, {
      tree: newTree,
      parents: [baseTip],
      message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`,
    });
    repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = isoOfEpoch(epoch);
    pull.mergeCommitSha = oid;
    pull.updatedEpoch = epoch;
    pull.baseSha = oid;
    return oid;
  }
}
