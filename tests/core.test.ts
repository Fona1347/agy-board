import { describe, expect, it } from 'vitest'
import {
  FREEZE_FIELD_BYTE_LIMIT,
  REDACTED_MARKER,
  buildDispatchPrompt,
  buildReworkPrompt,
  canCloseTaskWithSubgoals,
  checkSubgoalDependencies,
  computeNextRunPreviews,
  computeSubgoalRollup,
  fileUriToPath,
  formatScheduleSummary,
  hasSlashCommandLines,
  isTaskContentFrozen,
  isValidCron,
  isValidTimeZone,
  matchProjectIdForWorkspace,
  matchWorkspaceForPath,
  nextAfterCompletionAtMs,
  nextRunAtMs,
  normalizeFsPath,
  parseCron,
  parseFreezeRequest,
  reconcilePhaseStatus,
  redactSensitive,
  requiresPermissionConfirmation,
  reusableSessionId,
  ruleToVisualSchedule,
  sanitizeFreezeSnapshot,
  sanitizeHandover,
  unblockedSubgoals,
  visualScheduleToPatch,
  zonedEpoch,
  type ScheduleRule,
  type SubgoalRecord,
  type TaskRecord,
  type WorkspaceRecord,
} from '../src/core/index.ts'

describe('core/freeze', () => {
  it('parses <<<FREEZE blocks with Chinese or English headers and redacts secrets', () => {
    const raw = `
noise before
<<<FREEZE
目标:
Ship workspace Kanban
进度:
Connected Bearer supersecret_token_12345 and sk-test1234567890
下一步:
Run tests with AKIAIOSFODNN7EXAMPLE
>>>FREEZE
`
    const res = parseFreezeRequest(raw)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.warnings).toEqual(['redacted'])
    expect(res.snapshot.goal).toBe('Ship workspace Kanban')
    expect(res.snapshot.progress).toBe(`Connected ${REDACTED_MARKER} and ${REDACTED_MARKER}`)
    expect(res.snapshot.next).toBe(`Run tests with ${REDACTED_MARKER}`)
  })

  it('parses inline <<<FREEZE section values and still rejects inline slash commands', () => {
    const inline = `<<<FREEZE\nGoal: Ship inline header\n进度：完成80%\nNext: Verify tests\n>>>FREEZE`
    const res = parseFreezeRequest(inline)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.snapshot).toEqual({
      goal: 'Ship inline header',
      progress: '完成80%',
      next: 'Verify tests',
    })

    const badInline = `<<<FREEZE\nGoal: /kill\nProgress: ok\nNext: ok\n>>>FREEZE`
    const rejected = parseFreezeRequest(badInline)
    expect(rejected.ok).toBe(false)
    if (rejected.ok) return
    expect(rejected.error.code).toBe('slash-command-line')
  })

  it('redacts PEM blocks, GitHub/GitLab/Slack/Google keys', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK\n-----END RSA PRIVATE KEY-----'
    const input = `${pem} ghp_12345678901234567890 glpat-abcdefghij12345 xoxb-123456789012 AIzaSyD12345678901234567890`
    const { text, redacted } = redactSensitive(input)
    expect(redacted).toBe(true)
    expect(text).toBe(
      `${REDACTED_MARKER} ${REDACTED_MARKER} ${REDACTED_MARKER} ${REDACTED_MARKER} ${REDACTED_MARKER}`,
    )
  })

  it('rejects slash-command lines including indented ones', () => {
    expect(hasSlashCommandLines('hello\n  /kill')).toBe(true)
    const res = sanitizeFreezeSnapshot({ goal: 'ok', progress: '  /reset', next: 'done' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('slash-command-line')
  })

  it('enforces 8 KiB UTF-8 per-field byte limit', () => {
    const over = '中'.repeat(3000) // 9000 UTF-8 bytes > 8192
    const res = sanitizeFreezeSnapshot({ goal: over, progress: 'p', next: 'n' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('field-too-large')

    const exact = 'a'.repeat(FREEZE_FIELD_BYTE_LIMIT)
    const okRes = sanitizeFreezeSnapshot({ goal: exact, progress: 'p', next: 'n' })
    expect(okRes.ok).toBe(true)
  })
})

describe('core/handover', () => {
  it('validates handover caps and permission elevation gate', () => {
    const badRefs = sanitizeHandover({ references: Array.from({ length: 33 }, (_, i) => `f${i}`) })
    expect(badRefs).toBeUndefined()

    const good = sanitizeHandover({ workspaceId: 'ws-1', permission: 'workspace-write', references: ['README.md'] })
    expect(good).toEqual({ workspaceId: 'ws-1', permission: 'workspace-write', references: ['README.md'] })

    expect(requiresPermissionConfirmation({ permission: 'read-only' }, 'read-only')).toBe(false)
    expect(requiresPermissionConfirmation({ permission: 'workspace-write' }, 'read-only')).toBe(true)
    expect(
      requiresPermissionConfirmation({ permission: 'workspace-write', permissionConfirmedAt: 1234 }, 'read-only'),
    ).toBe(false)
    expect(
      requiresPermissionConfirmation(
        {
          permission: 'read-only',
          handover: { permission: 'danger-full-access', references: [], bundledAt: 1000 },
        },
        'workspace-write',
      ),
    ).toBe(true)
  })
})

describe('core/schedule', () => {
  it('handles Vixie cron OR/AND day semantics and impossible dates', () => {
    expect(isValidCron('0 9 * * 1-5')).toBe(true)
    expect(isValidCron('5/15 * * * *')).toBe(true)
    expect(isValidCron('bad cron')).toBe(false)

    const parsed = parseCron('0 0 */2 * 1')
    expect(parsed?.dayStarred).toBe(true)
    expect(parsed?.weekdayStarred).toBe(false)

    // Feb 30 never exists
    expect(nextRunAtMs('0 0 30 2 *', Date.UTC(2026, 0, 1), 'UTC')).toBeUndefined()
    // Leap day 2028-02-29 reachable from 2026
    const leap = nextRunAtMs('0 0 29 2 *', Date.UTC(2026, 0, 1), 'UTC')
    expect(leap).toBe(Date.UTC(2028, 1, 29, 0, 0))
  })

  it('skips spring-forward DST gaps and deduplicates fall-back overlaps', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true)
    expect(isValidTimeZone('Invalid/Zone')).toBe(false)

    // America/New_York spring forward 2026-03-08 02:30 does not exist -> undefined
    expect(zonedEpoch('America/New_York', 2026, 3, 8, 2, 30)).toBeUndefined()
    // Next cron after 01:30 EST jumps over 02:30 to next day 02:30 EDT
    const next = nextRunAtMs('30 2 * * *', Date.UTC(2026, 2, 8, 6, 40), 'America/New_York')
    expect(next).toBe(zonedEpoch('America/New_York', 2026, 3, 9, 2, 30))

    // Fall back 2026-11-01 01:30 picks earlier EDT instant (-04:00 = 05:30 UTC)
    expect(zonedEpoch('America/New_York', 2026, 11, 1, 1, 30)).toBe(Date.UTC(2026, 10, 1, 5, 30))
  })

  it('computes DST-safe nextAfterCompletionAtMs, bidirectional visual-cron roundtrips, previews, and summaries', () => {
    // Normal calendar advance in Asia/Shanghai aligned to 09:00
    const baseMs = zonedEpoch('Asia/Shanghai', 2026, 5, 1, 16, 45)!
    const next3d = nextAfterCompletionAtMs(baseMs, 3, 'Asia/Shanghai', 9, 0)
    expect(next3d).toBe(zonedEpoch('Asia/Shanghai', 2026, 5, 4, 9, 0))

    // DST spring-forward gap: 2026-03-08 02:30 in America/New_York skips forward to 03:00 EDT
    const preDst = zonedEpoch('America/New_York', 2026, 3, 7, 10, 0)!
    const dstAligned = nextAfterCompletionAtMs(preDst, 1, 'America/New_York', 2, 30)
    expect(dstAligned).toBe(zonedEpoch('America/New_York', 2026, 3, 8, 3, 0))

    // Roundtrip: daily, weekdays, weekly (including Sunday 0 -> 7 normalization), monthly, after_completion, custom_cron
    const cases: Array<{ rule: ScheduleRule; expectedPreset: string; expectedCron?: string }> = [
      {
        rule: { enabled: true, mode: 'cron', cron: '15 9 * * *', timeZone: 'Asia/Shanghai', runCount: 0 },
        expectedPreset: 'daily',
        expectedCron: '15 9 * * *',
      },
      {
        rule: { enabled: true, mode: 'cron', cron: '0 9 * * 1-5', timeZone: 'Asia/Shanghai', runCount: 0 },
        expectedPreset: 'weekdays',
        expectedCron: '0 9 * * 1-5',
      },
      {
        rule: { enabled: true, mode: 'cron', cron: '30 14 * * 1,3,0', timeZone: 'Asia/Shanghai', runCount: 0 },
        expectedPreset: 'weekly',
        expectedCron: '30 14 * * 1,3,7',
      },
      {
        rule: { enabled: true, mode: 'cron', cron: '0 8 15 * *', timeZone: 'UTC', runCount: 0 },
        expectedPreset: 'monthly',
        expectedCron: '0 8 15 * *',
      },
      {
        rule: {
          enabled: true,
          mode: 'after_completion',
          intervalDays: 3,
          atHour: 9,
          atMinute: 0,
          action: 'remind',
          timeZone: 'Asia/Shanghai',
          runCount: 0,
        },
        expectedPreset: 'after_completion',
      },
      {
        rule: { enabled: true, mode: 'cron', cron: '0 */2 * * *', timeZone: 'UTC', runCount: 0 },
        expectedPreset: 'custom_cron',
        expectedCron: '0 */2 * * *',
      },
      {
        rule: { enabled: true, mode: 'cron', cron: '30 9,18 * * 1-5', timeZone: 'UTC', runCount: 0 },
        expectedPreset: 'custom_cron',
        expectedCron: '30 9,18 * * 1-5',
      },
    ]

    for (const c of cases) {
      const spec = ruleToVisualSchedule(c.rule)
      expect(spec.preset).toBe(c.expectedPreset)
      const patch = visualScheduleToPatch(spec)
      expect(patch.mode).toBe(c.rule.mode)
      if (c.expectedCron) expect(patch.cron).toBe(c.expectedCron)
      if (c.rule.mode === 'after_completion') {
        expect(patch.intervalDays).toBe(3)
        expect(patch.atHour).toBe(9)
        expect(patch.atMinute).toBe(0)
        expect(patch.action).toBe('remind')
      }
    }

    // computeNextRunPreviews
    const cronPreviews = computeNextRunPreviews(
      { enabled: true, mode: 'cron', cron: '0 9 * * *', timeZone: 'UTC', runCount: 0 },
      3,
      Date.UTC(2026, 4, 1, 8, 0),
    )
    expect(cronPreviews).toEqual([
      Date.UTC(2026, 4, 1, 9, 0),
      Date.UTC(2026, 4, 2, 9, 0),
      Date.UTC(2026, 4, 3, 9, 0),
    ])
    const relPreviews = computeNextRunPreviews(
      { enabled: true, mode: 'after_completion', intervalDays: 3, atHour: 9, atMinute: 0, timeZone: 'UTC', runCount: 0 },
      2,
      Date.UTC(2026, 4, 1, 12, 0),
    )
    expect(relPreviews).toEqual([Date.UTC(2026, 4, 4, 9, 0), Date.UTC(2026, 4, 7, 9, 0)])

    // formatScheduleSummary
    expect(
      formatScheduleSummary(
        { enabled: true, mode: 'cron', cron: '0 9 * * 1-5', timeZone: 'Asia/Shanghai', action: 'dispatch', runCount: 0 },
        'zh',
      ),
    ).toBe('工作日 09:00 · 自动拉起会话')
    expect(
      formatScheduleSummary(
        { enabled: true, mode: 'cron', cron: '0 9 * * 1,3,5', timeZone: 'Asia/Shanghai', action: 'remind', runCount: 0 },
        'zh',
      ),
    ).toBe('每周一、三、五 09:00 · 仅提醒')
    expect(
      formatScheduleSummary(
        { enabled: true, mode: 'after_completion', intervalDays: 3, atHour: 9, atMinute: 0, timeZone: 'UTC', runCount: 0 },
        'zh',
      ),
    ).toContain('验收后 +3 天 09:00')
  })
})

describe('core/subgoals & phase reconciliation', () => {
  const mkSub = (id: string, required: boolean, status: SubgoalRecord['status'], deps: string[] = []): SubgoalRecord => ({
    id,
    taskId: 't1',
    title: id,
    detail: '',
    kind: 'custom',
    required,
    status,
    sortOrder: 0,
    dependencies: deps,
    addedBy: 'user',
    createdAt: 1,
  })

  it('computes required rollup and gates closing unless forced', () => {
    const subs = [mkSub('a', true, 'done'), mkSub('b', true, 'open'), mkSub('c', false, 'open')]
    const r = computeSubgoalRollup(subs)
    expect(r.requiredTotal).toBe(2)
    expect(r.requiredDone).toBe(1)
    expect(r.readyForReview).toBe(false)
    expect(canCloseTaskWithSubgoals(subs).allowed).toBe(false)
    expect(canCloseTaskWithSubgoals(subs, true).allowed).toBe(true)

    const doneSubs = [mkSub('a', true, 'done'), mkSub('b', true, 'done'), mkSub('c', false, 'open')]
    expect(computeSubgoalRollup(doneSubs).readyForReview).toBe(true)
    expect(canCloseTaskWithSubgoals(doneSubs).allowed).toBe(true)
  })

  it('detects dependency cycles and computes unblocked subgoals', () => {
    expect(
      checkSubgoalDependencies([
        { id: 'a', dependencies: ['b'] },
        { id: 'b', dependencies: ['a'] },
      ]).ok,
    ).toBe(false)

    const subs = [mkSub('a', true, 'done'), mkSub('b', true, 'open', ['a']), mkSub('c', true, 'open', ['b'])]
    expect(unblockedSubgoals(subs).map((s) => s.id)).toEqual(['b'])
  })

  it('reconciles phase/subPhase/status canonically', () => {
    expect(reconcilePhaseStatus('todo')).toEqual({ phase: 'todo', subPhase: 'ready', status: 'pending' })
    expect(reconcilePhaseStatus('on_hold')).toEqual({ phase: 'on_hold', subPhase: 'paused', status: 'in_progress' })
    expect(reconcilePhaseStatus('closed', 'cancelled')).toEqual({
      phase: 'closed',
      subPhase: 'cancelled',
      status: 'cancelled',
    })
  })
})

describe('core/workspace & session-reuse', () => {
  const workspaces: WorkspaceRecord[] = [
    {
      id: 'proj-1',
      name: 'Projects',
      rootPath: 'E:\\workspace\\Projects',
      folderPaths: ['E:\\workspace\\Projects', 'E:\\workspace\\Tools'],
      antigravityProjectId: 'proj-1',
      source: 'antigravity',
      createdAt: 1,
    },
    {
      id: 'ws-board',
      name: 'agy-board',
      rootPath: 'E:\\workspace\\Projects\\agy-board',
      folderPaths: ['E:\\workspace\\Projects\\agy-board'],
      antigravityProjectId: 'proj-1',
      source: 'custom',
      createdAt: 2,
    },
  ]

  it('normalizes Windows file URIs and matches longest-prefix project', () => {
    expect(fileUriToPath('file:///e%3A/workspace/notes_vault')).toBe('E:\\workspace\\notes_vault')
    expect(normalizeFsPath('e:/workspace/Projects/')).toBe('E:\\workspace\\Projects')
    expect(matchWorkspaceForPath('E:\\workspace\\Projects\\agy-board\\src', workspaces)?.id).toBe('ws-board')
    expect(matchProjectIdForWorkspace(undefined, 'E:\\workspace\\Tools\\sub', workspaces)).toBe('proj-1')
  })

  it('fails closed on session reuse when idle roster is unknown', () => {
    const task: Pick<TaskRecord, 'reuseSession' | 'executions' | 'conversations'> = {
      reuseSession: true,
      executions: [{ id: 'e1', taskId: 't1', conversationId: 'conv-1', startedAt: 1, endedAt: 2, result: 'succeeded' }],
      conversations: [{ taskId: 't1', conversationId: 'conv-1', role: 'primary', linkedAt: 1 }],
    }
    expect(reusableSessionId(task, undefined)).toBeUndefined()
    expect(reusableSessionId(task, new Set(['conv-1']))).toBe('conv-1')
    expect(reusableSessionId({ ...task, reuseSession: false }, new Set(['conv-1']))).toBeUndefined()
    expect(reusableSessionId({ ...task, reuseSession: false }, new Set(['conv-1']), { force: true })).toBe('conv-1')
  })

  it('locks task content only while an execution is actively running', () => {
    expect(isTaskContentFrozen({ executions: [] })).toBe(false)
    expect(
      isTaskContentFrozen({
        executions: [{ id: 'e-pre', taskId: 't1', startedAt: 1 }],
      }),
    ).toBe(true)
    expect(
      isTaskContentFrozen({
        executions: [
          { id: 'e-fail', taskId: 't1', startedAt: 1, endedAt: 2, result: 'failed', error: 'agentapi timeout' },
          { id: 'e-cancel', taskId: 't1', startedAt: 3, endedAt: 4, result: 'cancelled' },
        ],
      }),
    ).toBe(false)
    expect(
      isTaskContentFrozen({
        executions: [{ id: 'e-active', taskId: 't1', conversationId: 'conv-1', startedAt: 5 }],
      }),
    ).toBe(true)
    expect(
      isTaskContentFrozen({
        executions: [{ id: 'e-fail-conv', taskId: 't1', conversationId: 'conv-2', startedAt: 5, endedAt: 6, result: 'failed' }],
      }),
    ).toBe(false)
    expect(
      isTaskContentFrozen({
        executions: [{ id: 'e-done', taskId: 't1', startedAt: 5, endedAt: 6, result: 'succeeded' }],
      }),
    ).toBe(false)
    expect(
      isTaskContentFrozen({
        executions: [{ id: 'e-settled-unknown', taskId: 't1', startedAt: 5, endedAt: 6 }],
      }),
    ).toBe(false)
    expect(
      isTaskContentFrozen({
        executions: [],
        freeze: { goal: 'G', progress: 'P', next: 'N', frozenAt: 10 },
      }),
    ).toBe(false)

    // Recurring schedules stay editable across rounds unless explicitly frozen
    expect(
      isTaskContentFrozen({
        executions: [{ id: 'e-done', taskId: 't1', conversationId: 'conv-1', startedAt: 5, endedAt: 6, result: 'succeeded' }],
        schedule: { enabled: true, mode: 'cron', cron: '0 9 * * 1-5', runCount: 1 },
      }),
    ).toBe(false)
    expect(
      isTaskContentFrozen({
        executions: [{ id: 'e-done', taskId: 't1', conversationId: 'conv-1', startedAt: 5, endedAt: 6, result: 'succeeded' }],
        schedule: { enabled: true, mode: 'after_completion', intervalDays: 3, runCount: 1 },
      }),
    ).toBe(false)
    expect(
      isTaskContentFrozen({
        executions: [{ id: 'e-done', taskId: 't1', conversationId: 'conv-1', startedAt: 5, endedAt: 6, result: 'succeeded' }],
        schedule: { enabled: true, mode: 'once', at: 1000, runCount: 0 },
      }),
    ).toBe(false)
  })

  it('buildDispatchPrompt includes settled execution summaries (last 5), blockedReason, distinct skipped [-] subgoals, and scoped subgoal instruction', () => {
    const task: TaskRecord = {
      id: 't-dispatch-1',
      title: 'Harden Retry Pipeline',
      description: 'Add bounded exponential backoff',
      prompt: 'Implement retry logic and tests',
      phase: 'needs_you',
      subPhase: 'blocked',
      status: 'in_progress',
      priority: 'high',
      workspacePath: 'E:\\workspace\\Projects\\alpha',
      blockedReason: 'Waiting for rate-limit threshold decision',
      nextAction: 'Verify jitter bounds',
      sortOrder: 0,
      writeGate: 'unlocked',
      reuseSession: true,
      freeze: { goal: 'Reliable retries', progress: 'Added core helper', next: 'Wire into HTTP client', frozenAt: 100 },
      handover: { references: ['README.md', 'docs/spec.md'], bundledAt: 100 },
      tags: [{ name: 'resilience', promptPrefix: 'Always preserve idempotency.' }],
      planRevision: 1,
      createdAt: 1,
      updatedAt: 2,
      subgoals: [
        {
          id: 'sg-done',
          taskId: 't-dispatch-1',
          title: 'Design backoff formula',
          detail: '',
          kind: 'acceptance',
          required: true,
          status: 'done',
          sortOrder: 0,
          dependencies: [],
          addedBy: 'user',
          createdAt: 1,
        },
        {
          id: 'sg-prog',
          taskId: 't-dispatch-1',
          title: 'Wire retry helper',
          detail: '',
          kind: 'implementation',
          required: true,
          status: 'in_progress',
          sortOrder: 1,
          dependencies: [],
          addedBy: 'user',
          createdAt: 2,
        },
        {
          id: 'sg-skip',
          taskId: 't-dispatch-1',
          title: 'Legacy XML fallback',
          detail: '',
          kind: 'custom',
          required: false,
          status: 'skipped',
          sortOrder: 2,
          dependencies: [],
          addedBy: 'user',
          createdAt: 3,
        },
        {
          id: 'sg-open',
          taskId: 't-dispatch-1',
          title: 'Write unit tests',
          detail: '',
          kind: 'review',
          required: true,
          status: 'open',
          sortOrder: 3,
          dependencies: [],
          addedBy: 'user',
          createdAt: 4,
        },
      ],
      subgoalRollup: {
        total: 4,
        done: 1,
        inProgress: 1,
        open: 1,
        skipped: 1,
        requiredTotal: 3,
        requiredDone: 1,
        requiredRemaining: 2,
        allRequiredDone: false,
        readyForReview: false,
      },
      refs: [{ id: 'r1', taskId: 't-dispatch-1', kind: 'file', target: 'README.md', label: 'Docs', addedBy: 'user', createdAt: 1 }],
      originConversationId: 'conv-origin',
      originSummary: 'Found while auditing retry middleware',
      discoveredFromTaskId: 't-parent',
      conversations: [
        {
          taskId: 't-dispatch-1',
          conversationId: 'conv-origin',
          role: 'origin',
          linkedAt: 1,
          summary: 'Origin decision: retries stay idempotent',
          includeInHandoff: true,
        },
        {
          taskId: 't-dispatch-1',
          conversationId: 'conv-noise',
          role: 'worker',
          linkedAt: 2,
          summary: 'Scratch attempt, not promoted',
        },
      ],
      executions: [
        { id: 'ex-empty', taskId: 't-dispatch-1', startedAt: 1, endedAt: 2, result: 'succeeded' },
        { id: 'ex-0', taskId: 't-dispatch-1', startedAt: 3, endedAt: 4, result: 'succeeded', summary: 'Old summary 0 (should be truncated)' },
        { id: 'ex-1', taskId: 't-dispatch-1', startedAt: 5, endedAt: 6, result: 'succeeded', summary: 'Summary 1' },
        { id: 'ex-2', taskId: 't-dispatch-1', startedAt: 7, endedAt: 8, result: 'failed', error: 'Timeout error 2' },
        { id: 'ex-3', taskId: 't-dispatch-1', startedAt: 9, endedAt: 10, result: 'succeeded', reworkInstructions: 'Rework 3', summary: 'Summary 3' },
        { id: 'ex-4', taskId: 't-dispatch-1', startedAt: 11, endedAt: 12, result: 'succeeded', summary: 'Summary 4' },
        { id: 'ex-5', taskId: 't-dispatch-1', startedAt: 13, endedAt: 14, result: 'succeeded', summary: 'Summary 5' },
        { id: 'ex-open', taskId: 't-dispatch-1', startedAt: 15, summary: 'Open execution should be omitted' },
      ],
      comments: [{ id: 'c1', taskId: 't-dispatch-1', author: 'reviewer', bodyMd: 'Check jitter cap', createdAt: 15 }],
    }

    const prompt = buildDispatchPrompt(task, { extraInstruction: 'Report exact coverage.' })
    expect(prompt).toContain('Always preserve idempotency.')
    expect(prompt).toContain('## Origin / Discovered From')
    expect(prompt).toContain('Why captured: Found while auditing retry middleware')
    expect(prompt).toContain('Discovered from task: t-parent')
    expect(prompt).toContain('## Handoff Conclusions (★ included)')
    expect(prompt).toContain('(origin) conv-origin: Origin decision: retries stay idempotent')
    expect(prompt).not.toContain('Scratch attempt, not promoted')
    expect(prompt).toContain('## Blocked / Status Note\nWaiting for rate-limit threshold decision')
    expect(prompt).toContain('- [x] (sg-done) Design backoff formula [required]')
    expect(prompt).toContain('- [~] (sg-prog) Wire retry helper [required]')
    expect(prompt).toContain('- [-] (sg-skip) Legacy XML fallback [optional]')
    expect(prompt).toContain('- [ ] (sg-open) Write unit tests [required]')
    expect(prompt).toContain('## Prior Executions')
    expect(prompt).not.toContain('Old summary 0')
    expect(prompt).not.toContain('Open execution should be omitted')
    expect(prompt).toContain('#1 (succeeded) | Summary: Summary 1')
    expect(prompt).toContain('#2 (failed) | Error: Timeout error 2')
    expect(prompt).toContain('#3 (succeeded) | Rework: Rework 3 | Summary: Summary 3')
    expect(prompt).toContain('#5 (succeeded) | Summary: Summary 5')
    expect(prompt).toContain('## Comments\n- [reviewer] Check jitter cap')
    expect(prompt).toContain('- [file] README.md (Docs)')
    expect(prompt).toContain('- [handover] docs/spec.md')
    expect(prompt).toContain('## Additional Instructions\nReport exact coverage.')

    const scopedWithDetail = buildDispatchPrompt(task, {
      subgoal: { ...task.subgoals[1], detail: 'Integrate jitter into fetch wrapper' },
    })
    expect(scopedWithDetail).toContain('Scoped Subgoal (sg-prog): Wire retry helper')
    expect(scopedWithDetail).toContain('## Execution Instruction\nIntegrate jitter into fetch wrapper')

    const scopedFallbackTitle = buildDispatchPrompt(task, { subgoal: task.subgoals[3] })
    expect(scopedFallbackTitle).toContain('Scoped Subgoal (sg-open): Write unit tests')
    expect(scopedFallbackTitle).toContain('## Execution Instruction\nWrite unit tests')
  })

  it('buildReworkPrompt includes worktreePath, worktreeBranch, scoped subgoal, and refs', () => {
    const baseTask: TaskRecord = {
      id: 't-wt-1',
      title: 'Isolated Bugfix',
      description: '',
      prompt: '',
      phase: 'needs_you',
      subPhase: 'needs_input',
      status: 'in_progress',
      priority: 'normal',
      sortOrder: 0,
      writeGate: 'unlocked',
      reuseSession: true,
      tags: [],
      planRevision: 0,
      createdAt: 1,
      updatedAt: 1,
      subgoals: [],
      subgoalRollup: computeSubgoalRollup([]),
      refs: [{ id: 'r1', taskId: 't-wt-1', kind: 'file', target: 'src/retry.ts', addedBy: 'hook', createdAt: 1 }],
      conversations: [],
      executions: [],
      useWorktree: true,
      worktreePath: 'E:\\repo\\.worktrees\\agy-board-t-wt-1',
      worktreeBranch: 'agy-board/t-wt-1',
    }
    const subgoal: SubgoalRecord = {
      id: 'sg-9',
      taskId: 't-wt-1',
      title: 'Fix edge case',
      detail: '',
      kind: 'implementation',
      required: true,
      status: 'in_progress',
      sortOrder: 0,
      dependencies: [],
      addedBy: 'user',
      createdAt: 1,
    }

    const withBranch = buildReworkPrompt(baseTask, '  Handle HTTP 429 Retry-After header.  ', subgoal)
    expect(withBranch).toContain('[Rework Request for Task t-wt-1: Isolated Bugfix]')
    expect(withBranch).toContain('Worktree: E:\\repo\\.worktrees\\agy-board-t-wt-1 (branch: agy-board/t-wt-1)')
    expect(withBranch).toContain('Subgoal (sg-9): Fix edge case')
    expect(withBranch).toContain('Handle HTTP 429 Retry-After header.')
    expect(withBranch).toContain('Registered references:\n- [file] src/retry.ts')

    const withoutBranch = buildReworkPrompt({ ...baseTask, worktreeBranch: undefined, refs: [] }, 'Retry clean')
    expect(withoutBranch).toContain('Worktree: E:\\repo\\.worktrees\\agy-board-t-wt-1')
    expect(withoutBranch).not.toContain('(branch:')
    expect(withoutBranch).not.toContain('Registered references:')

    const withoutWorktree = buildReworkPrompt({ ...baseTask, worktreePath: undefined, worktreeBranch: undefined }, 'Plain rework')
    expect(withoutWorktree).not.toContain('Worktree:')
  })
})
