// rest.ts — GitHub REST v3: repositories, branches, commits, contents,
// issues, comments, labels, pull requests. Every reply is JSON and carries
// X-GitHub-Request-Id; errors carry a string message.

import {
  VIEWER,
  commitHistory,
  createCommit,
  decodeGlobalId,
  flattenTree,
  globalId,
  hashObject,
  isoOfEpoch,
  nextLogicalEpoch,
  parseCommit,
  parseTree,
  resolveRef,
  treeDeletePath,
  treeLookup,
  treeSetPath,
  type Forge,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
} from './store.ts';

export interface RestContext {
  forge: Forge;
  /** Absolute base URL of this request (for Link headers). */
  baseUrl: string;
}

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function ok(body: unknown, status = 200, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

export function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

/** Split a path into its '/'-separated, decoded segments. */
export function segments(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '').map((segment) => decodeURIComponent(segment));
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    id: repo.id,
    node_id: globalId('Repository', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: {
      login: repo.owner,
      id: VIEWER.id,
      node_id: globalId('User', repo.owner),
      type: 'User',
      avatar_url: '',
      html_url: '',
    },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoOfEpoch(repo.createdEpoch),
    updated_at: isoOfEpoch(repo.createdEpoch),
    pushed_at: defaultTip === undefined ? null : isoOfEpoch(repo.createdEpoch),
    html_url: '',
    clone_url: '',
    git_url: '',
    ssh_url: '',
    homepage: null,
    language: null,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color, description: label.description })),
    user: { login: issue.userLogin, id: VIEWER.id, type: 'User' },
    assignees: [],
    created_at: isoOfEpoch(issue.createdEpoch),
    updated_at: isoOfEpoch(issue.updatedEpoch),
    closed_at: issue.state === 'closed' ? isoOfEpoch(issue.updatedEpoch) : null,
    html_url: '',
    comments: issue.comments.length,
    repository_url: '',
  };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: repoMergeable(repo, pull),
    mergeable_state: repoMergeable(repo, pull) ? 'clean' : 'dirty',
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: { login: repo.owner, id: VIEWER.id, type: 'User' },
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: { login: repo.owner, id: VIEWER.id, type: 'User' },
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    user: { login: pull.userLogin, id: VIEWER.id, type: 'User' },
    created_at: isoOfEpoch(pull.createdEpoch),
    updated_at: isoOfEpoch(pull.updatedEpoch),
    closed_at: pull.state === 'closed' ? isoOfEpoch(pull.updatedEpoch) : null,
    html_url: '',
    draft: false,
    commits: 1,
    additions: pull.files.reduce((sum, file) => sum + file.additions, 0),
    deletions: pull.files.reduce((sum, file) => sum + file.deletions, 0),
    changed_files: pull.files.length,
  };
}

export function repoMergeable(repo: Repo, pull: PullRequest): boolean {
  if (pull.merged) return false;
  return repoMergeableUncached(repo, pull);
}

function repoMergeableUncached(repo: Repo, pull: PullRequest): boolean {
  // Imported lazily to keep this module's top-level imports flat.
  return pullMergeableImpl(repo, pull);
}

// The mergeability predicate lives in store.ts's Forge; re-exported here for
// the JSON builders above.
import { Forge as ForgeClass } from './store.ts';
const mergeProbe = new ForgeClass();
function pullMergeableImpl(repo: Repo, pull: PullRequest): boolean {
  return mergeProbe.pullMergeable(repo, pull);
}

export function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

/** Parse page/per_page query params (GitHub defaults: page 1, per_page 30). */
export function pagination(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

/** Slice a list into one page and build the GitHub Link header. */
export function paginate<T>(items: readonly T[], page: number, perPage: number, baseUrl: string, path: string, query: URLSearchParams): { pageItems: T[]; link: string | null } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  if (totalPages <= 1) return { pageItems, link: null };
  const urlFor = (p: number): string => {
    const next = new URLSearchParams(query);
    next.set('page', String(p));
    next.set('per_page', String(perPage));
    return `${baseUrl}${path}?${next.toString()}`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  parts.push(`<${urlFor(1)}>; rel="first"`);
  parts.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { pageItems, link: parts.join(', ') };
}

/** Look a repository up by owner/name, 404 unless the owner is the viewer. */
export function findRepo(ctx: RestContext, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return ctx.forge.getRepo(owner, name) ?? null;
}

export function notFound(message = 'Not Found'): RestResult {
  return err(404, message);
}

/** Resolve a branch (or the default) to its tip commit oid. */
export function branchTip(repo: Repo, branch: string | undefined): string | null {
  const name = branch ?? repo.defaultBranch;
  return repo.refs.get(`refs/heads/${name}`) ?? null;
}

// ---------------------------------------------------------------------------
// Route handlers. `body` is the parsed JSON request body (or null).
// ---------------------------------------------------------------------------

type Body = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** One contents write: create or update a file on a branch. */
function putContents(ctx: RestContext, repo: Repo, filePath: string, body: Body): RestResult {
  const message = asString(body.message) || 'Update file';
  const contentB64 = asString(body.content);
  if (contentB64 === '') return err(422, 'content is required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    return err(422, 'content is not valid base64');
  }
  const branch = asString(body.branch) || repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  let tip = repo.refs.get(refName);
  let baseTree: string | null = null;
  if (tip !== undefined) {
    const commit = repo.objects.get(tip);
    if (commit?.type === 'commit') baseTree = parseCommit(commit.data).tree;
  }
  const existing = baseTree === null ? null : treeLookup(repo, baseTree, filePath);
  const givenSha = asString(body.sha);
  if (existing !== null) {
    // Update: the caller must name the blob it replaces.
    if (givenSha === '' || givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
      return err(409, 'the file has changed since the sha given');
    }
  }
  const blobOid = hashObject('blob', content);
  if (!repo.objects.has(blobOid)) repo.objects.set(blobOid, { type: 'blob', data: content });
  const newTree = treeSetPath(repo, baseTree, filePath, blobOid);
  const parents = tip === undefined ? [] : [tip];
  const { oid } = createCommit(repo, { tree: newTree, parents, message });
  repo.refs.set(refName, oid);
  const status = existing === null ? 201 : 200;
  return ok(
    {
      content: {
        name: filePath.split('/').pop(),
        path: filePath,
        sha: blobOid,
        size: content.length,
        type: 'file',
        encoding: 'base64',
        content: content.toString('base64'),
      },
      commit: { sha: oid, message },
    },
    status,
  );
}

function getContents(ctx: RestContext, repo: Repo, filePath: string, query: URLSearchParams): RestResult {
  const ref = query.get('ref') ?? undefined;
  const tip = ref === undefined ? branchTip(repo, undefined) : resolveRef(repo, ref);
  if (tip === null) return notFound('Not Found');
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return notFound('Not Found');
  const treeOid = parseCommit(commit.data).tree;
  if (filePath === '') {
    // Root listing.
    const entries = flattenTree(repo, treeOid);
    const top = new Map<string, { oid: string; mode: string; isDir: boolean }>();
    for (const [path, entry] of entries) {
      const slash = path.indexOf('/');
      if (slash < 0) top.set(path, { oid: entry.oid, mode: entry.mode, isDir: false });
      else top.set(path.slice(0, slash), { oid: '', mode: '40000', isDir: true });
    }
    const list = [...top.entries()].map(([name, entry]) => ({
      type: entry.isDir ? 'dir' : 'file',
      name,
      path: name,
      sha: entry.isDir ? treeOid : entry.oid,
      size: 0,
    }));
    return ok(list);
  }
  const found = treeLookup(repo, treeOid, filePath);
  if (found === null) {
    // Maybe a directory: walk the tree to it.
    const segments = filePath.split('/').filter((segment) => segment !== '');
    let current = treeOid;
    let dir: string | null = null;
    for (const segment of segments) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return notFound('Not Found');
      const entry = ((): { mode: string; oid: string } | undefined => {
        const list = ((): unknown => {
          try {
            return parseTree(object.data);
          } catch {
            return [];
          }
        })() as { mode: string; name: string; oid: string }[];
        return list.find((candidate) => candidate.name === segment);
      })();
      if (!entry) return notFound('Not Found');
      if (entry.mode === '40000') {
        current = entry.oid;
        dir = current;
      } else {
        return notFound('Not Found');
      }
    }
    if (dir === null) return notFound('Not Found');
    const object = repo.objects.get(dir);
    if (!object) return notFound('Not Found');
    const list = parseTree(object.data).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: `${filePath}/${entry.name}`,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    }));
    return ok(list);
  }
  if (found.mode === '40000') {
    // A directory path lists its entries.
    const dirObject = repo.objects.get(found.oid);
    if (!dirObject || dirObject.type !== 'tree') return notFound('Not Found');
    const list = parseTree(dirObject.data).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: `${filePath}/${entry.name}`,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    }));
    return ok(list);
  }
  const blob = repo.objects.get(found.oid);
  if (!blob) return notFound('Not Found');
  return ok({
    type: 'file',
    name: filePath.split('/').pop(),
    path: filePath,
    sha: found.oid,
    size: blob.data.length,
    encoding: 'base64',
    content: blob.data.toString('base64'),
  });
}

function deleteContents(ctx: RestContext, repo: Repo, filePath: string, body: Body | null): RestResult {
  const branch = asString(body?.branch) || repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  if (tip === undefined) return notFound('Not Found');
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return notFound('Not Found');
  const treeOid = parseCommit(commit.data).tree;
  const existing = treeLookup(repo, treeOid, filePath);
  if (existing === null) return notFound('Not Found');
  const givenSha = asString(body?.sha);
  if (givenSha !== '' && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
    return err(409, 'the file has changed since the sha given');
  }
  const newTree = treeDeletePath(repo, treeOid, filePath);
  const message = asString(body?.message) || 'Delete file';
  const { oid } = createCommit(repo, { tree: newTree, parents: [tip], message });
  repo.refs.set(refName, oid);
  return ok({ commit: { sha: oid, message } });
}

function listIssues(ctx: RestContext, repo: Repo, query: URLSearchParams): RestResult {
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  let list = repo.issues.slice();
  if (state === 'open') list = list.filter((issue) => issue.state === 'open');
  else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
  list.sort((a, b) => {
    const keyA = sort === 'created' ? a.createdEpoch : a.updatedEpoch;
    const keyB = sort === 'created' ? b.createdEpoch : b.updatedEpoch;
    if (keyA !== keyB) return direction === 'asc' ? keyA - keyB : keyB - keyA;
    return direction === 'asc' ? a.number - b.number : b.number - a.number;
  });
  const { page, perPage } = pagination(query);
  const { pageItems, link } = paginate(list, page, perPage, ctx.baseUrl, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, query);
  return ok(
    pageItems.map((issue) => issueJson(repo, issue)),
    200,
    link === null ? undefined : { link },
  );
}

function listPulls(ctx: RestContext, repo: Repo, query: URLSearchParams): RestResult {
  const state = query.get('state') ?? 'open';
  let list = repo.pulls.slice();
  if (state === 'open') list = list.filter((pull) => pull.state === 'open');
  else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
  list.sort((a, b) => b.number - a.number);
  const { page, perPage } = pagination(query);
  const { pageItems, link } = paginate(list, page, perPage, ctx.baseUrl, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, query);
  return ok(
    pageItems.map((pull) => pullJson(repo, pull)),
    200,
    link === null ? undefined : { link },
  );
}

/** The main REST dispatcher. Returns null when the path is not a REST route. */
export function handleRest(method: string, path: string, query: URLSearchParams, body: Body | null, ctx: RestContext): RestResult | null {
  const parts = segments(path);
  if (parts.length < 2 || parts[0] !== 'api' || parts[1] !== 'v3') return null;

  const rest = parts.slice(2);

  // GET /api/v3/
  if (rest.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(
      { current_user_url: `${ctx.baseUrl}/api/v3/user`, rate_limit_url: `${ctx.baseUrl}/api/v3/rate_limit` },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: globalId('User', VIEWER.login),
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
      avatar_url: '',
      html_url: '',
    });
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const repos = ctx.forge.viewerRepos();
      const { page, perPage } = pagination(query);
      const { pageItems, link } = paginate(repos, page, perPage, ctx.baseUrl, '/api/v3/user/repos', query);
      return ok(
        pageItems.map((repo) => repoJson(repo)),
        200,
        link === null ? undefined : { link },
      );
    }
    if (method === 'POST') {
      const name = asString(body?.name);
      if (name === '') return err(422, 'name is required');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return err(422, 'name is not valid');
      if (ctx.forge.getRepo(VIEWER.login, name) !== undefined) {
        return err(422, `Repository ${VIEWER.login}/${name} already exists`);
      }
      const repo = ctx.forge.createRepo(name, {
        private: asBool(body?.private, false),
        description: asString(body?.description),
      });
      return ok(repoJson(repo), 201);
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1] as string;
    const name = rest[2] as string;
    const repo = findRepo(ctx, owner, name);
    if (repo === null) return notFound('Not Found');
    const tail = rest.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') return ok(repoJson(repo));
      if (method === 'PATCH') {
        if (body !== null && typeof body.description === 'string') repo.description = body.description;
        if (body !== null && typeof body.private === 'boolean') repo.private = body.private;
        return ok(repoJson(repo));
      }
      if (method === 'DELETE') {
        ctx.forge.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }

    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .sort()
          .map((ref) => ({
            name: ref.slice('refs/heads/'.length),
            commit: { sha: repo.refs.get(ref) as string },
            protected: false,
          }));
        return ok(branches);
      }
      if (tail.length === 2 && method === 'GET') {
        const branch = tail[1] as string;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) return notFound('Not Found');
        return ok({ name: branch, commit: { sha: tip }, protected: false });
      }
      return err(404, 'Not Found');
    }

    if (tail[0] === 'commits' && method === 'GET') {
      const ref = query.get('sha') ?? repo.defaultBranch;
      const tip = resolveRef(repo, ref);
      if (tip === null) return ok([]);
      const history = commitHistory(repo, tip, 100);
      const { page, perPage } = pagination(query);
      const { pageItems } = paginate(history, page, perPage, ctx.baseUrl, path, query);
      return ok(
        pageItems.map((commit) => {
          const sha = (commit as unknown as { sha: string }).sha;
          return {
            sha,
            commit: {
              // GitHub's API returns the message without its trailing newline.
              message: commit.message.replace(/\n$/, ''),
              author: { name: VIEWER.name, email: VIEWER.email },
              committer: { name: VIEWER.name, email: VIEWER.email },
            },
            author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
            committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
            parents: commit.parents.map((parent) => ({ sha: parent })),
          };
        }),
      );
    }

    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = asString(body?.ref);
        const sha = asString(body?.sha);
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha)) return err(422, 'ref and sha are required');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
        repo.refs.set(ref, sha.toLowerCase());
        return ok({ ref, object: { sha: sha.toLowerCase(), type: 'commit' } }, 201);
      }
      if (method === 'GET' && tail.length === 4 && tail[2] === 'heads') {
        const branch = tail[3] as string;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) return notFound('Not Found');
        return ok({ ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } });
      }
      return err(404, 'Not Found');
    }

    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (method === 'PUT') return putContents(ctx, repo, filePath, body ?? {});
      if (method === 'GET') return getContents(ctx, repo, filePath, query);
      if (method === 'DELETE') return deleteContents(ctx, repo, filePath, body);
      return err(404, 'Not Found');
    }

    if (tail[0] === 'labels') {
      if (method === 'GET') return ok([...repo.labels.values()].map((label) => labelJson(label)));
      if (method === 'POST' && tail.length === 1) {
        const labelName = asString(body?.name);
        if (labelName === '') return err(422, 'name is required');
        const existing = repo.labels.get(labelName);
        if (existing) return ok(labelJson(existing), 200);
        const label: Label = {
          name: labelName,
          color: asString(body?.color) || 'ededed',
          description: asString(body?.description),
        };
        repo.labels.set(labelName, label);
        return ok(labelJson(label), 201);
      }
      return err(404, 'Not Found');
    }

    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') return listIssues(ctx, repo, query);
        if (method === 'POST') {
          const title = asString(body?.title);
          const issueBody = asString(body?.body);
          if (title === '') return err(422, 'title is required');
          const wantedLabels = Array.isArray(body?.labels) ? (body?.labels as unknown[]) : [];
          const labels: Label[] = [];
          for (const wanted of wantedLabels) {
            const labelName = typeof wanted === 'string' ? wanted : asString((wanted as Body)?.name);
            const label = repo.labels.get(labelName);
            if (!label) return err(422, `Label '${labelName}' does not exist`);
            labels.push(label);
          }
          const issue = ctx.forge.createIssue(repo, title, issueBody, labels);
          return ok(issueJson(repo, issue), 201);
        }
        return err(404, 'Not Found');
      }
      const number = Number.parseInt(tail[1] as string, 10);
      if (!Number.isInteger(number)) return notFound('Not Found');
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (issue === undefined) return notFound('Not Found');
      if (tail.length === 2) {
        if (method === 'GET') return ok(issueJson(repo, issue));
        if (method === 'PATCH') {
          if (body !== null && typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
            issue.state = body.state;
          }
          if (body !== null && typeof body.title === 'string') issue.title = body.title;
          if (body !== null && typeof body.body === 'string') issue.body = body.body;
          issue.updatedEpoch = nextLogicalEpoch();
          return ok(issueJson(repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (method === 'GET') {
          return ok(
            issue.comments.map((comment) => ({
              id: comment.id,
              node_id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}/${comment.id}`),
              body: comment.body,
              user: { login: comment.userLogin, id: VIEWER.id, type: 'User' },
              created_at: isoOfEpoch(comment.createdEpoch),
              updated_at: isoOfEpoch(comment.createdEpoch),
            })),
          );
        }
        if (method === 'POST') {
          const commentBody = asString(body?.body);
          if (commentBody === '') return err(422, 'body is required');
          const comment = ctx.forge.createComment(repo, issue, commentBody);
          return ok(
            {
              id: comment.id,
              node_id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}/${comment.id}`),
              body: comment.body,
              user: { login: comment.userLogin, id: VIEWER.id, type: 'User' },
              created_at: isoOfEpoch(comment.createdEpoch),
              updated_at: isoOfEpoch(comment.createdEpoch),
            },
            201,
          );
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') return listPulls(ctx, repo, query);
        if (method === 'POST') {
          const title = asString(body?.title);
          const pullBody = asString(body?.body);
          const head = asString(body?.head);
          const base = asString(body?.base) || repo.defaultBranch;
          if (title === '' || head === '') return err(422, 'title and head are required');
          const headTip = resolveRef(repo, head);
          const baseTip = resolveRef(repo, base);
          if (headTip === null) return err(422, `head ref '${head}' does not exist`);
          if (baseTip === null) return err(422, `base ref '${base}' does not exist`);
          const existing = repo.pulls.find((pull) => pull.headRef === head && pull.baseRef === base && pull.state === 'open');
          if (existing) return err(422, 'A pull request already exists for this head branch');
          const pull = ctx.forge.createPull(repo, { title, body: pullBody, headRef: head, baseRef: base, headSha: headTip, baseSha: baseTip });
          return ok(pullJson(repo, pull), 201);
        }
        return err(404, 'Not Found');
      }
      const number = Number.parseInt(tail[1] as string, 10);
      if (!Number.isInteger(number)) return notFound('Not Found');
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) return notFound('Not Found');
      if (tail.length === 2) {
        if (method === 'GET') return ok(pullJson(repo, pull));
        return err(404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        return ok(
          pull.files.map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
          })),
        );
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (pull.state !== 'open' || pull.merged) return err(404, 'Not Found');
        const merged = ctx.forge.mergePull(repo, pull);
        if (merged === null) return err(405, 'Merge conflict: the pull request cannot be merged');
        return ok({ sha: merged, merged: true, message: `Pull request #${pull.number} successfully merged` });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
