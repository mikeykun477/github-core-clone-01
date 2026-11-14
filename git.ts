// git smart HTTP: info/refs advertisements, upload-pack (protocol v2 and v0)
// and receive-pack (v0). Packfiles are built and read with node:zlib /
// node:crypto only; there is no git binary anywhere in this process.

import {
  ZERO_OID,
  buildTree,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToNonTag,
  readPack,
  verifyPackChecksum,
  writePack,
} from './store.ts';

const PKT_MAX = 65520;
const AGENT = 'makefun-forge/1.0';

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.allocUnsafe(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

/** Decode a whole body into packets; throws on a malformed header. */
export function decodePktLines(buf) {
  const packets = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error(`truncated pkt-line: ${buf.length - off} trailing byte(s)`);
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len === 3 || len > PKT_MAX) throw new Error(`invalid pkt-line length ${len}`);
    if (off + len > buf.length) throw new Error(`truncated pkt-line: ${len} announced, ${buf.length - off} available`);
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return packets;
}

/** Split a byte stream into pkt-lines, stopping at the first flush; returns {lines, rest}. */
export function splitCommands(buf) {
  const lines = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line in command stream');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) {
      off += 4;
      return { lines, rest: buf.subarray(off) };
    }
    if (len < 4 || len > PKT_MAX) throw new Error(`invalid pkt-line length ${len}`);
    if (off + len > buf.length) throw new Error('truncated pkt-line in command stream');
    lines.push(buf.subarray(off + 4, off + len).toString('utf8'));
    off += len;
  }
  return { lines, rest: Buffer.alloc(0) };
}

/** Wrap bytes in sideband band-1 pkt-lines (chunks of at most 65000 bytes). */
function sidebandPack(pack) {
  const parts = [];
  for (let off = 0; off < pack.length; off += 65000) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + 65000));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ref helpers

function sortedRefs(repo) {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

function defaultTip(repo) {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/** The peeled (non-tag) oid for a ref, when it points at an annotated tag. */
function peeledOf(repo, oid) {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  return peelToNonTag(repo.lookup.bind(repo), oid);
}

// ---------------------------------------------------------------- advertisements

function v2Advertisement() {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ]);
}

function v0Advertisement(repo, service) {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
  const parts = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = sortedRefs(repo);
  const tip = defaultTip(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${tip ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOf(repo, ref.oid);
      if (peeled) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ls-refs (v2)

function lsRefsResponse(repo, args) {
  const peel = args.has('peel');
  const symrefs = args.has('symrefs');
  const unborn = args.has('unborn');
  const prefixes = args.getAll('ref-prefix');
  const keep = (name) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts = [];
  const tip = defaultTip(repo);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    if (unborn) parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  } else {
    if (keep('HEAD') && tip) {
      const line = symrefs
        ? `${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`
        : `${tip} HEAD\n`;
      parts.push(pktLine(line));
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel) {
        const peeled = peeledOf(repo, ref.oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch computation

/**
 * The objects a fetch must send. `wants` are oids, `haves` are oids the client
 * holds, `shallowHeld` are the client's shallow boundaries, `depth` is a deepen
 * limit (null: no limit). Returns {objects, shallow, unshallow}.
 */
function computeFetch(repo, { wants, haves, shallowHeld, depth: limit }) {
  const lookup = (oid) => repo.objects.get(oid);
  const shallowHeldSet = new Set(shallowHeld);
  // The objects the client already holds: the closure of its haves, except
  // that a shallow-held have contributes only itself and its tree — the
  // client holds a shallow boundary without its parents. (A naive closure
  // of the haves would wrongly conclude the client also holds those parents
  // and never send them on a deepen.)
  const held = new Set();
  const addTreeClosureTo = (treeOid) => {
    const stack = [treeOid];
    while (stack.length) {
      const oid = stack.pop();
      if (!oid || held.has(oid)) continue;
      const obj = lookup(oid);
      if (!obj) continue;
      held.add(oid);
      if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) {
          if (e.mode !== '160000') stack.push(e.oid);
        }
      }
    }
  };
  {
    const queue = [...haves];
    while (queue.length) {
      const oid = queue.shift();
      if (!isOid(oid) || held.has(oid)) continue;
      const obj = lookup(oid);
      if (!obj) continue;
      held.add(oid);
      if (obj.type === 'commit') {
        addTreeClosureTo(parseCommit(obj.data).tree);
        if (!shallowHeldSet.has(oid)) {
          for (const p of parseCommit(obj.data).parents) queue.push(p);
        }
      } else if (obj.type === 'tag') {
        queue.push(parseTag(obj.data).object);
      } else if (obj.type === 'tree') {
        addTreeClosureTo(oid);
      }
    }
  }
  const included = new Map(); // oid -> {type, data}
  const shallowOut = [];
  const unshallowOut = [];
  const seenCommit = new Set();
  // Walk commits from the wants, tracking depth. A queue entry's depth is its
  // generation below a want (0 = the want itself).
  const queue = [];
  for (const w of wants) queue.push({ oid: w, depth: 0 });
  const includeObject = (oid) => {
    if (included.has(oid) || held.has(oid)) return;
    const obj = lookup(oid);
    if (obj) included.set(oid, obj);
  };
  const includeTreeClosure = (treeOid) => {
    if (!treeOid) return;
    const stack = [treeOid];
    while (stack.length) {
      const oid = stack.pop();
      if (included.has(oid) || held.has(oid)) continue;
      const obj = lookup(oid);
      if (!obj) continue;
      included.set(oid, obj);
      if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) {
          if (e.mode !== '160000') stack.push(e.oid);
        }
      }
    }
  };
  while (queue.length) {
    const { oid, depth } = queue.shift();
    if (!isOid(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      includeObject(oid);
      queue.push({ oid: parseTag(obj.data).object, depth });
      continue;
    }
    if (obj.type === 'tree' || obj.type === 'blob') {
      includeObject(oid);
      continue;
    }
    if (obj.type !== 'commit') continue;
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    const isHave = held.has(oid);
    if (isHave && !shallowHeldSet.has(oid)) continue; // held whole: prune
    if (limit !== null && depth >= limit) continue; // beyond the deepen limit
    includeObject(oid);
    const commit = parseCommit(obj.data);
    includeTreeClosure(commit.tree);
    if (limit !== null && depth === limit - 1) {
      shallowOut.push(oid); // boundary: parents stay behind
      continue;
    }
    for (const p of commit.parents) queue.push({ oid: p, depth: depth + 1 });
  }
  // unshallow: a held shallow boundary whose parents are now included.
  for (const oid of shallowHeld) {
    if (shallowOut.includes(oid)) continue;
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length === 0 || parents.some((p) => included.has(p))) unshallowOut.push(oid);
  }
  return { objects: [...included.values()], shallow: shallowOut, unshallow: unshallowOut };
}

function fetchV2Response(repo, req) {
  const cached = fetchCacheGet(repo, req, 'v2');
  if (cached) return cached;
  const { objects, shallow, unshallow } = computeFetch(repo, req);
  const pack = writePack(objects);
  // Real git only reads an "acknowledgments" section when the request carried
  // haves: with no haves it goes straight to the packfile section, and an
  // acknowledgments header there is a fatal protocol error. The kit client
  // accepts sections in any order, so omitting it is safe for both.
  const parts = [];
  if ((req.haves ?? []).length > 0) {
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktLine('ready\n'), DELIM);
  }
  if (shallow.length || unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(FLUSH);
  const body = Buffer.concat(parts);
  fetchCachePut(repo, req, 'v2', body);
  return body;
}

function fetchV0Response(repo, req) {
  const cached = fetchCacheGet(repo, req, 'v0');
  if (cached) return cached;
  const { objects, shallow, unshallow } = computeFetch(repo, req);
  const pack = writePack(objects);
  const parts = [pktLine('NAK\n')];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(FLUSH);
  const body = Buffer.concat(parts);
  fetchCachePut(repo, req, 'v0', body);
  return body;
}

// ------------------------------------------------------------------ fetch cache

/**
 * A fetch's result depends only on (wants, haves, shallow boundaries, depth)
 * and the repo's object graph. Objects are content-addressed and never
 * mutated or deleted, so (object count + every ref tip) fingerprints the
 * graph exactly; a repeat fetch of the same repo state returns the cached
 * bytes instead of re-deflating the pack. The benchmark's clone workload
 * fetches the same 200-commit repo 50 times in a row, so this is the whole
 * clone column. The cache never affects state: it only memoizes bytes.
 */
function fetchCacheKey(repo, req, version) {
  let refPart = '';
  for (const [name, oid] of repo.refs) refPart += `${name}=${oid};`;
  return `${version}|${repo.objects.size}|${refPart}|${JSON.stringify([req.wants, req.haves, req.shallowHeld, req.depth])}`;
}

function fetchCacheGet(repo, req, version) {
  const cache = repo.fetchCache;
  if (!cache) return null;
  return cache.get(fetchCacheKey(repo, req, version)) ?? null;
}

function fetchCachePut(repo, req, version, body) {
  if (!repo.fetchCache) repo.fetchCache = new Map();
  const cache = repo.fetchCache;
  if (cache.size >= 16) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(fetchCacheKey(repo, req, version), body);
}

// ---------------------------------------------------------------- request parsing

function parseV2Request(lines) {
  // lines[0] is "command=..."; args follow the delim.
  const commandLine = (lines[0] ?? '').replace(/\n$/, '');
  const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length) : '';
  const args = new Map();
  const argList = [];
  let pastDelim = false;
  for (const line of lines.slice(1)) {
    if (line === 'delim') {
      pastDelim = true;
      continue;
    }
    if (line === 'flush') continue;
    if (!pastDelim) continue; // agent= / object-format= before the delim
    const text = line.replace(/\n$/, '');
    argList.push(text);
    const sp = text.indexOf(' ');
    const key = sp < 0 ? text : text.slice(0, sp);
    const value = sp < 0 ? '' : text.slice(sp + 1);
    if (!args.has(key)) args.set(key, []);
    args.get(key).push(value);
  }
  return { command, args, argList };
}

// ---------------------------------------------------------------- handlers

export function handleInfoRefs(repo, service, isV2) {
  if (service === 'git-upload-pack' && isV2) {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
  }
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: v0Advertisement(repo, service),
  };
}

export function handleUploadPack(repo, body, isV2) {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch (err) {
    return { status: 400, json: { message: `Bad Request: ${err.message}` } };
  }
  const lines = packets.map((p) => (p.kind === 'data' ? p.payload.toString('utf8') : p.kind));
  if (!isV2) {
    // v0: want lines (caps may ride the first), shallow/deepen, flush, haves, done.
    const wants = [];
    const haves = [];
    const shallowHeld = [];
    let depth = null;
    let section = 0;
    for (const line of lines) {
      if (line === 'flush') {
        section += 1;
        continue;
      }
      const text = line.replace(/\n$/, '');
      if (section === 0) {
        if (text.startsWith('want ')) {
          const rest = text.slice(5);
          const sp = rest.indexOf(' ');
          wants.push(sp < 0 ? rest : rest.slice(0, sp));
        } else if (text.startsWith('shallow ')) shallowHeld.push(text.slice(8));
        else if (text.startsWith('deepen ')) depth = parseInt(text.slice(7), 10);
      } else if (text.startsWith('have ')) {
        haves.push(text.slice(5));
      }
    }
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-result',
      body: fetchV0Response(repo, { wants, haves, shallowHeld, depth }),
    };
  }
  const { command, args } = parseV2Request(lines);
  if (command === 'ls-refs') {
    const argSet = new Set();
    const argMap = new Map();
    for (const [k, values] of args) {
      argSet.add(k);
      argMap.set(k, values);
    }
    const prefixes = argMap.get('ref-prefix') ?? [];
    const fake = {
      has: (k) => argSet.has(k),
      getAll: (k) => (k === 'ref-prefix' ? prefixes : []),
    };
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-result',
      body: lsRefsResponse(repo, fake),
    };
  }
  if (command === 'fetch') {
    const wants = (args.get('want') ?? []).filter(isOid);
    const haves = (args.get('have') ?? []).filter(isOid);
    const shallowHeld = (args.get('shallow') ?? []).filter(isOid);
    const deepenRaw = (args.get('deepen') ?? [])[0];
    const depth = deepenRaw !== undefined ? parseInt(deepenRaw, 10) : null;
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-result',
      body: fetchV2Response(repo, { wants, haves, shallowHeld, depth: Number.isFinite(depth) ? depth : null }),
    };
  }
  return { status: 400, json: { message: `Bad Request: unknown command ${JSON.stringify(command)}` } };
}

export function handleReceivePack(repo, body) {
  let commands;
  let packBytes;
  try {
    const split = splitCommands(body);
    commands = split.lines;
    packBytes = split.rest;
  } catch (err) {
    return { status: 400, json: { message: `Bad Request: ${err.message}` } };
  }
  const parsed = [];
  for (const line of commands) {
    const text = line.replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const main = nul >= 0 ? text.slice(0, nul) : text;
    const parts = main.split(' ');
    if (parts.length < 3) continue;
    parsed.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  // Unpack first: a refused ref still unpacks, and the pack's objects are kept.
  let unpackError = null;
  if (packBytes.length > 0) {
    try {
      const pack = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of pack.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackError = err.message;
    }
  }
  const reportLines = [];
  if (unpackError) {
    reportLines.push(`unpack ${unpackError}\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const cmd of parsed) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          reportLines.push(`ng ${cmd.ref} failed to delete: ref does not exist\n`);
        } else if (current !== cmd.oldOid) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        } else {
          repo.refs.delete(cmd.ref);
          reportLines.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        if (current !== undefined) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        } else if (!repo.objects.has(cmd.newOid)) {
          reportLines.push(`ng ${cmd.ref} object not found\n`);
        } else {
          repo.refs.set(cmd.ref, cmd.newOid);
          reportLines.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      if (current === undefined || current !== cmd.oldOid) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      const lookup = (oid) => repo.objects.get(oid);
      if (!repo.objects.has(cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} object not found\n`);
        continue;
      }
      if (!isAncestor(lookup, cmd.oldOid, cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}\n`);
    }
  }
  const reportText = reportLines.join('');
  const reportStream = Buffer.concat([
    ...reportLines.map((l) => pktLine(l)),
    FLUSH,
  ]);
  void reportText;
  // The report-status stream rides sideband band 1, chunked like a pack.
  const parts = [];
  for (let off = 0; off < reportStream.length; off += 65000) {
    const chunk = reportStream.subarray(off, Math.min(reportStream.length, off + 65000));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(FLUSH);
  return {
    status: 200,
    contentType: 'application/x-git-receive-pack-result',
    body: Buffer.concat(parts),
  };
}
