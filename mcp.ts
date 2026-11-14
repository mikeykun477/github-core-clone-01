// MCP over Streamable HTTP at POST /mcp: JSON-RPC 2.0, plain application/json
// answers, protocol revision 2026-07-28 (server/discover) with a legacy
// initialize fallback. Tools share the same store as REST and GraphQL.

import {
  VIEWER_LOGIN,
  repoGlobalId,
  issueGlobalId,
  pullGlobalId,
} from './store.ts';

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

// ------------------------------------------------------------------ tools

const TOOL_DEFS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ------------------------------------------------------------------ tool bodies

function repoJson(repo) {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo.owner, repo.name),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(repo, issue) {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    user: { login: issue.user },
  };
}

function pullJson(repo, pr) {
  return {
    id: pr.id,
    node_id: pullGlobalId(repo.owner, repo.name, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.head.ref, sha: repo.refTip(pr.head.ref) ?? pr.headShaAtCreation },
    base: { ref: pr.base.ref, sha: repo.refTip(pr.base.ref) ?? pr.baseShaAtCreation },
  };
}

function missingRequired(args, required) {
  return required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
}

/** Execute one tool call. Returns {ok, result} or {ok:false, error}. */
export function callTool(ctx, name, args) {
  const { store } = ctx;
  const lower = String(name ?? '').toLowerCase();
  const def = TOOL_DEFS.find((t) => t.name === lower || lower.endsWith(`_${t.name}`) || lower.endsWith(t.name));
  if (!def) return { ok: false, code: -32602, message: `Unknown tool: ${name}` };
  const missing = missingRequired(args, def.inputSchema.required);
  if (missing.length) {
    return { ok: false, isError: true, error: `Missing required argument(s): ${missing.join(', ')}` };
  }
  switch (def.name) {
    case 'create_repo': {
      if (store.getRepo(VIEWER_LOGIN, args.name)) {
        return { ok: false, isError: true, error: `Repository ${args.name} already exists` };
      }
      const repo = store.createRepo(VIEWER_LOGIN, args.name, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      return { ok: true, result: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = store.getRepo(args.owner, args.repo);
      if (!repo) return { ok: false, isError: true, error: `Repository ${args.owner}/${args.repo} not found` };
      return { ok: true, result: repoJson(repo) };
    }
    case 'create_issue': {
      const repo = store.getRepo(args.owner, args.repo);
      if (!repo) return { ok: false, isError: true, error: `Repository ${args.owner}/${args.repo} not found` };
      const issue = store.createIssue(repo, { title: args.title, body: typeof args.body === 'string' ? args.body : '' });
      return { ok: true, result: issueJson(repo, issue) };
    }
    case 'list_issues': {
      const repo = store.getRepo(args.owner, args.repo);
      if (!repo) return { ok: false, isError: true, error: `Repository ${args.owner}/${args.repo} not found` };
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      return { ok: true, result: { issues: issues.map((i) => issueJson(repo, i)), total_count: issues.length } };
    }
    case 'create_pull_request': {
      const repo = store.getRepo(args.owner, args.repo);
      if (!repo) return { ok: false, isError: true, error: `Repository ${args.owner}/${args.repo} not found` };
      if (!repo.refs.has(`refs/heads/${args.head}`)) {
        return { ok: false, isError: true, error: `Head branch "${args.head}" does not exist` };
      }
      if (!repo.refs.has(`refs/heads/${args.base}`)) {
        return { ok: false, isError: true, error: `Base branch "${args.base}" does not exist` };
      }
      const pr = store.createPull(repo, {
        title: args.title,
        body: typeof args.body === 'string' ? args.body : '',
        head: args.head,
        base: args.base,
      });
      return { ok: true, result: pullJson(repo, pr) };
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(args.owner, args.repo);
      if (!repo) return { ok: false, isError: true, error: `Repository ${args.owner}/${args.repo} not found` };
      const pr = repo.pulls.get(Number(args.pull_number));
      if (!pr) return { ok: false, isError: true, error: `Pull request #${args.pull_number} not found` };
      const result = repo.mergePull(pr, 'squash');
      if (!result.ok) return { ok: false, isError: true, error: result.message };
      return { ok: true, result: { ...pullJson(repo, pr), sha: result.sha } };
    }
    default:
      return { ok: false, code: -32602, message: `Unknown tool: ${name}` };
  }
}

// ------------------------------------------------------------------ JSON-RPC

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Handle one JSON-RPC request object. Returns {status, json} (json null means
 * an empty 202, for notifications).
 */
export function handleMcp(ctx, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { status: 400, json: rpcError(null, -32600, 'Invalid Request') };
  }
  const { method, params, id } = request;
  const isNotification = id === undefined || id === null;
  if (typeof method !== 'string') {
    return { status: 400, json: rpcError(id ?? null, -32600, 'Invalid Request') };
  }

  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        json: rpcResult(id, {
          supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
        }),
      };
    case 'initialize':
      return {
        status: 200,
        json: rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      };
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { status: 202, json: null };
    case 'tools/list':
      // Byte-identical across calls: a fixed literal list.
      return { status: 200, json: rpcResult(id, { tools: TOOL_DEFS }) };
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const outcome = callTool(ctx, name, args);
      if (outcome.ok) {
        return {
          status: 200,
          json: rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
            structuredContent: outcome.result,
            isError: false,
          }),
        };
      }
      if (outcome.code !== undefined) {
        return { status: 200, json: rpcError(id, outcome.code, outcome.message) };
      }
      return {
        status: 200,
        json: rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: outcome.error }) }],
          structuredContent: { error: outcome.error },
          isError: true,
        }),
      };
    }
    case 'ping':
      return { status: 200, json: rpcResult(id, {}) };
    default:
      return { status: 200, json: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}
