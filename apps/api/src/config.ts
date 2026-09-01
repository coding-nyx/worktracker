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
  /**
   * Legacy source bearer names that get full `admin` scope
   * (in addition to the `admin` token, the `web` source, and
   * Firebase users with `is_admin: true`). Defaults to the three
   * MCP clients we know: hermes, claude, codex. Override with
   * `WORKTRACKER_ADMIN_SOURCES="hermes,claude,codex,n8n"` (comma
   * separated, no spaces).
   *
   * Why an allowlist: the per-source bearers predate the v0.5
   * API-token model and were assumed admin-equivalent. Tightening
   * them to `read_write` broke legitimate MCP clients; the
   * allowlist restores the original behavior without reopening
   * the door to unknown sources.
   */
  adminSources: string[];
}

function readEnv(name: string, fallback?: string): string {
  const v = process.env[name];
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
    // Comma-separated source names. Empty / unset -> the v0.4
    // default allowlist (the three MCP clients we know ship).
    // Dedupe so a user-supplied list that already contains
    // 'hermes' doesn't double-count.
    adminSources: Array.from(new Set(
      (process.env.WORKTRACKER_ADMIN_SOURCES
        ? process.env.WORKTRACKER_ADMIN_SOURCES.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
        : ['hermes', 'claude', 'codex'])
    )),
  };
}
