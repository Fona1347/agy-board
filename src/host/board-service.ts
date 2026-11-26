/**
 * Authoritative Host Board Service shared across Sidecar HTTP API, MCP server, Hooks, and CLI.
 */
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  buildDispatchPrompt,
  buildReworkPrompt,
  canCloseTaskWithSubgoals,
  checkSubgoalDependencies,
  computeSubgoalRollup,
  DEFAULT_SESSION_PERMISSION,
  fileUriToPath,
  handoverOf,
  hasOpenExecution,
  isPathEqualOrInside,
  isRecurringSchedule,
  isTaskPermission,
  isTaskPhase,
  isTaskPriority,
  isValidCron,
  isValidTimeZone,
  matchProjectIdForWorkspace,
  matchWorkspaceForPath,
  nextAfterCompletionAtMs,
  nextRunAtMs,
  normalizeFsPath,
  normalizeTags,
  parseFreezeRequest,
  pathComparisonKey,
  reconcilePhaseStatus,
  requiresPermissionConfirmation,
  resolveHostTimeZone,
  reusableSessionId,
  sanitizeFreezeSnapshot,
  sanitizeHandover,
  scheduleExhausted,
  type BatchTaskAction,
  type BoardSnapshot,
  type ConversationRole,
  type DiscoveredConversation,
  type ExecutionContractSnapshot,
  type ExecutionOutcome,
  type FreezeSnapshot,
  type ScheduleAction,
  type ScheduleMisfirePolicy,
  type ScheduleMode,
  type ScheduleOverlapPolicy,
  type ScheduleRule,
  type ScheduleSessionMode,
  type SubgoalKind,
  type SubgoalStatus,
  type TaskCommentRecord,
  type TaskCreator,
  type TaskEventRecord,
  type TaskFreeze,
  type TaskHandoverInput,
  type TaskPermission,
  type TaskPhase,
  type TaskPriority,
  type TaskRecord,
  type TaskRefKind,
  type TaskRefRecord,
  type TaskSubPhase,
  type TaskTag,
  type WorkspaceRecord,
  type WriteGateMode,
} from '../core/index.ts'
import {
  DefaultAgentBridge,
  SAFE_CONVERSATION_ID_RE,
  type AgentBridge,
  type UpdateConversationAnnotations,
} from './agent-bridge.ts'
import type { BoardDatabase } from './db.ts'
import { LaunchAdmissionQueue } from './launch-admission.ts'
import { readHostThemeMode, type HostPaths } from './paths.ts'
import { previewTaskRef, resolveAllowedRefPath, type RefPreviewError, type RefPreviewResult } from './refs-guard.ts'
import {
  deleteCustomWorkspace as deleteWorkspaceHelper,
  findConversationsByIds,
  listMergedWorkspaces,
  readRecentConversations,
  resolveConversationLineage,
  updateCustomWorkspace as updateWorkspaceHelper,
} from './workspaces.ts'
import {
  cleanupTaskWorktree as cleanupWorktreeHelper,
  ensureTaskWorktree,
  getTaskWorktreeDiff as getWorktreeDiffHelper,
  type WorktreeDiffResult,
  type WorktreeErrorResult,
} from './worktree.ts'

export type MutationSource = 'ui' | 'mcp' | 'hook' | 'scheduler' | 'cli'

export interface ScheduleInputSpec {
  enabled?: boolean
  mode?: ScheduleMode
  cron?: string
  at?: number
  intervalDays?: number
  atHour?: number | null
  atMinute?: number | null
  action?: ScheduleAction
  sessionMode?: ScheduleSessionMode
  misfirePolicy?: ScheduleMisfirePolicy
  overlapPolicy?: ScheduleOverlapPolicy
  timeZone?: string | null
  maxRuns?: number | null
  clear?: boolean
}

export interface CreateTaskInput {
  title: string
  description?: string
  /** Human-exclusive alignment notes (forbidden for MCP/hook sources). */
  userNotes?: string
  prompt?: string
  phase?: TaskPhase
  subPhase?: TaskSubPhase
  priority?: TaskPriority
  workspaceId?: string
  workspacePath?: string
  workspaceLabel?: string
  nextAction?: string
  dueAt?: number
  reminderAt?: number
  pin?: boolean
  writeGate?: WriteGateMode
  mode?: string
  model?: string
  reasoningEffort?: string
  permission?: TaskPermission
  reuseSession?: boolean
  useWorktree?: boolean
  freeze?: FreezeSnapshot | string
  handover?: TaskHandoverInput
  tags?: Array<TaskTag | string>
  subgoals?: Array<{
    id?: string
    title: string
    detail?: string
    kind?: SubgoalKind
    required?: boolean
    dependencies?: string[]
  }>
  refs?: Array<{
    kind: TaskRefKind
    target: string
    label?: string
  }>
  schedule?: ScheduleInputSpec & { enabled: boolean }
  /** Explicit author override; defaults to `ai` for MCP/hook sources. */
  createdBy?: TaskCreator
  /** Conversation that spawned the task. `/btw` ids are validated before binding. */
  originConversationId?: string
  /** Mainline parent when the origin is an untransferred `/btw` side chat. */
  parentConversationId?: string
  /** One-line note on what the agent was investigating when it staged the card. */
  originSummary?: string
  /** Task this card was discovered from. */
  discoveredFromTaskId?: string
}

export interface UpdateTaskPatch {
  title?: string
  description?: string
  /** Human-exclusive alignment notes (forbidden for MCP/hook sources). */
  userNotes?: string
  prompt?: string
  priority?: TaskPriority
  workspaceId?: string | null
  workspacePath?: string | null
  workspaceLabel?: string | null
  blockedReason?: string | null
  nextAction?: string | null
  dueAt?: number | null
  reminderAt?: number | null
  writeGate?: WriteGateMode
  mode?: string | null
  model?: string | null
  reasoningEffort?: string | null
  permission?: TaskPermission | null
  reuseSession?: boolean
  useWorktree?: boolean
  freeze?: FreezeSnapshot | string | null
  handover?: TaskHandoverInput | null
  tags?: Array<TaskTag | string> | null
}

export interface DispatchOptions {
  subgoalId?: string
  mode?: 'auto' | 'new' | 'resume' | 'rework'
  conversationId?: string
  reworkInstructions?: string
  extraInstruction?: string
  model?: string
  profile?: string
  reasoningEffort?: string
  useWorktree?: boolean
  runGroupId?: string
  initiatedBy?: string
  source?: MutationSource
}

export interface BatchTasksInput {
  taskIds: string[]
  action: BatchTaskAction
  subPhase?: 'ready' | 'backlog'
  priority?: TaskPriority
  workspaceId?: string | null
  workspacePath?: string | null
  force?: boolean
}

export interface BatchTasksResult {
  action: BatchTaskAction
  affectedIds: string[]
  skippedIds: string[]
  tasks: TaskRecord[]
}

export interface BoardServiceOptions {
  sessionDefaultPermission?: TaskPermission
  maxConcurrentLaunches?: number
  agentBridge?: AgentBridge
  now?: () => number
  onChanged?: (revision: number) => void
}

export const BOARD_CONVERSATION_TAG = 'agy-board'
export const DEFAULT_CONVERSATION_TITLE_PREFIX = '[Board]'
export const DEFAULT_CONVERSATION_GROUP_ID = 'agy-board'
const CONVERSATION_GOVERNANCE_META_KEY = 'conversation_governance'

export interface ConversationGovernanceConfig {
  autoRename: boolean
  titlePrefix: string
  autoTag: boolean
  autoGroup: boolean
  conversationGroupId: string
  autoArchiveOnFinish: boolean
}

export const DEFAULT_CONVERSATION_GOVERNANCE: Readonly<ConversationGovernanceConfig> = {
  autoRename: true,
  titlePrefix: DEFAULT_CONVERSATION_TITLE_PREFIX,
  autoTag: true,
  autoGroup: true,
  conversationGroupId: DEFAULT_CONVERSATION_GROUP_ID,
  autoArchiveOnFinish: true,
}

export interface ConversationCleanupResult {
  ok: true
  available: boolean
  dryRun: boolean
  scannedTasks: number
  candidateCount: number
  archivedIds: string[]
  skippedIds: string[]
  failedIds: string[]
  errors: Array<{ conversationId: string; error: string }>
}

export function formatGovernedConversationTitle(
  taskTitle: string,
  subgoalTitle?: string,
  prefix = DEFAULT_CONVERSATION_TITLE_PREFIX,
): string {
  const base = subgoalTitle?.trim()
    ? `${taskTitle.trim()} · ${subgoalTitle.trim()}`
    : taskTitle.trim()
  const cleanPrefix = prefix.trim()
  if (!cleanPrefix) return base
  if (base.startsWith(cleanPrefix)) return base
  return `${cleanPrefix} ${base}`
}

export function buildGovernedConversationTags(task: Pick<TaskRecord, 'tags'>): string[] {
  const seen = new Set<string>([BOARD_CONVERSATION_TAG])
  for (const tag of task.tags) {
    const clean = tag.name.trim()
    if (clean) seen.add(clean)
  }
  return [...seen]
}

export function buildDispatchGovernanceAnnotations(
  task: Pick<TaskRecord, 'title' | 'tags'>,
  subgoal: { title: string } | undefined,
  config: ConversationGovernanceConfig,
): UpdateConversationAnnotations {
  const annotations: UpdateConversationAnnotations = {}
  if (config.autoRename) {
    annotations.title = formatGovernedConversationTitle(task.title, subgoal?.title, config.titlePrefix)
  }
  if (config.autoTag) {
    annotations.tags = buildGovernedConversationTags(task)
  }
  if (config.autoGroup) {
    const groupId = config.conversationGroupId.trim()
    if (groupId) {
      annotations.conversationGroupId = groupId
    }
  }
  return annotations
}

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'DomainError'
  }
}

function parseFreezeInput(value: FreezeSnapshot | string, frozenBy?: string, now = Date.now()): TaskFreeze {
  if (typeof value === 'string') {
    const parsed = parseFreezeRequest(value)
    if (!parsed.ok) throw new DomainError(parsed.error.code, parsed.error.message)
    return {
      ...parsed.snapshot,
      frozenAt: now,
      ...(parsed.warnings.includes('redacted') ? { redacted: true } : {}),
      ...(frozenBy ? { frozenBy } : {}),
    }
  }
  const sanitized = sanitizeFreezeSnapshot(value)
  if (!sanitized.ok) throw new DomainError(sanitized.error.code, sanitized.error.message)
  return {
    ...sanitized.snapshot,
    frozenAt: now,
    ...(sanitized.redacted ? { redacted: true } : {}),
    ...(frozenBy ? { frozenBy } : {}),
  }
}

export class BoardService {
  readonly db: BoardDatabase
  readonly paths: HostPaths
  readonly agentBridge: AgentBridge
  readonly admissionQueue: LaunchAdmissionQueue
  readonly sessionDefaultPermission: TaskPermission
  private maxConcurrentLaunches: number
  private readonly nowFn: () => number
  private readonly onChanged?: (revision: number) => void
  private readonly pendingGovernance = new Set<Promise<void>>()

  constructor(db: BoardDatabase, paths: HostPaths, options: BoardServiceOptions = {}) {
    this.db = db
    this.paths = paths
    this.sessionDefaultPermission = options.sessionDefaultPermission ?? DEFAULT_SESSION_PERMISSION
    this.maxConcurrentLaunches = Math.min(Math.max(options.maxConcurrentLaunches ?? 3, 1), 8)
    this.agentBridge = options.agentBridge ?? new DefaultAgentBridge(paths)
    this.nowFn = options.now ?? (() => Date.now())
    this.onChanged = options.onChanged
    this.admissionQueue = new LaunchAdmissionQueue(() => this.maxConcurrentLaunches)
  }

  private now(): number {
    return this.nowFn()
  }

  private notifyRevision(): number {
    const rev = this.db.bumpRevision()
    this.onChanged?.(rev)
    return rev
  }

  private taskSpaceDir(): string | undefined {
    const dbPath = this.db.dbPath
    if (!dbPath || dbPath === ':memory:') return undefined
    return join(dirname(dbPath), 'taskspace')
  }

  private taskSpaceFilePath(taskId: string): string | undefined {
    const dir = this.taskSpaceDir()
    if (!dir || !/^[A-Za-z0-9._-]+$/.test(taskId)) return undefined
    return join(dir, `${taskId}.md`)
  }

  syncTaskSpaceProjection(taskId: string): void {
    const filePath = this.taskSpaceFilePath(taskId)
    if (!filePath) return
    try {
      const task = this.db.getTask(taskId)
      if (!task || task.archivedAt !== undefined || (task.phase !== 'active' && task.phase !== 'needs_you')) {
        if (existsSync(filePath)) rmSync(filePath, { force: true })
        return
      }
      mkdirSync(dirname(filePath), { recursive: true })
      const lines: string[] = [
        '<!-- READ-ONLY TASKSPACE PROJECTION — Managed by agy-board; direct edits are blocked by Write Gate. -->',
        `# ${task.title}`,
        '',
        `- **Task ID**: \`${task.id}\``,
        `- **Phase**: \`${task.phase}\` / \`${task.subPhase}\` (status: \`${task.status}\`)`,
        `- **Priority**: \`${task.priority}\``,
        `- **Write Gate**: \`${task.writeGate}\``,
      ]
      if (task.workspaceLabel || task.workspacePath) {
        lines.push(`- **Workspace**: ${task.workspaceLabel ?? ''} ${task.workspacePath ? `(\`${task.workspacePath}\`)` : ''}`.trim())
      }
      if (task.worktreePath) {
        lines.push(`- **Worktree**: \`${task.worktreePath}\`${task.worktreeBranch ? ` (branch \`${task.worktreeBranch}\`)` : ''}`)
      }
      if (task.dueAt !== undefined) {
        lines.push(`- **Due**: ${new Date(task.dueAt).toISOString()}`)
      }
      if (task.blockedReason) {
        lines.push(`- **Blocked / Status Note**: ${task.blockedReason}`)
      }
      if (task.nextAction) {
        lines.push(`- **Next Action**: ${task.nextAction}`)
      }
      if (task.userNotes?.trim()) {
        lines.push('', '## Human Notes (Owner Only · Highest Priority)', '', task.userNotes.trim())
      }
      if (task.description.trim()) {
        lines.push('', '## Description', '', task.description.trim())
      }
      if (task.prompt.trim()) {
        lines.push('', '## Execution Contract / Prompt', '', task.prompt.trim())
      }
      if (task.freeze) {
        lines.push(
          '',
          '## Freeze Snapshot',
          '',
          `- **Goal**: ${task.freeze.goal}`,
          `- **Progress**: ${task.freeze.progress}`,
          `- **Next**: ${task.freeze.next}`,
        )
      }
      if (task.subgoals.length > 0) {
        lines.push('', '## Subgoals', '')
        for (const sg of task.subgoals) {
          const mark =
            sg.status === 'done'
              ? 'x'
              : sg.status === 'in_progress'
                ? '~'
                : sg.status === 'skipped'
                  ? '-'
                  : ' '
          lines.push(`- [${mark}] \`${sg.id}\` ${sg.title}${sg.required ? ' *(required)*' : ''}`)
        }
      }
      if (task.refs.length > 0 || (task.handover?.references?.length ?? 0) > 0) {
        lines.push('', '## TaskSpace References (Read-Only)', '')
        for (const ref of task.refs) {
          lines.push(`- [${ref.kind}] \`${ref.target}\`${ref.label ? ` — ${ref.label}` : ''}`)
        }
        for (const href of task.handover?.references ?? []) {
          if (!task.refs.some((r) => r.target === href)) {
            lines.push(`- [handover] \`${href}\``)
          }
        }
      }
      if (task.comments && task.comments.length > 0) {
        lines.push('', '## Comments', '')
        for (const c of task.comments.slice(-20)) {
          lines.push(`- **${c.author}** (${new Date(c.createdAt).toISOString()}): ${c.bodyMd}`)
        }
      }
      if (task.executions.length > 0) {
        lines.push('', '## Executions', '')
        for (const ex of task.executions.slice(-5)) {
          const statusLabel = ex.endedAt ? (ex.result ?? 'settled') : 'running'
          const detail = ex.summary || ex.error || ''
          lines.push(
            `- \`${ex.id.slice(0, 8)}\` [${statusLabel}]${ex.conversationId ? ` conv=\`${ex.conversationId}\`` : ''}${detail ? ` — ${detail}` : ''}`,
          )
        }
      }
      lines.push('')
      writeFileSync(filePath, lines.join('\n'), 'utf8')
    } catch {
      // Never fail primary DB operations if projection directory is read-only
    }
  }

  private appendEvent(
    taskId: string,
    kind: string,
    source: MutationSource,
    payload: Record<string, unknown> = {},
    opts: { subgoalId?: string; conversationId?: string; createdAt?: number } = {},
  ): void {
    this.db.db
      .prepare(
        `INSERT INTO task_events (id, task_id, subgoal_id, conversation_id, kind, source, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        taskId,
        opts.subgoalId ?? null,
        opts.conversationId ?? null,
        kind,
        source,
        JSON.stringify(payload),
        opts.createdAt ?? this.now(),
      )
  }

  listWorkspaces(): WorkspaceRecord[] {
    return listMergedWorkspaces(this.db, this.paths)
  }

  registerCustomWorkspace(input: { name?: string; rootPath: string; pinned?: boolean }): WorkspaceRecord {
    const normalized = normalizeFsPath(input.rootPath)
    if (!normalized) throw new DomainError('invalid-workspace', 'Workspace rootPath must not be empty.')
    const workspaces = this.listWorkspaces()
    const matchedProject = matchProjectIdForWorkspace(undefined, normalized, workspaces)
    const now = this.now()
    const existing = workspaces.find((w) => normalizeFsPath(w.rootPath).toLowerCase() === normalized.toLowerCase())
    const record: WorkspaceRecord = existing
      ? {
          ...existing,
          name: input.name?.trim() || existing.name,
          pinned: input.pinned ?? existing.pinned,
          lastUsedAt: now,
          antigravityProjectId: existing.antigravityProjectId ?? matchedProject,
        }
      : {
          id: `ws-${randomUUID().slice(0, 8)}`,
          name: input.name?.trim() || normalized.split(/[\\/]/).filter(Boolean).pop() || normalized,
          rootPath: normalized,
          folderPaths: [normalized],
          antigravityProjectId: matchedProject,
          source: 'custom',
          pinned: Boolean(input.pinned),
          lastUsedAt: now,
          createdAt: now,
        }
    this.db.inTransaction(() => {
      this.db.upsertWorkspace(record)
      this.notifyRevision()
    })
    return record
  }

  updateCustomWorkspace(
    workspaceId: string,
    patch: { name?: string; rootPath?: string; pinned?: boolean },
  ): WorkspaceRecord {
    let result!: WorkspaceRecord
    this.db.inTransaction(() => {
      const updated = updateWorkspaceHelper(this.db, this.paths, workspaceId, patch, this.now())
      if ('errorCode' in updated) {
        throw new DomainError(updated.errorCode, updated.message)
      }
      result = updated
      this.notifyRevision()
    })
    return result
  }

  deleteCustomWorkspace(workspaceId: string): void {
    this.db.inTransaction(() => {
      const res = deleteWorkspaceHelper(this.db, this.paths, workspaceId)
      if (!res.ok) {
        throw new DomainError(res.errorCode, res.message)
      }
      this.notifyRevision()
    })
  }

  listRecentConversations(options: { projectId?: string; workspacePath?: string; limit?: number } = {}): {
    available: boolean
    conversations: DiscoveredConversation[]
  } {
    return readRecentConversations(this.paths, options)
  }

  getSnapshot(options: { includeArchived?: boolean; activeWorkspacePaths?: string[] } = {}): BoardSnapshot {
    const now = this.now()
    const workspaces = this.listWorkspaces()
    const activeWorkspacePaths = (options.activeWorkspacePaths ?? []).map(normalizeFsPath).filter(Boolean)
    let activeMatch = undefined
    for (const ap of activeWorkspacePaths) {
      activeMatch = matchWorkspaceForPath(ap, workspaces)
      if (activeMatch) break
    }
    const convDiscovery = readRecentConversations(this.paths, { limit: 150 })
    const convById = new Map(convDiscovery.conversations.map((c) => [c.conversationId, c]))

    const rawTasks = this.db.listTasks({ includeArchived: options.includeArchived ?? true })
    const missingConvIds = new Set<string>()
    for (const t of rawTasks) {
      for (const link of t.conversations) {
        if (!convById.has(link.conversationId)) missingConvIds.add(link.conversationId)
      }
    }
    if (missingConvIds.size > 0) {
      const direct = findConversationsByIds(this.paths, [...missingConvIds])
      for (const [id, conv] of direct.map) convById.set(id, conv)
    }

    const tasks = rawTasks.map((task) => ({
      ...task,
      conversations: task.conversations.map((link) => {
        const live = convById.get(link.conversationId)
        return live
          ? {
              ...link,
              title: live.title,
              liveStatus: live.status,
              isIdle: live.isIdle,
            }
          : link
      }),
    }))

    const counts = {
      needs_you: 0,
      active: 0,
      on_hold: 0,
      todo: 0,
      closed: 0,
      archived: 0,
      dueReminders: 0,
    }
    for (const task of tasks) {
      if (task.archivedAt !== undefined) {
        counts.archived += 1
        continue
      }
      counts[task.phase] += 1
      if (
        task.phase !== 'closed' &&
        task.userMarks?.ignoredAt === undefined &&
        task.reminderAt !== undefined &&
        task.reminderAt <= now &&
        (task.remindedAt === undefined || task.remindedAt < task.reminderAt)
      ) {
        counts.dueReminders += 1
      }
    }

    return {
      revision: this.db.getRevision(),
      serverTime: now,
      timeZone: resolveHostTimeZone(),
      hostTheme: readHostThemeMode(this.paths.geminiConfigDir),
      sessionDefaultPermission: this.sessionDefaultPermission,
      maxConcurrentLaunches: this.maxConcurrentLaunches,
      workspaces,
      activeWorkspacePaths,
      activeProjectId: activeMatch?.antigravityProjectId ?? activeMatch?.id,
      tasks,
      recentConversations: convDiscovery.conversations,
      counts,
    }
  }

  getTask(taskId: string): TaskRecord | undefined {
    const task = this.db.getTask(taskId)
    if (!task) return undefined
    const linkedIds = task.conversations.map((c) => c.conversationId)
    const direct = findConversationsByIds(this.paths, linkedIds)
    return {
      ...task,
      conversations: task.conversations.map((link) => {
        const live = direct.map.get(link.conversationId)
        return live ? { ...link, title: live.title, liveStatus: live.status, isIdle: live.isIdle } : link
      }),
    }
  }

  listTaskEvents(taskId: string, limit = 100): TaskEventRecord[] {
    return this.db.listTaskEvents(taskId, limit)
  }

  private resolveWorkspaceBinding(
    input: { workspaceId?: string; workspacePath?: string; workspaceLabel?: string },
    workspaces: readonly WorkspaceRecord[],
  ): { workspaceId?: string; workspacePath?: string; workspaceLabel?: string } {
    let workspaceId = input.workspaceId?.trim() || undefined
    let workspacePath = input.workspacePath ? normalizeFsPath(input.workspacePath) : undefined
    let workspaceLabel = input.workspaceLabel?.trim() || undefined

    const deriveLabelForWorkspace = (ws: WorkspaceRecord, chosenPath?: string): string => {
      if (!chosenPath) return ws.name
      if (ws.rootPath && pathComparisonKey(chosenPath) === pathComparisonKey(ws.rootPath)) {
        return ws.name
      }
      const leaf = chosenPath.split(/[\\/]/).filter(Boolean).pop()
      return leaf || ws.name
    }

    if (workspaceId) {
      const ws = workspaces.find((w) => w.id === workspaceId || w.antigravityProjectId === workspaceId)
      if (ws) {
        workspaceId = ws.id
        workspacePath = workspacePath ?? (ws.rootPath || undefined)
        workspaceLabel = workspaceLabel ?? deriveLabelForWorkspace(ws, workspacePath)
      }
    } else if (workspacePath) {
      const matched = matchWorkspaceForPath(workspacePath, workspaces)
      if (matched) {
        workspaceId = matched.id
        workspaceLabel = workspaceLabel ?? deriveLabelForWorkspace(matched, workspacePath)
      } else {
        workspaceLabel = workspaceLabel ?? (workspacePath.split(/[\\/]/).filter(Boolean).pop() || workspacePath)
      }
    }
    return { workspaceId, workspacePath, workspaceLabel }
  }

  private buildScheduleRule(
    spec: ScheduleInputSpec,
    now: number,
    taskPhase: TaskPhase = 'todo',
    current?: ScheduleRule,
  ): ScheduleRule {
    const mode: ScheduleMode = spec.mode ?? current?.mode ?? 'cron'
    const enabled = spec.enabled ?? current?.enabled ?? false
    const zone =
      spec.timeZone === null
        ? resolveHostTimeZone()
        : spec.timeZone?.trim() || current?.timeZone || resolveHostTimeZone()
    if (!isValidTimeZone(zone)) {
      throw new DomainError('invalid-timezone', `Unsupported IANA time zone: ${zone}`)
    }

    const action: ScheduleAction = spec.action ?? current?.action ?? 'dispatch'
    const sessionMode: ScheduleSessionMode =
      spec.sessionMode ?? current?.sessionMode ?? (mode === 'once' ? 'auto' : 'new')
    const misfirePolicy: ScheduleMisfirePolicy = spec.misfirePolicy ?? current?.misfirePolicy ?? 'prompt'
    const overlapPolicy: ScheduleOverlapPolicy = spec.overlapPolicy ?? current?.overlapPolicy ?? 'wait_review'

    const maxRuns =
      spec.maxRuns === null
        ? undefined
        : spec.maxRuns !== undefined
          ? spec.maxRuns > 0
            ? Math.trunc(spec.maxRuns)
            : undefined
          : current?.maxRuns

    const modeChanged = current !== undefined && current.mode !== mode
    const rearmingEndedOnce =
      mode === 'once' && enabled && current !== undefined && current.endedAt !== undefined
    const runCount = modeChanged || rearmingEndedOnce ? 0 : (current?.runCount ?? 0)
    const isEditingDefinition =
      spec.mode !== undefined ||
      spec.cron !== undefined ||
      spec.at !== undefined ||
      spec.intervalDays !== undefined ||
      spec.atHour !== undefined ||
      spec.atMinute !== undefined
    const keepTransientState = !enabled && !isEditingDefinition

    const baseFields: Partial<ScheduleRule> = {
      action,
      sessionMode,
      misfirePolicy,
      overlapPolicy,
      ...(current?.lastTriggeredAt !== undefined ? { lastTriggeredAt: current.lastTriggeredAt } : {}),
      ...(keepTransientState && current?.endedAt !== undefined ? { endedAt: current.endedAt } : {}),
      ...(keepTransientState && current?.endedReason !== undefined ? { endedReason: current.endedReason } : {}),
      ...(keepTransientState && current?.skippedAt !== undefined ? { skippedAt: current.skippedAt } : {}),
      ...(keepTransientState && current?.skippedReason !== undefined ? { skippedReason: current.skippedReason } : {}),
      ...(keepTransientState && current?.missedSlotAt !== undefined ? { missedSlotAt: current.missedSlotAt } : {}),
    }

    if (mode === 'once') {
      const at = spec.at ?? current?.at
      if (typeof at !== 'number' || !Number.isFinite(at)) {
        throw new DomainError('invalid-schedule', 'One-shot schedule requires numeric `at` epoch milliseconds.')
      }
      if (enabled && at <= now) {
        throw new DomainError('invalid-schedule', 'One-shot schedule `at` must be in the future.')
      }
      return {
        ...baseFields,
        enabled,
        mode: 'once',
        at: Math.trunc(at),
        timeZone: zone,
        nextRunAt: enabled ? Math.trunc(at) : undefined,
        runCount,
      }
    }

    if (mode === 'after_completion') {
      const rawDays = spec.intervalDays ?? current?.intervalDays
      if (typeof rawDays !== 'number' || !Number.isFinite(rawDays) || Math.trunc(rawDays) < 1) {
        throw new DomainError('invalid-schedule', 'After-completion schedule requires `intervalDays` >= 1.')
      }
      const intervalDays = Math.trunc(rawDays)
      const atHour =
        spec.atHour === null
          ? undefined
          : spec.atHour !== undefined
            ? Math.trunc(spec.atHour)
            : current?.atHour
      const atMinute =
        spec.atMinute === null
          ? undefined
          : spec.atMinute !== undefined
            ? Math.trunc(spec.atMinute)
            : current?.atMinute
      if (atHour !== undefined && (!Number.isInteger(atHour) || atHour < 0 || atHour > 23)) {
        throw new DomainError('invalid-schedule', 'Schedule `atHour` must be an integer between 0 and 23.')
      }
      if (atMinute !== undefined && (!Number.isInteger(atMinute) || atMinute < 0 || atMinute > 59)) {
        throw new DomainError('invalid-schedule', 'Schedule `atMinute` must be an integer between 0 and 59.')
      }
      const waitingForCurrentRound = taskPhase === 'needs_you' || taskPhase === 'active'
      const nextRunAt =
        enabled && !waitingForCurrentRound
          ? nextAfterCompletionAtMs(now, intervalDays, zone, atHour, atMinute)
          : undefined
      return {
        ...baseFields,
        enabled,
        mode: 'after_completion',
        intervalDays,
        ...(atHour !== undefined ? { atHour } : {}),
        ...(atMinute !== undefined ? { atMinute } : {}),
        timeZone: zone,
        nextRunAt,
        runCount,
        ...(maxRuns !== undefined ? { maxRuns } : {}),
      }
    }

    const cron = (spec.cron ?? current?.cron ?? '').trim()
    if (!isValidCron(cron)) {
      throw new DomainError('invalid-cron', `Invalid 5-field cron expression: ${cron}`)
    }
    const nextRun = enabled ? nextRunAtMs(cron, now, zone) : undefined
    if (enabled && nextRun === undefined) {
      throw new DomainError('unreachable-cron', `Cron expression '${cron}' has no reachable run instant.`)
    }
    return {
      ...baseFields,
      enabled,
      mode: 'cron',
      cron,
      timeZone: zone,
      nextRunAt: nextRun,
      runCount,
      ...(maxRuns !== undefined ? { maxRuns } : {}),
    }
  }

  /**
   * Resolve where an agent-staged card came from. Antigravity's untransferred
   * `/btw` side chats never reach `conversation_summaries.db`, so binding their
   * transient id would produce a dead jump link. Persist the provenance id but
   * only create a navigable `origin` link when the id (or its mainline parent)
   * is actually known.
   */
  private resolveOriginConversation(
    input: CreateTaskInput,
    source: MutationSource,
  ): { persistedId?: string; bindableId?: string } {
    const explicit = input.originConversationId?.trim() ?? ''
    const fromEnv = source === 'mcp' ? (process.env.ANTIGRAVITY_CONVERSATION_ID ?? '').trim() : ''
    const candidate = explicit || fromEnv
    const parentHint = input.parentConversationId?.trim() ?? ''
    if (!candidate && !parentHint) return {}

    const lookup = findConversationsByIds(this.paths, [candidate, parentHint].filter(Boolean))
    const known = (id: string) => Boolean(id) && lookup.map.has(id)

    if (candidate && known(candidate)) return { persistedId: candidate, bindableId: candidate }
    if (parentHint && known(parentHint)) return { persistedId: candidate || parentHint, bindableId: parentHint }

    if (candidate) {
      const parent = resolveConversationLineage(this.paths, candidate).parentConversationId
      if (parent && known(parent)) return { persistedId: candidate, bindableId: parent }
    }
    if (parentHint) {
      const parent = resolveConversationLineage(this.paths, parentHint).parentConversationId
      if (parent && known(parent)) return { persistedId: candidate || parentHint, bindableId: parent }
    }

    // Discovery unavailable (e.g. no Antigravity store on this host): best effort.
    if (!lookup.available) {
      const bind = candidate || parentHint
      return { persistedId: bind, bindableId: bind }
    }
    // Ephemeral /btw: keep provenance, skip the dead link.
    return { persistedId: candidate || parentHint }
  }

  createTask(input: CreateTaskInput, source: MutationSource = 'ui'): TaskRecord {
    const title = input.title?.trim() ?? ''
    if (!title) throw new DomainError('title-required', 'Task title must not be blank.')
    if (input.userNotes !== undefined && (source === 'mcp' || source === 'hook')) {
      throw new DomainError(
        'user-notes-human-only',
        'Human notes (userNotes) are exclusively controlled by the human user and cannot be set by agent MCP/hook calls.',
      )
    }
    const now = this.now()
    const id = randomUUID()
    const workspaces = this.listWorkspaces()
    const ws = this.resolveWorkspaceBinding(input, workspaces)

    const priority: TaskPriority = isTaskPriority(input.priority) ? input.priority : 'normal'
    const initialPhase: TaskPhase = isTaskPhase(input.phase) ? input.phase : 'todo'
    // Agent-staged cards land in `todo/draft` until a human approves them.
    // Humans creating from the UI go straight to `ready`; the Backlog pool stays `backlog`.
    const defaultSubPhase: TaskSubPhase =
      initialPhase === 'todo' && input.subPhase === undefined && source === 'mcp' ? 'draft' : 'ready'
    const reconciled = reconcilePhaseStatus(initialPhase, input.subPhase ?? defaultSubPhase)
    const tags = normalizeTags(input.tags ?? [])
    const writeGate: WriteGateMode = input.writeGate === 'locked' ? 'locked' : 'unlocked'
    const createdBy: TaskCreator =
      input.createdBy === 'ai' || input.createdBy === 'user'
        ? input.createdBy
        : source === 'mcp' || source === 'hook'
          ? 'ai'
          : 'user'

    if (input.discoveredFromTaskId?.trim()) {
      const parentTask = this.db.getTask(input.discoveredFromTaskId.trim())
      if (!parentTask) {
        throw new DomainError(
          'discovered-from-not-found',
          `discoveredFromTaskId '${input.discoveredFromTaskId}' does not match an existing task.`,
        )
      }
    }

    const origin = this.resolveOriginConversation(input, source)

    let freeze: TaskFreeze | undefined
    if (input.freeze !== undefined) {
      freeze = parseFreezeInput(input.freeze, source, now)
    }

    let handover = undefined
    if (input.handover !== undefined) {
      const sanitized = sanitizeHandover(input.handover)
      if (!sanitized) throw new DomainError('invalid-handover', 'Handover bundle failed validation.')
      handover = handoverOf(sanitized, now)
    }

    const permission = input.permission !== undefined ? (isTaskPermission(input.permission) ? input.permission : undefined) : undefined
    if (input.permission !== undefined && permission === undefined) {
      throw new DomainError('invalid-permission', `Unsupported permission '${String(input.permission)}'.`)
    }

    const schedule = input.schedule && !input.schedule.clear
      ? this.buildScheduleRule(input.schedule, now, reconciled.phase)
      : undefined

    const preparedSubgoals: Array<{
      id: string
      title: string
      detail: string
      kind: SubgoalKind
      required: boolean
      sortOrder: number
      dependencies: string[]
    }> = (input.subgoals ?? []).map((sg, idx) => {
      const sgTitle = sg.title?.trim() ?? ''
      if (!sgTitle) throw new DomainError('invalid-subgoal', 'Subgoal title must not be blank.')
      return {
        id: sg.id?.trim() || randomUUID(),
        title: sgTitle,
        detail: sg.detail?.trim() ?? '',
        kind: sg.kind ?? 'custom',
        required: sg.required !== false,
        sortOrder: idx,
        dependencies: sg.dependencies ?? [],
      }
    })
    if (preparedSubgoals.length > 0) {
      const depCheck = checkSubgoalDependencies(preparedSubgoals)
      if (!depCheck.ok) throw new DomainError('invalid-subgoal-deps', depCheck.error)
    }

    this.db.inTransaction(() => {
      this.db.db
        .prepare(
          `INSERT INTO tasks (
            id, title, description, user_notes, prompt, phase, sub_phase, status, priority,
            workspace_id, workspace_path, workspace_label, blocked_reason, next_action,
            due_at, reminder_at, sort_order, write_gate, mode, model, reasoning_effort,
            permission, permission_confirmed_at, reuse_session, use_worktree, freeze_json, handover_json,
            tags_json, schedule_json, plan_revision, created_at, updated_at, completed_at,
            created_by, origin_conversation_id, origin_summary, discovered_from_task_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          title,
          input.description?.trim() ?? '',
          input.userNotes?.trim() ?? '',
          input.prompt?.trim() ?? '',
          reconciled.phase,
          reconciled.subPhase,
          reconciled.status,
          priority,
          ws.workspaceId ?? null,
          ws.workspacePath ?? null,
          ws.workspaceLabel ?? null,
          null,
          input.nextAction?.trim() || null,
          typeof input.dueAt === 'number' ? input.dueAt : null,
          typeof input.reminderAt === 'number' ? input.reminderAt : null,
          0,
          writeGate,
          input.mode?.trim() || null,
          input.model?.trim() || null,
          input.reasoningEffort?.trim() || null,
          permission ?? null,
          null,
          input.reuseSession === true ? 1 : 0,
          input.useWorktree === true ? 1 : 0,
          freeze ? JSON.stringify(freeze) : null,
          handover ? JSON.stringify(handover) : null,
          JSON.stringify(tags),
          schedule ? JSON.stringify(schedule) : null,
          preparedSubgoals.length > 0 ? 1 : 0,
          now,
          now,
          reconciled.phase === 'closed' ? now : null,
          createdBy,
          origin.persistedId ?? null,
          input.originSummary?.trim() || null,
          input.discoveredFromTaskId?.trim() || null,
        )

      for (const sg of preparedSubgoals) {
        this.db.db
          .prepare(
            `INSERT INTO task_subgoals (id, task_id, title, detail, kind, required, status, sort_order, dependencies_json, added_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
          )
          .run(sg.id, id, sg.title, sg.detail, sg.kind, sg.required ? 1 : 0, sg.sortOrder, JSON.stringify(sg.dependencies), source, now)
      }

      for (const ref of input.refs ?? []) {
        const target = ref.target?.trim()
        if (!target) continue
        this.db.db
          .prepare(
            `INSERT OR IGNORE INTO task_refs (id, task_id, kind, target, label, added_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(randomUUID(), id, ref.kind, target, ref.label?.trim() || null, source, now)
      }

      if (origin.bindableId) {
        this.db.db
          .prepare(
            `INSERT INTO task_conversations (task_id, subgoal_id, conversation_id, role, workspace_id, linked_at, summary, include_in_handoff)
             VALUES (?, '', ?, 'origin', ?, ?, ?, 1)
             ON CONFLICT(task_id, subgoal_id, conversation_id) DO UPDATE SET
               role = 'origin',
               linked_at = excluded.linked_at`,
          )
          .run(id, origin.bindableId, ws.workspaceId ?? null, now, input.originSummary?.trim() || null)
      }

      if (input.pin) {
        this.db.db
          .prepare(
            `INSERT INTO task_user_marks (task_id, pinned_at, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(task_id) DO UPDATE SET pinned_at = excluded.pinned_at, updated_at = excluded.updated_at`,
          )
          .run(id, now, now)
      }

      this.appendEvent(
        id,
        'task_created',
        source,
        {
          title,
          phase: reconciled.phase,
          subPhase: reconciled.subPhase,
          pin: Boolean(input.pin),
          workspacePath: ws.workspacePath,
          createdBy,
          ...(input.discoveredFromTaskId?.trim() ? { discoveredFromTaskId: input.discoveredFromTaskId.trim() } : {}),
          ...(origin.persistedId ? { originConversationId: origin.persistedId, originBindable: Boolean(origin.bindableId) } : {}),
        },
        { createdAt: now },
      )
      this.notifyRevision()
    })

    this.syncTaskSpaceProjection(id)
    return this.getTask(id)!
  }

  updateTask(taskId: string, patch: UpdateTaskPatch, source: MutationSource = 'ui'): TaskRecord {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    const now = this.now()

    // Human-exclusive notes are never locked for humans, and strictly protected from AI/MCP overwrites.
    if (patch.userNotes !== undefined && (source === 'mcp' || source === 'hook')) {
      throw new DomainError(
        'user-notes-human-only',
        'Human notes (userNotes) are exclusively controlled by the human user and cannot be overwritten by AI/MCP calls; use board_comment_add instead.',
      )
    }

    const nextTitle = patch.title !== undefined ? patch.title.trim() : task.title
    if (!nextTitle) throw new DomainError('title-required', 'Task title must not be blank.')

    const nextDescription = patch.description !== undefined ? patch.description.trim() : task.description
    const nextUserNotes = patch.userNotes !== undefined ? patch.userNotes.trim() : (task.userNotes ?? '')
    const nextPrompt = patch.prompt !== undefined ? patch.prompt.trim() : task.prompt
    const nextPriority = patch.priority !== undefined ? (isTaskPriority(patch.priority) ? patch.priority : task.priority) : task.priority

    const workspaces = this.listWorkspaces()
    let wsId = task.workspaceId
    let wsPath = task.workspacePath
    let wsLabel = task.workspaceLabel
    if (patch.workspaceId !== undefined || patch.workspacePath !== undefined || patch.workspaceLabel !== undefined) {
      if (patch.workspaceId === null && patch.workspacePath === null) {
        wsId = undefined
        wsPath = undefined
        wsLabel = undefined
      } else {
        const resolved = this.resolveWorkspaceBinding(
          {
            workspaceId: patch.workspaceId === null ? undefined : (patch.workspaceId ?? task.workspaceId),
            workspacePath: patch.workspacePath === null ? undefined : (patch.workspacePath ?? task.workspacePath),
            workspaceLabel: patch.workspaceLabel === null ? undefined : patch.workspaceLabel,
          },
          workspaces,
        )
        wsId = resolved.workspaceId
        wsPath = resolved.workspacePath
        wsLabel = resolved.workspaceLabel
      }
    }

    const nextBlockedReason = patch.blockedReason === null ? undefined : (patch.blockedReason ?? task.blockedReason)
    const nextAction = patch.nextAction === null ? undefined : (patch.nextAction !== undefined ? patch.nextAction.trim() || undefined : task.nextAction)
    const nextDueAt = patch.dueAt === null ? undefined : (patch.dueAt ?? task.dueAt)
    const nextReminderAt = patch.reminderAt === null ? undefined : (patch.reminderAt ?? task.reminderAt)
    const resetRemindedAt = patch.reminderAt !== undefined ? undefined : task.remindedAt
    const nextWriteGate = patch.writeGate ?? task.writeGate

    const nextMode = patch.mode === null ? undefined : (patch.mode !== undefined ? patch.mode.trim() || undefined : task.mode)
    const nextModel = patch.model === null ? undefined : (patch.model !== undefined ? patch.model.trim() || undefined : task.model)
    const nextEffort = patch.reasoningEffort === null ? undefined : (patch.reasoningEffort !== undefined ? patch.reasoningEffort.trim() || undefined : task.reasoningEffort)
    const nextReuse = patch.reuseSession ?? task.reuseSession
    const nextUseWorktree = patch.useWorktree ?? Boolean(task.useWorktree)

    let nextPermission = task.permission
    let permissionChanged = false
    if (patch.permission === null) {
      permissionChanged = task.permission !== undefined
      nextPermission = undefined
    } else if (patch.permission !== undefined) {
      if (!isTaskPermission(patch.permission)) {
        throw new DomainError('invalid-permission', `Unsupported permission '${String(patch.permission)}'.`)
      }
      permissionChanged = patch.permission !== task.permission
      nextPermission = patch.permission
    }

    let nextHandover = task.handover
    let handoverChanged = false
    if (patch.handover === null) {
      handoverChanged = task.handover !== undefined
      nextHandover = undefined
    } else if (patch.handover !== undefined) {
      const sanitized = sanitizeHandover(patch.handover)
      if (!sanitized) throw new DomainError('invalid-handover', 'Handover bundle failed validation.')
      nextHandover = handoverOf(sanitized, now)
      handoverChanged = true
    }

    // Re-arm confirmation gate on any permission or handover change (anti confirm-then-swap)
    const nextConfirmedAt = permissionChanged || handoverChanged ? undefined : task.permissionConfirmedAt

    let nextFreeze = task.freeze
    if (patch.freeze === null) {
      nextFreeze = undefined
    } else if (patch.freeze !== undefined) {
      nextFreeze = parseFreezeInput(patch.freeze, source, now)
    }

    const nextTags = patch.tags === null ? [] : patch.tags !== undefined ? normalizeTags(patch.tags) : task.tags

    this.db.inTransaction(() => {
      this.db.db
        .prepare(
          `UPDATE tasks SET
            title = ?, description = ?, user_notes = ?, prompt = ?, priority = ?,
            workspace_id = ?, workspace_path = ?, workspace_label = ?,
            blocked_reason = ?, next_action = ?, due_at = ?, reminder_at = ?, reminded_at = ?,
            write_gate = ?, mode = ?, model = ?, reasoning_effort = ?,
            permission = ?, permission_confirmed_at = ?, reuse_session = ?, use_worktree = ?,
            freeze_json = ?, handover_json = ?, tags_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          nextTitle,
          nextDescription,
          nextUserNotes,
          nextPrompt,
          nextPriority,
          wsId ?? null,
          wsPath ?? null,
          wsLabel ?? null,
          nextBlockedReason ?? null,
          nextAction ?? null,
          nextDueAt ?? null,
          nextReminderAt ?? null,
          resetRemindedAt ?? null,
          nextWriteGate,
          nextMode ?? null,
          nextModel ?? null,
          nextEffort ?? null,
          nextPermission ?? null,
          nextConfirmedAt ?? null,
          nextReuse ? 1 : 0,
          nextUseWorktree ? 1 : 0,
          nextFreeze ? JSON.stringify(nextFreeze) : null,
          nextHandover ? JSON.stringify(nextHandover) : null,
          JSON.stringify(nextTags),
          now,
          taskId,
        )

      this.appendEvent(taskId, 'task_updated', source, { fields: Object.keys(patch) }, { createdAt: now })
      this.notifyRevision()
    })

    this.syncTaskSpaceProjection(taskId)
    return this.getTask(taskId)!
  }

  /** Human-only action via UI HTTP API; intentionally NOT exposed as an MCP tool. */
  confirmPermission(taskId: string): TaskRecord {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    const now = this.now()
    this.db.inTransaction(() => {
      const nextSubPhase =
        task.phase === 'needs_you' && task.subPhase === 'permission_pending' ? 'ready' : task.subPhase
      const nextPhase =
        task.phase === 'needs_you' && task.subPhase === 'permission_pending' ? 'todo' : task.phase
      const reconciled = reconcilePhaseStatus(nextPhase, nextSubPhase)
      this.db.db
        .prepare(
          `UPDATE tasks SET permission_confirmed_at = ?, phase = ?, sub_phase = ?, status = ?, blocked_reason = CASE WHEN sub_phase = 'permission_pending' THEN NULL ELSE blocked_reason END, updated_at = ? WHERE id = ?`,
        )
        .run(now, reconciled.phase, reconciled.subPhase, reconciled.status, now, taskId)
      this.appendEvent(taskId, 'permission_confirmed', 'ui', { permission: task.handover?.permission ?? task.permission }, { createdAt: now })
      this.notifyRevision()
    })
    this.syncTaskSpaceProjection(taskId)
    return this.getTask(taskId)!
  }

  private clearSnoozeForTask(taskId: string, now: number): void {
    this.db.db
      .prepare('UPDATE task_user_marks SET snoozed_until = NULL, updated_at = ? WHERE task_id = ? AND snoozed_until IS NOT NULL')
      .run(now, taskId)
  }

  transitionPhase(
    taskId: string,
    targetPhase: TaskPhase,
    options: {
      subPhase?: TaskSubPhase
      blockedReason?: string | null
      nextAction?: string | null
      force?: boolean
      source?: MutationSource
      sortOrder?: number
    } = {},
  ): TaskRecord {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    if (task.archivedAt !== undefined) throw new DomainError('task-archived', 'Restore archived task before changing phase.')

    const source = options.source ?? 'ui'
    const now = this.now()
    const reconciled = reconcilePhaseStatus(targetPhase, options.subPhase)

    if (reconciled.phase === 'closed' && reconciled.subPhase !== 'cancelled') {
      const gate = canCloseTaskWithSubgoals(task.subgoals, Boolean(options.force))
      if (!gate.allowed) {
        throw new DomainError('required-subgoals-open', gate.reason)
      }
    }

    if (hasOpenExecution(task) && source !== 'hook' && !options.force && reconciled.phase !== 'active') {
      throw new DomainError('execution-open', 'Cannot move task away from active while an execution is still running (settle or force first).')
    }

    const blockedReason =
      options.blockedReason !== undefined
        ? options.blockedReason
        : reconciled.phase === 'needs_you' || reconciled.phase === 'on_hold'
          ? task.blockedReason ?? null
          : null

    const completedAt = reconciled.phase === 'closed' ? (task.completedAt ?? now) : null

    this.db.inTransaction(() => {
      this.db.db
        .prepare(
          `UPDATE tasks SET
            phase = ?, sub_phase = ?, status = ?,
            blocked_reason = ?,
            next_action = COALESCE(?, next_action),
            sort_order = COALESCE(?, sort_order),
            completed_at = ?,
            updated_at = ?
           WHERE id = ?`,
        )
        .run(
          reconciled.phase,
          reconciled.subPhase,
          reconciled.status,
          blockedReason,
          options.nextAction === undefined ? null : options.nextAction,
          options.sortOrder ?? null,
          completedAt,
          now,
          taskId,
        )

      if (reconciled.phase === 'needs_you') {
        this.clearSnoozeForTask(taskId, now)
      }

      // Closing a recurring task is the explicit "finish and stop repeating"
      // path; acceptance rounds use completeScheduleCycle instead.
      if (reconciled.phase === 'closed') {
        this.stopScheduleOnClose(taskId, task.schedule, now)
      }

      this.appendEvent(
        taskId,
        'phase_changed',
        source,
        { from: task.phase, to: reconciled.phase, subPhase: reconciled.subPhase, reason: blockedReason },
        { createdAt: now },
      )
      this.notifyRevision()
    })

    this.syncTaskSpaceProjection(taskId)
    const updated = this.getTask(taskId)!
    if (reconciled.phase === 'closed') {
      this.scheduleArchiveConversationsForTasks([updated])
    }
    return updated
  }

  reorderPhaseTasks(phase: TaskPhase, orderedTaskIds: string[]): void {
    const now = this.now()
    this.db.inTransaction(() => {
      const stmt = this.db.db.prepare('UPDATE tasks SET sort_order = ?, updated_at = ? WHERE id = ? AND phase = ?')
      orderedTaskIds.forEach((id, index) => {
        stmt.run(index, now, id, phase)
      })
      this.notifyRevision()
    })
  }

  archiveTask(taskId: string, source: MutationSource = 'ui'): TaskRecord {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    if (hasOpenExecution(task)) throw new DomainError('execution-open', 'Cannot archive task with an active running execution.')
    const now = this.now()
    this.db.inTransaction(() => {
      this.db.db.prepare('UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, taskId)
      this.appendEvent(taskId, 'task_archived', source, {}, { createdAt: now })
      this.notifyRevision()
    })
    this.syncTaskSpaceProjection(taskId)
    const updated = this.getTask(taskId)!
    this.scheduleArchiveConversationsForTasks([updated])
    return updated
  }

  restoreTask(taskId: string, source: MutationSource = 'ui'): TaskRecord {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    const now = this.now()
    this.db.inTransaction(() => {
      this.db.db.prepare('UPDATE tasks SET archived_at = NULL, updated_at = ? WHERE id = ?').run(now, taskId)
      this.appendEvent(taskId, 'task_restored', source, {}, { createdAt: now })
      this.notifyRevision()
    })
    this.syncTaskSpaceProjection(taskId)
    return this.getTask(taskId)!
  }

  deleteTask(taskId: string): void {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    if (hasOpenExecution(task)) throw new DomainError('execution-open', 'Cannot delete task while an execution is running.')
    this.db.inTransaction(() => {
      this.db.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
      this.notifyRevision()
    })
    this.syncTaskSpaceProjection(taskId)
  }

  setUserMarks(
    taskId: string,
    marks: { ack?: boolean; ignore?: boolean; pin?: boolean; snoozeUntil?: number | null },
    source: MutationSource = 'ui',
  ): TaskRecord {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    const now = this.now()
    const ackedAt = marks.ack === undefined ? (task.userMarks?.ackedAt ?? null) : (marks.ack ? now : null)
    const ignoredAt = marks.ignore === undefined ? (task.userMarks?.ignoredAt ?? null) : (marks.ignore ? now : null)
    const pinnedAt = marks.pin === undefined ? (task.userMarks?.pinnedAt ?? null) : (marks.pin ? now : null)
    let snoozedUntil: number | null
    if (marks.snoozeUntil === undefined) {
      snoozedUntil = task.userMarks?.snoozedUntil ?? null
    } else if (marks.snoozeUntil === null) {
      snoozedUntil = null
    } else if (typeof marks.snoozeUntil === 'number' && Number.isFinite(marks.snoozeUntil)) {
      snoozedUntil = Math.trunc(marks.snoozeUntil)
    } else {
      throw new DomainError('invalid-snooze', 'snoozeUntil must be a finite epoch millisecond timestamp or null.')
    }
    this.db.inTransaction(() => {
      this.db.db
        .prepare(
          `INSERT INTO task_user_marks (task_id, ignored_at, acked_at, pinned_at, snoozed_until, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             ignored_at = excluded.ignored_at,
             acked_at = excluded.acked_at,
             pinned_at = excluded.pinned_at,
             snoozed_until = excluded.snoozed_until,
             updated_at = excluded.updated_at`,
        )
        .run(taskId, ignoredAt, ackedAt, pinnedAt, snoozedUntil, now)
      this.appendEvent(
        taskId,
        'task_marks_updated',
        source,
        {
          ...(marks.ack !== undefined ? { ack: marks.ack } : {}),
          ...(marks.ignore !== undefined ? { ignore: marks.ignore } : {}),
          ...(marks.pin !== undefined ? { pin: marks.pin } : {}),
          ...(marks.snoozeUntil !== undefined ? { snoozeUntil: snoozedUntil } : {}),
        },
        { createdAt: now },
      )
      this.notifyRevision()
    })
    return this.getTask(taskId)!
  }

  batchTasks(input: BatchTasksInput, source: MutationSource = 'ui'): BatchTasksResult {
    const validActions = new Set<BatchTaskAction>([
      'pin',
      'unpin',
      'set_sub_phase',
      'set_priority',
      'set_workspace',
      'archive',
      'unarchive',
      'close',
      'delete',
    ])
    if (!validActions.has(input.action)) {
      throw new DomainError('invalid-batch-action', `Unsupported batch action '${String(input.action)}'.`)
    }
    const uniqueIds = [...new Set((input.taskIds ?? []).map((id) => String(id).trim()).filter(Boolean))]
    if (uniqueIds.length === 0) {
      return { action: input.action, affectedIds: [], skippedIds: [], tasks: [] }
    }

    if (input.action === 'set_sub_phase' && input.subPhase !== 'ready' && input.subPhase !== 'backlog') {
      throw new DomainError('invalid-sub-phase', "Batch set_sub_phase requires subPhase 'ready' or 'backlog'.")
    }
    if (input.action === 'set_priority' && !isTaskPriority(input.priority)) {
      throw new DomainError('invalid-priority', `Unsupported priority '${String(input.priority)}'.`)
    }

    let resolvedWs: { workspaceId?: string; workspacePath?: string; workspaceLabel?: string } | undefined
    if (input.action === 'set_workspace') {
      if (input.workspaceId === null && input.workspacePath === null) {
        resolvedWs = {}
      } else {
        const workspaces = this.listWorkspaces()
        resolvedWs = this.resolveWorkspaceBinding(
          {
            workspaceId: input.workspaceId ?? undefined,
            workspacePath: input.workspacePath ?? undefined,
          },
          workspaces,
        )
      }
    }

    const now = this.now()
    const affectedIds: string[] = []
    const skippedIds: string[] = []

    this.db.inTransaction(() => {
      const loaded: TaskRecord[] = []
      for (const taskId of uniqueIds) {
        const task = this.db.getTask(taskId)
        if (!task) {
          throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
        }
        loaded.push(task)
      }

      // Guard destructive / phase-changing actions atomically before mutating any row
      if (input.action === 'archive' || input.action === 'delete' || input.action === 'close') {
        for (const task of loaded) {
          if (hasOpenExecution(task)) {
            throw new DomainError(
              'execution-open',
              `Cannot ${input.action} task '${task.title}' while an execution is still running.`,
            )
          }
          if (input.action === 'close') {
            const gate = canCloseTaskWithSubgoals(task.subgoals, Boolean(input.force))
            if (!gate.allowed) {
              throw new DomainError('required-subgoals-open', gate.reason)
            }
          }
        }
      }

      for (const task of loaded) {
        switch (input.action) {
          case 'pin': {
            this.db.db
              .prepare(
                `INSERT INTO task_user_marks (task_id, pinned_at, updated_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(task_id) DO UPDATE SET pinned_at = excluded.pinned_at, updated_at = excluded.updated_at`,
              )
              .run(task.id, now, now)
            this.appendEvent(task.id, 'task_marks_updated', source, { pin: true, batch: true }, { createdAt: now })
            affectedIds.push(task.id)
            break
          }
          case 'unpin': {
            this.db.db
              .prepare(
                `INSERT INTO task_user_marks (task_id, pinned_at, updated_at)
                 VALUES (?, NULL, ?)
                 ON CONFLICT(task_id) DO UPDATE SET pinned_at = NULL, updated_at = excluded.updated_at`,
              )
              .run(task.id, now)
            this.appendEvent(task.id, 'task_marks_updated', source, { pin: false, batch: true }, { createdAt: now })
            affectedIds.push(task.id)
            break
          }
          case 'set_sub_phase': {
            if (task.archivedAt !== undefined || task.phase !== 'todo') {
              skippedIds.push(task.id)
              break
            }
            const rec = reconcilePhaseStatus('todo', input.subPhase)
            this.db.db
              .prepare('UPDATE tasks SET sub_phase = ?, status = ?, updated_at = ? WHERE id = ?')
              .run(rec.subPhase, rec.status, now, task.id)
            this.appendEvent(task.id, 'phase_changed', source, { from: task.phase, to: 'todo', subPhase: rec.subPhase, batch: true }, { createdAt: now })
            affectedIds.push(task.id)
            break
          }
          case 'set_priority': {
            this.db.db
              .prepare('UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?')
              .run(input.priority!, now, task.id)
            this.appendEvent(task.id, 'task_updated', source, { fields: ['priority'], priority: input.priority, batch: true }, { createdAt: now })
            affectedIds.push(task.id)
            break
          }
          case 'set_workspace': {
            this.db.db
              .prepare('UPDATE tasks SET workspace_id = ?, workspace_path = ?, workspace_label = ?, updated_at = ? WHERE id = ?')
              .run(resolvedWs?.workspaceId ?? null, resolvedWs?.workspacePath ?? null, resolvedWs?.workspaceLabel ?? null, now, task.id)
            this.appendEvent(task.id, 'task_updated', source, { fields: ['workspaceId', 'workspacePath'], batch: true }, { createdAt: now })
            affectedIds.push(task.id)
            break
          }
          case 'archive': {
            if (task.archivedAt !== undefined) {
              skippedIds.push(task.id)
              break
            }
            this.db.db.prepare('UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, task.id)
            this.appendEvent(task.id, 'task_archived', source, { batch: true }, { createdAt: now })
            affectedIds.push(task.id)
            break
          }
          case 'unarchive': {
            if (task.archivedAt === undefined) {
              skippedIds.push(task.id)
              break
            }
            this.db.db.prepare('UPDATE tasks SET archived_at = NULL, updated_at = ? WHERE id = ?').run(now, task.id)
            this.appendEvent(task.id, 'task_restored', source, { batch: true }, { createdAt: now })
            affectedIds.push(task.id)
            break
          }
          case 'close': {
            if (task.archivedAt !== undefined || task.phase === 'closed') {
              skippedIds.push(task.id)
              break
            }
            const rec = reconcilePhaseStatus('closed', 'done')
            const completedAt = task.completedAt ?? now
            this.db.db
              .prepare(
                'UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = NULL, completed_at = ?, updated_at = ? WHERE id = ?',
              )
              .run(rec.phase, rec.subPhase, rec.status, completedAt, now, task.id)
            this.stopScheduleOnClose(task.id, task.schedule, now)
            this.appendEvent(task.id, 'phase_changed', source, { from: task.phase, to: 'closed', subPhase: 'done', batch: true }, { createdAt: now })
            affectedIds.push(task.id)
            break
          }
          case 'delete': {
            this.db.db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id)
            affectedIds.push(task.id)
            break
          }
        }
      }

      if (affectedIds.length > 0) {
        this.notifyRevision()
      }
    })

    for (const id of affectedIds) {
      this.syncTaskSpaceProjection(id)
    }

    const tasks =
      input.action === 'delete'
        ? []
        : affectedIds.map((id) => this.getTask(id)).filter((t): t is TaskRecord => Boolean(t))

    if ((input.action === 'close' || input.action === 'archive') && tasks.length > 0) {
      this.scheduleArchiveConversationsForTasks(tasks)
    }

    return { action: input.action, affectedIds, skippedIds, tasks }
  }

  // --- Subgoals & Plan Breakdown ---
  planBreakdown(
    input: {
      taskId?: string
      title?: string
      description?: string
      workspacePath?: string
      workspaceId?: string
      replace?: boolean
      subgoals: Array<{
        id?: string
        title: string
        detail?: string
        kind?: SubgoalKind
        required?: boolean
        dependencies?: string[]
      }>
    },
    source: MutationSource = 'mcp',
  ): TaskRecord {
    let task: TaskRecord
    if (input.taskId) {
      const existing = this.getTask(input.taskId)
      if (!existing) throw new DomainError('task-not-found', `No task with id '${input.taskId}'.`)
      task = existing
    } else {
      if (!input.title?.trim()) throw new DomainError('title-required', 'Provide either taskId or title for plan breakdown.')
      task = this.createTask(
        {
          title: input.title.trim(),
          description: input.description,
          workspaceId: input.workspaceId,
          workspacePath: input.workspacePath,
        },
        source,
      )
    }

    const now = this.now()
    const baseOrder = input.replace ? 0 : task.subgoals.length
    const incoming = input.subgoals.map((sg, idx) => {
      const title = sg.title?.trim() ?? ''
      if (!title) throw new DomainError('invalid-subgoal', 'Subgoal title must not be blank.')
      return {
        id: sg.id?.trim() || randomUUID(),
        title,
        detail: sg.detail?.trim() ?? '',
        kind: sg.kind ?? ('custom' as SubgoalKind),
        required: sg.required !== false,
        sortOrder: baseOrder + idx,
        dependencies: sg.dependencies ?? [],
      }
    })

    const combinedForDeps = input.replace
      ? incoming
      : [...task.subgoals.map((s) => ({ id: s.id, dependencies: s.dependencies })), ...incoming]
    const seenIds = new Set<string>()
    for (const item of combinedForDeps) {
      if (seenIds.has(item.id)) {
        throw new DomainError('duplicate-subgoal-id', `Duplicate subgoal id '${item.id}'.`)
      }
      seenIds.add(item.id)
    }
    const depCheck = checkSubgoalDependencies(combinedForDeps)
    if (!depCheck.ok) throw new DomainError('invalid-subgoal-deps', depCheck.error)

    this.db.inTransaction(() => {
      if (input.replace) {
        this.db.db.prepare('DELETE FROM task_subgoals WHERE task_id = ?').run(task.id)
      }
      const stmt = this.db.db.prepare(
        `INSERT INTO task_subgoals (id, task_id, title, detail, kind, required, status, sort_order, dependencies_json, added_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      )
      for (const sg of incoming) {
        stmt.run(
          sg.id,
          task.id,
          sg.title,
          sg.detail,
          sg.kind,
          sg.required ? 1 : 0,
          sg.sortOrder,
          JSON.stringify(sg.dependencies),
          source,
          now,
        )
      }
      this.db.db
        .prepare('UPDATE tasks SET plan_revision = plan_revision + 1, updated_at = ? WHERE id = ?')
        .run(now, task.id)
      this.appendEvent(
        task.id,
        'plan_breakdown',
        source,
        { replace: Boolean(input.replace), count: incoming.length, planRevision: task.planRevision + 1 },
        { createdAt: now },
      )
      this.notifyRevision()
    })

    this.syncTaskSpaceProjection(task.id)
    return this.getTask(task.id)!
  }

  addSubgoal(
    taskId: string,
    input: { title: string; detail?: string; kind?: SubgoalKind; required?: boolean; dependencies?: string[] },
    source: MutationSource = 'ui',
  ): TaskRecord {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    const title = input.title?.trim() ?? ''
    if (!title) throw new DomainError('invalid-subgoal', 'Subgoal title must not be blank.')
    const id = randomUUID()
    const deps = input.dependencies ?? []
    const depCheck = checkSubgoalDependencies([
      ...task.subgoals.map((s) => ({ id: s.id, dependencies: s.dependencies })),
      { id, dependencies: deps },
    ])
    if (!depCheck.ok) throw new DomainError('invalid-subgoal-deps', depCheck.error)

    const now = this.now()
    this.db.inTransaction(() => {
      this.db.db
        .prepare(
          `INSERT INTO task_subgoals (id, task_id, title, detail, kind, required, status, sort_order, dependencies_json, added_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
        )
        .run(id, taskId, title, input.detail?.trim() ?? '', input.kind ?? 'custom', input.required !== false ? 1 : 0, task.subgoals.length, JSON.stringify(deps), source, now)
      this.db.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId)
      this.appendEvent(taskId, 'subgoal_added', source, { subgoalId: id, title, required: input.required !== false }, { subgoalId: id, createdAt: now })
      this.notifyRevision()
    })
    this.syncTaskSpaceProjection(taskId)
    return this.getTask(taskId)!
  }

  updateSubgoal(
    taskId: string,
    subgoalId: string,
    patch: { title?: string; detail?: string; kind?: SubgoalKind; required?: boolean; status?: SubgoalStatus; sortOrder?: number; dependencies?: string[] },
    source: MutationSource = 'ui',
  ): TaskRecord {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    const sg = task.subgoals.find((item) => item.id === subgoalId)
    if (!sg) throw new DomainError('subgoal-not-found', `No subgoal '${subgoalId}' on task '${taskId}'.`)

    const nextTitle = patch.title !== undefined ? patch.title.trim() : sg.title
    if (!nextTitle) throw new DomainError('invalid-subgoal', 'Subgoal title must not be blank.')
    const nextDetail = patch.detail !== undefined ? patch.detail.trim() : sg.detail
    const nextKind = patch.kind ?? sg.kind
    const nextRequired = patch.required ?? sg.required
    const nextStatus = patch.status ?? sg.status
    const nextOrder = patch.sortOrder ?? sg.sortOrder
    const nextDeps = patch.dependencies ?? sg.dependencies

    const depCheck = checkSubgoalDependencies(
      task.subgoals.map((item) => (item.id === subgoalId ? { id: item.id, dependencies: nextDeps } : { id: item.id, dependencies: item.dependencies })),
    )
    if (!depCheck.ok) throw new DomainError('invalid-subgoal-deps', depCheck.error)

    const now = this.now()
    const closedAt = nextStatus === 'done' || nextStatus === 'skipped' ? (sg.closedAt ?? now) : null

    const simulated = task.subgoals.map((item) =>
      item.id === subgoalId
        ? { ...item, title: nextTitle, detail: nextDetail, kind: nextKind, required: nextRequired, status: nextStatus, sortOrder: nextOrder, dependencies: nextDeps }
        : item,
    )
    const rollup = computeSubgoalRollup(simulated)
    const shouldRollToReview = rollup.readyForReview && task.phase === 'active'

    this.db.inTransaction(() => {
      this.db.db
        .prepare(
          `UPDATE task_subgoals SET title = ?, detail = ?, kind = ?, required = ?, status = ?, sort_order = ?, dependencies_json = ?, closed_at = ?
           WHERE id = ? AND task_id = ?`,
        )
        .run(nextTitle, nextDetail, nextKind, nextRequired ? 1 : 0, nextStatus, nextOrder, JSON.stringify(nextDeps), closedAt, subgoalId, taskId)

      if (shouldRollToReview) {
        this.db.db
          .prepare(
            "UPDATE task_executions SET ended_at = ?, result = 'succeeded', summary = COALESCE(summary, ?) WHERE task_id = ? AND ended_at IS NULL",
          )
          .run(now, 'All required subgoals completed', taskId)
        const rec = reconcilePhaseStatus('needs_you', 'review')
        this.db.db
          .prepare('UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?')
          .run(rec.phase, rec.subPhase, rec.status, 'All required subgoals complete — ready for review', now, taskId)
        this.clearSnoozeForTask(taskId, now)
        this.appendEvent(taskId, 'subgoals_ready_for_review', source, { requiredDone: rollup.requiredDone, requiredTotal: rollup.requiredTotal }, { subgoalId, createdAt: now })
      } else {
        this.db.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId)
      }

      this.appendEvent(
        taskId,
        'subgoal_updated',
        source,
        { subgoalId, status: nextStatus, required: nextRequired },
        { subgoalId, createdAt: now },
      )
      this.notifyRevision()
    })

    this.syncTaskSpaceProjection(taskId)
    return this.getTask(taskId)!
  }

  deleteSubgoal(taskId: string, subgoalId: string, source: MutationSource = 'ui'): TaskRecord {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    const remaining = task.subgoals.filter((sg) => sg.id !== subgoalId)
    const rollup = computeSubgoalRollup(remaining)
    const shouldRollToReview = rollup.readyForReview && task.phase === 'active'
    const now = this.now()
    this.db.inTransaction(() => {
      this.db.db.prepare('DELETE FROM task_subgoals WHERE id = ? AND task_id = ?').run(subgoalId, taskId)
      for (const sg of remaining) {
        if (sg.dependencies.includes(subgoalId)) {
          const nextDeps = sg.dependencies.filter((d) => d !== subgoalId)
          this.db.db
            .prepare('UPDATE task_subgoals SET dependencies_json = ? WHERE id = ? AND task_id = ?')
            .run(JSON.stringify(nextDeps), sg.id, taskId)
        }
      }
      if (shouldRollToReview) {
        this.db.db
          .prepare(
            "UPDATE task_executions SET ended_at = ?, result = 'succeeded', summary = COALESCE(summary, ?) WHERE task_id = ? AND ended_at IS NULL",
          )
          .run(now, 'All required subgoals completed', taskId)
        const rec = reconcilePhaseStatus('needs_you', 'review')
        this.db.db
          .prepare('UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?')
          .run(rec.phase, rec.subPhase, rec.status, 'All required subgoals complete — ready for review', now, taskId)
        this.clearSnoozeForTask(taskId, now)
        this.appendEvent(taskId, 'subgoals_ready_for_review', source, { requiredDone: rollup.requiredDone, requiredTotal: rollup.requiredTotal }, { createdAt: now })
      } else {
        this.db.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId)
      }
      this.appendEvent(taskId, 'subgoal_deleted', source, { subgoalId }, { subgoalId, createdAt: now })
      this.notifyRevision()
    })
    this.syncTaskSpaceProjection(taskId)
    return this.getTask(taskId)!
  }

  reorderSubgoals(taskId: string, orderedSubgoalIds: string[], source: MutationSource = 'ui'): TaskRecord {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    const existingIds = new Set(task.subgoals.map((s) => s.id))
    const seen = new Set<string>()
    const finalOrder: string[] = []
    for (const id of orderedSubgoalIds) {
      if (existingIds.has(id) && !seen.has(id)) {
        seen.add(id)
        finalOrder.push(id)
      }
    }
    for (const sg of task.subgoals) {
      if (!seen.has(sg.id)) {
        seen.add(sg.id)
        finalOrder.push(sg.id)
      }
    }
    const now = this.now()
    this.db.inTransaction(() => {
      const stmt = this.db.db.prepare('UPDATE task_subgoals SET sort_order = ? WHERE id = ? AND task_id = ?')
      finalOrder.forEach((sgId, index) => {
        stmt.run(index, sgId, taskId)
      })
      this.db.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId)
      this.appendEvent(taskId, 'subgoals_reordered', source, { orderedIds: finalOrder }, { createdAt: now })
      this.notifyRevision()
    })
    this.syncTaskSpaceProjection(taskId)
    return this.getTask(taskId)!
  }

  addTaskComment(
    taskId: string,
    input: { author?: string; bodyMd: string },
    source: MutationSource = 'ui',
  ): { task: TaskRecord; comment: TaskCommentRecord } {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    const bodyMd = input.bodyMd?.trim() ?? ''
    if (!bodyMd) throw new DomainError('invalid-comment', 'Comment bodyMd must not be blank.')
    const author = input.author?.trim() || source
    const id = randomUUID()
    const now = this.now()
    this.db.inTransaction(() => {
      this.db.db
        .prepare('INSERT INTO task_comments (id, task_id, author, body_md, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, taskId, author, bodyMd, now)
      this.db.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId)
      this.appendEvent(taskId, 'comment_added', source, { commentId: id, author }, { createdAt: now })
      this.notifyRevision()
    })
    this.syncTaskSpaceProjection(taskId)
    const updated = this.getTask(taskId)!
    const comment = updated.comments?.find((c) => c.id === id) ?? { id, taskId, author, bodyMd, createdAt: now }
    return { task: updated, comment }
  }

  // --- TaskSpace Refs ---
  addTaskRef(
    taskId: string,
    input: { kind: TaskRefKind; target: string; label?: string; subgoalId?: string; round?: number },
    source: MutationSource = 'ui',
  ): { task: TaskRecord; ref: TaskRefRecord } {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    const target = input.target?.trim()
    if (!target) throw new DomainError('invalid-ref', 'Reference target must not be blank.')
    const existing = task.refs.find((r) => r.kind === input.kind && r.target === target)
    if (existing) return { task, ref: existing }

    const id = randomUUID()
    const now = this.now()
    this.db.inTransaction(() => {
      this.db.db
        .prepare(
          `INSERT INTO task_refs (id, task_id, subgoal_id, kind, target, label, round, added_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, taskId, input.subgoalId ?? null, input.kind, target, input.label?.trim() || null, input.round ?? null, source, now)
      this.db.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId)
      this.appendEvent(taskId, 'ref_added', source, { refId: id, kind: input.kind, target }, { subgoalId: input.subgoalId, createdAt: now })
      this.notifyRevision()
    })
    this.syncTaskSpaceProjection(taskId)
    const updated = this.getTask(taskId)!
    return { task: updated, ref: updated.refs.find((r) => r.id === id)! }
  }

  removeTaskRef(taskId: string, refId: string, source: MutationSource = 'ui'): TaskRecord {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    const now = this.now()
    this.db.inTransaction(() => {
      this.db.db.prepare('DELETE FROM task_refs WHERE id = ? AND task_id = ?').run(refId, taskId)
      this.db.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId)
      this.appendEvent(taskId, 'ref_removed', source, { refId }, { createdAt: now })
      this.notifyRevision()
    })
    this.syncTaskSpaceProjection(taskId)
    return this.getTask(taskId)!
  }

  previewRef(taskId: string, refIdOrTarget: string): RefPreviewResult | RefPreviewError {
    const task = this.getTask(taskId)
    if (!task) return { ok: false, code: 'not-found', message: `No task with id '${taskId}'.` }
    return previewTaskRef(task, refIdOrTarget)
  }

  // --- Conversation Links ---
  linkConversation(
    taskId: string,
    input: {
      conversationId: string
      subgoalId?: string
      role?: ConversationRole
      workspaceId?: string
      summary?: string
      includeInHandoff?: boolean
    },
    source: MutationSource = 'ui',
  ): TaskRecord {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    const convId = input.conversationId?.trim()
    if (!convId) throw new DomainError('invalid-conversation', 'conversationId must not be empty.')
    const now = this.now()
    this.db.inTransaction(() => {
      this.db.db
        .prepare(
          `INSERT INTO task_conversations (task_id, subgoal_id, conversation_id, role, workspace_id, linked_at, summary, include_in_handoff)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id, subgoal_id, conversation_id) DO UPDATE SET
             role = excluded.role,
             workspace_id = COALESCE(excluded.workspace_id, task_conversations.workspace_id),
             linked_at = excluded.linked_at,
             summary = COALESCE(excluded.summary, task_conversations.summary),
             include_in_handoff = CASE WHEN excluded.include_in_handoff = 1 THEN 1 ELSE task_conversations.include_in_handoff END`,
        )
        .run(
          taskId,
          input.subgoalId ?? '',
          convId,
          input.role ?? 'primary',
          input.workspaceId ?? task.workspaceId ?? null,
          now,
          input.summary?.trim() || null,
          input.includeInHandoff ? 1 : 0,
        )
      this.db.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId)
      this.appendEvent(taskId, 'conversation_linked', source, { conversationId: convId, role: input.role ?? 'primary' }, { subgoalId: input.subgoalId, conversationId: convId, createdAt: now })
      this.notifyRevision()
    })
    this.syncTaskSpaceProjection(taskId)
    return this.getTask(taskId)!
  }

  unlinkConversation(taskId: string, conversationId: string, subgoalId = ''): TaskRecord {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    const now = this.now()
    this.db.inTransaction(() => {
      this.db.db
        .prepare('DELETE FROM task_conversations WHERE task_id = ? AND subgoal_id = ? AND conversation_id = ?')
        .run(taskId, subgoalId, conversationId)
      this.db.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId)
      this.notifyRevision()
    })
    this.syncTaskSpaceProjection(taskId)
    return this.getTask(taskId)!
  }

  updateConversationMeta(
    taskId: string,
    input: { conversationId: string; subgoalId?: string; summary?: string | null; includeInHandoff?: boolean; role?: ConversationRole },
    source: MutationSource = 'ui',
  ): TaskRecord {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    const convId = input.conversationId?.trim()
    if (!convId) throw new DomainError('invalid-conversation', 'conversationId must not be empty.')
    const now = this.now()
    this.db.inTransaction(() => {
      this.db.updateConversationLinkMeta(taskId, convId, input.subgoalId ?? '', {
        ...(input.summary !== undefined ? { summary: input.summary === null ? null : input.summary.trim() } : {}),
        ...(input.includeInHandoff !== undefined ? { includeInHandoff: input.includeInHandoff } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
      })
      this.db.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId)
      this.appendEvent(
        taskId,
        'conversation_meta_updated',
        source,
        {
          conversationId: convId,
          ...(input.includeInHandoff !== undefined ? { includeInHandoff: input.includeInHandoff } : {}),
          ...(input.summary !== undefined ? { hasSummary: Boolean(input.summary?.trim()) } : {}),
        },
        { subgoalId: input.subgoalId, conversationId: convId, createdAt: now },
      )
      this.notifyRevision()
    })
    return this.getTask(taskId)!
  }

  // --- Conversation Governance (Antigravity 2.35+ ConversationService) ---
  getConversationGovernanceConfig(): ConversationGovernanceConfig {
    try {
      const row = this.db.db
        .prepare('SELECT value FROM board_meta WHERE key = ?')
        .get(CONVERSATION_GOVERNANCE_META_KEY) as { value?: string } | undefined
      if (!row?.value) return { ...DEFAULT_CONVERSATION_GOVERNANCE }
      const parsed = JSON.parse(row.value) as Partial<ConversationGovernanceConfig>
      return {
        autoRename:
          typeof parsed.autoRename === 'boolean' ? parsed.autoRename : DEFAULT_CONVERSATION_GOVERNANCE.autoRename,
        titlePrefix:
          typeof parsed.titlePrefix === 'string' && parsed.titlePrefix.trim()
            ? parsed.titlePrefix.trim().slice(0, 40)
            : DEFAULT_CONVERSATION_GOVERNANCE.titlePrefix,
        autoTag: typeof parsed.autoTag === 'boolean' ? parsed.autoTag : DEFAULT_CONVERSATION_GOVERNANCE.autoTag,
        autoGroup: typeof parsed.autoGroup === 'boolean' ? parsed.autoGroup : DEFAULT_CONVERSATION_GOVERNANCE.autoGroup,
        conversationGroupId:
          typeof parsed.conversationGroupId === 'string' && parsed.conversationGroupId.trim()
            ? parsed.conversationGroupId.trim().slice(0, 64)
            : DEFAULT_CONVERSATION_GOVERNANCE.conversationGroupId,
        autoArchiveOnFinish:
          typeof parsed.autoArchiveOnFinish === 'boolean'
            ? parsed.autoArchiveOnFinish
            : DEFAULT_CONVERSATION_GOVERNANCE.autoArchiveOnFinish,
      }
    } catch {
      return { ...DEFAULT_CONVERSATION_GOVERNANCE }
    }
  }

  updateConversationGovernanceConfig(patch: Partial<ConversationGovernanceConfig>): ConversationGovernanceConfig {
    const current = this.getConversationGovernanceConfig()
    const next: ConversationGovernanceConfig = {
      autoRename: typeof patch.autoRename === 'boolean' ? patch.autoRename : current.autoRename,
      titlePrefix:
        typeof patch.titlePrefix === 'string' && patch.titlePrefix.trim()
          ? patch.titlePrefix.trim().slice(0, 40)
          : current.titlePrefix,
      autoTag: typeof patch.autoTag === 'boolean' ? patch.autoTag : current.autoTag,
      autoGroup: typeof patch.autoGroup === 'boolean' ? patch.autoGroup : current.autoGroup,
      conversationGroupId:
        typeof patch.conversationGroupId === 'string' && patch.conversationGroupId.trim()
          ? patch.conversationGroupId.trim().slice(0, 64)
          : current.conversationGroupId,
      autoArchiveOnFinish:
        typeof patch.autoArchiveOnFinish === 'boolean'
          ? patch.autoArchiveOnFinish
          : current.autoArchiveOnFinish,
    }
    this.db.inTransaction(() => {
      this.db.db
        .prepare(
          `INSERT INTO board_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(CONVERSATION_GOVERNANCE_META_KEY, JSON.stringify(next))
      this.notifyRevision()
    })
    return next
  }

  private collectArchivableConversationIds(
    tasks: readonly TaskRecord[],
    options?: { excludeTaskIdsFromOpenCheck?: Set<string> },
  ): { candidateIds: string[]; skippedIds: string[] } {
    const protectedIds = new Set<string>()
    for (const task of tasks) {
      for (const link of task.conversations) {
        if (link.role === 'origin' || link.role === 'reference') {
          const convId = link.conversationId.trim()
          if (convId) protectedIds.add(convId)
        }
      }
    }

    const rawCandidates = new Set<string>()
    for (const task of tasks) {
      for (const link of task.conversations) {
        if (link.role === 'origin' || link.role === 'reference') continue
        const convId = link.conversationId.trim()
        if (convId && !protectedIds.has(convId)) rawCandidates.add(convId)
      }
      for (const exec of task.executions) {
        const convId = exec.conversationId?.trim()
        if (convId && exec.endedAt !== undefined && !protectedIds.has(convId)) {
          rawCandidates.add(convId)
        }
      }
    }

    const excludeIds = options?.excludeTaskIdsFromOpenCheck
    const candidateIds: string[] = []
    const skippedIds: string[] = []

    for (const convId of rawCandidates) {
      if (!SAFE_CONVERSATION_ID_RE.test(convId)) {
        skippedIds.push(convId)
        continue
      }
      const linkedTasks = this.db.findTasksByConversationId(convId)
      const isProtectedRole = linkedTasks.some((t) =>
        t.conversations.some(
          (c) => (c.role === 'origin' || c.role === 'reference') && c.conversationId.trim() === convId,
        ),
      )
      if (isProtectedRole) {
        skippedIds.push(convId)
        continue
      }
      const hasOpenExec = linkedTasks.some((t) =>
        t.executions.some((e) => e.endedAt === undefined && e.conversationId === convId),
      )
      if (hasOpenExec) {
        skippedIds.push(convId)
        continue
      }
      const hasOtherOpenTask = linkedTasks.some(
        (t) => !(excludeIds?.has(t.id) ?? false) && t.archivedAt === undefined && t.phase !== 'closed',
      )
      if (hasOtherOpenTask) {
        skippedIds.push(convId)
        continue
      }
      candidateIds.push(convId)
    }

    return { candidateIds, skippedIds }
  }

  private scheduleArchiveConversationsForTasks(
    tasks: readonly TaskRecord[],
    options?: { excludeTaskIdsFromOpenCheck?: Set<string> },
  ): void {
    if (tasks.length === 0 || typeof this.agentBridge.updateConversation !== 'function') return
    const config = this.getConversationGovernanceConfig()
    if (!config.autoArchiveOnFinish) return
    const { candidateIds } = this.collectArchivableConversationIds(tasks, options)
    if (candidateIds.length === 0) return

    const updateConv = this.agentBridge.updateConversation.bind(this.agentBridge)
    const job = (async () => {
      for (const convId of candidateIds) {
        try {
          await updateConv(convId, { archived: true })
        } catch {
          // Fault-tolerant degradation: never block or crash primary board flow
        }
      }
    })()
    this.pendingGovernance.add(job)
    void job.finally(() => {
      this.pendingGovernance.delete(job)
    })
  }

  async flushConversationGovernance(): Promise<void> {
    while (this.pendingGovernance.size > 0) {
      await Promise.allSettled([...this.pendingGovernance])
    }
  }

  async cleanupFinishedConversations(
    options: { workspaceId?: string; dryRun?: boolean } = {},
  ): Promise<ConversationCleanupResult> {
    const allTasks = this.db.listTasks({ includeArchived: true })
    const finishedTasks = allTasks.filter(
      (t) =>
        (t.phase === 'closed' || t.archivedAt !== undefined) &&
        (!options.workspaceId || t.workspaceId === options.workspaceId),
    )
    const { candidateIds, skippedIds } = this.collectArchivableConversationIds(finishedTasks)
    const available = typeof this.agentBridge.updateConversation === 'function'
    const dryRun = Boolean(options.dryRun)
    if (dryRun || !available || candidateIds.length === 0) {
      return {
        ok: true,
        available,
        dryRun,
        scannedTasks: finishedTasks.length,
        candidateCount: candidateIds.length,
        archivedIds: [],
        skippedIds,
        failedIds: [],
        errors: [],
      }
    }

    const archivedIds: string[] = []
    const failedIds: string[] = []
    const errors: Array<{ conversationId: string; error: string }> = []
    for (const convId of candidateIds) {
      try {
        await this.agentBridge.updateConversation!(convId, { archived: true })
        archivedIds.push(convId)
      } catch (err) {
        failedIds.push(convId)
        errors.push({ conversationId: convId, error: err instanceof Error ? err.message : String(err) })
      }
    }

    return {
      ok: true,
      available,
      dryRun,
      scannedTasks: finishedTasks.length,
      candidateCount: candidateIds.length,
      archivedIds,
      skippedIds,
      failedIds,
      errors,
    }
  }

  // --- Dispatch / Resume / Rework ---
  async dispatchTask(
    taskId: string,
    options: DispatchOptions = {},
  ): Promise<{ task: TaskRecord; executionId: string; conversationId: string; action: 'new' | 'resume' | 'rework' }> {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    if (task.archivedAt !== undefined) throw new DomainError('task-archived', 'Cannot dispatch an archived task.')
    if (task.phase === 'todo' && task.subPhase === 'draft') {
      throw new DomainError(
        'draft-not-approved',
        'This todo is an AI draft. Review it and approve it to Ready before dispatching.',
      )
    }

    if (requiresPermissionConfirmation(task, this.sessionDefaultPermission)) {
      const now = this.now()
      this.db.inTransaction(() => {
        const rec = reconcilePhaseStatus('needs_you', 'permission_pending')
        this.db.db
          .prepare('UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?')
          .run(rec.phase, rec.subPhase, rec.status, 'Elevated permission requires human confirmation in the board UI.', now, taskId)
        this.clearSnoozeForTask(taskId, now)
        this.notifyRevision()
      })
      throw new DomainError(
        'confirmation-required',
        'Elevated permission requires human confirmation in the board UI before dispatch.',
      )
    }

    const mode = options.mode ?? 'auto'
    const subgoal = options.subgoalId ? task.subgoals.find((s) => s.id === options.subgoalId) : undefined
    if (options.subgoalId && !subgoal) {
      throw new DomainError('subgoal-not-found', `No subgoal '${options.subgoalId}' on task '${taskId}'.`)
    }

    if (mode === 'rework' && !options.reworkInstructions?.trim()) {
      throw new DomainError('rework-instructions-required', 'Rework requires non-empty reworkInstructions.')
    }

    if (hasOpenExecution(task)) {
      throw new DomainError('execution-open', 'Task already has an open running execution.')
    }

    const workspaces = this.listWorkspaces()
    if (task.handover?.workspaceId) {
      const explicitWs = workspaces.find(
        (w) => w.id === task.handover!.workspaceId || w.antigravityProjectId === task.handover!.workspaceId,
      )
      if (!explicitWs) {
        throw new DomainError(
          'unknown-handover-workspace',
          `Handover workspace '${task.handover.workspaceId}' is not registered or discovered.`,
        )
      }
    }
    const projectId = task.handover?.workspaceId
      ? matchProjectIdForWorkspace(task.handover.workspaceId, undefined, workspaces)
      : matchProjectIdForWorkspace(task.workspaceId, task.workspacePath, workspaces)

    const convDiscovery = readRecentConversations(this.paths, { limit: 300 })
    const convById = new Map(convDiscovery.conversations.map((c) => [c.conversationId, c]))
    const linkedConvIds = [
      ...task.conversations.map((c) => c.conversationId),
      ...(options.conversationId?.trim() ? [options.conversationId.trim()] : []),
    ]
    const directLookup = findConversationsByIds(this.paths, linkedConvIds)
    for (const [id, conv] of directLookup.map) {
      convById.set(id, conv)
    }
    const discoveryAvailable = convDiscovery.available || directLookup.available
    const idleSessionIds = discoveryAvailable
      ? new Set([...convById.values()].filter((c) => c.isIdle).map((c) => c.conversationId))
      : undefined

    let targetConvId: string | undefined
    let action: 'new' | 'resume' | 'rework' = 'new'

    if (mode === 'rework') {
      action = 'rework'
      const candidate =
        options.conversationId?.trim() ||
        reusableSessionId(task, idleSessionIds, { force: true, subgoalId: options.subgoalId }) ||
        task.conversations.find((c) => (options.subgoalId ? c.subgoalId === options.subgoalId : c.role === 'primary'))?.conversationId ||
        task.conversations.find((c) => (options.subgoalId ? c.subgoalId === options.subgoalId : true))?.conversationId
      if (!candidate) {
        throw new DomainError('no-conversation-to-rework', 'No existing conversation linked to rework; dispatch a new conversation instead.')
      }
      const liveConv = convById.get(candidate)
      if (liveConv && !liveConv.isIdle) {
        throw new DomainError('session-busy', `Conversation '${candidate}' is currently running (${liveConv.status}); wait for it to finish before sending rework.`)
      }
      targetConvId = candidate
    } else if (mode === 'resume') {
      action = 'resume'
      const candidate =
        options.conversationId?.trim() ||
        reusableSessionId(task, idleSessionIds, { force: true, subgoalId: options.subgoalId }) ||
        task.conversations.find((c) => (options.subgoalId ? c.subgoalId === options.subgoalId : c.role === 'primary'))?.conversationId ||
        task.conversations.find((c) => (options.subgoalId ? c.subgoalId === options.subgoalId : true))?.conversationId
      if (!candidate) {
        throw new DomainError('no-conversation-to-resume', 'No existing conversation linked to resume.')
      }
      const liveConv = convById.get(candidate)
      if (liveConv && !liveConv.isIdle) {
        throw new DomainError('session-busy', `Conversation '${candidate}' is currently running (${liveConv.status}); wait for it to settle before resuming.`)
      }
      targetConvId = candidate
    } else if (mode === 'auto') {
      const reused = options.conversationId?.trim() || reusableSessionId(task, idleSessionIds, { subgoalId: options.subgoalId })
      if (reused) {
        action = 'resume'
        targetConvId = reused
      }
    }

    const shouldUseWorktree = options.useWorktree ?? Boolean(task.useWorktree)
    let activeWorktreePath = task.worktreePath
    let activeWorktreeBranch = task.worktreeBranch
    const source = options.source ?? 'ui'
    if (shouldUseWorktree && task.workspacePath) {
      const wt = await ensureTaskWorktree(task.workspacePath, taskId)
      if (wt.ok) {
        activeWorktreePath = wt.worktreePath
        activeWorktreeBranch = wt.worktreeBranch
        const wtNow = this.now()
        this.db.inTransaction(() => {
          this.db.db
            .prepare('UPDATE tasks SET use_worktree = 1, worktree_path = ?, worktree_branch = ?, updated_at = ? WHERE id = ?')
            .run(wt.worktreePath, wt.worktreeBranch, wtNow, taskId)
          this.appendEvent(
            taskId,
            'worktree_ready',
            source,
            { worktreePath: wt.worktreePath, worktreeBranch: wt.worktreeBranch, reused: wt.reused },
            { createdAt: wtNow },
          )
          this.notifyRevision()
        })
      } else if (wt.reason === 'not-git-repo') {
        this.db.inTransaction(() => {
          this.appendEvent(taskId, 'worktree_skipped', source, { reason: wt.reason, message: wt.message })
          this.notifyRevision()
        })
      } else {
        throw new DomainError('worktree-failed', wt.message)
      }
    }

    const worktreeDirective = activeWorktreePath
      ? `Work strictly inside the isolated git worktree directory: ${activeWorktreePath}${activeWorktreeBranch ? ` (branch: ${activeWorktreeBranch})` : ''}.`
      : undefined
    const combinedExtraInstruction = [worktreeDirective, options.extraInstruction?.trim()].filter(Boolean).join('\n\n') || undefined

    const latestTaskForPrompt = activeWorktreePath !== task.worktreePath ? (this.getTask(taskId) ?? task) : task
    const promptText =
      action === 'rework'
        ? buildReworkPrompt(latestTaskForPrompt, options.reworkInstructions!, subgoal)
        : buildDispatchPrompt(latestTaskForPrompt, { subgoal, extraInstruction: combinedExtraInstruction })

    const executionId = randomUUID()
    const startedAt = this.now()
    const dispatchPlanRevision = latestTaskForPrompt.planRevision + 1
    const promotedHandoff = latestTaskForPrompt.conversations
      .filter((c) => c.includeInHandoff && c.summary?.trim())
      .map((c) => ({
        conversationId: c.conversationId,
        role: c.role,
        summary: c.summary!.trim(),
      }))
    const contractSnapshot: ExecutionContractSnapshot = {
      planRevision: dispatchPlanRevision,
      capturedAt: startedAt,
      title: latestTaskForPrompt.title,
      description: latestTaskForPrompt.description,
      userNotes: latestTaskForPrompt.userNotes ?? '',
      prompt: latestTaskForPrompt.prompt,
      ...(latestTaskForPrompt.nextAction ? { nextAction: latestTaskForPrompt.nextAction } : {}),
      ...(subgoal ? { subgoalId: subgoal.id } : {}),
      subgoals: latestTaskForPrompt.subgoals.map((sg) => ({
        id: sg.id,
        title: sg.title,
        required: sg.required,
        status: sg.status,
      })),
      refs: latestTaskForPrompt.refs.map((r) => ({
        kind: r.kind,
        target: r.target,
        ...(r.label ? { label: r.label } : {}),
      })),
      ...(promotedHandoff.length > 0 ? { handoffConclusions: promotedHandoff } : {}),
      ...(latestTaskForPrompt.freeze
        ? {
            freeze: {
              goal: latestTaskForPrompt.freeze.goal,
              progress: latestTaskForPrompt.freeze.progress,
              next: latestTaskForPrompt.freeze.next,
            },
          }
        : {}),
      dispatchedPrompt: promptText,
    }
    const runGroupId = options.runGroupId ?? taskId
    const dispatchLockPath =
      this.db.dbPath && this.db.dbPath !== ':memory:'
        ? join(dirname(this.db.dbPath), `dispatch.lock.${executionId}`)
        : undefined
    const releaseDispatchLock = () => {
      if (!dispatchLockPath) return
      try {
        if (existsSync(dispatchLockPath)) unlinkSync(dispatchLockPath)
      } catch {
        // ignore cleanup failure
      }
    }

    // Record open execution immediately with an immutable dispatch Contract snapshot
    this.db.inTransaction(() => {
      const concurrentOpen = this.db.db
        .prepare('SELECT 1 FROM task_executions WHERE task_id = ? AND ended_at IS NULL LIMIT 1')
        .get(taskId)
      if (concurrentOpen) {
        throw new DomainError('execution-open', 'Task already has an open running execution.')
      }
      if (dispatchLockPath) {
        try {
          writeFileSync(dispatchLockPath, String(process.pid), 'utf8')
        } catch {
          // best-effort advisory lock
        }
      }
      const rec = reconcilePhaseStatus('active', 'running')
      this.db.db
        .prepare(
          `INSERT INTO task_executions (
            id, task_id, subgoal_id, conversation_id, workspace_id, started_at,
            initiated_by, rework_instructions, frozen_at, plan_revision, contract_snapshot_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          executionId,
          taskId,
          subgoal?.id ?? null,
          targetConvId ?? null,
          projectId ?? task.workspaceId ?? null,
          startedAt,
          options.initiatedBy ?? source,
          action === 'rework' ? options.reworkInstructions!.trim() : null,
          task.freeze?.frozenAt ?? null,
          dispatchPlanRevision,
          JSON.stringify(contractSnapshot),
        )

      if (targetConvId) {
        this.db.db
          .prepare(
            `INSERT INTO task_conversations (task_id, subgoal_id, conversation_id, role, workspace_id, linked_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(task_id, subgoal_id, conversation_id) DO UPDATE SET linked_at = excluded.linked_at`,
          )
          .run(taskId, subgoal?.id ?? '', targetConvId, subgoal ? 'worker' : 'primary', projectId ?? task.workspaceId ?? null, startedAt)
      }

      this.db.db
        .prepare(
          'UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = NULL, reasoning_effort = COALESCE(?, reasoning_effort), plan_revision = ?, updated_at = ? WHERE id = ?',
        )
        .run(rec.phase, rec.subPhase, rec.status, options.reasoningEffort?.trim() || null, dispatchPlanRevision, startedAt, taskId)

      if (subgoal && subgoal.status === 'open') {
        this.db.db.prepare("UPDATE task_subgoals SET status = 'in_progress' WHERE id = ? AND task_id = ?").run(subgoal.id, taskId)
      }
      this.notifyRevision()
    })
    this.syncTaskSpaceProjection(taskId)

    return new Promise((resolve, reject) => {
      this.admissionQueue.enqueue({
        groupId: runGroupId,
        start: async () => {
          try {
            const governanceConfig = this.getConversationGovernanceConfig()
            const baseTitle = subgoal ? `${task.title} · ${subgoal.title}` : task.title
            const launchTitle = governanceConfig.autoRename
              ? formatGovernedConversationTitle(task.title, subgoal?.title, governanceConfig.titlePrefix)
              : baseTitle
            const launchTags = governanceConfig.autoTag
              ? buildGovernedConversationTags(task)
              : task.tags.length > 0
                ? task.tags.map((t) => t.name)
                : undefined

            const launchResult =
              action === 'new'
                ? await this.agentBridge.startConversation({
                    prompt: promptText,
                    title: launchTitle,
                    model: options.model ?? task.model,
                    profile: options.profile ?? task.handover?.mode ?? task.mode,
                    projectId,
                    tags: launchTags,
                  })
                : await this.agentBridge.sendMessage({
                    conversationId: targetConvId!,
                    message: promptText,
                    title: baseTitle,
                    projectId,
                  })

            const convId = launchResult.conversationId
            const now = this.now()
            this.db.inTransaction(() => {
              this.db.db.prepare('UPDATE task_executions SET conversation_id = ? WHERE id = ?').run(convId, executionId)
              this.db.db
                .prepare(
                  `INSERT INTO task_conversations (task_id, subgoal_id, conversation_id, role, workspace_id, linked_at)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(task_id, subgoal_id, conversation_id) DO UPDATE SET linked_at = excluded.linked_at`,
                )
                .run(taskId, subgoal?.id ?? '', convId, subgoal ? 'worker' : 'primary', projectId ?? task.workspaceId ?? null, now)
              this.appendEvent(
                taskId,
                action === 'new' ? 'task_dispatched' : action === 'rework' ? 'task_reworked' : 'task_resumed',
                source,
                { executionId, conversationId: convId, projectId, subgoalId: subgoal?.id, worktreePath: activeWorktreePath },
                { subgoalId: subgoal?.id, conversationId: convId, createdAt: now },
              )
              this.notifyRevision()
            })
            this.syncTaskSpaceProjection(taskId)

            if (
              action === 'new' &&
              typeof this.agentBridge.updateConversation === 'function' &&
              SAFE_CONVERSATION_ID_RE.test(convId)
            ) {
              const annotations = buildDispatchGovernanceAnnotations(task, subgoal, governanceConfig)
              if (Object.keys(annotations).length > 0) {
                try {
                  await this.agentBridge.updateConversation(convId, annotations)
                } catch {
                  // Fault-tolerant degradation: never block dispatch if LS < 2.35 or unreachable
                }
              }
            }

            resolve({ task: this.getTask(taskId)!, executionId, conversationId: convId, action })
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            const now = this.now()
            this.db.inTransaction(() => {
              this.db.db
                .prepare("UPDATE task_executions SET ended_at = ?, result = 'failed', error = ? WHERE id = ?")
                .run(now, msg, executionId)
              const rec = reconcilePhaseStatus('needs_you', 'blocked')
              this.db.db
                .prepare('UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?')
                .run(rec.phase, rec.subPhase, rec.status, msg, now, taskId)
              this.clearSnoozeForTask(taskId, now)
              this.appendEvent(taskId, 'dispatch_failed', source, { executionId, error: msg }, { subgoalId: subgoal?.id, createdAt: now })
              this.notifyRevision()
            })
            this.syncTaskSpaceProjection(taskId)
            reject(err)
          } finally {
            releaseDispatchLock()
          }
        },
        abandon: () => {
          try {
            const now = this.now()
            this.db.inTransaction(() => {
              this.db.db
                .prepare("UPDATE task_executions SET ended_at = ?, result = 'cancelled', error = 'Queue drained before launch' WHERE id = ?")
                .run(now, executionId)
              const rec = reconcilePhaseStatus('on_hold', 'paused')
              this.db.db
                .prepare('UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?')
                .run(rec.phase, rec.subPhase, rec.status, 'Launch abandoned on shutdown', now, taskId)
              this.notifyRevision()
            })
            this.syncTaskSpaceProjection(taskId)
          } finally {
            releaseDispatchLock()
          }
          reject(new DomainError('launch-abandoned', 'Launch abandoned because queue drained.'))
        },
      })
    })
  }

  async getTaskWorktreeDiff(taskId: string): Promise<WorktreeDiffResult | WorktreeErrorResult> {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    if (!task.worktreePath) {
      throw new DomainError('no-worktree', `Task '${taskId}' does not have an attached git worktree.`)
    }
    return getWorktreeDiffHelper(task.worktreePath)
  }

  async cleanupTaskWorktree(taskId: string, force = false, source: MutationSource = 'ui'): Promise<TaskRecord> {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    if (!task.worktreePath) return task
    const res = await cleanupWorktreeHelper(task.workspacePath, task.worktreePath, task.worktreeBranch, force)
    if (!res.ok) {
      throw new DomainError('worktree-cleanup-failed', res.message)
    }
    const now = this.now()
    this.db.inTransaction(() => {
      this.db.db
        .prepare('UPDATE tasks SET worktree_path = NULL, worktree_branch = NULL, updated_at = ? WHERE id = ?')
        .run(now, taskId)
      this.appendEvent(
        taskId,
        'worktree_cleaned',
        source,
        { removedPath: res.removedPath, branchDeleted: res.branchDeleted },
        { createdAt: now },
      )
      this.notifyRevision()
    })
    this.syncTaskSpaceProjection(taskId)
    return this.getTask(taskId)!
  }

  settleExecution(
    taskId: string,
    outcome: ExecutionOutcome,
    options: { executionId?: string; summary?: string; error?: string; targetPhase?: TaskPhase; force?: boolean; source?: MutationSource } = {},
  ): TaskRecord {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    const now = this.now()
    const targetExec =
      (options.executionId ? task.executions.find((e) => e.id === options.executionId) : undefined) ??
      [...task.executions].reverse().find((e) => e.endedAt === undefined)

    const nextPhase =
      options.targetPhase ??
      (outcome === 'cancelled'
        ? 'on_hold'
        : 'needs_you')
    const nextSubPhase: TaskSubPhase =
      nextPhase === 'closed'
        ? outcome === 'cancelled'
          ? 'cancelled'
          : 'done'
        : outcome === 'cancelled'
          ? 'paused'
          : outcome === 'failed'
            ? 'blocked'
            : task.subgoalRollup.readyForReview
              ? 'review'
              : 'needs_input'
    const rec = reconcilePhaseStatus(nextPhase, nextSubPhase)
    if (rec.phase === 'closed' && rec.subPhase !== 'cancelled') {
      const gate = canCloseTaskWithSubgoals(task.subgoals, Boolean(options.force))
      if (!gate.allowed) {
        throw new DomainError('required-subgoals-open', gate.reason)
      }
    }
    const completedAt = rec.phase === 'closed' ? (task.completedAt ?? now) : null
    const blockedReason =
      options.error ??
      (rec.phase === 'closed'
        ? null
        : rec.subPhase === 'review'
          ? 'Execution settled — ready for review'
          : rec.subPhase === 'needs_input'
            ? 'Execution settled — awaiting next instruction'
            : null)

    this.db.inTransaction(() => {
      if (targetExec && targetExec.endedAt === undefined) {
        this.db.db
          .prepare('UPDATE task_executions SET ended_at = ?, result = ?, error = ?, summary = ? WHERE id = ?')
          .run(now, outcome, options.error ?? null, options.summary ?? null, targetExec.id)
      }
      // Mirror the distilled conclusion onto the conversation capsule so the
      // next dispatch can carry it without reading the whole transcript.
      if (targetExec?.conversationId && options.summary?.trim()) {
        this.db.updateConversationLinkMeta(taskId, targetExec.conversationId, targetExec.subgoalId ?? '', {
          summary: options.summary.trim(),
          ...(outcome === 'succeeded' ? { includeInHandoff: true } : {}),
        })
      }
      this.db.db
        .prepare('UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, completed_at = ?, updated_at = ? WHERE id = ?')
        .run(rec.phase, rec.subPhase, rec.status, blockedReason, completedAt, now, taskId)
      if (rec.phase === 'needs_you') {
        this.clearSnoozeForTask(taskId, now)
      }
      if (rec.phase === 'closed') {
        this.stopScheduleOnClose(taskId, task.schedule, now)
      }
      this.appendEvent(
        taskId,
        'execution_settled',
        options.source ?? 'ui',
        { executionId: targetExec?.id, outcome, error: options.error, summary: options.summary },
        { createdAt: now },
      )
      this.notifyRevision()
    })

    this.syncTaskSpaceProjection(taskId)
    return this.getTask(taskId)!
  }

  // --- Schedule & Reminders ---
  private cleanScheduleTransient(rule: ScheduleRule): ScheduleRule {
    const cleaned: ScheduleRule = { ...rule }
    delete cleaned.missedSlotAt
    delete cleaned.skippedAt
    delete cleaned.skippedReason
    delete cleaned.endedAt
    delete cleaned.endedReason
    return cleaned
  }

  /** Closing a task is the explicit "finish and stop repeating" action. */
  private stopScheduleOnClose(taskId: string, schedule: ScheduleRule | undefined, now: number): void {
    if (!schedule?.enabled) return
    const stopped: ScheduleRule = {
      ...this.cleanScheduleTransient(schedule),
      enabled: false,
      nextRunAt: undefined,
      endedAt: now,
      endedReason: 'closed',
    }
    this.db.db.prepare('UPDATE tasks SET schedule_json = ? WHERE id = ?').run(JSON.stringify(stopped), taskId)
  }

  private advanceScheduleNextRun(sched: ScheduleRule, fromMs: number, zone: string): number | undefined {
    if (sched.mode === 'cron' && sched.cron) {
      return nextRunAtMs(sched.cron, fromMs, zone)
    }
    if (sched.mode === 'after_completion') {
      return undefined
    }
    return undefined
  }

  private triggerScheduledReminder(taskId: string, now: number, source: MutationSource): void {
    const current = this.getTask(taskId)
    if (!current) return
    this.db.inTransaction(() => {
      if (current.phase === 'todo' || current.phase === 'on_hold' || current.phase === 'needs_you') {
        const rec = reconcilePhaseStatus('needs_you', 'reminder_due')
        this.db.db
          .prepare(
            `UPDATE tasks
             SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(rec.phase, rec.subPhase, rec.status, 'Scheduled reminder due', now, taskId)
        this.clearSnoozeForTask(taskId, now)
      } else {
        this.db.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId)
      }
      this.appendEvent(taskId, 'schedule_reminder_due', source, {}, { createdAt: now })
      this.notifyRevision()
    })
    this.syncTaskSpaceProjection(taskId)
  }

  setTaskSchedule(
    taskId: string,
    patch: ScheduleInputSpec | null,
    source: MutationSource = 'ui',
  ): TaskRecord {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    const now = this.now()

    if (patch === null || patch.clear === true) {
      this.db.inTransaction(() => {
        this.db.db.prepare('UPDATE tasks SET schedule_json = NULL, updated_at = ? WHERE id = ?').run(now, taskId)
        this.appendEvent(taskId, 'schedule_cleared', source, {}, { createdAt: now })
        this.notifyRevision()
      })
      this.syncTaskSpaceProjection(taskId)
      return this.getTask(taskId)!
    }

    const rule = this.buildScheduleRule(patch, now, task.phase, task.schedule)

    this.db.inTransaction(() => {
      this.db.db.prepare('UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(rule), now, taskId)
      this.appendEvent(taskId, 'schedule_updated', source, { schedule: rule }, { createdAt: now })
      this.notifyRevision()
    })
    this.syncTaskSpaceProjection(taskId)
    return this.getTask(taskId)!
  }

  completeScheduleCycle(
    taskId: string,
    options: { force?: boolean; note?: string } = {},
    source: MutationSource = 'ui',
  ): TaskRecord {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    if (task.archivedAt !== undefined) throw new DomainError('task-archived', 'Restore archived task before completing a cycle.')
    if (!task.schedule) throw new DomainError('invalid-schedule', 'Task does not have an active schedule.')

    if (hasOpenExecution(task) && !options.force) {
      throw new DomainError('execution-open', 'Cannot complete cycle while an execution is still running (settle or force first).')
    }
    const gate = canCloseTaskWithSubgoals(task.subgoals, Boolean(options.force))
    if (!gate.allowed) {
      throw new DomainError('required-subgoals-open', gate.reason)
    }

    const now = this.now()
    const sched = task.schedule
    const zone = sched.timeZone ?? resolveHostTimeZone()
    let nextRule = { ...this.cleanScheduleTransient(sched), consecutiveFailures: 0 }
    if (nextRule.enabled && !scheduleExhausted(nextRule)) {
      if (nextRule.mode === 'after_completion') {
        nextRule.nextRunAt = nextAfterCompletionAtMs(
          now,
          nextRule.intervalDays ?? 1,
          zone,
          nextRule.atHour,
          nextRule.atMinute,
        )
      } else if (nextRule.mode === 'cron' && nextRule.cron) {
        const nextTick = nextRunAtMs(nextRule.cron, now, zone)
        if (nextTick !== undefined) {
          nextRule.nextRunAt = nextTick
        } else {
          nextRule = { ...nextRule, enabled: false, nextRunAt: undefined, endedAt: now, endedReason: 'no-target' }
        }
      }
    } else if (scheduleExhausted(nextRule)) {
      nextRule = { ...nextRule, enabled: false, nextRunAt: undefined, endedAt: now, endedReason: 'limit' }
    }

    const reconciled = reconcilePhaseStatus('todo', 'ready')
    const clearStaleDue = task.dueAt !== undefined && task.dueAt <= now

    this.db.inTransaction(() => {
      this.db.db.prepare('UPDATE task_subgoals SET status = \'open\', closed_at = NULL WHERE task_id = ?').run(taskId)
      this.db.db
        .prepare(
          `UPDATE tasks
           SET phase = ?, sub_phase = ?, status = ?,
               blocked_reason = NULL,
               completed_at = NULL,
               due_at = CASE WHEN ? THEN NULL ELSE due_at END,
               schedule_json = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          reconciled.phase,
          reconciled.subPhase,
          reconciled.status,
          clearStaleDue ? 1 : 0,
          JSON.stringify(nextRule),
          now,
          taskId,
        )
      this.appendEvent(
        taskId,
        'cycle_accepted',
        source,
        {
          round: sched.runCount,
          nextRunAt: nextRule.nextRunAt,
          ...(options.note?.trim() ? { note: options.note.trim() } : {}),
        },
        { createdAt: now },
      )
      this.notifyRevision()
    })
    this.syncTaskSpaceProjection(taskId)
    const updated = this.getTask(taskId)!
    const reusesAcrossCycles = sched.sessionMode === 'auto' && task.reuseSession
    if (!reusesAcrossCycles) {
      this.scheduleArchiveConversationsForTasks([updated], {
        excludeTaskIdsFromOpenCheck: new Set([taskId]),
      })
    }
    return updated
  }

  async handleMissedSchedule(
    taskId: string,
    action: 'run' | 'skip',
    source: MutationSource = 'ui',
  ): Promise<TaskRecord> {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    if (task.archivedAt !== undefined) throw new DomainError('task-archived', 'Restore archived task first.')
    const sched = task.schedule
    if (!sched) throw new DomainError('invalid-schedule', 'Task does not have a schedule.')
    const now = this.now()
    const zone = sched.timeZone ?? resolveHostTimeZone()

    if (action === 'skip') {
      const updated = this.cleanScheduleTransient(sched)
      if (sched.endedReason === 'missed') {
        updated.endedAt = sched.endedAt ?? now
        updated.endedReason = 'skipped'
      }
      this.db.inTransaction(() => {
        this.db.db.prepare('UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(updated), now, taskId)
        this.appendEvent(taskId, 'schedule_missed_dismissed', source, { missedSlotAt: sched.missedSlotAt }, { createdAt: now })
        this.notifyRevision()
      })
      this.syncTaskSpaceProjection(taskId)
      return this.getTask(taskId)!
    }

    if (hasOpenExecution(task)) {
      throw new DomainError('execution-open', 'Task already has an open running execution.')
    }
    const schedAction: ScheduleAction = sched.action ?? 'dispatch'
    if (schedAction === 'dispatch' && requiresPermissionConfirmation(task, this.sessionDefaultPermission)) {
      throw new DomainError(
        'confirmation-required',
        'Elevated permission requires human confirmation in the board UI before dispatch.',
      )
    }

    const nextCount = sched.runCount + 1
    let nextRule: ScheduleRule = {
      ...this.cleanScheduleTransient(sched),
      lastTriggeredAt: now,
      runCount: nextCount,
      consecutiveFailures: 0,
    }
    if (sched.mode === 'once' || scheduleExhausted(nextRule)) {
      nextRule = {
        ...nextRule,
        enabled: false,
        nextRunAt: undefined,
        endedAt: now,
        endedReason: sched.mode === 'once' ? 'fired' : 'limit',
      }
    } else if (sched.mode === 'after_completion') {
      nextRule.nextRunAt = undefined
    } else if (sched.cron) {
      const future = nextRule.nextRunAt !== undefined && nextRule.nextRunAt > now ? nextRule.nextRunAt : nextRunAtMs(sched.cron, now, zone)
      if (future !== undefined) {
        nextRule.nextRunAt = future
      } else {
        nextRule = { ...nextRule, enabled: false, nextRunAt: undefined, endedAt: now, endedReason: 'no-target' }
      }
    }

    this.db.inTransaction(() => {
      this.db.db.prepare('UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(nextRule), now, taskId)
      this.appendEvent(
        taskId,
        'schedule_caught_up',
        source,
        { scheduledFor: sched.missedSlotAt ?? sched.skippedAt ?? now },
        { createdAt: now },
      )
      this.notifyRevision()
    })

    if (schedAction === 'remind') {
      this.triggerScheduledReminder(taskId, now, source)
    } else {
      const dispatchMode = sched.sessionMode ?? (sched.mode === 'once' ? 'auto' : 'new')
      await this.dispatchTask(taskId, { mode: dispatchMode, source, initiatedBy: source })
    }
    return this.getTask(taskId)!
  }

  skipScheduleCycle(taskId: string, source: MutationSource = 'ui'): TaskRecord {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    const sched = task.schedule
    if (!sched) throw new DomainError('invalid-schedule', 'Task does not have a schedule.')
    const now = this.now()
    const zone = sched.timeZone ?? resolveHostTimeZone()
    const baseCursor = Math.max(now, sched.nextRunAt ?? now)

    let updated: ScheduleRule = {
      ...this.cleanScheduleTransient(sched),
      skippedAt: now,
      skippedReason: 'skipped',
    }
    if (sched.mode === 'cron' && sched.cron) {
      const nextTick = nextRunAtMs(sched.cron, baseCursor, zone)
      updated = nextTick !== undefined
        ? { ...updated, nextRunAt: nextTick }
        : { ...updated, enabled: false, nextRunAt: undefined, endedAt: now, endedReason: 'no-target' }
    } else if (sched.mode === 'after_completion') {
      updated.nextRunAt = nextAfterCompletionAtMs(baseCursor, sched.intervalDays ?? 1, zone, sched.atHour, sched.atMinute)
    } else {
      updated = { ...updated, enabled: false, nextRunAt: undefined, endedAt: now, endedReason: 'skipped' }
    }

    this.db.inTransaction(() => {
      this.db.db.prepare('UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(updated), now, taskId)
      this.appendEvent(taskId, 'schedule_cycle_skipped', source, { skippedFor: sched.nextRunAt, nextRunAt: updated.nextRunAt }, { createdAt: now })
      this.notifyRevision()
    })
    this.syncTaskSpaceProjection(taskId)
    return this.getTask(taskId)!
  }

  async runScheduleNow(taskId: string, source: MutationSource = 'ui'): Promise<TaskRecord> {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    if (task.archivedAt !== undefined) throw new DomainError('task-archived', 'Restore archived task first.')
    const sched = task.schedule
    if (!sched) throw new DomainError('invalid-schedule', 'Task does not have a schedule.')
    if (hasOpenExecution(task)) {
      throw new DomainError('execution-open', 'Task already has an open running execution.')
    }
    const schedAction: ScheduleAction = sched.action ?? 'dispatch'
    if (schedAction === 'dispatch' && requiresPermissionConfirmation(task, this.sessionDefaultPermission)) {
      throw new DomainError(
        'confirmation-required',
        'Elevated permission requires human confirmation in the board UI before dispatch.',
      )
    }

    const now = this.now()
    const nextCount = sched.runCount + 1
    let nextRule: ScheduleRule = {
      ...this.cleanScheduleTransient(sched),
      lastTriggeredAt: now,
      runCount: nextCount,
      consecutiveFailures: 0,
    }
    if (sched.mode === 'once') {
      // Preserve future one-shot trigger if it hasn't fired yet
      const futureAt = sched.at !== undefined && sched.at > now ? sched.at : undefined
      if (sched.enabled && futureAt !== undefined) {
        nextRule.enabled = true
        nextRule.nextRunAt = futureAt
      } else {
        nextRule.enabled = false
        nextRule.nextRunAt = undefined
      }
    } else if (sched.maxRuns !== undefined && nextCount >= sched.maxRuns) {
      nextRule = {
        ...nextRule,
        enabled: false,
        nextRunAt: undefined,
        endedAt: now,
        endedReason: 'limit',
      }
    }

    this.db.inTransaction(() => {
      this.db.db.prepare('UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(nextRule), now, taskId)
      this.appendEvent(taskId, 'schedule_run_now', source, { runCount: nextCount }, { createdAt: now })
      this.notifyRevision()
    })

    if (schedAction === 'remind') {
      this.triggerScheduledReminder(taskId, now, source)
    } else {
      const dispatchMode = sched.sessionMode ?? 'new'
      await this.dispatchTask(taskId, { mode: dispatchMode, source, initiatedBy: source })
    }
    return this.getTask(taskId)!
  }

  setTaskReminder(taskId: string, reminderAt: number | null, source: MutationSource = 'ui'): TaskRecord {
    const task = this.getTask(taskId)
    if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
    const now = this.now()
    const clearReminderReason = (reminderAt === null || reminderAt > now) && task.subPhase === 'reminder_due' && task.blockedReason === 'Reminder due'
    this.db.inTransaction(() => {
      this.db.db
        .prepare(
          `UPDATE tasks
           SET reminder_at = ?, reminded_at = NULL,
               blocked_reason = CASE WHEN ? THEN NULL ELSE blocked_reason END,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(reminderAt === null ? null : Math.trunc(reminderAt), clearReminderReason ? 1 : 0, now, taskId)
      this.appendEvent(taskId, 'reminder_updated', source, { reminderAt }, { createdAt: now })
      this.notifyRevision()
    })
    this.syncTaskSpaceProjection(taskId)
    return this.getTask(taskId)!
  }

  async runSchedulerTick(now = this.now()): Promise<{ firedReminders: string[]; firedSchedules: string[] }> {
    const tasks = this.db.listTasks({ includeArchived: false })
    const firedReminders: string[] = []
    const firedSchedules: string[] = []
    const missedWindowMs = 5 * 60 * 1000
    const catchUpMaxAgeMs = 7 * 86_400_000
    const dueTriggers: Array<{ taskId: string; sched: ScheduleRule; zone: string; caughtUpFrom?: number }> = []

    for (const task of tasks) {
      if (
        task.reminderAt !== undefined &&
        task.reminderAt <= now &&
        (task.remindedAt === undefined || task.remindedAt < task.reminderAt) &&
        task.phase !== 'closed'
      ) {
        let reminderClaimed = false
        this.db.inTransaction(() => {
          const shouldSurface = task.phase === 'todo' || task.phase === 'on_hold'
          const rec = shouldSurface ? reconcilePhaseStatus('needs_you', 'reminder_due') : null
          const res = rec
            ? this.db.db
                .prepare(
                  `UPDATE tasks
                   SET reminded_at = ?, phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ?
                   WHERE id = ? AND reminder_at IS NOT NULL AND reminder_at <= ? AND (reminded_at IS NULL OR reminded_at < reminder_at)`,
                )
                .run(now, rec.phase, rec.subPhase, rec.status, 'Reminder due', now, task.id, now)
            : this.db.db
                .prepare(
                  `UPDATE tasks
                   SET reminded_at = ?, updated_at = ?
                   WHERE id = ? AND reminder_at IS NOT NULL AND reminder_at <= ? AND (reminded_at IS NULL OR reminded_at < reminder_at)`,
                )
                .run(now, now, task.id, now)
          if (res.changes > 0) {
            reminderClaimed = true
            if (rec) {
              this.clearSnoozeForTask(task.id, now)
            }
            this.appendEvent(task.id, 'reminder_due', 'scheduler', { reminderAt: task.reminderAt }, { createdAt: now })
            this.notifyRevision()
          }
        })
        if (reminderClaimed) {
          this.syncTaskSpaceProjection(task.id)
          firedReminders.push(task.id)
        }
      }

      const sched = task.schedule
      if (!sched || !sched.enabled || sched.nextRunAt === undefined || sched.nextRunAt > now) continue
      // A recurring rule survives an accidental close (legacy rows); closing via
      // transitionPhase disables the rule explicitly, so this only rescues
      // schedules that were killed before that fix existed.
      if (task.phase === 'closed' && !isRecurringSchedule(sched)) continue

      const zone = sched.timeZone ?? resolveHostTimeZone()
      const schedAction: ScheduleAction = sched.action ?? 'dispatch'
      let caughtUpFrom: number | undefined

      // Evaluate misfire (> 5 minutes overdue) according to misfirePolicy
      if (now - sched.nextRunAt > missedWindowMs) {
        const misfirePolicy = sched.misfirePolicy ?? 'prompt'
        if (misfirePolicy === 'catch_up_once' && now - sched.nextRunAt <= catchUpMaxAgeMs) {
          caughtUpFrom = sched.nextRunAt
        } else if (misfirePolicy === 'skip') {
          const updatedRule: ScheduleRule =
            sched.mode === 'once'
              ? { ...this.cleanScheduleTransient(sched), enabled: false, nextRunAt: undefined, endedAt: now, endedReason: 'skipped', skippedAt: now, skippedReason: 'skipped' }
              : {
                  ...this.cleanScheduleTransient(sched),
                  skippedAt: now,
                  skippedReason: 'skipped',
                  nextRunAt: this.advanceScheduleNextRun(sched, now, zone),
                }
          this.db.inTransaction(() => {
            this.db.db.prepare('UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(updatedRule), now, task.id)
            this.appendEvent(task.id, 'schedule_missed', 'scheduler', { scheduledFor: sched.nextRunAt, policy: 'skip' }, { createdAt: now })
            this.notifyRevision()
          })
          continue
        } else {
          // `prompt` misfire policy: surface the miss for a human decision
          // (catch-up / skip) instead of silently killing a one-shot rule.
          // Already-surfaced misses are left untouched so ticks do not spam.
          if (sched.skippedReason === 'missed' && sched.missedSlotAt === sched.nextRunAt) continue
          const updatedRule: ScheduleRule =
            sched.mode === 'once'
              ? {
                  ...this.cleanScheduleTransient(sched),
                  // Keep enabled and keep the missed slot so /schedule/catch-up
                  // can still run it; do not mark endedAt.
                  missedSlotAt: sched.nextRunAt,
                  skippedAt: now,
                  skippedReason: 'missed',
                }
              : {
                  ...this.cleanScheduleTransient(sched),
                  missedSlotAt: sched.nextRunAt,
                  skippedAt: now,
                  skippedReason: 'missed',
                  nextRunAt: this.advanceScheduleNextRun(sched, now, zone),
                }
          this.db.inTransaction(() => {
            this.db.db.prepare('UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(updatedRule), now, task.id)
            this.appendEvent(
              task.id,
              'schedule_missed',
              'scheduler',
              { scheduledFor: sched.nextRunAt, policy: 'prompt', surfaced: true },
              { createdAt: now },
            )
            this.notifyRevision()
          })
          continue
        }
      }

      if (hasOpenExecution(task)) {
        const updatedRule: ScheduleRule = {
          ...sched,
          skippedAt: now,
          skippedReason: 'busy',
          nextRunAt: this.advanceScheduleNextRun(sched, now, zone),
          ...(sched.mode === 'once' ? { enabled: false, endedAt: now, endedReason: 'busy' } : {}),
        }
        this.db.inTransaction(() => {
          this.db.db.prepare('UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(updatedRule), now, task.id)
          this.notifyRevision()
        })
        continue
      }

      if (
        task.phase === 'needs_you' &&
        sched.overlapPolicy !== 'allow_replace' &&
        sched.skippedReason !== 'launch-failed'
      ) {
        const updatedRule: ScheduleRule = {
          ...sched,
          skippedAt: now,
          skippedReason: 'awaiting-review',
          nextRunAt: this.advanceScheduleNextRun(sched, now, zone),
          ...(sched.mode === 'once' ? { enabled: false, endedAt: now, endedReason: 'awaiting-review' } : {}),
        }
        this.db.inTransaction(() => {
          this.db.db.prepare('UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(updatedRule), now, task.id)
          this.appendEvent(task.id, 'schedule_held_for_review', 'scheduler', { scheduledFor: sched.nextRunAt }, { createdAt: now })
          this.notifyRevision()
        })
        continue
      }

      if (schedAction === 'dispatch' && requiresPermissionConfirmation(task, this.sessionDefaultPermission)) {
        const updatedRule: ScheduleRule = {
          ...sched,
          skippedAt: now,
          skippedReason: 'permission',
          nextRunAt: this.advanceScheduleNextRun(sched, now, zone),
          ...(sched.mode === 'once' ? { enabled: false, endedAt: now, endedReason: 'permission' } : {}),
        }
        this.db.inTransaction(() => {
          this.db.db.prepare('UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(updatedRule), now, task.id)
          this.notifyRevision()
        })
        continue
      }

      const nextCount = sched.runCount + 1
      let nextRule: ScheduleRule = {
        ...this.cleanScheduleTransient(sched),
        lastTriggeredAt: now,
        runCount: nextCount,
        consecutiveFailures: 0,
      }
      if (sched.mode === 'once' || scheduleExhausted(nextRule)) {
        nextRule = {
          ...nextRule,
          enabled: false,
          nextRunAt: undefined,
          endedAt: now,
          endedReason: sched.mode === 'once' ? 'fired' : 'limit',
        }
      } else if (sched.mode === 'after_completion') {
        nextRule = {
          ...nextRule,
          nextRunAt: undefined,
        }
      } else {
        const nextTick = sched.cron ? nextRunAtMs(sched.cron, now, zone) : undefined
        nextRule = nextTick
          ? { ...nextRule, nextRunAt: nextTick }
          : { ...nextRule, enabled: false, nextRunAt: undefined, endedAt: now, endedReason: 'no-target' }
      }

      let claimed = false
      this.db.inTransaction(() => {
        const res = this.db.db
          .prepare('UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ? AND schedule_json = ?')
          .run(JSON.stringify(nextRule), now, task.id, JSON.stringify(sched))
        if (res.changes > 0) {
          claimed = true
          if (caughtUpFrom !== undefined) {
            this.appendEvent(task.id, 'schedule_caught_up', 'scheduler', { scheduledFor: caughtUpFrom }, { createdAt: now })
          }
          this.notifyRevision()
        }
      })
      if (claimed) {
        dueTriggers.push({ taskId: task.id, sched, zone, caughtUpFrom })
      }
    }

    if (dueTriggers.length > 0) {
      const concurrency = Math.max(1, Math.min(this.maxConcurrentLaunches, 4))
      let cursor = 0
      const runWorker = async () => {
        while (cursor < dueTriggers.length) {
          const item = dueTriggers[cursor++]
          const { taskId, sched, zone } = item
          const schedAction: ScheduleAction = sched.action ?? 'dispatch'
          if (schedAction === 'remind') {
            this.triggerScheduledReminder(taskId, now, 'scheduler')
            firedSchedules.push(taskId)
            continue
          }
          try {
            const dispatchMode = sched.sessionMode ?? (sched.mode === 'once' ? 'auto' : 'new')
            await this.dispatchTask(taskId, { mode: dispatchMode, source: 'scheduler', initiatedBy: 'scheduler' })
            firedSchedules.push(taskId)
          } catch (err) {
            // Refund budget & restore the active schedule window on launch failure.
            const refundedNextRun =
              sched.mode === 'cron' && sched.cron
                ? nextRunAtMs(sched.cron, now, zone)
                : sched.mode === 'after_completion' && sched.nextRunAt !== undefined
                  ? sched.nextRunAt
                  : sched.mode === 'once'
                    ? (sched.at ?? sched.nextRunAt)
                    : undefined
            const failures = (sched.consecutiveFailures ?? 0) + 1
            const tripped = failures >= 3
            this.db.inTransaction(() => {
              const refunded: ScheduleRule = {
                ...sched,
                enabled: tripped ? false : refundedNextRun !== undefined ? sched.enabled : false,
                nextRunAt: tripped ? undefined : refundedNextRun,
                runCount: sched.runCount,
                endedAt: tripped ? now : refundedNextRun !== undefined ? undefined : now,
                endedReason: tripped ? 'launch-failed' : refundedNextRun !== undefined ? undefined : 'launch-failed',
                skippedAt: now,
                skippedReason: 'launch-failed',
                consecutiveFailures: failures,
              }
              this.db.db.prepare('UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(refunded), now, taskId)
              this.appendEvent(
                taskId,
                tripped ? 'schedule_circuit_open' : 'schedule_launch_failed',
                'scheduler',
                { failures, error: err instanceof Error ? err.message : String(err) },
                { createdAt: now },
              )
              if (tripped) {
                const rec = reconcilePhaseStatus('needs_you', 'blocked')
                this.db.db
                  .prepare('UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?')
                  .run(
                    rec.phase,
                    rec.subPhase,
                    rec.status,
                    `Scheduled launch failed ${failures} times; automatic scheduling paused.`,
                    now,
                    taskId,
                  )
                this.clearSnoozeForTask(taskId, now)
              }
              this.notifyRevision()
            })
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, dueTriggers.length) }, () => runWorker()))
    }

    return { firedReminders, firedSchedules }
  }

  private realPathOrSelf(rawPath: string): string {
    const resolved = resolve(rawPath)
    try {
      if (existsSync(resolved)) return normalizeFsPath(realpathSync(resolved))
      const parent = dirname(resolved)
      if (existsSync(parent)) {
        return normalizeFsPath(join(realpathSync(parent), resolved.slice(parent.length).replace(/^[\\/]+/, '')))
      }
    } catch {
      // fall back to normalized lexical path
    }
    return normalizeFsPath(resolved)
  }

  private resolveTargetPath(rawTarget: string, cwdStr?: string, fallbackWorkspace?: string): string {
    let cleaned = rawTarget.trim()
    if (cleaned.toLowerCase().startsWith('file://')) {
      cleaned = fileUriToPath(cleaned)
    }
    const baseDir = cwdStr?.trim() || fallbackWorkspace?.trim()
    const resolved = !isAbsolute(cleaned) && baseDir ? resolve(baseDir, cleaned) : resolve(cleaned)
    return this.realPathOrSelf(resolved)
  }

  private findProtectedTargetHit(
    toolName: string,
    args: Record<string, unknown>,
    cwdStr: string | undefined,
    linkedTasks: readonly TaskRecord[],
  ): string | undefined {
    const realDbPath =
      this.paths.dbPath && this.paths.dbPath !== ':memory:' ? this.realPathOrSelf(this.paths.dbPath) : ''
    const dbKey = realDbPath ? pathComparisonKey(realDbPath) : ''
    const rawTaskspaceDir = this.taskSpaceDir()
    const taskspaceDir = rawTaskspaceDir ? this.realPathOrSelf(rawTaskspaceDir) : undefined
    const taskspaceKey = taskspaceDir ? pathComparisonKey(taskspaceDir) : ''
    const realBoardDir = this.paths.boardDir ? this.realPathOrSelf(this.paths.boardDir) : undefined

    const handoverTargets: Array<{ href: string; realPath: string; key: string; workspaceKey: string }> = []
    for (const t of linkedTasks) {
      const wsReal = t.workspacePath ? this.realPathOrSelf(t.workspacePath) : ''
      const workspaceKey = wsReal ? pathComparisonKey(wsReal) : ''
      for (const href of t.handover?.references ?? []) {
        if (/^https?:\/\//i.test(href.trim())) continue
        const refCheck = resolveAllowedRefPath(href, t.workspacePath ?? cwdStr)
        if (!refCheck.ok) continue
        const refReal = this.resolveTargetPath(refCheck.path, cwdStr, t.workspacePath)
        const key = pathComparisonKey(refReal)
        if (key) handoverTargets.push({ href, realPath: refReal, key, workspaceKey })
      }
    }

    const checkCandidatePath = (rawPath: string): string | undefined => {
      const resolved = this.resolveTargetPath(rawPath, cwdStr, linkedTasks[0]?.workspacePath)
      const candKey = pathComparisonKey(resolved)
      if (!candKey) return undefined
      if (
        dbKey &&
        (candKey === dbKey ||
          candKey === `${dbKey}-wal` ||
          candKey === `${dbKey}-shm` ||
          candKey === `${dbKey}-journal`)
      ) {
        return 'board.db SQLite storage is protected from direct tool writes.'
      }
      if (taskspaceKey && taskspaceDir && isPathEqualOrInside(resolved, taskspaceDir)) {
        return 'TaskSpace projection files under taskspace/ are read-only.'
      }
      for (const ref of handoverTargets) {
        if (candKey === ref.key || isPathEqualOrInside(resolved, ref.realPath)) {
          return `Handover reference '${ref.href}' is read-only and cannot be modified.`
        }
      }
      return undefined
    }

    const fileKeys = ['TargetFile', 'AbsolutePath', 'Path', 'path', 'file_path', 'target_file', 'TargetDirectory']
    for (const key of fileKeys) {
      const val = args[key]
      if (typeof val === 'string' && val.trim()) {
        const hit = checkCandidatePath(val)
        if (hit) return hit
      }
    }

    if (toolName === 'run_command' || toolName === 'send_command_input') {
      const cmd = String(args.CommandLine ?? args.Input ?? '')
      if (cmd.trim()) {
        const lowerCmd = cmd.replace(/\\/g, '/').toLowerCase()
        const mutatingShell = /(>>|>|\brm\b|\brmdir\b|\brd\b|\bdel\b|\berase\b|\bmv\b|\bmove\b|\bren\b|\bcp\b|\bcopy\b|\bsed\s+-i|\btee\b|\bsqlite3\b|\bpython|\bnode\b|\bpowershell|\bpwsh\b|\bunlink\b|\btruncate\b|set-content|add-content|out-file|remove-item|rename-item)/i.test(
          cmd,
        )
        if (mutatingShell) {
          if (dbKey && (lowerCmd.includes(dbKey) || /\bboard\.db\b/.test(lowerCmd))) {
            return 'Shell mutation targeting board.db is blocked by Write Gate.'
          }
          const resolvedCwd = cwdStr ? this.realPathOrSelf(cwdStr) : ''
          const cwdKey = resolvedCwd ? pathComparisonKey(resolvedCwd) : ''
          const boardKey = realBoardDir ? pathComparisonKey(realBoardDir) : ''
          const inBoardDir = Boolean(
            cwdKey && boardKey && realBoardDir && (cwdKey === boardKey || isPathEqualOrInside(resolvedCwd, realBoardDir)),
          )
          if (
            taskspaceKey &&
            (lowerCmd.includes(taskspaceKey) ||
              (inBoardDir && /(?:^|[\s"'\\/])taskspace(?:$|[\s"'\\/])/i.test(lowerCmd)))
          ) {
            return 'Shell mutation targeting read-only taskspace/ projection is blocked by Write Gate.'
          }
          for (const ref of handoverTargets) {
            const relUnix = ref.href.trim().replace(/\\/g, '/').toLowerCase()
            const cwdInsideRefWs = Boolean(cwdKey && ref.workspaceKey && (cwdKey === ref.workspaceKey || cwdKey.startsWith(`${ref.workspaceKey}/`)))
            if (lowerCmd.includes(ref.key) || (cwdInsideRefWs && relUnix && lowerCmd.includes(relUnix))) {
              return `Shell mutation targeting read-only handover reference '${ref.href}' is blocked by Write Gate.`
            }
          }
        }
      }
    }

    return undefined
  }

  // --- Antigravity Hook Integration ---
  handleHookEvent(payload: Record<string, unknown>): Record<string, unknown> {
    const hookEventName = String(payload.hookEventName ?? '')
    const directConv = typeof payload.conversationId === 'string' ? payload.conversationId.trim() : ''
    let parentConv = typeof payload.parentConversationId === 'string' ? payload.parentConversationId.trim() : ''
    let rootConv = typeof payload.rootConversationId === 'string' ? payload.rootConversationId.trim() : ''
    let nestingDepth = 0
    let ancestorChain: string[] = []

    if (directConv && (!parentConv || !rootConv)) {
      const lineage = resolveConversationLineage(this.paths, directConv)
      if (!parentConv && lineage.parentConversationId) parentConv = lineage.parentConversationId
      if (!rootConv && lineage.rootConversationId) rootConv = lineage.rootConversationId
      nestingDepth = lineage.nestingDepth
      ancestorChain = lineage.ancestors
    }

    const lookupActiveTasks = (convId: string): TaskRecord[] =>
      convId ? this.db.findTasksByConversationId(convId).filter((t) => t.archivedAt === undefined) : []

    let linkedTasks = lookupActiveTasks(directConv)
    const isSubagentInvocation = Boolean(
      parentConv || nestingDepth > 0 || (rootConv && directConv && rootConv !== directConv),
    )

    // For SessionStart, PreToolUse (Write Gate), and PostToolUse (deliverables),
    // fall back to parent/ancestor/root conversation so spawned subagents cannot bypass a locked Write Gate.
    // For Stop, NEVER fall back to parent/root so a subagent finishing cannot falsely settle the parent task.
    if (linkedTasks.length === 0 && hookEventName !== 'Stop') {
      const fallbacks = [parentConv, ...ancestorChain, rootConv].filter(Boolean)
      for (const candidate of fallbacks) {
        linkedTasks = lookupActiveTasks(candidate)
        if (linkedTasks.length > 0) break
      }
    }

    // Always enforce protected board.db* and taskspace/* writes in PreToolUse even for unlinked conversations
    if (hookEventName === 'PreToolUse') {
      const toolCall = (payload.toolCall ?? {}) as Record<string, unknown>
      const toolName = String(toolCall.name ?? '').toLowerCase()
      const args = (toolCall.args ?? {}) as Record<string, unknown>
      const cwdStr = typeof payload.cwd === 'string' ? payload.cwd : undefined
      const writeTools = new Set([
        'write_to_file',
        'replace_file_content',
        'multi_replace_file_content',
        'run_command',
        'edit_file',
        'write_file',
        'delete_file',
        'send_command_input',
      ])
      if (writeTools.has(toolName)) {
        const protectedReason = this.findProtectedTargetHit(toolName, args, cwdStr, linkedTasks)
        if (protectedReason) {
          return { decision: 'deny', reason: protectedReason }
        }
      }
    }

    if (linkedTasks.length === 0) {
      if (hookEventName === 'PreToolUse' || hookEventName === 'Stop') {
        return { decision: 'allow' }
      }
      return {}
    }

    const conversationId = directConv || parentConv || rootConv
    const primaryTask = linkedTasks[0]

    if (hookEventName === 'SessionStart') {
      const lines = [
        `[agy-board linked task] ${primaryTask.title} (id: ${primaryTask.id}, phase: ${primaryTask.phase})`,
        ...(primaryTask.workspacePath ? [`Workspace: ${primaryTask.workspacePath}`] : []),
        ...(primaryTask.worktreePath ? [`Worktree: ${primaryTask.worktreePath}`] : []),
        ...(primaryTask.freeze
          ? [`Goal: ${primaryTask.freeze.goal}`, `Progress: ${primaryTask.freeze.progress}`, `Next: ${primaryTask.freeze.next}`]
          : []),
        ...(primaryTask.subgoals.length > 0
          ? [
              `Subgoals: ${primaryTask.subgoals
                .map((s) => `${s.status === 'done' ? '[x]' : s.status === 'skipped' ? '[-]' : '[ ]'} ${s.title}${s.required ? ' (required)' : ''}`)
                .join(' | ')}`,
            ]
          : []),
      ]
      return {
        injectSteps: [{ systemMessage: { systemMessage: lines.join('\n') } }],
      }
    }

    if (hookEventName === 'PreToolUse') {
      const toolCall = (payload.toolCall ?? {}) as Record<string, unknown>
      const toolName = String(toolCall.name ?? '').toLowerCase()
      const args = (toolCall.args ?? {}) as Record<string, unknown>

      if (toolName === 'ask_question') {
        const now = this.now()
        const rec = reconcilePhaseStatus('needs_you', 'needs_input')
        const updatedTaskIds: string[] = []
        this.db.inTransaction(() => {
          let changed = false
          for (const task of linkedTasks) {
            if (task.phase === 'closed') continue
            this.db.db
              .prepare('UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?')
              .run(rec.phase, rec.subPhase, rec.status, 'Waiting for user answer (ask_question)', now, task.id)
            this.clearSnoozeForTask(task.id, now)
            this.appendEvent(
              task.id,
              'hook_ask_question',
              'hook',
              { previousPhase: task.phase, previousSubPhase: task.subPhase },
              { conversationId, createdAt: now },
            )
            updatedTaskIds.push(task.id)
            changed = true
          }
          if (changed) this.notifyRevision()
        })
        for (const id of updatedTaskIds) this.syncTaskSpaceProjection(id)
        return { decision: 'allow' }
      }

      const normalizedTool = toolName.includes('/') ? toolName.split('/').pop()! : toolName
      const isBoardMutation =
        normalizedTool === 'board_transition' ||
        normalizedTool.endsWith('_board_transition') ||
        normalizedTool === 'board_update' ||
        normalizedTool.endsWith('_board_update') ||
        normalizedTool === 'board_archive' ||
        normalizedTool.endsWith('_board_archive') ||
        normalizedTool === 'board_delete' ||
        normalizedTool.endsWith('_board_delete')

      if (isBoardMutation) {
        const targetTaskId = typeof args.taskId === 'string' ? args.taskId.trim() : undefined
        const lockedTask = linkedTasks.find(
          (t) => t.writeGate === 'locked' && (!targetTaskId || t.id === targetTaskId),
        )
        const targetTask = targetTaskId ? this.db.getTask(targetTaskId) : undefined
        const effectiveLocked =
          lockedTask ?? (linkedTasks.some((t) => t.writeGate === 'locked') && targetTask?.writeGate === 'locked' ? targetTask : undefined)
        if (effectiveLocked) {
          const patchArgs = (args.patch && typeof args.patch === 'object' ? args.patch : args) as Record<string, unknown>
          const isDelete = normalizedTool === 'board_delete' || normalizedTool.endsWith('_board_delete')
          const isArchive =
            normalizedTool === 'board_archive' ||
            normalizedTool.endsWith('_board_archive') ||
            ((normalizedTool === 'board_transition' || normalizedTool.endsWith('_board_transition')) && args.action === 'archive')
          const isClosing =
            (normalizedTool === 'board_transition' || normalizedTool.endsWith('_board_transition')) && args.phase === 'closed'
          const isUnlocking =
            (normalizedTool === 'board_update' || normalizedTool.endsWith('_board_update')) && patchArgs.writeGate === 'unlocked'

          if (isDelete || isArchive || isClosing || isUnlocking) {
            return {
              decision: 'deny',
              reason: `agy-board Write Gate is LOCKED on task "${effectiveLocked.title}" (${effectiveLocked.id}). Closing, archiving, deleting, or unlocking writeGate from a locked conversation is denied.`,
            }
          }
        }
        return { decision: 'allow' }
      }

      const writeTools = new Set([
        'write_to_file',
        'replace_file_content',
        'multi_replace_file_content',
        'run_command',
        'edit_file',
        'write_file',
        'delete_file',
        'send_command_input',
      ])
      if (writeTools.has(toolName)) {
        const lockedTask = linkedTasks.find(
          (t) => t.writeGate === 'locked' && (t.phase === 'active' || t.phase === 'needs_you'),
        )
        if (lockedTask) {
          return {
            decision: 'deny',
            reason: `agy-board Write Gate is LOCKED on task "${lockedTask.title}" (${lockedTask.id}). Unlock it in Agy Board before modifying files or running mutating commands.`,
          }
        }
        const hasActiveOrNeedsYou = linkedTasks.some((t) => t.phase === 'active' || t.phase === 'needs_you')
        if (!hasActiveOrNeedsYou) {
          const pausedOrClosed = linkedTasks.find((t) => t.phase === 'on_hold' || t.phase === 'closed')
          if (pausedOrClosed) {
            return {
              decision: 'ask',
              reason: `Linked agy-board task "${pausedOrClosed.title}" is currently ${pausedOrClosed.phase}. Confirm before modifying workspace files.`,
            }
          }
        }
      }
      return { decision: 'allow' }
    }

    if (hookEventName === 'PostToolUse') {
      const toolCall = (payload.toolCall ?? {}) as Record<string, unknown>
      const toolName = String(toolCall.name ?? '')
      const lowerName = toolName.toLowerCase()
      const args = (toolCall.args ?? {}) as Record<string, unknown>
      const now = this.now()

      if (lowerName === 'ask_question') {
        if (payload.error) {
          this.db.inTransaction(() => {
            this.appendEvent(
              primaryTask.id,
              'hook_tool_error',
              'hook',
              { tool: toolName, error: String(payload.error).slice(0, 400) },
              { conversationId, createdAt: now },
            )
            this.notifyRevision()
          })
          return {}
        }
        const rec = reconcilePhaseStatus('active', 'running')
        const updatedTaskIds: string[] = []
        this.db.inTransaction(() => {
          let changed = false
          for (const task of linkedTasks) {
            if (task.phase === 'needs_you' && task.subPhase === 'needs_input') {
              this.db.db
                .prepare('UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = NULL, updated_at = ? WHERE id = ?')
                .run(rec.phase, rec.subPhase, rec.status, now, task.id)
              this.appendEvent(task.id, 'hook_ask_question_answered', 'hook', {}, { conversationId, createdAt: now })
              updatedTaskIds.push(task.id)
              changed = true
            }
          }
          if (changed) this.notifyRevision()
        })
        for (const id of updatedTaskIds) this.syncTaskSpaceProjection(id)
        return {}
      }

      const fileCandidate =
        args.TargetFile ?? args.AbsolutePath ?? args.Path ?? args.path ?? args.file_path ?? args.target_file
      const writeRefTools = new Set([
        'write_to_file',
        'replace_file_content',
        'multi_replace_file_content',
        'edit_file',
        'write_file',
      ])

      let changed = false
      this.db.inTransaction(() => {
        if (payload.error) {
          this.appendEvent(
            primaryTask.id,
            'hook_tool_error',
            'hook',
            { tool: toolName, error: String(payload.error).slice(0, 400) },
            { conversationId, createdAt: now },
          )
          changed = true
        } else if (typeof fileCandidate === 'string' && fileCandidate.trim() && writeRefTools.has(lowerName)) {
          const rawFile = fileCandidate.trim()
          const cwdStr = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : undefined
          const resolvedFile = !isAbsolute(rawFile) && cwdStr ? resolve(cwdStr, rawFile) : rawFile
          const target = normalizeFsPath(resolvedFile)
          this.db.db
            .prepare(
              `INSERT OR IGNORE INTO task_refs (id, task_id, kind, target, label, added_by, created_at)
               VALUES (?, ?, 'file', ?, ?, 'hook', ?)`,
            )
            .run(randomUUID(), primaryTask.id, target, `${toolName}`, now)
          this.appendEvent(
            primaryTask.id,
            'hook_deliverable_captured',
            'hook',
            { tool: toolName, target },
            { conversationId, createdAt: now },
          )
          changed = true
        }
        if (changed) this.notifyRevision()
      })
      if (changed) this.syncTaskSpaceProjection(primaryTask.id)
      return {}
    }

    if (hookEventName === 'Stop') {
      if (payload.fullyIdle === false) return { decision: 'allow' }
      if (isSubagentInvocation && linkedTasks.every((t) => !t.conversations.some((c) => c.conversationId === directConv))) {
        return { decision: 'allow' }
      }
      const reason = String(payload.terminationReason ?? 'NO_TOOL_CALL')
      const isLimitStop =
        reason === 'MAX_INVOCATIONS' || reason === 'MAX_FORCED_INVOCATIONS' || reason === 'MAX_TOKEN_BUDGET_EXCEEDED'
      const now = this.now()
      const transcriptSummary = extractLastPlannerSummary(
        typeof payload.transcriptPath === 'string' ? payload.transcriptPath : undefined,
      )
      for (const task of linkedTasks) {
        if (task.phase !== 'active' && !hasOpenExecution(task)) continue
        const openExec = [...task.executions]
          .reverse()
          .find((e) => e.endedAt === undefined && e.conversationId === directConv)
        const hasOtherOpenExec = task.executions.some(
          (e) => e.endedAt === undefined && e.conversationId !== directConv,
        )
        const outcome: ExecutionOutcome =
          reason === 'USER_CANCELED' ? 'cancelled' : reason === 'ERROR' ? 'failed' : 'succeeded'
        const targetPhase: TaskPhase = outcome === 'cancelled' ? 'on_hold' : 'needs_you'
        const targetSubPhase: TaskSubPhase =
          outcome === 'cancelled'
            ? 'paused'
            : outcome === 'failed'
              ? 'blocked'
              : isLimitStop
                ? 'needs_input'
                : task.subgoalRollup.readyForReview
                  ? 'review'
                  : 'needs_input'
        const rec = reconcilePhaseStatus(targetPhase, targetSubPhase)
        const errText = payload.error ? String(payload.error) : outcome === 'failed' ? reason : null
        const blockedText =
          errText ??
          (outcome === 'cancelled'
            ? 'Paused after user cancellation'
            : isLimitStop
              ? `Turn stopped at limit (${reason}) — awaiting instruction`
              : task.subgoalRollup.readyForReview
                ? 'All required subgoals complete — ready for review'
                : 'Turn completed — awaiting review or next instruction')

        this.db.inTransaction(() => {
          if (openExec) {
            this.db.db
              .prepare('UPDATE task_executions SET ended_at = ?, result = ?, error = ?, summary = COALESCE(?, summary) WHERE id = ?')
              .run(now, outcome, errText, transcriptSummary ?? null, openExec.id)
          } else {
            this.db.db
              .prepare(
                `INSERT INTO task_executions (id, task_id, conversation_id, workspace_id, started_at, ended_at, result, error, summary, initiated_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'hook')`,
              )
              .run(
                randomUUID(),
                task.id,
                directConv || conversationId,
                task.workspaceId ?? null,
                now,
                now,
                outcome,
                errText,
                transcriptSummary ?? null,
              )
          }
          if (!hasOtherOpenExec) {
            this.db.db
              .prepare('UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?')
              .run(rec.phase, rec.subPhase, rec.status, blockedText, now, task.id)
            if (rec.phase === 'needs_you') {
              this.clearSnoozeForTask(task.id, now)
            }
          }
          this.appendEvent(
            task.id,
            'hook_stop',
            'hook',
            {
              terminationReason: reason,
              outcome,
              targetPhase: hasOtherOpenExec ? task.phase : rec.phase,
              targetSubPhase: hasOtherOpenExec ? task.subPhase : rec.subPhase,
              ...(transcriptSummary ? { summary: transcriptSummary } : {}),
            },
            { conversationId, createdAt: now },
          )
          this.notifyRevision()
        })
        this.syncTaskSpaceProjection(task.id)
      }
      return { decision: 'allow' }
    }

    return {}
  }
}

function extractTextFromPlannerContent(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : undefined
  }
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => {
        if (typeof item === 'string') return item.trim()
        if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
          return String((item as { text: string }).text).trim()
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
    return joined || undefined
  }
  if (value && typeof value === 'object') {
    const obj = value as { parts?: unknown; text?: unknown; response?: unknown }
    if (Array.isArray(obj.parts)) {
      return extractTextFromPlannerContent(obj.parts)
    }
    if (typeof obj.text === 'string' && obj.text.trim()) {
      return obj.text.trim()
    }
    if (typeof obj.response === 'string' && obj.response.trim()) {
      return obj.response.trim()
    }
  }
  return undefined
}

function extractLastPlannerSummary(transcriptPath: string | undefined): string | undefined {
  if (!transcriptPath) return undefined
  try {
    const stat = statSync(transcriptPath)
    if (!stat.isFile() || stat.size <= 0) return undefined
    const maxTail = 524_288
    const offset = Math.max(0, stat.size - maxTail)
    const length = stat.size - offset
    const fd = openSync(transcriptPath, 'r')
    try {
      const buf = Buffer.allocUnsafe(length)
      readSync(fd, buf, 0, length, offset)
      const text = buf.toString('utf8')
      const lines = text.split(/\r?\n/)
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim()
        if (!line) continue
        try {
          const parsed = JSON.parse(line) as {
            type?: string
            content?: unknown
            plannerResponse?: { response?: unknown; modifiedResponse?: unknown }
            step?: { plannerResponse?: { response?: unknown; modifiedResponse?: unknown } }
            response?: unknown
          }
          if (parsed.type === 'PLANNER_RESPONSE' || parsed.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
            const summary =
              extractTextFromPlannerContent(parsed.content) ??
              extractTextFromPlannerContent(parsed.plannerResponse?.modifiedResponse) ??
              extractTextFromPlannerContent(parsed.plannerResponse?.response) ??
              extractTextFromPlannerContent(parsed.step?.plannerResponse?.modifiedResponse) ??
              extractTextFromPlannerContent(parsed.step?.plannerResponse?.response) ??
              extractTextFromPlannerContent(parsed.response)
            if (summary) return summary.slice(0, 2000)
          }
        } catch {
          // ignore partial first line
        }
      }
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
  return undefined
}

