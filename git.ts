// git.ts — git smart HTTP: info/refs (v0 + v2), upload-pack (v2 + v0),
// receive-pack (v0). No git binary: the packfile and protocol are built
// here, on node:zlib and node:crypto, from the store in store.ts.

import {
  ZERO_OID,
  collectReachable,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  type Forge,
  type GitObject,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = Buffer.from('0000', 'ascii');
export const pktDelim = Buffer.from('0001', 'ascii');

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Decode every pkt-line in a buffer; throws on a malformed header. */
export function decodePktLines(bytes: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line');
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length < 4 || length > 65520) {
      throw new Error(`invalid pkt-line length ${length}`);
    } else {
      if (offset + length > bytes.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

export function pktLinesText(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------------------
// Ref listing
// ---------------------------------------------------------------------------

export interface RefEntry {
  name: string;
  oid: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function peelOf(repo: Repo, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (object?.type === 'tag') return parseTag(object.data).object;
  return undefined;
}

/** Every ref of the repository, HEAD first, then heads, then tags, sorted. */
export function listRefs(repo: Repo): RefEntry[] {
  const out: RefEntry[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultTip = repo.refs.get(defaultRef);
  if (defaultTip !== undefined) {
    out.push({ name: 'HEAD', oid: defaultTip, symrefTarget: defaultRef });
  } else {
    out.push({ name: 'HEAD', oid: ZERO_OID, symrefTarget: defaultRef, unborn: true });
  }
  const heads = [...repo.refs.keys()].filter((name) => name.startsWith('refs/heads/')).sort();
  for (const name of heads) {
    out.push({ name, oid: repo.refs.get(name) as string });
  }
  const tags = [...repo.refs.keys()].filter((name) => name.startsWith('refs/tags/')).sort();
  for (const name of tags) {
    const oid = repo.refs.get(name) as string;
    out.push({ name, oid, peeled: peelOf(repo, oid) });
  }
  return out;
}

const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow filter agent=github-core-clone-01-forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=github-core-clone-01-forge/1.0';

/** The v0 info/refs body for a service, with the `# service=` preamble. */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush];
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS_V0} symref=HEAD:refs/heads/${repo.defaultBranch}` : RECEIVE_CAPS;
  const refs = listRefs(repo).filter((ref) => ref.name !== 'HEAD');
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0 && headTip === undefined) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = listRefs(repo)[0] as RefEntry;
    parts.push(pktLine(`${head.oid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

/** The v2 info/refs body: `version 2` plus capability lines. */
export function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'agent=github-core-clone-01-forge/1.0\n',
  ];
  const parts: Buffer[] = [];
  for (const line of lines) parts.push(pktLine(line));
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Fetch planning: which commits and objects a fetch sends.
// ---------------------------------------------------------------------------

export interface FetchPlan {
  /** Commits (and tag objects) the response includes. */
  includedCommits: string[];
  /** Objects to pack. */
  objects: GitObject[];
  /** The new shallow boundary (commits whose parents are not included). */
  shallow: string[];
  /** Old shallow commits that are now fully included. */
  unshallow: string[];
}

export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  oldShallow: readonly string[],
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // What the client already holds: the reachable closure of its haves,
  // truncated at its old shallow boundary — a shallow commit's parents
  // are NOT held, even though they are reachable from the have.
  const collectHeld = (roots: readonly string[]): Set<string> => {
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      const object = lookup(oid);
      if (!object) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        if (!oldShallow.includes(oid)) {
          for (const parent of commit.parents) queue.push(parent);
        }
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
    return seen;
  };
  // Included commits: a depth-limited walk from the wants, or the whole
  // reachable closure minus what the haves already reach.
  const included = new Set<string>();
  if (depth !== null) {
    let level = [...wants];
    for (let generation = 0; generation < depth && level.length > 0; generation += 1) {
      const next: string[] = [];
      for (const oid of level) {
        if (included.has(oid)) continue;
        const object = lookup(oid);
        if (!object) continue;
        included.add(oid);
        if (object.type === 'commit') {
          for (const parent of parseCommit(object.data).parents) next.push(parent);
        } else if (object.type === 'tag') {
          next.push(parseTag(object.data).object);
        }
      }
      level = next;
    }
  } else {
    const haveReachable = collectHeld(haves);
    for (const oid of collectReachable(wants, lookup)) {
      if (haveReachable.has(oid)) continue;
      const object = lookup(oid);
      if (object?.type === 'commit' || object?.type === 'tag') included.add(oid);
    }
  }
  // Objects: the closure of the included commits, truncated at the boundary
  // (a boundary commit contributes its tree, not its parents), minus what
  // the client already holds.
  const haveObjects = collectHeld(haves);
  const send = new Set<string>();
  const addClosure = (root: string, truncateParents: boolean): void => {
    const queue = [root];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid) || haveObjects.has(oid)) continue;
      seen.add(oid);
      const object = lookup(oid);
      if (!object) continue;
      send.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        if (!truncateParents) for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
  };
  for (const oid of included) {
    const object = lookup(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      const isBoundary = depth !== null && commit.parents.some((parent) => !included.has(parent));
      addClosure(oid, depth !== null && isBoundary);
    } else if (object.type === 'tag') {
      addClosure(oid, false);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of send) {
    const object = lookup(oid);
    if (object) objects.push(object);
  }
  // Shallow boundary: included commits with a parent outside the set.
  const shallow: string[] = [];
  for (const oid of included) {
    const object = lookup(oid);
    if (object?.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (commit.parents.some((parent) => !included.has(parent))) shallow.push(oid);
  }
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const old of oldShallow) {
      if (included.has(old) && !shallow.includes(old)) unshallow.push(old);
    }
  }
  return { includedCommits: [...included], objects, shallow, unshallow };
}

/** Split pack bytes into sideband band-1 pkt-lines. */
export function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

// ---------------------------------------------------------------------------
// upload-pack v2: ls-refs and fetch.
// ---------------------------------------------------------------------------

export function handleLsRefs(repo: Repo, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const refs = listRefs(repo);
  const parts: Buffer[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    const attrs: string[] = [];
    if (symrefs && ref.symrefTarget !== undefined) attrs.push(`symref-target:${ref.symrefTarget}`);
    if (peel && ref.peeled !== undefined) attrs.push(`peeled:${ref.peeled}`);
    if (ref.unborn === true) {
      if (!unborn) continue;
      parts.push(pktLine(`unborn ${ref.name}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}\n`));
    } else {
      parts.push(pktLine(`${ref.oid} ${ref.name}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}\n`));
    }
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

export function handleFetchV2(repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7).trim(), 10);
  }
  const plan = planFetch(repo, wants, haves, depth, shallow);
  const parts: Buffer[] = [];
  // acknowledgments section
  parts.push(pktLine('acknowledgments\n'));
  const acked = haves.filter((have) => plan.includedCommits.length > 0 && wants.some((want) => isAncestor(have, want, (oid) => repo.objects.get(oid))));
  if (acked.length > 0) {
    for (const have of acked) parts.push(pktLine(`ACK ${have}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktDelim);
  // shallow-info section
  if (depth !== null) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim);
  }
  // packfile section
  parts.push(pktLine('packfile\n'));
  const pack = writePack(plan.objects);
  for (const chunk of sidebandPack(pack)) parts.push(chunk);
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack v0: want/have/done with sideband.
// ---------------------------------------------------------------------------

export function handleFetchV0(repo: Repo, lines: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let seenFlush = false;
  for (const line of lines) {
    if (line === '') continue;
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      wants.push(rest.split(' ')[0] as string);
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      depth = Number.parseInt(line.slice(7).trim(), 10);
    } else if (line === 'done') {
      seenFlush = true;
    }
  }
  void seenFlush;
  const plan = planFetch(repo, wants, haves, depth, shallow);
  const parts: Buffer[] = [];
  const acked = haves.filter((have) => wants.some((want) => isAncestor(have, want, (oid) => repo.objects.get(oid))));
  if (acked.length > 0) {
    for (const have of acked) parts.push(pktLine(`ACK ${have}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const pack = writePack(plan.objects);
  for (const chunk of sidebandPack(pack)) parts.push(chunk);
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack v0: command list + pack, report-status over sideband.
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

/**
 * Handle a receive-pack request body. Returns the response body: the
 * report-status stream framed in sideband band 1, or an unpack error.
 * The body is `<pkt-lines of commands> flush <pack bytes>`.
 */
export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  // Split the command section (pkt-lines up to the first flush) from the pack.
  let offset = 0;
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  let sawFlush = false;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      sawFlush = true;
      break;
    }
    if (length < 4 || offset + length > body.length) break;
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    const line = payload.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    let text = line;
    if (nul >= 0) {
      text = line.slice(0, nul);
      capabilities = line.slice(nul + 1).split(' ').filter((token) => token !== '');
    }
    const parts = text.split(' ');
    if (parts.length >= 3 && isOid(parts[0] as string) && isOid(parts[1] as string)) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  }
  const wantsReport = capabilities.includes('report-status') || capabilities.includes('report-status-v2');
  const packBytes = sawFlush ? body.subarray(offset) : Buffer.alloc(0);

  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const report: PushReportLine[] = [];

  if (commands.length === 0) {
    return Buffer.concat([pktFlush]);
  }

  // Unpack: every object the pack carries joins the repo's store.
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (needsPack && packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message.replace(/\n/g, ' ') : String(err);
    }
  } else if (needsPack && packBytes.length === 0) {
    unpackOk = false;
    unpackDetail = 'unpacker error: empty pack';
  }

  for (const command of commands) {
    if (!unpackOk) {
      report.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        report.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (current !== command.oldOid && command.oldOid !== ZERO_OID) {
        report.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      } else {
        repo.refs.delete(command.ref);
        report.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (!target) {
      report.push({ ref: command.ref, ok: false, reason: 'unable to resolve new object' });
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        report.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (current !== command.oldOid) {
      report.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      continue;
    }
    if (command.newOid === current) {
      report.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (!isAncestor(current, command.newOid, (oid) => repo.objects.get(oid))) {
      report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    report.push({ ref: command.ref, ok: true, reason: '' });
  }

  if (!wantsReport) {
    return Buffer.concat([pktFlush]);
  }
  reportLines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`);
  for (const entry of report) {
    reportLines.push(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`);
  }
  const reportText = Buffer.concat(reportLines.map((line) => pktLine(line)));
  // The report-status stream rides sideband band 1, itself pkt-lined.
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let start = 0; start < reportText.length; start += CHUNK) {
    const slice = reportText.subarray(start, Math.min(reportText.length, start + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

/** Parse an upload-pack v2 request body into its command and arguments. */
export function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  const lines = pktLinesText(packets);
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
    } else {
      args.push(line);
    }
  }
  void lines;
  return { command, args };
}

/** Parse a v0 upload-pack request body into its text lines. */
export function parseV0Request(body: Buffer): string[] {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    else if (packet.kind === 'flush') lines.push('');
  }
  return lines;
}
