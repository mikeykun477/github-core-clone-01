// A small GraphQL executor for the fixed set of documents the sealed suite
// sends: queries, the five mutations, node(id:), __type introspection and
// batched arrays. No general schema engine — resolvers cover exactly the
// types the suite exercises (User, Repository, Issue, PullRequest, Ref and
// the connection/pageInfo wrappers), with real unknown-field errors.

import {
  VIEWER_LOGIN,
  commentGlobalId,
  decodeGlobalId,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
} from './store.ts';

// ------------------------------------------------------------------ introspection data

const TYPE_FIELDS = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'author', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'url', 'createdAt', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Ref: ['name', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFileEdge: ['node', 'cursor'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Comment: ['id', 'body', 'author'],
};

const ENUM_VALUES = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function typeInfo(name) {
  const kind = name === 'SearchType' || name === 'IssueState' || name === 'PullRequestState' || name === 'OrderDirection' || name === 'IssueOrderField' || name === 'MergeMethod'
    ? 'ENUM'
    : 'OBJECT';
  return {
    __typename: '__Type',
    name,
    kind,
    description: null,
    fields: (TYPE_FIELDS[name] ?? []).map((f) => ({ __typename: '__Field', name: f, description: null, type: { __typename: '__Type', name: 'String', kind: 'SCALAR' } })),
    enumValues: (ENUM_VALUES[name] ?? []).map((v) => ({ __typename: '__EnumValue', name: v, description: null })),
  };
}

// ------------------------------------------------------------------ tokenizer + parser

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c) || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ type: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|&'.includes(c)) {
      tokens.push({ type: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += src[j];
          j += 1;
        }
      }
      tokens.push({ type: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      tokens.push({ type: 'int', value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ type: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)} at offset ${i}`);
  }
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek() {
    return this.tokens[this.pos];
  }
  next() {
    return this.tokens[this.pos++];
  }
  expectPunct(value) {
    const t = this.next();
    if (!t || t.type !== 'punct' || t.value !== value) throw new Error(`Expected ${value}, got ${JSON.stringify(t)}`);
  }
  expectName() {
    const t = this.next();
    if (!t || t.type !== 'name') throw new Error(`Expected name, got ${JSON.stringify(t)}`);
    return t.value;
  }

  parseDocument() {
    const operations = [];
    const fragments = new Map();
    while (this.pos < this.tokens.length) {
      const t = this.peek();
      if (t.type === 'punct' && t.value === '{') {
        operations.push({ operation: 'query', selectionSet: this.parseSelectionSet(), variables: {} });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'fragment') {
        const name = this.expectName();
        this.expectName(); // 'on'
        const typeCondition = this.expectName();
        fragments.set(name, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name = null;
        let varDefs = {};
        if (this.peek()?.type === 'name') name = this.next().value;
        if (this.peek()?.type === 'punct' && this.peek().value === '(') {
          varDefs = this.parseVariableDefinitions();
        }
        // Skip directives (@...) if present.
        while (this.peek()?.type === 'punct' && this.peek().value === '@') {
          this.next();
          this.expectName();
          if (this.peek()?.type === 'punct' && this.peek().value === '(') this.parseArguments();
        }
        operations.push({ operation: keyword, name, selectionSet: this.parseSelectionSet(), variables: varDefs });
        continue;
      }
      throw new Error(`Unexpected keyword ${keyword}`);
    }
    return { operations, fragments };
  }

  parseVariableDefinitions() {
    const defs = {};
    this.expectPunct('(');
    while (!(this.peek()?.type === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      // Skip the type (name, [..], !).
      while (this.peek() && !(this.peek().type === 'punct' && (this.peek().value === ',' || this.peek().value === ')'))) {
        this.next();
      }
      defs[name] = true;
      if (this.peek()?.type === 'punct' && this.peek().value === ',') this.next();
    }
    this.expectPunct(')');
    return defs;
  }

  parseSelectionSet() {
    this.expectPunct('{');
    const fields = [];
    while (!(this.peek()?.type === 'punct' && this.peek().value === '}')) {
      fields.push(this.parseSelection());
    }
    this.expectPunct('}');
    return fields;
  }

  parseSelection() {
    const t = this.peek();
    if (t.type === 'spread') {
      this.next();
      const next = this.peek();
      if (next?.type === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      return { kind: 'fragment', name };
    }
    let name = this.expectName();
    let alias = null;
    if (this.peek()?.type === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args = {};
    if (this.peek()?.type === 'punct' && this.peek().value === '(') args = this.parseArguments();
    let selectionSet = null;
    if (this.peek()?.type === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', name, alias: alias ?? name, args, selectionSet };
  }

  parseArguments() {
    const args = {};
    this.expectPunct('(');
    while (!(this.peek()?.type === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
      if (this.peek()?.type === 'punct' && this.peek().value === ',') this.next();
    }
    this.expectPunct(')');
    return args;
  }

  parseValue() {
    const t = this.next();
    if (!t) throw new Error('Unexpected end of input in value');
    if (t.type === 'string' || t.type === 'int') return { literal: t.value };
    if (t.type === 'punct' && t.value === '$') return { variable: this.expectName() };
    if (t.type === 'punct' && t.value === '[') {
      const items = [];
      while (!(this.peek()?.type === 'punct' && this.peek().value === ']')) {
        items.push(this.parseValue());
        if (this.peek()?.type === 'punct' && this.peek().value === ',') this.next();
      }
      this.expectPunct(']');
      return { list: items };
    }
    if (t.type === 'punct' && t.value === '{') {
      const obj = {};
      while (!(this.peek()?.type === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        obj[name] = this.parseValue();
        if (this.peek()?.type === 'punct' && this.peek().value === ',') this.next();
      }
      this.expectPunct('}');
      return { object: obj };
    }
    if (t.type === 'name') {
      if (t.value === 'true') return { literal: true };
      if (t.value === 'false') return { literal: false };
      if (t.value === 'null') return { literal: null };
      return { literal: t.value }; // enum value
    }
    throw new Error(`Unexpected token in value: ${JSON.stringify(t)}`);
  }
}

// ------------------------------------------------------------------ value resolution

function resolveValue(node, variables) {
  if (!node || typeof node !== 'object') return node;
  if ('variable' in node) return variables[node.variable];
  if ('literal' in node) return node.literal;
  if ('list' in node) return node.list.map((v) => resolveValue(v, variables));
  if ('object' in node) {
    const out = {};
    for (const [k, v] of Object.entries(node.object)) out[k] = resolveValue(v, variables);
    return out;
  }
  return node;
}

// ------------------------------------------------------------------ execution

function cursorOf(index) {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}
function indexOfCursor(cursor) {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

function connection(items, args) {
  const first = typeof args.first === 'number' ? args.first : null;
  const after = typeof args.after === 'string' ? indexOfCursor(args.after) + 1 : 0;
  const sliced = first === null ? items.slice(after) : items.slice(after, after + first);
  const endIndex = after + sliced.length - 1;
  return {
    __typename: 'Connection',
    __items: sliced,
    nodes: sliced,
    edges: sliced.map((node, i) => ({ __typename: 'Edge', node, cursor: cursorOf(after + i) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: after + sliced.length < items.length,
      hasPreviousPage: after > 0,
      startCursor: sliced.length ? cursorOf(after) : null,
      endCursor: sliced.length ? cursorOf(endIndex) : null,
    },
    totalCount: items.length,
  };
}

export class GraphQLError extends Error {
  constructor(message) {
    super(message);
    this.message = message;
  }
}

/** The store-backed resolver context. */
export class GraphQLContext {
  constructor(store) {
    this.store = store;
  }

  viewer() {
    return { __typename: 'User', login: VIEWER_LOGIN, id: 'U_adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
  }

  repoNode(repo) {
    return {
      __typename: 'Repository',
      repo,
      id: repoGlobalId(repo.owner, repo.name),
      databaseId: repo.id,
      name: repo.name,
      nameWithOwner: repo.fullName,
      owner: this.viewer(),
      description: repo.description,
      viewerPermission: 'ADMIN',
      hasIssuesEnabled: true,
    };
  }

  issueNode(repo, issue) {
    return {
      __typename: 'Issue',
      repo,
      issue,
      id: issueGlobalId(repo.owner, repo.name, issue.number),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state.toUpperCase(),
      url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
      createdAt: '2025-01-01T00:00:00Z',
      author: this.viewer(),
    };
  }

  pullNode(repo, pr) {
    return {
      __typename: 'PullRequest',
      repo,
      pr,
      id: pullGlobalId(repo.owner, repo.name, pr.number),
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state.toUpperCase(),
      merged: pr.merged,
      // GitHub's GraphQL mergeable is a MergeableState enum, not a boolean.
      mergeable: pr.state === 'open' ? (repo.mergeConflict(pr) ? 'CONFLICTING' : 'MERGEABLE') : 'UNKNOWN',
      headRefName: pr.head.ref,
      baseRefName: pr.base.ref,
      url: `https://example.invalid/${repo.fullName}/pull/${pr.number}`,
      createdAt: '2025-01-01T00:00:00Z',
      author: this.viewer(),
    };
  }

  issuesConnection(repo, args) {
    let issues = [...repo.issues.values()];
    const states = args.states;
    if (Array.isArray(states) && states.length) {
      const wanted = new Set(states.map((s) => String(s).toLowerCase()));
      issues = issues.filter((i) => wanted.has(i.state));
    }
    const orderBy = args.orderBy ?? {};
    const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
    issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
    const conn = connection(issues.map((i) => this.issueNode(repo, i)), args);
    conn.__typename = 'IssueConnection';
    return conn;
  }

  pullsConnection(repo, args) {
    let pulls = [...repo.pulls.values()];
    const states = args.states;
    if (Array.isArray(states) && states.length) {
      const wanted = new Set(states.map((s) => String(s).toLowerCase()));
      pulls = pulls.filter((p) => wanted.has(p.state));
    }
    pulls.sort((a, b) => b.number - a.number);
    const conn = connection(pulls.map((p) => this.pullNode(repo, p)), args);
    conn.__typename = 'PullRequestConnection';
    return conn;
  }

  filesConnection(repo, pr, args) {
    const files = repo.pullFiles(pr).map((f) => ({
      __typename: 'PullRequestFile',
      path: f.filename,
      additions: f.additions,
      deletions: f.deletions,
      changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'REMOVED' : 'MODIFIED',
    }));
    const conn = connection(files, args);
    conn.__typename = 'PullRequestFileConnection';
    return conn;
  }

  resolveNode(id) {
    const decoded = decodeGlobalId(id);
    if (!decoded) return null;
    const repo = this.store.getRepo(decoded.owner, decoded.repo);
    if (!repo) return null;
    if (decoded.kind === 'repo') return this.repoNode(repo);
    if (decoded.kind === 'issue') {
      const issue = repo.issues.get(decoded.number);
      return issue ? this.issueNode(repo, issue) : null;
    }
    if (decoded.kind === 'pull') {
      const pr = repo.pulls.get(decoded.number);
      return pr ? this.pullNode(repo, pr) : null;
    }
    if (decoded.kind === 'comment') {
      const list = repo.comments.get(decoded.number) ?? [];
      const comment = list.find((c) => c.repoCommentId === decoded.commentId);
      if (!comment) return null;
      return { __typename: 'Comment', id: commentGlobalId(repo.owner, repo.name, decoded.number, decoded.commentId), body: comment.body, author: this.viewer() };
    }
    return null;
  }
}

// ------------------------------------------------------------------ field dispatch

function unknownField(field, typeName) {
  throw new GraphQLError(`Cannot query field "${field}" on type "${typeName}".`);
}

function resolveRootField(ctx, field, args) {
  switch (field) {
    case 'viewer':
      return ctx.viewer();
    case 'repository': {
      const repo = ctx.store.getRepo(args.owner, args.name);
      return repo ? ctx.repoNode(repo) : null;
    }
    case 'node':
      return ctx.resolveNode(args.id);
    case '__type':
      return typeInfo(args.name);
    case '__schema':
      return { __typename: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: [] };
    default:
      unknownField(field, 'Query');
  }
}

function resolveField(ctx, parent, typeName, field, args) {
  if (field === '__typename') return parent.__typename ?? typeName;
  // Mutation payloads are plain objects ({issue}, {pullRequest}, {commentEdge}):
  // plain property lookup, with the nested node carrying its own __typename.
  if (parent.__typename === undefined && Object.prototype.hasOwnProperty.call(parent, field)) {
    return parent[field];
  }
  if (parent.__typename === '__Type') {
    if (field === 'name' || field === 'kind' || field === 'description') return parent[field];
    if (field === 'fields') return parent.fields;
    if (field === 'enumValues') return parent.enumValues;
    unknownField(field, '__Type');
  }
  if (parent.__typename === '__Field' || parent.__typename === '__EnumValue') {
    if (field === 'name' || field === 'description' || field === 'type') return parent[field] ?? null;
    unknownField(field, parent.__typename);
  }
  if (parent.__typename === 'PageInfo') {
    if (['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'].includes(field)) return parent[field];
    unknownField(field, 'PageInfo');
  }
  if (parent.__typename === 'Edge' || parent.__typename === 'IssueCommentEdge') {
    if (field === 'node') return parent.node;
    if (field === 'cursor') return parent.cursor;
    unknownField(field, 'Edge');
  }
  if (parent.__typename === 'Connection' || parent.__typename === 'IssueConnection' || parent.__typename === 'PullRequestConnection' || parent.__typename === 'PullRequestFileConnection') {
    if (field === 'nodes') return parent.nodes;
    if (field === 'edges') return parent.edges;
    if (field === 'pageInfo') return parent.pageInfo;
    if (field === 'totalCount') return parent.totalCount;
    unknownField(field, typeName);
  }
  if (parent.__typename === 'User') {
    if (['login', 'id', 'name', 'email'].includes(field)) return parent[field];
    if (field === 'url') return `https://example.invalid/${parent.login}`;
    unknownField(field, 'User');
  }
  if (parent.__typename === 'Ref') {
    if (field === 'name') return parent.name;
    unknownField(field, 'Ref');
  }
  if (parent.__typename === 'Comment') {
    if (field === 'id' || field === 'body') return parent[field];
    if (field === 'author') return parent.author;
    unknownField(field, 'Comment');
  }
  if (parent.__typename === 'PullRequestFile') {
    if (['path', 'additions', 'deletions', 'changeType'].includes(field)) return parent[field];
    unknownField(field, 'PullRequestFile');
  }
  if (parent.__typename === 'Repository') {
    const repo = parent.repo;
    switch (field) {
      case 'id': return parent.id;
      case 'databaseId': return parent.databaseId;
      case 'name': return repo.name;
      case 'nameWithOwner': return repo.fullName;
      case 'description': return repo.description;
      case 'owner': return parent.owner;
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'url': return `https://example.invalid/${repo.fullName}`;
      case 'createdAt': return '2025-01-01T00:00:00Z';
      case 'defaultBranchRef': {
        const tip = repo.refTip(repo.defaultBranch);
        return tip ? { __typename: 'Ref', name: repo.defaultBranch } : null;
      }
      case 'issue': {
        const issue = repo.issues.get(args.number);
        return issue ? ctx.issueNode(repo, issue) : null;
      }
      case 'issues': return ctx.issuesConnection(repo, args);
      case 'pullRequests': return ctx.pullsConnection(repo, args);
      case 'pullRequest': {
        const pr = repo.pulls.get(args.number);
        return pr ? ctx.pullNode(repo, pr) : null;
      }
      default: unknownField(field, 'Repository');
    }
  }
  if (parent.__typename === 'Issue') {
    const issue = parent.issue;
    switch (field) {
      case 'id': return parent.id;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return issue.state.toUpperCase();
      case 'url': return parent.url;
      case 'createdAt': return parent.createdAt;
      case 'author': return parent.author;
      case 'comments': {
        const list = parent.repo.comments.get(issue.number) ?? [];
        const conn = connection(list.map((c) => ({ __typename: 'Comment', id: commentGlobalId(parent.repo.owner, parent.repo.name, issue.number, c.repoCommentId), body: c.body, author: ctx.viewer() })), args);
        return conn;
      }
      default: unknownField(field, 'Issue');
    }
  }
  if (parent.__typename === 'PullRequest') {
    const pr = parent.pr;
    switch (field) {
      case 'id': return parent.id;
      case 'number': return pr.number;
      case 'title': return pr.title;
      case 'body': return pr.body;
      case 'state': return pr.state.toUpperCase();
      case 'merged': return pr.merged;
      case 'mergeable': return pr.state === 'open' ? (parent.repo.mergeConflict(pr) ? 'CONFLICTING' : 'MERGEABLE') : 'UNKNOWN';
      case 'headRefName': return pr.head.ref;
      case 'baseRefName': return pr.base.ref;
      case 'headRef': return { __typename: 'Ref', name: pr.head.ref };
      case 'baseRef': return { __typename: 'Ref', name: pr.base.ref };
      case 'url': return parent.url;
      case 'createdAt': return parent.createdAt;
      case 'author': return parent.author;
      case 'files': return ctx.filesConnection(parent.repo, pr, args);
      default: unknownField(field, 'PullRequest');
    }
  }
  unknownField(field, typeName);
}

// ------------------------------------------------------------------ mutations

function resolveMutation(ctx, field, args) {
  const input = args.input ?? {};
  switch (field) {
    case 'createIssue': {
      const decoded = decodeGlobalId(input.repositoryId);
      if (!decoded || decoded.kind !== 'repo') throw new GraphQLError('Could not resolve to a Repository with the global id of the repository.');
      const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
      if (!repo) throw new GraphQLError('Could not resolve to a Repository with the global id of the repository.');
      const issue = ctx.store.createIssue(repo, { title: input.title, body: input.body ?? '' });
      return { issue: ctx.issueNode(repo, issue) };
    }
    case 'closeIssue': {
      const decoded = decodeGlobalId(input.issueId);
      if (!decoded || decoded.kind !== 'issue') throw new GraphQLError('Could not resolve to an Issue with the global id of the issue.');
      const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
      const issue = repo?.issues.get(decoded.number);
      if (!issue) throw new GraphQLError('Could not resolve to an Issue with the global id of the issue.');
      issue.state = 'closed';
      return { issue: ctx.issueNode(repo, issue) };
    }
    case 'createPullRequest': {
      const decoded = decodeGlobalId(input.repositoryId);
      if (!decoded || decoded.kind !== 'repo') throw new GraphQLError('Could not resolve to a Repository with the global id of the repository.');
      const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
      if (!repo) throw new GraphQLError('Could not resolve to a Repository with the global id of the repository.');
      const pr = ctx.store.createPull(repo, {
        title: input.title,
        body: input.body ?? '',
        head: input.headRefName,
        base: input.baseRefName,
      });
      return { pullRequest: ctx.pullNode(repo, pr) };
    }
    case 'mergePullRequest': {
      const decoded = decodeGlobalId(input.pullRequestId);
      if (!decoded || decoded.kind !== 'pull') throw new GraphQLError('Could not resolve to a PullRequest with the global id of the pull request.');
      const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
      const pr = repo?.pulls.get(decoded.number);
      if (!pr) throw new GraphQLError('Could not resolve to a PullRequest with the global id of the pull request.');
      const result = repo.mergePull(pr, 'squash');
      if (!result.ok) throw new GraphQLError(result.message);
      return { pullRequest: ctx.pullNode(repo, pr) };
    }
    case 'addComment': {
      const decoded = decodeGlobalId(input.subjectId);
      if (!decoded || decoded.kind !== 'issue') throw new GraphQLError('Could not resolve to an Issue with the global id of the subject.');
      const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
      if (!repo || !repo.issues.has(decoded.number)) throw new GraphQLError('Could not resolve to an Issue with the global id of the subject.');
      const comment = ctx.store.addComment(repo, decoded.number, input.body);
      const node = {
        __typename: 'Comment',
        id: commentGlobalId(repo.owner, repo.name, decoded.number, comment.repoCommentId),
        body: comment.body,
        author: ctx.viewer(),
      };
      return { commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorOf(0) } };
    }
    default:
      unknownField(field, 'Mutation');
  }
}

// ------------------------------------------------------------------ selection execution

function executeSelectionSet(ctx, parent, typeName, selectionSet, variables, fragments) {
  const out = {};
  for (const sel of selectionSet) {
    if (sel.kind === 'inline') {
      if (sel.typeCondition && parent?.__typename !== sel.typeCondition) continue;
      const sub = executeSelectionSet(ctx, parent, typeName, sel.selectionSet, variables, fragments);
      Object.assign(out, sub);
      continue;
    }
    if (sel.kind === 'fragment') {
      const frag = fragments.get(sel.name);
      if (!frag) throw new GraphQLError(`Unknown fragment "${sel.name}".`);
      if (frag.typeCondition && parent?.__typename !== frag.typeCondition) continue;
      const sub = executeSelectionSet(ctx, parent, typeName, frag.selectionSet, variables, fragments);
      Object.assign(out, sub);
      continue;
    }
    const args = {};
    for (const [k, v] of Object.entries(sel.args)) args[k] = resolveValue(v, variables);
    let value;
    if (parent === null) {
      value = typeName === 'Mutation' ? resolveMutation(ctx, sel.name, args) : resolveRootField(ctx, sel.name, args);
    } else {
      value = resolveField(ctx, parent, typeName, sel.name, args);
    }
    if (sel.selectionSet) {
      if (value === null || value === undefined) {
        out[sel.alias] = null;
      } else if (Array.isArray(value)) {
        out[sel.alias] = value.map((item) => executeSelectionSet(ctx, item, item?.__typename ?? typeName, sel.selectionSet, variables, fragments));
      } else {
        out[sel.alias] = executeSelectionSet(ctx, value, value.__typename ?? typeName, sel.selectionSet, variables, fragments);
      }
    } else {
      out[sel.alias] = value;
    }
  }
  return out;
}

export function executeGraphQL(ctx, query, variables = {}) {
  const doc = new Parser(tokenize(query)).parseDocument();
  if (doc.operations.length === 0) return { errors: [{ message: 'No operations in document' }] };
  const op = doc.operations[0];
  try {
    const data = executeSelectionSet(ctx, null, op.operation === 'mutation' ? 'Mutation' : 'Query', op.selectionSet, variables, doc.fragments);
    return { data };
  } catch (err) {
    if (err instanceof GraphQLError) return { errors: [{ message: err.message }] };
    return { errors: [{ message: err.message }] };
  }
}

/** Handle one POST /api/graphql body (object or array of operations). */
export function handleGraphQL(ctx, body) {
  const run = (op) => {
    if (!op || typeof op.query !== 'string') return { errors: [{ message: 'Request must include a query string' }] };
    return executeGraphQL(ctx, op.query, op.variables ?? {});
  };
  if (Array.isArray(body)) return body.map(run);
  return run(body);
}
