// app.ts — the HTTP server.
// Routes:
//   GET  /healthz                                  (no auth)
//   /<owner>/<repo>.git/info/refs                 (git smart HTTP)
//   /<owner>/<repo>.git/git-upload-pack
//   /<owner>/<repo>.git/git-receive-pack
//   /api/v3/...                                    (REST v3)
//   /api/graphql                                   (GraphQL)
//   /mcp                                           (MCP)
// Every response is JSON except git responses, and every response carries
// a non-empty X-GitHub-Request-Id. Missing/wrong Bearer token is 401 on
// every authenticated route; unknown routes are JSON 404.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import {
  handleFetchV0,
  handleFetchV2,
  handleLsRefs,
  handleReceivePack,
  parseV0Request,
  parseV2Request,
  v0Advertisement,
  v2Advertisement,
} from './git.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcpBody } from './mcp.ts';

export const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'local-dev-token';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${process.pid}-${Date.now()}-${requestCounter}`;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function jsonResponse(
  response: ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'X-GitHub-Request-Id': requestId,
    ...extraHeaders,
  });
  response.end(payload);
}

function isAuthorized(request: IncomingMessage): boolean {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  return match[1] === SHOP_TOKEN;
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function wantsV2(request: IncomingMessage): boolean {
  const header = request.headers['git-protocol'];
  return typeof header === 'string' && header.includes('version=2');
}

export function createApp(): { server: ReturnType<typeof createServer>; forge: Forge } {
  const forge = new Forge();

  const server = createServer(async (request, response) => {
    const requestId = nextRequestId();
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = request.method ?? 'GET';

    try {
      if (path === '/healthz') {
        jsonResponse(response, 200, { status: 'ok' }, requestId);
        return;
      }

      // Git smart HTTP: /<owner>/<repo>.git/info/refs, /git-upload-pack, /git-receive-pack
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch !== null) {
        const owner = decodePathSegment(gitMatch[1] as string);
        const repoName = decodePathSegment(gitMatch[2] as string);
        const action = gitMatch[3] as string;
        const repo = forge.getRepo(owner, repoName);
        if (repo === undefined) {
          jsonResponse(response, 404, { message: 'Not Found' }, requestId);
          return;
        }
        if (!isAuthorized(request)) {
          jsonResponse(response, 401, { message: 'Requires authentication' }, requestId);
          return;
        }
        const service = url.searchParams.get('service');
        const body = method === 'POST' ? await readBody(request) : Buffer.alloc(0);
        if (action === 'info/refs' && method === 'GET') {
          if (service === 'git-upload-pack') {
            const payload = wantsV2(request) ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack');
            response.writeHead(200, {
              'Content-Type': 'application/x-git-upload-pack-advertisement',
              'Content-Length': payload.length,
              'X-GitHub-Request-Id': requestId,
            });
            response.end(payload);
            return;
          }
          if (service === 'git-receive-pack') {
            const payload = v0Advertisement(repo, 'git-receive-pack');
            response.writeHead(200, {
              'Content-Type': 'application/x-git-receive-pack-advertisement',
              'Content-Length': payload.length,
              'X-GitHub-Request-Id': requestId,
            });
            response.end(payload);
            return;
          }
          jsonResponse(response, 400, { message: 'Missing service parameter' }, requestId);
          return;
        }
        if (action === 'git-upload-pack' && method === 'POST') {
          const parsed = parseV2Request(body);
          let payload: Buffer;
          if (parsed.command === 'ls-refs') {
            payload = handleLsRefs(repo, parsed.args);
          } else if (parsed.command === 'fetch') {
            payload = handleFetchV2(repo, parsed.args);
          } else {
            payload = handleFetchV0(repo, parseV0Request(body));
          }
          response.writeHead(200, {
            'Content-Type': 'application/x-git-upload-pack-result',
            'Content-Length': payload.length,
            'X-GitHub-Request-Id': requestId,
          });
          response.end(payload);
          return;
        }
        if (action === 'git-receive-pack' && method === 'POST') {
          const payload = handleReceivePack(repo, body);
          response.writeHead(200, {
            'Content-Type': 'application/x-git-receive-pack-result',
            'Content-Length': payload.length,
            'X-GitHub-Request-Id': requestId,
          });
          response.end(payload);
          return;
        }
        jsonResponse(response, 405, { message: 'Method Not Allowed' }, requestId);
        return;
      }

      // REST v3
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (!isAuthorized(request)) {
          jsonResponse(response, 401, { message: 'Requires authentication' }, requestId);
          return;
        }
        const rawBody = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE' ? await readBody(request) : Buffer.alloc(0);
        let parsed: unknown = null;
        if (rawBody.length > 0) {
          try {
            parsed = JSON.parse(rawBody.toString('utf8'));
          } catch {
            jsonResponse(response, 400, { message: 'Problems parsing JSON' }, requestId);
            return;
          }
        }
        const bodyObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
        const baseUrl = `http://${request.headers.host ?? '127.0.0.1'}`;
        const restResult = handleRest(method, path, url.searchParams, bodyObject, { forge, baseUrl });
        if (restResult === null) {
          jsonResponse(response, 404, { message: 'Not Found' }, requestId);
          return;
        }
        jsonResponse(response, restResult.status, restResult.body, requestId, restResult.headers ?? {});
        return;
      }

      // GraphQL
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          jsonResponse(response, 405, { message: 'Method Not Allowed' }, requestId);
          return;
        }
        if (!isAuthorized(request)) {
          jsonResponse(response, 401, { message: 'Requires authentication' }, requestId);
          return;
        }
        const rawBody = await readBody(request);
        let payload: unknown;
        try {
          payload = JSON.parse(rawBody.toString('utf8'));
        } catch {
          jsonResponse(response, 400, { errors: [{ message: 'Problems parsing JSON' }] }, requestId);
          return;
        }
        // Batched operations: a JSON array is answered in order.
        if (Array.isArray(payload)) {
          const results = payload.map((entry) => {
            const item = entry as { query?: string; variables?: Record<string, unknown>; operationName?: string };
            if (typeof item?.query !== 'string') return { data: null, errors: [{ message: 'A GraphQL operation must provide a query string' }] };
            return executeGraphQL(forge, item.query, item.variables ?? {}, item.operationName);
          });
          jsonResponse(response, 200, results, requestId);
          return;
        }
        const item = payload as { query?: string; variables?: Record<string, unknown>; operationName?: string };
        if (typeof item?.query !== 'string') {
          jsonResponse(response, 400, { errors: [{ message: 'A GraphQL operation must provide a query string' }] }, requestId);
          return;
        }
        const result = executeGraphQL(forge, item.query, item.variables ?? {}, item.operationName);
        jsonResponse(response, 200, result, requestId);
        return;
      }

      // MCP
      if (path === '/mcp') {
        if (method !== 'POST') {
          jsonResponse(response, 405, { message: 'Method Not Allowed' }, requestId);
          return;
        }
        if (!isAuthorized(request)) {
          jsonResponse(response, 401, { message: 'Requires authentication' }, requestId);
          return;
        }
        const rawBody = await readBody(request);
        const result = handleMcpBody(forge, rawBody.toString('utf8'));
        // Pre-2026-07-28 clients get a parse error inside HTTP 200.
        const status = result.status === 400 && request.headers['mcp-protocol-version'] !== '2026-07-28' ? 200 : result.status;
        jsonResponse(response, status, result.body, requestId);
        return;
      }

      // Everything else: a JSON 404, never HTML.
      jsonResponse(response, 404, { message: 'Not Found' }, requestId);
    } catch (err) {
      // A handler failure must never leak a stack trace or an HTML page.
      const message = err instanceof Error ? err.message : String(err);
      jsonResponse(response, 500, { message: `Internal Server Error: ${message}` }, requestId);
    }
  });

  return { server, forge };
}
