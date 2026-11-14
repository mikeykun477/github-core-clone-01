# github-core-clone-01

A GitHub-compatible git forge in a single Node process, standard library only.

## What it is

One process, one in-memory store, four interfaces over the same data:

- **Git smart HTTP** — `git clone` / `fetch` / `push` over HTTP, protocol v2
  and v0, `upload-pack` and `receive-pack`, plain v2 packs.
- **REST v3** — repositories, branches, commits, refs, contents, labels,
  issues, comments and pull requests under `/api/v3`.
- **GraphQL** — the queries and mutations `gh` and `github-mcp-server`
  send, under `/api/graphql`, with opaque global ids.
- **MCP** — `server/discover` (2026-07-28) and the legacy `initialize`
  handshake, `tools/list` and `tools/call`, under `/mcp`.

## Run

```sh
node --experimental-strip-types main.ts
```

Node 22 or newer. No dependencies. The server listens on an ephemeral
port (or `$PORT`) and prints it. Auth is a Bearer token:
`$MAKEFUN_SHOP_TOKEN`, defaulting to `local-dev-token` for local runs.

With `$MAKEFUN_ENV_URL` set, the server registers its port with the env
service and exits when the run reports done.

## Layout

| File | Contents |
| --- | --- |
| `main.ts` | Entry point and env lifecycle. |
| `app.ts` | HTTP server, auth, routing. |
| `store.ts` | In-memory store, git object model, packs, deterministic viewer. |
| `git.ts` | Smart HTTP: pkt-lines, fetch v2/v0, receive-pack. |
| `rest.ts` | REST v3 handlers. |
| `graphql.ts` | GraphQL parser and executor. |
| `mcp.ts` | MCP JSON-RPC handlers and tools. |

Timestamps in the store use a deterministic logical clock so a live run
and a replay produce the same bytes. Packs sent to clients are plain
(no deltas); packs received are fully parsed, including OFS and REF deltas.

## Verify

Start the server, then run the kit's sealed runner against it from the
kit directory:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:<port> --token local-dev-token --perf --json
```

Start a fresh server for every run; the suite mutates state by design.
