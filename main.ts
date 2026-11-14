// main.ts — entry point.
// Lifecycle: bind an ephemeral port, register it with the make.fun env
// service when MAKEFUN_ENV_URL is set, poll /done until the run finishes,
// then exit. Local development: with no MAKEFUN_ENV_URL, just listen and
// print the port. Never binds 8080.

import { createApp } from './app.ts';

async function registerAndWait(port: number): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL as string;
  const registerUrl = `${envUrl.replace(/\/$/, '')}/register`;
  const doneUrl = `${envUrl.replace(/\/$/, '')}/done`;
  const response = await fetch(registerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!response.ok) {
    throw new Error(`register failed: HTTP ${response.status}`);
  }
  for (;;) {
    const doneResponse = await fetch(doneUrl);
    if (doneResponse.ok) {
      const payload = (await doneResponse.json()) as { done?: boolean };
      if (payload.done === true) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function main(): Promise<void> {
  const { server } = createApp();
  const requestedPort = process.env.PORT !== undefined ? Number.parseInt(process.env.PORT, 10) : 0;
  const port = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : 0;
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  console.log(`github-core-clone-01 listening on http://127.0.0.1:${actualPort}`);
  // A clean shutdown on SIGTERM so a supervisor can stop the server.
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
  });
  if (process.env.MAKEFUN_ENV_URL !== undefined && process.env.MAKEFUN_ENV_URL !== '') {
    await registerAndWait(actualPort);
    server.close();
    process.exit(0);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
