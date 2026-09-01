/**
 * Tool definitions for the AI brain. Mirrors the 15 MCP tools
 * in apps/api/src/mcp.ts but in the OpenAI function-calling
 * format. Same parameter schemas; descriptions are slightly
 * reworked for the AI audience (a person talking to the model,
 * not an external client).
 *
 * The same handlers back both surfaces: when the model invokes
 * a tool, the chat route dispatches to handleToolCall with the
 * user's auth, so writes go through the same brain command
 * queue as MCP clients (read-your-writes semantics, audit log,
 * same RBAC).
 */

import type { ChatTool } from './client.js';

const worktracker_list_items: ChatTool = {
  type: 'function',
  function: {
    name: 'worktracker_list_items',
    description: 'List work items the user can see. Optional filters: kind, status, source, owner, a search string, and how many to return. Use this first when the user asks about my work, what is open, what is assigned to X, etc.',
    parameters: {
      type: 'object',
      properties: {
        kind:        { type: 'string', enum: ['task', 'ticket', 'decision', 'review'] },
        status:      { type: 'string', description: 'open, ready, in_progress, blocked, done, cancelled' },
        source:      { type: 'string' },
        owner:       { type: 'string' },
        q:           { type: 'string' },
        limit:       { type: 'number', minimum: 1, maximum: 200 },
        include_archived: { type: 'boolean' },
      },
    },
  },
};

const worktracker_get_item: ChatTool = {
  type: 'function',
  function: {
    name: 'worktracker_get_item',
    description: 'Get one work item by id, including its event timeline (comments, transitions).',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
};

const worktracker_create_item: ChatTool = {
  type: 'function',
  function: {
    name: 'worktracker_create_item',
    description: 'Create a new work item. Only `kind` and `title` are required; everything else is optional. Use this when the user says "create", "add", "log", "remind me to", etc.',
    parameters: {
      type: 'object',
      properties: {
        kind:        { type: 'string', enum: ['task', 'ticket', 'decision', 'review'] },
        title:       { type: 'string' },
        body:        { type: 'string' },
        severity:    { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        priority:    { type: 'string', enum: ['low', 'medium', 'high'] },
        owner:       { type: 'string' },
        due_at:      { type: 'string', description: 'ISO 8601' },
      },
      required: ['kind', 'title'],
    },
  },
};

const worktracker_update_item: ChatTool = {
  type: 'function',
  function: {
    name: 'worktracker_update_item',
    description: 'Patch fields on a work item. Requires the current `expected_version` for optimistic concurrency. Pass `archived_at: null` to unarchive, or a timestamp to archive.',
    parameters: {
      type: 'object',
      properties: {
        id:               { type: 'string' },
        patch:            { type: 'object' },
        expected_version: { type: 'number' },
      },
      required: ['id', 'patch', 'expected_version'],
    },
  },
};

const worktracker_transition: ChatTool = {
  type: 'function',
  function: {
    name: 'worktracker_transition',
    description: 'Move a work item to a new status (e.g. open → in_progress). Requires the current `expected_version`. Pass `force_dispatch: true` to also run Grill + Wayfind enrichment before the transition.',
    parameters: {
      type: 'object',
      properties: {
        id:               { type: 'string' },
        to_status:        { type: 'string' },
        comment:          { type: 'string' },
        force_dispatch:   { type: 'boolean' },
        expected_version: { type: 'number' },
      },
      required: ['id', 'to_status', 'expected_version'],
    },
  },
};

const worktracker_comment: ChatTool = {
  type: 'function',
  function: {
    name: 'worktracker_comment',
    description: 'Append a comment to a work item\'s event timeline. Use this when the user says "add a note", "comment on…", "log that…", etc.',
    parameters: {
      type: 'object',
      properties: {
        id:               { type: 'string' },
        body:             { type: 'string' },
        expected_version: { type: 'number' },
      },
      required: ['id', 'body'],
    },
  },
};

const worktracker_link_items: ChatTool = {
  type: 'function',
  function: {
    name: 'worktracker_link_items',
    description: 'Link two work items with a relationship. Use `parent_id` and `child_id` (or any two items) and a `kind` describing the relationship.',
    parameters: {
      type: 'object',
      properties: {
        parent_id: { type: 'string' },
        child_id:  { type: 'string' },
        kind:      { type: 'string', enum: ['depends_on', 'blocks', 'related', 'mirrors', 'parent_of'] },
      },
      required: ['parent_id', 'child_id', 'kind'],
    },
  },
};

const worktracker_list_boards: ChatTool = {
  type: 'function',
  function: {
    name: 'worktracker_list_boards',
    description: 'List all kanban boards the user can see, with their columns and kind filter. Use this to know what boards exist before creating or switching.',
    parameters: { type: 'object', properties: {} },
  },
};

const worktracker_get_board: ChatTool = {
  type: 'function',
  function: {
    name: 'worktracker_get_board',
    description: 'Get one board by id, including its column definitions.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
};

const worktracker_create_board: ChatTool = {
  type: 'function',
  function: {
    name: 'worktracker_create_board',
    description: 'Create a new kanban board. Requires `name` and `columns` (each column has id, label, and a list of statuses it covers). Pass `is_default: true` to make it the landing board. ADMIN only — fails for non-admins.',
    parameters: {
      type: 'object',
      properties: {
        name:        { type: 'string' },
        description: { type: 'string' },
        kinds:       { type: 'array', items: { type: 'string', enum: ['task', 'ticket', 'decision', 'review'] } },
        columns:     {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              id:       { type: 'string' },
              label:    { type: 'string' },
              statuses: { type: 'array', items: { type: 'string' }, minItems: 1 },
              kinds:    { type: 'array', items: { type: 'string', enum: ['task', 'ticket', 'decision', 'review'] } },
            },
            required: ['id', 'label', 'statuses'],
          },
        },
        is_default:  { type: 'boolean' },
      },
      required: ['name', 'columns'],
    },
  },
};

const worktracker_update_board: ChatTool = {
  type: 'function',
  function: {
    name: 'worktracker_update_board',
    description: 'Patch a board (rename, change columns, toggle is_default). ADMIN only.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        kinds: { type: 'array', items: { type: 'string', enum: ['task', 'ticket', 'decision', 'review'] } },
        columns: { type: 'array', items: { type: 'object' } },
        is_default: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
};

const worktracker_delete_board: ChatTool = {
  type: 'function',
  function: {
    name: 'worktracker_delete_board',
    description: 'Delete a board by id. Cannot delete the default board. ADMIN only.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
};

const worktracker_enrich: ChatTool = {
  type: 'function',
  function: {
    name: 'worktracker_enrich',
    description: 'Run the Grill or Wayfind enricher on a work item. Stage "both" runs both. Use when the user says "analyze", "enrich", "fill in the details", or "what should I do about X".',
    parameters: {
      type: 'object',
      properties: {
        id:       { type: 'string' },
        stage:    { type: 'string', enum: ['grill', 'wayfind', 'both'] },
        enricher: { type: 'string' },
      },
      required: ['id', 'stage'],
    },
  },
};

const worktracker_dispatch: ChatTool = {
  type: 'function',
  function: {
    name: 'worktracker_dispatch',
    description: 'High-level "ship it" tool: pre-flight + missing enrichment + transition. Returns a job id. Use when the user says "ship", "dispatch", "do the whole flow".',
    parameters: {
      type: 'object',
      properties: {
        id:      { type: 'string' },
        options: {
          type: 'object',
          properties: {
            force:    { type: 'boolean' },
            enricher: { type: 'string' },
            stages:   { type: 'array', items: { type: 'string', enum: ['grill', 'wayfind'] } },
          },
        },
      },
      required: ['id'],
    },
  },
};

const worktracker_set_reminder: ChatTool = {
  type: 'function',
  function: {
    name: 'worktracker_set_reminder',
    description: 'Set a reminder on a work item. v0.5 stub — currently returns `{ accepted: false, reason: "v0.5" }`. Tell the user this is not implemented yet if they try to use it.',
    parameters: {
      type: 'object',
      properties: {
        item_id:   { type: 'string' },
        remind_at: { type: 'string' },
        channel:   { type: 'string' },
        target:    { type: 'string' },
      },
      required: ['item_id', 'remind_at', 'channel', 'target'],
    },
  },
};

export const AI_TOOLS: ChatTool[] = [
  worktracker_list_items,
  worktracker_get_item,
  worktracker_create_item,
  worktracker_update_item,
  worktracker_transition,
  worktracker_comment,
  worktracker_link_items,
  worktracker_list_boards,
  worktracker_get_board,
  worktracker_create_board,
  worktracker_update_board,
  worktracker_delete_board,
  worktracker_enrich,
  worktracker_dispatch,
  worktracker_set_reminder,
];

/** Map of tool name → ChatTool for quick lookup. */
export const AI_TOOLS_BY_NAME = new Map(AI_TOOLS.map((t) => [t.function.name, t]));
