// mcp.ts — Model Context Protocol over streamable HTTP (2026-07-28).
// Modern discovery via `server/discover`, legacy `initialize` handshake,
// tools/list + tools/call against the same Forge store as REST and GraphQL.
// Errors are JSON-RPC errors, never HTTP 500: unknown tool -32602, bad
// JSON -32700, missing arguments isError:true / -32602.

import { VIEWER, resolveRef, type Forge } from './store.ts';

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
}

const SERVER_INFO = {
  name: 'github-core-clone-01',
  version: '0.1.0',
  description: 'A GitHub-compatible git forge with repositories, issues, pull requests, GraphQL and git smart HTTP.',
};

const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function resultResponse(id: string | number | null | undefined, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

function errorResponse(id: string | number | null | undefined, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, { type: string; description: string }>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'The name of the repository to create.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The owner (login) of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string', description: 'The owner (login) of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the issue.' },
      body: { type: 'string', description: 'The body of the issue.' },
      labels: { type: 'array', description: 'Labels to apply to the issue.' },
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The owner (login) of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      state: { type: 'string', description: 'Issue state: open, closed or all.' },
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner: { type: 'string', description: 'The owner (login) of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the pull request.' },
      body: { type: 'string', description: 'The body of the pull request.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch with a squash merge.',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: { type: 'string', description: 'The owner (login) of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
    },
  },
];

function toolJson(tool: ToolDef): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required, additionalProperties: false },
  };
}

function textContent(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], structuredContent: { result: text } };
}

function errorContent(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------------------
// Tool execution (acts on the same Forge store as REST / GraphQL)
// ---------------------------------------------------------------------------

function argString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function missingArg(name: string): Record<string, unknown> {
  return errorContent(`Missing required argument: ${name}`);
}

function executeTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'create_repo') {
    const repoName = argString(args, 'name');
    if (!repoName) return missingArg('name');
    const description = argString(args, 'description') ?? '';
    const isPrivate = args.private === true;
    try {
      const repo = forge.createRepo(repoName, { description, private: isPrivate });
      return textContent(JSON.stringify({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, description: repo.description, private: repo.private, default_branch: repo.defaultBranch }));
    } catch (err) {
      return errorContent(err instanceof Error ? err.message : String(err));
    }
  }
  if (name === 'get_repo') {
    const owner = argString(args, 'owner');
    const repoName = argString(args, 'repo');
    if (!owner) return missingArg('owner');
    if (!repoName) return missingArg('repo');
    const repo = owner === VIEWER.login ? forge.getRepo(owner, repoName) : undefined;
    if (!repo) return errorContent(`Repository not found: ${owner}/${repoName}`);
    return textContent(JSON.stringify({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, description: repo.description, private: repo.private, default_branch: repo.defaultBranch }));
  }
  if (name === 'create_issue') {
    const owner = argString(args, 'owner');
    const repoName = argString(args, 'repo');
    const title = argString(args, 'title');
    if (!owner) return missingArg('owner');
    if (!repoName) return missingArg('repo');
    if (!title) return missingArg('title');
    const repo = owner === VIEWER.login ? forge.getRepo(owner, repoName) : undefined;
    if (!repo) return errorContent(`Repository not found: ${owner}/${repoName}`);
    const body = argString(args, 'body') ?? '';
    const labels = Array.isArray(args.labels) ? args.labels.filter((label): label is string => typeof label === 'string') : [];
    const labelObjects = labels
      .map((name) => repo.labels.get(name))
      .filter((label): label is NonNullable<typeof label> => label !== undefined);
    const issue = forge.createIssue(repo, title, body, labelObjects);
    return textContent(JSON.stringify({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
  }
  if (name === 'list_issues') {
    const owner = argString(args, 'owner');
    const repoName = argString(args, 'repo');
    if (!owner) return missingArg('owner');
    if (!repoName) return missingArg('repo');
    const repo = owner === VIEWER.login ? forge.getRepo(owner, repoName) : undefined;
    if (!repo) return errorContent(`Repository not found: ${owner}/${repoName}`);
    const state = argString(args, 'state') ?? 'open';
    const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    return textContent(JSON.stringify(issues.map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state }))));
  }
  if (name === 'create_pull_request') {
    const owner = argString(args, 'owner');
    const repoName = argString(args, 'repo');
    const title = argString(args, 'title');
    const head = argString(args, 'head');
    const base = argString(args, 'base');
    if (!owner) return missingArg('owner');
    if (!repoName) return missingArg('repo');
    if (!title) return missingArg('title');
    if (!head) return missingArg('head');
    if (!base) return missingArg('base');
    const repo = owner === VIEWER.login ? forge.getRepo(owner, repoName) : undefined;
    if (!repo) return errorContent(`Repository not found: ${owner}/${repoName}`);
    const headSha = resolveRef(repo, head);
    const baseSha = resolveRef(repo, base);
    if (headSha === null || baseSha === null) return errorContent(`Unknown branch: ${headSha === null ? head : base}`);
    const body = argString(args, 'body') ?? '';
    const pull = forge.createPull(repo, { title, body, headRef: head, baseRef: base, headSha, baseSha });
    return textContent(JSON.stringify({ id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state, head: { ref: head }, base: { ref: base } }));
  }
  if (name === 'merge_pull_request') {
    const owner = argString(args, 'owner');
    const repoName = argString(args, 'repo');
    if (!owner) return missingArg('owner');
    if (!repoName) return missingArg('repo');
    const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : undefined;
    if (pullNumber === undefined) return missingArg('pull_number');
    const repo = owner === VIEWER.login ? forge.getRepo(owner, repoName) : undefined;
    if (!repo) return errorContent(`Repository not found: ${owner}/${repoName}`);
    const pull = repo.pulls.find((candidate) => candidate.number === pullNumber);
    if (!pull) return errorContent(`Pull request not found: ${pullNumber}`);
    const merged = forge.mergePull(repo, pull);
    if (merged === null) return errorContent('Pull request cannot be merged: it has merge conflicts');
    return textContent(JSON.stringify({ id: pull.id, number: pull.number, merged: true, merged_at: pull.mergedAt, merge_commit_sha: pull.mergeCommitSha }));
  }
  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

/**
 * Handle one parsed JSON-RPC request (or a batch array, returned as an array).
 * Returns null for notifications (no response).
 */
export function handleMcpRequest(forge: Forge, body: unknown): Record<string, unknown> | Record<string, unknown>[] | null {
  if (Array.isArray(body)) {
    const responses: Record<string, unknown>[] = [];
    for (const item of body) {
      const response = handleSingle(forge, item);
      if (response !== null) responses.push(response);
    }
    return responses;
  }
  return handleSingle(forge, body);
}

function handleSingle(forge: Forge, body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object') {
    return errorResponse(null, -32600, 'Invalid Request');
  }
  const request = body as JsonRpcRequest;
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id === undefined ? null : request.id;
  const params = request.params ?? {};

  if (method === '') {
    // A response or notification with no method: no reply.
    return null;
  }

  if (method === 'server/discover') {
    return resultResponse(id, {
      supportedVersions: PROTOCOL_VERSIONS,
      _meta: {
        'io.modelcontextprotocol/serverInfo': SERVER_INFO,
        capabilities: { tools: {} },
      },
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
      protocolVersion: '2026-07-28',
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const version = PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return resultResponse(id, {
      protocolVersion: version,
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null;
  }

  if (method === 'ping') {
    return resultResponse(id, {});
  }

  if (method === 'tools/list') {
    return resultResponse(id, { tools: TOOLS.map(toolJson) });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (!tool) {
      return errorResponse(id, -32602, `Unknown tool: ${name}`);
    }
    for (const required of tool.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        return resultResponse(id, missingArg(required));
      }
    }
    const result = executeTool(forge, name, args);
    return resultResponse(id, result);
  }

  return errorResponse(id, -32601, `Method not found: ${method}`);
}

/**
 * Parse a raw request body. Returns `{ status, body }` where body is the
 * JSON-RPC response object (or array). Non-JSON bodies get -32700.
 */
export function handleMcpBody(forge: Forge, rawBody: string): { status: number; body: Record<string, unknown> | Record<string, unknown>[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: errorResponse(null, -32700, 'Parse error') };
  }
  const response = handleMcpRequest(forge, parsed);
  if (response === null) return { status: 202, body: { jsonrpc: '2.0', id: null, result: {} } };
  return { status: 200, body: response };
}
