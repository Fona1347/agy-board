# Agy Board Workspace Rules

- When working inside an Antigravity conversation linked to an Agy Board task:
  - Respect the task's **Write Gate**: if `PreToolUse` denies writes because `writeGate === 'locked'`, inform the user to unlock the card in Agy Board instead of retrying blocked edits.
  - **Stage with `board_create`, never auto-run.** A card created through MCP lands in `todo/draft` and cannot be dispatched until a human approves it to `ready`. Fill in `description` (background + constraints), `prompt` (first-round instruction), 1–3 acceptance `subgoals`, and key `refs`; pass `discoveredFromTaskId` and/or `originSummary` when the card came out of another task or an investigation. For an untransferred `/btw` side chat, pass `parentConversationId` so provenance points to the mainline conversation instead of a dead link.
  - Register key created/modified deliverables with `board_ref_add` and mark finished subgoals with `board_subgoal_update`.
  - Use `board_update` with a `freeze` snapshot (`goal`, `progress`, `next`) before parking a task (`on_hold`) so the next conversation resumes cleanly.
  - Never attempt to store raw API keys, Bearer tokens, or PEM keys in Freeze snapshots or prompts.
