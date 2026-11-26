# Agy Board Workspace Rules

- **Trigger & Scope Routing:**
  - Whenever the user mentions managing todos/board tasks — e.g. 「记个待办 / 加到看板 / 记个 todo / 先记下来 / 回头再做 / 看看看板 / 提醒我 / 派发或验收看板任务」 — load the `agy-board` skill and use `board_*` MCP tools.
  - Do **not** auto-create cards for trivial one-turn edits, pure Q&A, or external Google Calendar meetings.
- When working inside an Antigravity conversation linked to an Agy Board task:
  - Respect the task's **Write Gate**: if `PreToolUse` denies writes because `writeGate === 'locked'`, inform the user to unlock the card in Agy Board instead of retrying blocked edits.
  - **Stage with `board_create`, never auto-run.** A card created through MCP lands in `todo/draft` and cannot be dispatched until a human approves it to `ready`. Put **only 1–3 concise human-readable sentences (≤150 chars)** in `description`; put the full execution plan/contract in `prompt` along with 1–3 acceptance `subgoals` and key `refs`; pass `discoveredFromTaskId` and/or `originSummary` when the card came out of another task or an investigation. For an untransferred `/btw` side chat, pass `parentConversationId` so provenance points to the mainline conversation instead of a dead link.
  - **Respect human-exclusive `userNotes`:** `userNotes` is never locked and can only be edited by the human user in UI/CLI — MCP tools must never overwrite it (append agent progress via `board_comment_add`). Whenever `userNotes` is present on a task, treat it as the **highest-priority alignment override**.
  - Register key created/modified deliverables with `board_ref_add` and mark finished subgoals with `board_subgoal_update`.
  - Use `board_update` with a `freeze` snapshot (`goal`, `progress`, `next`) before parking a task (`on_hold`) so the next conversation resumes cleanly.
  - Never attempt to store raw API keys, Bearer tokens, or PEM keys in Freeze snapshots or prompts.
