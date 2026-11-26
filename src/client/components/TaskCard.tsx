import type { CSSProperties } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Check, CheckCircle2, ChevronUp, ChevronsUp, Columns2, ExternalLink, GitBranch, ShieldAlert, Timer } from 'lucide-react'
import { requiresPermissionConfirmation } from '../../core/handover.ts'
import { hasOpenExecution, type TaskPermission, type TaskRecord } from '../../core/types.ts'
import { formatPhaseSubPhaseLabel, tr, type Locale } from '../i18n.ts'
import { formatCreatedStamp, formatRelativeAge, formatShortDue, formatWorkspaceBadge, latestPrimaryConversation } from '../utils.ts'
import { isRecurringActiveSchedule, ScheduleMicroBadge } from './ScheduleComposer.tsx'
import { formatElapsedTimer } from '../viewFilters.ts'
import { StatusGlyph } from './StatusGlyph.tsx'

export function resolveTaskTintClass(task: TaskRecord, needsPerm: boolean): string {
  if (task.phase === 'needs_you') {
    if (needsPerm || task.subPhase === 'needs_input' || task.subPhase === 'reminder_due') return 'tint-warn'
    if (task.subPhase === 'blocked') return 'tint-danger'
    return 'tint-ok'
  }
  if (task.phase === 'active') return 'tint-active'
  if (task.phase === 'on_hold') return 'tint-danger'
  return ''
}

export function resolveNeedsYouBadgeClass(task: TaskRecord, needsPerm: boolean): string {
  if (needsPerm || task.subPhase === 'needs_input' || task.subPhase === 'reminder_due') return 'badge-warn'
  if (task.subPhase === 'blocked') return 'badge-danger'
  return 'badge-ok'
}

export interface TaskCardProps {
  task: TaskRecord
  locale: Locale
  sessionDefaultPermission: TaskPermission
  now: number
  compact?: boolean
  showWorkspaceTag?: boolean
  interactiveWrapper?: boolean
  onOpen: (taskId: string) => void
  onFilterWorkspace: (workspaceKey: string) => void
  onToggleManualComplete?: (task: TaskRecord) => void
  onJump?: (conversationId: string, options?: { split?: 'right' }) => void
  onConfirmPermission?: (taskId: string) => void
  onApproveAndClose?: (taskId: string) => void
  onApproveDraft?: (task: TaskRecord) => void
  onAcceptScheduleCycle?: (taskId: string) => void
}

export function TaskCard({
  task,
  locale,
  sessionDefaultPermission,
  now,
  compact = false,
  showWorkspaceTag = true,
  interactiveWrapper = true,
  onOpen,
  onFilterWorkspace,
  onToggleManualComplete,
  onJump,
  onConfirmPermission,
  onApproveAndClose,
  onApproveDraft,
  onAcceptScheduleCycle,
}: TaskCardProps) {
  const needsPerm = requiresPermissionConfirmation(task, sessionDefaultPermission)
  const openExecution = hasOpenExecution(task)
  const primaryConv = latestPrimaryConversation(task)
  const rollup = task.subgoalRollup
  const wsBadge = formatWorkspaceBadge(task, tr(locale, 'unboundBadge'))
  const isIgnored = Boolean(task.userMarks?.ignoredAt)
  const dueInfo =
    task.dueAt !== undefined && task.phase !== 'closed' ? formatShortDue(task.dueAt, now, locale) : null
  const ageText = formatRelativeAge(task.updatedAt || task.createdAt, now, locale)

  const canManualToggle = Boolean(
    onToggleManualComplete && !needsPerm && !openExecution && task.phase !== 'active',
  )

  const handleToggleCircle = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (canManualToggle && onToggleManualComplete) {
      onToggleManualComplete(task)
    }
  }

  const interactiveProps = interactiveWrapper
    ? {
        tabIndex: 0,
        'aria-label': task.title,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            onOpen(task.id)
          }
        },
      }
    : {}

  const tintClass = resolveTaskTintClass(task, needsPerm)

  // Hóng InboxCard: ONLY needs_you cards expose compact action buttons
  if (task.phase === 'needs_you' && !compact) {
    const statusLabel = formatPhaseSubPhaseLabel(task.phase, task.subPhase, locale)
    return (
      <div
        className={`task-card is-inbox${tintClass ? ` ${tintClass}` : ''}${isIgnored ? ' is-ignored' : ''}`}
        onClick={() => onOpen(task.id)}
        {...interactiveProps}
        data-testid={`task-card-${task.id}`}
      >
        <div className="card-main-row">
          <div className="card-title-group">
            <span style={{ marginTop: 2 }}>
              <StatusGlyph phase={task.phase} subPhase={task.subPhase} size={15} />
            </span>
            <div className="card-title">{task.title}</div>
          </div>
          <div className="card-right-tags">
            {isIgnored && <span className="badge">{tr(locale, 'ignoredPill')}</span>}
            <span className={`badge ${resolveNeedsYouBadgeClass(task, needsPerm)}`}>{statusLabel}</span>
          </div>
        </div>

        {(task.blockedReason || task.nextAction || dueInfo || task.schedule || task.reminderAt !== undefined || (showWorkspaceTag && !wsBadge.isUnbound) || rollup.total > 0) && (
          <div className="card-footer-left">
            {rollup.total > 0 && (
              <span className="mini-progress-wrap">
                <span className="mini-progress-track">
                  <span
                    className="mini-progress-fill"
                    style={{ width: `${Math.round((rollup.done / rollup.total) * 100)}%` }}
                  />
                </span>
                <span>
                  {rollup.done}/{rollup.total}
                </span>
              </span>
            )}
            {dueInfo && (
              <span className={dueInfo.isOverdue ? 'text-danger' : 'text-warn'} style={{ fontSize: 11 }}>
                {dueInfo.text}
              </span>
            )}
            <ScheduleMicroBadge task={task} locale={locale} now={now} />
            {showWorkspaceTag && !wsBadge.isUnbound && (
              <button
                type="button"
                className="ws-micro-tag"
                title={task.workspacePath || wsBadge.label}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  onFilterWorkspace(wsBadge.filterKey)
                }}
              >
                {wsBadge.label}
              </button>
            )}
            {(task.blockedReason || task.nextAction) && (
              <span className="card-subtext" title={task.blockedReason || task.nextAction}>
                {task.blockedReason || task.nextAction}
              </span>
            )}
          </div>
        )}

        <div
          className="inbox-actions-row"
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="inbox-actions-btns">
            {needsPerm && onConfirmPermission && (
              <button
                type="button"
                className="btn btn-xs btn-primary"
                onClick={() => onConfirmPermission(task.id)}
              >
                <ShieldAlert size={11} />
                <span>{tr(locale, 'confirmPermission')}</span>
              </button>
            )}

            {primaryConv && onJump && (
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

            {!needsPerm && !openExecution && rollup.requiredRemaining === 0 && (
              isRecurringActiveSchedule(task) && (onAcceptScheduleCycle || onApproveAndClose) ? (
                <button
                  type="button"
                  className="btn btn-xs btn-primary"
                  onClick={() => (onAcceptScheduleCycle ?? onApproveAndClose)!(task.id)}
                >
                  <CheckCircle2 size={11} />
                  <span>{tr(locale, 'acceptRound')}</span>
                </button>
              ) : onApproveAndClose ? (
                <button
                  type="button"
                  className="btn btn-xs btn-primary"
                  onClick={() => onApproveAndClose(task.id)}
                >
                  <CheckCircle2 size={11} />
                  <span>{tr(locale, 'approveAndClose')}</span>
                </button>
              ) : null
            )}
          </div>

          <span className="card-age">{ageText}</span>
        </div>
      </div>
    )
  }

  // Restrained Card: Zero action buttons on todo/on_hold/closed; active adds subtle telemetry & optional jump
  const pct = rollup.total > 0 ? Math.round((rollup.done / rollup.total) * 100) : 0
  const isActivePhase = task.phase === 'active'
  const activeExec = isActivePhase ? [...task.executions].reverse().find((e) => e.endedAt === undefined) : undefined
  const elapsedText =
    isActivePhase && !compact
      ? formatElapsedTimer(activeExec?.startedAt ?? task.updatedAt ?? task.createdAt, now)
      : null
  const nextOpenSubgoal =
    isActivePhase && !compact
      ? task.subgoals.find((sg) => sg.status === 'in_progress') ?? task.subgoals.find((sg) => sg.status === 'open')
      : undefined

  return (
    <div
      className={`task-card${tintClass ? ` ${tintClass}` : ''}${isIgnored ? ' is-ignored' : ''}`}
      onClick={() => onOpen(task.id)}
      {...interactiveProps}
      data-testid={`task-card-${task.id}`}
    >
      <div className="card-main-row">
        <div className="card-title-group">
          <button
            type="button"
            className="status-icon-btn"
            disabled={!canManualToggle}
            aria-label={task.phase === 'closed' ? tr(locale, 'restore') : tr(locale, 'approvePass')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={handleToggleCircle}
            style={{ marginTop: 1 }}
          >
            <StatusGlyph phase={task.phase} subPhase={task.subPhase} size={15} />
          </button>
          <div className="card-title">{task.title}</div>
        </div>

        <div className="card-right-tags">
          {elapsedText && (
            <span className="badge card-elapsed-pill tabular-nums" data-testid={`elapsed-${task.id}`}>
              <Timer size={10} aria-hidden="true" />
              <span>{elapsedText}</span>
            </span>
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
          {isIgnored && <span className="badge">{tr(locale, 'ignoredPill')}</span>}
          {task.phase === 'todo' && task.subPhase === 'draft' && (
            <span className="badge badge-warn" title={tr(locale, 'draftBanner')}>
              {tr(locale, 'draftBadge')}
            </span>
          )}
          {task.phase === 'on_hold' && <span className="badge badge-danger">{tr(locale, 'blockedPill')}</span>}
        </div>
      </div>

      {!compact && (task.blockedReason || task.nextAction) && (
        <div className="card-subtext" title={task.blockedReason || task.nextAction}>
          {task.blockedReason || task.nextAction}
        </div>
      )}

      {nextOpenSubgoal && (
        <div className="card-subtext card-next-subgoal" title={nextOpenSubgoal.title}>
          ↳ {rollup.done}/{rollup.total}: {nextOpenSubgoal.title}
        </div>
      )}

      <div className="card-footer-row">
        <div className="card-footer-left">
          {rollup.total > 0 && (
            <span className="mini-progress-wrap">
              <span className="mini-progress-track">
                <span className="mini-progress-fill" style={{ width: `${pct}%` }} />
              </span>
              <span>
                {rollup.done}/{rollup.total}
              </span>
            </span>
          )}
          {isActivePhase && task.worktreeBranch && (
            <span className="badge card-worktree-badge" title={task.worktreePath || task.worktreeBranch}>
              <GitBranch size={10} aria-hidden="true" />
              <span>{task.worktreeBranch}</span>
            </span>
          )}
          {dueInfo ? (
            <span
              className={dueInfo.isOverdue ? 'text-danger' : dueInfo.isSoon ? 'text-warn' : 'text-muted'}
              style={{ fontSize: 11 }}
            >
              {dueInfo.text}
            </span>
          ) : (
            task.phase !== 'closed' && (() => {
              const createdStamp = formatCreatedStamp(task.createdAt, now, locale)
              return (
                <span
                  className={createdStamp.isStale ? 'text-warn' : 'text-muted'}
                  style={{ fontSize: 11 }}
                  title={createdStamp.full}
                  data-testid={`created-stamp-${task.id}`}
                >
                  {createdStamp.label}
                </span>
              )
            })()
          )}
          <ScheduleMicroBadge task={task} locale={locale} now={now} />
          {showWorkspaceTag && !wsBadge.isUnbound && (
            <button
              type="button"
              className="ws-micro-tag"
              title={task.workspacePath || wsBadge.label}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onFilterWorkspace(wsBadge.filterKey)
              }}
            >
              {wsBadge.label}
            </button>
          )}
        </div>
        <div className="row-wrap" style={{ gap: 4, flexShrink: 0 }}>
          {task.phase === 'todo' && task.subPhase === 'draft' && !compact && onApproveDraft && (
            <button
              type="button"
              className="btn btn-xs btn-ok"
              data-testid={`card-approve-draft-${task.id}`}
              title={`${tr(locale, 'approveDraft')} (A)`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onApproveDraft(task)
              }}
            >
              <Check size={10} />
              <span>{locale === 'zh' ? '通过' : 'Approve'}</span>
            </button>
          )}
          {isActivePhase && !compact && primaryConv && onJump && (
            <button
              type="button"
              className="btn btn-xs btn-ghost card-active-jump-btn"
              title={tr(locale, 'openSession')}
              aria-label={tr(locale, 'openSession')}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onJump(primaryConv.conversationId)
              }}
            >
              ↗
            </button>
          )}
          <span className="card-age">{ageText}</span>
        </div>
      </div>
    </div>
  )
}

export function SortableTaskCard(props: TaskCardProps) {
  const dragDisabled = hasOpenExecution(props.task)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.task.id,
    disabled: dragDisabled,
    data: { task: props.task, phase: props.task.phase },
  })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={isDragging ? 'is-dragging' : undefined}
      {...attributes}
      role={undefined}
      aria-label={props.task.title}
      {...listeners}
    >
      <TaskCard {...props} interactiveWrapper={false} />
    </div>
  )
}
