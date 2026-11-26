/**
 * Core domain types and state reconciliation for agy-board.
 * Zero Node/DOM/framework dependencies so domain logic is pure and fast to test.
 */

export type TaskPhase = 'needs_you' | 'active' | 'on_hold' | 'todo' | 'closed'

export type TaskSubPhase =
  | 'review'
  | 'blocked'
  | 'needs_input'
  | 'permission_pending'
  | 'reminder_due'
  | 'running'
  | 'working'
  | 'paused'
  | 'waiting'
  | 'draft'
  | 'ready'
  | 'backlog'
  | 'done'
  | 'cancelled'

export type CanonicalStatus = 'pending' | 'in_progress' | 'done' | 'cancelled'

/**
 * Who authored the task. `ai` covers tasks staged by an agent through MCP/hooks;
 * `user` covers cards created through the board UI or CLI.
 */
export type TaskCreator = 'user' | 'ai'

export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low'

export type WriteGateMode = 'unlocked' | 'locked'

export const TASK_PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access'] as const
export type TaskPermission = (typeof TASK_PERMISSIONS)[number]

export function isTaskPermission(value: unknown): value is TaskPermission {
  return typeof value === 'string' && (TASK_PERMISSIONS as readonly string[]).includes(value)
}

export const TASK_PHASES = ['needs_you', 'active', 'on_hold', 'todo', 'closed'] as const

export function isTaskPhase(value: unknown): value is TaskPhase {
  return typeof value === 'string' && (TASK_PHASES as readonly string[]).includes(value)
}

export const TASK_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && (TASK_PRIORITIES as readonly string[]).includes(value)
}

export interface FreezeSnapshot {
  goal: string
  progress: string
  next: string
}

export interface TaskFreeze extends FreezeSnapshot {
  frozenAt: number
  redacted?: boolean
  frozenBy?: string
}

export interface TaskHandoverInput {
  workspaceId?: string
  mode?: string
  permission?: TaskPermission
  references: string[]
}

export interface TaskHandover extends TaskHandoverInput {
  bundledAt: number
}

export interface TaskTag {
  name: string
  promptPrefix?: string
}

export const TASK_TAG_LIMIT = 8
export const TAG_NAME_MAX_LENGTH = 32
export const TAG_PROMPT_MAX_LENGTH = 200

export function normalizeTags(value: unknown): TaskTag[] {
  if (!Array.isArray(value)) return []
  const result: TaskTag[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item === 'string') {
      const name = item.trim()
      if (!name || name.length > TAG_NAME_MAX_LENGTH || seen.has(name)) continue
      seen.add(name)
      result.push({ name })
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>
      if (typeof rec.name !== 'string') continue
      const name = rec.name.trim()
      if (!name || name.length > TAG_NAME_MAX_LENGTH || seen.has(name)) continue
      const rawPrefix = typeof rec.promptPrefix === 'string' ? rec.promptPrefix.trim() : ''
      const promptPrefix = rawPrefix ? rawPrefix.slice(0, TAG_PROMPT_MAX_LENGTH) : undefined
      seen.add(name)
      result.push(promptPrefix ? { name, promptPrefix } : { name })
    }
    if (result.length >= TASK_TAG_LIMIT) break
  }
  return result
}

export type ScheduleMode = 'cron' | 'once' | 'after_completion'

export type ScheduleAction = 'dispatch' | 'remind'

export type ScheduleSessionMode = 'new' | 'auto'

export type ScheduleMisfirePolicy = 'prompt' | 'catch_up_once' | 'skip'

export type ScheduleOverlapPolicy = 'wait_review' | 'allow_replace'

export type ScheduleStopReason =
  | 'fired'
  | 'limit'
  | 'no-target'
  | 'missed'
  | 'busy'
  | 'permission'
  | 'launch-failed'
  | 'awaiting-review'
  | 'closed'
  | 'skipped'

export interface ScheduleRule {
  enabled: boolean
  mode: ScheduleMode
  cron?: string
  at?: number
  timeZone?: string
  nextRunAt?: number
  lastTriggeredAt?: number
  runCount: number
  maxRuns?: number
  endedAt?: number
  endedReason?: ScheduleStopReason
  skippedAt?: number
  skippedReason?: ScheduleStopReason
  action?: ScheduleAction
  sessionMode?: ScheduleSessionMode
  misfirePolicy?: ScheduleMisfirePolicy
  overlapPolicy?: ScheduleOverlapPolicy
  intervalDays?: number
  atHour?: number
  atMinute?: number
  missedSlotAt?: number
  /** Consecutive launch failures; the circuit breaker disables the rule at 3. */
  consecutiveFailures?: number
}

export type SubgoalKind = 'acceptance' | 'implementation' | 'review' | 'custom'
export type SubgoalStatus = 'open' | 'in_progress' | 'done' | 'skipped'

export interface SubgoalRecord {
  id: string
  taskId: string
  title: string
  detail: string
  kind: SubgoalKind
  required: boolean
  status: SubgoalStatus
  sortOrder: number
  dependencies: string[]
  addedBy: string
  createdAt: number
  closedAt?: number
  conversations?: ConversationLink[]
}

export type TaskRefKind = 'file' | 'url' | 'artifact' | 'command' | 'doc'

export interface TaskRefRecord {
  id: string
  taskId: string
  subgoalId?: string
  kind: TaskRefKind
  target: string
  label?: string
  round?: number
  addedBy: string
  createdAt: number
}

export type ConversationRole = 'origin' | 'primary' | 'worker' | 'reviewer' | 'reference'

export interface ConversationLink {
  taskId: string
  subgoalId?: string
  conversationId: string
  role: ConversationRole
  workspaceId?: string
  linkedAt: number
  title?: string
  liveStatus?: string
  isIdle?: boolean
  /** One-line distilled conclusion captured when the session settles. */
  summary?: string
  /** Include this conclusion in the next dispatch handoff capsule. */
  includeInHandoff?: boolean
}

export type ExecutionOutcome = 'succeeded' | 'failed' | 'cancelled'

export interface ExecutionContractSnapshot {
  planRevision: number
  capturedAt: number
  title: string
  description: string
  userNotes: string
  prompt: string
  nextAction?: string
  subgoalId?: string
  subgoals: Array<{
    id: string
    title: string
    required: boolean
    status: SubgoalStatus
  }>
  refs: Array<{
    kind: TaskRefKind
    target: string
    label?: string
  }>
  handoffConclusions?: Array<{
    conversationId: string
    role: ConversationRole
    summary: string
  }>
  freeze?: FreezeSnapshot
  dispatchedPrompt: string
}

export interface ExecutionRecord {
  id: string
  taskId: string
  subgoalId?: string
  conversationId?: string
  workspaceId?: string
  startedAt: number
  endedAt?: number
  result?: ExecutionOutcome
  error?: string
  summary?: string
  initiatedBy?: string
  reworkInstructions?: string
  frozenAt?: number
  planRevision?: number
  contractSnapshot?: ExecutionContractSnapshot
}

export interface TaskEventRecord {
  id: string
  taskId: string
  subgoalId?: string
  conversationId?: string
  kind: string
  source: 'ui' | 'mcp' | 'hook' | 'scheduler' | 'cli'
  payload: Record<string, unknown>
  createdAt: number
}

export interface TaskUserMarks {
  taskId: string
  ignoredAt?: number
  ackedAt?: number
  pinnedAt?: number
  snoozedUntil?: number
  updatedAt: number
}

export type BatchTaskAction =
  | 'pin'
  | 'unpin'
  | 'set_sub_phase'
  | 'set_priority'
  | 'set_workspace'
  | 'archive'
  | 'unarchive'
  | 'close'
  | 'delete'

export interface TaskCommentRecord {
  id: string
  taskId: string
  author: string
  bodyMd: string
  createdAt: number
}

export interface WorkspaceRecord {
  id: string
  name: string
  rootPath: string
  folderPaths: string[]
  antigravityProjectId?: string
  source: 'antigravity' | 'custom'
  pinned?: boolean
  lastUsedAt?: number
  createdAt: number
}

export interface DiscoveredConversation {
  conversationId: string
  title: string
  preview: string
  projectId: string
  workspacePaths: string[]
  status: string
  isIdle: boolean
  stepCount: number
  lastModifiedAt: number
}

export interface SubgoalRollup {
  total: number
  done: number
  inProgress: number
  open: number
  skipped: number
  requiredTotal: number
  requiredDone: number
  requiredRemaining: number
  allRequiredDone: boolean
  readyForReview: boolean
}

export interface TaskRecord {
  id: string
  title: string
  /** Concise 1-3 sentence brief summary (<=150 chars recommended). */
  description: string
  /** Human-exclusive alignment notes & overrides. Never locked; AI/MCP forbidden from overwriting. */
  userNotes?: string
  /** Full Agent Execution Contract / implementation plan. */
  prompt: string
  phase: TaskPhase
  subPhase: TaskSubPhase
  status: CanonicalStatus
  priority: TaskPriority
  workspaceId?: string
  workspacePath?: string
  workspaceLabel?: string
  blockedReason?: string
  nextAction?: string
  dueAt?: number
  reminderAt?: number
  remindedAt?: number
  sortOrder: number
  writeGate: WriteGateMode
  mode?: string
  model?: string
  reasoningEffort?: string
  permission?: TaskPermission
  permissionConfirmedAt?: number
  reuseSession: boolean
  /** `ai` when staged by an agent via MCP/hooks, `user` otherwise. */
  createdBy?: TaskCreator
  /** Conversation that spawned the task (may be an untransferred `/btw` id). */
  originConversationId?: string
  /** Free-text provenance note ("while looking into X"). */
  originSummary?: string
  /** Task this card was discovered from. */
  discoveredFromTaskId?: string
  freeze?: TaskFreeze
  handover?: TaskHandover
  tags: TaskTag[]
  schedule?: ScheduleRule
  planRevision: number
  createdAt: number
  updatedAt: number
  completedAt?: number
  archivedAt?: number
  subgoals: SubgoalRecord[]
  subgoalRollup: SubgoalRollup
  refs: TaskRefRecord[]
  conversations: ConversationLink[]
  executions: ExecutionRecord[]
  comments?: TaskCommentRecord[]
  userMarks?: TaskUserMarks
  useWorktree?: boolean
  worktreePath?: string
  worktreeBranch?: string
}

export interface BoardSnapshot {
  revision: number
  serverTime: number
  timeZone: string
  hostTheme?: 'dark' | 'light' | 'system'
  sessionDefaultPermission: TaskPermission
  maxConcurrentLaunches: number
  workspaces: WorkspaceRecord[]
  activeWorkspacePaths: string[]
  activeProjectId?: string
  tasks: TaskRecord[]
  recentConversations: DiscoveredConversation[]
  counts: {
    needs_you: number
    active: number
    on_hold: number
    todo: number
    closed: number
    archived: number
    dueReminders: number
  }
}

export const DEFAULT_SUBPHASE_FOR_PHASE: Record<TaskPhase, TaskSubPhase> = {
  needs_you: 'review',
  active: 'running',
  on_hold: 'paused',
  todo: 'ready',
  closed: 'done',
}

export function reconcilePhaseStatus(
  phase: TaskPhase,
  subPhase?: TaskSubPhase,
): { phase: TaskPhase; subPhase: TaskSubPhase; status: CanonicalStatus } {
  const validSubPhases: Record<TaskPhase, readonly TaskSubPhase[]> = {
    needs_you: ['review', 'blocked', 'needs_input', 'permission_pending', 'reminder_due'],
    active: ['running', 'working'],
    on_hold: ['paused', 'waiting'],
    todo: ['draft', 'ready', 'backlog'],
    closed: ['done', 'cancelled'],
  }
  const resolvedSub =
    subPhase && validSubPhases[phase].includes(subPhase)
      ? subPhase
      : DEFAULT_SUBPHASE_FOR_PHASE[phase]
  let status: CanonicalStatus
  if (phase === 'todo') status = 'pending'
  else if (phase === 'closed') status = resolvedSub === 'cancelled' ? 'cancelled' : 'done'
  else status = 'in_progress'
  return { phase, subPhase: resolvedSub, status }
}

export function hasOpenExecution(task: Pick<TaskRecord, 'executions'>): boolean {
  return task.executions.some((e) => e.endedAt === undefined)
}

export function isRecurringSchedule(schedule?: Pick<ScheduleRule, 'mode'>): boolean {
  return Boolean(schedule && (schedule.mode === 'cron' || schedule.mode === 'after_completion'))
}

/**
 * Task content is never blocking-frozen: each dispatch captures an immutable
 * `ExecutionContractSnapshot` on `task_executions` and increments `planRevision`.
 * Kept exported for backward compatibility; use `hasOpenExecution(task)` when
 * rendering a non-blocking "applies on next dispatch/rework" hint.
 */
export function isTaskContentFrozen(
  _task?: Pick<TaskRecord, 'executions'> & Partial<Pick<TaskRecord, 'freeze' | 'schedule'>>,
): boolean {
  return false
}
