# WorkTracker — Cyberpunk Minimalist Redesign Plan

**Status:** Plan v0.1 — pending approval
**Scope:** Complete visual + interaction re-skin of the WorkTracker web UI (`web/`) and per-page design specs. Backend, data model, MCP, REST, and deploy pipeline are unchanged.
**Direction:** Dark-only. Cyan `#00E5FF` = primary/structure. Magenta `#FF2BD6` = dispatch/active/alert. Avenir Next (sans) + JetBrains Mono (mono). Near-black canvas, hairline borders, glow used sparingly.

---

## 0. TL;DR

1. Re-skin the existing 5 routes (`/`, `/login`, `/sources`, `/admin`, `/settings`) and 9 components in one token-driven pass. No new pages, no new product surface — this is a design refresh, not a feature push.
2. Replace the current `bg-* / ink-* / brand-* / status-*` token set with a single cyberpunk palette. Every component must be addressable via semantic tokens so a future revert is one diff.
3. Ship in 4 phases: **Tokens & chrome → Kanban (home) → Detail / modals / chat → Admin & settings → Polish.** Each phase ends with a visual review on the Superdesign canvas.
4. After this plan is approved, we move to Superdesign execution: design the Kanban home first, lock the visual language, then propagate the same tokens to the rest of the surfaces.

---

## 1. Design language

### 1.1 Visual principles (non-negotiable)

| # | Principle | What it means in practice |
|---|-----------|---------------------------|
| 1 | **Two-color rule** | Cyan is structure (links, focus rings, primary buttons, kanban column borders, "ready" status). Magenta is dispatch/active ("in progress" status, active drag, live pulse, send/confirm). Everything else is ink, border, or surface neutral. No third accent. |
| 2 | **Hairline > heavy** | 1px borders everywhere. 2px reserved for selected/active only. No 3px+ borders, no thick rules. |
| 3 | **Glow earns its place** | Glow is only on (a) focused input, (b) the live "in progress" card, (c) the dispatch primary button, (d) toast confirmation. Never on rest state. |
| 4 | **Negative space over decoration** | No busy gradients on cards. The canvas carries one subtle radial gradient at most. Cards are flat with a 1px border. |
| 5 | **Motion is functional** | Shimmer on loading. Scan-line on dispatch. 120ms hover transitions. 240ms slide-in for panels. No bounce/spring. No decorative parallax. |
| 6 | **Mono for data, sans for prose** | Numbers, IDs, status codes, timestamps, MCP tool names render in mono. Headings, body, labels render in Avenir Next. |
| 7 | **Status palette = cyan ladder** | All six kanban statuses derive from the same hue family (cyan→teal→violet→amber→magenta→dim), with two "alert" escapes (warning amber, danger red) reserved for the warning/danger states only. |

### 1.2 Color tokens

```
/* === canvas === */
--bg-base:      #07070D   /* page background, near-black with blue undertone */
--bg-surface:   #0C0C18   /* cards, panels */
--bg-raised:    #11111F   /* popovers, modals, menu */
--bg-sunken:    #050510   /* code blocks, terminal-feel areas */
--bg-overlay:   rgb(0 0 0 / 0.72)  /* modal scrim */

/* === ink (text) === */
--ink-1:        #F4F4FA   /* primary text */
--ink-2:        #C8C8D8   /* secondary text */
--ink-3:        #8A8AA0   /* tertiary / placeholder */
--ink-4:        #4D4D63   /* disabled */

/* === border === */
--border-subtle:  rgb(0 229 255 / 0.06)  /* hairline dividers */
--border-default: rgb(0 229 255 / 0.14)  /* card edges */
--border-strong:  rgb(0 229 255 / 0.32)  /* hover/focus */
--border-active:  #00E5FF                /* selected */

/* === brand (cyan) === */
--cyan-50:  #E0FAFF
--cyan-100: #B3F2FF
--cyan-300: #66E9FF
--cyan-400: #33E0FF
--cyan-500: #00E5FF   /* primary */
--cyan-600: #00B8CC
--cyan-700: #008C99
--cyan-glow: rgb(0 229 255 / 0.45)

/* === dispatch (magenta) === */
--magenta-50:  #FFE0F8
--magenta-300: #FF8FE5
--magenta-400: #FF5BDD
--magenta-500: #FF2BD6   /* primary magenta */
--magenta-600: #CC1FAA
--magenta-700: #991780
--magenta-glow: rgb(255 43 214 / 0.45)

/* === status (kanban column / pill) === */
--status-backlog:  #8A8AA0   /* dim grey */
--status-ready:    #00E5FF   /* cyan */
--status-progress: #FF2BD6   /* magenta */
--status-blocked:  #F59E0B   /* amber */
--status-review:   #A855F7   /* violet */
--status-done:     #22D3A4   /* mint */

/* === semantics === */
--success:  #22D3A4
--warning:  #F59E0B
--danger:   #FF4D6D
--info:     #00E5FF

/* === effects === */
--grid-line:    rgb(0 229 255 / 0.04)   /* hairline grid background */
--grid-line-2:  rgb(0 229 255 / 0.02)   /* secondary grid */
--scan-line:    rgb(255 43 214 / 0.12)  /* dispatch animation */
```

### 1.3 Typography

```
font-sans:  'Avenir Next', 'Avenir', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif
font-mono:  'JetBrains Mono', 'IBM Plex Mono', 'SF Mono', Menlo, Consolas, monospace
font-display: 'Avenir Next', 'Avenir', sans-serif  /* same as sans, no separate display */

/* scale (rem) */
--text-xs:    0.75    /* 12px — mono labels, IDs */
--text-sm:    0.8125  /* 13px — meta, timestamps */
--text-base:  0.875   /* 14px — body */
--text-md:    1.0     /* 16px — emphasized body */
--text-lg:    1.125   /* 18px — subheading */
--text-xl:    1.5     /* 24px — page title */
--text-2xl:   2.0     /* 32px — hero / board name */
--text-3xl:   2.75    /* 44px — login hero */
--text-4xl:   4.0     /* 64px — login hero (desktop) */

/* weights (Avenir Next) */
regular:  400
medium:   500
demibold: 600
bold:     700 (use sparingly — semibold first)

/* tracking */
tight:    -0.01em   /* display */
normal:    0        /* body */
wide:     +0.04em   /* mono labels, "DISPATCH" pill, "READY" status */
widest:   +0.12em   /* logo wordmark only */
```

### 1.4 Spacing, radius, motion

```
/* spacing (px) */
1, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96

/* radius (px) */
xs: 2     /* pills, badges */
sm: 4     /* inputs, small buttons */
md: 6     /* cards, buttons */
lg: 10    /* panels, modals */
xl: 14    /* hero cards (login) */
pill: 9999 /* status pills, tags */

/* elevation (dark mode — no shadow; use border + glow) */
- hairline (1px border-default)
- raised (1px border-default + bg-raised) — for modals, popovers
- glow-cyan (cyan-glow box-shadow) — focus, dispatch
- glow-magenta (magenta-glow box-shadow) — active drag, live card

/* motion (ms / curves) */
instant: 80
fast:    120
base:    200
slow:    320
easing:  cubic-bezier(0.22, 1, 0.36, 1)   /* out-quint */
easing-in: cubic-bezier(0.64, 0, 0.78, 0) /* in-quart */
```

### 1.5 Backgrounds & motifs

- **Canvas** — `#07070D` flat, with one optional 1600×900 radial at top-right (`cyan-glow 0.06` → transparent 60%). No noise. No mesh. No animated gradient.
- **Hairline grid** — repeating linear-gradient at 32px, `--grid-line`, opacity 0.4. Visible on the canvas only, hidden inside cards/panels. Toggled off for `/login` and `/admin` for visual hierarchy.
- **No "scanline" effect on the whole page** — scanline is a one-shot motion on the dispatch button, not a permanent CRT effect.

---

## 2. Functional inventory (current state)

Pulled from `web/app/`, `web/components/`, the README, and the 15 MCP tools. This is what exists today, before the redesign.

### 2.1 Routes

| Route | Purpose | Auth | Data source |
|-------|---------|------|-------------|
| `/` | Kanban board (home) | bearer | Firestore `work_items` onSnapshot |
| `/login` | Bearer/API base sign-in | public | localStorage |
| `/sources` | Connector directory + register new | bearer | `GET /api/sources`, `POST /api/sources` |
| `/admin` | Connector admin + enricher pool + boards CRUD | admin bearer | same surface + `POST/PATCH/DELETE /api/boards` |
| `/settings` | API tokens, MCP config, integrations | bearer | same surface |

### 2.2 Components (`web/components/`)

| Component | Used in | Role |
|-----------|---------|------|
| `TopBar` | all signed-in pages | Brand, board picker, search, user menu, theme toggle |
| `Modal` | new item, confirm, dialogs | Generic overlay |
| `NewItemModal` | Kanban | Quick-add item form |
| `ItemDetailsPanel` | Kanban | Right-side slide-in for item detail, comments, transitions |
| `ChatPanel` | item detail | MCP-aware inline chat (Grill/Wayfind triggers) |
| `ApiTokensSection` | settings | Token list, rotate, copy |
| `Pill` | board, column, status | Status / kind / source badge |
| `EmptyState` | kanban, sources, settings | Empty-data illustration + CTA |
| `ThemeToggle` | top bar | Light / dark switch (becomes read-only in dark-only) |

### 2.3 Features per surface

**Kanban (`/`)**
- Board picker (localStorage active_board_id; falls back to 5-column default)
- Columns rendered top-to-bottom; cards are draggable via dnd-kit
- Live `onSnapshot` from Firestore — card moves on the server, browser updates the same frame
- New item button → `NewItemModal`
- Click card → `ItemDetailsPanel` slide-in
- Filter by kind / source / owner
- Search (q) — debounced
- Dispatch (transition to in_progress) runs pre-flight (Grill + Wayfind via configured enricher)
- Conflict surfacing on column

**Login (`/login`)**
- API base URL field
- Bearer token field (paste WORKTRACKER_ADMIN_TOKEN or source token)
- Optional "remember" (localStorage)
- One-click emulator preset (`http://127.0.0.1:4001` + `local-admin`)

**Sources (`/sources`)**
- List of registered sources (name, kind, token age, last seen, item count)
- "Register new" form (name, kind, manifest, optional rotate flag)
- Conflict log per source (open conflicts → "ours / theirs / merge")
- Rotate API key inline

**Admin (`/admin`)**
- Connector Admin (same as `/sources` + delete + force-replay)
- Enricher Pool: which source runs Grill / Wayfind on transition
- Boards CRUD: list, create, edit columns/statuses, set default, delete (default is protected)
- MCP endpoint inspector: last 20 requests, status, latency

**Settings (`/settings`)**
- API tokens section (current user / source tokens, rotate, copy)
- MCP config — example Claude Desktop / Cursor snippets
- Webhooks (per-source URL + secret + last delivery)
- Danger zone — archive all, purge conflicts

### 2.4 Data & system surfaces (not in scope for the visual redesign, but referenced)

- 15 MCP tools (`worktracker_list_items`, `_get_item`, `_create_item`, `_update_item`, `_transition`, `_comment`, `_link_items`, `_set_reminder`, `_enrich`, `_dispatch`, `_list_boards`, `_get_board`, `_create_board`, `_update_board`, `_delete_board`)
- REST surface at `/api/**` (items, sources, commands, webhooks, boards)
- Auth: bearer token; admin inferred from source `kind` or well-known admin token

---

## 3. Page map (post-redesign)

Same five routes. The redesign swaps the visual language but keeps the IA. New per-page treatment:

| Route | Cyberpunk treatment | Key change vs. current |
|-------|---------------------|------------------------|
| `/login` | Hero canvas, hairline grid, oversized mono token preview, single cyan CTA | Was: simple form on radial-gradient background. Now: brand-stage — first impression sets the tone. |
| `/` (Kanban) | Top bar with mono `WORKTRACKER` wordmark; 5 columns hairline-bordered, cyan column labels, magenta "in progress" active glow; cards flat with 1px border, mono IDs, mono timestamps | Was: blue brand with soft shadow cards. Now: 1px hairline cards, mono data, magenta dispatch highlight. |
| `/sources` | Table view with mono `name` and `kind` columns, status dot, copyable token with cyan hover state, conflict log inline-expandable | Was: card grid. Now: data-dense table (cyberpunk = readable data, not decoration). |
| `/admin` | Three-tab layout (Connectors / Enrichers / Boards); each tab as a distinct sub-canvas with its own column rule | Was: single long page. Now: structured three-pane admin. |
| `/settings` | Two-column layout: nav rail left, content right; danger zone in a magenta-bordered card | Was: stacked sections. Now: clearer hierarchy. |

---

## 4. Per-page spec

### 4.1 `/login`

**Purpose:** Set the brand tone and capture the bearer token.

**Layout (desktop, 1440+):**
- Two-column split: left = brand canvas (60%), right = form (40%)
- Left canvas: wordmark `WORKTRACKER` in Avenir Next Bold, 64px, tracking widest, cyan-500. Underneath, mono subtitle `// unified work tracker` in cyan-300. Hairline grid background. One radial cyan glow top-right.
- Right form: vertically centered. Fields stacked, 320px wide, 6px radius, 1px border `--border-default`, focus state 1px cyan-500 with `cyan-glow` shadow. "Sign in" button = cyan-500 fill, `bg-base` text, 6px radius, mono caps "SIGN IN" tracking wide, magenta-glow on hover.
- Emulator preset link in mono `→ use emulator` cyan-300.
- Below form, mono caption: `POST {API_BASE}/api/health · auth: bearer`

**Layout (mobile, <768):**
- Stack: wordmark top, form below. No left column. Grid still present.

**States:**
- Default: as above.
- Submitting: button text → `…` with shimmer; button disabled.
- Error: red border on form, mono error line below: `[401] bearer token invalid`.
- Success: scan-line sweep across button (200ms), then route to `/`.

**Components used:** brand wordmark, input, button, mono link.

---

### 4.2 `/` (Kanban)

**Purpose:** Default landing — show the active board, allow drag/drop and quick actions, surface live updates.

**Chrome:**
- Top bar (60px) — sticky, 1px bottom border, `bg-base`. Contents left→right:
  - Wordmark `WORKTRACKER` (mono caps, 14px, cyan-500, tracking widest)
  - `│` hairline divider
  - Board picker dropdown (current board name, chevron, click → list of boards + "Manage boards" link to `/admin#boards`)
  - Spacer
  - Search input (mono placeholder `q: …`, 240px)
  - Filter chips (kind / source / owner — clickable, 1px border, mono label, active state = cyan-500 border)
  - `+ New` button (cyan outline, mono caps `+ NEW`)
  - User avatar (32px, hairline border, click → menu)
- Theme toggle in the user menu only (no separate toggle in the top bar — dark-only)

**Canvas:**
- Hairline grid background (32px), opacity 0.4
- 5 columns (`Open / Ready / In Progress / Blocked / Done` by default, or board-specific)
- Each column: 280–320px wide, hairline right border, header sticky within column, scroll inside column

**Column header (44px sticky):**
- 2px top border in the column's status color (cyan for Ready, magenta for In Progress, etc.)
- Mono caps label (e.g. `READY`, 11px, tracking wide, color = status)
- Item count mono `12` (ink-3)
- 3-dot menu on the right (set as default status, clear column, etc.)

**Card (1px border, 6px radius, `bg-surface`):**
- Top row: kind pill (mono, e.g. `TASK`, 10px tracking wide) + source pill (cyan-500 dot + source name, mono 11px)
- Title: Avenir Next 14px, ink-1, max 2 lines, ellipsis
- Body preview (if present): 12px ink-2, max 2 lines
- Meta row: assignee avatar (16px), timestamp (mono 11px ink-3), priority indicator (cyan/magenta hairline)
- Optional: link icons (n dependencies, m comments) — mono 11px

**Card states:**
- Rest: 1px border `--border-default`, `bg-surface`
- Hover: 1px border `--border-strong`, no shadow, cursor grab
- Active drag: 1px border `#FF2BD6`, `magenta-glow` box-shadow, 1.04 scale, cursor grabbing
- Live update (just moved by another user): brief cyan-glow pulse, 600ms

**Empty column:**
- Mono `// no items` ink-3, italic Avenir Next body, 14px

**New item modal:**
- Title field, kind select, source select, body textarea, owner field
- "Create" = cyan outline; "Create & dispatch" = magenta-fill (the dual CTA is intentional)
- Close: `Esc`, click outside, or mono `× CLOSE` top-right

**Item details panel (right slide-in, 480px, `bg-raised`):**
- Header: kind pill, title (Avenir Next 18px medium), close `×`
- Tabs: `Details / Comments / Events / Chat`
- Details: every field editable inline; field labels mono caps 10px ink-3, values Avenir Next 14px ink-1
- Comments: timeline, monospace timestamp + author, body in Avenir Next
- Events: append-only log, mono `01HW…  transition  open → in_progress  @agent`
- Chat: `ChatPanel` — sends to MCP via the chat surface, shows Grill/Wayfind results inline
- Footer: status transition buttons (cyan outline = standard, magenta fill = dispatch), `Archive`, `Delete` (red)

**Components used:** TopBar, Pill, NewItemModal, ItemDetailsPanel, ChatPanel, Modal, EmptyState.

---

### 4.3 `/sources`

**Purpose:** Connector directory + register a new connector + surface conflicts.

**Chrome:** same top bar, `SOURCES` underlined in mono.

**Layout (desktop):**
- Page title: `SOURCES` (mono, 24px, tracking wide, cyan-500)
- Subtitle: mono `// registered connectors · 7`
- "+ Register" button top-right (cyan outline)
- Data table:
  - Columns: `NAME | KIND | TOKEN | LAST SEEN | ITEMS | STATUS`
  - Row: hairline bottom border; status dot (4px) in the source's status color; name in Avenir Next 14px medium; everything else mono 12px
  - Row hover: `bg-raised`
  - Row click: opens `SourceDrawer` (right slide-in, similar to item panel)

**Source drawer (320px):**
- Name, kind, manifest URL, created at, rotated at, last seen
- Token block: `••••••••••••` + copy button (cyan-300 hover)
- "Rotate API key" (magenta outline, confirm modal)
- "Force replay last 24h" (cyan outline)
- "Unregister" (red outline, confirm modal)

**Conflict log (below table, collapsible):**
- Section title: `// open conflicts` mono 12px
- Per conflict: command id (mono), source, our-value, their-value, reason, `[ours] [theirs] [merge]` buttons
- Click `merge` opens a side-by-side diff modal

**Empty state:** mono `// no sources yet` + "Register your first connector" CTA.

**Components used:** TopBar, Modal, EmptyState, SourceDrawer (new), ConflictRow (new).

---

### 4.4 `/admin`

**Purpose:** Admin-only — manage connectors (with destructive ops), enricher pool, boards.

**Chrome:** same top bar; `ADMIN` underlined; admin badge in top bar (mono `ADMIN` pill, magenta-500 border, transparent fill).

**Layout:** three-tab nav, top of page (sticky below top bar):
- `CONNECTORS | ENRICHERS | BOARDS` (mono caps, 14px, tracking wide)
- Active tab: 2px bottom border cyan-500
- Inactive tab: ink-3, hover ink-2

**Tab 1 — Connectors:**
- Same table as `/sources` plus:
  - `DELETE` column (red outline button, confirm modal)
  - "Force replay" extended to arbitrary date range
  - Bulk select with checkboxes (hairline square, cyan check)

**Tab 2 — Enrichers:**
- A grid of 4 "agent slots" (Grill, Wayfind, both, fallback)
- Each slot: card 280×160, hairline border, mono title, source select dropdown, "Test" button (cyan outline), "Run" button (magenta outline)
- Status line below each: `last run: 12s ago · success · 1.2s`

**Tab 3 — Boards:**
- Table of boards: `NAME | COLUMNS | DEFAULT | KINDS | ACTIONS`
- Row click: `BoardEditor` slide-in (560px)
- BoardEditor:
  - Name field
  - Description (multi-line)
  - Column editor: drag-to-reorder, each column has `id`, `label`, `statuses[]`, color
  - Kind filter chips
  - "Set as default" toggle (disabled if already default)
  - "Save" (cyan fill), "Delete" (red outline, default boards disabled)

**Components used:** TopBar, Modal, EmptyState, SourceDrawer, BoardEditor (refactor of current inline board CRUD), EnricherSlot (new), Tabs (new).

---

### 4.5 `/settings`

**Purpose:** Per-user API tokens, MCP config snippets, webhook delivery, danger zone.

**Chrome:** same top bar; `SETTINGS` underlined.

**Layout:** two-column.
- Left rail (200px): section nav mono caps, active = cyan-500
  - `API TOKENS`
  - `MCP CONFIG`
  - `WEBHOOKS`
  - `DANGER ZONE`
- Right content: section detail (each ~600px wide)

**API tokens section:** list of `Source` tokens (the user is one source), with rotate/copy. New: "Create source token" form (replaces the current "create new token" if it exists, mirrors the `/sources` register flow but without the manifest URL field).

**MCP config:** per-client snippet in a sunken code block (`bg-sunken`, mono 12px, cyan-300) with copy button. Three presets: Claude Desktop, Cursor, custom JSON-RPC. Each shows the exact `config.json` / `claude_desktop_config.json` snippet.

**Webhooks:** per-source URL + secret + last delivery table. "Send test" button (magenta outline) triggers a sample event.

**Danger zone:** magenta-bordered card on a `bg-raised` background.
- "Archive all completed items" — confirm modal, type-to-confirm
- "Purge conflicts" — confirm modal
- "Reset workspace" — confirm modal, type "RESET" to confirm
- "Delete account" — disabled in admin mode, redirect to /sources for source de-registration

**Components used:** TopBar, Modal, ApiTokensSection, CodeBlock (new), SectionNav (new), DangerCard (new).

---

## 5. Documentation outline

After the visual redesign lands, the docs need a parallel update. Files to write or revise:

| File | Status | Content |
|------|--------|---------|
| `docs/design-system.md` | **new** | Color tokens, typography, spacing, motion, elevation, with copy-paste Tailwind / CSS snippets. The "source of truth" for the visual language. |
| `docs/design-language.md` | **new** | Principles (the 7 rules from §1.1), do/don't with screenshots, "what cyberpunk minimalism means here". |
| `docs/components.md` | **new** | One section per shared component: anatomy, states, props, do/don't. Sourced from `web/components/`. |
| `docs/redesign-cyberpunk-plan.md` | **this file** | Keep as historical plan; mark "shipped" once executed. |
| `docs/screens.md` | **new** | Per-page annotated screenshots + interaction notes (Kanban, Login, Sources, Admin, Settings). |
| `docs/onboarding-for-designers.md` | **new** | "How to add a new screen in this style" — 1 page, links to the above. |
| `web/README.md` | revise | Add "Design language" section pointing to `docs/design-system.md`. |
| `README.md` | revise | Add a single screenshot of the redesigned Kanban near the top. |

---

## 6. Implementation plan (phased)

Each phase ends with a visual review on the Superdesign canvas. No phase merges with the next without sign-off.

### Phase 0 — Tokens & chrome (foundation)

**Goal:** All the tokens exist, the top bar is rebuilt, the canvas background is in place. No screen content changes yet.

**Tasks:**
1. Update `web/tailwind.config.ts` — replace the `colors` block with the cyberpunk palette. Keep the semantic token names (`bg-*`, `ink-*`, `border-*`, `status-*`) so all existing class names still resolve; only the underlying RGB values change.
2. Update `web/app/globals.css` — define the new CSS variables in `:root[data-theme="dark"]`. Remove the light-theme block (dark-only). Add the hairline grid background, the radial canvas glow, and the focus / dispatch keyframes.
3. Add `font-mono` to `tailwind.config.ts` (JetBrains Mono with system fallbacks).
4. Add a `<link rel="preconnect">` for Google Fonts in `web/app/layout.tsx` and load JetBrains Mono (400, 500) — Avenir Next stays local per user preference.
5. Update `components/TopBar.tsx`:
   - Wordmark in mono caps, cyan-500
   - Remove the theme toggle (or move to a user-menu item that says "Theme: Dark" disabled)
   - Add a 1px bottom border in `--border-subtle`
6. Update `components/Pill.tsx` to read from the new status palette.
7. Add the hairline grid background to the main layout (`app/layout.tsx`).
8. Verify: `npm run dev:web` loads, every existing page still renders, palette is right, no console errors.

**Acceptance:** `localhost:3000` shows the new palette on every existing page. Existing copy, layouts, interactions unchanged. Token-only swap.

**Design review:** Superdesign canvas — drop a single "foundations" page showing color tokens, type scale, spacing, motion.

---

### Phase 1 — `/login` (brand stage)

**Goal:** Establish the visual language in the most-controlled surface. Lock the look here before the more complex Kanban.

**Tasks:**
1. Rewrite `app/login/page.tsx` per §4.1.
2. Build a new `components/BrandCanvas.tsx` (wordmark + subtitle + radial glow + grid) for reuse on `/` and `/login`.
3. Add `components/Button.tsx` if not present — variants: `primary` (cyan fill), `dispatch` (magenta fill), `outline-cyan`, `outline-magenta`, `danger`. Mono caps label, tracking wide.
4. Add `components/Input.tsx` — focus state with cyan-glow.
5. Verify form still wires to `localStorage` and routes to `/` on success.

**Acceptance:** login feels like a stage, not a form. One form per design.

**Design review:** Superdesign canvas — login at 1440, 1024, 768, 375.

---

### Phase 2 — `/` (Kanban) home

**Goal:** The center of the product. Most of the user's time is here. This is the make-or-break screen.

**Tasks:**
1. Rebuild `app/page.tsx` per §4.2. Pull column header, card, board picker, search, filters, top-bar new button.
2. Refactor `components/ItemDetailsPanel.tsx` for the new tabbed layout (Details / Comments / Events / Chat). The chat tab uses the existing `ChatPanel`.
3. Update `components/NewItemModal.tsx` to the dual CTA (`Create` / `Create & dispatch`).
4. Update `components/ChatPanel.tsx` to the cyberpunk look (mono timestamps, cyan user bubbles, magenta agent bubbles, sunken background for the message stream).
5. Add a 32px hairline grid to the kanban canvas.
6. Confirm `dnd-kit` drag handle still works with the new card border / scale state.
7. Confirm `onSnapshot` still drives the live pulse (cyan-glow 600ms on a card that another user just moved).

**Acceptance:** Kanban reads as a calm, data-dense surface. Cyan = structure, magenta = dispatch highlight. No busy decoration. Drag still smooth.

**Design review:** Superdesign canvas — default board, 3 boards (one empty, one busy, one with a card in active drag), the details panel open, the new item modal, the chat panel.

---

### Phase 3 — `/sources` and `/admin`

**Goal:** Data-dense surfaces — these are the admin's daily work area.

**Tasks:**
1. Build `app/sources/page.tsx` per §4.3 — table, drawer, conflict log.
2. Add `components/SourceDrawer.tsx` (new) and `components/ConflictRow.tsx` (new).
3. Rebuild `app/admin/page.tsx` per §4.4 — three-tab layout, with the new `components/EnricherSlot.tsx`, the refactored `BoardEditor`, and a `components/Tabs.tsx` primitive.
4. Confirm the admin-only gate still works (the admin badge in the top bar should be a no-op if the user isn't admin — just hidden).

**Acceptance:** sources and admin are table-first, hairline-first, mono-heavy. Conflict resolution is the most action-rich surface in the app and reads as such.

**Design review:** Superdesign canvas — sources with a conflict open, admin with each tab.

---

### Phase 4 — `/settings` and polish

**Goal:** Settings + the final pass — keyboard, screen-reader, motion-reduce, edge cases.

**Tasks:**
1. Rebuild `app/settings/page.tsx` per §4.5 — two-column with section nav.
2. Add `components/SectionNav.tsx`, `components/CodeBlock.tsx`, `components/DangerCard.tsx`.
3. Wire up the MCP config snippets (Claude Desktop, Cursor, custom) — generate from the actual server config.
4. Polish pass across all pages:
   - Keyboard focus rings (cyan-glow) consistent
   - `prefers-reduced-motion` honored (no shimmer, no scan-line, no slide-in)
   - Empty states redrawn for the cyberpunk look
   - Error states get a mono error line `[code] message`
   - Loading states get a shimmer on the affected region only
5. Add a `not-found.tsx` and `error.tsx` at the app root in the same style.
6. Lighthouse / a11y audit (target: a11y ≥ 95, perf ≥ 90 on the kanban).

**Acceptance:** every route is on-style, every interaction is keyboard-accessible, every error has a mono message, the app is reduced-motion-safe.

**Design review:** Superdesign canvas — settings with each section, the not-found page, the error page.

---

## 7. Risks & dependencies

| # | Risk | Mitigation |
|---|------|------------|
| 1 | **Avenir Next availability** — local to the user's machine; on shared devices (e.g. preview deploys) it falls back to system sans. | Keep the fallback chain (`Avenir Next, Avenir, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif`). Document the design intent in `docs/design-system.md` so reviewers don't flag the fallback. |
| 2 | **Dark-only excludes daytime use** — the user works across time zones; some hours the dark UI may be harsh. | Provide a single user-menu toggle "Theme: Dark" (disabled) and a one-line comment in code: "dark-only per product direction". If users push back, add a light theme later — token-driven, so it's a single mapping change. |
| 3 | **Cyberpunk "minimalism" can read as cold or sterile** | Soften with: 1px grid background (not pure black), mono caps with `wide` tracking (not `widest`), and a single radial cyan glow on the canvas top-right. No scanline overlay. |
| 4 | **Mono everywhere becomes unreadable** | Restrict mono to data (numbers, IDs, timestamps, MCP tool names, status pills, button labels). Body prose stays Avenir Next. |
| 5 | **dnd-kit visual regression** — new border / scale on active drag may interact with the lib's transform. | Phase 2 has an explicit verification step. If dnd-kit's transform conflicts, move scale to a wrapper, not the drag target. |
| 6 | **`onSnapshot` pulse can be visually loud if many items move at once** | Throttle the pulse: only pulse the topmost moved card in the viewport per second. |
| 7 | **Backwards compatibility with existing screenshots / docs** | Once Phase 0 lands, update the README's screenshot. Plan to roll the design system docs in parallel, not after. |
| 8 | **Firestore security rules interaction** — none. Visual redesign is UI-only. | N/A. |

---

## 8. Open questions (for the user, not blocking)

1. **Should the admin `/admin` route remain at `/admin`, or move to `/settings/admin`?** Current is `/admin`. The redesign preserves it; just confirming.
2. **Should the user-menu theme toggle be removed entirely, or kept as a disabled "Theme: Dark" line?** Recommend removed entirely.
3. **Brand wordmark** — keep `WORKTRACKER` in mono caps, or do you want a logotype (custom glyph) later? Recommend keep mono caps for v1; revisit at v2.
4. **MCP config snippets** — auto-generate from the current server config, or maintain as static copy? Recommend auto-generate (the snippet needs to know the API base the user signed in with).
5. **Sounds** — should the dispatch action have an audio cue? Recommend no; cyberpunk minimalism is visual-only.

---

## 9. Next step (after approval)

Run `superdesign init` to read this codebase and build `.superdesign/init/` so the design drafts can pull in real components, routes, and tokens. Then design the Kanban home first (`/`) on the canvas — that's the screen that locks the visual language. Propagate the same tokens to login → sources → admin → settings in that order. Each phase ends with a canvas review.
