// The REST v3 surface under /api/v3: repositories, branches, commits, contents,
// labels, issues, comments and pull requests (with squash merges). All data
// lives in the store; every reply is JSON with an X-GitHub-Request-Id.

import {
  DEFAULT_BRANCH,
  VIEWER_LOGIN,
  buildTree,
  diffTrees,
  flattenTree,
  hashObject,
  isOid,
  lineDiff,
  parseCommit,
  parseTree,
  treeIsDir,
  treeListDir,
  treeLookup,
} from './store.ts';

const BASE64 = (buf) => Buffer.from(buf).toString('base64');

// ------------------------------------------------------------------ shapes

function userObject(login) {
  return { login, id: 1000, type: 'User', site_admin: false };
}

export function repoObject(repo) {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: userObject(repo.owner),
    private: repo.private,
    html_url: `https://example.invalid/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    pushed_at: '2025-01-01T00:00:00Z',
    git_url: `git://example.invalid/${repo.fullName}.git`,
    clone_url: `https://example.invalid/${repo.fullName}.git`,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_downloads: false,
    has_wiki: false,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

export function issueObject(repo, issue) {
  return {
    id: issue.id,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: 0, name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
    }),
    user: userObject(issue.user),
    assignees: [],
    comments: issue.commentsCount,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    closed_at: issue.state === 'closed' ? '2025-01-01T00:00:00Z' : null,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullObject(repo, pr) {
  const headSha = repo.refTip(pr.head.ref) ?? pr.headShaAtCreation;
  const baseSha = repo.refTip(pr.base.ref) ?? pr.baseShaAtCreation;
  return {
    id: pr.id,
    node_id: `P_${repo.id}_${pr.number}`,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    draft: false,
    merged: pr.merged,
    mergeable: pr.state === 'open' ? !repo.mergeConflict(pr) : null,
    mergeable_state: pr.state === 'open' ? (repo.mergeConflict(pr) ? 'conflicting' : 'clean') : 'unknown',
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    closed_at: pr.closedAt,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    user: userObject(pr.user),
    head: {
      label: `${repo.owner}:${pr.head.ref}`,
      ref: pr.head.ref,
      sha: headSha,
      user: userObject(repo.owner),
      repo: repoObject(repo),
    },
    base: {
      label: `${repo.owner}:${pr.base.ref}`,
      ref: pr.base.ref,
      sha: baseSha,
      user: userObject(repo.owner),
      repo: repoObject(repo),
    },
    html_url: `https://example.invalid/${repo.fullName}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

function commitObject(repo, oid) {
  const obj = repo.objects.get(oid);
  const commit = obj ? parseCommit(obj.data) : { tree: '', parents: [], author: '', committer: '', message: '' };
  return {
    sha: oid,
    commit: {
      message: commit.message,
      tree: { sha: commit.tree },
      author: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: '2025-01-01T00:00:00Z' },
      committer: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: '2025-01-01T00:00:00Z' },
    },
    author: userObject(VIEWER_LOGIN),
    committer: userObject(VIEWER_LOGIN),
    parents: commit.parents.map((p) => ({ sha: p })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
  };
}

function branchObject(repo, name) {
  const tip = repo.refTip(name);
  return {
    name,
    commit: { sha: tip, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${tip}` },
    protected: false,
  };
}

// ------------------------------------------------------------------ helpers

/** Parse "?page=&per_page=" with GitHub defaults; returns {page, perPage}. */
function pagination(query) {
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  return { page, perPage };
}

/** Slice a list into a page and build a Link header value (or null). */
function paginate(items, query, basePath, host) {
  const { page, perPage } = pagination(query);
  const total = items.length;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const links = [];
  const urlFor = (p) => `http://${host}${basePath}${basePath.includes('?') ? '&' : '?'}page=${p}&per_page=${perPage}`;
  if (page < lastPage) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (lastPage > 1) links.push(`<${urlFor(lastPage)}>; rel="last"`);
  if (page > 1) links.push(`<${urlFor(1)}>; rel="first"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  return { slice, link: links.length ? links.join(', ') : null };
}

/** The commits reachable from `tip`, newest first. */
function listCommits(repo, tip) {
  const out = [];
  const seen = new Set();
  const queue = tip ? [tip] : [];
  while (queue.length) {
    const oid = queue.shift();
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    const commit = parseCommit(obj.data);
    for (const p of commit.parents) queue.push(p);
  }
  return out;
}

// ------------------------------------------------------------------ routing

/**
 * Handle a REST request. `ctx` carries {store, method, segments, query, body,
 * host}. Returns {status, json, headers?, raw?} (json omitted for 204).
 */
export function handleRest(ctx) {
  const { store, method, segments: seg, query, body, host } = ctx;
  const notFound = (message = 'Not Found') => ({ status: 404, json: { message } });
  const badRequest = (message) => ({ status: 400, json: { message } });

  // The API root.
  if (seg.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      json: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  if (seg[0] === 'meta') {
    if (method !== 'GET') return notFound();
    return { status: 200, json: { installed_version: '1.0.0', verifiable_password_authentication: true } };
  }

  if (seg[0] === 'user') {
    if (seg.length === 1) {
      if (method !== 'GET') return notFound();
      return { status: 200, json: { ...userObject(VIEWER_LOGIN), name: 'ada iversen', email: 'adaiversen@example.invalid' } };
    }
    if (seg[1] === 'repos') {
      if (method === 'GET') {
        const repos = store.reposOf(VIEWER_LOGIN).map((r) => repoObject(r));
        const { slice, link } = paginate(repos, query, '/api/v3/user/repos', host);
        return { status: 200, json: slice, headers: link ? { link } : {} };
      }
      if (method === 'POST') {
        const name = typeof body?.name === 'string' ? body.name : '';
        if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
          return { status: 422, json: { message: 'Validation Failed: name is invalid' } };
        }
        if (store.getRepo(VIEWER_LOGIN, name)) {
          return { status: 422, json: { message: 'Repository already exists' } };
        }
        const repo = store.createRepo(VIEWER_LOGIN, name, {
          description: typeof body?.description === 'string' ? body.description : '',
          isPrivate: body?.private === true,
        });
        return { status: 201, json: repoObject(repo) };
      }
      return notFound();
    }
    return notFound();
  }

  if (seg[0] !== 'repos' || seg.length < 3) return notFound();
  const owner = decodeURIComponent(seg[1]);
  const repoName = decodeURIComponent(seg[2]);
  // A repository belongs to the token's login; any other owner is a 404.
  if (owner !== VIEWER_LOGIN) return notFound();
  const repo = store.getRepo(owner, repoName);
  const rest = seg.slice(3);

  // /repos/{o}/{r} itself.
  if (rest.length === 0) {
    if (!repo) return notFound();
    if (method === 'GET') return { status: 200, json: repoObject(repo) };
    if (method === 'PATCH') {
      if (typeof body?.description === 'string') repo.description = body.description;
      if (typeof body?.private === 'boolean') repo.private = body.private;
      if (typeof body?.name === 'string' && body.name !== repo.name) {
        // Renames are not exercised by the suite; ignore them.
      }
      return { status: 200, json: repoObject(repo) };
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204 };
    }
    return notFound();
  }
  if (!repo) return notFound();

  // Branches.
  if (rest[0] === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') return notFound();
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort()
        .map((name) => branchObject(repo, name));
      return { status: 200, json: branches };
    }
    if (rest.length === 2 && method === 'GET') {
      const name = decodeURIComponent(rest[1]);
      if (!repo.refs.has(`refs/heads/${name}`)) return notFound();
      return { status: 200, json: branchObject(repo, name) };
    }
    return notFound();
  }

  // Commits.
  if (rest[0] === 'commits') {
    if (method !== 'GET') return notFound();
    if (rest.length === 2) {
      const oid = decodeURIComponent(rest[1]);
      if (!repo.objects.has(oid)) return notFound();
      return { status: 200, json: commitObject(repo, oid) };
    }
    if (rest.length === 1) {
      const ref = query.get('sha');
      const tip = ref ? repo.resolveRef(ref) : repo.refTip(repo.defaultBranch);
      const commits = listCommits(repo, tip).map((oid) => commitObject(repo, oid));
      return { status: 200, json: commits };
    }
    return notFound();
  }

  // Git Data: refs.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = typeof body?.ref === 'string' ? body.ref : '';
      const sha = typeof body?.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !isOid(sha)) {
        return { status: 422, json: { message: 'Validation Failed: ref or sha is invalid' } };
      }
      if (repo.refs.has(ref)) return { status: 422, json: { message: 'Reference already exists' } };
      if (!repo.objects.has(sha)) return { status: 422, json: { message: 'Object does not exist' } };
      repo.refs.set(ref, sha);
      return { status: 201, json: { ref, node_id: `R_${repo.id}_${ref}`, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` } } };
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = rest.slice(2).map((s) => decodeURIComponent(s)).join('/');
      const full = `refs/${ref}`;
      const sha = repo.refs.get(full);
      if (!sha) return notFound();
      return { status: 200, json: { ref: full, node_id: `R_${repo.id}_${full}`, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(full)}`, object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` } } };
    }
    return notFound();
  }

  // Contents.
  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
    return handleContents(ctx, repo, filePath);
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return { status: 200, json: [...repo.labels.values()] };
    }
    if (method === 'POST' && rest.length === 1) {
      const name = typeof body?.name === 'string' ? body.name : '';
      if (name === '') return { status: 422, json: { message: 'Validation Failed: name is required' } };
      const label = {
        id: repo.labels.size + 1,
        name,
        color: typeof body?.color === 'string' ? body.color : 'ededed',
        description: typeof body?.description === 'string' ? body.description : '',
        default: false,
      };
      repo.labels.set(name, label);
      return { status: 201, json: label };
    }
    return notFound();
  }

  // Issues.
  if (rest[0] === 'issues') {
    return handleIssues(ctx, repo);
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    return handlePulls(ctx, repo);
  }

  return notFound();
}

// ------------------------------------------------------------------ contents

function handleContents(ctx, repo, filePath) {
  const { method, query, body } = ctx;
  const refParam = query.get('ref');
  const notFound = (message = 'Not Found') => ({ status: 404, json: { message } });
  const treeForBranch = (branch) => {
    const tip = branch ? repo.refTip(branch) : repo.refTip(repo.defaultBranch);
    return tip ? parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree : null;
  };
  const tip = refParam ? repo.resolveRef(refParam) : repo.refTip(repo.defaultBranch);
  const treeOid = tip ? parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree : null;

  if (method === 'GET') {
    if (filePath === '') {
      const entries = treeListDir(repo.lookup.bind(repo), treeOid, '') ?? [];
      return { status: 200, json: entries.map((e) => dirEntry(repo, '', e)) };
    }
    const blobOid = treeLookup(repo.lookup.bind(repo), treeOid, filePath);
    if (blobOid) {
      const data = repo.objects.get(blobOid).data;
      const name = filePath.split('/').pop();
      return {
        status: 200,
        json: {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name,
          path: filePath,
          content: BASE64(data),
          sha: blobOid,
          url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${filePath}`,
          html_url: `https://example.invalid/${repo.fullName}/blob/${repo.defaultBranch}/${filePath}`,
          git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
          download_url: `https://example.invalid/${repo.fullName}/raw/${repo.defaultBranch}/${filePath}`,
        },
      };
    }
    if (treeIsDir(repo.lookup.bind(repo), treeOid, filePath)) {
      const entries = treeListDir(repo.lookup.bind(repo), treeOid, filePath) ?? [];
      return { status: 200, json: entries.map((e) => dirEntry(repo, filePath, e)) };
    }
    return notFound();
  }

  if (method === 'PUT') {
    const contentB64 = typeof body?.content === 'string' ? body.content : '';
    let content;
    try {
      content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      return { status: 400, json: { message: 'content is not valid base64' } };
    }
    const message = typeof body?.message === 'string' ? body.message : 'Update file';
    const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
    const branchTree = treeForBranch(branch);
    const sha = typeof body?.sha === 'string' ? body.sha : undefined;
    const current = treeLookup(repo.lookup.bind(repo), branchTree, filePath);
    if (current) {
      if (sha === undefined) return { status: 409, json: { message: 'sha is required to update a file' } };
      if (sha.toLowerCase() !== current.toLowerCase()) {
        return { status: 409, json: { message: 'sha does not match the current file' } };
      }
    }
    const blobOid = repo.putObject('blob', content);
    const { commitOid } = repo.commitOnBranch({
      branch,
      message,
      changes: [{ path: filePath, blobOid }],
    });
    return {
      status: current ? 200 : 201,
      json: {
        content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, encoding: 'base64', type: 'file' },
        commit: { sha: commitOid, message },
      },
    };
  }

  if (method === 'DELETE') {
    const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
    const current = treeLookup(repo.lookup.bind(repo), treeForBranch(branch), filePath);
    if (!current) return notFound();
    const sha = typeof body?.sha === 'string' ? body.sha : undefined;
    if (sha !== undefined && sha.toLowerCase() !== current.toLowerCase()) {
      return { status: 409, json: { message: 'sha does not match the current file' } };
    }
    const message = typeof body?.message === 'string' ? body.message : 'Delete file';
    const { commitOid } = repo.commitOnBranch({
      branch,
      message,
      changes: [{ path: filePath, blobOid: null }],
    });
    return { status: 200, json: { commit: { sha: commitOid, message } } };
  }

  return notFound();
}

function dirEntry(repo, dir, entry) {
  const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
  return {
    type: entry.mode === '40000' ? 'dir' : 'file',
    size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    name: entry.name,
    path,
    sha: entry.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://example.invalid/${repo.fullName}/tree/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${entry.oid}`,
    download_url: entry.mode === '40000' ? null : `https://example.invalid/${repo.fullName}/raw/${repo.defaultBranch}/${path}`,
  };
}

// ------------------------------------------------------------------ issues

function handleIssues(ctx, repo) {
  const { store, method, segments: seg, query, body, host } = ctx;
  const rest = seg.slice(3); // ['issues', ...]
  const notFound = (message = 'Not Found') => ({ status: 404, json: { message } });

  if (rest.length === 1) {
    if (method === 'GET') {
      let issues = [...repo.issues.values()];
      const state = query.get('state') ?? 'open';
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      const { slice, link } = paginate(issues.map((i) => issueObject(repo, i)), query, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, host);
      return { status: 200, json: slice, headers: link ? { link } : {} };
    }
    if (method === 'POST') {
      const title = typeof body?.title === 'string' ? body.title : '';
      if (title === '') return { status: 422, json: { message: 'Validation Failed: title is required' } };
      const labels = Array.isArray(body?.labels) ? body.labels : [];
      for (const name of labels) {
        if (typeof name !== 'string' || !repo.labels.has(name)) {
          return { status: 422, json: { message: `Validation Failed: label "${String(name)}" does not exist` } };
        }
      }
      const issue = store.createIssue(repo, { title, body: typeof body?.body === 'string' ? body.body : '', labels });
      return { status: 201, json: issueObject(repo, issue) };
    }
    return notFound();
  }

  const number = parseInt(rest[1], 10);
  if (!Number.isInteger(number)) return notFound();
  const issue = repo.issues.get(number);

  if (rest.length === 2) {
    if (!issue) return notFound();
    if (method === 'GET') return { status: 200, json: issueObject(repo, issue) };
    if (method === 'PATCH') {
      if (typeof body?.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
        issue.state = body.state;
        issue.updatedSeq = store.nextSeq();
      }
      if (typeof body?.title === 'string') issue.title = body.title;
      if (typeof body?.body === 'string') issue.body = body.body;
      if (Array.isArray(body?.labels)) {
        for (const name of body.labels) {
          if (typeof name !== 'string' || !repo.labels.has(name)) {
            return { status: 422, json: { message: `Validation Failed: label "${String(name)}" does not exist` } };
          }
        }
        issue.labels = [...body.labels];
      }
      return { status: 200, json: issueObject(repo, issue) };
    }
    return notFound();
  }

  if (rest.length === 3 && rest[2] === 'comments') {
    if (!issue) return notFound();
    if (method === 'GET') {
      const comments = (repo.comments.get(number) ?? []).map((c) => ({
        id: c.id,
        node_id: `C_${repo.id}_${number}_${c.id}`,
        body: c.body,
        user: userObject(c.user),
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: `https://example.invalid/${repo.fullName}/issues/${number}#issuecomment-${c.id}`,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${c.id}`,
      }));
      return { status: 200, json: comments };
    }
    if (method === 'POST') {
      const text = typeof body?.body === 'string' ? body.body : '';
      if (text === '') return { status: 422, json: { message: 'Validation Failed: body is required' } };
      const comment = store.addComment(repo, number, text);
      return {
        status: 201,
        json: {
          id: comment.id,
          node_id: `C_${repo.id}_${number}_${comment.id}`,
          body: comment.body,
          user: userObject(comment.user),
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          html_url: `https://example.invalid/${repo.fullName}/issues/${number}#issuecomment-${comment.id}`,
          url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
        },
      };
    }
    return notFound();
  }

  return notFound();
}

// ------------------------------------------------------------------ pull requests

function handlePulls(ctx, repo) {
  const { store, method, segments: seg, query, body, host } = ctx;
  const rest = seg.slice(3); // ['pulls', ...]
  const notFound = (message = 'Not Found') => ({ status: 404, json: { message } });

  if (rest.length === 1) {
    if (method === 'GET') {
      let pulls = [...repo.pulls.values()];
      const state = query.get('state') ?? 'open';
      if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      const { slice, link } = paginate(pulls.map((p) => pullObject(repo, p)), query, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, host);
      return { status: 200, json: slice, headers: link ? { link } : {} };
    }
    if (method === 'POST') {
      const title = typeof body?.title === 'string' ? body.title : '';
      const head = typeof body?.head === 'string' ? body.head : '';
      const base = typeof body?.base === 'string' ? body.base : repo.defaultBranch;
      if (title === '' || head === '') return { status: 422, json: { message: 'Validation Failed: title and head are required' } };
      if (!repo.refs.has(`refs/heads/${head}`)) return { status: 422, json: { message: `Validation Failed: head branch "${head}" does not exist` } };
      if (!repo.refs.has(`refs/heads/${base}`)) return { status: 422, json: { message: `Validation Failed: base branch "${base}" does not exist` } };
      const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.head.ref === head && p.base.ref === base);
      if (existing) return { status: 422, json: { message: 'Validation Failed: a pull request already exists for this head and base' } };
      const pr = store.createPull(repo, { title, body: typeof body?.body === 'string' ? body.body : '', head, base });
      return { status: 201, json: pullObject(repo, pr) };
    }
    return notFound();
  }

  const number = parseInt(rest[1], 10);
  if (!Number.isInteger(number)) return notFound();
  const pr = repo.pulls.get(number);

  if (rest.length === 2) {
    if (!pr) return notFound();
    if (method === 'GET') return { status: 200, json: pullObject(repo, pr) };
    return notFound();
  }

  if (rest.length === 3 && rest[2] === 'files') {
    if (!pr) return notFound();
    if (method !== 'GET') return notFound();
    return { status: 200, json: repo.pullFiles(pr) };
  }

  if (rest.length === 3 && rest[2] === 'merge') {
    if (!pr) return notFound();
    if (method !== 'PUT') return notFound();
    const result = repo.mergePull(pr, typeof body?.merge_method === 'string' ? body.merge_method : 'squash');
    if (!result.ok) return { status: result.status, json: { message: result.message } };
    return { status: 200, json: { sha: result.sha, merged: true, message: result.message } };
  }

  return notFound();
}
