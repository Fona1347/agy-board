# Agy Board (`agy-board`)

**English** | [简体中文](README.zh-CN.md)

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

## Features

- **3 Differentiated Views & 4-Tier Semantic Palette**:
  - **Focus (`焦点`)**: Daily command center surfacing `Needs Attention`, `Active`, `Today's Focus` (urgent / pinned / due within 48h / scheduled today), and `Completed Today`, with `★` pinning, Snooze presets, and a collapsible `Quiet Pool` (`待排期与远期池`) + `Ignored` recovery box.
  - **Kanban (`看板`)**: 4-tier asymmetric execution board (`Needs You`, `Active & On Hold`, `Todo`, `Closed` bucketed by `Today` / `Yesterday` / `Last 7 Days` / `Older`) with `@dnd-kit` drag-and-drop, concurrency indicator, and drag-to-dispatch inline confirmation.
  - **List (`列表`)**: Master-Detail triage ledger supporting 4-axis grouping (`Workspace`, `Status`, `Schedule`, `Tag`), multi-criterion sorting, 1-click `Ready ↔ Backlog` toggle, `Shift+Click` multi-select Batch Bar, and keyboard arrow stepping.
- **Dual-Tab Detail Drawer (`My View` & `Agent Control`)**:
  - Separates human notes, subgoals, priority, DDL, and reminder/schedule controls from agent execution prompts, session linking, worktree diffs, write gate, and run history.
  - Host-synced 3-way theme (`Follow Agy` / `Light` / `Dark`) and EN/中文 i18n toggle.
- **AI Draft Approval Gate & Cross-Session Context Capsule**:
  - Tasks staged by AI via MCP `board_create` land in `todo/draft` with origin provenance (`originConversationId`, `discoveredFromTaskId`, `originSummary`) and require explicit human approval before dispatch.
  - Weighted conversation links (`summary` + `★ Include in handoff`) assemble a clean cross-session Context Capsule into newly spawned agent sessions instead of blindly reusing bloated threads.
- **Zero-Cron Scheduling, Reminders & `SidecarOwner`**:
  - Supports one-time reminders (`reminderAt`), `once`, zone-aware 5-field `cron` (DST-safe), and `after_completion` recurring rules, plus `remind`-only mode, `Accept Round` cycle completion, sleep misfire catch-up banner (`Run Now` / `Skip`), and `SidecarOwner` multi-window single-leader locking.
- **Workspace Linking, Antigravity 2.35+ Bridge & Git Worktree Isolation**:
  - Multi-folder workspace discovery (`~/.gemini/config/projects/*.json`) synced live via `window.sidecar.getWorkspaceUris()` / `onWorkspaceChange()`.
  - Connects to Antigravity 2.35+ `product.v1.ConversationService` over Connect HTTP+JSON (with HTTPS TLS fallback and `agentapi` CLI fallback) to launch, resume, rework, jump, or `Split ↗` sessions.
  - Opt-in Git worktree isolation under `.worktrees/agy-board-<taskId>` with diff inspection and cleanup.
- **15 MCP Tools, Inline MCP App Card & Dual Write Gate Hooks**:
  - **15 MCP Tools** (`mcp_config.json` → `dist/mcp.mjs`): `board_list`, `board_get`, `board_card`, `board_workspaces`, `board_create`, `board_update`, `board_transition`, `board_plan_breakdown`, `plan_to_board`, `board_subgoal_update`, `board_comment_add`, `board_ref_add`, `board_dispatch`, `board_schedule`, `next_ready_task`. (Intentionally omits `confirm_permission`.)
  - **Inline MCP App Resource**: `ui://agy-board/card.html` (`text/html;profile=mcp-app`) linked on `board_list`, `board_get`, and `board_card`.
  - **Lifecycle Hooks** (`hooks.json` → `dist/hook.mjs`): `SessionStart` context injection, `PreToolUse` Dual Write Gate & `ask_question` pause, `PostToolUse` deliverable capture & resume, and `Stop` transcript summary settlement.
  - **Freeze & Handover Security**: Redacts secrets (`sk-`, `Bearer`, `ghp_`, `gho_`, `github_pat_`, `glpat-`, `xox*`, `AKIA`, `AIza`, PEM private keys) and blocks direct file/shell mutations to `board.db*`, `taskspace/*.md`, and `handover.references`.
- **In-Memory Demo Sandbox**:
  - Preview every state (Draft, Review, Permission Pending, Active, Reminder Due, Missed Schedule) inside an isolated in-memory sandbox without touching your real SQLite database.

## Architecture Overview

- **Core Domain (`src/core/`)**: Pure zero-dependency TypeScript domain logic (`types`, `freeze`, `handover`, `subgoals`, `schedule`, `session-reuse`, `workspace`).
- **Authoritative Host (`src/host/`)**:
  - `db.ts`: `node:sqlite` WAL database with schema migrations, `dispatch.lock.<executionId>` in-flight protection, and optional orphan recovery.
  - `board-service.ts`: Unified mutation, validation, TaskSpace Markdown projection, Dual Write Gate, dispatch, and scheduler engine shared by Sidecar/HTTP, MCP, Hooks, and CLI.
  - `workspaces.ts`: Read-only discovery of Antigravity projects and `conversation_summaries.db`, merged with custom editable workspaces.
  - `agent-bridge.ts`: Antigravity `product.v1.ConversationService` Connect HTTP+JSON client, `agentapi` CLI fallback, and loopback CDP navigation.
  - `worktree.ts`, `scheduler.ts`, `refs-guard.ts`, `launch-admission.ts`: Git worktree lifecycle, single-leader scheduler, allowlisted TaskSpace file preview, and fair concurrency queue.
- **Entrypoints (`src/entry/`, bundled into `dist/*` & `sidecars/board/`)**:
  - `sidecar.ts` / `router.ts` / `server-core.ts`: Dual-mode `sidecar_sdk` `SidecarApp` (serving a self-contained single-file inline HTML UI via `app.page('/')` with async `/_sidecar/*` overrides) and standalone loopback HTTP+SSE server.
  - `mcp.ts`, `hook.ts`, `cli.ts`: Compiled zero-dependency Node 22+ bundles.

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
│   └── public/index.html       # Self-contained single-file React + @dnd-kit UI bundle
├── dist/
│   ├── mcp.mjs                 # Compiled MCP stdio server (15 tools + MCP App card)
│   ├── hook.mjs                # Compiled Antigravity hook entrypoint
│   └── cli.mjs                 # Compiled CLI (serve, doctor, workspaces, list, create, dispatch)
├── src/
│   ├── core/                   # Pure domain logic
│   ├── host/                   # node:sqlite DB, workspaces, agent bridge, worktree, refs guard, scheduler
│   ├── entry/                  # Sidecar, HTTP router, MCP, Hook, CLI
│   └── client/                 # React + @dnd-kit UI & Demo Sandbox
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
npm run build   # Typechecks (tsc --noEmit), builds single-file React UI, and bundles runtime JS
npm test        # Runs full Vitest suite (vitest run)
npm run check   # Runs build + test
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
