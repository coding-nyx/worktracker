# Cloud Run container for the WorkTracker REST + MCP API.
# Build with the REPO ROOT as the build context so the npm
# workspace (apps/api, packages/types, ...) is visible:
#
#   gcloud run deploy worktracker-api \
#     --source . \
#     --region us-central1 \
#     --project worktracker-prod-2026 \
#     --allow-unauthenticated
#
# `gcloud run deploy --source .` triggers Cloud Build with the
# current directory as the build context, which is the repo
# root. The Dockerfile is at apps/api/Dockerfile, so we point
# Cloud Build at it explicitly.

FROM node:22-slim

WORKDIR /usr/src/repo

# Install all workspace deps from the repo root. We use
# `npm install` (not `npm ci`) because the per-package lockfile
# isn't split — the root lockfile covers all workspaces.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/types/package.json ./packages/types/
COPY apps/api/package.json ./apps/api/
RUN npm install

# Build @worktracker/types first — both the web and the api
# consume its dist as a published package.
COPY packages/types ./packages/types
RUN npm run build --workspace=@worktracker/types

# Build the api itself.
COPY apps/api ./apps/api
RUN npm run build --workspace=@worktracker/api

# Drop devDeps so the runtime image is smaller.
WORKDIR /usr/src/repo/apps/api
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

# `node /usr/src/repo/apps/api/dist/index.js` boots the Fastify
# server. The path is absolute because Cloud Run resets the
# working directory to `/workspace` before running the entry
# point, so a relative `dist/index.js` would 404 there.
# No firebase-functions/v2 needed here — that's only for Cloud
# Functions, which is what `functions.ts` is for.
CMD ["node", "/usr/src/repo/apps/api/dist/index.js"]
