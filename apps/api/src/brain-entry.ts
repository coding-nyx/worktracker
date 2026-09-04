/**
 * Brain entry point — the Cloud Run container for the
 * `worktracker-brain` service.
 *
 * Boots a minimal HTTP server on PORT (just `/` for the Cloud Run
 * default healthcheck + `/api/healthz` as a conventional alias) and
 * starts the Firestore document listener. No REST or MCP routes
 * — the API lives in the separate `worktracker-api` service.
 *
 * Run via: `node dist/brain-entry.js`
 * Container CMD: `CMD ["node", "/usr/src/repo/apps/api/dist/brain-entry.js"]`
 */

import * as http from 'node:http';
import { startBrainListener } from './brain-listener.js';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/api/healthz') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, service: 'worktracker-brain' }));
    return;
  }
  res.statusCode = 404;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: 'not found', path: req.url }));
});

server.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`[brain-entry] HTTP healthcheck listening on http://${host}:${port}`);
  // Start the Firestore listener once the server is up so the
  // healthcheck can pass before the listener attaches.
  startBrainListener();
  // eslint-disable-next-line no-console
  console.log('[brain-entry] Firestore listener started');
});
