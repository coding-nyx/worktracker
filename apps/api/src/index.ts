/**
 * Cloud Run entry. When run as a module (`node dist/index.js`),
 * boots the Fastify app on `PORT` (default 8080) bound to all
 * interfaces — this is what Cloud Run invokes.
 *
 * Local dev: `npm run dev:api` (tsx watch) does the same thing.
 *
 * The `brain` Firestore trigger is also re-exported from here so
 * Firebase Functions still finds it at the default `index.js`
 * entry point. Cloud Run doesn't care about the export; it only
 * runs the IIFE below.
 *
 * The IIFE is gated on `K_REVISION` (set by Cloud Run's container
 * contract) and the absence of `FUNCTION_TARGET` (set by Cloud
 * Functions). When loaded by Cloud Functions the trigger exports
 * run and the Fastify HTTP server must NOT start, because Cloud
 * Functions already owns port 8080.
 */

import { buildApp } from './app.js';

export { brain } from './functions.js';

const isCloudRun = !!process.env.K_REVISION && !process.env.FUNCTION_TARGET;
if (isCloudRun) {
  void (async () => {
    const app = await buildApp();
    const port = Number(process.env.PORT ?? 8080);
    const host = process.env.HOST ?? '0.0.0.0';
    await app.listen({ port, host });
    app.log.info(`WorkTracker API listening on http://${host}:${port}`);
  })();
}
