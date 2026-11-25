import type { TaskPriority, TaskRecord } from '../core/types.ts'
import type { Locale } from './i18n.ts'
import { sortTasksByDeadline } from './utils.ts'

export const FORTY_EIGHT_HOURS_MS = 48 * 3600_000
export const SEVEN_DAYS_MS = 7 * 86_400_000

export function startOfLocalDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function endOfLocalDay(now: number): number {
  const d = new Date(now)
  d.setHours(23, 59, 59, 999)
  return d.getTime()
}

export type SnoozePreset = '2h' | 'tonight' | 'tomorrow' | 'nextMonday'

export function computeSnoozeTarget(preset: SnoozePreset, now: number): number {
  if (preset === '2h') return now + 2 * 3600_000
  const d = new Date(now)
  if (preset === 'tonight') {
    d.setHours(20, 0, 0, 0)
    if (d.getTime() <= now) {
      d.setDate(d.getDate() + 1)
    }
    return d.getTime()
  }
  if (preset === 'tomorrow') {
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
    return d.getTime()
  }
  // nextMonday
  const day = d.getDay() // 0 = Sun, 1 = Mon, ...
  const daysUntilMon = day === 0 ? 1 : 8 - day
  d.setDate(d.getDate() + daysUntilMon)
  d.setHours(9, 0, 0, 0)
  return d.getTime()
}

export function formatSnoozeUntilTag(snoozedUntil: number, locale: Locale): string {
  const d = new Date(snoozedUntil)
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return locale === 'zh' ? `延后至 ${stamp}` : `Snoozed until ${stamp}`
}

export function isTaskSnoozed(task: TaskRecord, now: number): boolean {
  return task.userMarks?.snoozedUntil !== undefined && task.userMarks.snoozedUntil > now
}

export function isFocusTodayTodo(task: TaskRecord, now: number): boolean {
  if (task.phase !== 'todo') return false
  if (task.userMarks?.pinnedAt) return true
  if (task.priority === 'urgent') return true
  if (task.dueAt !== undefined && task.dueAt <= now + FORTY_EIGHT_HOURS_MS) return true
  const eod = endOfLocalDay(now)
  if (task.reminderAt !== undefined && task.reminderAt <= eod) return true
  if (task.schedule?.enabled && task.schedule.nextRunAt !== undefined && task.schedule.nextRunAt <= eod) {
    return true
  }
  return false
}

export function isFocusPrimaryTask(task: TaskRecord, now: number): boolean {
  if (task.archivedAt !== undefined) return false
  if (task.userMarks?.ignoredAt !== undefined) return false
  if (isTaskSnoozed(task, now)) return false
  if (task.phase === 'needs_you') return true
  if (task.phase === 'active' || task.phase === 'on_hold') return true
  if (task.phase === 'todo') return isFocusTodayTodo(task, now)
  if (task.phase === 'closed') {
    const completed = task.completedAt ?? task.updatedAt
    return completed >= startOfLocalDay(now)
  }
  return false
}

export interface FocusPartition {
  needsYou: TaskRecord[]
  inProgress: TaskRecord[]
  todayTodos: TaskRecord[]
  todayClosed: TaskRecord[]
  quietPool: TaskRecord[]
  ignored: TaskRecord[]
}

export function partitionFocusTasks(tasks: readonly TaskRecord[], now: number): FocusPartition {
  const sod = startOfLocalDay(now)
  const needsYou: TaskRecord[] = []
  const inProgress: TaskRecord[] = []
  const todayTodos: TaskRecord[] = []
  const todayClosed: TaskRecord[] = []
  const quietPool: TaskRecord[] = []
  const ignored: TaskRecord[] = []

  for (const task of tasks) {
    if (task.archivedAt !== undefined) continue
    if (task.userMarks?.ignoredAt !== undefined) {
      ignored.push(task)
      continue
    }
    if (isTaskSnoozed(task, now)) {
      if (task.phase !== 'closed') {
        quietPool.push(task)
      }
      continue
    }
    if (task.phase === 'needs_you') {
      needsYou.push(task)
    } else if (task.phase === 'active' || task.phase === 'on_hold') {
      inProgress.push(task)
    } else if (task.phase === 'todo') {
      if (isFocusTodayTodo(task, now)) {
        todayTodos.push(task)
      } else {
        quietPool.push(task)
      }
    } else if (task.phase === 'closed') {
      if ((task.completedAt ?? task.updatedAt) >= sod) {
        todayClosed.push(task)
      }
    }
  }

  return {
    needsYou: sortTasksByDeadline(needsYou),
    inProgress: sortTasksByDeadline(inProgress),
    todayTodos: sortTasksByDeadline(todayTodos),
    todayClosed: [...todayClosed].sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt)),
    quietPool: sortTasksByDeadline(quietPool),
    ignored,
  }
}

export interface KanbanFiltered {
  needsYou: TaskRecord[]
  active: TaskRecord[]
  onHold: TaskRecord[]
  readyTodos: TaskRecord[]
  recentClosed: TaskRecord[]
  backlogCount: number
  scheduledFutureCount: number
  olderClosedCount: number
}

export function filterKanbanTasks(tasks: readonly TaskRecord[], now: number): KanbanFiltered {
  const eod = endOfLocalDay(now)
  const closedCutoff = now - SEVEN_DAYS_MS
  const needsYou: TaskRecord[] = []
  const active: TaskRecord[] = []
  const onHold: TaskRecord[] = []
  const readyTodos: TaskRecord[] = []
  const recentClosed: TaskRecord[] = []
  let backlogCount = 0
  let scheduledFutureCount = 0
  let olderClosedCount = 0

  for (const task of tasks) {
    if (task.archivedAt !== undefined) continue
    if (task.userMarks?.ignoredAt !== undefined) continue
    if (task.phase === 'needs_you') {
      needsYou.push(task)
    } else if (task.phase === 'active') {
      active.push(task)
    } else if (task.phase === 'on_hold') {
      onHold.push(task)
    } else if (task.phase === 'todo') {
      if (task.subPhase === 'backlog') {
        backlogCount += 1
        continue
      }
      const isFutureScheduledOnly =
        Boolean(task.schedule?.enabled && task.schedule.nextRunAt !== undefined && task.schedule.nextRunAt > eod) &&
        !(task.dueAt !== undefined && task.dueAt <= now + FORTY_EIGHT_HOURS_MS) &&
        !task.userMarks?.pinnedAt
      if (isFutureScheduledOnly) {
        scheduledFutureCount += 1
        continue
      }
      readyTodos.push(task)
    } else if (task.phase === 'closed') {
      const doneAt = task.completedAt ?? task.updatedAt
      if (doneAt >= closedCutoff) {
        recentClosed.push(task)
      } else {
        olderClosedCount += 1
      }
    }
  }

  return {
    needsYou: sortTasksByDeadline(needsYou),
    active: sortTasksByDeadline(active),
    onHold: sortTasksByDeadline(onHold),
    readyTodos: sortTasksByDeadline(readyTodos),
    recentClosed: [...recentClosed].sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt)),
    backlogCount,
    scheduledFutureCount,
    olderClosedCount,
  }
}

export function formatElapsedTimer(startedAt: number, now: number): string {
  const totalSec = Math.max(0, Math.floor((now - startedAt) / 1000))
  const hours = Math.floor(totalSec / 3600)
  const mins = Math.floor((totalSec % 3600) / 60)
  const secs = totalSec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`
}

export type ListSortBy = 'updated' | 'due' | 'priority' | 'created'

const PRIORITY_RANK: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
}

export function sortListTasks(tasks: readonly TaskRecord[], sortBy: ListSortBy): TaskRecord[] {
  if (sortBy === 'due') {
    return sortTasksByDeadline(tasks)
  }
  const copy = [...tasks]
  copy.sort((a, b) => {
    if (sortBy === 'priority') {
      const pDiff = (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2)
      if (pDiff !== 0) return pDiff
      const aHas = typeof a.dueAt === 'number' && Number.isFinite(a.dueAt)
      const bHas = typeof b.dueAt === 'number' && Number.isFinite(b.dueAt)
      if (aHas && !bHas) return -1
      if (!aHas && bHas) return 1
      if (aHas && bHas && a.dueAt !== b.dueAt) return (a.dueAt as number) - (b.dueAt as number)
      return (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)
    }
    if (sortBy === 'created') {
      return b.createdAt - a.createdAt
    }
    return (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)
  })
  return copy
}

export type ScheduleBucketKey = 'anomaly' | 'cron_active' | 'once_or_reminder' | 'paused' | 'unscheduled'

export function classifyScheduleBucket(task: TaskRecord): ScheduleBucketKey {
  const sched = task.schedule
  if (sched) {
    const hasAnomaly =
      sched.missedSlotAt !== undefined ||
      sched.skippedAt !== undefined ||
      sched.endedReason === 'missed' ||
      sched.endedReason === 'launch-failed' ||
      sched.endedReason === 'permission' ||
      sched.endedReason === 'busy' ||
      sched.endedReason === 'no-target'
    if (hasAnomaly) return 'anomaly'
    if (sched.enabled && (sched.mode === 'cron' || sched.mode === 'after_completion')) return 'cron_active'
    if (sched.enabled && sched.mode === 'once') return 'once_or_reminder'
    if (!sched.enabled) return 'paused'
  }
  if (task.reminderAt !== undefined && task.phase !== 'closed') {
    return 'once_or_reminder'
  }
  return 'unscheduled'
}

export type StatusBucketKey = 'needs_you' | 'active' | 'on_hold' | 'todo_ready' | 'todo_backlog' | 'closed'

export function classifyStatusBucket(task: TaskRecord): StatusBucketKey {
  if (task.phase === 'todo') {
    return task.subPhase === 'backlog' ? 'todo_backlog' : 'todo_ready'
  }
  return task.phase
}
