/**
 * Per-kind Zod schemas for the `WorkItem.data` field. Every write
 * to `data` is validated against the schema for the item's `kind`
 * (strict: unknown keys are rejected, not silently dropped). The
 * detail view in the web UI relies on the typed shape, so lenient
 * validation is a footgun.
 *
 * Slice 3. The types live in `@worktracker/types` so the web can
 * render the detail view without pulling in zod; the schemas live
 * here because zod is an API-side runtime concern.
 *
 * The shapes are intentionally narrow. The free-form `data_map`
 * is the "everything else" bucket for fields these schemas don't
 * know about.
 */

import { z } from 'zod';
import type { WorkItemKind } from '@worktracker/types';
import { SEVERITIES } from '@worktracker/types';
import { InvalidInputError } from './errors.js';

// Shared scalar primitives.

const NonEmptyString = z.string().min(1).max(10_000);

/** Estimate in minutes — non-negative, sane upper bound (1 year). */
const EstimateMinutes = z.number().int().min(0).max(525_600);

const Tags = z.array(z.string().min(1).max(120)).max(64);

// task — see WorkItem.data in the architecture doc §5.
const TaskDataSchema = z
  .object({
    estimate_minutes: EstimateMinutes.optional(),
    acceptance_criteria: z.array(NonEmptyString).max(64).optional(),
    tags: Tags.optional(),
  })
  .strict();

// ticket — `severity` is required (it's the whole point of a
// ticket); `customer` and `reproduction` are the common
// "what's the impact" fields.
const TicketDataSchema = z
  .object({
    severity: z.enum(SEVERITIES),
    customer: z.string().max(200).optional(),
    reproduction: z.string().max(20_000).optional(),
  })
  .strict();

// decision — at least one option is required; the chosen one is
// optional until the decision lands.
const DecisionOptionSchema = z
  .object({
    id: z.string().min(1).max(64),
    title: NonEmptyString,
    body: z.string().max(20_000).optional(),
  })
  .strict();

const DecisionDataSchema = z
  .object({
    options: z.array(DecisionOptionSchema).min(1).max(32),
    chosen_option_id: z.string().min(1).max(64).optional(),
    rationale: z.string().max(20_000).optional(),
  })
  .strict()
  .refine(
    (d) => d.chosen_option_id === undefined || d.options.some((o) => o.id === d.chosen_option_id),
    {
      message: "chosen_option_id must match one of the option ids",
      path: ['chosen_option_id'],
    },
  );

// review — verdict is optional while the review is in progress;
// a final state has a verdict set.
const ReviewDataSchema = z
  .object({
    reviewer: z.string().max(200).optional(),
    rubric: z.string().max(20_000).optional(),
    verdict: z.enum(['approve', 'request_changes', 'comment']).optional(),
  })
  .strict();

const SCHEMAS: Record<WorkItemKind, z.ZodType<unknown>> = {
  task: TaskDataSchema,
  ticket: TicketDataSchema,
  decision: DecisionDataSchema,
  review: ReviewDataSchema,
};

/**
 * Validate a `data` payload against the schema for the given kind.
 * Throws an `InvalidInputError` (`code: 'invalid_input'`) on
 * failure, with the Zod issues attached as `details`. The brain
 * catches the WorkTrackerError and records the failure as
 * `code: 'invalid_data'` (rewritten by the brain) on the command
 * + the conflicts collection.
 */
export function validateItemData(
  data: unknown,
  kind: WorkItemKind,
): Record<string, unknown> {
  const schema = SCHEMAS[kind];
  const result = schema.safeParse(data);
  if (result.success) return result.data as Record<string, unknown>;
  throw new InvalidInputError(
    `data does not match the ${kind} schema: ${result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')}`,
    {
      code: 'invalid_data',
      kind,
      issues: result.error.issues.map((i) => ({
        path: i.path,
        message: i.message,
        code: i.code,
      })),
    },
  );
}

/**
 * Non-throwing variant. Returns a `{ ok: true, data }` or
 * `{ ok: false, issues }` so callers can render the failure
 * inline (e.g. the web detail view's "edit data" form).
 */
export function tryValidateItemData(
  data: unknown,
  kind: WorkItemKind,
):
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; issues: z.ZodIssue[] } {
  const schema = SCHEMAS[kind];
  const r = schema.safeParse(data);
  if (r.success) return { ok: true, data: r.data as Record<string, unknown> };
  return { ok: false, issues: r.error.issues };
}

/** True if the given (kind, data) combination is well-formed. */
export function isValidItemData(data: unknown, kind: WorkItemKind): boolean {
  return SCHEMAS[kind].safeParse(data).success;
}
