import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Archive,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsUp,
  Circle,
  Clock,
  FolderGit2,
  PauseCircle,
  Plus,
  Repeat,
  Star,
  Trash2,
} from 'lucide-react'
import { requiresPermissionConfirmation } from '../../core/handover.ts'
import {
  hasOpenExecution,
  type BatchTaskAction,
  type DiscoveredConversation,
  type TaskPermission,
  type TaskPriority,
  type TaskRecord,
  type WorkspaceRecord,
} from '../../core/types.ts'
import { isPathEqualOrInside, pathComparisonKey } from '../../core/workspace.ts'
import { boardApi } from '../api.ts'
import { formatPhaseLabel, formatPriorityLabel, tr, type Locale } from '../i18n.ts'
import { collectWorkspaceFolders, formatCreatedStamp, formatShortDue, formatWorkspaceBadge } from '../utils.ts'
import { ScheduleMicroBadge } from './ScheduleComposer.tsx'
import {
  classifyScheduleBucket,
  classifyStatusBucket,
  sortListTasks,
  type ListSortBy,
  type ScheduleBucketKey,
  type StatusBucketKey,
} from '../viewFilters.ts'
import { StatusGlyph } from './StatusGlyph.tsx'
import { TaskDetailView } from './TaskDetailDrawer.tsx'

export type ListGroupBy = 'workspace' | 'status' | 'schedule' | 'tag'

interface ListViewProps {
  tasks: TaskRecord[]
  workspaces: WorkspaceRecord[]
  recentConversations: DiscoveredConversation[]
  activeWorkspacePaths: string[]
  hasActiveFilter: boolean
  locale: Locale
  now: number
  groupBy: ListGroupBy
  isNarrow: boolean
  selectedTask: TaskRecord | null
  sessionDefaultPermission: TaskPermission
  autoOpenSession?: boolean
  defaultTimeZone?: string
  onChangeGroupBy: (next: ListGroupBy) => void
  onSelectTask: (taskId: string | null) => void
  onCreateInWorkspace: (
    workspacePath?: string,
    workspaceId?: string,
    conversation?: DiscoveredConversation,
  ) => void
  onToggleManualComplete: (task: TaskRecord) => void
  onTogglePin?: (taskId: string, pin: boolean) => void
  onToggleTodoSubPhase?: (task: TaskRecord) => void
  onTaskUpdated: () => Promise<void>
  onToast: (msg: string) => void
}

const STATUS_GROUPS: ReadonlyArray<{
  key: StatusBucketKey
  phase: TaskRecord['phase']
  subPhase?: TaskRecord['subPhase']
  labelEn: string
  labelZh: string
}> = [
  { key: 'needs_you', phase: 'needs_you', labelEn: 'Needs Attention', labelZh: '需要你确认' },
  { key: 'active', phase: 'active', labelEn: 'In Progress', labelZh: '在做' },
  { key: 'on_hold', phase: 'on_hold', labelEn: 'Paused', labelZh: '停住了' },
  { key: 'todo_ready', phase: 'todo', subPhase: 'ready', labelEn: 'Ready', labelZh: '待启动 Ready' },
  { key: 'todo_backlog', phase: 'todo', subPhase: 'backlog', labelEn: 'Backlog', labelZh: '想法池 Backlog' },
  { key: 'closed', phase: 'closed', labelEn: 'Completed', labelZh: '已收尾' },
]

const SCHEDULE_GROUPS: ReadonlyArray<{
  key: ScheduleBucketKey
  labelKey: 'schedAnomaly' | 'schedCronActive' | 'schedOnceOrReminder' | 'schedPaused' | 'schedUnscheduled'
}> = [
  { key: 'anomaly', labelKey: 'schedAnomaly' },
  { key: 'cron_active', labelKey: 'schedCronActive' },
  { key: 'once_or_reminder', labelKey: 'schedOnceOrReminder' },
  { key: 'paused', labelKey: 'schedPaused' },
  { key: 'unscheduled', labelKey: 'schedUnscheduled' },
]

function renderScheduleBucketIcon(key?: ScheduleBucketKey) {
  switch (key) {
    case 'anomaly':
      return <AlertTriangle size={12} style={{ color: 'var(--agy-warn-fg)', flexShrink: 0 }} />
    case 'cron_active':
      return <Repeat size={12} style={{ color: 'var(--agy-active-fg)', flexShrink: 0 }} />
    case 'once_or_reminder':
      return <Clock size={12} style={{ color: 'var(--agy-muted-fg)', flexShrink: 0 }} />
    case 'paused':
      return <PauseCircle size={12} style={{ color: 'var(--agy-muted-fg)', flexShrink: 0 }} />
    default:
      return <Circle size={11} style={{ color: 'var(--agy-muted-fg)', flexShrink: 0 }} />
  }
}

interface RenderedGroup {
  key: string
  label: string
  kind: 'workspace' | 'status' | 'schedule' | 'tag'
  phase?: TaskRecord['phase']
  subPhase?: TaskRecord['subPhase']
  scheduleKey?: ScheduleBucketKey
  workspacePath?: string
  workspaceId?: string
  items: TaskRecord[]
}

function formatScheduleMeta(task: TaskRecord, locale: Locale): string {
  const parts: string[] = []
  const sched = task.schedule
  if (sched) {
    if (sched.cron) parts.push(sched.cron)
    if (sched.nextRunAt) {
      const d = new Date(sched.nextRunAt)
      const pad = (n: number) => String(n).padStart(2, '0')
      parts.push(
        `${locale === 'zh' ? '下次' : 'Next'} ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
      )
    }
    if (sched.skippedReason) parts.push(`skip:${sched.skippedReason}`)
    else if (sched.endedReason && sched.endedReason !== 'fired') parts.push(`end:${sched.endedReason}`)
  } else if (task.reminderAt !== undefined && task.phase !== 'closed') {
    const d = new Date(task.reminderAt)
    const pad = (n: number) => String(n).padStart(2, '0')
    parts.push(
      `${locale === 'zh' ? '提醒' : 'Remind'} ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
    )
  }
  return parts.join(' · ')
}

export function ListView({
  tasks,
  workspaces,
  recentConversations,
  activeWorkspacePaths,
  hasActiveFilter,
  locale,
  now,
  groupBy,
  isNarrow,
  selectedTask,
  sessionDefaultPermission,
  autoOpenSession = false,
  defaultTimeZone,
  onChangeGroupBy,
  onSelectTask,
  onCreateInWorkspace,
  onToggleManualComplete,
  onTogglePin,
  onToggleTodoSubPhase,
  onTaskUpdated,
  onToast,
}: ListViewProps) {
  const [sortBy, setSortBy] = useState<ListSortBy>('due')
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({
    closed: true,
    unscheduled: true,
  })
  const [showOtherWorkspaces, setShowOtherWorkspaces] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [lastAnchorId, setLastAnchorId] = useState<string | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false)
  const [batchWsVal, setBatchWsVal] = useState('')
  const [batchPrioVal, setBatchPrioVal] = useState('')

  useEffect(() => {
    const existing = new Set(tasks.map((t) => t.id))
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev
      const next = new Set([...prev].filter((id) => existing.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [tasks])

  useEffect(() => {
    if (selectedIds.size === 0) setConfirmBatchDelete(false)
  }, [selectedIds.size])

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const isPathActive = (wsPath?: string) =>
    Boolean(
      wsPath &&
        activeWorkspacePaths.some(
          (ap) => isPathEqualOrInside(wsPath, ap) || isPathEqualOrInside(ap, wsPath),
        ),
    )

  const sortedTasks = useMemo(() => sortListTasks(tasks, sortBy), [tasks, sortBy])

  const groups: RenderedGroup[] = useMemo(() => {
    if (groupBy === 'status') {
      return STATUS_GROUPS.map((g) => ({
        key: g.key,
        label: locale === 'zh' ? g.labelZh : g.labelEn,
        kind: 'status' as const,
        phase: g.phase,
        subPhase: g.subPhase,
        items: sortedTasks.filter((t) => classifyStatusBucket(t) === g.key),
      }))
    }

    if (groupBy === 'schedule') {
      return SCHEDULE_GROUPS.map((g) => ({
        key: g.key,
        label: tr(locale, g.labelKey),
        kind: 'schedule' as const,
        scheduleKey: g.key,
        items: sortedTasks.filter((t) => classifyScheduleBucket(t) === g.key),
      }))
    }

    if (groupBy === 'tag') {
      const byTag = new Map<string, TaskRecord[]>()
      const untagged: TaskRecord[] = []
      for (const task of sortedTasks) {
        if (task.tags.length === 0) {
          untagged.push(task)
          continue
        }
        for (const tag of task.tags) {
          const arr = byTag.get(tag.name) ?? []
          arr.push(task)
          byTag.set(tag.name, arr)
        }
      }
      const tagGroups: RenderedGroup[] = [...byTag.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([tagName, items]) => ({
          key: `tag:${tagName}`,
          label: `#${tagName}`,
          kind: 'tag' as const,
          items,
        }))
      if (untagged.length > 0) {
        tagGroups.push({
          key: '__untagged__',
          label: tr(locale, 'untagged'),
          kind: 'tag' as const,
          items: untagged,
        })
      }
      return tagGroups
    }

    // groupBy === 'workspace'
    const workspaceGroups = new Map<
      string,
      { key: string; label: string; path?: string; workspaceId?: string; isActive: boolean; items: TaskRecord[] }
    >()
    for (const task of sortedTasks) {
      const pathKey = task.workspacePath ? pathComparisonKey(task.workspacePath) : ''
      const key = pathKey ? `path:${pathKey}` : task.workspaceId || '__unbound__'
      const existing = workspaceGroups.get(key)
      const isActive = isPathActive(task.workspacePath)
      if (existing) {
        existing.items.push(task)
        if (!existing.workspaceId && task.workspaceId) existing.workspaceId = task.workspaceId
      } else {
        const badge = formatWorkspaceBadge(task, tr(locale, 'noWorkspace'))
        workspaceGroups.set(key, {
          key,
          label: badge.isUnbound ? tr(locale, 'noWorkspace') : badge.label,
          path: task.workspacePath,
          workspaceId: task.workspaceId,
          isActive,
          items: [task],
        })
      }
    }
    return [...workspaceGroups.values()]
      .sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1
        if (a.key === '__unbound__') return 1
        if (b.key === '__unbound__') return -1
        return a.label.localeCompare(b.label)
      })
      .map((g) => ({
        key: g.key,
        label: g.label,
        kind: 'workspace' as const,
        workspacePath: g.path,
        workspaceId: g.workspaceId,
        items: g.items,
      }))
  }, [groupBy, locale, sortedTasks, activeWorkspacePaths])

  const visibleOrderedIds = useMemo(() => {
    const out: string[] = []
    const seen = new Set<string>()
    for (const group of groups) {
      if (collapsedGroups[group.key]) continue
      for (const item of group.items) {
        if (!seen.has(item.id)) {
          seen.add(item.id)
          out.push(item.id)
        }
      }
    }
    return out
  }, [groups, collapsedGroups])

  const emptyWorkspaces = useMemo(() => {
    if (groupBy !== 'workspace' || hasActiveFilter) return []
    const coveredWsIds = new Set(groups.map((g) => g.workspaceId).filter(Boolean))
    const coveredPathKeys = new Set(
      groups.map((g) => (g.workspacePath ? pathComparisonKey(g.workspacePath) : '')).filter(Boolean),
    )
    return workspaces.filter((ws) => {
      if (coveredWsIds.has(ws.id)) return false
      const folders = collectWorkspaceFolders(ws)
      if (folders.length === 0) return true
      return !folders.some((fp) => coveredPathKeys.has(pathComparisonKey(fp)))
    })
  }, [groupBy, hasActiveFilter, groups, workspaces])

  const handleRowCheckClick = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation()
    if (e.shiftKey && lastAnchorId) {
      const a = visibleOrderedIds.indexOf(lastAnchorId)
      const b = visibleOrderedIds.indexOf(taskId)
      if (a !== -1 && b !== -1) {
        const start = Math.min(a, b)
        const end = Math.max(a, b)
        setSelectedIds((prev) => {
          const next = new Set(prev)
          for (let i = start; i <= end; i += 1) {
            next.add(visibleOrderedIds[i])
          }
          return next
        })
        setLastAnchorId(taskId)
        return
      }
    }
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
    setLastAnchorId(taskId)
  }

  const handleToggleSelectGroup = (items: TaskRecord[]) => {
    if (items.length === 0) return
    const allSelected = items.every((t) => selectedIds.has(t.id))
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const item of items) {
        if (allSelected) next.delete(item.id)
        else next.add(item.id)
      }
      return next
    })
  }

  const runBatch = async (
    action: BatchTaskAction,
    extra: {
      subPhase?: 'ready' | 'backlog'
      priority?: TaskPriority
      workspaceId?: string | null
      workspacePath?: string | null
    } = {},
  ) => {
    const taskIds = [...selectedIds]
    if (taskIds.length === 0) return
    setBatchBusy(true)
    try {
      const res = await boardApi.batchTasks({ taskIds, action, ...extra })
      await onTaskUpdated()
      if (action === 'delete' || action === 'archive') {
        setSelectedIds(new Set())
        setConfirmBatchDelete(false)
      }
      onToast(
        locale === 'zh'
          ? `批量操作已更新 ${res.affectedIds.length} 项`
          : `Updated ${res.affectedIds.length} item(s)`,
      )
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err))
    } finally {
      setBatchBusy(false)
    }
  }

  const handleMasterKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    if (visibleOrderedIds.length === 0) return
    e.preventDefault()
    const idx = selectedTask ? visibleOrderedIds.indexOf(selectedTask.id) : -1
    if (e.key === 'ArrowDown') {
      const nextIdx = idx === -1 ? 0 : Math.min(visibleOrderedIds.length - 1, idx + 1)
      onSelectTask(visibleOrderedIds[nextIdx])
    } else {
      const nextIdx = idx === -1 ? visibleOrderedIds.length - 1 : Math.max(0, idx - 1)
      onSelectTask(visibleOrderedIds[nextIdx])
    }
  }

  const renderTaskRow = (task: TaskRecord, keyPrefix = '') => {
    const isSelected = selectedTask?.id === task.id
    const isChecked = selectedIds.has(task.id)
    const isPinned = Boolean(task.userMarks?.pinnedAt)
    const needsPerm = requiresPermissionConfirmation(task, sessionDefaultPermission)
    const canToggle = !needsPerm && !hasOpenExecution(task) && task.phase !== 'active'
    const dueInfo = task.dueAt !== undefined && task.phase !== 'closed' ? formatShortDue(task.dueAt, now, locale) : null
    const createdStamp = !dueInfo && task.phase !== 'closed' ? formatCreatedStamp(task.createdAt, now, locale) : null
    const wsBadge = formatWorkspaceBadge(task, '')
    const schedMeta = groupBy === 'schedule' ? formatScheduleMeta(task, locale) : ''
    const subtitleParts: string[] = []
    if (schedMeta) subtitleParts.push(schedMeta)
    if (dueInfo) subtitleParts.push(dueInfo.text)
    if (createdStamp) subtitleParts.push(createdStamp.label)
    if (task.subgoalRollup.total > 0) subtitleParts.push(`${task.subgoalRollup.done}/${task.subgoalRollup.total}`)
    if (groupBy !== 'workspace' && wsBadge.label) subtitleParts.push(wsBadge.label)
    if (groupBy !== 'status') subtitleParts.push(formatPhaseLabel(task.phase, locale))
    if (task.blockedReason || task.nextAction) subtitleParts.push(task.blockedReason || task.nextAction || '')

    return (
      <div
        key={`${keyPrefix}${task.id}`}
        className={`list-row${isSelected ? ' is-selected' : ''}${isChecked ? ' is-checked' : ''}`}
        onClick={() => onSelectTask(task.id)}
        data-testid={`task-card-${task.id}`}
      >
        <div className="list-row-body">
          <input
            type="checkbox"
            className={`list-row-check${selectedIds.size > 0 || isChecked ? ' is-visible' : ''}`}
            checked={isChecked}
            onChange={() => {}}
            onClick={(e) => handleRowCheckClick(e, task.id)}
            aria-label={`Select ${task.title}`}
          />
          <button
            type="button"
            className="status-icon-btn"
            disabled={!canToggle}
            aria-label={task.phase === 'closed' ? tr(locale, 'restore') : tr(locale, 'approvePass')}
            onClick={(e) => {
              e.stopPropagation()
              if (canToggle) onToggleManualComplete(task)
            }}
            style={{ marginTop: 1 }}
          >
            <StatusGlyph phase={task.phase} subPhase={task.subPhase} size={14} />
          </button>

          <div className="list-row-text">
            <div className="list-row-title">{task.title}</div>
            {(subtitleParts.length > 0 || task.schedule || task.reminderAt !== undefined) && (
              <div className="list-row-meta row-wrap" style={{ gap: 6 }}>
                <ScheduleMicroBadge task={task} locale={locale} now={now} />
                {subtitleParts.length > 0 && <span>{subtitleParts.join(' · ')}</span>}
              </div>
            )}
          </div>
        </div>

        <div className="list-row-actions" onClick={(e) => e.stopPropagation()}>
          {task.phase === 'todo' && onToggleTodoSubPhase && (
            <button
              type="button"
              className={`list-subphase-pill${
                task.subPhase === 'backlog' ? ' is-backlog' : task.subPhase === 'draft' ? ' is-draft' : ' is-ready'
              }`}
              onClick={() => onToggleTodoSubPhase(task)}
              title={
                task.subPhase === 'draft'
                  ? locale === 'zh'
                    ? '审校通过，移入 Ready'
                    : 'Approve draft to Ready'
                  : task.subPhase === 'backlog'
                    ? 'Switch to Ready'
                    : 'Move to Backlog'
              }
              data-testid={`toggle-subphase-${task.id}`}
            >
              {task.subPhase === 'backlog' ? 'Backlog' : task.subPhase === 'draft' ? tr(locale, 'draftBadge') : 'Ready'}
            </button>
          )}
          {onTogglePin && (
            <button
              type="button"
              className={`focus-pin-btn${isPinned ? ' is-pinned' : ''}`}
              aria-label={isPinned ? (locale === 'zh' ? '取消星标' : 'Unstar') : (locale === 'zh' ? '星标置顶' : 'Star')}
              title={isPinned ? tr(locale, 'unpinFromFocus') : tr(locale, 'pinToFocus')}
              onClick={() => onTogglePin(task.id, !isPinned)}
            >
              <Star size={12} fill={isPinned ? 'currentColor' : 'none'} />
            </button>
          )}
          {task.priority === 'urgent' && (
            <span className="prio-chip is-urgent" title={locale === 'zh' ? '紧急' : 'Urgent'}>
              <ChevronsUp size={13} aria-hidden="true" />
            </span>
          )}
          {task.priority === 'high' && (
            <span className="prio-chip" title={locale === 'zh' ? '高优先级' : 'High priority'}>
              <ChevronUp size={13} aria-hidden="true" />
            </span>
          )}
        </div>
      </div>
    )
  }

  // Narrow viewport drill-down: show inline detail when selected
  if (isNarrow && selectedTask) {
    return (
      <div className="list-master-detail is-narrow" data-testid="list-view">
        <div className="list-detail-pane">
          <TaskDetailView
            key={selectedTask.id}
            task={selectedTask}
            locale={locale}
            workspaces={workspaces}
            recentConversations={recentConversations}
            sessionDefaultPermission={sessionDefaultPermission}
            autoOpenSession={autoOpenSession}
            defaultTimeZone={defaultTimeZone}
            variant="inline"
            showBackButton
            onClose={() => onSelectTask(null)}
            onTaskUpdated={onTaskUpdated}
            onToast={onToast}
          />
        </div>
      </div>
    )
  }

  return (
    <div className={`list-master-detail${isNarrow ? ' is-narrow' : ''}`} data-testid="list-view">
      <div
        className="list-master-pane"
        tabIndex={0}
        onKeyDown={handleMasterKeyDown}
        data-testid="list-master-pane"
      >
        <div className="list-pane-toolbar">
          <div className="list-toolbar-top">
            <span className="text-muted tabular-nums" style={{ fontSize: 11.5 }}>
              {tasks.length} {locale === 'zh' ? '条待办' : 'todos'}
            </span>
            <select
              className="list-sort-select"
              aria-label={locale === 'zh' ? '排序方式' : 'Sort by'}
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as ListSortBy)}
              data-testid="list-sort-select"
            >
              <option value="updated">{tr(locale, 'sortUpdated')}</option>
              <option value="due">{tr(locale, 'sortDue')}</option>
              <option value="priority">{tr(locale, 'sortPriority')}</option>
              <option value="created">{tr(locale, 'sortCreated')}</option>
            </select>
          </div>
          <div className="list-group-switch">
            <button
              type="button"
              className={`list-switch-btn${groupBy === 'workspace' ? ' is-active' : ''}`}
              onClick={() => onChangeGroupBy('workspace')}
            >
              {tr(locale, 'groupByWorkspace')}
            </button>
            <button
              type="button"
              className={`list-switch-btn${groupBy === 'status' ? ' is-active' : ''}`}
              onClick={() => onChangeGroupBy('status')}
            >
              {tr(locale, 'groupByStatus')}
            </button>
            <button
              type="button"
              className={`list-switch-btn${groupBy === 'schedule' ? ' is-active' : ''}`}
              onClick={() => onChangeGroupBy('schedule')}
            >
              {tr(locale, 'groupBySchedule')}
            </button>
            <button
              type="button"
              className={`list-switch-btn${groupBy === 'tag' ? ' is-active' : ''}`}
              onClick={() => onChangeGroupBy('tag')}
            >
              {tr(locale, 'groupByTag')}
            </button>
          </div>
        </div>

        <div className="list-groups-scroll">
          {groups.length === 0 && emptyWorkspaces.length === 0 && (
            <div className="empty-hint">{tr(locale, 'emptyNone')}</div>
          )}

          {groups.map((group) => {
            const isCollapsed = Boolean(collapsedGroups[group.key])
            const allGroupSelected = group.items.length > 0 && group.items.every((t) => selectedIds.has(t.id))
            return (
              <div key={group.key} className="list-group">
                <div
                  className="list-group-header"
                  style={{ cursor: 'pointer' }}
                  onClick={() => toggleGroup(group.key)}
                >
                  <span className="row-wrap" style={{ minWidth: 0, flex: 1 }}>
                    {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    {group.kind === 'workspace' && (
                      <FolderGit2 size={12} style={{ color: 'var(--agy-muted-fg)' }} />
                    )}
                    {group.kind === 'status' && group.phase && (
                      <StatusGlyph
                        phase={group.phase}
                        subPhase={group.subPhase}
                        size={13}
                        animate={group.items.length > 0}
                      />
                    )}
                    {group.kind === 'schedule' && group.scheduleKey && (
                      <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center' }}>
                        {renderScheduleBucketIcon(group.scheduleKey)}
                      </span>
                    )}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {group.label}
                    </span>
                    <span className="kanban-count-pill tabular-nums">{group.items.length}</span>
                  </span>

                  <div className="row-wrap" style={{ gap: 4, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                    {group.items.length > 0 && (
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost list-group-select-btn"
                        onClick={() => handleToggleSelectGroup(group.items)}
                      >
                        {allGroupSelected ? tr(locale, 'deselectAllGroup') : tr(locale, 'selectAllGroup')}
                      </button>
                    )}
                    {group.kind === 'workspace' && (
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost"
                        title={tr(locale, 'newTask')}
                        onClick={() => onCreateInWorkspace(group.workspacePath, group.workspaceId)}
                      >
                        <Plus size={11} />
                      </button>
                    )}
                  </div>
                </div>

                {!isCollapsed && (
                  <div className="list-group-items">
                    {group.items.length === 0 ? (
                      <div className="text-muted" style={{ padding: '4px 10px', fontSize: 11.5 }}>
                        {tr(locale, 'emptyNone')}
                      </div>
                    ) : (
                      group.items.map((t) => renderTaskRow(t, `${group.key}::`))
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {groupBy === 'workspace' && emptyWorkspaces.length > 0 && (
            <div className="list-group">
              <button
                type="button"
                className="list-group-header"
                onClick={() => setShowOtherWorkspaces((v) => !v)}
              >
                <span className="row-wrap">
                  {showOtherWorkspaces ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span>{tr(locale, 'otherWorkspaces')}</span>
                  <span className="kanban-section-count">{emptyWorkspaces.length}</span>
                </span>
              </button>
              {showOtherWorkspaces && (
                <div className="list-group-items">
                  {emptyWorkspaces.map((ws) => {
                    const folders = collectWorkspaceFolders(ws)
                    return (
                      <div key={ws.id} className="list-row" style={{ cursor: 'default' }}>
                        <div className="list-row-body">
                          <FolderGit2 size={13} style={{ color: 'var(--agy-muted-fg)', marginTop: 2 }} />
                          <div className="list-row-text">
                            <div className="list-row-title">{ws.name}</div>
                            {ws.rootPath && <div className="list-row-meta">{ws.rootPath}</div>}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost"
                          onClick={() => onCreateInWorkspace(folders[0] || ws.rootPath, ws.id)}
                        >
                          <Plus size={11} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sticky Bottom Batch Action Bar */}
        {selectedIds.size > 0 && (
          <div className="list-batch-bar" data-testid="list-batch-bar">
            <div className="list-batch-summary">
              <strong className="tabular-nums">
                {locale === 'zh' ? `已选 ${selectedIds.size} 项` : `${selectedIds.size} selected`}
              </strong>
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                onClick={() => {
                  setSelectedIds(new Set())
                  setConfirmBatchDelete(false)
                }}
              >
                {tr(locale, 'cancel')}
              </button>
            </div>
            <div className="list-batch-actions">
              <button
                type="button"
                className="btn btn-xs"
                disabled={batchBusy}
                onClick={() => void runBatch('pin')}
              >
                <Star size={11} />
                <span>{locale === 'zh' ? '★ 聚焦' : '★ Pin'}</span>
              </button>
              <button
                type="button"
                className="btn btn-xs"
                disabled={batchBusy}
                onClick={() => void runBatch('set_sub_phase', { subPhase: 'ready' })}
              >
                {locale === 'zh' ? '设 Ready' : 'Set Ready'}
              </button>
              <button
                type="button"
                className="btn btn-xs"
                disabled={batchBusy}
                onClick={() => void runBatch('set_sub_phase', { subPhase: 'backlog' })}
              >
                {locale === 'zh' ? '设 Backlog' : 'Set Backlog'}
              </button>
              <select
                className="list-batch-select"
                aria-label={locale === 'zh' ? '批量工作区' : 'Batch workspace'}
                value={batchWsVal}
                disabled={batchBusy}
                onChange={(e) => {
                  const val = e.target.value
                  setBatchWsVal('')
                  if (!val) return
                  if (val === '__unbound__') {
                    void runBatch('set_workspace', { workspaceId: null, workspacePath: null })
                  } else {
                    const ws = workspaces.find((w) => w.id === val)
                    void runBatch('set_workspace', {
                      workspaceId: val,
                      workspacePath: ws?.rootPath ?? null,
                    })
                  }
                }}
              >
                <option value="">{locale === 'zh' ? '工作区 ▾' : 'Workspace ▾'}</option>
                <option value="__unbound__">{tr(locale, 'unboundBadge')}</option>
                {workspaces.map((ws) => (
                  <option key={ws.id} value={ws.id}>
                    {ws.name}
                  </option>
                ))}
              </select>
              <select
                className="list-batch-select"
                aria-label={locale === 'zh' ? '批量优先级' : 'Batch priority'}
                value={batchPrioVal}
                disabled={batchBusy}
                onChange={(e) => {
                  const val = e.target.value as TaskPriority | ''
                  setBatchPrioVal('')
                  if (!val) return
                  void runBatch('set_priority', { priority: val })
                }}
              >
                <option value="">{locale === 'zh' ? '优先级 ▾' : 'Priority ▾'}</option>
                {(['urgent', 'high', 'normal', 'low'] as const).map((p) => (
                  <option key={p} value={p}>
                    {formatPriorityLabel(p, locale)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-xs"
                disabled={batchBusy}
                onClick={() => void runBatch('archive')}
              >
                <Archive size={11} />
                <span>{tr(locale, 'archive')}</span>
              </button>
              <button
                type="button"
                className={`btn btn-xs ${confirmBatchDelete ? 'btn-danger' : ''}`}
                disabled={batchBusy}
                onClick={() => {
                  if (!confirmBatchDelete) {
                    setConfirmBatchDelete(true)
                    return
                  }
                  void runBatch('delete')
                }}
              >
                <Trash2 size={11} />
                <span>
                  {confirmBatchDelete
                    ? locale === 'zh'
                      ? '确认删除'
                      : 'Confirm Delete'
                    : tr(locale, 'delete')}
                </span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Right Master-Detail Pane on Wide / Medium */}
      {!isNarrow && (
        <div className="list-detail-pane">
          {selectedTask ? (
            <TaskDetailView
              key={selectedTask.id}
              task={selectedTask}
              locale={locale}
              workspaces={workspaces}
              recentConversations={recentConversations}
              sessionDefaultPermission={sessionDefaultPermission}
              autoOpenSession={autoOpenSession}
              defaultTimeZone={defaultTimeZone}
              variant="inline"
              showBackButton={false}
              onClose={() => onSelectTask(null)}
              onTaskUpdated={onTaskUpdated}
              onToast={onToast}
            />
          ) : (
            <div className="list-detail-empty">
              <CheckSquare size={28} style={{ opacity: 0.38 }} />
              <span>{tr(locale, 'selectTaskHint')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
