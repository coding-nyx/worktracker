/**
 * Hermes connector. Bidirectional sync with the user's local
 * Hermes kanban:
 *
 *   Outbound (WorkTracker → Hermes):
 *     - Mirror a WorkTracker item to a Hermes kanban task when
 *       the item's source manifest opts in to a Hermes mirror
 *       (default on for `kind=task`).
 *     - Bind the Hermes task to a per-item delivery handle via
 *       `hermes kanban notify-subscribe`.
 *
 *   Inbound (Hermes → WorkTracker):
 *     - Register a Hermes webhook subscription on startup.
 *     - When Hermes fires the webhook, translate the payload
 *       into a WorkTracker `commands/{id}` document and let the
 *       brain process it.
 *
 * The connector lives in the same Node process as the API
 * (it's loaded by the connector admin or by a Cloud Function
 * scheduled ping). For v0 we keep it simple: a single class
 * with `start()` and `stop()`.
 */

import { ulid, nowIso } from '../ids.js';
import { getDb } from '../firestore.js';
import type { WorkItem, WorkItemEvent } from '@worktracker/types';

export interface HermesConnectorConfig {
  /** Path to the `hermes` CLI on the local box. */
  hermesBin: string;
  /** Hermes profile to use (defaults to "default"). */
  profile: string;
  /** The WorkTracker source name for the Hermes connection. */
  sourceName: string;
  /** Bearer token for the WorkTracker source. */
  sourceToken: string;
  /** WorkTracker API base URL. */
  apiBase: string;
  /** The chat ID for `hermes kanban notify-subscribe`. */
  notifyChatId: string;
  /** The platform to subscribe to notifications for. */
  notifyPlatform: 'telegram' | 'slack' | 'discord' | 'whatsapp' | 'weixin';
  /** Optional fetch for environments without a global fetch. */
  fetchImpl?: typeof fetch;
  /** Optional child-process spawn for environments without `node:child_process`. */
  spawnImpl?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

export class HermesConnector {
  private readonly cfg: Required<Omit<HermesConnectorConfig, 'fetchImpl' | 'spawnImpl'>> &
    Pick<HermesConnectorConfig, 'fetchImpl' | 'spawnImpl'>;
  private webhookName = 'worktracker-sync';

  constructor(cfg: HermesConnectorConfig) {
    this.cfg = {
      hermesBin: cfg.hermesBin,
      profile: cfg.profile,
      sourceName: cfg.sourceName,
      sourceToken: cfg.sourceToken,
      apiBase: cfg.apiBase,
      notifyChatId: cfg.notifyChatId,
      notifyPlatform: cfg.notifyPlatform,
      ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
      ...(cfg.spawnImpl ? { spawnImpl: cfg.spawnImpl } : {}),
    };
  }

  /**
   * Register the Hermes webhook subscription. Idempotent —
   * if a subscription with the same name already exists,
   * Hermes replaces it.
   */
  async start(): Promise<void> {
    await this.shellHermes([
      'webhook',
      'subscribe',
      this.webhookName,
      '--events',
      'kanban.*',
      '--deliver',
      'telegram',
      '--deliver-chat-id',
      this.cfg.notifyChatId,
    ]);
  }

  async stop(): Promise<void> {
    try {
      await this.shellHermes(['webhook', 'remove', this.webhookName]);
    } catch {
      // Best-effort; the subscription might already be gone.
    }
  }

  /**
   * Mirror a WorkTracker item to Hermes. Called by the
   * notification router (or directly by a connector admin
   * action) when a `created` / `updated` / `transition` event
   * for an item whose source manifest has `mirror_to_hermes`.
   *
   * Returns the Hermes task id; stores it on the item's
   * `source_meta.hermes_task_id` so subsequent updates hit the
   * same task.
   */
  async mirrorItem(item: WorkItem, event: WorkItemEvent): Promise<void> {
    const existingTaskId = (item.source_meta as { hermes_task_id?: string } | undefined)
      ?.hermes_task_id;
    if (event.kind === 'created' || !existingTaskId) {
      const taskId = await this.shellHermes([
        'kanban',
        'create',
        `[${item.kind}] ${item.title}`,
        '--triage',
        '--priority',
        priorityForKind(item.kind),
        '--assignee',
        'worktracker',
        '--created-by',
        'worktracker',
        '--body',
        item.body ?? '',
      ]);
      await getDb()
        .collection('work_items')
        .doc(item.id)
        .update({
          source_meta: { ...(item.source_meta ?? {}), hermes_task_id: taskId },
          updated_at: nowIso(),
        });
      await this.bindNotification(taskId);
      return;
    }
    if (event.kind === 'status_change' && event.to_status) {
      await this.shellHermes([
        'kanban',
        'update',
        existingTaskId,
        '--status',
        event.to_status,
      ]);
      return;
    }
    if (event.kind === 'comment' && event.body) {
      await this.shellHermes(['kanban', 'comment', existingTaskId, event.body]);
    }
  }

  /**
   * Translate a Hermes webhook payload into a WorkTracker
   * `commands/{id}` document and let the brain evaluate it.
   * The webhook URL is registered on Hermes; the Cloud
   * Function's incoming-webhook route is what calls this.
   */
  async handleHermesWebhook(payload: HermesWebhookPayload): Promise<void> {
    if (payload.event.startsWith('kanban.task')) {
      const cmdId = ulid();
      const command = {
        id: cmdId,
        source: this.cfg.sourceName,
        source_event_id: `${payload.event}:${payload.task_id}:${payload.at}`,
        op: 'create' as const,
        item_id: null,
        payload: {
          kind: 'task' as const,
          title: payload.title ?? `Hermes task ${payload.task_id}`,
          body: payload.body ?? null,
          status: mapHermesStatus(payload.status),
          source_id: payload.task_id,
          source_meta: {
            hermes_task_id: payload.task_id,
            mirror_to_hermes: false, // Hermes-originated; don't loop
          },
        },
        status: 'queued' as const,
        error: null,
        applied_event_id: null,
        created_at: nowIso(),
        applied_at: null,
      };
      await getDb().collection('commands').doc(cmdId).set(command);
    }
    // kanban.comment events: a future iteration translates
    // these to `comment` commands. Skipped for v0.
  }

  // ----- internals -----

  private async bindNotification(hermesTaskId: string): Promise<void> {
    await this.shellHermes([
      'kanban',
      'notify-subscribe',
      hermesTaskId,
      '--platform',
      this.cfg.notifyPlatform,
      '--chat-id',
      this.cfg.notifyChatId,
    ]);
  }

  private async shellHermes(args: string[]): Promise<string> {
    if (this.cfg.spawnImpl) {
      const { stdout } = await this.cfg.spawnImpl(this.cfg.hermesBin, [
        '--profile',
        this.cfg.profile,
        ...args,
      ]);
      return stdout.trim();
    }
    const { spawn } = await import('node:child_process');
    return new Promise<string>((resolve, reject) => {
      const proc = spawn(this.cfg.hermesBin, ['--profile', this.cfg.profile, ...args], {
        env: { ...process.env, HERMES_GATEWAY: '' },
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      proc.stdout.on('data', (c) => out.push(c));
      proc.stderr.on('data', (c) => err.push(c));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`hermes ${args[0]} exited ${code}: ${Buffer.concat(err).toString()}`));
          return;
        }
        resolve(Buffer.concat(out).toString().trim());
      });
    });
  }
}

interface HermesWebhookPayload {
  event: string;
  task_id: string;
  title?: string;
  body?: string;
  status?: string;
  at: string;
}

function priorityForKind(kind: WorkItem['kind']): string {
  switch (kind) {
    case 'task':
      return '2';
    case 'ticket':
      return '1';
    case 'decision':
      return '3';
    case 'review':
      return '2';
  }
}

function mapHermesStatus(s: string | undefined): WorkItem['status'] {
  // Hermes statuses don't map 1:1 to ours; default to 'open'
  // for the create command and let the brain surface a conflict
  // if the human wants a different status.
  if (!s) return 'open';
  return 'open';
}
