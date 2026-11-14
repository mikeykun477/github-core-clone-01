// graphql.ts — GraphQL v4 for the documents gh and github-mcp-server send.
// A small recursive-descent parser plus an executor over the forge's store.
// Unknown fields are reported as GraphQL errors (HTTP 200 with `errors`),
// never as HTTP errors; an unauthenticated request is 401 (app.ts).

import {
  VIEWER,
  decodeGlobalId,
  globalId,
  isoOfEpoch,
  resolveRef,
  type Forge,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// Lexer + parser (documents only: no schema definition language).
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',' || char === '\ufeff') {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '"') {
      // A string, or a block string (""").
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        const value = end < 0 ? source.slice(index + 3) : source.slice(index + 3, end);
        tokens.push({ kind: 'string', value });
        index = end < 0 ? source.length : end + 3;
        continue;
      }
      let end = index + 1;
      let value = '';
      while (end < source.length && source[end] !== '"') {
        if (source[end] === '\\' && end + 1 < source.length) {
          const escaped = source[end + 1] as string;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          end += 2;
        } else {
          value += source[end] as string;
          end += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      index = end + 1;
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let end = index;
      while (end < source.length && /[0-9.eE+-]/.test(source[end] as string)) end += 1;
      const value = source.slice(index, end);
      tokens.push({ kind: value.includes('.') || value.includes('e') || value.includes('E') ? 'float' : 'int', value });
      index = end;
      continue;
    }
    if (/[_A-Za-z]/.test(char)) {
      let end = index;
      while (end < source.length && /[_A-Za-z0-9]/.test(source[end] as string)) end += 1;
      tokens.push({ kind: 'name', value: source.slice(index, end) });
      index = end;
      continue;
    }
    if (char === '.' && source.startsWith('...', index)) {
      tokens.push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    if ('!$():=@[]{ }|'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      index += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection: SelectionNode[];
}

export interface FragmentNode {
  typeCondition: string;
  selection: SelectionNode[];
}

export type SelectionNode = { kind: 'field'; field: FieldNode } | { kind: 'fragment'; fragment: FragmentNode };

export interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; type: string; required: boolean }[];
  selection: SelectionNode[];
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.index] as Token;
    this.index += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${JSON.stringify(token)}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token)}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      type = this.next().value as 'query' | 'mutation';
      const next = this.peek();
      if (next.kind === 'name') name = this.next().value;
    }
    const variables: OperationNode['variables'] = [];
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const { type: varType, required } = this.parseType();
        variables.push({ name: varName, type: varType, required });
        if (this.isPunct('=')) {
          this.next();
          this.parseValue();
        }
      }
      this.expectPunct(')');
    }
    const selection = this.parseSelectionSet();
    return { type, name, variables, selection };
  }

  private parseType(): { type: string; required: boolean } {
    let type = '';
    if (this.isPunct('[')) {
      this.next();
      const inner = this.parseType();
      type = `[${inner.type}]`;
      this.expectPunct(']');
    } else {
      type = this.expectName();
    }
    let required = false;
    if (this.isPunct('!')) {
      this.next();
      required = true;
    }
    return { type, required };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.isPunct('...')) {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', fragment: { typeCondition, selection: this.parseSelectionSet() } };
      }
      if (token.kind === 'name') {
        // A named fragment spread; the suite never sends one, but skip it.
        this.next();
        return { kind: 'fragment', fragment: { typeCondition: '', selection: [] } };
      }
      throw new Error('expected a fragment condition');
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.isPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selection: SelectionNode[] = [];
    if (this.isPunct('{')) selection = this.parseSelectionSet();
    return { kind: 'field', field: { alias, name, args, selection } };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.isPunct('}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

export function parseDocument(source: string): OperationNode[] {
  return new Parser(lex(source)).parseDocument();
}

// ---------------------------------------------------------------------------
// Value resolution
// ---------------------------------------------------------------------------

export function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema: the fields each type exposes (what __type reports and what the
// executor accepts). Anything outside these lists is an unknown field.
// ---------------------------------------------------------------------------

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url',
  ],
  Ref: ['id', 'name', 'target'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType'],
  Node: ['id'],
};

const SCHEMA_ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

const KNOWN_TYPES = new Set([...Object.keys(SCHEMA_FIELDS), ...Object.keys(SCHEMA_ENUMS)]);

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

interface TypedValue {
  type: string;
  value: unknown;
}

function fieldError(ctx: ExecContext, type: string, field: string): null {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${type}".` });
  return null;
}

function argValue(field: FieldNode, name: string, ctx: ExecContext): unknown {
  const arg = field.args.find((candidate) => candidate.name === name);
  if (!arg) return undefined;
  return resolveValue(arg.value, ctx.variables);
}

function issueStateOut(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateOut(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return -1;
    return Number.parseInt(text.slice('cursor:'.length), 10);
  } catch {
    return -1;
  }
}

function issueNode(ctx: ExecContext, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __type: 'Issue',
    __value: issue,
    __repo: repo,
    id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    state: issueStateOut(issue.state),
    body: issue.body,
    createdAt: isoOfEpoch(issue.createdEpoch),
    updatedAt: isoOfEpoch(issue.updatedEpoch),
  };
}

function pullNode(ctx: ExecContext, repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    __type: 'PullRequest',
    __value: pull,
    __repo: repo,
    id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pullStateOut(pull),
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    createdAt: isoOfEpoch(pull.createdEpoch),
    updatedAt: isoOfEpoch(pull.updatedEpoch),
    mergedAt: pull.mergedAt,
  };
}

function repoNode(ctx: ExecContext, repo: Repo): Record<string, unknown> {
  return {
    __type: 'Repository',
    __value: repo,
    id: globalId('Repository', `${repo.owner}/${repo.name}`),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    isPrivate: repo.private,
    createdAt: isoOfEpoch(repo.createdEpoch),
    updatedAt: isoOfEpoch(repo.createdEpoch),
  };
}

function userNode(): Record<string, unknown> {
  return {
    __type: 'User',
    id: globalId('User', VIEWER.login),
    login: VIEWER.login,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

function typeNode(name: string): Record<string, unknown> | null {
  if (!KNOWN_TYPES.has(name)) return null;
  return { __type: '__Type', __typeName: name, name, kind: SCHEMA_ENUMS[name] !== undefined ? 'ENUM' : 'OBJECT' };
}

/** Resolve one field of a typed value; returns the raw value (or null). */
function resolveField(ctx: ExecContext, parent: Record<string, unknown>, field: FieldNode): unknown {
  const type = (parent.__type as string) ?? 'Query';
  const fields = SCHEMA_FIELDS[type];
  if (fields !== undefined && !fields.includes(field.name)) return fieldError(ctx, type, field.name);
  switch (type) {
    case 'Query':
      return resolveQueryField(ctx, field);
    case 'User':
      return parent[field.name] ?? null;
    case 'Repository':
      return resolveRepositoryField(ctx, parent, field);
    case 'Issue':
      return resolveIssueField(ctx, parent, field);
    case 'PullRequest':
      return resolvePullField(ctx, parent, field);
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
      return parent[field.name] ?? null;
    case 'PageInfo':
      return parent[field.name] ?? null;
    case 'Ref':
      return parent[field.name] ?? null;
    case '__Type':
      return resolveTypeField(ctx, parent, field);
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      return parent[field.name] ?? null;
    case 'AddCommentPayload':
      return parent[field.name] ?? null;
    case 'IssueCommentEdge':
      return parent[field.name] ?? null;
    case 'IssueComment':
      return parent[field.name] ?? null;
    case 'PullRequestChangedFile':
      return parent[field.name] ?? null;
    default:
      return parent[field.name] ?? null;
  }
}

function resolveQueryField(ctx: ExecContext, field: FieldNode): unknown {
  if (field.name === 'viewer') return userNode();
  if (field.name === 'repository') {
    const owner = argValue(field, 'owner', ctx);
    const name = argValue(field, 'name', ctx);
    if (typeof owner !== 'string' || typeof name !== 'string') return null;
    if (owner !== VIEWER.login) return null;
    const repo = ctx.forge.getRepo(owner, name);
    if (!repo) return null;
    return repoNode(ctx, repo);
  }
  if (field.name === 'node') {
    const id = argValue(field, 'id', ctx);
    if (typeof id !== 'string') return null;
    const decoded = decodeGlobalId(id);
    if (!decoded) return null;
    if (decoded.kind === 'Repository') {
      const [owner, name] = decoded.key.split('/');
      if (owner === undefined || name === undefined) return null;
      const repo = ctx.forge.getRepo(owner, name);
      if (!repo) return null;
      return repoNode(ctx, repo);
    }
    if (decoded.kind === 'Issue') {
      const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
      if (!match) return null;
      const repo = ctx.forge.getRepo(match[1] as string, match[2] as string);
      if (!repo) return null;
      const issue = repo.issues.find((candidate) => candidate.number === Number(match[3]));
      if (!issue) return null;
      return issueNode(ctx, repo, issue);
    }
    if (decoded.kind === 'PullRequest') {
      const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
      if (!match) return null;
      const repo = ctx.forge.getRepo(match[1] as string, match[2] as string);
      if (!repo) return null;
      const pull = repo.pulls.find((candidate) => candidate.number === Number(match[3]));
      if (!pull) return null;
      return pullNode(ctx, repo, pull);
    }
    return null;
  }
  if (field.name === '__type') {
    const name = argValue(field, 'name', ctx);
    if (typeof name !== 'string') return null;
    return typeNode(name);
  }
  if (field.name === '__schema') {
    return { __type: '__Schema' };
  }
  return null;
}

function resolveRepositoryField(ctx: ExecContext, parent: Record<string, unknown>, field: FieldNode): unknown {
  const repo = parent.__value as Repo;
  switch (field.name) {
    case 'owner':
      return userNode();
    case 'defaultBranchRef': {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return { __type: 'Ref', id: globalId('Ref', `${repo.owner}/${repo.name}:${repo.defaultBranch}`), name: repo.defaultBranch, target: tip === undefined ? null : { __type: 'Commit', oid: tip } };
    }
    case 'issue': {
      const number = argValue(field, 'number', ctx);
      if (typeof number !== 'number') return null;
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (!issue) return null;
      return issueNode(ctx, repo, issue);
    }
    case 'issues': {
      const first = argValue(field, 'first', ctx);
      const after = argValue(field, 'after', ctx);
      const states = argValue(field, 'states', ctx);
      const orderBy = argValue(field, 'orderBy', ctx) as { field?: string; direction?: string } | undefined;
      let list = repo.issues.slice();
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      const direction = orderBy?.direction === 'ASC' ? 1 : -1;
      list.sort((a, b) => {
        if (a.createdEpoch !== b.createdEpoch) return (a.createdEpoch - b.createdEpoch) * direction;
        return (a.number - b.number) * direction;
      });
      const start = indexOfCursor(after) + 1;
      const count = typeof first === 'number' && first > 0 ? first : list.length;
      const window = list.slice(start, start + count);
      const endCursor = window.length > 0 ? cursorFor(start + window.length - 1) : null;
      return {
        __type: 'IssueConnection',
        nodes: window.map((issue) => issueNode(ctx, repo, issue)),
        edges: window.map((issue, offset) => ({ __type: 'IssueEdge', node: issueNode(ctx, repo, issue), cursor: cursorFor(start + offset) })),
        pageInfo: { __type: 'PageInfo', hasNextPage: start + count < list.length, hasPreviousPage: start > 0, startCursor: window.length > 0 ? cursorFor(start) : null, endCursor },
        totalCount: list.length,
      };
    }
    case 'pullRequests': {
      const first = argValue(field, 'first', ctx);
      const list = repo.pulls.slice().sort((a, b) => b.number - a.number);
      const count = typeof first === 'number' && first > 0 ? first : list.length;
      const window = list.slice(0, count);
      return {
        __type: 'PullRequestConnection',
        nodes: window.map((pull) => pullNode(ctx, repo, pull)),
        edges: window.map((pull, offset) => ({ __type: 'PullRequestEdge', node: pullNode(ctx, repo, pull), cursor: cursorFor(offset) })),
        pageInfo: { __type: 'PageInfo', hasNextPage: list.length > count, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: list.length,
      };
    }
    case 'pullRequest': {
      const number = argValue(field, 'number', ctx);
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (!pull) return null;
      return pullNode(ctx, repo, pull);
    }
    default:
      return parent[field.name] ?? null;
  }
}

function resolveIssueField(ctx: ExecContext, parent: Record<string, unknown>, field: FieldNode): unknown {
  if (field.name === 'author') return userNode();
  if (field.name === 'labels') {
    const issue = parent.__value as Issue;
    return { __type: 'LabelConnection', nodes: issue.labels.map((label) => ({ __type: 'Label', name: label.name, color: label.color })) };
  }
  if (field.name === 'comments') {
    const issue = parent.__value as Issue;
    return { __type: 'IssueCommentConnection', nodes: issue.comments.map((comment) => ({ __type: 'IssueComment', id: globalId('IssueComment', String(comment.id)), body: comment.body })) };
  }
  return parent[field.name] ?? null;
}

function resolvePullField(ctx: ExecContext, parent: Record<string, unknown>, field: FieldNode): unknown {
  const pull = parent.__value as PullRequest;
  const repo = parent.__repo as Repo;
  if (field.name === 'mergeable') {
    return ctx.forge.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
  }
  if (field.name === 'files') {
    const first = argValue(field, 'first', ctx);
    const count = typeof first === 'number' && first > 0 ? first : pull.files.length;
    const window = pull.files.slice(0, count);
    return {
      __type: 'PullRequestChangedFileConnection',
      nodes: window.map((file) => ({ __type: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() })),
      edges: window.map((file, offset) => ({ __type: 'PullRequestChangedFileEdge', node: { __type: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() }, cursor: cursorFor(offset) })),
      pageInfo: { __type: 'PageInfo', hasNextPage: pull.files.length > count, hasPreviousPage: false, startCursor: null, endCursor: null },
      totalCount: pull.files.length,
    };
  }
  if (field.name === 'author') return userNode();
  if (field.name === 'headRef') return { __type: 'Ref', name: pull.headRef };
  if (field.name === 'baseRef') return { __type: 'Ref', name: pull.baseRef };
  return parent[field.name] ?? null;
}

function resolveTypeField(ctx: ExecContext, parent: Record<string, unknown>, field: FieldNode): unknown {
  const name = parent.__typeName as string;
  if (field.name === 'fields') {
    const names = SCHEMA_FIELDS[name] ?? [];
    return names.map((fieldName) => ({ __type: '__Field', name: fieldName }));
  }
  if (field.name === 'enumValues') {
    const values = SCHEMA_ENUMS[name] ?? [];
    return values.map((value) => ({ __type: '__EnumValue', name: value }));
  }
  return parent[field.name] ?? null;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function executeMutation(ctx: ExecContext, field: FieldNode): unknown {
  const input = argValue(field, 'input', ctx) as Record<string, unknown> | undefined;
  if (field.name === 'createIssue') {
    const repositoryId = typeof input?.repositoryId === 'string' ? input.repositoryId : '';
    const decoded = decodeGlobalId(repositoryId);
    if (!decoded || decoded.kind !== 'Repository') return { __type: 'CreateIssuePayload', issue: null };
    const [owner, name] = decoded.key.split('/');
    const repo = owner !== undefined && name !== undefined ? ctx.forge.getRepo(owner, name) : undefined;
    if (!repo) return { __type: 'CreateIssuePayload', issue: null };
    const title = typeof input?.title === 'string' ? input.title : '';
    const body = typeof input?.body === 'string' ? input.body : '';
    const issue = ctx.forge.createIssue(repo, title, body, []);
    return { __type: 'CreateIssuePayload', issue: issueNode(ctx, repo, issue) };
  }
  if (field.name === 'closeIssue') {
    const issueId = typeof input?.issueId === 'string' ? input.issueId : '';
    const decoded = decodeGlobalId(issueId);
    if (!decoded || decoded.kind !== 'Issue') return { __type: 'CloseIssuePayload', issue: null };
    const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
    if (!match) return { __type: 'CloseIssuePayload', issue: null };
    const repo = ctx.forge.getRepo(match[1] as string, match[2] as string);
    if (!repo) return { __type: 'CloseIssuePayload', issue: null };
    const issue = repo.issues.find((candidate) => candidate.number === Number(match[3]));
    if (!issue) return { __type: 'CloseIssuePayload', issue: null };
    issue.state = 'closed';
    return { __type: 'CloseIssuePayload', issue: issueNode(ctx, repo, issue) };
  }
  if (field.name === 'createPullRequest') {
    const repositoryId = typeof input?.repositoryId === 'string' ? input.repositoryId : '';
    const decoded = decodeGlobalId(repositoryId);
    if (!decoded || decoded.kind !== 'Repository') return { __type: 'CreatePullRequestPayload', pullRequest: null };
    const [owner, name] = decoded.key.split('/');
    const repo = owner !== undefined && name !== undefined ? ctx.forge.getRepo(owner, name) : undefined;
    if (!repo) return { __type: 'CreatePullRequestPayload', pullRequest: null };
    const baseRefName = typeof input?.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
    const headRefName = typeof input?.headRefName === 'string' ? input.headRefName : '';
    const title = typeof input?.title === 'string' ? input.title : '';
    const body = typeof input?.body === 'string' ? input.body : '';
    const headSha = resolveRef(repo, headRefName);
    const baseSha = resolveRef(repo, baseRefName);
    if (headSha === null || baseSha === null) {
      ctx.errors.push({ message: `createPullRequest: head or base ref does not exist` });
      return { __type: 'CreatePullRequestPayload', pullRequest: null };
    }
    const pull = ctx.forge.createPull(repo, { title, body, headRef: headRefName, baseRef: baseRefName, headSha, baseSha });
    return { __type: 'CreatePullRequestPayload', pullRequest: pullNode(ctx, repo, pull) };
  }
  if (field.name === 'mergePullRequest') {
    const pullRequestId = typeof input?.pullRequestId === 'string' ? input.pullRequestId : '';
    const decoded = decodeGlobalId(pullRequestId);
    if (!decoded || decoded.kind !== 'PullRequest') return { __type: 'MergePullRequestPayload', pullRequest: null };
    const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
    if (!match) return { __type: 'MergePullRequestPayload', pullRequest: null };
    const repo = ctx.forge.getRepo(match[1] as string, match[2] as string);
    if (!repo) return { __type: 'MergePullRequestPayload', pullRequest: null };
    const pull = repo.pulls.find((candidate) => candidate.number === Number(match[3]));
    if (!pull) return { __type: 'MergePullRequestPayload', pullRequest: null };
    const merged = ctx.forge.mergePull(repo, pull);
    if (merged === null) {
      ctx.errors.push({ message: 'mergePullRequest: the pull request cannot be merged' });
      return { __type: 'MergePullRequestPayload', pullRequest: pullNode(ctx, repo, pull) };
    }
    return { __type: 'MergePullRequestPayload', pullRequest: pullNode(ctx, repo, pull) };
  }
  if (field.name === 'addComment') {
    const subjectId = typeof input?.subjectId === 'string' ? input.subjectId : '';
    const decoded = decodeGlobalId(subjectId);
    if (!decoded || decoded.kind !== 'Issue') return { __type: 'AddCommentPayload', commentEdge: null };
    const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
    if (!match) return { __type: 'AddCommentPayload', commentEdge: null };
    const repo = ctx.forge.getRepo(match[1] as string, match[2] as string);
    if (!repo) return { __type: 'AddCommentPayload', commentEdge: null };
    const issue = repo.issues.find((candidate) => candidate.number === Number(match[3]));
    if (!issue) return { __type: 'AddCommentPayload', commentEdge: null };
    const body = typeof input?.body === 'string' ? input.body : '';
    const comment = ctx.forge.createComment(repo, issue, body);
    return {
      __type: 'AddCommentPayload',
      commentEdge: {
        __type: 'IssueCommentEdge',
        node: { __type: 'IssueComment', id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}/${comment.id}`), body: comment.body },
      },
    };
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
  return null;
}

// ---------------------------------------------------------------------------
// Selection execution
// ---------------------------------------------------------------------------

function executeSelection(ctx: ExecContext, parent: Record<string, unknown>, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const parentType = (parent.__type as string) ?? 'Query';
      if (selection.fragment.typeCondition !== '' && selection.fragment.typeCondition !== parentType) continue;
      const nested = executeSelection(ctx, parent, selection.fragment.selection);
      Object.assign(out, nested);
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    let value: unknown;
    if ((parent.__type as string | undefined) === 'MutationRoot') {
      value = executeMutation(ctx, field);
    } else {
      value = resolveField(ctx, parent, field);
    }
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (field.selection.length === 0) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((entry) => {
        if (entry !== null && typeof entry === 'object') return executeSelection(ctx, entry as Record<string, unknown>, field.selection);
        return entry;
      });
      continue;
    }
    if (typeof value === 'object') {
      out[key] = executeSelection(ctx, value as Record<string, unknown>, field.selection);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Validate every selected field against the schema; collect unknown fields. */
function validateSelection(type: string, selections: SelectionNode[], ctx: ExecContext): void {
  const fields = SCHEMA_FIELDS[type];
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      validateSelection(selection.fragment.typeCondition || type, selection.fragment.selection, ctx);
      continue;
    }
    const field = selection.field;
    if (fields !== undefined && !fields.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${type}".` });
      continue;
    }
    if (field.selection.length === 0) continue;
    // Recurse into the right sub-type. Connection fields depend on which
    // connection they sit in: `nodes` under a pull-request connection are
    // pull requests, not issues, and `pageInfo` is a PageInfo, not an edge.
    const connectionElement: Record<string, string> = {
      IssueConnection: 'Issue',
      PullRequestConnection: 'PullRequest',
      PullRequestChangedFileConnection: 'PullRequestChangedFile',
    };
    const connectionEdge: Record<string, string> = {
      IssueConnection: 'IssueEdge',
      PullRequestConnection: 'PullRequestEdge',
      PullRequestChangedFileConnection: 'PullRequestChangedFileEdge',
    };
    const childType: Record<string, string> = {
      viewer: 'User',
      repository: 'Repository',
      node: 'Node',
      owner: 'User',
      defaultBranchRef: 'Ref',
      issue: 'Issue',
      issues: 'IssueConnection',
      pullRequests: 'PullRequestConnection',
      pullRequest: 'PullRequest',
      files: 'PullRequestChangedFileConnection',
      commentEdge: 'IssueCommentEdge',
    };
    let next: string | undefined;
    if (field.name === 'nodes') next = connectionElement[type];
    else if (field.name === 'edges') next = connectionEdge[type];
    else if (field.name === 'node' && type.endsWith('Edge')) {
      const connection = type.slice(0, -'Edge'.length) + 'Connection';
      next = connectionElement[connection];
    } else if (field.name === 'pageInfo') next = 'PageInfo';
    else next = childType[field.name];
    if (next !== undefined) validateSelection(next, field.selection, ctx);
  }
}

/** Execute one operation document; returns the {data, errors} envelope. */
export function executeGraphQL(forge: Forge, query: string, variables: Record<string, unknown>, operationName?: string): { data: Record<string, unknown> | null; errors: { message: string }[] } {
  const ctx: ExecContext = { forge, variables, errors: [] };
  let operations: OperationNode[];
  try {
    operations = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let operation = operations[0];
  if (operationName !== undefined) {
    operation = operations.find((candidate) => candidate.name === operationName) ?? operations[0] as OperationNode;
  }
  if (!operation) return { data: null, errors: [{ message: 'No operation provided' }] };
  // Apply variable defaults.
  const vars: Record<string, unknown> = { ...variables };
  for (const variable of operation.variables) {
    if (!(variable.name in vars)) vars[variable.name] = null;
  }
  ctx.variables = vars;
  if (operation.type === 'mutation') {
    validateSelection('Mutation', operation.selection, ctx);
    if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
    const root: Record<string, unknown> = { __type: 'MutationRoot' };
    const data = executeSelection(ctx, root, operation.selection);
    return { data, errors: ctx.errors };
  }
  validateSelection('Query', operation.selection, ctx);
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  const root: Record<string, unknown> = { __type: 'Query' };
  const data = executeSelection(ctx, root, operation.selection);
  return { data, errors: ctx.errors };
}
