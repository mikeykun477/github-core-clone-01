# github-core-clone-01

A standalone GitHub-compatible git forge: one process, no UI, serving from its
own in-memory store:

- git smart HTTP (`/{owner}/{repo}.git`): upload-pack protocol v2 (ls-refs,
  fetch, shallow/deepen) and v0, receive-pack v0 with report-status and
  side-band-64k; packfiles built and read with `node:zlib`/`node:crypto` only,
  no git binary.
- REST v3 under `/api/v3`: repositories, branches, commits, contents, labels,
  issues, comments, pull requests, files and squash merges.
- GraphQL v4 at `/api/graphql`: the documents `gh` and `github-mcp-server`
  send (viewer, repository, issues, pull requests, mutations, `__type`
  introspection, `node(id:)`, cursor pagination, batched operations).
- MCP at `/mcp`: JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28
  (`server/discover`, `tools/list`, `tools/call`).

## Run it

```sh
node main.ts
```

The platform runs `node /bot/main.ts` (Node 22). The program binds an
ephemeral port, POSTs it to `$MAKEFUN_ENV_URL/register`, then polls
`$MAKEFUN_ENV_URL/done` until the suite is over and exits 0. `MAKEFUN_SHOP_TOKEN`
is the bearer token every API call must carry. Only the standard library is
used; there is nothing to install.

## Layout

- `main.ts` — the entry <-> env lifecycle (bind, register, wait for done).
- `app.ts` — the HTTP server: routing, auth, JSON discipline.
- `store.ts` — the in-memory store and the git object model (hashing, trees,
  commits, tags, packfiles, reachability, diffs, merges).
- `git.ts` — git smart HTTP (advertisements, upload-pack v2/v0, receive-pack).
- `rest.ts` — the REST v3 surface.
- `graphql.ts` — a small GraphQL parser and executor for the v4 surface.
- `mcp.ts` — the MCP endpoint (discover, tools/list, tools/call).
