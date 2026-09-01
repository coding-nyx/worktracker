/**
 * Local API bootstrap for integration tests. Listens on $PORT
 * (default 8081) and prints a "ready" line so the test runner
 * can wait for it.
 *
 * Run:
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 \
 *   FIRESTORE_EMULATOR=true \
 *   WORKTRACKER_ADMIN_TOKEN=local-admin-token \
 *   WORKTRACKER_ENV=local \
 *   PORT=8081 \
 *   npx tsx tests/local-server.ts
 */
import { buildApp } from '../src/app.js';

const port = Number(process.env.PORT ?? 8081);
const host = process.env.HOST ?? '127.0.0.1';

(async () => {
  const app = await buildApp();
  await app.listen({ port, host });
  console.log(`READY http://${host}:${port}`);

  process.on('SIGTERM', async () => {
    await app.close();
    process.exit(0);
  });
})().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
