import type {
  BatchTaskAction,
  BoardFocusRequest,
  BoardSnapshot,
  ConversationRole,
  ScheduleAction,
  ScheduleMisfirePolicy,
  ScheduleMode,
  ScheduleOverlapPolicy,
  ScheduleSessionMode,
  SubgoalKind,
  SubgoalStatus,
  TaskEventRecord,
  TaskHandoverInput,
  TaskPermission,
  TaskPhase,
  TaskPriority,
  TaskRecord,
  TaskRefKind,
  TaskSubPhase,
  WorkspaceRecord,
  WriteGateMode,
} from '../core/types.ts'

export interface ScheduleMutationPatch {
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

export interface TaskCommentRecord {
  id: string
  taskId: string
  author: string
  bodyMd: string
  createdAt: number
}

export interface WorktreeDiffFile {
  path: string
  status?: string
  additions?: number
  deletions?: number
}

export interface WorktreeDiffResponse {
  ok?: boolean
  available?: boolean
  exists?: boolean
  worktreePath?: string
  branch?: string
  baseBranch?: string
  status?: string
  stat?: string
  diffStat?: string
  summary?: string
  diff?: string
  patch?: string
  hasChanges?: boolean
  truncated?: boolean
  clean?: boolean
  ahead?: number
  files?: WorktreeDiffFile[]
  message?: string
  error?: string
}

export type ClientTaskRecord = TaskRecord & {
  useWorktree?: boolean
  worktreePath?: string
  worktreeBranch?: string
  comments?: TaskCommentRecord[]
}

export interface TaskDetailResponse {
  task: ClientTaskRecord
  events: TaskEventRecord[]
  comments?: TaskCommentRecord[]
}

export interface ConversationGovernanceConfig {
  autoRename: boolean
  titlePrefix: string
  autoTag: boolean
  autoGroup: boolean
  conversationGroupId: string
  autoArchiveOnFinish: boolean
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
  revision?: number
}

export interface SidecarBridge {
  conversationId?: string
  fetch(url: string, options?: RequestInit): Promise<Response>
  getWorkspaceUris(): Promise<string[]>
  onWorkspaceChange(listener: (uris: string[]) => void): () => void
  ui?: {
    toggleAuxPane?(request?: unknown): void
    toggleConversation?(conversationId: string, options?: { split?: 'right'; [key: string]: unknown }): void
    addArtifactComment?(payload: { uri?: string; comment: string; selection?: string; pageTitle?: string }): void
  }
}

declare global {
  interface Window {
    sidecar?: SidecarBridge
  }
}

export function getSidecar(): SidecarBridge | undefined {
  return typeof window !== 'undefined' ? window.sidecar : undefined
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const sidecar = getSidecar()
  const fetcher = sidecar?.fetch ?? fetch
  const headers = new Headers(init?.headers)
  if (!headers.has('Content-Type') && init?.body) {
    headers.set('Content-Type', 'application/json')
  }
  const res = await fetcher(url, { ...init, headers })
  const text = await res.text()
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  if (!res.ok || parsed.ok === false) {
    const errMsg = typeof parsed.error === 'string' ? parsed.error : `Request failed (${res.status})`
    throw new Error(errMsg)
  }
  return parsed as T
}

const realBoardApi = {
  getSnapshot(activeWorkspaces: string[] = []): Promise<BoardSnapshot> {
    const params = new URLSearchParams()
    if (activeWorkspaces.length > 0) params.set('activeWorkspaces', activeWorkspaces.join('|'))
    const qs = params.toString()
    return requestJson<BoardSnapshot>(`/api/snapshot${qs ? `?${qs}` : ''}`)
  },
  getRevision(): Promise<{
    revision: number
    serverTime: number
    hostTheme?: 'dark' | 'light' | 'system'
    focus?: BoardFocusRequest | null
  }> {
    return requestJson('/api/revision')
  },
  getTaskDetail(taskId: string): Promise<TaskDetailResponse> {
    return requestJson(`/api/tasks/get?taskId=${encodeURIComponent(taskId)}`)
  },
  registerWorkspace(input: { name?: string; rootPath: string; pinned?: boolean }): Promise<{ workspace: WorkspaceRecord }> {
    return requestJson('/api/workspaces/register', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },
  updateWorkspace(input: { workspaceId: string; name?: string; pinned?: boolean }): Promise<{ workspace: WorkspaceRecord }> {
    return requestJson('/api/workspaces/update', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },
  deleteWorkspace(workspaceId: string): Promise<{ ok: true }> {
    return requestJson('/api/workspaces/delete', {
      method: 'POST',
      body: JSON.stringify({ workspaceId }),
    })
  },
  createTask(input: {
    title: string
    description?: string
    userNotes?: string
    prompt?: string
    phase?: TaskPhase
    subPhase?: TaskSubPhase
    priority?: TaskPriority
    workspaceId?: string
    workspacePath?: string
    nextAction?: string
    dueAt?: number
    pin?: boolean
    permission?: TaskPermission
    writeGate?: WriteGateMode
    mode?: string
    model?: string
    reasoningEffort?: string
    useWorktree?: boolean
    reuseSession?: boolean
    reminderAt?: number
    schedule?: ScheduleMutationPatch & { enabled: boolean }
    handover?: TaskHandoverInput
    tags?: Array<{ name: string; promptPrefix?: string }>
    freeze?: { goal: string; progress: string; next: string } | string
    subgoals?: Array<{ title: string; detail?: string; kind?: SubgoalKind; required?: boolean }>
  }): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/create', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },
  updateTask(taskId: string, patch: Record<string, unknown>): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/update', {
      method: 'POST',
      body: JSON.stringify({ taskId, patch }),
    })
  },
  transitionTask(
    taskId: string,
    phase: TaskPhase,
    options: { subPhase?: TaskSubPhase; blockedReason?: string | null; nextAction?: string | null; force?: boolean } = {},
  ): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/transition', {
      method: 'POST',
      body: JSON.stringify({ taskId, phase, ...options }),
    })
  },
  reorderTasks(phase: TaskPhase, orderedIds: string[]): Promise<{ ok: true }> {
    return requestJson('/api/tasks/reorder', {
      method: 'POST',
      body: JSON.stringify({ phase, orderedIds }),
    })
  },
  confirmPermission(taskId: string): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/confirm-permission', {
      method: 'POST',
      body: JSON.stringify({ taskId }),
    })
  },
  archiveTask(taskId: string): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/archive', { method: 'POST', body: JSON.stringify({ taskId }) })
  },
  restoreTask(taskId: string): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/restore', { method: 'POST', body: JSON.stringify({ taskId }) })
  },
  deleteTask(taskId: string): Promise<{ ok: true }> {
    return requestJson('/api/tasks/delete', { method: 'POST', body: JSON.stringify({ taskId }) })
  },
  setMarks(
    taskId: string,
    marks: { ack?: boolean; ignore?: boolean; pin?: boolean; snoozeUntil?: number | null },
  ): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/marks', { method: 'POST', body: JSON.stringify({ taskId, ...marks }) })
  },
  batchTasks(input: {
    taskIds: string[]
    action: BatchTaskAction
    subPhase?: 'ready' | 'backlog'
    priority?: TaskPriority
    workspaceId?: string | null
    workspacePath?: string | null
    force?: boolean
  }): Promise<{ ok: true; action: BatchTaskAction; affectedIds: string[]; skippedIds: string[]; tasks: TaskRecord[] }> {
    return requestJson('/api/tasks/batch', { method: 'POST', body: JSON.stringify(input) })
  },
  addComment(
    taskId: string,
    input: { bodyMd: string; author?: string },
  ): Promise<{ ok?: boolean; task?: TaskRecord; comment?: TaskCommentRecord; comments?: TaskCommentRecord[] }> {
    return requestJson('/api/tasks/comment/add', {
      method: 'POST',
      body: JSON.stringify({ taskId, ...input }),
    })
  },
  addSubgoal(
    taskId: string,
    input: { title: string; detail?: string; kind?: SubgoalKind; required?: boolean },
  ): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/subgoal/add', {
      method: 'POST',
      body: JSON.stringify({ taskId, ...input }),
    })
  },
  planBreakdown(input: {
    taskId: string
    replace?: boolean
    subgoals: Array<{ title: string; detail?: string; kind?: SubgoalKind; required?: boolean }>
  }): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/plan-breakdown', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },
  updateSubgoal(
    taskId: string,
    subgoalId: string,
    patch: { title?: string; detail?: string; required?: boolean; status?: SubgoalStatus; sortOrder?: number },
  ): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/subgoal/update', {
      method: 'POST',
      body: JSON.stringify({ taskId, subgoalId, patch }),
    })
  },
  reorderSubgoals(taskId: string, orderedIds: string[]): Promise<{ ok?: boolean; task?: TaskRecord }> {
    return requestJson('/api/tasks/subgoals/reorder', {
      method: 'POST',
      body: JSON.stringify({ taskId, orderedIds }),
    })
  },
  deleteSubgoal(taskId: string, subgoalId: string): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/subgoal/delete', {
      method: 'POST',
      body: JSON.stringify({ taskId, subgoalId }),
    })
  },
  addRef(
    taskId: string,
    input: { kind: TaskRefKind; target: string; label?: string; subgoalId?: string },
  ): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/ref/add', {
      method: 'POST',
      body: JSON.stringify({ taskId, ...input }),
    })
  },
  removeRef(taskId: string, refId: string): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/ref/remove', {
      method: 'POST',
      body: JSON.stringify({ taskId, refId }),
    })
  },
  async previewRef(
    taskId: string,
    refId: string,
  ): Promise<{
    ok: boolean
    refId?: string
    kind?: string
    target?: string
    resolvedPath?: string
    isUrl?: boolean
    isBinary?: boolean
    language?: string
    sizeBytes?: number
    truncated?: boolean
    content?: string
    message?: string
  }> {
    const sidecar = getSidecar()
    const fetcher = sidecar?.fetch ?? fetch
    const r = await fetcher(
      `/api/tasks/ref/preview?taskId=${encodeURIComponent(taskId)}&refId=${encodeURIComponent(refId)}`,
    )
    const text = await r.text()
    try {
      return JSON.parse(text)
    } catch {
      return { ok: false, message: text || `Preview failed (${r.status})` }
    }
  },
  linkConversation(
    taskId: string,
    input: {
      conversationId: string
      subgoalId?: string
      role?: ConversationRole
      summary?: string
      includeInHandoff?: boolean
    },
  ): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/conversation/link', {
      method: 'POST',
      body: JSON.stringify({ taskId, ...input }),
    })
  },
  updateConversationMeta(
    taskId: string,
    input: {
      conversationId: string
      subgoalId?: string
      summary?: string | null
      includeInHandoff?: boolean
      role?: ConversationRole
    },
  ): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/conversation/meta', {
      method: 'POST',
      body: JSON.stringify({ taskId, ...input }),
    })
  },
  unlinkConversation(taskId: string, conversationId: string, subgoalId = ''): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/conversation/unlink', {
      method: 'POST',
      body: JSON.stringify({ taskId, conversationId, subgoalId }),
    })
  },
  dispatch(
    taskId: string,
    options: {
      subgoalId?: string
      mode?: 'auto' | 'new' | 'resume' | 'rework'
      conversationId?: string
      reworkInstructions?: string
      extraInstruction?: string
      model?: string
      profile?: string
      useWorktree?: boolean
      reasoningEffort?: string
    } = {},
  ): Promise<{ ok: true; task: TaskRecord; executionId: string; conversationId: string; action: string }> {
    return requestJson('/api/tasks/dispatch', {
      method: 'POST',
      body: JSON.stringify({ taskId, ...options }),
    })
  },
  settle(
    taskId: string,
    outcome: 'succeeded' | 'failed' | 'cancelled',
    summaryOrOpts?: string | { summary?: string; targetPhase?: TaskPhase; force?: boolean },
  ): Promise<{ task: TaskRecord }> {
    const opts = typeof summaryOrOpts === 'string' ? { summary: summaryOrOpts } : (summaryOrOpts ?? {})
    return requestJson('/api/tasks/settle', {
      method: 'POST',
      body: JSON.stringify({ taskId, outcome, ...opts }),
    })
  },
  setReminder(taskId: string, reminderAt: number | null): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/reminder', {
      method: 'POST',
      body: JSON.stringify({ taskId, reminderAt }),
    })
  },
  setSchedule(
    taskId: string,
    patch: ScheduleMutationPatch | null,
  ): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/schedule', {
      method: 'POST',
      body: JSON.stringify({ taskId, patch }),
    })
  },
  completeScheduleCycle(
    taskId: string,
    options: { force?: boolean; note?: string } = {},
  ): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/schedule/complete-cycle', {
      method: 'POST',
      body: JSON.stringify({ taskId, ...options }),
    })
  },
  catchUpSchedule(taskId: string, action: 'run' | 'skip'): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/schedule/catch-up', {
      method: 'POST',
      body: JSON.stringify({ taskId, action }),
    })
  },
  skipScheduleCycle(taskId: string): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/schedule/skip-cycle', {
      method: 'POST',
      body: JSON.stringify({ taskId }),
    })
  },
  runScheduleNow(taskId: string): Promise<{ task: TaskRecord }> {
    return requestJson('/api/tasks/schedule/run-now', {
      method: 'POST',
      body: JSON.stringify({ taskId }),
    })
  },
  async getWorktreeDiff(taskId: string): Promise<WorktreeDiffResponse> {
    const sidecar = getSidecar()
    const fetcher = sidecar?.fetch ?? fetch
    const r = await fetcher(`/api/tasks/worktree/diff?taskId=${encodeURIComponent(taskId)}`)
    const text = await r.text()
    try {
      const parsed = JSON.parse(text) as WorktreeDiffResponse
      if (!r.ok && parsed.ok === undefined) parsed.ok = false
      return parsed
    } catch {
      return { ok: false, message: text || `Diff request failed (${r.status})` }
    }
  },
  cleanupWorktree(taskId: string): Promise<{ ok: boolean; message?: string; task?: TaskRecord }> {
    return requestJson('/api/tasks/worktree/cleanup', {
      method: 'POST',
      body: JSON.stringify({ taskId }),
    })
  },
  async jumpToConversation(
    conversationId: string,
    options?: { split?: 'right' },
  ): Promise<{ ok: boolean; message: string }> {
    const sidecar = getSidecar()
    if (typeof window !== 'undefined' && window.parent !== window && sidecar?.ui?.toggleConversation) {
      if (options) {
        sidecar.ui.toggleConversation(conversationId, options)
      } else {
        sidecar.ui.toggleConversation(conversationId)
      }
      return {
        ok: true,
        message: options?.split
          ? `Opened ${conversationId.slice(0, 8)} in split (${options.split})`
          : `Switched Antigravity to ${conversationId.slice(0, 8)}`,
      }
    }
    const callerOrigin = typeof window !== 'undefined' ? window.location.origin : undefined
    const res = await requestJson<{ ok: boolean; method: string; reason?: string }>('/api/conversations/jump', {
      method: 'POST',
      body: JSON.stringify({
        conversationId,
        ...(callerOrigin ? { callerOrigin } : {}),
        ...(options ? { options, split: options.split } : {}),
      }),
    })
    return {
      ok: res.ok,
      message: res.ok ? `Jumped via CDP to ${conversationId.slice(0, 8)}` : res.reason ?? 'Could not jump via CDP.',
    }
  },
  getConversationGovernance(): Promise<{ ok: true; config: ConversationGovernanceConfig }> {
    return requestJson('/api/conversations/governance')
  },
  updateConversationGovernance(
    patch: Partial<ConversationGovernanceConfig>,
  ): Promise<{ ok: true; config: ConversationGovernanceConfig; revision?: number }> {
    return requestJson('/api/conversations/governance/update', {
      method: 'POST',
      body: JSON.stringify(patch),
    })
  },
  cleanupFinishedConversations(
    options: { workspaceId?: string; dryRun?: boolean } = {},
  ): Promise<ConversationCleanupResult> {
    return requestJson('/api/conversations/cleanup-finished', {
      method: 'POST',
      body: JSON.stringify(options),
    })
  },
}

export type BoardApiSandbox = typeof realBoardApi

let activeSandbox: BoardApiSandbox | null = null

export function setBoardApiSandbox(sandbox: BoardApiSandbox | null): void {
  activeSandbox = sandbox
}

export function getBoardApiSandbox(): BoardApiSandbox | null {
  return activeSandbox
}

export const boardApi: BoardApiSandbox = new Proxy(realBoardApi, {
  get(target, prop) {
    if (typeof Reflect.get(target, prop) !== 'function') {
      return Reflect.get(activeSandbox ?? target, prop)
    }
    return (...args: unknown[]) => {
      const source = activeSandbox ?? target
      const fn = Reflect.get(source, prop) as (...a: unknown[]) => unknown
      return fn.apply(source, args)
    }
  },
})
