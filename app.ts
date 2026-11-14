// The HTTP server: one node:http process, stdlib only. Routes:
//   GET  /healthz                 (no auth)
//   *    /{owner}/{repo}.git/*    git smart HTTP
//   *    /api/v3/*                REST v3
//   POST /api/graphql             GraphQL
//   POST /mcp                     MCP (JSON-RPC over Streamable HTTP)
// Every JSON reply carries X-GitHub-Request-Id and application/json.

import http from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './git.ts';
import { handleRest } from './rest.ts';
import { GraphQLContext, handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

export function createServer(store = new Store()) {
  const gql = new GraphQLContext(store);
  let requestCounter = 0;
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  function sendJson(res, status, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-github-request-id': String(++requestCounter),
      'content-length': Buffer.byteLength(payload),
      ...extraHeaders,
    });
    res.end(payload);
  }

  function sendBuffer(res, status, contentType, body, extraHeaders = {}) {
    res.writeHead(status, {
      'content-type': contentType,
      'x-github-request-id': String(++requestCounter),
      'content-length': body.length,
      ...extraHeaders,
    });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';
    const path = decodeURIComponent(url.pathname);

    // Unauthenticated health check.
    if (path === '/healthz') {
      if (method !== 'GET') return sendJson(res, 404, { message: 'Not Found' });
      return sendJson(res, 200, { status: 'ok' });
    }

    const body = await readBody(req);

    // Auth: when MAKEFUN_SHOP_TOKEN is set, every protected route requires an
    // exact Bearer match; in local dev (unset) any non-empty Bearer is fine.
    const isGit = path.endsWith('.git/info/refs') || path.endsWith('.git/git-upload-pack') || path.endsWith('.git/git-receive-pack');
    const isProtected = path.startsWith('/api/v3') || path.startsWith('/api/graphql') || path === '/mcp' || isGit;
    if (isProtected) {
      const auth = req.headers.authorization ?? '';
      const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      if (presented === '' || (token !== '' && presented !== token)) {
        return sendJson(res, 401, { message: 'Bad credentials' });
      }
    }

    // Git smart HTTP: /{owner}/{repo}.git/{service}
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (gitMatch) {
      const owner = gitMatch[1];
      const repoName = gitMatch[2];
      const service = gitMatch[3];
      const repo = store.getRepo(owner, repoName);
      if (!repo) return sendJson(res, 404, { message: 'Not Found' });
      const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (service === 'info/refs') {
        const queryService = url.searchParams.get('service') ?? '';
        const which = queryService === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack';
        const out = handleInfoRefs(repo, which, isV2 && which === 'git-upload-pack');
        return sendBuffer(res, out.status, out.contentType, out.body);
      }
      if (service === 'git-upload-pack') {
        if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' });
        const out = handleUploadPack(repo, body, isV2);
        if (out.json) return sendJson(res, out.status, out.json);
        return sendBuffer(res, out.status, out.contentType, out.body);
      }
      if (service === 'git-receive-pack') {
        if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' });
        const out = handleReceivePack(repo, body);
        if (out.json) return sendJson(res, out.status, out.json);
        return sendBuffer(res, out.status, out.contentType, out.body);
      }
    }

    // GraphQL.
    if (path === '/api/graphql') {
      if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' });
      let parsed;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        return sendJson(res, 400, { message: 'Bad Request: invalid JSON' });
      }
      const result = handleGraphQL(gql, parsed);
      return sendJson(res, 200, result);
    }

    // MCP.
    if (path === '/mcp') {
      if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' });
      let parsed;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        // Non-JSON body: JSON-RPC parse error -32700.
        return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      const out = handleMcp({ store }, parsed);
      if (out.json === null) {
        res.writeHead(202, { 'x-github-request-id': String(++requestCounter), 'content-length': 0 });
        return res.end();
      }
      return sendJson(res, out.status, out.json);
    }

    // REST v3.
    if (path.startsWith('/api/v3')) {
      const segments = path.slice('/api/v3'.length).split('/').filter((s) => s !== '');
      let parsed;
      if (body.length > 0) {
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          return sendJson(res, 400, { message: 'Bad Request: invalid JSON' });
        }
      }
      const out = handleRest({ store, method, segments, query: url.searchParams, body: parsed, host: req.headers.host ?? 'localhost' });
      if (out.status === 204) {
        res.writeHead(204, { 'x-github-request-id': String(++requestCounter), ...out.headers });
        return res.end();
      }
      return sendJson(res, out.status, out.json, out.headers ?? {});
    }

    return sendJson(res, 404, { message: 'Not Found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      try {
        sendJson(res, 500, { message: `Internal Server Error: ${err.message}` });
      } catch {
        res.destroy();
      }
    });
  });

  return { server, store };
}
