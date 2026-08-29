# Cloud Run container for the WorkTracker REST + MCP API.
# Build from the repo root:
#   gcloud run deploy worktracker-api \
#     --source ./apps/api \
#     --region us-central1 \
#     --allow-unauthenticated
#
# `gcloud run deploy --source .` triggers Cloud Build, which
# runs this Dockerfile, pushes the image to Artifact Registry,
# and rolls out a new Cloud Run revision in one step.

FROM node:22-slim

WORKDIR /usr/src/app

# Install all deps (we need devDeps for the tsc build). We
# use `npm install` rather than `npm ci` because the api
# package lives inside an npm workspace and ships no
# per-package lockfile.
COPY package.json ./
COPY tsconfig.json ./
RUN npm install

# Build the TypeScript.
COPY src ./src
RUN npm run build

# Drop devDeps so the runtime image is smaller. This also
# drops the @types/* packages that aren't needed at runtime.
RUN npm prune --omit=dev

# Production: only the compiled JS + prod node_modules.
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

# `node dist/index.js` boots the Fastify server. No
# firebase-functions/v2 needed here — that's only for
# Cloud Functions, which is what `functions.ts` is for.
CMD ["node", "dist/index.js"]
