<div align="center">

<img src="assets/logo.svg" alt="Agy Board Logo" width="72" height="72" />

# Agy Board

**Workspace-linked AI Task Board, Draft Approval Gate & Cross-Session Handoff Console for Antigravity**

[![Release](https://img.shields.io/badge/release-v0.1.0-B45309?style=flat-square)](https://github.com/Fona1347/agy-board/releases/latest)
[![Node](https://img.shields.io/badge/node-22.13%2B-339933?style=flat-square)](#quick-install)
[![Antigravity](https://img.shields.io/badge/Antigravity-2.34%2B%20(2.35%2B%20native)-2563EB?style=flat-square)](#quick-install)
[![License](https://img.shields.io/badge/license-MIT-555555?style=flat-square)](LICENSE)

**English** | [简体中文](README.zh-CN.md)

[Workflow](#why-agy-board) · [Quick Install](#quick-install) · [Views & Features](#three-views--core-capabilities) · [MCP & Guardrails](#mcp-tools-hooks--guardrails) · [CLI & Dev](#cli-preview--development) · [Acknowledgments](#acknowledgments--inspiration)

</div>

<p align="center">
  <a href="https://github.com/Fona1347/agy-board/releases/download/v0.1.0/agy-board-promo-45s.mp4">
    <img src="https://github.com/Fona1347/agy-board/releases/download/v0.1.0/agy-board-preview.gif" alt="Agy Board Demo Preview" />
  </a>
</p>

<p align="center">
  <sub>Click the preview above (or download <a href="https://github.com/Fona1347/agy-board/releases/download/v0.1.0/agy-board-promo-45s.mp4"><code>agy-board-promo-45s.mp4</code></a>) for the 45s HD walkthrough. Demo recorded in Chinese UI; Agy Board supports instant English / Chinese and Light / Dark theme switching.</sub>
</p>

---

## Why Agy Board?

When running AI agents across multiple repositories over days or weeks, ordinary to-do lists break down quickly:

- **AI-created tasks mix with human-approved work** — follow-ups spotted mid-chat get lost or launched before you review them.
- **Reusing bloated chat threads causes context rot** — resuming last week's session drags irrelevant history instead of distilled decisions.
- **Background schedules silently misfire or overwrite results** — hand-written cron syntax is fragile, and sleeping laptops either drop runs or clobber unreviewed output.

Agy Board lives right inside Antigravity's side panel as a **4-step human-in-the-loop workflow**:

1. **AI Stages a Draft** — During any chat, your agent calls `board_create` to park follow-up work in `todo/draft` with provenance (`originConversationId`, `discoveredFromTaskId`, `originSummary`), subgoals, and file refs. Drafts cannot auto-run.
2. **You Review & Approve** — Inspect or edit the goal, subgoals, and permissions in the dual-tab detail drawer, then click **Approve → Ready** (elevated permissions always require human confirmation in the UI).
3. **Dispatch in a Clean Session** — Launch a fresh conversation with a distilled **Context Capsule** (pinned `★` conversation summaries, freeze handover, and key refs), optionally isolated in its own Git worktree.
4. **Auto-Return for Review** — Lifecycle hooks detect completion or `ask_question` pauses and bounce the card into **Needs Attention**, where you **Accept**, **Accept Round** (for recurring tasks), or send inline **Rework**.

---

## Quick Install

Requires **Node.js 22.13+** (uses built-in `node:sqlite`). The release zip is self-contained and needs **zero `node_modules`** on disk.

1. Download the latest `agy-board-v*.zip` from [GitHub Releases](https://github.com/Fona1347/agy-board/releases/latest).
2. Extract its contents into `~/.gemini/config/plugins/agy-board/` (Windows: `%USERPROFILE%\.gemini\config\plugins\agy-board\`).
3. Open **Customizations → Plugins** in Antigravity to verify **Agy Board** is enabled, then open **Agy Board** from the left `Plugins` sidebar or the right Auxiliary Pane (`+`). Both entrypoints share the same board and remember your last view (defaults to **Focus**).

> **Try without touching your real tasks**: Open **Filters & Settings → Demo Sandbox** inside Agy Board for a full-state in-memory showcase (zero database writes, instant reset).

<details>
<summary>What can I say to my Antigravity agent right after installing?</summary>

Agy Board bundles workspace rules (`rules/AGENTS.md`) and a built-in skill (`skills/agy-board/SKILL.md`), so your agent knows how to cooperate immediately. Try prompts like:

- `"Show my active and needs-attention tasks across workspaces on Agy Board"`
- `"Stage the remaining cleanup items we just found as drafts on Agy Board with subgoals and file refs"`
- `"Break down this feature into required subgoals on Agy Board and save a freeze snapshot before we switch tasks"`

</details>

---

## Three Views & Core Capabilities

### Three Views, Three Jobs

| View | Question It Answers | What It Shows | Signature Actions |
| :--- | :--- | :--- | :--- |
| **Focus** | What needs me right now and today? | `Needs Attention`, `Active & Paused`, `Today's Focus` (urgent, `★` pinned, due within 48h, or reminder/schedule today), and `Completed Today`; everything else stays tucked inside `Backlog & Later Pool` and `Ignored`. | Left DDL/schedule timeline rail, `★` pin, one-click Snooze (`+2h` / tonight / tomorrow / next Monday), restore ignored items. |
| **Kanban** | What is running and where is the bottleneck? | 4 asymmetric lanes: `Needs Attention`, `In Progress` & `Paused` (system-managed), `Ready to Start`, and `Completed (Last 7 Days)` (older history links straight to List; Backlog and far-future items stay out of the way). | Drag-to-dispatch inline confirmation bar, live `Running N/3` concurrency pill, elapsed stopwatch, and Git worktree badges. |
| **List** | What is the full inventory across all repos? | 100% of tasks including `AI Draft`, `Backlog`, full history, and optional `Archived`, in a responsive Master-Detail split. | 4-axis grouping (`Workspace` / `Status` / `Schedule` / `Tag`), sorting, 1-click Draft approve or `Ready ↔ Backlog` toggle, `Shift+Click` batch bar, and `↑/↓` stepping. |

### Core Capabilities

| Capability | Highlights |
| :--- | :--- |
| **Dual-Tab Detail Drawer** | Separates **My View** (human summary, subgoals, priority, DDL, reminders) from **Agent Control** (execution prompt, linked sessions, worktree diff, write gate, run logs). Syncs theme with Antigravity (`Follow Agy` / `Light` / `Dark`) and switches EN/中文 live. |
| **AI Draft Gate & Context Capsule** | MCP-created tasks default to `todo/draft` with provenance links (safely resolving untransferred `/btw` side chats back to parent conversations). Mark valuable sessions with `★ Include in handoff` so new clean sessions inherit distilled conclusions instead of stale chat logs. |
| **Zero-Cron Scheduler** | Visual scheduler for one-time reminders, `once`, DST-safe 5-field `cron`, and `after_completion` loops; supports `remind`-only mode, `Accept Round` without killing recurring rules, sleep misfire banner (`Catch Up Now` / `Skip`), and `SidecarOwner` single-leader locking across windows. |
| **Workspaces, 2.34+/2.35+ Bridge & Worktrees** | Auto-discovers multi-folder Antigravity workspaces (`~/.gemini/config/projects/*.json`) with live `[This Workspace]` sync. Runs on Antigravity **2.34+** (`agentapi` CLI fallback) and automatically uses native `product.v1.ConversationService` on **2.35+**. Optional Git worktree isolation (`.worktrees/agy-board-<taskId>`) with in-panel diff preview and cleanup. |

---

## MCP Tools, Hooks & Guardrails

Agy Board exposes **15 stdio MCP tools**, an inline **MCP App card** (`ui://agy-board/card.html`), and **4 lifecycle hooks** to keep human review and workspace safety enforceable at runtime.

<details>
<summary>15 MCP Tools & Inline MCP App Card</summary>

| Group | Tools | Notes |
| :--- | :--- | :--- |
| **Read & Inline UI** | `board_list`, `board_get`, `board_card`, `board_workspaces`, `next_ready_task` | `board_list`, `board_get`, and `board_card` attach `ui://agy-board/card.html` for inline task cards in chat. |
| **Stage & Update** | `board_create`, `board_update`, `board_transition`, `board_comment_add`, `board_ref_add` | `board_create` lands in `todo/draft`; AI cannot bypass human approval or self-confirm elevated permissions (`confirm_permission` is intentionally omitted from MCP). |
| **Plan & Dispatch** | `board_plan_breakdown`, `plan_to_board`, `board_subgoal_update`, `board_dispatch`, `board_schedule` | Supports required/optional subgoals, dependency cycle checks, worktree dispatch, and schedule management. |

</details>

<details>
<summary>Lifecycle Hooks, Dual Write Gate & Secret Redaction</summary>

| Mechanism | Behavior |
| :--- | :--- |
| **Lifecycle Hooks (`hooks.json` → `dist/hook.mjs`)** | `SessionStart` injects task context; `PreToolUse` enforces Dual Write Gate and pauses on `ask_question`; `PostToolUse` registers created/edited deliverables and resumes after `ask_question`; `Stop` summarizes the final planner response and settles the active execution. Exits cleanly with `{"decision":"allow"}` without creating a phantom database if the board is uninitialized. |
| **Dual Write Gate** | Enforced in both `PreToolUse` and MCP handlers. When `writeGate` is `locked`, file/shell mutations and destructive task transitions are blocked until unlocked in the UI. Even when `unlocked`, Antigravity tool calls and shell commands targeting `board.db*`, `taskspace/`, or linked `handover.references` are blocked (and `on_hold`/`closed` tasks prompt for confirmation). |
| **Freeze & Handover Hygiene** | `FreezeSnapshot` automatically redacts credentials (`sk-`, `Bearer`, `ghp_`, `gho_`, `github_pat_`, `glpat-`, `xox[bpars]-`, `AKIA`, `AIza`, PEM private keys), rejects `/command` lines, and caps each field at 8 KiB UTF-8. |

</details>

---

## CLI, Preview & Development

Requires **Node.js 22.13+** (tested on Node 24 with native `node:sqlite`).

```bash
npm install
npm run check                                           # typecheck + single-file UI + runtime bundles + Vitest
npm run dev                                             # Vite dev server (:5179 proxying :17910)
node dist/cli.mjs serve --port 17910 --db ./.data/dev.db # standalone browser preview (http://127.0.0.1:17910)
```

<details>
<summary>CLI Commands & Environment Variables</summary>

| Command | Purpose |
| :--- | :--- |
| `node dist/cli.mjs serve [--port 17910] [--db <path>]` | Start loopback HTTP+SSE server serving the compiled UI and APIs. |
| `node dist/cli.mjs doctor [--db <path>] [--json]` | Inspect DB health, discovered workspaces, and host paths. |
| `node dist/cli.mjs workspaces [--db <path>] [--json]` | List discovered Antigravity projects and custom workspaces. |
| `node dist/cli.mjs list [--phase ...] [--workspace ...] [--all\|--archived] [--json]` | Filter and list tasks (`needs_you`, `active`, `on_hold`, `todo`, `closed`). |
| `node dist/cli.mjs create --title "..." [--priority ...] [--due ...] [--reminder ...] [--use-worktree] [--json]` | Create a task from CLI (also supports `--description`, `--prompt`, `--workspace`, `--workspace-id`, `--next-action`, `--mode`, `--model`, `--due-at`/`--dueAt`, `--reminder-at`/`--reminderAt`). |
| `node dist/cli.mjs dispatch <taskId> [--mode auto\|new\|resume\|rework] [--rework "..."] [--use-worktree] [--dry-run] [--json]` | Dispatch or rework a task session from CLI (also supports `--task`, `--subgoal`, `--model`, `--profile`). |

| Environment Variable | Default / Purpose |
| :--- | :--- |
| `AGY_BOARD_PORT` | Default `17910`; used by both `cli.mjs serve` (when `--port` is omitted) and standalone `server.mjs`. |
| `AGY_BOARD_DB_PATH` / `AGY_BOARD_DATA_DIR` / `AGY_BOARD_PLUGIN_DATA` | Override SQLite database path or data directory (defaults to `<antigravityDataDir>/agy-board/board.db`). |
| `AGY_BOARD_GEMINI_CONFIG_DIR` / `AGY_BOARD_ANTIGRAVITY_DATA_DIR` | Override `~/.gemini/config` or `~/.gemini/antigravity` discovery roots. |
| `AGY_BOARD_CDP_PORT` / `AGY_BOARD_DEVTOOLS_PORT_FILE` | Loopback CDP port or port-file override for standalone browser conversation jumping. |
| `ANTIGRAVITY_LS_ADDRESS` / `ANTIGRAVITY_CSRF_TOKEN` / `ANTIGRAVITY_AGENTAPI_EXE` / `ANTIGRAVITY_SIDECAR_SDK_PATH` | Host-injected runtime variables when running inside Antigravity. |

</details>

<details>
<summary>Architecture & Repository Layout</summary>

| Layer | Path | Responsibility |
| :--- | :--- | :--- |
| **Core Domain** | `src/core/` | Zero-dependency TypeScript logic (`types`, `freeze`, `handover`, `subgoals`, `schedule`, `session-reuse`, `workspace`). |
| **Host Engine** | `src/host/` | `node:sqlite` WAL DB + migrations, `BoardService`, workspace/session discovery, `ConversationService`/`agentapi` bridge, Git worktrees, `BoardScheduler`/`SidecarOwner`, refs guard, and fair launch queue. |
| **Entrypoints** | `src/entry/` | Dual-mode `SidecarApp` (single-file inline HTML via `app.page('/')` + async `/_sidecar/*` overrides) and loopback HTTP+SSE server, plus MCP, Hook, and CLI bundles. |
| **Frontend** | `src/client/` | React 19 + `@dnd-kit` UI (Focus / Kanban / List / Dual-Tab Drawer / Zero-Cron Composer / in-memory Demo Sandbox). |

```text
agy-board/
├── plugin.json                 # Antigravity native plugin manifest
├── mcp_config.json             # MCP stdio server entry (${PLUGIN_ROOT}/dist/mcp.mjs)
├── hooks.json                  # Antigravity lifecycle hooks (dist/hook.mjs)
├── agy-kit.compat.json         # agy-kit Scheme B isolation & runtime_entries manifest
├── assets/logo.svg             # Plugin icon
├── rules/AGENTS.md             # Workspace agent guidance
├── skills/agy-board/SKILL.md   # Agent skill instructions
├── sidecars/board/             # sidecar.json, compiled server.mjs, single-file public/index.html
├── dist/                       # Compiled Node 22+ bundles (mcp.mjs, hook.mjs, cli.mjs)
├── src/                        # TypeScript source (core / host / entry / client)
└── tests/                      # Vitest unit, host integration, MCP/Hook E2E, HTTP/CLI, and React UI tests
```

</details>

---

## Integrating into `agy-kit` (Optional)

Developing inside this repository never touches `~/.gemini/config/` or external `agy-kit` installations by default. To pin `agy-board` inside [agy-kit](https://github.com/Fona1347/agy-kit):

1. Run `npm run check` to produce verified bundles.
2. Copy or pin the 8 self-contained `runtime_entries` listed in [agy-kit.compat.json](agy-kit.compat.json) (`assets`, `dist`, `hooks.json`, `mcp_config.json`, `plugin.json`, `rules`, `sidecars`, `skills`) plus `LICENSE` and `THIRD_PARTY_NOTICES.md`.
3. Register the plugin via `plugin.json`, `mcp_config.json`, `hooks.json` (`agy-board-lifecycle`), and `sidecars/board/sidecar.json`.
4. Keep Scheme B spatial separation invariants intact (declared in [agy-kit.compat.json](agy-kit.compat.json): zero DOM injection, zero composer-footer hooks, zero shortcut overrides).

---

## Acknowledgments & Inspiration

`agy-board` is an original MIT-licensed codebase, deeply informed by open-source engineering patterns and agent-workflow pioneers across the community:

### Antigravity Ecosystem References & Coexistence

| Project | License | What We Learned / How We Coexist |
| :--- | :--- | :--- |
| [ATtacK030130/antigrative-dashboard](https://github.com/ATtacK030130/antigrative-dashboard) | MIT | Pioneered native Antigravity sidecar patterns including `SidecarOwner` single-leader locking, Windows CWD handle release before updates, multi-path `sidecar_sdk` loading, host theme reading, and verified `daemon/*.json` discovery. |
| [Fona1347/agy-kit](https://github.com/Fona1347/agy-kit) | MIT | Defines the Scheme B spatial-separation contract ([agy-kit.compat.json](agy-kit.compat.json)) and shared warm-paper / warm-charcoal caramel palette variables. |
| [0DNANCY/agy-claude-style](https://github.com/0DNANCY/agy-claude-style) | MIT | Coexists cleanly via the `data-ag-no-i18n="true"` convention and zero DOM injection. |
| [Lumidarin/agy-capsule](https://github.com/Lumidarin/agy-capsule) | MIT | Coexists cleanly under Scheme B (`composer_footer: false`), keeping telemetry capsules in the footer and task boards in the side pane. |

### Agent Workflow & UX Inspiration

| Project | License | Inspired Mechanism |
| :--- | :--- | :--- |
| [gastownhall/beads](https://github.com/gastownhall/beads) | MIT | Cross-session memory lineage and `discovered-from` provenance tracking (`discoveredFromTaskId`). |
| [MrLesk/Backlog.md](https://github.com/MrLesk/Backlog.md) | MIT | Structured task handoff tickets and the "1 task = 1 clean context window" capsule workflow. |
| [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) | Apache-2.0 | Kanban as an agent dispatch console with Git worktree isolation, inline diff review, and rework loops. |
| [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec) · [github/spec-kit](https://github.com/github/spec-kit) · [coleam00/Archon](https://github.com/coleam00/Archon) | MIT | Shift-left human review gates (`todo/draft` approval before agent execution). |
| [johannesjo/super-productivity](https://github.com/johannesjo/super-productivity) | MIT | Clean separation of deferral/scheduling (`Snooze`) from hard deadlines (`dueAt`) and single catch-up misfire handling. |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | MIT | Collapsible detail sections and restrained, low-noise visual hierarchy. |

Additional UX inspiration comes from Linear, Things 3, Raycast, and Claude Cowork. Built with [React](https://react.dev/), [@dnd-kit](https://dndkit.com/), [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk), [Lucide](https://lucide.dev/), [Zod](https://zod.dev/), [Vite](https://vite.dev/), [esbuild](https://esbuild.github.io/), [Vitest](https://vitest.dev/), and Node.js `node:sqlite`.

---

## License

[MIT](LICENSE) · Third-party bundle notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
