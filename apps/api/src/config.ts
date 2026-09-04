/**
 * Environment configuration for the WorkTracker API.
 * Loaded once at module init; fail fast if anything is missing.
 */

export interface Config {
  /** Public project ID, used for log correlation. */
  projectId: string;
  /** Logical environment label: 'local' | 'dev' | 'prod'. */
  env: 'local' | 'dev' | 'prod';
  /** Admin bearer token for admin-only endpoints. */
  adminToken: string;
  /** Optional override for the Firestore project (Cloud Functions sets this). */
  firestoreProject?: string;
  /** Optional MiniMax OpenAI-compatible API base URL. */
  llmBaseUrl?: string;
  /** Optional MiniMax API key. */
  llmApiKey?: string;
  // Slice 1 (wrecking ball): the `adminSources` allowlist is gone.
  // Sources declare their own `scope` field in `Client`;
  // see `apps/api/src/auth.ts:getEffectiveScope`. The env var
  // `WORKTRACKER_ADMIN_SOURCES` is no longer read.
}

function readEnv(name: string, fallback?: string): string {
  // Trim trailing whitespace — Secret Manager can attach a final
  // `\n` to the value, and `gcloud run deploy --set-env-vars` /
  // `kubectl create secret` users sometimes copy-paste with a
  // trailing space. Either way the value the operator thinks
  // they wrote isn't the value the runtime sees.
  const v = process.env[name]?.replace(/\s+$/, '');
  if (v && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${name}`);
}

export function loadConfig(): Config {
  // In Cloud Functions, GCLOUD_PROJECT is set by the runtime.
  // Use that as the primary signal for prod; WORKTRACKER_ENV
  // remains useful for `dev` overrides.
  const gcloudProject = process.env.GCLOUD_PROJECT;
  const isCloud = !!gcloudProject && gcloudProject !== 'worktracker-local';
  const envExplicit = process.env.WORKTRACKER_ENV as Config['env'] | undefined;
  const env: Config['env'] = envExplicit ?? (isCloud ? 'prod' : 'local');
  const isLocal = env === 'local';
  return {
    projectId: gcloudProject ?? process.env.WORKTRACKER_PROJECT_ID ?? 'worktracker-local',
    env,
    // v0 single-user: a static shared secret. The web UI embeds
    // the same value. In v0.5 this becomes a Firebase Secret.
    adminToken: readEnv(
      'WORKTRACKER_ADMIN_TOKEN',
      isLocal ? 'local-admin-token' : 'worktracker-prod-2026-admin-token',
    ),
    firestoreProject: gcloudProject,
    llmBaseUrl: process.env.WORKTRACKER_LLM_BASE_URL,
    llmApiKey: process.env.WORKTRACKER_LLM_API_KEY,
  };
}
