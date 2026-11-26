/**
 * Antigravity MCP stdio server + inline MCP App UI resource for agy-board.
 * Shares the exact same authoritative SQLite BoardService as the Sidecar UI and Hooks.
 */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  TASK_PERMISSIONS,
  TASK_PHASES,
  TASK_PRIORITIES,
  isPathEqualOrInside,
  matchProjectIdForWorkspace,
  pathComparisonKey,
  requiresPermissionConfirmation,
  unblockedSubgoals,
  type TaskPhase,
  type TaskPriority,
  type TaskRecord,
  type TaskRefKind,
  type TaskSubPhase,
} from '../core/index.ts'
import {
  BoardDatabase,
  BoardService,
  resolveConversationLineage,
  resolveHostPaths,
  type HostPathOverrides,
} from '../host/index.ts'
import { installEpipeGuard, releasePluginCwdLock } from './server-core.ts'
import { renderMcpAppCardHtml } from '../mcp-app/render-card.ts'

export { renderMcpAppCardHtml }
export const MCP_APP_CARD_URI = 'ui://agy-board/card.html'
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app'

function textResult(
  data: Record<string, unknown>,
  structured?: boolean | Record<string, unknown>,
): {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
} {
  const structuredContent =
    structured === true ? data : structured && typeof structured === 'object' ? structured : undefined
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    ...(structuredContent ? { structuredContent } : {}),
  }
}

function errResult(err: unknown): { isError: true; content: Array<{ type: 'text'; text: string }> } {
  const message = err instanceof Error ? err.message : String(err)
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }) }] }
}

function summarizeTask(task: TaskRecord): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    phase: task.phase,
    subPhase: task.subPhase,
    status: task.status,
    priority: task.priority,
    workspaceId: task.workspaceId,
    workspacePath: task.workspacePath,
    workspaceLabel: task.workspaceLabel,
    blockedReason: task.blockedReason,
    nextAction: task.nextAction,
    dueAt: task.dueAt,
    writeGate: task.writeGate,
    mode: task.mode,
    model: task.model,
    reasoningEffort: task.reasoningEffort,
    useWorktree: Boolean(task.useWorktree),
    worktreePath: task.worktreePath,
    worktreeBranch: task.worktreeBranch,
    tags: task.tags,
    planRevision: task.planRevision,
    hasUserNotes: Boolean(task.userNotes?.trim()),
    subgoalRollup: task.subgoalRollup,
    refCount: task.refs.length,
    commentCount: task.comments?.length ?? 0,
    conversations: task.conversations.map((c) => ({
      conversationId: c.conversationId,
      role: c.role,
      subgoalId: c.subgoalId,
      title: c.title,
      isIdle: c.isIdle,
    })),
    reminderAt: task.reminderAt,
    updatedAt: task.updatedAt,
  }
}

function getLockedTaskForCallerConversation(service: BoardService, targetTaskId?: string): TaskRecord | undefined {
  const convId = process.env.ANTIGRAVITY_CONVERSATION_ID?.trim()
  if (!convId) return undefined
  const candidates = [convId]
  const lineage = resolveConversationLineage(service.paths, convId)
  if (lineage.parentConversationId) candidates.push(lineage.parentConversationId)
  candidates.push(...lineage.ancestors)
  if (lineage.rootConversationId) candidates.push(lineage.rootConversationId)

  const seen = new Set<string>()
  const linkedTasks: TaskRecord[] = []
  for (const cid of candidates) {
    if (!cid || seen.has(cid)) continue
    seen.add(cid)
    for (const t of service.db.findTasksByConversationId(cid)) {
      if (t.archivedAt === undefined && !linkedTasks.some((x) => x.id === t.id)) {
        linkedTasks.push(t)
      }
    }
  }
  if (linkedTasks.length === 0) return undefined
  const directMatch = linkedTasks.find(
    (t) =>
      t.writeGate === 'locked' &&
      t.phase !== 'closed' &&
      (!targetTaskId || t.id === targetTaskId),
  )
  if (directMatch) return directMatch
  if (targetTaskId && linkedTasks.some((t) => t.writeGate === 'locked')) {
    const explicit = service.getTask(targetTaskId)
    if (explicit?.writeGate === 'locked') return explicit
  }
  return undefined
}

const PRIORITY_RANK: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
}

export function createBoardMcpServer(service: BoardService): McpServer {
  const server = new McpServer(
    {
      name: 'agy-board',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  )

  server.registerResource(
    'agy-board-card',
    MCP_APP_CARD_URI,
    {
      title: 'Agy Board Status Card',
      description: 'Self-contained HTML task status card for inline MCP App rendering.',
      mimeType: MCP_APP_MIME_TYPE,
      _meta: { ui: { prefersBorder: false } },
    },
    async () => ({
      contents: [
        {
          uri: MCP_APP_CARD_URI,
          mimeType: MCP_APP_MIME_TYPE,
          _meta: { ui: { prefersBorder: false } },
          text: renderMcpAppCardHtml(),
        },
      ],
    }),
  )

  const handoverSchema = z.object({
    workspaceId: z.string().optional(),
    mode: z.string().optional(),
    permission: z.enum(TASK_PERMISSIONS).optional(),
    references: z.array(z.string()).default([]),
  })

  server.registerTool(
    'board_list',
    {
      title: 'List Agy Board Tasks',
      description:
        'List tasks on Agy Board filtered by workspace (normalized path or antigravityProjectId), phase (needs_you, active, on_hold, todo, closed), tag, priority, or free-text query.',
      inputSchema: {
        phase: z.enum(TASK_PHASES).optional(),
        workspacePath: z.string().optional(),
        workspaceId: z.string().optional(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        tag: z.string().optional(),
        query: z.string().optional(),
        includeArchived: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      _meta: { ui: { resourceUri: MCP_APP_CARD_URI } },
    },
    async (args) => {
      try {
        const snap = service.getSnapshot({ includeArchived: args.includeArchived ?? false })
        const wsById = new Map(snap.workspaces.map((w) => [w.id, w]))
        const needle = args.query?.trim().toLowerCase() ?? ''
        const wsPathFilter = args.workspacePath?.trim() ?? ''
        const wsPathKey = wsPathFilter ? pathComparisonKey(wsPathFilter) : ''
        const filterProjectIdFromPath = wsPathFilter
          ? matchProjectIdForWorkspace(undefined, wsPathFilter, snap.workspaces)
          : undefined
        const filterProjectIdFromId = args.workspaceId
          ? matchProjectIdForWorkspace(args.workspaceId, undefined, snap.workspaces) ?? args.workspaceId
          : undefined

        const matched = snap.tasks.filter((task) => {
          if (!args.includeArchived && task.archivedAt !== undefined) return false
          if (args.phase && task.phase !== args.phase) return false
          if (args.workspaceId) {
            const taskWs = task.workspaceId ? wsById.get(task.workspaceId) : undefined
            const taskProjId =
              taskWs?.antigravityProjectId ??
              matchProjectIdForWorkspace(task.workspaceId, task.workspacePath, snap.workspaces)
            const matchesId =
              task.workspaceId === args.workspaceId ||
              taskProjId === args.workspaceId ||
              (filterProjectIdFromId !== undefined && taskProjId === filterProjectIdFromId)
            if (!matchesId) return false
          }
          if (wsPathFilter) {
            const taskPath = task.workspacePath ?? ''
            const taskProjId = matchProjectIdForWorkspace(task.workspaceId, task.workspacePath, snap.workspaces)
            const matchesPath =
              Boolean(taskPath) &&
              (isPathEqualOrInside(taskPath, wsPathFilter) ||
                isPathEqualOrInside(wsPathFilter, taskPath) ||
                (wsPathKey !== '' && pathComparisonKey(taskPath).includes(wsPathKey)))
            const matchesProject =
              filterProjectIdFromPath !== undefined &&
              (task.workspaceId === filterProjectIdFromPath || taskProjId === filterProjectIdFromPath)
            if (!matchesPath && !matchesProject) return false
          }
          if (args.priority && task.priority !== args.priority) return false
          if (args.tag && !task.tags.some((t) => t.name === args.tag)) return false
          if (needle) {
            const hay = [
              task.title,
              task.description,
              task.userNotes ?? '',
              task.workspaceLabel ?? '',
              task.workspacePath ?? '',
              task.freeze?.goal ?? '',
              task.freeze?.next ?? '',
              ...task.tags.map((t) => t.name),
            ]
              .join('\n')
              .toLowerCase()
            if (!hay.includes(needle)) return false
          }
          return true
        })
        const limit = args.limit ?? 50
        return textResult(
          {
            ok: true,
            revision: snap.revision,
            counts: snap.counts,
            total: matched.length,
            tasks: matched.slice(0, limit).map(summarizeTask),
          },
          true,
        )
      } catch (err) {
        return errResult(err)
      }
    },
  )

  server.registerTool(
    'board_get',
    {
      title: 'Get Agy Board Task',
      description:
        'Get full task details including human-exclusive userNotes (read-only for agents; treat as highest-priority override), concise description brief, full execution contract prompt, freeze snapshot, subgoals, TaskSpace refs, comments, linked conversations, executions (with per-round contractSnapshot), and recent events.',
      inputSchema: {
        taskId: z.string().min(1),
      },
      _meta: { ui: { resourceUri: MCP_APP_CARD_URI } },
    },
    async ({ taskId }) => {
      try {
        const task = service.getTask(taskId)
        if (!task) return errResult(new Error(`No task with id '${taskId}'.`))
        return textResult({ ok: true, task, events: service.listTaskEvents(taskId, 30) }, true)
      } catch (err) {
        return errResult(err)
      }
    },
  )

  server.registerTool(
    'board_card',
    {
      title: 'Agy Board Status Card',
      description:
        'Render an inline Agy Board status card for a specific taskId or current active/needs_you tasks. Set focusInBoard=true with taskId to request the right-hand Agy Board sidebar to focus and open that task drawer.',
      inputSchema: {
        taskId: z.string().optional(),
        workspacePath: z.string().optional(),
        focusInBoard: z.boolean().optional(),
      },
      _meta: { ui: { resourceUri: MCP_APP_CARD_URI } },
    },
    async ({ taskId, workspacePath, focusInBoard }) => {
      try {
        if (taskId) {
          const task = service.getTask(taskId)
          if (!task) return errResult(new Error(`No task with id '${taskId}'.`))
          const focusRequest = focusInBoard ? service.requestFocusTask(task.id) : undefined
          return textResult(
            {
              ok: true,
              task,
              ...(focusRequest
                ? { focusRequest, sidecarUri: 'sidecar://agy-board/board/' }
                : {}),
            },
            true,
          )
        }
        const snap = service.getSnapshot({ includeArchived: false })
        const filterProjId = workspacePath
          ? matchProjectIdForWorkspace(undefined, workspacePath, snap.workspaces)
          : undefined
        const relevant = snap.tasks.filter((t) => {
          if (t.phase === 'closed') return false
          if (workspacePath) {
            const pMatch =
              Boolean(t.workspacePath) &&
              (isPathEqualOrInside(t.workspacePath!, workspacePath) ||
                isPathEqualOrInside(workspacePath, t.workspacePath!))
            const projMatch =
              filterProjId !== undefined &&
              (t.workspaceId === filterProjId ||
                matchProjectIdForWorkspace(t.workspaceId, t.workspacePath, snap.workspaces) === filterProjId)
            return pMatch || projMatch
          }
          return true
        })
        return textResult(
          {
            ok: true,
            revision: snap.revision,
            counts: snap.counts,
            total: relevant.length,
            tasks: relevant.slice(0, 12).map(summarizeTask),
          },
          true,
        )
      } catch (err) {
        return errResult(err)
      }
    },
  )

  server.tool(
    'board_workspaces',
    'List Antigravity registered workspaces, custom workspaces, and recent conversations per workspace.',
    {
      workspacePath: z.string().optional(),
      query: z.string().optional(),
      limitConversations: z.number().int().min(1).max(500).optional(),
    },
    async ({ workspacePath, query, limitConversations }) => {
      try {
        const workspaces = service.listWorkspaces()
        const conversations = service.listRecentConversations({
          workspacePath,
          query,
          limit: limitConversations ?? 30,
        })
        return textResult({
          ok: true,
          workspaces,
          recentConversations: conversations.conversations,
          hasMoreConversations: conversations.hasMore,
        })
      } catch (err) {
        return errResult(err)
      }
    },
  )

  server.registerTool(
    'board_create',
    {
      title: 'Create Agy Board Task',
      description:
        'Stage a new task on Agy Board. Agent-created cards default to todo/draft and wait for human approval; pass phase/subPhase to override. Put ONLY a 1–3 sentence human-readable brief (<=150 chars) in `description`; put the full execution contract/plan in `prompt` and `subgoals`. Human-exclusive `userNotes` cannot be set via MCP. Include refs and origin provenance (discoveredFromTaskId/originSummary) so the human can review before dispatch.',
      inputSchema: {
        title: z.string().min(1),
        description: z
          .string()
          .describe('Concise 1–3 sentence human-readable brief summary (<=150 chars). Do NOT dump multi-paragraph plans here; put full plans in `prompt` and `subgoals`.')
          .optional(),
        prompt: z
          .string()
          .describe('Full Agent Execution Contract / implementation plan and first-round instructions (Markdown supported).')
          .optional(),
        phase: z.enum(TASK_PHASES).optional(),
        subPhase: z.enum(['draft', 'ready', 'backlog']).optional(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        createdBy: z.enum(['user', 'ai']).optional(),
        discoveredFromTaskId: z.string().optional(),
        originSummary: z.string().optional(),
        originConversationId: z.string().optional(),
        parentConversationId: z.string().optional(),
        workspaceId: z.string().optional(),
        workspacePath: z.string().optional(),
        nextAction: z.string().optional(),
        dueAt: z.number().int().optional(),
        mode: z.string().optional(),
        model: z.string().optional(),
        reasoningEffort: z.string().optional(),
        permission: z.enum(TASK_PERMISSIONS).optional(),
        reuseSession: z.boolean().optional(),
        useWorktree: z.boolean().optional(),
        writeGate: z.enum(['unlocked', 'locked']).optional(),
        reminderAt: z.number().int().optional(),
        handover: handoverSchema.optional(),
        tags: z
          .array(
            z.object({
              name: z.string().min(1),
              promptPrefix: z.string().optional(),
            }),
          )
          .optional(),
        freeze: z
          .union([
            z.string(),
            z.object({
              goal: z.string(),
              progress: z.string(),
              next: z.string(),
            }),
          ])
          .optional(),
        subgoals: z
          .array(
            z.object({
              id: z.string().optional(),
              title: z.string().min(1),
              detail: z.string().optional(),
              kind: z.enum(['acceptance', 'implementation', 'review', 'custom']).optional(),
              required: z.boolean().optional(),
              dependencies: z.array(z.string()).optional(),
            }),
          )
          .optional(),
        refs: z
          .array(
            z.object({
              kind: z.enum(['file', 'url', 'artifact', 'command', 'doc']),
              target: z.string().min(1),
              label: z.string().optional(),
            }),
          )
          .optional(),
        schedule: z
          .object({
            enabled: z.boolean(),
            mode: z.enum(['cron', 'once', 'after_completion']).optional(),
            cron: z.string().optional(),
            at: z.number().int().optional(),
            intervalDays: z.number().int().min(1).optional(),
            atHour: z.number().int().min(0).max(23).optional(),
            atMinute: z.number().int().min(0).max(59).optional(),
            action: z.enum(['dispatch', 'remind']).optional(),
            sessionMode: z.enum(['new', 'auto']).optional(),
            misfirePolicy: z.enum(['prompt', 'catch_up_once', 'skip']).optional(),
            overlapPolicy: z.enum(['wait_review', 'allow_replace']).optional(),
            timeZone: z.string().nullable().optional(),
            maxRuns: z.number().int().nullable().optional(),
          })
          .optional(),
      },
      _meta: { ui: { resourceUri: MCP_APP_CARD_URI } },
    },
    async (args) => {
      try {
        const task = service.createTask(args, 'mcp')
        return textResult(
          { ok: true, task: summarizeTask(task), fullTask: task },
          { ok: true, task, fullTask: task },
        )
      } catch (err) {
        return errResult(err)
      }
    },
  )

  server.tool(
    'board_update',
    'Update task metadata, concise `description` brief (1–3 sentences, <=150 chars), execution contract `prompt`, workspace binding, dueAt, handover, mode, model, reasoningEffort, nextAction, priority, writeGate, tags, or freeze snapshot. Human-exclusive `userNotes` is protected and CANNOT be modified via MCP (use `board_comment_add` to append agent progress). Note: changing permission re-arms human confirmation in UI.',
    {
      taskId: z.string().min(1),
      title: z.string().optional(),
      description: z
        .string()
        .describe('Concise 1–3 sentence human-readable brief summary (<=150 chars); keep full plans in `prompt`.')
        .optional(),
      prompt: z
        .string()
        .describe('Full Agent Execution Contract / implementation plan (Markdown supported).')
        .optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      workspaceId: z.string().nullable().optional(),
      workspacePath: z.string().nullable().optional(),
      blockedReason: z.string().nullable().optional(),
      nextAction: z.string().nullable().optional(),
      dueAt: z.number().int().nullable().optional(),
      mode: z.string().nullable().optional(),
      model: z.string().nullable().optional(),
      reasoningEffort: z.string().nullable().optional(),
      writeGate: z.enum(['unlocked', 'locked']).optional(),
      permission: z.enum(TASK_PERMISSIONS).nullable().optional(),
      reuseSession: z.boolean().optional(),
      useWorktree: z.boolean().optional(),
      handover: z.union([z.null(), handoverSchema]).optional(),
      tags: z
        .array(z.object({ name: z.string().min(1), promptPrefix: z.string().optional() }))
        .nullable()
        .optional(),
      freeze: z
        .union([
          z.null(),
          z.string(),
          z.object({ goal: z.string(), progress: z.string(), next: z.string() }),
        ])
        .optional(),
    },
    async ({ taskId, ...patch }) => {
      try {
        if (patch.writeGate === 'unlocked') {
          const lockedTask = getLockedTaskForCallerConversation(service, taskId)
          if (lockedTask) {
            return errResult(
              new Error(
                `agy-board Write Gate is LOCKED on task "${lockedTask.title}" (${lockedTask.id}). Unlocking writeGate from an agent MCP call in a locked conversation is denied.`,
              ),
            )
          }
        }
        const task = service.updateTask(taskId, patch, 'mcp')
        return textResult({ ok: true, task: summarizeTask(task) }, { ok: true, task })
      } catch (err) {
        return errResult(err)
      }
    },
  )

  server.tool(
    'board_transition',
    'Transition a task across phases (needs_you, active, on_hold, todo, closed) or archive/restore it. Enforces required subgoals completion before closing unless force=true.',
    {
      taskId: z.string().min(1),
      action: z.enum(['phase', 'archive', 'restore']).default('phase'),
      phase: z.enum(TASK_PHASES).optional(),
      subPhase: z
        .enum([
          'review',
          'blocked',
          'needs_input',
          'permission_pending',
          'reminder_due',
          'running',
          'working',
          'paused',
          'waiting',
          'draft',
          'ready',
          'backlog',
          'done',
          'cancelled',
        ])
        .optional(),
      blockedReason: z.string().nullable().optional(),
      nextAction: z.string().nullable().optional(),
      force: z.boolean().optional(),
    },
    async (args) => {
      try {
        if (args.action === 'archive' || (args.action === 'phase' && args.phase === 'closed')) {
          const lockedTask = getLockedTaskForCallerConversation(service, args.taskId)
          if (lockedTask) {
            return errResult(
              new Error(
                `agy-board Write Gate is LOCKED on task "${lockedTask.title}" (${lockedTask.id}). Closing or archiving from a locked conversation is denied.`,
              ),
            )
          }
        }
        if (args.action === 'archive') {
          return textResult({ ok: true, task: summarizeTask(service.archiveTask(args.taskId, 'mcp')) })
        }
        if (args.action === 'restore') {
          return textResult({ ok: true, task: summarizeTask(service.restoreTask(args.taskId, 'mcp')) })
        }
        if (!args.phase) return errResult(new Error('phase is required when action=phase.'))
        const current = service.getTask(args.taskId)
        if (
          current?.phase === 'todo' &&
          current.subPhase === 'draft' &&
          (args.subPhase === 'ready' ||
            args.subPhase === 'backlog' ||
            (args.phase === 'todo' && args.subPhase === undefined))
        ) {
          return errResult(
            new Error(
              'Draft approval is a human gate. Ask the user to click "审校通过 → Ready" in the Agy Board UI instead of approving an AI draft over MCP.',
            ),
          )
        }
        const task = service.transitionPhase(args.taskId, args.phase as TaskPhase, {
          subPhase: args.subPhase as TaskSubPhase | undefined,
          blockedReason: args.blockedReason,
          nextAction: args.nextAction,
          force: args.force,
          source: 'mcp',
        })
        return textResult({ ok: true, task: summarizeTask(task) }, { ok: true, task })
      } catch (err) {
        return errResult(err)
      }
    },
  )

  server.tool(
    'board_plan_breakdown',
    'Break down a task (existing taskId or new title+workspace) into structured lightweight subgoals with dependency checks and planRevision tracking.',
    {
      taskId: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      workspaceId: z.string().optional(),
      workspacePath: z.string().optional(),
      replace: z.boolean().optional(),
      subgoals: z
        .array(
          z.object({
            id: z.string().optional(),
            title: z.string().min(1),
            detail: z.string().optional(),
            kind: z.enum(['acceptance', 'implementation', 'review', 'custom']).optional(),
            required: z.boolean().optional(),
            dependencies: z.array(z.string()).optional(),
          }),
        )
        .min(1),
    },
    async (args) => {
      try {
        const task = service.planBreakdown(args, 'mcp')
        return textResult({ ok: true, taskId: task.id, planRevision: task.planRevision, subgoals: task.subgoals, rollup: task.subgoalRollup })
      } catch (err) {
        return errResult(err)
      }
    },
  )

  server.tool(
    'plan_to_board',
    'Materialize a structured plan onto Agy Board (create or update task with priority, dueAt, tags, refs, freeze snapshot, and subgoal breakdown).',
    {
      taskId: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      workspaceId: z.string().optional(),
      workspacePath: z.string().optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      dueAt: z.number().int().optional(),
      replace: z.boolean().optional(),
      tags: z
        .array(
          z.union([
            z.string().min(1),
            z.object({
              name: z.string().min(1),
              promptPrefix: z.string().optional(),
            }),
          ]),
        )
        .optional(),
      refs: z
        .array(
          z.object({
            kind: z.enum(['file', 'url', 'artifact', 'command', 'doc']).default('file'),
            target: z.string().min(1),
            label: z.string().optional(),
          }),
        )
        .optional(),
      freeze: z
        .union([
          z.string(),
          z.object({
            goal: z.string(),
            progress: z.string(),
            next: z.string(),
          }),
        ])
        .optional(),
      subgoals: z
        .array(
          z.object({
            id: z.string().optional(),
            title: z.string().min(1),
            detail: z.string().optional(),
            kind: z.enum(['acceptance', 'implementation', 'review', 'custom']).optional(),
            required: z.boolean().optional(),
            dependencies: z.array(z.string()).optional(),
          }),
        )
        .default([]),
    },
    async (args) => {
      try {
        let task: TaskRecord
        if (!args.taskId) {
          if (!args.title?.trim()) {
            return errResult(new Error('Provide either taskId or title for plan_to_board.'))
          }
          task = service.createTask(
            {
              title: args.title.trim(),
              description: args.description,
              workspaceId: args.workspaceId,
              workspacePath: args.workspacePath,
              priority: args.priority,
              dueAt: args.dueAt,
              tags: args.tags,
              refs: args.refs,
              freeze: args.freeze,
            },
            'mcp',
          )
        } else {
          task = service.getTask(args.taskId)!
          if (!task) return errResult(new Error(`No task with id '${args.taskId}'.`))
          const patch: Parameters<BoardService['updateTask']>[1] = {}
          if (args.title !== undefined && args.title.trim() && args.title.trim() !== task.title) {
            patch.title = args.title.trim()
          }
          if (args.description !== undefined && args.description.trim() !== task.description) {
            patch.description = args.description
          }
          if (args.workspaceId !== undefined) patch.workspaceId = args.workspaceId
          if (args.workspacePath !== undefined) patch.workspacePath = args.workspacePath
          if (args.priority !== undefined) patch.priority = args.priority
          if (args.dueAt !== undefined) patch.dueAt = args.dueAt
          if (args.tags !== undefined) patch.tags = args.tags
          if (args.freeze !== undefined) patch.freeze = args.freeze
          if (Object.keys(patch).length > 0) {
            task = service.updateTask(task.id, patch, 'mcp')
          }
          for (const ref of args.refs ?? []) {
            service.addTaskRef(task.id, { kind: ref.kind as TaskRefKind, target: ref.target, label: ref.label }, 'mcp')
          }
          task = service.getTask(task.id)!
        }

        if (args.subgoals.length > 0) {
          task = service.planBreakdown(
            {
              taskId: task.id,
              replace: args.replace,
              subgoals: args.subgoals,
            },
            'mcp',
          )
        }

        return textResult({
          ok: true,
          taskId: task.id,
          planRevision: task.planRevision,
          task: summarizeTask(task),
          subgoals: task.subgoals,
          rollup: task.subgoalRollup,
        })
      } catch (err) {
        return errResult(err)
      }
    },
  )

  server.tool(
    'board_subgoal_update',
    'Create, update, complete, or skip a lightweight subgoal on a task. Completing all required subgoals automatically rolls an active task into needs_you/review.',
    {
      taskId: z.string().min(1),
      subgoalId: z.string().optional(),
      title: z.string().optional(),
      detail: z.string().optional(),
      kind: z.enum(['acceptance', 'implementation', 'review', 'custom']).optional(),
      required: z.boolean().optional(),
      status: z.enum(['open', 'in_progress', 'done', 'skipped']).optional(),
      sortOrder: z.number().int().optional(),
      dependencies: z.array(z.string()).optional(),
    },
    async (args) => {
      try {
        if (!args.subgoalId) {
          if (!args.title) return errResult(new Error('title is required when creating a subgoal without subgoalId.'))
          const task = service.addSubgoal(
            args.taskId,
            {
              title: args.title,
              detail: args.detail,
              kind: args.kind,
              required: args.required,
              dependencies: args.dependencies,
            },
            'mcp',
          )
          return textResult(
            { ok: true, subgoals: task.subgoals, rollup: task.subgoalRollup, phase: task.phase },
            { ok: true, task, subgoals: task.subgoals, rollup: task.subgoalRollup, phase: task.phase },
          )
        }
        const task = service.updateSubgoal(
          args.taskId,
          args.subgoalId,
          {
            title: args.title,
            detail: args.detail,
            kind: args.kind,
            required: args.required,
            status: args.status,
            sortOrder: args.sortOrder,
            dependencies: args.dependencies,
          },
          'mcp',
        )
        return textResult(
          { ok: true, phase: task.phase, subPhase: task.subPhase, rollup: task.subgoalRollup, subgoals: task.subgoals },
          { ok: true, task, phase: task.phase, subPhase: task.subPhase, rollup: task.subgoalRollup, subgoals: task.subgoals },
        )
      } catch (err) {
        return errResult(err)
      }
    },
  )

  server.tool(
    'board_comment_add',
    'Append a markdown progress comment onto an Agy Board task.',
    {
      taskId: z.string().min(1),
      bodyMd: z.string().min(1),
      author: z.string().optional(),
    },
    async (args) => {
      try {
        const res = service.addTaskComment(args.taskId, { author: args.author ?? 'agent', bodyMd: args.bodyMd }, 'mcp')
        return textResult({ ok: true, comment: res.comment, totalComments: res.task.comments?.length ?? 0 })
      } catch (err) {
        return errResult(err)
      }
    },
  )

  server.tool(
    'board_ref_add',
    'Register a read-only TaskSpace deliverable or context pointer (file, url, artifact, command, doc) on a task/subgoal.',
    {
      taskId: z.string().min(1),
      kind: z.enum(['file', 'url', 'artifact', 'command', 'doc']).default('file'),
      target: z.string().min(1),
      label: z.string().optional(),
      subgoalId: z.string().optional(),
      round: z.number().int().optional(),
    },
    async (args) => {
      try {
        const res = service.addTaskRef(
          args.taskId,
          {
            kind: args.kind as TaskRefKind,
            target: args.target,
            label: args.label,
            subgoalId: args.subgoalId,
            round: args.round,
          },
          'mcp',
        )
        return textResult({ ok: true, ref: res.ref, totalRefs: res.task.refs.length })
      } catch (err) {
        return errResult(err)
      }
    },
  )

  server.tool(
    'board_dispatch',
    'Launch a new Antigravity conversation or resume/rework an existing one in the task target workspace (respects LaunchAdmissionQueue, git worktree isolation, and human permission confirmation gate).',
    {
      taskId: z.string().min(1),
      subgoalId: z.string().optional(),
      mode: z.enum(['auto', 'new', 'resume', 'rework']).default('auto'),
      conversationId: z.string().optional(),
      reworkInstructions: z.string().optional(),
      extraInstruction: z.string().optional(),
      model: z.string().optional(),
      profile: z.string().optional(),
      reasoningEffort: z.string().optional(),
      useWorktree: z.boolean().optional(),
    },
    async (args) => {
      try {
        const res = await service.dispatchTask(args.taskId, {
          subgoalId: args.subgoalId,
          mode: args.mode,
          conversationId: args.conversationId,
          reworkInstructions: args.reworkInstructions,
          extraInstruction: args.extraInstruction,
          model: args.model,
          profile: args.profile,
          reasoningEffort: args.reasoningEffort,
          useWorktree: args.useWorktree,
          source: 'mcp',
        })
        return textResult(
          {
            ok: true,
            action: res.action,
            executionId: res.executionId,
            conversationId: res.conversationId,
            phase: res.task.phase,
            worktreePath: res.task.worktreePath,
            worktreeBranch: res.task.worktreeBranch,
          },
          {
            ok: true,
            task: res.task,
            action: res.action,
            executionId: res.executionId,
            conversationId: res.conversationId,
            phase: res.task.phase,
            worktreePath: res.task.worktreePath,
            worktreeBranch: res.task.worktreeBranch,
          },
        )
      } catch (err) {
        return errResult(err)
      }
    },
  )

  server.tool(
    'board_schedule',
    'Set a task one-time reminder (reminderAt) or arm/disarm/clear a zone-aware cron, once, or after_completion schedule.',
    {
      taskId: z.string().min(1),
      reminderAt: z.number().int().nullable().optional(),
      schedule: z
        .object({
          enabled: z.boolean().optional(),
          mode: z.enum(['cron', 'once', 'after_completion']).optional(),
          cron: z.string().optional(),
          at: z.number().int().optional(),
          intervalDays: z.number().int().min(1).optional(),
          atHour: z.number().int().min(0).max(23).nullable().optional(),
          atMinute: z.number().int().min(0).max(59).nullable().optional(),
          action: z.enum(['dispatch', 'remind']).optional(),
          sessionMode: z.enum(['new', 'auto']).optional(),
          misfirePolicy: z.enum(['prompt', 'catch_up_once', 'skip']).optional(),
          overlapPolicy: z.enum(['wait_review', 'allow_replace']).optional(),
          timeZone: z.string().nullable().optional(),
          maxRuns: z.number().int().nullable().optional(),
          clear: z.boolean().optional(),
        })
        .nullable()
        .optional(),
    },
    async (args) => {
      try {
        let task: TaskRecord | undefined
        if (args.reminderAt !== undefined) {
          task = service.setTaskReminder(args.taskId, args.reminderAt, 'mcp')
        }
        if (args.schedule !== undefined) {
          task = service.setTaskSchedule(args.taskId, args.schedule, 'mcp')
        }
        if (!task) {
          return errResult(new Error('Provide reminderAt and/or schedule.'))
        }
        return textResult({ ok: true, reminderAt: task.reminderAt, schedule: task.schedule })
      } catch (err) {
        return errResult(err)
      }
    },
  )

  server.tool(
    'next_ready_task',
    'Pick the highest-priority ready task (plus its unblocked subgoals) filtered optionally by workspace or tag.',
    {
      workspacePath: z.string().optional(),
      workspaceId: z.string().optional(),
      tag: z.string().optional(),
      includeNeedsYou: z.boolean().optional(),
      includeOnHold: z.boolean().optional(),
    },
    async (args) => {
      try {
        const snap = service.getSnapshot({ includeArchived: false })
        const allowedPhases = new Set<TaskPhase>(['todo'])
        if (args.includeNeedsYou === true) allowedPhases.add('needs_you')
        if (args.includeOnHold === true) allowedPhases.add('on_hold')

        const filterProjId = args.workspacePath
          ? matchProjectIdForWorkspace(undefined, args.workspacePath, snap.workspaces)
          : undefined

        const candidates = snap.tasks.filter((t) => {
          if (t.archivedAt !== undefined || !allowedPhases.has(t.phase)) return false
          if (t.subPhase === 'permission_pending') return false
          if (requiresPermissionConfirmation(t, snap.sessionDefaultPermission)) return false
          if (args.workspaceId && t.workspaceId !== args.workspaceId) return false
          if (args.workspacePath) {
            const pMatch =
              Boolean(t.workspacePath) &&
              (isPathEqualOrInside(t.workspacePath!, args.workspacePath) ||
                isPathEqualOrInside(args.workspacePath, t.workspacePath!))
            const projMatch = filterProjId !== undefined && t.workspaceId === filterProjId
            if (!pMatch && !projMatch) return false
          }
          if (args.tag && !t.tags.some((tg) => tg.name === args.tag)) return false
          return true
        })

        if (candidates.length === 0) {
          return textResult({ ok: true, task: null, nextSubgoals: [], message: 'No ready tasks found.' })
        }

        const phaseOrder: Record<TaskPhase, number> = {
          todo: 0,
          needs_you: 1,
          on_hold: 2,
          active: 3,
          closed: 4,
        }
        candidates.sort((a, b) => {
          if (phaseOrder[a.phase] !== phaseOrder[b.phase]) return phaseOrder[a.phase] - phaseOrder[b.phase]
          if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) {
            return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
          }
          const aDue = a.dueAt ?? Number.MAX_SAFE_INTEGER
          const bDue = b.dueAt ?? Number.MAX_SAFE_INTEGER
          if (aDue !== bDue) return aDue - bDue
          if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
          return a.createdAt - b.createdAt
        })

        const best = candidates[0]
        return textResult({
          ok: true,
          task: summarizeTask(best),
          nextSubgoals: unblockedSubgoals(best.subgoals),
          candidatesCount: candidates.length,
        })
      } catch (err) {
        return errResult(err)
      }
    },
  )

  return server
}

export async function startMcpStdioServer(pathOverrides?: HostPathOverrides): Promise<void> {
  installEpipeGuard()
  const paths = resolveHostPaths(pathOverrides)
  const db = new BoardDatabase(paths.dbPath)
  releasePluginCwdLock(paths.dbPath)
  const service = new BoardService(db, paths)
  const server = createBoardMcpServer(service)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.on('exit', () => {
    try {
      db.close()
    } catch {
      // ignore
    }
  })
}

function isMainMcp(): boolean {
  if (!process.argv[1]) return false
  try {
    return (
      pathComparisonKey(realpathSync(resolve(process.argv[1]))) ===
      pathComparisonKey(realpathSync(fileURLToPath(import.meta.url)))
    )
  } catch {
    return process.argv[1].endsWith('mcp.mjs') || process.argv[1].endsWith('mcp.ts')
  }
}

if (isMainMcp()) {
  void startMcpStdioServer()
}
