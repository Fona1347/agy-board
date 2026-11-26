/**
 * Flat RPC-style HTTP route definitions shared by both Antigravity SidecarApp
 * and the standalone loopback HTTP server.
 *
 * All API routes use exact pathnames (no `:id` path parameters) because
 * Antigravity's `sidecar_sdk` dispatches APIs via exact `Map.get(url.pathname)`.
 */
import { DomainError, readHostThemeMode, type BoardService } from '../host/index.ts'
import type {
  BatchTaskAction,
  ConversationRole,
  TaskPhase,
  TaskPriority,
  TaskRefKind,
  TaskSubPhase,
} from '../core/index.ts'

export interface HttpResponsePayload {
  status: number
  body: unknown
}

export interface RouteDef {
  method: 'GET' | 'POST'
  path: string
  handler: (data: Record<string, unknown>) => Promise<unknown> | unknown
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  return undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

export function buildBoardApiRoutes(service: BoardService): RouteDef[] {
  return [
    {
      method: 'GET',
      path: '/api/health',
      handler: () => ({
        ok: true,
        revision: service.db.getRevision(),
        serverTime: Date.now(),
      }),
    },
    {
      method: 'GET',
      path: '/api/revision',
      handler: () => ({
        revision: service.db.getRevision(),
        serverTime: Date.now(),
        hostTheme: readHostThemeMode(service.paths.geminiConfigDir),
      }),
    },
    {
      method: 'GET',
      path: '/api/snapshot',
      handler: (data) => {
        const activeRaw = asString(data.activeWorkspaces)
        const activeWorkspacePaths = activeRaw
          ? activeRaw.split('|').map((s) => s.trim()).filter(Boolean)
          : []
        const includeArchived = asBoolean(data.includeArchived) ?? true
        return service.getSnapshot({ includeArchived, activeWorkspacePaths })
      },
    },
    {
      method: 'GET',
      path: '/api/workspaces',
      handler: () => ({
        workspaces: service.listWorkspaces(),
      }),
    },
    {
      method: 'POST',
      path: '/api/workspaces/register',
      handler: (data) => {
        const workspace = service.registerCustomWorkspace({
          name: asString(data.name),
          rootPath: String(data.rootPath ?? ''),
          pinned: asBoolean(data.pinned),
        })
        return { ok: true, workspace, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/workspaces/update',
      handler: (data) => {
        const workspaceId = String(data.workspaceId ?? data.id ?? '').trim()
        if (!workspaceId) throw new DomainError('invalid-workspace', 'workspaceId is required.')
        const workspace = service.updateCustomWorkspace(workspaceId, {
          name: asString(data.name),
          rootPath: asString(data.rootPath),
          pinned: asBoolean(data.pinned),
        })
        return { ok: true, workspace, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/workspaces/delete',
      handler: (data) => {
        const workspaceId = String(data.workspaceId ?? data.id ?? '').trim()
        if (!workspaceId) throw new DomainError('invalid-workspace', 'workspaceId is required.')
        service.deleteCustomWorkspace(workspaceId)
        return { ok: true, revision: service.db.getRevision() }
      },
    },
    {
      method: 'GET',
      path: '/api/conversations',
      handler: (data) =>
        service.listRecentConversations({
          projectId: asString(data.projectId),
          workspacePath: asString(data.workspacePath),
          limit: asNumber(data.limit),
        }),
    },
    {
      method: 'POST',
      path: '/api/conversations/jump',
      handler: async (data) => {
        const conversationId = String(data.conversationId ?? '').trim()
        const callerOrigin = asString(data.callerOrigin)
        return service.agentBridge.jumpToConversation(
          conversationId,
          callerOrigin ? { excludeOrigin: callerOrigin } : undefined,
        )
      },
    },
    {
      method: 'GET',
      path: '/api/conversations/governance',
      handler: () => ({
        ok: true,
        config: service.getConversationGovernanceConfig(),
      }),
    },
    {
      method: 'POST',
      path: '/api/conversations/governance/update',
      handler: (data) => {
        const config = service.updateConversationGovernanceConfig({
          ...(data.autoRename !== undefined ? { autoRename: asBoolean(data.autoRename) } : {}),
          ...(data.titlePrefix !== undefined ? { titlePrefix: asString(data.titlePrefix) } : {}),
          ...(data.autoTag !== undefined ? { autoTag: asBoolean(data.autoTag) } : {}),
          ...(data.autoGroup !== undefined ? { autoGroup: asBoolean(data.autoGroup) } : {}),
          ...(data.conversationGroupId !== undefined ? { conversationGroupId: asString(data.conversationGroupId) } : {}),
          ...(data.autoArchiveOnFinish !== undefined ? { autoArchiveOnFinish: asBoolean(data.autoArchiveOnFinish) } : {}),
        })
        return { ok: true, config, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/conversations/cleanup-finished',
      handler: async (data) => {
        const result = await service.cleanupFinishedConversations({
          workspaceId: asString(data.workspaceId),
          dryRun: asBoolean(data.dryRun),
        })
        return { ...result, revision: service.db.getRevision() }
      },
    },
    {
      method: 'GET',
      path: '/api/tasks/get',
      handler: (data) => {
        const taskId = String(data.taskId ?? '')
        const task = service.getTask(taskId)
        if (!task) throw new DomainError('task-not-found', `No task with id '${taskId}'.`)
        return { task, events: service.listTaskEvents(taskId, 80) }
      },
    },
    {
      method: 'GET',
      path: '/api/tasks/events',
      handler: (data) => {
        const taskId = String(data.taskId ?? '')
        return { events: service.listTaskEvents(taskId, asNumber(data.limit) ?? 80) }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/create',
      handler: (data) => {
        const payload = { ...data }
        if (payload.dueAt !== undefined && payload.dueAt !== null) {
          const parsedDue = asNumber(payload.dueAt)
          if (parsedDue === undefined) throw new DomainError('invalid-due-at', 'dueAt must be a finite epoch millisecond timestamp.')
          payload.dueAt = parsedDue
        }
        if (payload.reminderAt !== undefined && payload.reminderAt !== null) {
          const parsedRem = asNumber(payload.reminderAt)
          if (parsedRem === undefined) throw new DomainError('invalid-reminder', 'reminderAt must be a finite epoch millisecond timestamp.')
          payload.reminderAt = parsedRem
        }
        if (payload.useWorktree !== undefined) {
          payload.useWorktree = asBoolean(payload.useWorktree) ?? Boolean(payload.useWorktree)
        }
        if (payload.pin !== undefined) {
          payload.pin = asBoolean(payload.pin) ?? Boolean(payload.pin)
        }
        const task = service.createTask(payload as never, 'ui')
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/update',
      handler: (data) => {
        const taskId = String(data.taskId ?? '')
        const patch = { ...((data.patch ?? data) as Record<string, unknown>) }
        delete patch.taskId
        if (patch.dueAt !== undefined && patch.dueAt !== null) {
          const parsedDue = asNumber(patch.dueAt)
          if (parsedDue === undefined) throw new DomainError('invalid-due-at', 'dueAt must be a finite epoch millisecond timestamp or null.')
          patch.dueAt = parsedDue
        }
        if (patch.useWorktree !== undefined) {
          patch.useWorktree = asBoolean(patch.useWorktree) ?? Boolean(patch.useWorktree)
        }
        const task = service.updateTask(taskId, patch as never, 'ui')
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/transition',
      handler: (data) => {
        const task = service.transitionPhase(String(data.taskId ?? ''), data.phase as TaskPhase, {
          subPhase: data.subPhase as TaskSubPhase | undefined,
          blockedReason: data.blockedReason as string | null | undefined,
          nextAction: data.nextAction as string | null | undefined,
          force: asBoolean(data.force),
          sortOrder: asNumber(data.sortOrder),
          source: 'ui',
        })
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/reorder',
      handler: (data) => {
        const phase = data.phase as TaskPhase
        const orderedIds = Array.isArray(data.orderedIds) ? data.orderedIds.map(String) : []
        service.reorderPhaseTasks(phase, orderedIds)
        return { ok: true, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/confirm-permission',
      handler: (data) => {
        const task = service.confirmPermission(String(data.taskId ?? ''))
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/archive',
      handler: (data) => {
        const task = service.archiveTask(String(data.taskId ?? ''), 'ui')
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/restore',
      handler: (data) => {
        const task = service.restoreTask(String(data.taskId ?? ''), 'ui')
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/delete',
      handler: (data) => {
        service.deleteTask(String(data.taskId ?? ''))
        return { ok: true, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/marks',
      handler: (data) => {
        let snoozeUntil: number | null | undefined
        if (data.snoozeUntil === null) {
          snoozeUntil = null
        } else if (data.snoozeUntil !== undefined) {
          const parsed = asNumber(data.snoozeUntil)
          if (parsed === undefined) {
            throw new DomainError('invalid-snooze', 'snoozeUntil must be a finite epoch millisecond timestamp or null.')
          }
          snoozeUntil = parsed
        }
        const task = service.setUserMarks(
          String(data.taskId ?? ''),
          {
            ack: asBoolean(data.ack),
            ignore: asBoolean(data.ignore),
            pin: asBoolean(data.pin),
            snoozeUntil,
          },
          'ui',
        )
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/batch',
      handler: (data) => {
        const taskIds = Array.isArray(data.taskIds) ? data.taskIds.map(String) : []
        const result = service.batchTasks(
          {
            taskIds,
            action: String(data.action ?? '') as BatchTaskAction,
            subPhase: asString(data.subPhase) as 'ready' | 'backlog' | undefined,
            priority: asString(data.priority) as TaskPriority | undefined,
            workspaceId: data.workspaceId === null ? null : asString(data.workspaceId),
            workspacePath: data.workspacePath === null ? null : asString(data.workspacePath),
            force: asBoolean(data.force),
          },
          'ui',
        )
        return { ok: true, ...result, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/plan-breakdown',
      handler: (data) => {
        const task = service.planBreakdown(data as never, 'ui')
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/subgoal/add',
      handler: (data) => {
        const task = service.addSubgoal(String(data.taskId ?? ''), data as never, 'ui')
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/subgoal/update',
      handler: (data) => {
        const task = service.updateSubgoal(
          String(data.taskId ?? ''),
          String(data.subgoalId ?? ''),
          (data.patch ?? data) as never,
          'ui',
        )
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/subgoal/delete',
      handler: (data) => {
        const task = service.deleteSubgoal(String(data.taskId ?? ''), String(data.subgoalId ?? ''), 'ui')
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/subgoals/reorder',
      handler: (data) => {
        const rawIds = data.orderedIds ?? data.orderedSubgoalIds
        const orderedIds = Array.isArray(rawIds) ? rawIds.map(String) : []
        const task = service.reorderSubgoals(String(data.taskId ?? ''), orderedIds, 'ui')
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/comment/add',
      handler: (data) => {
        const res = service.addTaskComment(
          String(data.taskId ?? ''),
          {
            author: asString(data.author),
            bodyMd: String(data.bodyMd ?? data.body ?? data.content ?? ''),
          },
          'ui',
        )
        return { ok: true, task: res.task, comment: res.comment, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/ref/add',
      handler: (data) => {
        const res = service.addTaskRef(
          String(data.taskId ?? ''),
          {
            kind: (asString(data.kind) ?? 'file') as TaskRefKind,
            target: String(data.target ?? ''),
            label: asString(data.label),
            subgoalId: asString(data.subgoalId),
            round: asNumber(data.round),
          },
          'ui',
        )
        return { ok: true, task: res.task, ref: res.ref, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/ref/remove',
      handler: (data) => {
        const task = service.removeTaskRef(String(data.taskId ?? ''), String(data.refId ?? ''), 'ui')
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'GET',
      path: '/api/tasks/ref/preview',
      handler: (data) => {
        const preview = service.previewRef(
          String(data.taskId ?? ''),
          String(data.refId ?? data.target ?? ''),
        )
        return preview
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/conversation/link',
      handler: (data) => {
        const task = service.linkConversation(
          String(data.taskId ?? ''),
          {
            conversationId: String(data.conversationId ?? ''),
            subgoalId: asString(data.subgoalId),
            role: asString(data.role) as ConversationRole | undefined,
            workspaceId: asString(data.workspaceId),
            summary: asString(data.summary),
            includeInHandoff: asBoolean(data.includeInHandoff),
          },
          'ui',
        )
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/conversation/meta',
      handler: (data) => {
        const task = service.updateConversationMeta(
          String(data.taskId ?? ''),
          {
            conversationId: String(data.conversationId ?? ''),
            subgoalId: asString(data.subgoalId),
            summary: data.summary === null ? null : asString(data.summary),
            includeInHandoff: asBoolean(data.includeInHandoff),
            role: asString(data.role) as ConversationRole | undefined,
          },
          'ui',
        )
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/conversation/unlink',
      handler: (data) => {
        const task = service.unlinkConversation(
          String(data.taskId ?? ''),
          String(data.conversationId ?? ''),
          asString(data.subgoalId) ?? '',
        )
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/dispatch',
      handler: async (data) => {
        const res = await service.dispatchTask(String(data.taskId ?? ''), {
          subgoalId: asString(data.subgoalId),
          mode: asString(data.mode) as 'auto' | 'new' | 'resume' | 'rework' | undefined,
          conversationId: asString(data.conversationId),
          reworkInstructions: asString(data.reworkInstructions),
          extraInstruction: asString(data.extraInstruction),
          model: asString(data.model),
          profile: asString(data.profile),
          reasoningEffort: asString(data.reasoningEffort),
          useWorktree: asBoolean(data.useWorktree),
          runGroupId: asString(data.runGroupId),
          source: 'ui',
        })
        return { ok: true, ...res, revision: service.db.getRevision() }
      },
    },
    {
      method: 'GET',
      path: '/api/tasks/worktree/diff',
      handler: async (data) => {
        const taskId = String(data.taskId ?? '')
        return service.getTaskWorktreeDiff(taskId)
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/worktree/cleanup',
      handler: async (data) => {
        const taskId = String(data.taskId ?? '')
        const task = await service.cleanupTaskWorktree(taskId, Boolean(asBoolean(data.force)), 'ui')
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/settle',
      handler: (data) => {
        const task = service.settleExecution(String(data.taskId ?? ''), (data.outcome ?? 'succeeded') as never, {
          executionId: asString(data.executionId),
          summary: asString(data.summary),
          error: asString(data.error),
          targetPhase: asString(data.targetPhase) as TaskPhase | undefined,
          force: asBoolean(data.force),
          source: 'ui',
        })
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/schedule',
      handler: (data) => {
        const patch = data.patch === null ? null : ((data.patch ?? data) as never)
        const task = service.setTaskSchedule(String(data.taskId ?? ''), patch, 'ui')
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/schedule/complete-cycle',
      handler: (data) => {
        const task = service.completeScheduleCycle(
          String(data.taskId ?? ''),
          { force: asBoolean(data.force), note: asString(data.note) },
          'ui',
        )
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/schedule/catch-up',
      handler: async (data) => {
        const action = asString(data.action)
        if (action !== 'run' && action !== 'skip') {
          throw new DomainError('invalid-schedule', "catch-up action must be 'run' or 'skip'.")
        }
        const task = await service.handleMissedSchedule(String(data.taskId ?? ''), action, 'ui')
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/schedule/skip-cycle',
      handler: (data) => {
        const task = service.skipScheduleCycle(String(data.taskId ?? ''), 'ui')
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/schedule/run-now',
      handler: async (data) => {
        const task = await service.runScheduleNow(String(data.taskId ?? ''), 'ui')
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/reminder',
      handler: (data) => {
        const raw = data.reminderAt
        let reminderAt: number | null
        if (raw === null || raw === undefined || raw === '') {
          reminderAt = null
        } else {
          const parsed = asNumber(raw)
          if (parsed === undefined) {
            throw new DomainError('invalid-reminder', 'reminderAt must be a finite epoch millisecond timestamp or null.')
          }
          reminderAt = parsed
        }
        const task = service.setTaskReminder(String(data.taskId ?? ''), reminderAt, 'ui')
        return { ok: true, task, revision: service.db.getRevision() }
      },
    },
  ]
}

export function formatApiError(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof DomainError) {
    const status =
      err.code === 'task-not-found' ||
      err.code === 'subgoal-not-found' ||
      err.code === 'workspace-not-found' ||
      err.code === 'no-worktree'
        ? 404
        : err.code === 'confirmation-required' ||
            err.code === 'frozen-content' ||
            err.code === 'required-subgoals-open' ||
            err.code === 'execution-open' ||
            err.code === 'session-busy' ||
            err.code === 'duplicate-subgoal-id' ||
            err.code === 'cannot-delete-host-workspace' ||
            err.code === 'cannot-edit-host-workspace-path'
          ? 409
          : 400
    return { status, body: { ok: false, code: err.code, error: err.message } }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { status: 500, body: { ok: false, code: 'internal-error', error: message } }
}

export type { TaskPriority }
