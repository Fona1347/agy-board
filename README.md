# Agy Board (`agy-board`)

Workspace-linked Kanban, Focus & Todo board plugin for **Antigravity** (`SIDECAR_UI_ENTRYPOINT_AUX_PANE` and `SIDECAR_UI_ENTRYPOINT_SIDEBAR`), built with TypeScript, React, `@dnd-kit`, and Node 22+ native `node:sqlite`.

[![Agy Board Demo Preview](https://github.com/Fona1347/agy-board/releases/download/v0.1.0/agy-board-preview.gif)](https://github.com/Fona1347/agy-board/releases/download/v0.1.0/agy-board-promo-45s.mp4)

> Click the preview above (or download [`agy-board-promo-45s.mp4`](https://github.com/Fona1347/agy-board/releases/download/v0.1.0/agy-board-promo-45s.mp4)) to watch the full 45s HD demo.

Designed for standalone Antigravity plugin installation (zero `node_modules` required on disk) and clean upstream pinning via `agy-kit` (**Scheme B compatible**, zero DOM/footer/shortcut interference).

## Quick Install (Antigravity Plugin)

Requires **Node.js 22.13+** (for built-in `node:sqlite`).

1. Download `agy-board-v0.1.0.zip` from [GitHub Releases](https://github.com/Fona1347/agy-board/releases).
2. Extract it into your Antigravity plugins directory as `~/.gemini/config/plugins/agy-board/` (on Windows: `%USERPROFILE%\.gemini\config\plugins\agy-board\`).
3. Open **Customizations → Plugins** in Antigravity to verify **Agy Board** is enabled, then open **Agy Board** from the left `Plugins` sidebar or the right Auxiliary Pane (`+`).

> Want to preview every UI state without touching your real tasks? Open **Filters & Settings → Demo Sandbox** inside the board for an isolated in-memory showcase.

## Architecture Overview

- **Core Domain (`src/core/`)**: Pure zero-dependency TypeScript domain logic (`types`, `freeze`, `handover`, `subgoals`, `schedule`, `session-reuse`, `workspace`).
- **Authoritative Host (`src/host/`)**:
  - `db.ts`: `node:sqlite` WAL database with schema migrations (including composite `(task_id, id)` `task_subgoals`, `task_comments`, `task_refs`, `task_conversations`, `task_executions`, `task_events`, `task_user_marks`, and worktree columns) + `dispatch.lock.<executionId>` in-flight protection + optional `recoverOrphans` startup recovery.
  - `board-service.ts`: Unified mutation, validation, TaskSpace Markdown projection, dual Write Gate, dispatch, and scheduler engine shared by HTTP/Sidecar, MCP, Hooks, and CLI.
  - `workspaces.ts`: Read-only discovery of Antigravity projects (`~/.gemini/config/projects/*.json`, including multi-folder workspaces) and `conversation_summaries.db` (conditional `not_fully_idle` support + full conversation lookup by ID + subagent lineage resolution), merged with custom editable workspaces.
  - `agent-bridge.ts`: Antigravity Language Server `ConversationService` (`CreateConversation`, `GetConversation`, `ListConversations`, `UpdateConversation`) via Connect HTTP+JSON (with HTTP 400/426 -> HTTPS TLS fallback and verified daemon discovery), `agentapi` CLI fallback (stripping caller `ANTIGRAVITY_CONVERSATION_ID`/`ANTIGRAVITY_PROJECT_ID` on unbound launches), and loopback CDP navigation (`/c/<id>`).
  - `worktree.ts`: Opt-in Git worktree isolation under `.worktrees/agy-board-<taskId>` (`agy-board/<taskId>`).
  - `scheduler.ts`: `SidecarOwner` single-leader lockfile (`<boardDir>/scheduler.owner.json`) + `BoardScheduler` periodic tick.
  - `refs-guard.ts`: Strict allowlisted TaskSpace file preview with symlink-escape and device-path guards.
  - `launch-admission.ts`: Round-robin fair concurrency cap (`LaunchAdmissionQueue`).
- **Entrypoints (`src/entry/`, bundled into `dist/*` & `sidecars/board/server.mjs`)**:
  - `sidecar.ts` / `router.ts` / `server-core.ts`: Dual-mode `sidecar_sdk` `SidecarApp` (with async `/_sidecar/*` overrides after `app.run()`) and standalone loopback HTTP+SSE server.
  - `mcp.ts`: Stdio MCP server (15 tools + `ui://agy-board/card.html` inline MCP App card resource).
  - `hook.ts`: Antigravity lifecycle hook handler (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`), exiting early with `{"decision":"allow"}` without creating a phantom `board.db` when the board has not been initialized.
  - `cli.ts`: Standalone CLI (`serve`, `doctor`, `workspaces`, `list`, `create`, `dispatch`).

## Features

- **4-Tier Asymmetric Kanban & 3 Views (Hong / DSH Minimalist UI)**:
  - **Tiers**: `Needs You` (`review`, `blocked`, `needs_input`, `permission_pending`, `reminder_due`) · `Active & On Hold` (asymmetric split lane; `On Hold` is system-managed and rejects manual drops) · `Todo` (`ready`, `backlog`) · `Closed` (`done`, `cancelled`, collapsible with `Today` / `Yesterday` / `Last 7 Days` / `Older` time buckets).
  - **Views**:
    - `Focus` (`焦点`, first-time default view): sorts non-closed tasks earliest-DDL-first (`overdue` → `today` → `tomorrow` → `upcoming` → `undated`) along a left DDL timeline rail, with an `已忽略 N 件` recovery box at the bottom.
    - `Kanban` (`看板`): `@dnd-kit` drag & drop across lanes (`On Hold` drop-protected) with restrained zero-button normal cards, Inbox action buttons only on `Needs You`, and semantic full-card tints (`tint-ok` green for `review`, `tint-warn` amber for `needs_input`/`permission_pending`/`reminder_due`, `tint-active` blue for `active`, `tint-danger` red for `on_hold`/`blocked`, neutral `#2f2f2d`/`#FFFFFF` for `todo`).
    - `List` (`列表`): Master-Detail split view supporting `Group by Status` / `Group by Workspace` (collapsing to responsive drill-down below `740px`).
  - **Progressive Disclosure & Host-Synced Dual Palette**: First-class `dueAt` DDL input in `New Task` with `More options` (`更多设置`) and `Advanced settings` (`高级设置`) folded by default; persistent `task_comments`, `MarkdownText`, `TaskHandover` inspection, 3-way `[跟随 agy | 浅色 | 深色]` host-following theme (`#262624` / `#2f2f2d` / `#CF8F50` Dark & `#F9F9F7` / `#FFFFFF` / `#B45309` Light), and EN/中文 i18n toggle.
- **Workspace Linking & Cross-Workspace Dispatch / Jump / Split / Rework / Relay**:
  - Multi-folder workspace dropdown listing all `folderPaths`, preserving exact subfolder paths, and filtering strictly by selected path.
  - `[This Workspace]` filter syncs live with Antigravity via `window.sidecar.getWorkspaceUris()` / `onWorkspaceChange()`.
  - Launch a `New Session` / `Relay / New`, `Resume` an idle conversation, send inline `Rework` instructions into an existing conversation, `Jump` / `Jump & Reply` (`toggleConversation` in Aux Pane / CDP `/c/<id>` standalone), open `Split ↗` (`{ split: 'right' }`), or toggle `Auto-open session` on dispatch.
- **Subgoals, TaskSpace Read-Only Projection & Dual Write Gate**:
  - Lightweight subgoals with composite `(task_id, id)` primary key, `required` vs `optional` flags, dependency cycle validation, drag reordering (`POST /api/tasks/subgoals/reorder`), and per-subgoal conversation dispatch.
  - Completing or deleting subgoals so all `required` subgoals finish automatically settles open executions and rolls an `active` task into `needs_you` (`review`); closing is gated unless `force=true`.
  - Read-only TaskSpace Markdown projection (`<boardDir>/taskspace/<taskId>.md`) for `active` / `needs_you` tasks, plus allowlisted `task_refs` preview (`RefPreviewModal`) with properly percent-encoded `file:///` URIs for `fileView` / `addArtifactComment` (guarded off for URL/command previews).
  - **Dual Write Gate**: Enforced in **both** `PreToolUse` (`dist/hook.mjs`, including `mcp_agy-board_board_*` tool matchers and subagent lineage fallback) **and** inside MCP handlers (`dist/mcp.mjs`). Locked tasks block workspace file/shell mutations as well as closing, archiving, deleting, or unlocking `writeGate` from a locked conversation; even when `writeGate === 'unlocked'`, direct writes and shell mutations (`rm`/`rmdir`/redirects) targeting `board.db*`, `<boardDir>/taskspace/*.md`, and `handover.references` are always blocked.
  - **Freeze & Handover Security**: `FreezeSnapshot` (`<<<FREEZE ... >>>FREEZE`) redacts credentials (`sk-`, `Bearer`, `ghp_`, `gho_`, `github_pat_`, `glpat-`, `xox*`, `AKIA`, `AIza`, PEM private keys), rejects `/command` lines, enforces an 8 KiB per-field UTF-8 cap, and unlocks pre-launch errors automatically (`isTaskContentFrozen`). `TaskHandover` + human-only UI confirmation gate re-arms on any permission or handover change.
- **Git Worktree Isolation**:
  - Enable `useWorktree` per task or dispatch to isolate work inside `<repo>/.worktrees/agy-board-<taskId>` on branch `agy-board/<taskId>`, inspect git status & diffs (`GET /api/tasks/worktree/diff`), and clean up (`POST /api/tasks/worktree/cleanup`).
- **MCP Tools, Inline MCP App Card & Hooks**:
  - **15 MCP Tools** (`mcp_config.json` -> `dist/mcp.mjs`):
    `board_list`, `board_get`, `board_card`, `board_workspaces`, `board_create`, `board_update`, `board_transition`, `board_plan_breakdown`, `plan_to_board`, `board_subgoal_update`, `board_comment_add`, `board_ref_add`, `board_dispatch`, `board_schedule`, `next_ready_task`. (Intentionally omits `confirm_permission`.)
  - **Inline MCP App Card Resource**: `ui://agy-board/card.html` (`text/html;profile=mcp-app`), linked via `_meta.ui.resourceUri` on `board_list`, `board_get`, and `board_card`.
  - **Lifecycle Hooks** (`hooks.json` -> `dist/hook.mjs`): `SessionStart` context injection, `PreToolUse` Dual Write Gate & `ask_question` pause (`needs_you/needs_input`), `PostToolUse` deliverable auto-capture & `ask_question` resume (non-error only), and `Stop` transcript summary (`PLANNER_RESPONSE` / `CORTEX_STEP_TYPE_PLANNER_RESPONSE`) & strict `openExec.conversationId === directConv` execution settlement.
- **Cron, Reminders & `SidecarOwner`**:
  - One-time reminders (`reminderAt`), `once` schedules, and zone-aware 5-field Vixie cron rules (`Intl.DateTimeFormat`, DST-safe) with launch-failure budget refunding (`cron` and `once` within the 5-minute grace window).
  - Multi-window single-leader locking via `SidecarOwner` (`<boardDir>/scheduler.owner.json`) prevents duplicate triggers across Antigravity windows.

## Repository Layout

```text
agy-board/
├── plugin.json                 # Antigravity native plugin manifest
├── mcp_config.json             # MCP stdio server entry (${PLUGIN_ROOT}/dist/mcp.mjs)
├── hooks.json                  # Antigravity lifecycle hooks (dist/hook.mjs)
├── agy-kit.compat.json         # agy-kit Scheme B spatial isolation & runtime_entries manifest
├── assets/logo.svg             # Plugin logo
├── rules/AGENTS.md             # Workspace agent guidance
├── skills/agy-board/SKILL.md   # Agent skill instructions
├── sidecars/board/
│   ├── sidecar.json            # Aux Pane & Sidebar entrypoints
│   ├── server.mjs              # Compiled Sidecar + standalone loopback server
│   └── public/                 # Compiled React + @dnd-kit frontend
├── dist/
│   ├── mcp.mjs                 # Compiled MCP stdio server (15 tools + MCP App card)
│   ├── hook.mjs                # Compiled Antigravity hook entrypoint
│   └── cli.mjs                 # Compiled CLI (serve, doctor, workspaces, list, create, dispatch)
├── src/
│   ├── core/                   # Pure domain logic
│   ├── host/                   # node:sqlite DB, workspaces, agent bridge, worktree, refs guard, scheduler
│   ├── entry/                  # Sidecar, HTTP router, MCP, Hook, CLI
│   └── client/                 # React + @dnd-kit UI
└── tests/                      # Vitest unit, host integration, MCP/Hook E2E, HTTP/CLI/Sidecar, and React UI tests
```

## CLI Usage & Flags

Global options supported across subcommands: `--db <path>` (overrides SQLite DB location; defaults to `AGY_BOARD_DB_PATH`, `<AGY_BOARD_DATA_DIR>/board.db`, or `<antigravityDataDir>/agy-board/board.db`) and `-h` / `--help`. All command subcommands (`doctor`, `workspaces`, `list`, `create`, `dispatch`) accept `--json` for machine-readable output.

```bash
node dist/cli.mjs serve [--port 17910] [--db <path>]
node dist/cli.mjs doctor [--db <path>] [--json]
node dist/cli.mjs workspaces [--db <path>] [--json]
node dist/cli.mjs list [--phase needs_you|active|on_hold|todo|closed] [--workspace <str>] [--include-archived|--archived|--all] [--db <path>] [--json]
node dist/cli.mjs create [--title "..."] [title...] [--description "..."] [--prompt "..."] [--workspace <path>] [--workspace-id <id>] [--priority urgent|high|normal|low] [--next-action "..."] [--mode <str>] [--model <str>] [--due <iso|ms>] [--reminder <iso|ms>] [--use-worktree] [--db <path>] [--json]
node dist/cli.mjs dispatch <taskId> [--task <id>] [--mode auto|new|resume|rework] [--rework "..."] [--subgoal <id>] [--model <str>] [--profile <str>] [--use-worktree] [--dry-run] [--db <path>] [--json]
```

Optional environment overrides: `AGY_BOARD_PORT` (default `17910`), `AGY_BOARD_DB_PATH`, `AGY_BOARD_DATA_DIR`, `AGY_BOARD_GEMINI_CONFIG_DIR`, `AGY_BOARD_ANTIGRAVITY_DATA_DIR`, `AGY_BOARD_CDP_PORT`. Also supported on `create`: `--due-at` / `--dueAt` and `--reminder-at` / `--reminderAt` aliases.

## Development & Standalone Preview

Requires **Node.js 22.13+** (tested on Node 24 with native `node:sqlite`).

```bash
npm install
npm run build   # Typechecks (tsc --noEmit), builds React UI, and bundles runtime JS
npm test        # Runs full Vitest suite (npx vitest run)
```

### Standalone Preview (Without Antigravity Deployment)

```bash
node dist/cli.mjs serve --port 17910
```

Optionally pass `--db ./.data/dev-board.db` to keep preview data isolated, then open `http://127.0.0.1:17910` in a browser.

## Integrating into `agy-kit` (Optional)

**Zero deployment is performed by default** — developing inside this repository does not touch `~/.gemini/config/` or external `agy-kit` installations.

When you are ready to pin `agy-board` inside an `agy-kit` setup:

1. Build and verify cleanly first:
   ```bash
   npm run build && npm test
   ```
2. Copy or pin only the self-contained runtime artifact set declared in `agy-kit.compat.json` (`runtime_entries`, requiring zero `node_modules` on disk):
   - `assets`, `dist`, `hooks.json`, `mcp_config.json`, `plugin.json`, `rules`, `sidecars`, `skills`
3. Register the plugin payload in `agy-kit` using `plugin.json`, `mcp_config.json` (`${PLUGIN_ROOT}/dist/mcp.mjs`, `AGY_BOARD_PLUGIN_DATA=${PLUGIN_DATA}`), `hooks.json` (`agy-board-lifecycle`), and `sidecars/board/sidecar.json`.
4. Preserve **Scheme B spatial separation** invariants (`agy-kit.compat.json`):
   - `dom_injection: false`, `composer_footer: false`, `aux_pane_only: true`, `modifies_shortcuts: false`, `modifies_app_storage: false`, `modifies_language_server: false`, `duplicate_toast_notifications: false`.

## License

[MIT](LICENSE)
