/**
 * Protocol module registry (slice 6).
 *
 * Eight modules cover the agents the architecture plan calls
 * out. Each module declares:
 *   - `name`             the agent's stable identifier
 *   - `display_name`     for the UI
 *   - `agent`            one of the architecture §3.7 agent tags
 *   - `transport`        'http' (json-rpc 2.0) | 'stdio' (subprocess)
 *   - `endpoint_template` the URL or command the user configures
 *                        in their MCP client; `{bearer}` is replaced
 *                        at install time
 *   - `install_steps`    human-readable setup instructions
 *   - `verify_command`   a shell command the wizard runs as the
 *                        final "verify" step (a curl that hits
 *                        /api/clients/introspect with the bearer)
 *
 * The wizard (slice 7) iterates this registry, the docs page
 * references it, and the connector's `protocol` field matches
 * one of these `agent` tags so the connector knows which impl
 * to dispatch against.
 *
 * Adding a new module: add a row below, the rest is automatic.
 */

export const PROTOCOL_TRANSPORTS = ['http', 'stdio'] as const;
export type ProtocolTransport = (typeof PROTOCOL_TRANSPORTS)[number];

export const PROTOCOL_AGENTS = [
  'claude-code',
  'codex',
  'cline',
  'copilot',
  'cursor',
  'openclaw',
  'hermes',
  'custom',
] as const;
export type ProtocolAgent = (typeof PROTOCOL_AGENTS)[number];

export interface ProtocolModule {
  name: ProtocolAgent;
  display_name: string;
  /** Short paragraph the wizard and docs page render verbatim. */
  blurb: string;
  transport: ProtocolTransport;
  /**
   * URL (transport: 'http') or shell command template
   * (transport: 'stdio') the user pastes into their MCP client
   * config. `{bearer}` and `{url}` are replaced at install time
   * with the freshly-minted client credential and the live
   * server URL respectively.
   */
  endpoint_template: string;
  /**
   * Ordered install steps. Each step renders as a numbered
   * instruction in the wizard. The wizard's verify step
   * (final) runs the `verify_command` after these complete.
   */
  install_steps: string[];
  /** Shell command the wizard runs as the "verify it works" step. */
  verify_command: string;
}

export const PROTOCOL_REGISTRY: ProtocolModule[] = [
  {
    name: 'claude-code',
    display_name: 'Claude Code',
    blurb:
      "Anthropic's CLI coding agent. Reads MCP servers from `~/.claude.json` or `.mcp.json` in the project root.",
    transport: 'http',
    endpoint_template: JSON.stringify(
      {
        mcpServers: {
          worktracker: {
            type: 'http',
            url: '{url}/mcp/stream',
            headers: { Authorization: 'Bearer {bearer}' },
          },
        },
      },
      null,
      2,
    ),
    install_steps: [
      'Copy the JSON block above.',
      'Open `~/.claude.json` (or your project `.mcp.json`) and paste it as a top-level `mcpServers` key.',
      'Run `claude` from any directory; the agent auto-connects on first prompt.',
    ],
    verify_command:
      "curl -sS -H 'Authorization: Bearer {bearer}' '{url}/api/clients/introspect' | jq .name",
  },
  {
    name: 'codex',
    display_name: 'Codex CLI',
    blurb:
      "OpenAI's CLI coding agent. Reads MCP servers from `~/.codex/config.toml`.",
    transport: 'http',
    endpoint_template: '[mcp_servers.worktracker]\nurl = "{url}/mcp/stream"\nbearer_token = "{bearer}"',
    install_steps: [
      'Append the TOML block to `~/.codex/config.toml` (create the file if it does not exist).',
      'Restart `codex` so it picks up the new server.',
    ],
    verify_command:
      "curl -sS -H 'Authorization: Bearer {bearer}' '{url}/api/clients/introspect' | jq .scope",
  },
  {
    name: 'cline',
    display_name: 'Cline',
    blurb:
      "VS Code AI extension. Configures MCP servers in the Cline panel (gear icon → MCP Servers).",
    transport: 'http',
    endpoint_template: JSON.stringify(
      {
        mcpServers: {
          worktracker: {
            url: '{url}/mcp/stream',
            type: 'http',
            headers: { Authorization: 'Bearer {bearer}' },
          },
        },
      },
      null,
      2,
    ),
    install_steps: [
      'Open the Cline panel in VS Code.',
      'Click the gear icon, then "MCP Servers" → "Configure MCP Servers".',
      'Paste the JSON block above and save.',
    ],
    verify_command:
      "curl -sS -H 'Authorization: Bearer {bearer}' '{url}/api/clients/introspect' | jq .visible_tools | length",
  },
  {
    name: 'copilot',
    display_name: 'GitHub Copilot',
    blurb:
      "GitHub's agent. MCP support is rolling out; the canonical config path is the editor's MCP panel.",
    transport: 'http',
    endpoint_template: JSON.stringify(
      { mcpServers: { worktracker: { url: '{url}/mcp/stream', headers: { Authorization: 'Bearer {bearer}' } } } },
      null,
      2,
    ),
    install_steps: [
      'Open the Copilot panel in your editor.',
      'Add an MCP server pointing at the URL above with the bearer header.',
    ],
    verify_command:
      "curl -sS -H 'Authorization: Bearer {bearer}' '{url}/api/clients/introspect' | jq .name",
  },
  {
    name: 'cursor',
    display_name: 'Cursor',
    blurb:
      "Cursor reads MCP servers from `~/.cursor/mcp.json` or a project-level `.cursor/mcp.json`.",
    transport: 'http',
    endpoint_template: JSON.stringify(
      { mcpServers: { worktracker: { url: '{url}/mcp/stream', headers: { Authorization: 'Bearer {bearer}' } } } },
      null,
      2,
    ),
    install_steps: [
      'Open `~/.cursor/mcp.json` (or your project `.cursor/mcp.json`).',
      'Add the JSON block under `mcpServers`.',
      'Restart Cursor so it loads the new server.',
    ],
    verify_command:
      "curl -sS -H 'Authorization: Bearer {bearer}' '{url}/api/clients/introspect' | jq .server_version",
  },
  {
    name: 'openclaw',
    display_name: 'OpenClaw',
    blurb:
      "OpenClaw is WorkTracker's own bridge daemon. Installs as a systemd unit; calls the same /mcp/stream endpoint.",
    transport: 'http',
    endpoint_template: JSON.stringify(
      { mcpServers: { worktracker: { url: '{url}/mcp/stream', headers: { Authorization: 'Bearer {bearer}' } } } },
      null,
      2,
    ),
    install_steps: [
      'Run the OpenClaw installer (download link in the wizard).',
      'Paste the bearer it returns into the bridge config.',
    ],
    verify_command:
      "curl -sS -H 'Authorization: Bearer {bearer}' '{url}/api/clients/introspect' | jq .visible_tools",
  },
  {
    name: 'hermes',
    display_name: 'Hermes',
    blurb:
      "WorkTracker's local-first kanban daemon. Two-sided install: this wizard mints a bearer, the daemon is installed separately on the same machine.",
    transport: 'http',
    endpoint_template: JSON.stringify(
      { mcpServers: { worktracker: { url: '{url}/mcp/stream', headers: { Authorization: 'Bearer {bearer}' } } } },
      null,
      2,
    ),
    install_steps: [
      'Install the daemon: `brew install hermes-kanban` (or download from the link below).',
      'Run `hermes install`; it will prompt for the bearer below.',
      'Paste the bearer into the prompt.',
    ],
    verify_command:
      "curl -sS -H 'Authorization: Bearer {bearer}' '{url}/api/clients/introspect' | jq .name",
  },
  {
    name: 'custom',
    display_name: 'Custom HTTP client',
    blurb:
      "Anything that speaks JSON-RPC 2.0 over HTTP. Use the raw URL and bearer below; no client config file needed.",
    transport: 'http',
    endpoint_template: 'POST {url}/mcp/stream\nAuthorization: Bearer {bearer}\nContent-Type: application/json\n\n{ "jsonrpc":"2.0","id":1,"method":"tools/list" }',
    install_steps: [
      'Point your client at the URL above.',
      'Pass the bearer in the `Authorization` header on every request.',
      'The `tools/list` response lists the 23 tools you can call.',
    ],
    verify_command:
      "curl -sS -H 'Authorization: Bearer {bearer}' '{url}/api/clients/introspect' | jq .visible_tools | length",
  },
];

/**
 * Look up a protocol module by agent tag. Returns `null` if the
 * agent is unknown so the wizard can render an honest "this
 * agent is not yet supported" message.
 */
export function findProtocol(name: string): ProtocolModule | null {
  return PROTOCOL_REGISTRY.find((m) => m.name === name) ?? null;
}

/**
 * Render an `endpoint_template` with `{url}` and `{bearer}`
 * placeholders substituted. Used by the wizard's "copy config"
 * step and by the connectors "invite" endpoint.
 */
export function renderEndpoint(template: string, url: string, bearer: string): string {
  return template.replace(/\{url\}/g, url).replace(/\{bearer\}/g, bearer);
}
