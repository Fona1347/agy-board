import { describe, expect, it } from 'vitest'
import type { TaskRecord } from '../src/core/types.ts'
import { formatCreatedStamp, sortTasksByDeadline } from '../src/client/utils.ts'
import {
  classifyScheduleBucket,
  classifyStatusBucket,
  computeSnoozeTarget,
  endOfLocalDay,
  filterKanbanTasks,
  formatElapsedTimer,
  isFocusPrimaryTask,
  isFocusTodayTodo,
  partitionFocusTasks,
  sortListTasks,
  startOfLocalDay,
} from '../src/client/viewFilters.ts'

function mkTask(overrides: Partial<TaskRecord> & { id: string; title: string }): TaskRecord {
  const now = 1_780_000_000_000
  return {
    description: '',
    prompt: '',
    phase: 'todo',
    subPhase: 'ready',
    status: 'pending',
    priority: 'normal',
    sortOrder: 0,
    writeGate: 'unlocked',
    reuseSession: true,
    tags: [],
    planRevision: 0,
    createdAt: now - 10_000,
    updatedAt: now - 5_000,
    subgoals: [],
    subgoalRollup: {
      total: 0,
      done: 0,
      inProgress: 0,
      open: 0,
      skipped: 0,
      requiredTotal: 0,
      requiredDone: 0,
      requiredRemaining: 0,
      allRequiredDone: true,
      readyForReview: false,
    },
    refs: [],
    conversations: [],
    executions: [],
    ...overrides,
  }
}

describe('Three-view pure filtering, grouping & sorting logic', () => {
  it('enforces Focus horizon admission (48h DDL, urgent, pinnedAt, today schedule, auto-unsnooze expiry, and Quiet Pool)', () => {
    const now = new Date(2026, 6, 15, 14, 0, 0).getTime()
    const sod = startOfLocalDay(now)
    const eod = endOfLocalDay(now)

    const tNeeds = mkTask({ id: 't-needs', title: 'Needs', phase: 'needs_you', subPhase: 'review', status: 'in_progress' })
    const tSnoozedNeeds = mkTask({
      id: 't-snoozed-needs',
      title: 'Snoozed Needs',
      phase: 'needs_you',
      subPhase: 'needs_input',
      status: 'in_progress',
      userMarks: { taskId: 't-snoozed-needs', snoozedUntil: now + 3_600_000, updatedAt: now },
    })
    const tExpiredSnooze = mkTask({
      id: 't-expired-snooze',
      title: 'Expired Snooze',
      phase: 'todo',
      priority: 'urgent',
      userMarks: { taskId: 't-expired-snooze', snoozedUntil: now - 1000, updatedAt: now },
    })
    const tDue48h = mkTask({ id: 't-48h', title: 'Due 48h', dueAt: now + 48 * 3600_000 })
    const tDue72h = mkTask({ id: 't-72h', title: 'Due 72h', dueAt: now + 72 * 3600_000 })
    const tPinned = mkTask({
      id: 't-pinned',
      title: 'Pinned Someday',
      subPhase: 'backlog',
      userMarks: { taskId: 't-pinned', pinnedAt: now - 100, updatedAt: now },
    })
    const tTodaySched = mkTask({
      id: 't-sched-today',
      title: 'Today Sched',
      schedule: { enabled: true, mode: 'cron', cron: '0 18 * * *', nextRunAt: eod - 60_000, runCount: 0 },
    })
    const tFutureSched = mkTask({
      id: 't-sched-future',
      title: 'Future Sched',
      schedule: { enabled: true, mode: 'cron', cron: '0 9 * * *', nextRunAt: eod + 3_600_000, runCount: 0 },
    })
    const tSomeday = mkTask({ id: 't-someday', title: 'Undated Someday' })
    const tClosedToday = mkTask({
      id: 't-closed-today',
      title: 'Closed Today',
      phase: 'closed',
      subPhase: 'done',
      status: 'done',
      completedAt: sod + 1000,
    })
    const tClosedYest = mkTask({
      id: 't-closed-yest',
      title: 'Closed Yesterday',
      phase: 'closed',
      subPhase: 'done',
      status: 'done',
      completedAt: sod - 1000,
    })
    const tIgnored = mkTask({
      id: 't-ignored',
      title: 'Ignored',
      priority: 'urgent',
      userMarks: { taskId: 't-ignored', ignoredAt: now - 100, updatedAt: now },
    })

    expect(isFocusPrimaryTask(tNeeds, now)).toBe(true)
    expect(isFocusPrimaryTask(tSnoozedNeeds, now)).toBe(false)
    expect(isFocusPrimaryTask(tExpiredSnooze, now)).toBe(true)
    expect(isFocusTodayTodo(tDue48h, now)).toBe(true)
    expect(isFocusTodayTodo(tDue72h, now)).toBe(false)
    expect(isFocusTodayTodo(tPinned, now)).toBe(true)
    expect(isFocusTodayTodo(tTodaySched, now)).toBe(true)
    expect(isFocusTodayTodo(tFutureSched, now)).toBe(false)
    expect(isFocusTodayTodo(tSomeday, now)).toBe(false)
    expect(isFocusPrimaryTask(tClosedToday, now)).toBe(true)
    expect(isFocusPrimaryTask(tClosedYest, now)).toBe(false)
    expect(isFocusPrimaryTask(tIgnored, now)).toBe(false)

    const part = partitionFocusTasks(
      [
        tNeeds,
        tSnoozedNeeds,
        tExpiredSnooze,
        tDue48h,
        tDue72h,
        tPinned,
        tTodaySched,
        tFutureSched,
        tSomeday,
        tClosedToday,
        tClosedYest,
        tIgnored,
      ],
      now,
    )
    expect(part.needsYou.map((t) => t.id)).toEqual(['t-needs'])
    expect(part.todayTodos.map((t) => t.id)).toEqual(['t-48h', 't-expired-snooze', 't-pinned', 't-sched-today'])
    expect(part.todayClosed.map((t) => t.id)).toEqual(['t-closed-today'])
    expect(part.quietPool.map((t) => t.id)).toEqual(['t-72h', 't-snoozed-needs', 't-sched-future', 't-someday'])
    expect(part.ignored.map((t) => t.id)).toEqual(['t-ignored'])

    const tonight = computeSnoozeTarget('tonight', now)
    expect(tonight).toBeGreaterThan(now)
    expect(new Date(tonight).getHours()).toBe(20)
    const nextMon = computeSnoozeTarget('nextMonday', now)
    expect(new Date(nextMon).getDay()).toBe(1)
    expect(new Date(nextMon).getHours()).toBe(9)
  })

  it('filters Kanban scope (excludes ignored, backlog, future-only schedules, >7d closed) and formats elapsed timer', () => {
    const now = new Date(2026, 6, 15, 14, 0, 0).getTime()
    const eod = endOfLocalDay(now)

    const kReady = mkTask({ id: 'k-ready', title: 'Ready', subPhase: 'ready' })
    const kBacklog = mkTask({ id: 'k-backlog', title: 'Backlog', subPhase: 'backlog' })
    const kFutureSched = mkTask({
      id: 'k-future-sched',
      title: 'Future Sched',
      schedule: { enabled: true, mode: 'cron', cron: '0 9 * * 1', nextRunAt: eod + 86_400_000, runCount: 0 },
    })
    const kFutureSchedPinned = mkTask({
      id: 'k-future-pinned',
      title: 'Future Sched Pinned',
      userMarks: { taskId: 'k-future-pinned', pinnedAt: now, updatedAt: now },
      schedule: { enabled: true, mode: 'cron', cron: '0 9 * * 1', nextRunAt: eod + 86_400_000, runCount: 0 },
    })
    const kIgnored = mkTask({
      id: 'k-ignored',
      title: 'Ignored',
      phase: 'active',
      subPhase: 'running',
      userMarks: { taskId: 'k-ignored', ignoredAt: now - 500, updatedAt: now },
    })
    const kClosedRecent = mkTask({
      id: 'k-closed-3d',
      title: 'Closed 3d',
      phase: 'closed',
      subPhase: 'done',
      completedAt: now - 3 * 86_400_000,
    })
    const kClosedOld = mkTask({
      id: 'k-closed-20d',
      title: 'Closed 20d',
      phase: 'closed',
      subPhase: 'done',
      completedAt: now - 20 * 86_400_000,
    })

    const res = filterKanbanTasks(
      [kReady, kBacklog, kFutureSched, kFutureSchedPinned, kIgnored, kClosedRecent, kClosedOld],
      now,
    )
    expect(res.active).toHaveLength(0)
    expect(res.readyTodos.map((t) => t.id)).toEqual(['k-ready', 'k-future-pinned'])
    expect(res.backlogCount).toBe(1)
    expect(res.scheduledFutureCount).toBe(1)
    expect(res.recentClosed.map((t) => t.id)).toEqual(['k-closed-3d'])
    expect(res.olderClosedCount).toBe(1)

    expect(formatElapsedTimer(now - 65_000, now)).toBe('01:05')
    expect(formatElapsedTimer(now - 3_665_000, now)).toBe('1:01:05')
  })

  it('classifies List 4-way status/schedule buckets and sorts by updated/due/priority/created', () => {
    const now = 1_780_000_000_000
    const a = mkTask({ id: 'a', title: 'A', priority: 'low', dueAt: now + 5000, createdAt: now - 3000, updatedAt: now - 100 })
    const b = mkTask({ id: 'b', title: 'B', priority: 'urgent', dueAt: now + 9000, createdAt: now - 1000, updatedAt: now - 500, subPhase: 'backlog' })
    const c = mkTask({ id: 'c', title: 'C', priority: 'high', createdAt: now - 2000, updatedAt: now - 200 })

    expect(sortListTasks([a, b, c], 'updated').map((t) => t.id)).toEqual(['a', 'c', 'b'])
    expect(sortListTasks([a, b, c], 'due').map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(sortListTasks([a, b, c], 'priority').map((t) => t.id)).toEqual(['b', 'c', 'a'])
    expect(sortListTasks([a, b, c], 'created').map((t) => t.id)).toEqual(['b', 'c', 'a'])

    expect(classifyStatusBucket(a)).toBe('todo_ready')
    expect(classifyStatusBucket(b)).toBe('todo_backlog')

    expect(
      classifyScheduleBucket(
        mkTask({
          id: 's1',
          title: 'Missed',
          schedule: { enabled: false, mode: 'once', at: now - 1000, runCount: 0, endedReason: 'missed' },
        }),
      ),
    ).toBe('anomaly')
    expect(
      classifyScheduleBucket(
        mkTask({
          id: 's2',
          title: 'Cron',
          schedule: { enabled: true, mode: 'cron', cron: '0 9 * * *', nextRunAt: now + 1000, runCount: 1 },
        }),
      ),
    ).toBe('cron_active')
    expect(
      classifyScheduleBucket(
        mkTask({
          id: 's3',
          title: 'Once',
          schedule: { enabled: true, mode: 'once', at: now + 1000, nextRunAt: now + 1000, runCount: 0 },
        }),
      ),
    ).toBe('once_or_reminder')
    expect(
      classifyScheduleBucket(
        mkTask({
          id: 's4',
          title: 'Paused',
          schedule: { enabled: false, mode: 'cron', cron: '0 9 * * *', runCount: 2 },
        }),
      ),
    ).toBe('paused')
    expect(classifyScheduleBucket(a)).toBe('unscheduled')
  })

  it('orders overdue -> earliest DDL -> undated newest-created-first across Focus, Kanban, and List (due) and formats createdAt stamp', () => {
    const now = new Date(2026, 10, 25, 18, 0, 0).getTime()
    const overdueOld = mkTask({
      id: 't-overdue-old',
      title: 'Overdue Old',
      dueAt: now - 3 * 3600_000,
      createdAt: now - 10 * 86_400_000,
    })
    const overdueRecent = mkTask({
      id: 't-overdue-recent',
      title: 'Overdue Recent',
      dueAt: now - 1 * 3600_000,
      createdAt: now - 5 * 86_400_000,
    })
    const dueSoon = mkTask({
      id: 't-due-soon',
      title: 'Due Soon',
      dueAt: now + 2 * 3600_000,
      createdAt: now - 8 * 86_400_000,
    })
    const undatedOld = mkTask({
      id: 't-undated-old',
      title: 'Undated Old',
      priority: 'high',
      createdAt: now - 9 * 86_400_000,
    })
    const undatedNew = mkTask({
      id: 't-undated-new',
      title: 'Undated New',
      priority: 'low',
      createdAt: now - 30 * 60_000,
    })
    const mixed = [undatedOld, dueSoon, overdueRecent, undatedNew, overdueOld]
    const expectedOrder = ['t-overdue-old', 't-overdue-recent', 't-due-soon', 't-undated-new', 't-undated-old']

    expect(sortTasksByDeadline(mixed).map((t) => t.id)).toEqual(expectedOrder)
    expect(sortListTasks(mixed, 'due').map((t) => t.id)).toEqual(expectedOrder)
    expect(filterKanbanTasks(mixed, now).readyTodos.map((t) => t.id)).toEqual(expectedOrder)

    const part = partitionFocusTasks(mixed, now)
    expect(part.todayTodos.map((t) => t.id)).toEqual(['t-overdue-old', 't-overdue-recent', 't-due-soon'])
    expect(part.quietPool.map((t) => t.id)).toEqual(['t-undated-new', 't-undated-old'])

    const todayStamp = formatCreatedStamp(now - 30 * 60_000, now, 'zh')
    expect(todayStamp.label).toContain('今天')
    expect(todayStamp.isStale).toBe(false)

    const staleStamp = formatCreatedStamp(now - 9 * 86_400_000, now, 'zh')
    expect(staleStamp.label).toContain('9天')
    expect(staleStamp.isStale).toBe(true)
  })
})
