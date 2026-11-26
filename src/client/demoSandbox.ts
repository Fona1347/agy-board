import {
  nextAfterCompletionAtMs,
  nextRunAtMs,
  resolveHostTimeZone,
} from '../core/schedule.ts'
import { computeSubgoalRollup } from '../core/subgoals.ts'
import {
  reconcilePhaseStatus,
  type BatchTaskAction,
  type BoardSnapshot,
  type DiscoveredConversation,
  type ExecutionOutcome,
  type ScheduleRule,
  type SubgoalKind,
  type SubgoalRecord,
  type SubgoalStatus,
  type TaskEventRecord,
  type TaskHandover,
  type TaskHandoverInput,
  type TaskPermission,
  type TaskPhase,
  type TaskPriority,
  type TaskRecord,
  type TaskRefKind,
  type TaskRefRecord,
  type TaskSubPhase,
  type WorkspaceRecord,
  type WriteGateMode,
} from '../core/types.ts'
import type {
  BoardApiSandbox,
  ClientTaskRecord,
  ConversationCleanupResult,
  ConversationGovernanceConfig,
  ScheduleMutationPatch,
  TaskCommentRecord,
  TaskDetailResponse,
  WorktreeDiffResponse,
} from './api.ts'
import type { Locale } from './i18n.ts'

export interface DemoSandboxOptions {
  now?: number
  locale?: Locale
  onMutate?: (action: string) => void
}

function cloneSubgoalRollup(subgoals: readonly SubgoalRecord[]) {
  return computeSubgoalRollup(subgoals)
}

function computeSnapshotCounts(tasks: readonly ClientTaskRecord[], now: number): BoardSnapshot['counts'] {
  let needs_you = 0
  let active = 0
  let on_hold = 0
  let todo = 0
  let closed = 0
  let archived = 0
  let dueReminders = 0

  for (const t of tasks) {
    if (t.archivedAt !== undefined) {
      archived += 1
      continue
    }
    if (t.phase === 'needs_you') needs_you += 1
    else if (t.phase === 'active') active += 1
    else if (t.phase === 'on_hold') on_hold += 1
    else if (t.phase === 'todo') todo += 1
    else if (t.phase === 'closed') closed += 1

    if (
      t.phase !== 'closed' &&
      t.userMarks?.ignoredAt === undefined &&
      ((t.reminderAt !== undefined &&
        t.reminderAt <= now &&
        (t.remindedAt === undefined || t.remindedAt < t.reminderAt)) ||
        (t.phase === 'needs_you' && t.subPhase === 'reminder_due'))
    ) {
      dueReminders += 1
    }
  }

  return { needs_you, active, on_hold, todo, closed, archived, dueReminders }
}

function buildInitialData(now: number, locale: Locale): {
  snapshot: BoardSnapshot
  eventsByTask: Map<string, TaskEventRecord[]>
} {
  const zh = locale === 'zh'
  const timeZone = resolveHostTimeZone()

  const workspaces: WorkspaceRecord[] = [
    {
      id: 'demo-ws-board',
      name: 'Agy Board',
      rootPath: 'E:\\demo\\agy-board',
      folderPaths: ['E:\\demo\\agy-board'],
      antigravityProjectId: 'demo-ws-board',
      source: 'antigravity',
      pinned: true,
      lastUsedAt: now - 5 * 60_000,
      createdAt: now - 14 * 86_400_000,
    },
    {
      id: 'demo-ws-research',
      name: 'Research Lab',
      rootPath: 'E:\\demo\\research-lab',
      folderPaths: ['E:\\demo\\research-lab', 'E:\\demo\\research-lab\\papers'],
      antigravityProjectId: 'demo-ws-research',
      source: 'antigravity',
      lastUsedAt: now - 35 * 60_000,
      createdAt: now - 10 * 86_400_000,
    },
    {
      id: 'demo-ws-infra',
      name: 'Cloud Gateway',
      rootPath: 'E:\\demo\\cloud-gateway',
      folderPaths: ['E:\\demo\\cloud-gateway'],
      antigravityProjectId: 'demo-ws-infra',
      source: 'custom',
      lastUsedAt: now - 2 * 3600_000,
      createdAt: now - 7 * 86_400_000,
    },
  ]

  const recentConversations: DiscoveredConversation[] = [
    {
      conversationId: 'demo-conv-review',
      title: zh ? 'PR #42 卡片视觉收口与单元测试' : 'PR #42 card polish & unit tests',
      preview: zh ? '已完成所有必达子目标，请确认验收。' : 'All required subgoals completed and ready for review.',
      projectId: 'demo-ws-board',
      workspacePaths: ['E:\\demo\\agy-board'],
      status: 'IDLE',
      isIdle: true,
      stepCount: 14,
      lastModifiedAt: now - 12 * 60_000,
    },
    {
      conversationId: 'demo-conv-active',
      title: zh ? '重构调度队列并发控制' : 'Refactor scheduler concurrency pool',
      preview: zh ? '正在执行调度器边界用例测试...' : 'Running scheduler edge-case tests...',
      projectId: 'demo-ws-board',
      workspacePaths: ['E:\\demo\\agy-board'],
      status: 'RUNNING',
      isIdle: false,
      stepCount: 9,
      lastModifiedAt: now - 30_000,
    },
    {
      conversationId: 'demo-conv-input',
      title: zh ? '确认指数退避重试策略' : 'Clarify exponential backoff retry policy',
      preview: zh ? '请确认最大重试次数取 3 次还是 5 次。' : 'Please confirm max retries: 3 or 5 attempts.',
      projectId: 'demo-ws-infra',
      workspacePaths: ['E:\\demo\\cloud-gateway'],
      status: 'IDLE',
      isIdle: true,
      stepCount: 6,
      lastModifiedAt: now - 25 * 60_000,
    },
    {
      conversationId: 'demo-conv-perm',
      title: zh ? '执行生产索引迁移预演' : 'Run production index migration dry-run',
      preview: zh ? '需要高权限终端执行迁移脚本校验。' : 'Elevated permission required to run migration verification.',
      projectId: 'demo-ws-infra',
      workspacePaths: ['E:\\demo\\cloud-gateway'],
      status: 'IDLE',
      isIdle: true,
      stepCount: 3,
      lastModifiedAt: now - 40 * 60_000,
    },
  ]

  const mkSubgoals = (
    taskId: string,
    items: Array<{
      id: string
      title: string
      status: SubgoalStatus
      required?: boolean
      kind?: SubgoalKind
    }>,
  ): SubgoalRecord[] =>
    items.map((item, idx) => ({
      id: item.id,
      taskId,
      title: item.title,
      detail: '',
      kind: item.kind ?? 'implementation',
      required: item.required ?? true,
      status: item.status,
      sortOrder: idx,
      dependencies: [],
      addedBy: 'user',
      createdAt: now - (items.length - idx) * 600_000,
      ...(item.status === 'done' ? { closedAt: now - (items.length - idx) * 300_000 } : {}),
    }))

  const sgReminder: SubgoalRecord[] = []
  const sgPermission = mkSubgoals('demo-permission-pending', [
    {
      id: 'demo-sg-perm-1',
      title: zh ? '校验迁移 SQL 回滚脚本' : 'Validate rollback SQL script',
      status: 'done',
      kind: 'acceptance',
    },
    {
      id: 'demo-sg-perm-2',
      title: zh ? '在隔离环境执行预演检查' : 'Execute dry-run check in staging',
      status: 'open',
      kind: 'implementation',
    },
  ])
  const sgReview = mkSubgoals('demo-review', [
    {
      id: 'demo-sg-rev-1',
      title: zh ? '补齐窄屏 360px 响应式布局' : 'Polish 360px narrow pane responsive layout',
      status: 'done',
      kind: 'implementation',
    },
    {
      id: 'demo-sg-rev-2',
      title: zh ? '通过全部 Vitest 前端回归用例' : 'Pass all Vitest client regression tests',
      status: 'done',
      kind: 'acceptance',
    },
  ])
  const sgNeedsInput = mkSubgoals('demo-needs-input', [
    {
      id: 'demo-sg-inp-1',
      title: zh ? '梳理网关 502/504 超时场景' : 'Audit gateway 502/504 timeout paths',
      status: 'done',
    },
    {
      id: 'demo-sg-inp-2',
      title: zh ? '按人工决策更新重试阈值' : 'Apply chosen retry threshold',
      status: 'open',
    },
  ])
  const sgActive = mkSubgoals('demo-active', [
    {
      id: 'demo-sg-act-1',
      title: zh ? '拆分并发准入队列状态机' : 'Extract launch admission state machine',
      status: 'done',
    },
    {
      id: 'demo-sg-act-2',
      title: zh ? '补全抢占与超时清理单元测试' : 'Add preemption & timeout cleanup tests',
      status: 'in_progress',
    },
    {
      id: 'demo-sg-act-3',
      title: zh ? '输出变更摘要供人工验收' : 'Generate summary for human review',
      status: 'open',
      kind: 'review',
    },
  ])
  const sgAfterCompletion = mkSubgoals('demo-after-completion', [
    {
      id: 'demo-sg-ac-1',
      title: zh ? '抓取近 3 天 arXiv 新论文并生成摘要' : 'Fetch last 3 days arXiv papers & summarize',
      status: 'done',
      kind: 'acceptance',
    },
  ])
  const sgClosedToday = mkSubgoals('demo-closed-today', [
    {
      id: 'demo-sg-cls-1',
      title: zh ? '统一深浅双主题语义色板 token' : 'Unify dark/light semantic surface tokens',
      status: 'done',
    },
    {
      id: 'demo-sg-cls-2',
      title: zh ? '验证单文件构建产物大小' : 'Verify single-file bundle output',
      status: 'done',
      kind: 'acceptance',
    },
  ])

  const cronNextRun = nextRunAtMs('0 9 * * 1-5', now, timeZone) ?? now + 2 * 3600_000

  const tasks: ClientTaskRecord[] = [
    {
      id: 'demo-reminder-due',
      title: zh ? '确认发版前 Checklist 与灰度名单' : 'Confirm pre-release checklist & canary list',
      description: zh
        ? '定时提醒已到点：请在今天下班前核对灰度用户列表并触发预发布检查。'
        : 'Scheduled reminder is due: verify the canary user list and trigger preflight checks before EOD.',
      prompt: zh ? '核对发版 checklist 并输出摘要' : 'Verify release checklist and summarize gaps',
      phase: 'needs_you',
      subPhase: 'reminder_due',
      status: 'in_progress',
      priority: 'high',
      workspaceId: 'demo-ws-board',
      workspacePath: 'E:\\demo\\agy-board',
      workspaceLabel: 'Agy Board',
      nextAction: zh ? '确认后即可延后 1 小时或直接开始会话' : 'Snooze 1h, acknowledge, or start session',
      dueAt: now + 2 * 3600_000,
      reminderAt: now - 15 * 60_000,
      sortOrder: 0,
      writeGate: 'unlocked',
      reuseSession: true,
      tags: [{ name: 'release' }],
      planRevision: 1,
      createdAt: now - 6 * 3600_000,
      updatedAt: now - 15 * 60_000,
      subgoals: sgReminder,
      subgoalRollup: cloneSubgoalRollup(sgReminder),
      refs: [],
      conversations: [],
      executions: [],
    },
    {
      id: 'demo-permission-pending',
      title: zh ? '生产索引迁移脚本预演（需提权确认）' : 'Production index migration dry-run (Permission required)',
      description: zh
        ? '需要高于默认 `read-only` 的执行权限，等待人工在看板内点击「确认提权后启动」。'
        : 'Requires elevated permission above read-only default. Human confirmation in the board UI is required before launch.',
      prompt: 'Run migrations/2026_02_add_idx.sql in dry-run mode and report lock times.',
      phase: 'needs_you',
      subPhase: 'permission_pending',
      status: 'in_progress',
      priority: 'urgent',
      workspaceId: 'demo-ws-infra',
      workspacePath: 'E:\\demo\\cloud-gateway',
      workspaceLabel: 'Cloud Gateway',
      blockedReason: zh
        ? '请求 danger-full-access 权限以执行迁移脚本预演'
        : 'Requested danger-full-access permission for migration dry-run',
      dueAt: now + 90 * 60_000,
      sortOrder: 1,
      writeGate: 'locked',
      permission: 'danger-full-access',
      reuseSession: true,
      handover: {
        workspaceId: 'demo-ws-infra',
        mode: 'agent',
        permission: 'danger-full-access',
        references: ['migrations/2026_02_add_idx.sql', 'scripts/verify-prod.sh'],
        bundledAt: now - 20 * 60_000,
      },
      tags: [{ name: 'infra' }, { name: 'db' }],
      planRevision: 1,
      createdAt: now - 5 * 3600_000,
      updatedAt: now - 20 * 60_000,
      subgoals: sgPermission,
      subgoalRollup: cloneSubgoalRollup(sgPermission),
      refs: [
        {
          id: 'demo-ref-perm-1',
          taskId: 'demo-permission-pending',
          kind: 'file',
          target: 'migrations/2026_02_add_idx.sql',
          label: 'Migration SQL',
          addedBy: 'user',
          createdAt: now - 20 * 60_000,
        },
      ],
      conversations: [
        {
          taskId: 'demo-permission-pending',
          conversationId: 'demo-conv-perm',
          role: 'primary',
          workspaceId: 'demo-ws-infra',
          linkedAt: now - 40 * 60_000,
          title: recentConversations[3].title,
          liveStatus: 'IDLE',
          isIdle: true,
        },
      ],
      executions: [],
    },
    {
      id: 'demo-review',
      title: zh ? 'PR #42 卡片视觉收口与单元测试（待你验收）' : 'PR #42 card polish & unit tests (Ready for review)',
      description: zh
        ? 'Agent 已完成全部必达子目标并提交产物。\n\n- 优化了 360px 窄栏卡片换行\n- 补齐深浅双主题对比度验证'
        : 'Agent finished all required subgoals and attached deliverables.\n\n- Refined 360px narrow card wrapping\n- Verified dark/light theme contrast',
      prompt: 'Polish card layout for 360px sidebar and run tests.',
      phase: 'needs_you',
      subPhase: 'review',
      status: 'in_progress',
      priority: 'high',
      workspaceId: 'demo-ws-board',
      workspacePath: 'E:\\demo\\agy-board',
      workspaceLabel: 'Agy Board',
      nextAction: zh ? '预览交付物引用或点击「验收通过」' : 'Inspect deliverables or click Approve',
      dueAt: now + 3 * 3600_000,
      sortOrder: 2,
      writeGate: 'unlocked',
      permission: 'workspace-write',
      permissionConfirmedAt: now - 3 * 3600_000,
      reuseSession: true,
      tags: [{ name: 'frontend' }, { name: 'ui' }],
      planRevision: 2,
      createdAt: now - 4 * 3600_000,
      updatedAt: now - 12 * 60_000,
      subgoals: sgReview,
      subgoalRollup: cloneSubgoalRollup(sgReview),
      refs: [
        {
          id: 'demo-ref-rev-1',
          taskId: 'demo-review',
          kind: 'file',
          target: 'src/client/styles.css',
          label: 'Theme & Layout CSS',
          round: 1,
          addedBy: 'agent',
          createdAt: now - 15 * 60_000,
        },
        {
          id: 'demo-ref-rev-2',
          taskId: 'demo-review',
          kind: 'command',
          target: 'npm run check',
          label: 'Full build & test check',
          round: 1,
          addedBy: 'agent',
          createdAt: now - 12 * 60_000,
        },
        {
          id: 'demo-ref-rev-3',
          taskId: 'demo-review',
          kind: 'url',
          target: 'https://example.com/pr/42',
          label: 'Preview Link',
          addedBy: 'user',
          createdAt: now - 2 * 3600_000,
        },
      ],
      conversations: [
        {
          taskId: 'demo-review',
          conversationId: 'demo-conv-review',
          role: 'primary',
          workspaceId: 'demo-ws-board',
          linkedAt: now - 3 * 3600_000,
          title: recentConversations[0].title,
          liveStatus: 'IDLE',
          isIdle: true,
        },
      ],
      executions: [
        {
          id: 'demo-exec-rev-1',
          taskId: 'demo-review',
          conversationId: 'demo-conv-review',
          workspaceId: 'demo-ws-board',
          startedAt: now - 55 * 60_000,
          endedAt: now - 12 * 60_000,
          result: 'succeeded',
          summary: zh
            ? '已完成 360px 窄栏适配与 12 项 UI 用例验证，全部通过。'
            : 'Completed 360px narrow pane styling and verified 12 UI regression tests.',
          initiatedBy: 'ui',
        },
      ],
      comments: [
        {
          id: 'demo-cmt-rev-1',
          taskId: 'demo-review',
          author: 'agent',
          bodyMd: zh
            ? '已完成所有必达步骤，建议在**深色/浅色主题**下抽查窄栏横幅换行效果。'
            : 'All required subgoals are done. Suggested spot-check: narrow banner wrapping in both **dark & light** themes.',
          createdAt: now - 12 * 60_000,
        },
      ],
    },
    {
      id: 'demo-needs-input',
      title: zh ? '网关熔断与重试退避策略待确认' : 'Gateway retry backoff policy needs decision',
      description: zh
        ? 'Agent 梳理了超时路径，但在最大重试次数与幂等白名单处停下等待人工拍板。'
        : 'Agent audited timeout paths and paused to ask for human guidance on max retry count and idempotency allowlist.',
      prompt: 'Update retry middleware once user confirms max attempts.',
      phase: 'needs_you',
      subPhase: 'needs_input',
      status: 'in_progress',
      priority: 'high',
      workspaceId: 'demo-ws-infra',
      workspacePath: 'E:\\demo\\cloud-gateway',
      workspaceLabel: 'Cloud Gateway',
      blockedReason: zh
        ? '请确认上游 504 超时最大重试次数（3 次 vs 5 次）及是否包含 POST'
        : 'Confirm max retries on 504 (3 vs 5) and whether POST endpoints are eligible',
      dueAt: now + 5 * 3600_000,
      sortOrder: 3,
      writeGate: 'unlocked',
      reuseSession: true,
      tags: [{ name: 'infra' }, { name: 'api' }],
      planRevision: 1,
      createdAt: now - 3 * 3600_000,
      updatedAt: now - 25 * 60_000,
      subgoals: sgNeedsInput,
      subgoalRollup: cloneSubgoalRollup(sgNeedsInput),
      refs: [],
      conversations: [
        {
          taskId: 'demo-needs-input',
          conversationId: 'demo-conv-input',
          role: 'primary',
          workspaceId: 'demo-ws-infra',
          linkedAt: now - 25 * 60_000,
          title: recentConversations[2].title,
          liveStatus: 'IDLE',
          isIdle: true,
        },
      ],
      executions: [],
    },
    {
      id: 'demo-after-completion',
      title: zh ? 'arXiv 领域追踪简报（验收后每 3 天循环）' : 'arXiv literature digest (Review +3d cycle)',
      description: zh
        ? '配置为 `after_completion` 循环规则：本轮验收通过后自动安排 3 天后下一轮调研。'
        : 'Configured with `after_completion` schedule: accepting this round automatically schedules the next cycle in 3 days.',
      prompt: 'Gather recent papers and update digest markdown.',
      phase: 'needs_you',
      subPhase: 'review',
      status: 'in_progress',
      priority: 'normal',
      workspaceId: 'demo-ws-research',
      workspacePath: 'E:\\demo\\research-lab\\papers',
      workspaceLabel: 'Research Lab / papers',
      nextAction: zh ? '点击「验收本轮」自动排期下一轮' : 'Click Accept Round to schedule next cycle',
      sortOrder: 4,
      writeGate: 'unlocked',
      reuseSession: true,
      schedule: {
        enabled: true,
        mode: 'after_completion',
        intervalDays: 3,
        atHour: 9,
        atMinute: 30,
        timeZone,
        runCount: 2,
        lastTriggeredAt: now - 3 * 86_400_000,
        action: 'dispatch',
        sessionMode: 'new',
        misfirePolicy: 'prompt',
        overlapPolicy: 'wait_review',
      },
      tags: [{ name: 'research' }, { name: 'recurring' }],
      planRevision: 1,
      createdAt: now - 8 * 86_400_000,
      updatedAt: now - 18 * 60_000,
      subgoals: sgAfterCompletion,
      subgoalRollup: cloneSubgoalRollup(sgAfterCompletion),
      refs: [
        {
          id: 'demo-ref-ac-1',
          taskId: 'demo-after-completion',
          kind: 'doc',
          target: 'digests/weekly-notes.md',
          label: 'Digest Notes',
          addedBy: 'agent',
          createdAt: now - 18 * 60_000,
        },
      ],
      conversations: [],
      executions: [
        {
          id: 'demo-exec-ac-1',
          taskId: 'demo-after-completion',
          workspaceId: 'demo-ws-research',
          startedAt: now - 35 * 60_000,
          endedAt: now - 18 * 60_000,
          result: 'succeeded',
          summary: zh ? '已整理 6 篇新论文摘要至 digests/weekly-notes.md' : 'Added 6 new paper summaries to digests/weekly-notes.md',
          initiatedBy: 'scheduler',
        },
      ],
    },
    {
      id: 'demo-active',
      title: zh ? '重构调度队列并发控制与 Worktree 隔离' : 'Refactor scheduler concurrency pool & Worktree isolation',
      description: zh
        ? 'Agent 正在隔离 Worktree 中运行，正在补全并发准入抢占测试。'
        : 'Agent is actively running inside an isolated Git worktree, writing concurrency preemption tests.',
      prompt: 'Extract launch admission queue and verify worktree cleanup.',
      phase: 'active',
      subPhase: 'running',
      status: 'in_progress',
      priority: 'high',
      workspaceId: 'demo-ws-board',
      workspacePath: 'E:\\demo\\agy-board',
      workspaceLabel: 'Agy Board',
      useWorktree: true,
      worktreePath: 'E:\\demo\\.worktrees\\demo-active',
      worktreeBranch: 'agy/demo-active',
      dueAt: now + 6 * 3600_000,
      sortOrder: 0,
      writeGate: 'unlocked',
      permission: 'workspace-write',
      permissionConfirmedAt: now - 10 * 60_000,
      reuseSession: true,
      freeze: {
        goal: zh ? '重构调度准入队列并保证并发上限隔离' : 'Refactor launch admission queue with strict concurrency bounds',
        progress: zh ? '已完成状态机拆分，正在补充边界测试' : 'State machine extracted; writing edge-case tests',
        next: zh ? '运行 vitest 并提交验收' : 'Run vitest suite and submit for review',
        frozenAt: now - 8 * 60_000,
        frozenBy: 'ui',
      },
      tags: [{ name: 'core' }, { name: 'scheduler' }],
      planRevision: 2,
      createdAt: now - 2 * 3600_000,
      updatedAt: now - 4 * 60_000,
      subgoals: sgActive,
      subgoalRollup: cloneSubgoalRollup(sgActive),
      refs: [],
      conversations: [
        {
          taskId: 'demo-active',
          conversationId: 'demo-conv-active',
          role: 'primary',
          workspaceId: 'demo-ws-board',
          linkedAt: now - 5 * 60_000,
          title: recentConversations[1].title,
          liveStatus: 'RUNNING',
          isIdle: false,
        },
      ],
      executions: [
        {
          id: 'demo-exec-active',
          taskId: 'demo-active',
          conversationId: 'demo-conv-active',
          workspaceId: 'demo-ws-board',
          startedAt: now - 4 * 60_000 - 18_000,
          initiatedBy: 'ui',
          frozenAt: now - 8 * 60_000,
        },
      ],
    },
    {
      id: 'demo-on-hold',
      title: zh ? '外部模型评测基准批量回放（系统暂停）' : 'External benchmark batch replay (System paused)',
      description: zh
        ? '因上游 API 触发限流，调度器已将该任务自动移入「停住了 / On Hold」托管状态。'
        : 'Upstream API rate limit reached; scheduler automatically moved this task to On Hold.',
      prompt: 'Replay evaluation dataset once upstream quota resets.',
      phase: 'on_hold',
      subPhase: 'paused',
      status: 'in_progress',
      priority: 'normal',
      workspaceId: 'demo-ws-research',
      workspacePath: 'E:\\demo\\research-lab',
      workspaceLabel: 'Research Lab',
      blockedReason: zh
        ? '上游接口 HTTP 429 限流 · 系统已暂停等待配额恢复'
        : 'Upstream HTTP 429 rate limit · paused by system until quota resets',
      sortOrder: 0,
      writeGate: 'unlocked',
      reuseSession: true,
      tags: [{ name: 'eval' }],
      planRevision: 1,
      createdAt: now - 5 * 3600_000,
      updatedAt: now - 35 * 60_000,
      subgoals: [],
      subgoalRollup: cloneSubgoalRollup([]),
      refs: [],
      conversations: [],
      executions: [
        {
          id: 'demo-exec-hold-1',
          taskId: 'demo-on-hold',
          workspaceId: 'demo-ws-research',
          startedAt: now - 45 * 60_000,
          endedAt: now - 35 * 60_000,
          result: 'failed',
          error: 'HTTP 429 Too Many Requests',
          summary: zh ? '批次 #3 遭遇限流中断' : 'Batch #3 interrupted by rate limit',
          initiatedBy: 'scheduler',
        },
      ],
    },
    {
      id: 'demo-todo-overdue',
      title: zh ? '修复 Safari 下 Sticky 表头阴影重叠（已逾期）' : 'Fix sticky header shadow overlap in Safari (Overdue)',
      description: zh
        ? '逾期红标样式演示：截止时间早于当前时刻，在焦点时间轴置顶显示。'
        : 'Overdue DDL styling sample: due timestamp is in the past and pins near top of Focus timeline.',
      prompt: 'Inspect z-index and backdrop blur on sticky headers.',
      phase: 'todo',
      subPhase: 'ready',
      status: 'pending',
      priority: 'urgent',
      workspaceId: 'demo-ws-board',
      workspacePath: 'E:\\demo\\agy-board',
      workspaceLabel: 'Agy Board',
      dueAt: now - 2 * 3600_000,
      sortOrder: 0,
      writeGate: 'unlocked',
      reuseSession: true,
      tags: [{ name: 'bugfix' }, { name: 'ui' }],
      planRevision: 0,
      createdAt: now - 2 * 86_400_000,
      updatedAt: now - 2 * 3600_000,
      subgoals: [],
      subgoalRollup: cloneSubgoalRollup([]),
      refs: [],
      conversations: [],
      executions: [],
    },
    {
      id: 'demo-todo-today',
      title: zh ? '补充看板快捷键说明与引导文档（今日截止）' : 'Document board keyboard shortcuts & guide (Due today)',
      description: zh
        ? '今日截止 + 星标置顶演示：在看板「没开始」与焦点「今日聚焦」同步展示。'
        : 'Due-today + starred sample: visible in both Focus Today and Kanban Ready column.',
      prompt: 'Add keyboard shortcut reference section to README.',
      phase: 'todo',
      subPhase: 'ready',
      status: 'pending',
      priority: 'high',
      workspaceId: 'demo-ws-board',
      workspacePath: 'E:\\demo\\agy-board',
      workspaceLabel: 'Agy Board',
      dueAt: now + 4 * 3600_000,
      sortOrder: 1,
      writeGate: 'unlocked',
      reuseSession: true,
      userMarks: {
        taskId: 'demo-todo-today',
        pinnedAt: now - 30 * 60_000,
        updatedAt: now - 30 * 60_000,
      },
      tags: [{ name: 'docs' }, { name: 'frontend' }],
      planRevision: 0,
      createdAt: now - 86_400_000,
      updatedAt: now - 30 * 60_000,
      subgoals: [],
      subgoalRollup: cloneSubgoalRollup([]),
      refs: [],
      conversations: [],
      executions: [],
    },
    {
      id: 'demo-cron',
      title: zh ? '工作日早 09:00 依赖安全巡检（Cron 循环）' : 'Weekday 09:00 dependency audit (Cron schedule)',
      description: zh
        ? '周期定时任务样本：每个工作日 09:00 自动拉起新会话检查依赖漏洞。'
        : 'Recurring cron sample: automatically dispatches a fresh audit session every weekday at 09:00.',
      prompt: 'Run npm audit and summarize actionable advisories.',
      phase: 'todo',
      subPhase: 'ready',
      status: 'pending',
      priority: 'normal',
      workspaceId: 'demo-ws-infra',
      workspacePath: 'E:\\demo\\cloud-gateway',
      workspaceLabel: 'Cloud Gateway',
      sortOrder: 2,
      writeGate: 'unlocked',
      reuseSession: false,
      userMarks: {
        taskId: 'demo-cron',
        pinnedAt: now - 50 * 60_000,
        updatedAt: now - 50 * 60_000,
      },
      schedule: {
        enabled: true,
        mode: 'cron',
        cron: '0 9 * * 1-5',
        timeZone,
        nextRunAt: cronNextRun,
        lastTriggeredAt: now - 24 * 3600_000,
        runCount: 5,
        action: 'dispatch',
        sessionMode: 'new',
        misfirePolicy: 'prompt',
        overlapPolicy: 'wait_review',
      },
      tags: [{ name: 'security' }, { name: 'recurring' }],
      planRevision: 0,
      createdAt: now - 10 * 86_400_000,
      updatedAt: now - 3600_000,
      subgoals: [],
      subgoalRollup: cloneSubgoalRollup([]),
      refs: [],
      conversations: [],
      executions: [],
    },
    {
      id: 'demo-backlog',
      title: zh ? '探索多 Agent 协同子目标依赖图可视化' : 'Explore subgoal dependency DAG visualization',
      description: zh
        ? '想法池（Backlog）样本：在焦点视图收起于底部「待排期与远期池」，可点 ★ 加入今日聚焦。'
        : 'Backlog pool sample: tucked into the bottom Backlog & Later Pool in Focus view; star ★ to promote.',
      prompt: 'Prototype lightweight SVG dependency graph for subgoals.',
      phase: 'todo',
      subPhase: 'backlog',
      status: 'pending',
      priority: 'low',
      workspaceId: 'demo-ws-research',
      workspacePath: 'E:\\demo\\research-lab',
      workspaceLabel: 'Research Lab',
      sortOrder: 3,
      writeGate: 'unlocked',
      reuseSession: true,
      tags: [{ name: 'idea' }],
      planRevision: 0,
      createdAt: now - 4 * 86_400_000,
      updatedAt: now - 2 * 86_400_000,
      subgoals: [],
      subgoalRollup: cloneSubgoalRollup([]),
      refs: [],
      conversations: [],
      executions: [],
    },
    {
      id: 'demo-closed-today',
      title: zh ? '统一深浅双主题表面色板与对比度校准' : 'Calibrate dark/light surface palette & contrast',
      description: zh
        ? '今日已完成样本：在焦点视图归入「今日已完成」，在看板归入「已收尾 → 今天」。'
        : 'Completed today sample: grouped into Completed Today in Focus view and Today bucket in Kanban.',
      prompt: 'Audit CSS variables for light and dark themes.',
      phase: 'closed',
      subPhase: 'done',
      status: 'done',
      priority: 'normal',
      workspaceId: 'demo-ws-board',
      workspacePath: 'E:\\demo\\agy-board',
      workspaceLabel: 'Agy Board',
      sortOrder: 0,
      writeGate: 'unlocked',
      reuseSession: true,
      tags: [{ name: 'ui' }],
      planRevision: 1,
      createdAt: now - 7 * 3600_000,
      updatedAt: now - 45 * 60_000,
      completedAt: now - 45 * 60_000,
      subgoals: sgClosedToday,
      subgoalRollup: cloneSubgoalRollup(sgClosedToday),
      refs: [],
      conversations: [],
      executions: [
        {
          id: 'demo-exec-cls-1',
          taskId: 'demo-closed-today',
          workspaceId: 'demo-ws-board',
          startedAt: now - 90 * 60_000,
          endedAt: now - 45 * 60_000,
          result: 'succeeded',
          summary: zh ? '已完成双主题色板调整与构建验证' : 'Updated dual-theme tokens and verified build.',
          initiatedBy: 'ui',
        },
      ],
    },
  ]

  const eventsByTask = new Map<string, TaskEventRecord[]>()
  for (const t of tasks) {
    eventsByTask.set(t.id, [
      {
        id: `demo-evt-init-${t.id}`,
        taskId: t.id,
        kind: 'task.demo_seeded',
        source: 'ui',
        payload: { phase: t.phase, subPhase: t.subPhase },
        createdAt: t.createdAt,
      },
    ])
  }

  return {
    snapshot: {
      revision: 1,
      serverTime: now,
      timeZone,
      sessionDefaultPermission: 'read-only',
      maxConcurrentLaunches: 3,
      workspaces,
      activeWorkspacePaths: ['E:\\demo\\agy-board'],
      activeProjectId: 'demo-ws-board',
      tasks,
      recentConversations,
      counts: computeSnapshotCounts(tasks, now),
    },
    eventsByTask,
  }
}

export function createDemoSandboxSnapshot(now = Date.now(), locale: Locale = 'zh'): BoardSnapshot {
  return buildInitialData(now, locale).snapshot
}

export interface DemoSandboxController {
  api: BoardApiSandbox
  getSnapshot: () => BoardSnapshot
  reset: (now?: number, nextLocale?: Locale) => BoardSnapshot
}

export function createDemoSandboxController(options: DemoSandboxOptions = {}): DemoSandboxController {
  let locale: Locale = options.locale ?? 'zh'
  let state = buildInitialData(options.now ?? Date.now(), locale)
  let seq = 1

  const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${seq++}`

  const cloneSnapshot = (): BoardSnapshot => {
    const now = Date.now()
    const tasks = state.snapshot.tasks
    return {
      ...state.snapshot,
      serverTime: now,
      tasks: [...tasks],
      workspaces: [...state.snapshot.workspaces],
      counts: computeSnapshotCounts(tasks, now),
    }
  }

  const recordEvent = (
    taskId: string,
    kind: string,
    payload: Record<string, unknown> = {},
    extras: { subgoalId?: string; conversationId?: string } = {},
  ) => {
    const list = state.eventsByTask.get(taskId) ?? []
    list.push({
      id: nextId('demo-evt'),
      taskId,
      kind,
      source: 'ui',
      payload,
      createdAt: Date.now(),
      ...extras,
    })
    state.eventsByTask.set(taskId, list)
  }

  const bumpRevision = () => {
    state.snapshot.revision += 1
  }

  const findTaskIndex = (taskId: string): number => {
    const idx = state.snapshot.tasks.findIndex((t) => t.id === taskId)
    if (idx === -1) throw new Error(`Demo task not found: ${taskId}`)
    return idx
  }

  const updateTaskInPlace = (
    taskId: string,
    updater: (cur: ClientTaskRecord) => ClientTaskRecord,
  ): ClientTaskRecord => {
    const idx = findTaskIndex(taskId)
    const cur = state.snapshot.tasks[idx]
    const updated = updater(cur)
    state.snapshot.tasks[idx] = updated
    bumpRevision()
    return updated
  }

  const applySchedulePatch = (
    cur: ScheduleRule | undefined,
    patch: ScheduleMutationPatch | null,
    now: number,
  ): ScheduleRule | undefined => {
    if (patch === null || patch.clear) return undefined
    const mode = patch.mode ?? cur?.mode ?? 'cron'
    const timeZone =
      patch.timeZone === null
        ? undefined
        : patch.timeZone ?? cur?.timeZone ?? state.snapshot.timeZone
    const enabled = patch.enabled ?? cur?.enabled ?? true
    const cron = patch.cron ?? cur?.cron
    const at = patch.at ?? cur?.at
    const intervalDays = patch.intervalDays ?? cur?.intervalDays
    let nextRunAt = cur?.nextRunAt
    if (enabled) {
      if (mode === 'cron' && cron) {
        nextRunAt = nextRunAtMs(cron, now, timeZone)
      } else if (mode === 'once') {
        nextRunAt = at
      } else if (mode === 'after_completion') {
        nextRunAt = cur?.nextRunAt
      }
    }
    return {
      enabled,
      mode,
      ...(cron !== undefined ? { cron } : {}),
      ...(at !== undefined ? { at } : {}),
      ...(timeZone !== undefined ? { timeZone } : {}),
      ...(nextRunAt !== undefined ? { nextRunAt } : {}),
      ...(cur?.lastTriggeredAt !== undefined ? { lastTriggeredAt: cur.lastTriggeredAt } : {}),
      runCount: cur?.runCount ?? 0,
      ...(patch.maxRuns !== undefined
        ? patch.maxRuns === null
          ? {}
          : { maxRuns: patch.maxRuns }
        : cur?.maxRuns !== undefined
          ? { maxRuns: cur.maxRuns }
          : {}),
      action: patch.action ?? cur?.action ?? 'dispatch',
      sessionMode: patch.sessionMode ?? cur?.sessionMode ?? 'auto',
      misfirePolicy: patch.misfirePolicy ?? cur?.misfirePolicy ?? 'prompt',
      overlapPolicy: patch.overlapPolicy ?? cur?.overlapPolicy ?? 'wait_review',
      ...(intervalDays !== undefined ? { intervalDays } : {}),
      ...(patch.atHour !== undefined
        ? patch.atHour === null
          ? {}
          : { atHour: patch.atHour }
        : cur?.atHour !== undefined
          ? { atHour: cur.atHour }
          : {}),
      ...(patch.atMinute !== undefined
        ? patch.atMinute === null
          ? {}
          : { atMinute: patch.atMinute }
        : cur?.atMinute !== undefined
          ? { atMinute: cur.atMinute }
          : {}),
    }
  }

  const notify = (action: string) => {
    options.onMutate?.(action)
  }

  let governanceConfig: ConversationGovernanceConfig = {
    autoRename: true,
    titlePrefix: '[Board]',
    autoTag: true,
    autoGroup: true,
    conversationGroupId: 'agy-board',
    autoArchiveOnFinish: true,
  }

  const api: BoardApiSandbox = {
    async getSnapshot() {
      return cloneSnapshot()
    },

    async getRevision() {
      return {
        revision: state.snapshot.revision,
        serverTime: Date.now(),
        hostTheme: state.snapshot.hostTheme,
      }
    },

    async getTaskDetail(taskId: string): Promise<TaskDetailResponse> {
      const idx = findTaskIndex(taskId)
      const task = state.snapshot.tasks[idx]
      return {
        task,
        events: [...(state.eventsByTask.get(taskId) ?? [])],
        comments: [...(task.comments ?? [])],
      }
    },

    async listConversations(options = {}) {
      const q = options.query?.trim().toLowerCase() ?? ''
      const offset = Math.max(Math.floor(options.offset ?? 0), 0)
      const limit = Math.max(Math.floor(options.limit ?? 200), 1)
      const filtered = state.snapshot.recentConversations.filter((c) => {
        if (options.projectId && c.projectId !== options.projectId && !options.workspacePath) return false
        if (options.workspacePath) {
          const target = options.workspacePath.toLowerCase()
          const matchesPath = c.workspacePaths.some((p) => p.toLowerCase().includes(target) || target.includes(p.toLowerCase()))
          if (!matchesPath && (!options.projectId || c.projectId !== options.projectId)) return false
        }
        if (q) {
          const hay = `${c.title}\n${c.preview}\n${c.conversationId}`.toLowerCase()
          if (!hay.includes(q)) return false
        }
        return true
      })
      const conversations = filtered.slice(offset, offset + limit)
      return {
        available: true,
        conversations,
        hasMore: filtered.length > offset + limit,
      }
    },

    async registerWorkspace(input) {
      const now = Date.now()
      const cleanPath = input.rootPath.trim()
      const name = input.name?.trim() || cleanPath.split(/[\\/]/).filter(Boolean).pop() || cleanPath
      const ws: WorkspaceRecord = {
        id: nextId('demo-ws'),
        name,
        rootPath: cleanPath,
        folderPaths: [cleanPath],
        source: 'custom',
        pinned: Boolean(input.pinned),
        createdAt: now,
      }
      state.snapshot.workspaces = [...state.snapshot.workspaces, ws]
      bumpRevision()
      notify('workspace.register')
      return { workspace: ws }
    },

    async updateWorkspace(input) {
      const idx = state.snapshot.workspaces.findIndex((w) => w.id === input.workspaceId)
      if (idx === -1) throw new Error('Workspace not found')
      const cur = state.snapshot.workspaces[idx]
      const updated: WorkspaceRecord = {
        ...cur,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      }
      state.snapshot.workspaces[idx] = updated
      bumpRevision()
      notify('workspace.update')
      return { workspace: updated }
    },

    async deleteWorkspace(workspaceId) {
      state.snapshot.workspaces = state.snapshot.workspaces.filter((w) => w.id !== workspaceId)
      bumpRevision()
      notify('workspace.delete')
      return { ok: true as const }
    },

    async createTask(input) {
      const now = Date.now()
      const taskId = nextId('demo-task')
      const { phase, subPhase, status } = reconcilePhaseStatus(input.phase ?? 'todo', input.subPhase)
      const subgoals: SubgoalRecord[] = (input.subgoals ?? []).map((sg, idx) => ({
        id: nextId('demo-sg'),
        taskId,
        title: sg.title,
        detail: sg.detail ?? '',
        kind: sg.kind ?? 'implementation',
        required: sg.required ?? true,
        status: 'open',
        sortOrder: idx,
        dependencies: [],
        addedBy: 'user',
        createdAt: now,
      }))
      const ws = input.workspaceId
        ? state.snapshot.workspaces.find((w) => w.id === input.workspaceId)
        : undefined
      const handover: TaskHandover | undefined = input.handover
        ? { ...input.handover, bundledAt: now }
        : undefined
      const freeze =
        input.freeze && typeof input.freeze === 'object'
          ? { ...input.freeze, frozenAt: now, frozenBy: 'ui' }
          : undefined
      const task: ClientTaskRecord = {
        id: taskId,
        title: input.title,
        description: input.description ?? '',
        userNotes: input.userNotes ?? '',
        prompt: input.prompt ?? '',
        phase,
        subPhase,
        status,
        priority: input.priority ?? 'normal',
        workspaceId: input.workspaceId,
        workspacePath: input.workspacePath ?? ws?.rootPath,
        workspaceLabel: ws?.name ?? input.workspacePath?.split(/[\\/]/).filter(Boolean).pop(),
        nextAction: input.nextAction,
        dueAt: input.dueAt,
        reminderAt: input.reminderAt,
        sortOrder: state.snapshot.tasks.length,
        writeGate: input.writeGate ?? 'unlocked',
        mode: input.mode,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        permission: input.permission,
        reuseSession: input.reuseSession ?? true,
        useWorktree: input.useWorktree,
        freeze,
        handover,
        tags: input.tags ?? [],
        schedule: input.schedule ? applySchedulePatch(undefined, input.schedule, now) : undefined,
        planRevision: 0,
        createdAt: now,
        updatedAt: now,
        subgoals,
        subgoalRollup: cloneSubgoalRollup(subgoals),
        refs: [],
        conversations: [],
        executions: [],
        ...(input.pin ? { userMarks: { taskId, pinnedAt: now, updatedAt: now } } : {}),
      }
      state.snapshot.tasks = [task, ...state.snapshot.tasks]
      recordEvent(taskId, 'task.created', { phase, subPhase })
      bumpRevision()
      notify('task.create')
      return { task }
    },

    async updateTask(taskId, patch) {
      const now = Date.now()
      const updated = updateTaskInPlace(taskId, (cur) => {
        const next: ClientTaskRecord = { ...cur, updatedAt: now }
        if (typeof patch.title === 'string') next.title = patch.title
        if (typeof patch.description === 'string') next.description = patch.description
        if (typeof patch.userNotes === 'string') next.userNotes = patch.userNotes
        else if (patch.userNotes === null) next.userNotes = ''
        if (typeof patch.prompt === 'string') next.prompt = patch.prompt
        if (patch.priority !== undefined) next.priority = patch.priority as TaskPriority
        if (patch.nextAction !== undefined) next.nextAction = patch.nextAction ? String(patch.nextAction) : undefined
        if (patch.blockedReason !== undefined) {
          next.blockedReason = patch.blockedReason ? String(patch.blockedReason) : undefined
        }
        if (patch.dueAt !== undefined) {
          next.dueAt = patch.dueAt === null ? undefined : Number(patch.dueAt)
        }
        if (patch.writeGate !== undefined) next.writeGate = patch.writeGate as WriteGateMode
        if (patch.permission !== undefined) {
          next.permission = patch.permission ? (patch.permission as TaskPermission) : undefined
        }
        if (patch.reuseSession !== undefined) next.reuseSession = Boolean(patch.reuseSession)
        if (patch.useWorktree !== undefined) next.useWorktree = Boolean(patch.useWorktree)
        if (patch.mode !== undefined) next.mode = patch.mode ? String(patch.mode) : undefined
        if (patch.model !== undefined) next.model = patch.model ? String(patch.model) : undefined
        if (patch.reasoningEffort !== undefined) {
          next.reasoningEffort = patch.reasoningEffort ? String(patch.reasoningEffort) : undefined
        }
        if (Array.isArray(patch.tags)) next.tags = patch.tags
        if (patch.workspaceId !== undefined || patch.workspacePath !== undefined) {
          next.workspaceId = patch.workspaceId === null ? undefined : (patch.workspaceId as string | undefined)
          next.workspacePath = patch.workspacePath === null ? undefined : (patch.workspacePath as string | undefined)
          const ws = next.workspaceId
            ? state.snapshot.workspaces.find((w) => w.id === next.workspaceId)
            : undefined
          next.workspaceLabel =
            ws?.name ?? (next.workspacePath ? next.workspacePath.split(/[\\/]/).filter(Boolean).pop() : undefined)
        }
        if (patch.freeze !== undefined) {
          if (patch.freeze === null) {
            next.freeze = undefined
          } else if (typeof patch.freeze === 'object') {
            const f = patch.freeze as { goal: string; progress: string; next: string }
            next.freeze = { ...f, frozenAt: now, frozenBy: 'ui' }
          }
        }
        if (patch.handover !== undefined) {
          if (patch.handover === null) {
            next.handover = undefined
          } else if (typeof patch.handover === 'object') {
            next.handover = { ...(patch.handover as TaskHandoverInput), bundledAt: now }
          }
        }
        return next
      })
      recordEvent(taskId, 'task.updated', { keys: Object.keys(patch) })
      notify('task.update')
      return { task: updated }
    },

    async transitionTask(taskId, targetPhase, options = {}) {
      const now = Date.now()
      const updated = updateTaskInPlace(taskId, (cur) => {
        const reconciled = reconcilePhaseStatus(targetPhase, options.subPhase)
        const next: ClientTaskRecord = {
          ...cur,
          phase: reconciled.phase,
          subPhase: reconciled.subPhase,
          status: reconciled.status,
          updatedAt: now,
          ...(reconciled.phase === 'closed' ? { completedAt: cur.completedAt ?? now } : { completedAt: undefined }),
        }
        if (options.blockedReason !== undefined) {
          next.blockedReason = options.blockedReason ?? undefined
        } else if (reconciled.phase === 'closed' || reconciled.phase === 'todo') {
          next.blockedReason = undefined
        }
        if (options.nextAction !== undefined) {
          next.nextAction = options.nextAction ?? undefined
        }
        return next
      })
      recordEvent(taskId, 'task.transitioned', { phase: updated.phase, subPhase: updated.subPhase })
      notify('task.transition')
      return { task: updated }
    },

    async reorderTasks(phase: TaskPhase, orderedIds: string[]) {
      const rank = new Map(orderedIds.map((id, idx) => [id, idx]))
      state.snapshot.tasks = state.snapshot.tasks.map((t) =>
        t.phase === phase && rank.has(t.id) ? { ...t, sortOrder: rank.get(t.id)! } : t,
      )
      bumpRevision()
      notify('task.reorder')
      return { ok: true as const }
    },

    async confirmPermission(taskId) {
      const now = Date.now()
      const updated = updateTaskInPlace(taskId, (cur) => {
        const nextPhase: TaskPhase = cur.phase === 'needs_you' && cur.subPhase === 'permission_pending' ? 'todo' : cur.phase
        const reconciled = reconcilePhaseStatus(nextPhase, nextPhase === 'todo' ? 'ready' : cur.subPhase)
        return {
          ...cur,
          permissionConfirmedAt: now,
          phase: reconciled.phase,
          subPhase: reconciled.subPhase,
          status: reconciled.status,
          blockedReason: cur.subPhase === 'permission_pending' ? undefined : cur.blockedReason,
          updatedAt: now,
        }
      })
      recordEvent(taskId, 'permission.confirmed')
      notify('task.confirm_permission')
      return { task: updated }
    },

    async archiveTask(taskId) {
      const now = Date.now()
      const updated = updateTaskInPlace(taskId, (cur) => ({ ...cur, archivedAt: now, updatedAt: now }))
      recordEvent(taskId, 'task.archived')
      notify('task.archive')
      return { task: updated }
    },

    async restoreTask(taskId) {
      const now = Date.now()
      const updated = updateTaskInPlace(taskId, (cur) => ({ ...cur, archivedAt: undefined, updatedAt: now }))
      recordEvent(taskId, 'task.restored')
      notify('task.restore')
      return { task: updated }
    },

    async deleteTask(taskId) {
      state.snapshot.tasks = state.snapshot.tasks.filter((t) => t.id !== taskId)
      state.eventsByTask.delete(taskId)
      bumpRevision()
      notify('task.delete')
      return { ok: true as const }
    },

    async setMarks(taskId, marks) {
      const now = Date.now()
      const updated = updateTaskInPlace(taskId, (cur) => {
        const prev = cur.userMarks ?? { taskId, updatedAt: now }
        const nextMarks = { ...prev, updatedAt: now }
        if (marks.ack !== undefined) nextMarks.ackedAt = marks.ack ? now : undefined
        if (marks.ignore !== undefined) nextMarks.ignoredAt = marks.ignore ? now : undefined
        if (marks.pin !== undefined) nextMarks.pinnedAt = marks.pin ? now : undefined
        if (marks.snoozeUntil !== undefined) {
          nextMarks.snoozedUntil = marks.snoozeUntil === null ? undefined : marks.snoozeUntil
        }
        return { ...cur, userMarks: nextMarks, updatedAt: now }
      })
      recordEvent(taskId, 'task.marks', marks as Record<string, unknown>)
      notify('task.marks')
      return { task: updated }
    },

    async batchTasks(input) {
      const now = Date.now()
      const idSet = new Set(input.taskIds)
      const affectedIds: string[] = []
      const skippedIds: string[] = []
      const updatedTasks: TaskRecord[] = []

      if (input.action === 'delete') {
        for (const t of state.snapshot.tasks) {
          if (idSet.has(t.id)) affectedIds.push(t.id)
        }
        state.snapshot.tasks = state.snapshot.tasks.filter((t) => !idSet.has(t.id))
      } else {
        state.snapshot.tasks = state.snapshot.tasks.map((t) => {
          if (!idSet.has(t.id)) return t
          affectedIds.push(t.id)
          let next: ClientTaskRecord = { ...t, updatedAt: now }
          const prevMarks = next.userMarks ?? { taskId: t.id, updatedAt: now }
          switch (input.action as BatchTaskAction) {
            case 'pin':
              next.userMarks = { ...prevMarks, pinnedAt: now, updatedAt: now }
              break
            case 'unpin':
              next.userMarks = { ...prevMarks, pinnedAt: undefined, updatedAt: now }
              break
            case 'set_sub_phase':
              if (input.subPhase && next.phase === 'todo') {
                next.subPhase = input.subPhase
              }
              break
            case 'set_priority':
              if (input.priority) next.priority = input.priority
              break
            case 'set_workspace': {
              next.workspaceId = input.workspaceId ?? undefined
              next.workspacePath = input.workspacePath ?? undefined
              const ws = next.workspaceId
                ? state.snapshot.workspaces.find((w) => w.id === next.workspaceId)
                : undefined
              next.workspaceLabel =
                ws?.name ?? (next.workspacePath ? next.workspacePath.split(/[\\/]/).filter(Boolean).pop() : undefined)
              break
            }
            case 'archive':
              next.archivedAt = now
              break
            case 'unarchive':
              next.archivedAt = undefined
              break
            case 'close': {
              const rec = reconcilePhaseStatus('closed', 'done')
              next = { ...next, ...rec, completedAt: now }
              break
            }
          }
          updatedTasks.push(next)
          return next
        })
      }

      bumpRevision()
      notify(`task.batch.${input.action}`)
      return {
        ok: true as const,
        action: input.action,
        affectedIds,
        skippedIds,
        tasks: updatedTasks,
      }
    },

    async addComment(taskId, input) {
      const now = Date.now()
      const comment: TaskCommentRecord = {
        id: nextId('demo-cmt'),
        taskId,
        author: input.author ?? 'user',
        bodyMd: input.bodyMd,
        createdAt: now,
      }
      const updated = updateTaskInPlace(taskId, (cur) => ({
        ...cur,
        comments: [...(cur.comments ?? []), comment],
        updatedAt: now,
      }))
      recordEvent(taskId, 'comment.added', { author: comment.author })
      notify('task.comment')
      return { ok: true, task: updated, comment, comments: updated.comments }
    },

    async addSubgoal(taskId, input) {
      const now = Date.now()
      const sgId = nextId('demo-sg')
      const updated = updateTaskInPlace(taskId, (cur) => {
        const sg: SubgoalRecord = {
          id: sgId,
          taskId,
          title: input.title,
          detail: input.detail ?? '',
          kind: input.kind ?? 'implementation',
          required: input.required ?? true,
          status: 'open',
          sortOrder: cur.subgoals.length,
          dependencies: [],
          addedBy: 'user',
          createdAt: now,
        }
        const subgoals = [...cur.subgoals, sg]
        return {
          ...cur,
          subgoals,
          subgoalRollup: cloneSubgoalRollup(subgoals),
          planRevision: cur.planRevision + 1,
          updatedAt: now,
        }
      })
      recordEvent(taskId, 'subgoal.added', { title: input.title }, { subgoalId: sgId })
      notify('subgoal.add')
      return { task: updated }
    },

    async planBreakdown(input) {
      const now = Date.now()
      const updated = updateTaskInPlace(input.taskId, (cur) => {
        const base = input.replace ? [] : [...cur.subgoals]
        const added: SubgoalRecord[] = input.subgoals.map((sg, idx) => ({
          id: nextId('demo-sg'),
          taskId: input.taskId,
          title: sg.title,
          detail: sg.detail ?? '',
          kind: sg.kind ?? 'implementation',
          required: sg.required ?? true,
          status: 'open',
          sortOrder: base.length + idx,
          dependencies: [],
          addedBy: 'user',
          createdAt: now,
        }))
        const subgoals = [...base, ...added]
        return {
          ...cur,
          subgoals,
          subgoalRollup: cloneSubgoalRollup(subgoals),
          planRevision: cur.planRevision + 1,
          updatedAt: now,
        }
      })
      recordEvent(input.taskId, 'subgoal.plan_breakdown', { count: input.subgoals.length })
      notify('subgoal.breakdown')
      return { task: updated }
    },

    async updateSubgoal(taskId, subgoalId, patch) {
      const now = Date.now()
      const updated = updateTaskInPlace(taskId, (cur) => {
        const subgoals = cur.subgoals.map((sg) =>
          sg.id === subgoalId
            ? {
                ...sg,
                ...(patch.title !== undefined ? { title: patch.title } : {}),
                ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
                ...(patch.required !== undefined ? { required: patch.required } : {}),
                ...(patch.status !== undefined
                  ? {
                      status: patch.status,
                      closedAt: patch.status === 'done' || patch.status === 'skipped' ? now : undefined,
                    }
                  : {}),
                ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
              }
            : sg,
        )
        return {
          ...cur,
          subgoals,
          subgoalRollup: cloneSubgoalRollup(subgoals),
          updatedAt: now,
        }
      })
      recordEvent(taskId, 'subgoal.updated', patch as Record<string, unknown>, { subgoalId })
      notify('subgoal.update')
      return { task: updated }
    },

    async reorderSubgoals(taskId, orderedIds) {
      const now = Date.now()
      const rank = new Map(orderedIds.map((id, idx) => [id, idx]))
      const updated = updateTaskInPlace(taskId, (cur) => {
        const subgoals = [...cur.subgoals]
          .map((sg) => (rank.has(sg.id) ? { ...sg, sortOrder: rank.get(sg.id)! } : sg))
          .sort((a, b) => a.sortOrder - b.sortOrder)
        return { ...cur, subgoals, updatedAt: now }
      })
      notify('subgoal.reorder')
      return { ok: true, task: updated }
    },

    async deleteSubgoal(taskId, subgoalId) {
      const now = Date.now()
      const updated = updateTaskInPlace(taskId, (cur) => {
        const subgoals = cur.subgoals.filter((sg) => sg.id !== subgoalId)
        return {
          ...cur,
          subgoals,
          subgoalRollup: cloneSubgoalRollup(subgoals),
          updatedAt: now,
        }
      })
      recordEvent(taskId, 'subgoal.deleted', {}, { subgoalId })
      notify('subgoal.delete')
      return { task: updated }
    },

    async addRef(taskId, input) {
      const now = Date.now()
      const ref: TaskRefRecord = {
        id: nextId('demo-ref'),
        taskId,
        kind: input.kind as TaskRefKind,
        target: input.target,
        label: input.label,
        subgoalId: input.subgoalId,
        addedBy: 'user',
        createdAt: now,
      }
      const updated = updateTaskInPlace(taskId, (cur) => ({
        ...cur,
        refs: [...cur.refs, ref],
        updatedAt: now,
      }))
      recordEvent(taskId, 'ref.added', { kind: input.kind, target: input.target })
      notify('ref.add')
      return { task: updated }
    },

    async removeRef(taskId, refId) {
      const now = Date.now()
      const updated = updateTaskInPlace(taskId, (cur) => ({
        ...cur,
        refs: cur.refs.filter((r) => r.id !== refId),
        updatedAt: now,
      }))
      recordEvent(taskId, 'ref.removed', { refId })
      notify('ref.remove')
      return { task: updated }
    },

    async previewRef(taskId, refId) {
      const idx = findTaskIndex(taskId)
      const task = state.snapshot.tasks[idx]
      const ref = task.refs.find((r) => r.id === refId)
      if (!ref) return { ok: false, message: 'Demo reference not found' }
      const isUrl = ref.kind === 'url' || /^https?:\/\//i.test(ref.target)
      const content = isUrl
        ? `External URL: ${ref.target}`
        : locale === 'zh'
          ? `// [演示沙箱只读预览] ${ref.target}\n// 不会读取磁盘或修改真实文件\nexport const demoSandboxPreview = true;\n`
          : `// [Demo Sandbox Read-Only Preview] ${ref.target}\n// No disk access or workspace mutation\nexport const demoSandboxPreview = true;\n`
      return {
        ok: true,
        refId: ref.id,
        kind: ref.kind,
        target: ref.target,
        resolvedPath: isUrl ? undefined : `${task.workspacePath ?? 'E:\\demo'}\\${ref.target}`,
        isUrl,
        isBinary: false,
        language: isUrl ? 'text' : ref.target.endsWith('.css') ? 'css' : 'typescript',
        sizeBytes: content.length,
        truncated: false,
        content,
      }
    },

    async linkConversation(taskId, input) {
      const now = Date.now()
      const updated = updateTaskInPlace(taskId, (cur) => {
        const filtered = cur.conversations.filter(
          (c) => !(c.conversationId === input.conversationId && (c.subgoalId ?? '') === (input.subgoalId ?? '')),
        )
        const discovered = state.snapshot.recentConversations.find((c) => c.conversationId === input.conversationId)
        return {
          ...cur,
          conversations: [
            ...filtered,
            {
              taskId,
              conversationId: input.conversationId,
              subgoalId: input.subgoalId,
              role: input.role ?? 'primary',
              workspaceId: cur.workspaceId,
              linkedAt: now,
              title: discovered?.title ?? `Sandbox Session ${input.conversationId.slice(0, 8)}`,
              liveStatus: discovered?.status ?? 'IDLE',
              isIdle: discovered?.isIdle ?? true,
              ...(input.summary?.trim() ? { summary: input.summary.trim() } : {}),
              ...(input.includeInHandoff ? { includeInHandoff: true } : {}),
            },
          ],
          updatedAt: now,
        }
      })
      recordEvent(taskId, 'conversation.linked', { role: input.role ?? 'primary' }, { conversationId: input.conversationId })
      notify('conversation.link')
      return { task: updated }
    },

    async updateConversationMeta(taskId, input) {
      const now = Date.now()
      const updated = updateTaskInPlace(taskId, (cur) => ({
        ...cur,
        conversations: cur.conversations.map((c) =>
          c.conversationId === input.conversationId && (c.subgoalId ?? '') === (input.subgoalId ?? '')
            ? {
                ...c,
                ...(input.summary !== undefined ? { summary: input.summary === null ? undefined : input.summary } : {}),
                ...(input.includeInHandoff !== undefined ? { includeInHandoff: input.includeInHandoff } : {}),
                ...(input.role !== undefined ? { role: input.role } : {}),
              }
            : c,
        ),
        updatedAt: now,
      }))
      notify('conversation.meta')
      return { task: updated }
    },
    async unlinkConversation(taskId, conversationId, subgoalId = '') {
      const now = Date.now()
      const updated = updateTaskInPlace(taskId, (cur) => ({
        ...cur,
        conversations: cur.conversations.filter(
          (c) => !(c.conversationId === conversationId && (c.subgoalId ?? '') === subgoalId),
        ),
        updatedAt: now,
      }))
      notify('conversation.unlink')
      return { task: updated }
    },

    async dispatch(taskId, opts = {}) {
      const now = Date.now()
      const executionId = nextId('demo-exec')
      const existingConv = opts.conversationId ?? state.snapshot.tasks[findTaskIndex(taskId)].conversations.at(-1)?.conversationId
      const conversationId = opts.mode === 'new' || !existingConv ? nextId('demo-conv') : existingConv
      const updated = updateTaskInPlace(taskId, (cur) => {
        const hasConv = cur.conversations.some((c) => c.conversationId === conversationId)
        const conversations = hasConv
          ? cur.conversations.map((c) =>
              c.conversationId === conversationId ? { ...c, liveStatus: 'RUNNING', isIdle: false } : c,
            )
          : [
              ...cur.conversations,
              {
                taskId,
                subgoalId: opts.subgoalId,
                conversationId,
                role: 'primary' as const,
                workspaceId: cur.workspaceId,
                linkedAt: now,
                title: `[Demo] ${cur.title.slice(0, 32)}`,
                liveStatus: 'RUNNING',
                isIdle: false,
              },
            ]
        const execution = {
          id: executionId,
          taskId,
          subgoalId: opts.subgoalId,
          conversationId,
          workspaceId: cur.workspaceId,
          startedAt: now,
          initiatedBy: 'sandbox',
          ...(opts.reworkInstructions ? { reworkInstructions: opts.reworkInstructions } : {}),
        }
        return {
          ...cur,
          phase: 'active',
          subPhase: 'running',
          status: 'in_progress',
          blockedReason: undefined,
          useWorktree: opts.useWorktree ?? cur.useWorktree,
          conversations,
          executions: [...cur.executions, execution],
          updatedAt: now,
        }
      })
      recordEvent(
        taskId,
        'execution.simulated_dispatch',
        { mode: opts.mode ?? 'auto', executionId },
        { conversationId, subgoalId: opts.subgoalId },
      )
      notify('task.dispatch')
      return {
        ok: true as const,
        task: updated,
        executionId,
        conversationId,
        action: 'simulated',
      }
    },

    async settle(taskId, outcome: ExecutionOutcome, summaryOrOpts) {
      const now = Date.now()
      const opts = typeof summaryOrOpts === 'string' ? { summary: summaryOrOpts } : (summaryOrOpts ?? {})
      const targetPhase: TaskPhase =
        opts.targetPhase ?? (outcome === 'cancelled' ? 'closed' : 'needs_you')
      const targetSubPhase: TaskSubPhase =
        targetPhase === 'closed'
          ? outcome === 'cancelled'
            ? 'cancelled'
            : 'done'
          : targetPhase === 'needs_you'
            ? outcome === 'failed'
              ? 'blocked'
              : 'review'
            : 'ready'
      const reconciled = reconcilePhaseStatus(targetPhase, targetSubPhase)
      const updated = updateTaskInPlace(taskId, (cur) => ({
        ...cur,
        ...reconciled,
        ...(reconciled.phase === 'closed' ? { completedAt: now } : {}),
        executions: cur.executions.map((ex) =>
          ex.endedAt === undefined
            ? {
                ...ex,
                endedAt: now,
                result: outcome,
                summary: opts.summary ?? ex.summary,
              }
            : ex,
        ),
        conversations: cur.conversations.map((c) => ({ ...c, liveStatus: 'IDLE', isIdle: true })),
        updatedAt: now,
      }))
      recordEvent(taskId, 'execution.simulated_settled', { outcome, summary: opts.summary })
      notify('task.settle')
      return { task: updated }
    },

    async setReminder(taskId, reminderAt) {
      const now = Date.now()
      const updated = updateTaskInPlace(taskId, (cur) => ({
        ...cur,
        reminderAt: reminderAt === null ? undefined : reminderAt,
        remindedAt: reminderAt === null ? undefined : cur.remindedAt,
        updatedAt: now,
      }))
      recordEvent(taskId, 'reminder.updated', { reminderAt })
      notify('task.reminder')
      return { task: updated }
    },

    async setSchedule(taskId, patch) {
      const now = Date.now()
      const updated = updateTaskInPlace(taskId, (cur) => ({
        ...cur,
        schedule: applySchedulePatch(cur.schedule, patch, now),
        updatedAt: now,
      }))
      recordEvent(taskId, 'schedule.updated', { cleared: Boolean(patch?.clear) })
      notify('task.schedule')
      return { task: updated }
    },

    async completeScheduleCycle(taskId, opts = {}) {
      const now = Date.now()
      const updated = updateTaskInPlace(taskId, (cur) => {
        const sched = cur.schedule
        const nextRunAt =
          sched?.mode === 'after_completion'
            ? nextAfterCompletionAtMs(now, sched.intervalDays ?? 1, sched.timeZone, sched.atHour, sched.atMinute)
            : sched?.mode === 'cron' && sched.cron
              ? nextRunAtMs(sched.cron, now, sched.timeZone)
              : sched?.nextRunAt
        const reconciled = reconcilePhaseStatus('todo', 'ready')
        return {
          ...cur,
          ...reconciled,
          blockedReason: undefined,
          schedule: sched
            ? {
                ...sched,
                runCount: sched.runCount + 1,
                lastTriggeredAt: now,
                nextRunAt,
                skippedAt: undefined,
                skippedReason: undefined,
                missedSlotAt: undefined,
              }
            : undefined,
          updatedAt: now,
        }
      })
      recordEvent(taskId, 'schedule.cycle_completed', { note: opts.note })
      notify('schedule.complete_cycle')
      return { task: updated }
    },

    async catchUpSchedule(taskId, action) {
      const now = Date.now()
      if (action === 'run') {
        const res = await api.dispatch(taskId, { mode: 'new' })
        const updated = updateTaskInPlace(taskId, (cur) => ({
          ...cur,
          schedule: cur.schedule
            ? {
                ...cur.schedule,
                missedSlotAt: undefined,
                skippedReason: undefined,
                skippedAt: undefined,
                lastTriggeredAt: now,
              }
            : undefined,
        }))
        return { task: updated ?? res.task }
      }
      const updated = updateTaskInPlace(taskId, (cur) => ({
        ...cur,
        schedule: cur.schedule
          ? {
              ...cur.schedule,
              missedSlotAt: undefined,
              skippedReason: undefined,
              skippedAt: now,
              nextRunAt:
                cur.schedule.mode === 'cron' && cur.schedule.cron
                  ? nextRunAtMs(cur.schedule.cron, now, cur.schedule.timeZone)
                  : cur.schedule.nextRunAt,
            }
          : undefined,
        updatedAt: now,
      }))
      notify('schedule.catch_up_skip')
      return { task: updated }
    },

    async skipScheduleCycle(taskId) {
      const now = Date.now()
      const updated = updateTaskInPlace(taskId, (cur) => {
        const sched = cur.schedule
        if (!sched) return cur
        const from = sched.nextRunAt && sched.nextRunAt > now ? sched.nextRunAt : now
        const nextRunAt =
          sched.mode === 'cron' && sched.cron ? nextRunAtMs(sched.cron, from, sched.timeZone) : sched.nextRunAt
        return {
          ...cur,
          schedule: {
            ...sched,
            skippedAt: now,
            skippedReason: 'skipped',
            nextRunAt,
          },
          updatedAt: now,
        }
      })
      notify('schedule.skip_cycle')
      return { task: updated }
    },

    async runScheduleNow(taskId) {
      const res = await api.dispatch(taskId, { mode: 'new' })
      return { task: res.task }
    },

    async getWorktreeDiff(taskId): Promise<WorktreeDiffResponse> {
      const idx = findTaskIndex(taskId)
      const task = state.snapshot.tasks[idx]
      if (!task.useWorktree && !task.worktreePath) {
        return {
          ok: true,
          available: true,
          exists: false,
          clean: true,
          message: locale === 'zh' ? '沙箱样本未启用 Worktree' : 'No worktree active for this demo task',
        }
      }
      return {
        ok: true,
        available: true,
        exists: true,
        clean: false,
        hasChanges: true,
        ahead: 1,
        worktreePath: task.worktreePath ?? `E:\\demo\\.worktrees\\${task.id}`,
        branch: task.worktreeBranch ?? `agy/${task.id}`,
        baseBranch: 'main',
        stat: ' 2 files changed, 42 insertions(+), 7 deletions(-)',
        files: [
          { path: 'src/host/launch-admission.ts', status: 'M', additions: 28, deletions: 7 },
          { path: 'tests/launch-admission.test.ts', status: 'A', additions: 14, deletions: 0 },
        ],
        patch:
          'diff --git a/src/host/launch-admission.ts b/src/host/launch-admission.ts\n' +
          '--- a/src/host/launch-admission.ts\n' +
          '+++ b/src/host/launch-admission.ts\n' +
          '@@ -10,3 +10,6 @@\n' +
          '+// [Demo Sandbox] Simulated worktree diff preview\n' +
          '+export const DEMO_SANDBOX_DIFF = true\n',
      }
    },

    async cleanupWorktree(taskId) {
      const now = Date.now()
      const updated = updateTaskInPlace(taskId, (cur) => ({
        ...cur,
        worktreePath: undefined,
        worktreeBranch: undefined,
        useWorktree: false,
        updatedAt: now,
      }))
      notify('worktree.cleanup')
      return {
        ok: true,
        message: locale === 'zh' ? '演示沙箱：已模拟清理 Worktree' : 'Demo Sandbox: simulated worktree cleanup',
        task: updated,
      }
    },

    async jumpToConversation(conversationId, opts) {
      const shortId = conversationId.slice(0, 8)
      return {
        ok: true,
        message:
          locale === 'zh'
            ? `演示沙箱：已模拟${opts?.split ? '右侧分屏' : ''}打开会话 ${shortId}（不拉起真实窗口）`
            : `Demo Sandbox: simulated ${opts?.split ? 'split ' : ''}jump to ${shortId} (no real session opened)`,
      }
    },

    async getConversationGovernance() {
      return { ok: true as const, config: { ...governanceConfig } }
    },

    async updateConversationGovernance(patch) {
      governanceConfig = {
        ...governanceConfig,
        ...(typeof patch.autoRename === 'boolean' ? { autoRename: patch.autoRename } : {}),
        ...(typeof patch.titlePrefix === 'string' && patch.titlePrefix.trim()
          ? { titlePrefix: patch.titlePrefix.trim().slice(0, 40) }
          : {}),
        ...(typeof patch.autoTag === 'boolean' ? { autoTag: patch.autoTag } : {}),
        ...(typeof patch.autoGroup === 'boolean' ? { autoGroup: patch.autoGroup } : {}),
        ...(typeof patch.conversationGroupId === 'string' && patch.conversationGroupId.trim()
          ? { conversationGroupId: patch.conversationGroupId.trim().slice(0, 64) }
          : {}),
        ...(typeof patch.autoArchiveOnFinish === 'boolean'
          ? { autoArchiveOnFinish: patch.autoArchiveOnFinish }
          : {}),
      }
      notify('conversation.governance')
      return { ok: true as const, config: { ...governanceConfig }, revision: state.snapshot.revision }
    },

    async cleanupFinishedConversations(opts = {}): Promise<ConversationCleanupResult> {
      const finished = state.snapshot.tasks.filter(
        (t) =>
          (t.phase === 'closed' || t.archivedAt !== undefined) &&
          (!opts.workspaceId || t.workspaceId === opts.workspaceId),
      )
      const openConvIds = new Set<string>()
      for (const t of state.snapshot.tasks) {
        if (t.archivedAt === undefined && t.phase !== 'closed') {
          for (const c of t.conversations) openConvIds.add(c.conversationId)
        }
      }
      const candidates = new Set<string>()
      const skipped = new Set<string>()
      for (const t of finished) {
        for (const c of t.conversations) {
          if (c.role === 'origin' || c.role === 'reference') continue
          if (openConvIds.has(c.conversationId)) skipped.add(c.conversationId)
          else candidates.add(c.conversationId)
        }
        for (const ex of t.executions) {
          if (!ex.conversationId || ex.endedAt === undefined) continue
          if (openConvIds.has(ex.conversationId)) skipped.add(ex.conversationId)
          else candidates.add(ex.conversationId)
        }
      }
      const archivedIds = opts.dryRun ? [] : [...candidates]
      if (!opts.dryRun) notify('conversation.cleanup_finished')
      return {
        ok: true,
        available: true,
        dryRun: Boolean(opts.dryRun),
        scannedTasks: finished.length,
        candidateCount: candidates.size,
        archivedIds,
        skippedIds: [...skipped],
        failedIds: [],
        errors: [],
        revision: state.snapshot.revision,
      }
    },
  }

  return {
    api,
    getSnapshot: cloneSnapshot,
    reset: (now = Date.now(), nextLocale = locale) => {
      locale = nextLocale
      state = buildInitialData(now, locale)
      governanceConfig = {
        autoRename: true,
        titlePrefix: '[Board]',
        autoTag: true,
        autoGroup: true,
        conversationGroupId: 'agy-board',
        autoArchiveOnFinish: true,
      }
      return cloneSnapshot()
    },
  }
}
