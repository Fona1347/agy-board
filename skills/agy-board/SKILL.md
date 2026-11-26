---
name: agy-board
description: Manage workspace-bound Todo/Kanban cards, subgoals, TaskSpace deliverable pointers, freeze handovers, reminders, and cross-workspace conversation dispatch on Agy Board.
---

# Agy Board Workflow

Use `agy-board` MCP tools (`board_*`) whenever the user wants to track multi-session work, switch workspaces, break down a plan into subgoals, freeze context for handoff, or dispatch follow-up sessions.

## Key Practices

1. **Stage Drafts with Clean 3-Layer Separation (Brief / Human Notes / Contract)**:
   - `board_create` from an agent lands in `todo/draft` (AI 草稿 · 待审); it cannot be dispatched until the human clicks `审校通过 → Ready`.
   - **`description` (Task Brief)**: Keep strictly to **1–3 concise human-readable sentences (≤150 chars)**. Never dump multi-paragraph plans, checklists, or code blocks into `description`.
   - **`prompt` + `subgoals` + `refs` (Agent Execution Contract)**: Put the complete implementation plan, constraints, acceptance subgoals (1–3 items), and key deliverable/reference pointers here.
   - **`userNotes` (Human-Exclusive Notes & Alignment Overrides)**: 100% human-owned, never locked, and strictly forbidden for agents/MCP to overwrite. Always read `userNotes` as the **highest-priority alignment override** when present, and use `board_comment_add` to append agent progress updates instead.
   - **Dispatch Snapshot Model**: Editing a task's title, brief, human notes, or contract is never blocking-frozen (even during active execution); each dispatch captures an immutable `contractSnapshot` on `task_executions` and increments `planRevision`, so edits made mid-run apply cleanly on the next dispatch or rework.
   - Record provenance: `discoveredFromTaskId` when the card came from another task, `originSummary` ("while checking X I noticed Y"), and `parentConversationId` for an untransferred `/btw` side chat so the link points to the mainline conversation.

2. **Bind Every Task to a Workspace**:
   - Call `board_workspaces` to look up Antigravity registered projects (`~/.gemini/config/projects/*.json`) or custom workspace paths.
   - Always pass `workspaceId` or `workspacePath` to `board_create` so the board can filter by workspace and launch sessions into the right project via `ANTIGRAVITY_PROJECT_ID`.

3. **Plan Breakdown with Lightweight Subgoals**:
   - Use `board_plan_breakdown` to decompose work into `required` (gate completion) vs `optional` subgoals with dependencies.
   - Update progress via `board_subgoal_update`. Once all `required` subgoals are `done`, an active task automatically moves to `needs_you` (`review`).

4. **TaskSpace Deliverable Pointers**:
   - Register produced files, URLs, commands, or artifacts via `board_ref_add`. Only registered pointers can be previewed in the Aux Pane.

5. **Freeze Snapshot for Handoffs**:
   - When pausing or handing off across sessions, capture `{ goal, progress, next }` (or a `<<<FREEZE ... >>>FREEZE` block). Never embed credentials or lines starting with `/`.

6. **Permission Confirmation Safety**:
   - Elevated permissions (`workspace-write` / `danger-full-access` above session default) require human confirmation inside the Agy Board UI (`Confirm Elevated Permission`). Never try to bypass the gate.

7. **Aux Pane Navigation Pill & Precision Focus**:
   - Inline MCP App task cards (`board_create`, `board_get`, `board_card`, `board_list`) collapse under `Worked for ...` once a turn finishes. Therefore, whenever you **create or update** tasks on Agy Board (and the `agy-board` plugin is enabled/running), attach **one** clickable navigation pill at the end of your final response:
     `[Agy Board](sidecar://agy-board/board/)`
   - Do not repeat multiple pills to the same view in a single reply, and omit the pill if the plugin is not enabled/running.
   - Inside the inline MCP App card, clicking **「在右侧看板查看」** or **「去看板审校 → Ready」** triggers `board_card({ taskId, focusInBoard: true })`, which writes a cross-process focus signal (`board_meta.focus_request`) so the right-hand Agy Board automatically opens that exact task's detail drawer (both via Sidecar `/api/revision` polling and Standalone SSE). Opening the board with `?taskId=<id>` also opens the target task drawer directly.
   - Draft approval (`todo/draft → ready`) remains a human gate: never attempt to bypass it via MCP; guide the user to click **「审校通过 → Ready」** inside the Agy Board sidebar.
