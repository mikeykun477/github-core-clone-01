// Entry point: bind an ephemeral port, register it with the environment,
// answer /healthz, wait for the environment to say it is done, exit 0.
// Lifecycle copied from the kit starter (rules/instance.yaml requires
// registration within 20 s of boot and exit 0 once the export is written).

import { createServer } from './app.ts';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { server } = createServer();
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve(server.address().port));
  });
  const envUrl = process.env.MAKEFUN_ENV_URL;
  const startedAt = Date.now();
  const deadlineMs = 900_000; // The trial wall is 900 s; the env cuts off at wall - 90 s.

  if (!envUrl) {
    // Local dev: just serve on the ephemeral port until killed.
    console.error(`Listening on ${port} (no MAKEFUN_ENV_URL; local dev mode)`);
    return;
  }

  const register = async () => {
    const res = await fetch(`${envUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    if (!res.ok) throw new Error(`register failed: ${res.status}`);
  };
  await register();
  console.error(`Registered port ${port}`);

  while (Date.now() - startedAt < deadlineMs) {
    try {
      const res = await fetch(`${envUrl}/done`);
      const data = await res.json();
      if (data.done) {
        console.error('Environment done; exiting');
        server.close();
        process.exit(0);
      }
    } catch {
      // The environment may not answer yet; keep polling.
    }
    await sleep(500);
  }
  console.error('Deadline reached; exiting');
  server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
