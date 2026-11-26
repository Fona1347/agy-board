import { useEffect, useState } from 'react'
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsUp,
  Clock,
  Columns2,
  ExternalLink,
  ShieldAlert,
  Star,
} from 'lucide-react'
import { requiresPermissionConfirmation } from '../../core/handover.ts'
import { hasOpenExecution, isRecurringSchedule, type TaskPermission, type TaskRecord } from '../../core/types.ts'
import { formatPhaseSubPhaseLabel, tr, type Locale } from '../i18n.ts'
import {
  formatCreatedStamp,
  formatRelativeAge,
  formatTimelineTick,
  formatWorkspaceBadge,
  latestPrimaryConversation,
} from '../utils.ts'
import { isRecurringActiveSchedule, ScheduleMicroBadge } from './ScheduleComposer.tsx'
import {
  computeSnoozeTarget,
  formatSnoozeUntilTag,
  isTaskSnoozed,
  partitionFocusTasks,
  type SnoozePreset,
} from '../viewFilters.ts'
import { StatusGlyph } from './StatusGlyph.tsx'
import { resolveNeedsYouBadgeClass, resolveTaskTintClass } from './TaskCard.tsx'

interface FocusViewProps {
  tasks: TaskRecord[]
  locale: Locale
  sessionDefaultPermission: TaskPermission
  now: number
  showWorkspaceTag: boolean
  onOpenTask: (taskId: string) => void
  onFilterWorkspace: (wsKey: string) => void
  onToggleManualComplete: (task: TaskRecord) => void
  onToggleIgnore: (taskId: string, ignore: boolean) => void
  onTogglePin: (taskId: string, pin: boolean) => void
  onSnoozeTask: (taskId: string, snoozeUntil: number | null) => void
  onJump: (conversationId: string, options?: { split?: 'right' }) => void
  onConfirmPermission: (taskId: string) => void
  onApproveAndClose: (taskId: string) => void
  onApproveDraft?: (task: TaskRecord) => void
  onAcceptScheduleCycle?: (taskId: string) => void
}

function firstLinePreview(raw?: string): string {
  if (!raw) return ''
  const line = raw
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^#+\s*/, '').replace(/^[-*]\s*/, ''))
    .find(Boolean)
  return line ?? ''
}

export function FocusView({
  tasks,
  locale,
  sessionDefaultPermission,
  now,
  showWorkspaceTag,
  onOpenTask,
  onFilterWorkspace,
  onToggleManualComplete,
  onToggleIgnore,
  onTogglePin,
  onSnoozeTask,
  onJump,
  onConfirmPermission,
  onApproveAndClose,
  onApproveDraft,
  onAcceptScheduleCycle,
}: FocusViewProps) {
  const [openNeedsYou, setOpenNeedsYou] = useState(true)
  const [openActive, setOpenActive] = useState(true)
  const [openTodo, setOpenTodo] = useState(true)
  const [openClosed, setOpenClosed] = useState(false)
  const [openQuietPool, setOpenQuietPool] = useState(false)
  const [openIgnored, setOpenIgnored] = useState(false)
  const [snoozeMenuTaskId, setSnoozeMenuTaskId] = useState<string | null>(null)

  useEffect(() => {
    if (!snoozeMenuTaskId) return
    const closeMenu = () => setSnoozeMenuTaskId(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSnoozeMenuTaskId(null)
    }
    window.addEventListener('click', closeMenu)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('keydown', onKey)
    }
  }, [snoozeMenuTaskId])

  const { needsYou, inProgress, todayTodos, todayClosed, quietPool, ignored } = partitionFocusTasks(tasks, now)
  const primaryEmpty = needsYou.length === 0 && inProgress.length === 0 && todayTodos.length === 0
  const effectivePoolOpen = openQuietPool || (primaryEmpty && quietPool.length > 0)

  const applySnooze = (taskId: string, preset: SnoozePreset) => {
    setSnoozeMenuTaskId(null)
    onSnoozeTask(taskId, computeSnoozeTarget(preset, now))
  }

  const renderTimelineRow = (task: TaskRecord, isElevatedCard: boolean) => {
    const tick = formatTimelineTick(
      task.dueAt,
      now,
      locale,
      task.phase !== 'closed'
        ? {
            nextRunAt: task.schedule?.enabled ? task.schedule.nextRunAt : undefined,
            reminderAt: task.reminderAt,
            isRecurring: isRecurringSchedule(task.schedule),
          }
        : undefined,
    )
    const wsBadge = formatWorkspaceBadge(task, tr(locale, 'unboundBadge'))
    const subtitle =
      task.blockedReason ||
      task.nextAction ||
      firstLinePreview(task.description) ||
      (task.subgoalRollup.total > 0 ? `${task.subgoalRollup.done}/${task.subgoalRollup.total}` : '')
    const needsPerm = requiresPermissionConfirmation(task, sessionDefaultPermission)
    const openExecution = hasOpenExecution(task)
    const primaryConv = latestPrimaryConversation(task)
    const canToggle = !needsPerm && !openExecution && task.phase !== 'active' && task.phase !== 'needs_you'
    const statusLabel = formatPhaseSubPhaseLabel(task.phase, task.subPhase, locale)
    const tintClass = isElevatedCard ? resolveTaskTintClass(task, needsPerm) : ''
    const isInbox = task.phase === 'needs_you'
    const isActiveWithConv = task.phase === 'active' && Boolean(primaryConv)
    const isPinned = Boolean(task.userMarks?.pinnedAt)
    const canSnooze = task.phase === 'needs_you' || task.phase === 'todo'
    const snoozeOpen = snoozeMenuTaskId === task.id
    const ageText = formatRelativeAge(task.updatedAt || task.createdAt, now, locale)
    const createdStamp = task.dueAt === undefined ? formatCreatedStamp(task.createdAt, now, locale) : null

    return (
      <div key={task.id} className="focus-timeline-row" data-testid={`focus-row-${task.id}`}>
        <div
          className="ddl-rail"
          data-testid={`ddl-tick-${task.id}`}
          title={createdStamp ? `${locale === 'zh' ? '加入于' : 'Added'} ${createdStamp.full}` : undefined}
        >
          <div className={`ddl-tick-text tone-${tick.tone}`}>
            <div className="ddl-tick-primary tabular-nums">{tick.primary}</div>
            {tick.secondary && <div className="ddl-tick-secondary tabular-nums">{tick.secondary}</div>}
          </div>
          <span className={`ddl-node tone-${tick.tone}`} />
        </div>

        <div
          className={isElevatedCard ? `focus-row-card${tintClass ? ` ${tintClass}` : ''}` : 'focus-row-plain is-scheduled'}
          onClick={() => onOpenTask(task.id)}
          data-testid={`task-card-${task.id}`}
        >
          <div className="focus-row-main">
            <div className="focus-row-content">
              {isInbox ? (
                <span style={{ marginTop: 2, flexShrink: 0 }}>
                  <StatusGlyph phase={task.phase} subPhase={task.subPhase} size={15} />
                </span>
              ) : (
                <button
                  type="button"
                  className="status-icon-btn"
                  disabled={!canToggle}
                  aria-label={tr(locale, 'approvePass')}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (canToggle) onToggleManualComplete(task)
                  }}
                  style={{ marginTop: 2 }}
                >
                  <StatusGlyph phase={task.phase} subPhase={task.subPhase} size={15} />
                </button>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="focus-row-title-line">
                  <span className="focus-row-title">{task.title}</span>
                  {isInbox && (
                    <span className={`badge ${resolveNeedsYouBadgeClass(task, needsPerm)}`}>
                      {statusLabel}
                    </span>
                  )}
                  {task.phase === 'on_hold' && (
                    <span className="badge badge-danger">{tr(locale, 'blockedPill')}</span>
                  )}
                  <ScheduleMicroBadge task={task} locale={locale} now={now} />
                  {showWorkspaceTag && !wsBadge.isUnbound && (
                    <button
                      type="button"
                      className="ws-micro-tag"
                      title={task.workspacePath || wsBadge.label}
                      onClick={(e) => {
                        e.stopPropagation()
                        onFilterWorkspace(wsBadge.filterKey)
                      }}
                    >
                      {wsBadge.label}
                    </button>
                  )}
                  {createdStamp && (
                    <span
                      className={`badge tabular-nums${createdStamp.isStale ? ' badge-warn' : ''}`}
                      title={createdStamp.full}
                      data-testid={`created-stamp-${task.id}`}
                    >
                      {createdStamp.label}
                    </span>
                  )}
                </div>
                {subtitle && <div className="focus-row-subtitle">{subtitle}</div>}
              </div>
            </div>

            <div className="focus-row-aside" onClick={(e) => e.stopPropagation()}>
              {canSnooze && (
                <div className="snooze-menu-wrap">
                  <button
                    type="button"
                    className={`focus-ignore-btn focus-snooze-trigger${snoozeOpen ? ' is-open' : ''}`}
                    aria-expanded={snoozeOpen}
                    aria-label={tr(locale, 'snooze')}
                    onClick={() => setSnoozeMenuTaskId((cur) => (cur === task.id ? null : task.id))}
                  >
                    <Clock size={11} />
                    <span>{tr(locale, 'snooze')} ▾</span>
                  </button>
                  {snoozeOpen && (
                    <div className="snooze-menu" role="menu" data-testid={`snooze-menu-${task.id}`}>
                      <button type="button" className="snooze-menu-item" role="menuitem" onClick={() => applySnooze(task.id, '2h')}>
                        {tr(locale, 'snooze2h')}
                      </button>
                      <button type="button" className="snooze-menu-item" role="menuitem" onClick={() => applySnooze(task.id, 'tonight')}>
                        {tr(locale, 'snoozeTonight')}
                      </button>
                      <button type="button" className="snooze-menu-item" role="menuitem" onClick={() => applySnooze(task.id, 'tomorrow')}>
                        {tr(locale, 'snoozeTomorrow')}
                      </button>
                      <button type="button" className="snooze-menu-item" role="menuitem" onClick={() => applySnooze(task.id, 'nextMonday')}>
                        {tr(locale, 'snoozeNextMonday')}
                      </button>
                      <div className="snooze-menu-sep" />
                      <button
                        type="button"
                        className="snooze-menu-item is-danger"
                        role="menuitem"
                        onClick={() => {
                          setSnoozeMenuTaskId(null)
                          onToggleIgnore(task.id, true)
                        }}
                      >
                        {tr(locale, 'ignoreTask')}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {!canSnooze && (
                <button
                  type="button"
                  className="focus-ignore-btn"
                  onClick={() => onToggleIgnore(task.id, true)}
                >
                  {tr(locale, 'ignoreTask')}
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
              <button
                type="button"
                className={`focus-pin-btn${isPinned ? ' is-pinned' : ''}`}
                aria-label={isPinned ? (locale === 'zh' ? '取消星标' : 'Unstar') : (locale === 'zh' ? '星标置顶' : 'Star')}
                title={isPinned ? tr(locale, 'unpinFromFocus') : tr(locale, 'pinToFocus')}
                onClick={() => onTogglePin(task.id, !isPinned)}
              >
                <Star size={12} fill={isPinned ? 'currentColor' : 'none'} />
              </button>
            </div>
          </div>

          {isInbox && (
            <div className="inbox-actions-row" onClick={(e) => e.stopPropagation()}>
              <div className="inbox-actions-btns">
                {needsPerm && (
                  <button
                    type="button"
                    className="btn btn-xs btn-primary"
                    onClick={() => onConfirmPermission(task.id)}
                  >
                    <ShieldAlert size={11} />
                    <span>{tr(locale, 'confirmPermission')}</span>
                  </button>
                )}
                {primaryConv && (
                  <>
                    <button
                      type="button"
                      className="btn btn-xs"
                      onClick={() => onJump(primaryConv.conversationId)}
                      title={primaryConv.title || primaryConv.conversationId}
                    >
                      <ExternalLink size={11} />
                      <span>{tr(locale, 'openSession')}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost"
                      onClick={() => onJump(primaryConv.conversationId, { split: 'right' })}
                      aria-label={tr(locale, 'splitRight')}
                      title={tr(locale, 'splitRight')}
                    >
                      <Columns2 size={11} />
                    </button>
                  </>
                )}
                {!needsPerm && !openExecution && task.subgoalRollup.requiredRemaining === 0 && (
                  isRecurringActiveSchedule(task) ? (
                    <button
                      type="button"
                      className="btn btn-xs btn-primary"
                      onClick={() => (onAcceptScheduleCycle ?? onApproveAndClose)(task.id)}
                    >
                      <CheckCircle2 size={11} />
                      <span>{tr(locale, 'acceptRound')}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-xs btn-primary"
                      onClick={() => onApproveAndClose(task.id)}
                    >
                      <CheckCircle2 size={11} />
                      <span>{tr(locale, 'approveAndClose')}</span>
                    </button>
                  )
                )}
              </div>
              <span className="card-age">{ageText}</span>
            </div>
          )}

          {isActiveWithConv && primaryConv && (
            <div className="inbox-actions-row" onClick={(e) => e.stopPropagation()}>
              <div className="inbox-actions-btns">
                <button
                  type="button"
                  className="btn btn-xs"
                  onClick={() => onJump(primaryConv.conversationId)}
                  title={primaryConv.title || primaryConv.conversationId}
                >
                  <ExternalLink size={11} />
                  <span>{tr(locale, 'openSession')}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-xs btn-ghost"
                  onClick={() => onJump(primaryConv.conversationId, { split: 'right' })}
                  aria-label={tr(locale, 'splitRight')}
                  title={tr(locale, 'splitRight')}
                >
                  <Columns2 size={11} />
                  <span>{tr(locale, 'splitRight')}</span>
                </button>
              </div>
              <span className="card-age">{ageText}</span>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="focus-container" data-testid="focus-view">
      {/* Zone 1: Needs Attention Spotlight */}
      {needsYou.length > 0 && (
        <section className="focus-group focus-zone is-spotlight">
          <button
            type="button"
            className="focus-group-toggle is-zone-title"
            onClick={() => setOpenNeedsYou((v) => !v)}
          >
            {openNeedsYou ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span>{tr(locale, 'pendingHandle')}</span>
            <span className="kanban-count-pill is-warn tabular-nums">{needsYou.length}</span>
          </button>
          {openNeedsYou && (
            <div className="focus-timeline-list">
              {needsYou.map((t) => renderTimelineRow(t, true))}
            </div>
          )}
        </section>
      )}

      {/* Zone 2: Active / Paused Execution */}
      {inProgress.length > 0 && (
        <section className="focus-group focus-zone is-exec">
          <button
            type="button"
            className="focus-group-toggle is-zone-title"
            onClick={() => setOpenActive((v) => !v)}
          >
            {openActive ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span>{tr(locale, 'activeAndHold')}</span>
            <span className="kanban-count-pill is-active tabular-nums">{inProgress.length}</span>
          </button>
          {openActive && (
            <div className="focus-timeline-list">
              {inProgress.map((t) => renderTimelineRow(t, true))}
            </div>
          )}
        </section>
      )}

      {/* Zone 3: Today's Focus (48h DDL / Urgent / Pinned / Today Schedule) */}
      <section className="focus-group focus-zone is-schedule">
        <button
          type="button"
          className="focus-group-toggle is-zone-title"
          onClick={() => setOpenTodo((v) => !v)}
        >
          {openTodo ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span>{tr(locale, 'todayFocus')}</span>
          <span className="kanban-count-pill tabular-nums">{todayTodos.length}</span>
        </button>
        {openTodo && (
          todayTodos.length === 0 ? (
            <div className="empty-hint">{tr(locale, 'emptyNone')}</div>
          ) : (
            <div className="focus-timeline-list">
              {todayTodos.map((t) => renderTimelineRow(t, false))}
            </div>
          )
        )}
      </section>

      {/* Zone 4: Completed Today (Default Collapsed) */}
      {todayClosed.length > 0 && (
        <section className="focus-group focus-zone is-closed">
          <button
            type="button"
            className="focus-group-toggle is-zone-title"
            onClick={() => setOpenClosed((v) => !v)}
          >
            {openClosed ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span>{tr(locale, 'completedToday')}</span>
            <span className="kanban-count-pill tabular-nums">{todayClosed.length}</span>
          </button>
          {openClosed && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {todayClosed.map((task) => {
                const wsBadge = formatWorkspaceBadge(task, tr(locale, 'unboundBadge'))
                return (
                  <div
                    key={task.id}
                    className="focus-row-plain"
                    style={{ paddingLeft: 18 }}
                    onClick={() => onOpenTask(task.id)}
                    data-testid={`task-card-${task.id}`}
                  >
                    <div className="focus-row-main">
                      <div className="focus-row-content">
                        <button
                          type="button"
                          className="status-icon-btn"
                          aria-label={tr(locale, 'restore')}
                          onClick={(e) => {
                            e.stopPropagation()
                            onToggleManualComplete(task)
                          }}
                          style={{ marginTop: 2 }}
                        >
                          <StatusGlyph phase="closed" size={15} />
                        </button>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="focus-row-title-line">
                            <span className="focus-row-title">{task.title}</span>
                            {showWorkspaceTag && !wsBadge.isUnbound && (
                              <span className="ws-micro-tag">{wsBadge.label}</span>
                            )}
                          </div>
                          {task.subgoalRollup.total > 0 && (
                            <div className="focus-row-subtitle">
                              {task.subgoalRollup.done}/{task.subgoalRollup.total}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="focus-row-aside">
                        <button
                          type="button"
                          className="focus-ignore-btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            onToggleIgnore(task.id, true)
                          }}
                        >
                          {tr(locale, 'ignoreTask')}
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      )}

      {/* Bottom Quiet Pool Drawer (Later / Backlog / Undated / Snoozed) */}
      {quietPool.length > 0 && (
        <div className="quiet-pool-box" data-testid="quiet-pool-box">
          <button
            type="button"
            className="ignored-box-head"
            onClick={() => setOpenQuietPool((v) => !v)}
          >
            <span className="row-wrap">
              {effectivePoolOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span>
                {tr(locale, 'quietPoolTitle')} <span className="tabular-nums">{quietPool.length}</span>{' '}
                {tr(locale, 'ignoredUnit')}
              </span>
            </span>
          </button>
          {effectivePoolOpen && (
            <div className="quiet-pool-body">
              {primaryEmpty && (
                <div className="quiet-pool-empty-hint">{tr(locale, 'quietPoolEmptyHint')}</div>
              )}
              {quietPool.map((task) => {
                const snoozed = isTaskSnoozed(task, now)
                const wsBadge = formatWorkspaceBadge(task, '')
                const tick = task.dueAt !== undefined ? formatTimelineTick(task.dueAt, now, locale) : null
                const createdStamp = formatCreatedStamp(task.createdAt, now, locale)
                return (
                  <div
                    key={task.id}
                    className="quiet-pool-row"
                    onClick={() => onOpenTask(task.id)}
                    data-testid={`quiet-pool-row-${task.id}`}
                  >
                    <div className="quiet-pool-row-main">
                      <StatusGlyph phase={task.phase} subPhase={task.subPhase} size={13} />
                      <span className="quiet-pool-row-title">{task.title}</span>
                      {task.phase === 'todo' && task.subPhase === 'draft' && (
                        <span className="badge badge-warn">{tr(locale, 'draftBadge')}</span>
                      )}
                      {wsBadge.label && <span className="ws-micro-tag">{wsBadge.label}</span>}
                      {tick ? (
                        <span className="badge tabular-nums">
                          {tick.primary}
                          {tick.secondary ? ` ${tick.secondary}` : ''}
                        </span>
                      ) : (
                        <span
                          className={`badge tabular-nums${createdStamp.isStale ? ' badge-warn' : ''}`}
                          title={createdStamp.full}
                          data-testid={`created-stamp-${task.id}`}
                        >
                          {createdStamp.label}
                        </span>
                      )}
                      {snoozed && task.userMarks?.snoozedUntil && (
                        <span className="badge badge-warn tabular-nums">
                          {formatSnoozeUntilTag(task.userMarks.snoozedUntil, locale)}
                        </span>
                      )}
                    </div>
                    <div className="row-wrap" onClick={(e) => e.stopPropagation()}>
                      {task.phase === 'todo' && task.subPhase === 'draft' && onApproveDraft && (
                        <button
                          type="button"
                          className="btn btn-xs btn-ok"
                          data-testid={`quiet-approve-draft-${task.id}`}
                          title={`${tr(locale, 'approveDraft')} (A)`}
                          onClick={() => onApproveDraft(task)}
                        >
                          <Check size={10} />
                          <span>{locale === 'zh' ? '通过' : 'Approve'}</span>
                        </button>
                      )}
                      {snoozed ? (
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost"
                          onClick={() => onSnoozeTask(task.id, null)}
                        >
                          {tr(locale, 'unsnooze')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost"
                          title={tr(locale, 'pinToFocus')}
                          onClick={() => onTogglePin(task.id, true)}
                        >
                          <Star size={11} />
                          <span>{locale === 'zh' ? '置顶' : 'Pin'}</span>
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Ignored Box (Bottom Disclosure) */}
      {ignored.length > 0 && (
        <div className="ignored-box" data-testid="ignored-box">
          <button
            type="button"
            className="ignored-box-head"
            onClick={() => setOpenIgnored((v) => !v)}
          >
            <span>
              {tr(locale, 'ignoredSection')} {ignored.length} {tr(locale, 'ignoredUnit')}
            </span>
            {openIgnored ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          {openIgnored &&
            ignored.map((task) => (
              <div key={task.id} className="ignored-row">
                <span
                  style={{
                    cursor: 'pointer',
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  onClick={() => onOpenTask(task.id)}
                >
                  {task.title}
                </span>
                <div className="row-wrap">
                  <span style={{ fontSize: 11 }}>
                    {formatRelativeAge(task.updatedAt || task.createdAt, now, locale)}
                  </span>
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    onClick={() => onToggleIgnore(task.id, false)}
                  >
                    {tr(locale, 'recover')}
                  </button>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
