import { useEffect, useState, type ReactNode } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { ChevronDown, ChevronRight, Play, ShieldAlert } from 'lucide-react'
import { requiresPermissionConfirmation } from '../../core/handover.ts'
import type { TaskPermission, TaskPhase, TaskRecord } from '../../core/types.ts'
import { tr, type Locale } from '../i18n.ts'
import { bucketClosedTasks } from '../utils.ts'
import { filterKanbanTasks } from '../viewFilters.ts'
import type { ListGroupBy } from './ListView.tsx'
import { StatusGlyph } from './StatusGlyph.tsx'
import { SortableTaskCard, TaskCard } from './TaskCard.tsx'

export type BoardLayoutTier = 'narrow' | 'medium' | 'wide'

interface KanbanViewProps {
  tasks: TaskRecord[]
  locale: Locale
  layoutTier: BoardLayoutTier
  sessionDefaultPermission: TaskPermission
  maxConcurrentLaunches?: number
  now: number
  showWorkspaceTag?: boolean
  onOpenTask: (taskId: string) => void
  onFilterWorkspace: (wsKey: string) => void
  onToggleManualComplete?: (task: TaskRecord) => void
  onJump: (conversationId: string, options?: { split?: 'right' }) => void
  onConfirmPermission: (taskId: string) => void
  onApproveAndClose: (taskId: string) => void
  onAcceptScheduleCycle?: (taskId: string) => void
  onMovePhase: (taskId: string, targetPhase: TaskPhase, sortOrder?: number) => void
  onReorderPhase: (phase: TaskPhase, orderedIds: string[]) => void
  onDispatchTask?: (taskId: string) => Promise<void> | void
  onConfirmAndDispatch?: (taskId: string) => Promise<void> | void
  onSwitchToList?: (groupBy?: ListGroupBy) => void
}

function DroppableZone({
  id,
  className,
  disabled = false,
  children,
}: {
  id: string
  className: string
  disabled?: boolean
  children: ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled })
  return (
    <div
      ref={setNodeRef}
      className={`${className}${!disabled && isOver ? ' is-over' : ''}${disabled ? ' is-drop-disabled' : ''}`}
      data-dropzone={id}
    >
      {children}
    </div>
  )
}

export function KanbanView({
  tasks,
  locale,
  layoutTier,
  sessionDefaultPermission,
  maxConcurrentLaunches = 3,
  now,
  showWorkspaceTag = true,
  onOpenTask,
  onFilterWorkspace,
  onToggleManualComplete,
  onJump,
  onConfirmPermission,
  onApproveAndClose,
  onAcceptScheduleCycle,
  onMovePhase,
  onReorderPhase,
  onDispatchTask,
  onConfirmAndDispatch,
  onSwitchToList,
}: KanbanViewProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [collapseClosed, setCollapseClosed] = useState(true)
  const [pendingLaunch, setPendingLaunch] = useState<{ taskId: string; sortOrder?: number } | null>(null)
  const [launching, setLaunching] = useState(false)
  const [tickSec, setTickSec] = useState(0)

  const {
    needsYou,
    active,
    onHold,
    readyTodos,
    recentClosed,
    backlogCount,
    scheduledFutureCount,
    olderClosedCount,
  } = filterKanbanTasks(tasks, now)

  useEffect(() => {
    setTickSec(0)
  }, [now])

  useEffect(() => {
    if (active.length === 0) return
    const timer = setInterval(() => {
      setTickSec((s) => s + 1)
    }, 1000)
    return () => clearInterval(timer)
  }, [active.length])

  const effectiveNow = now + tickSec * 1000

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const byPhase: Record<TaskPhase, TaskRecord[]> = {
    needs_you: needsYou,
    active,
    on_hold: onHold,
    todo: readyTodos,
    closed: recentClosed,
  }
  const closedBuckets = bucketClosedTasks(byPhase.closed, now)

  const draggingTask = draggingId ? tasks.find((t) => t.id === draggingId) : undefined
  const pendingLaunchTask = pendingLaunch ? tasks.find((t) => t.id === pendingLaunch.taskId) : undefined

  const resolveDropPhase = (overId: string): TaskPhase | undefined => {
    if (overId === 'col:needs_you') return 'needs_you'
    if (overId === 'col:active') return 'active'
    if (overId === 'col:on_hold') return undefined
    if (overId === 'col:todo') return 'todo'
    if (overId === 'col:closed') return 'closed'
    const overTask = tasks.find((t) => t.id === overId)
    if (!overTask || overTask.phase === 'on_hold') return undefined
    return overTask.phase
  }

  const handleDragStart = (event: DragStartEvent) => {
    setDraggingId(String(event.active.id))
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setDraggingId(null)
    const { active: dragActive, over } = event
    if (!over) return
    const activeId = String(dragActive.id)
    const overId = String(over.id)
    const activeTask = tasks.find((t) => t.id === activeId)
    if (!activeTask) return

    const targetPhase = resolveDropPhase(overId)
    if (!targetPhase || targetPhase === 'on_hold') return

    if (activeTask.phase === targetPhase) {
      const list = byPhase[targetPhase]
      const oldIdx = list.findIndex((t) => t.id === activeId)
      const newIdx = list.findIndex((t) => t.id === overId)
      if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx) {
        const next = [...list]
        const [moved] = next.splice(oldIdx, 1)
        next.splice(newIdx, 0, moved)
        onReorderPhase(
          targetPhase,
          next.map((t) => t.id),
        )
      }
      return
    }

    const targetIdx = byPhase[targetPhase].findIndex((t) => t.id === overId)
    const sortOrder = targetIdx >= 0 ? targetIdx : undefined

    if (activeTask.phase === 'todo' && targetPhase === 'active') {
      setPendingLaunch({ taskId: activeTask.id, sortOrder })
      return
    }

    onMovePhase(activeTask.id, targetPhase, sortOrder)
  }

  const renderSortable = (task: TaskRecord, compact = false) => (
    <SortableTaskCard
      key={task.id}
      task={task}
      locale={locale}
      sessionDefaultPermission={sessionDefaultPermission}
      now={task.phase === 'active' ? effectiveNow : now}
      compact={compact}
      showWorkspaceTag={showWorkspaceTag}
      onOpen={onOpenTask}
      onFilterWorkspace={onFilterWorkspace}
      onToggleManualComplete={onToggleManualComplete}
      onJump={onJump}
      onConfirmPermission={onConfirmPermission}
      onApproveAndClose={onApproveAndClose}
      onAcceptScheduleCycle={onAcceptScheduleCycle}
    />
  )

  const isWide = layoutTier === 'wide'
  const pendingHasWorkspace = Boolean(pendingLaunchTask?.workspacePath || pendingLaunchTask?.workspaceId)
  const pendingNeedsPerm = pendingLaunchTask
    ? requiresPermissionConfirmation(pendingLaunchTask, sessionDefaultPermission)
    : false

  const hiddenSummaryParts: string[] = []
  if (backlogCount > 0) {
    hiddenSummaryParts.push(
      locale === 'zh' ? `💡 想法池 Backlog (${backlogCount})` : `💡 Backlog (${backlogCount})`,
    )
  }
  if (scheduledFutureCount > 0) {
    hiddenSummaryParts.push(
      locale === 'zh' ? `⏰ 定时守候 (${scheduledFutureCount})` : `⏰ Scheduled (${scheduledFutureCount})`,
    )
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="kanban-board" data-testid="kanban-view">
        {/* Tier 1: Needs Confirmation (Spotlight Action Inbox) */}
        <section className={`kanban-section kanban-zone is-inbox-zone${byPhase.needs_you.length === 0 ? ' is-quiet' : ''}`}>
          <div className="kanban-section-head">
            <span className="kanban-section-title is-spotlight">
              <StatusGlyph phase="needs_you" subPhase="needs_input" size={15} />
              <span>{tr(locale, 'needsYou')}</span>
              <span className="kanban-count-pill is-warn tabular-nums">{byPhase.needs_you.length}</span>
            </span>
            {byPhase.needs_you.length > 0 && (
              <span className="kanban-section-hint">
                {locale === 'zh' ? '优先处理 · 等待你的确认或验收' : 'Priority · Awaiting your review'}
              </span>
            )}
          </div>
          <DroppableZone id="col:needs_you" className="kanban-drop-box is-borderless">
            <SortableContext items={byPhase.needs_you.map((t) => t.id)} strategy={verticalListSortingStrategy}>
              {byPhase.needs_you.length === 0 ? (
                <div className="kanban-empty-lane is-compact">{tr(locale, 'emptyNone')}</div>
              ) : (
                <div className={isWide ? 'kanban-inbox-grid' : 'kanban-lane-stack'}>
                  {byPhase.needs_you.map((t) => renderSortable(t))}
                </div>
              )}
            </SortableContext>
          </DroppableZone>
        </section>

        {/* Tier 2: Live Execution Split (Active | On Hold) */}
        <div className={`kanban-tier-2 kanban-zone is-exec-zone ${isWide ? 'is-wide' : 'is-stacked'}`}>
          <section className="kanban-section">
            <div className="kanban-section-head">
              <span className="kanban-section-title">
                <StatusGlyph phase="active" size={14} animate={byPhase.active.length > 0} />
                <span>{tr(locale, 'active')}</span>
                <span className="kanban-count-pill is-active tabular-nums">{byPhase.active.length}</span>
              </span>
              <span className="kanban-count-pill is-active kanban-concurrency-pill tabular-nums" data-testid="kanban-concurrency-pill">
                {locale === 'zh'
                  ? `并发 ${byPhase.active.length}/${maxConcurrentLaunches}`
                  : `Running ${byPhase.active.length}/${maxConcurrentLaunches}`}
              </span>
            </div>

            {pendingLaunchTask && pendingLaunch && (
              <div className="kanban-launch-strip" data-testid="kanban-launch-strip">
                <div className="kanban-launch-strip-title">
                  {locale === 'zh'
                    ? `将「${pendingLaunchTask.title}」移入在做：`
                    : `Move "${pendingLaunchTask.title}" to In Progress:`}
                  {!pendingHasWorkspace && (
                    <span className="badge badge-warn" style={{ marginLeft: 6 }}>
                      {tr(locale, 'noWorkspace')}
                    </span>
                  )}
                </div>
                <div className="kanban-launch-strip-actions">
                  {pendingHasWorkspace ? (
                    pendingNeedsPerm ? (
                      <button
                        type="button"
                        className="btn btn-xs btn-primary"
                        disabled={launching}
                        onClick={async () => {
                          setLaunching(true)
                          try {
                            await onConfirmAndDispatch?.(pendingLaunchTask.id)
                          } finally {
                            setLaunching(false)
                            setPendingLaunch(null)
                          }
                        }}
                      >
                        <ShieldAlert size={11} />
                        <span>{locale === 'zh' ? '▶ 确认提权并启动 AI' : '▶ Confirm Permission & Start AI'}</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-xs btn-primary"
                        disabled={launching}
                        onClick={async () => {
                          setLaunching(true)
                          try {
                            await onDispatchTask?.(pendingLaunchTask.id)
                          } finally {
                            setLaunching(false)
                            setPendingLaunch(null)
                          }
                        }}
                      >
                        <Play size={11} />
                        <span>{locale === 'zh' ? '▶ 启动 AI 会话' : '▶ Start AI Session'}</span>
                      </button>
                    )
                  ) : (
                    <>
                      <button type="button" className="btn btn-xs btn-primary" disabled>
                        <Play size={11} />
                        <span>{locale === 'zh' ? '▶ 启动 AI 会话' : '▶ Start AI Session'}</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-xs"
                        onClick={() => {
                          onOpenTask(pendingLaunchTask.id)
                          setPendingLaunch(null)
                        }}
                      >
                        {locale === 'zh' ? '打开详情绑定' : 'Open Details'}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="btn btn-xs"
                    disabled={launching}
                    onClick={() => {
                      onMovePhase(pendingLaunchTask.id, 'active', pendingLaunch.sortOrder)
                      setPendingLaunch(null)
                    }}
                  >
                    {locale === 'zh' ? '仅移至在做 (人工)' : 'Move Only (Manual)'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    disabled={launching}
                    onClick={() => setPendingLaunch(null)}
                  >
                    {tr(locale, 'cancel')}
                  </button>
                </div>
              </div>
            )}

            <DroppableZone
              id="col:active"
              className={`kanban-drop-box ${byPhase.active.length === 0 ? 'is-empty' : 'is-borderless'}`}
            >
              <SortableContext items={byPhase.active.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                {byPhase.active.length === 0 ? (
                  <div className="kanban-empty-lane">{tr(locale, 'emptyNone')}</div>
                ) : (
                  <div className="kanban-lane-stack">
                    {byPhase.active.map((t) => renderSortable(t))}
                  </div>
                )}
              </SortableContext>
            </DroppableZone>
          </section>

          <section className="kanban-section kanban-exec-hold">
            <div className="kanban-section-head">
              <span className="kanban-section-title">
                <StatusGlyph phase="on_hold" size={14} />
                <span>{tr(locale, 'onHold')}</span>
                <span className="kanban-count-pill is-danger tabular-nums">{byPhase.on_hold.length}</span>
              </span>
              <span className="kanban-section-hint">{tr(locale, 'onHoldSystemManaged')}</span>
            </div>
            <DroppableZone
              id="col:on_hold"
              className={`kanban-drop-box lane-on-hold ${byPhase.on_hold.length === 0 ? 'is-empty' : 'is-borderless'}`}
              disabled
            >
              <SortableContext items={byPhase.on_hold.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                {byPhase.on_hold.length === 0 ? (
                  <div className="kanban-empty-lane">{tr(locale, 'emptyNone')}</div>
                ) : (
                  <div className="kanban-lane-stack">
                    {byPhase.on_hold.map((t) => renderSortable(t))}
                  </div>
                )}
              </SortableContext>
            </DroppableZone>
          </section>
        </div>

        {/* Tier 3: Ready Todo Pipeline */}
        <section className="kanban-section kanban-zone is-todo-zone">
          <div className="kanban-section-head">
            <span className="kanban-section-title">
              <StatusGlyph phase="todo" size={14} />
              <span>{locale === 'zh' ? '待启动 Ready' : 'Ready to Start'}</span>
              <span className="kanban-count-pill tabular-nums">{byPhase.todo.length}</span>
            </span>
            <span className="kanban-section-hint">
              {locale === 'zh' ? '拖拽至「在做」可拉起会话' : 'Drag to In Progress to launch'}
            </span>
          </div>

          {hiddenSummaryParts.length > 0 && (
            <div className="kanban-hidden-summary" data-testid="kanban-hidden-summary">
              <span>{hiddenSummaryParts.join(' · ')}</span>
              {onSwitchToList && (
                <button
                  type="button"
                  className="btn btn-xs btn-ghost"
                  onClick={() =>
                    onSwitchToList(backlogCount === 0 && scheduledFutureCount > 0 ? 'schedule' : 'status')
                  }
                >
                  {locale === 'zh' ? '前往列表管理 →' : 'Manage in List →'}
                </button>
              )}
            </div>
          )}

          <DroppableZone id="col:todo" className="kanban-drop-box is-borderless">
            <SortableContext items={byPhase.todo.map((t) => t.id)} strategy={verticalListSortingStrategy}>
              {byPhase.todo.length === 0 ? (
                <div className="kanban-empty-lane">{tr(locale, 'emptyNone')}</div>
              ) : (
                <div className={isWide ? 'kanban-todo-grid' : 'kanban-lane-stack'}>
                  {byPhase.todo.map((t) => renderSortable(t))}
                </div>
              )}
            </SortableContext>
          </DroppableZone>
        </section>

        {/* Tier 4: Recent 7d Completed Disclosure */}
        <section className="kanban-section kanban-zone is-closed-zone">
          <DroppableZone id="col:closed" className="kanban-drop-box is-borderless">
            <div className="kanban-section-head">
              <button
                type="button"
                className="focus-group-toggle"
                aria-label={collapseClosed ? 'Expand archive' : 'Collapse archive'}
                onClick={() => setCollapseClosed((c) => !c)}
              >
                {collapseClosed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <span>{tr(locale, 'recent7dClosed')}</span>
                <span className="kanban-count-pill tabular-nums">{byPhase.closed.length}</span>
              </button>
              {olderClosedCount > 0 && onSwitchToList && (
                <button
                  type="button"
                  className="btn btn-xs btn-ghost kanban-older-link"
                  onClick={() => onSwitchToList('status')}
                >
                  {locale === 'zh'
                    ? `查看更早 ${olderClosedCount} 条历史记录 →`
                    : `View ${olderClosedCount} older items →`}
                </button>
              )}
            </div>
            {!collapseClosed && (
              <SortableContext items={byPhase.closed.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                <div className="kanban-closed-body">
                  {byPhase.closed.length === 0 ? (
                    <div className="kanban-empty-lane">{tr(locale, 'emptyNone')}</div>
                  ) : (
                    closedBuckets.map(({ bucket, tasks: bucketTasks }) => (
                      <div key={bucket} className="closed-bucket">
                        <div className="sublane-label">
                          {tr(locale, bucket)} ({bucketTasks.length})
                        </div>
                        <div className={isWide ? 'kanban-todo-grid' : 'kanban-lane-stack'}>
                          {bucketTasks.map((t) => renderSortable(t, true))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </SortableContext>
            )}
          </DroppableZone>
        </section>
      </div>

      <DragOverlay>
        {draggingTask ? (
          <TaskCard
            task={draggingTask}
            locale={locale}
            sessionDefaultPermission={sessionDefaultPermission}
            now={draggingTask.phase === 'active' ? effectiveNow : now}
            showWorkspaceTag={showWorkspaceTag}
            onOpen={() => {}}
            onFilterWorkspace={() => {}}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
