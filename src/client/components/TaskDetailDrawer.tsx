import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  Bell,
  Bot,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  Columns2,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  FolderGit2,
  GitBranch,
  GripVertical,
  Link2,
  Lock,
  MessageSquare,
  MessageSquareReply,
  Play,
  Plus,
  RotateCcw,
  Send,
  ShieldAlert,
  Sliders,
  Sparkles,
  Star,
  Trash2,
  Unlock,
  User,
  X,
} from 'lucide-react'
import { parseFreezeRequest } from '../../core/freeze.ts'
import { requiresPermissionConfirmation } from '../../core/handover.ts'
import {
  hasOpenExecution,
  type ConversationLink,
  type ConversationRole,
  type DiscoveredConversation,
  type SubgoalRecord,
  type SubgoalStatus,
  type TaskEventRecord,
  type TaskPermission,
  type TaskPhase,
  type TaskPriority,
  type TaskRecord,
  type TaskRefKind,
  type TaskSubPhase,
  type WorkspaceRecord,
} from '../../core/types.ts'
import { isPathEqualOrInside, matchWorkspaceForPath, pathComparisonKey } from '../../core/workspace.ts'
import {
  boardApi,
  getSidecar,
  type ClientTaskRecord,
  type TaskCommentRecord,
  type WorktreeDiffResponse,
} from '../api.ts'
import {
  formatConversationRole,
  formatPhaseLabel,
  formatPhaseSubPhaseLabel,
  formatPriorityLabel,
  tr,
  type Locale,
} from '../i18n.ts'
import {
  buildWorkspaceFolderChoices,
  collectWorkspaceFolders,
  dateTimeLocalToEpoch,
  decodeWorkspaceFolderValue,
  epochToDateTimeLocal,
  formatCreatedStamp,
  fsPathToFileUri,
  isAbsoluteFsPath,
  isSafeExternalUrl,
  latestPrimaryConversation,
  latestSubgoalConversation,
  pathBasename,
} from '../utils.ts'
import { MarkdownText } from './MarkdownText.tsx'
import { RefPreviewModal, type PreviewData } from './RefPreviewModal.tsx'
import { isRecurringActiveSchedule, TaskScheduleBar } from './ScheduleComposer.tsx'
import { StatusGlyph } from './StatusGlyph.tsx'
import { computeSnoozeTarget, isTaskSnoozed } from '../viewFilters.ts'

const SUBPHASES_BY_PHASE: Record<TaskPhase, readonly TaskSubPhase[]> = {
  needs_you: ['review', 'blocked', 'needs_input', 'permission_pending', 'reminder_due'],
  active: ['running', 'working'],
  on_hold: ['paused', 'waiting'],
  todo: ['draft', 'ready', 'backlog'],
  closed: ['done', 'cancelled'],
}

function extractShortMemo(raw: string): { memo: string; hasMore: boolean } {
  const trimmed = raw.trim()
  if (!trimmed) return { memo: '', hasMore: false }
  const plain = trimmed
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  const sentences =
    plain
      .match(/[^。！？.!?\n]+[。！？.!?]?/g)
      ?.map((s) => s.trim())
      .filter(Boolean) ?? [plain]
  if (sentences.length <= 3 && plain.length <= 180) {
    return { memo: trimmed, hasMore: false }
  }
  const shortText = sentences.slice(0, 3).join(' ')
  const clipped = shortText.length > 180 ? `${shortText.slice(0, 177).trim()}…` : shortText
  return { memo: clipped, hasMore: true }
}

function SortableSubgoalItem({
  subgoal,
  linkedConv,
  locale,
  busy,
  disabledDispatch,
  onToggleStatus,
  onToggleRequired,
  onDispatchSubgoal,
  onJump,
  onDelete,
}: {
  subgoal: SubgoalRecord
  linkedConv?: ConversationLink
  locale: Locale
  busy: boolean
  disabledDispatch: boolean
  onToggleStatus: (sg: SubgoalRecord, next: SubgoalStatus) => void
  onToggleRequired: (sg: SubgoalRecord) => void
  onDispatchSubgoal: (
    sg: SubgoalRecord,
    mode: 'new' | 'resume' | 'rework',
    options?: { conversationId?: string; reworkInstructions?: string },
  ) => void
  onJump: (convId: string, options?: { split?: 'right' }) => void
  onDelete: (subgoalId: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: subgoal.id })
  const [showRework, setShowRework] = useState(false)
  const [reworkDraft, setReworkDraft] = useState('')
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition }
  const conv = linkedConv ?? subgoal.conversations?.at(-1)

  const submitSubgoalRework = () => {
    const trimmed = reworkDraft.trim()
    if (!trimmed || !conv) return
    onDispatchSubgoal(subgoal, 'rework', {
      conversationId: conv.conversationId,
      reworkInstructions: trimmed,
    })
    setReworkDraft('')
    setShowRework(false)
  }

  return (
    <div
      ref={setNodeRef}
      className="subgoal-row-item"
      style={style}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' }}>
        <div className="row-wrap" style={{ flex: 1, minWidth: 0 }}>
          <span style={{ cursor: 'grab', color: 'var(--agy-muted-fg)' }} {...attributes} {...listeners}>
            <GripVertical size={13} />
          </span>
          <input
            type="checkbox"
            checked={subgoal.status === 'done'}
            onChange={() => onToggleStatus(subgoal, subgoal.status === 'done' ? 'open' : 'done')}
          />
          <span
            style={{
              textDecoration: subgoal.status === 'done' ? 'line-through' : 'none',
              opacity: subgoal.status === 'skipped' ? 0.6 : 1,
              fontWeight: 500,
              wordBreak: 'break-word',
            }}
          >
            {subgoal.title}
          </span>
          <button
            type="button"
            className="badge"
            style={{
              cursor: 'pointer',
              fontWeight: subgoal.required ? 600 : 400,
              color: subgoal.required ? 'var(--agy-fg)' : 'var(--agy-muted-fg)',
            }}
            onClick={() => onToggleRequired(subgoal)}
          >
            {subgoal.required ? tr(locale, 'required') : tr(locale, 'optional')}
          </button>
        </div>

        <div className="row-wrap">
          {conv && (
            <>
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                title={tr(locale, 'jumpSession')}
                onClick={() => onJump(conv.conversationId)}
              >
                <ExternalLink size={11} />
              </button>
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                title={tr(locale, 'splitRight')}
                onClick={() => onJump(conv.conversationId, { split: 'right' })}
              >
                <Columns2 size={11} />
              </button>
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                disabled={busy || disabledDispatch}
                title={tr(locale, 'resumeSession')}
                onClick={() =>
                  onDispatchSubgoal(subgoal, 'resume', { conversationId: conv.conversationId })
                }
              >
                <RotateCcw size={11} />
              </button>
              <button
                type="button"
                className={`btn btn-xs btn-ghost${showRework ? ' is-active' : ''}`}
                disabled={busy || disabledDispatch}
                title={tr(locale, 'rework')}
                onClick={() => setShowRework((v) => !v)}
              >
                <MessageSquareReply size={11} />
              </button>
            </>
          )}
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            disabled={busy || disabledDispatch}
            title={conv ? tr(locale, 'relayNew') : tr(locale, 'dispatchNew')}
            onClick={() => onDispatchSubgoal(subgoal, 'new')}
          >
            <Play size={11} />
          </button>
          <button type="button" className="btn btn-xs btn-ghost" onClick={() => onDelete(subgoal.id)} aria-label={tr(locale, 'delete')}>
            <Trash2 size={11} />
          </button>
        </div>
      </div>

      {showRework && conv && (
        <div className="row-wrap">
          <input
            className="input-field"
            style={{ flex: 1, fontSize: 11.5 }}
            value={reworkDraft}
            onChange={(e) => setReworkDraft(e.target.value)}
            placeholder={tr(locale, 'reworkShortPlaceholder')}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setShowRework(false)
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submitSubgoalRework()
              }
            }}
          />
          <button
            type="button"
            className="btn btn-xs btn-primary"
            disabled={busy || disabledDispatch || !reworkDraft.trim()}
            onClick={submitSubgoalRework}
          >
            <Send size={10} />
            <span>{tr(locale, 'sendRework')}</span>
          </button>
        </div>
      )}
    </div>
  )
}

export interface TaskDetailViewProps {
  task: TaskRecord
  locale: Locale
  workspaces: WorkspaceRecord[]
  recentConversations: DiscoveredConversation[]
  sessionDefaultPermission: TaskPermission
  autoOpenSession?: boolean
  defaultTimeZone?: string
  variant?: 'drawer' | 'inline'
  showBackButton?: boolean
  onClose: () => void
  onTaskUpdated: () => Promise<void>
  onToast: (msg: string) => void
}

export function TaskDetailView({
  task: initialTask,
  locale,
  workspaces,
  recentConversations,
  sessionDefaultPermission,
  autoOpenSession = false,
  defaultTimeZone,
  variant = 'drawer',
  showBackButton = false,
  onClose,
  onTaskUpdated,
  onToast,
}: TaskDetailViewProps) {
  const initialClientTask = initialTask as ClientTaskRecord
  const [task, setTask] = useState<ClientTaskRecord>(initialClientTask)
  const [events, setEvents] = useState<TaskEventRecord[]>([])
  const [comments, setComments] = useState<TaskCommentRecord[]>(initialClientTask.comments ?? [])

  const [titleDraft, setTitleDraft] = useState(initialTask.title)
  const [descDraft, setDescDraft] = useState(initialTask.description)
  const [descEditing, setDescEditing] = useState(!initialTask.description.trim())
  const [userNotesDraft, setUserNotesDraft] = useState(initialTask.userNotes ?? '')
  const [userNotesPreview, setUserNotesPreview] = useState(false)
  const [promptDraft, setPromptDraft] = useState(initialTask.prompt)
  const [contractEditing, setContractEditing] = useState(!initialTask.prompt.trim())
  const [contractExpanded, setContractExpanded] = useState(false)
  const [nextActionDraft, setNextActionDraft] = useState(initialTask.nextAction ?? '')
  const [dueAtDraft, setDueAtDraft] = useState(epochToDateTimeLocal(initialTask.dueAt))
  const [priorityDraft, setPriorityDraft] = useState<TaskPriority>(initialTask.priority)
  const [permissionDraft, setPermissionDraft] = useState<TaskPermission | ''>(initialTask.permission ?? '')
  const [tagsDraft, setTagsDraft] = useState(initialTask.tags.map((t) => t.name).join(', '))
  const [reuseDraft, setReuseDraft] = useState(initialTask.reuseSession)
  const [modeDraft, setModeDraft] = useState(initialTask.mode ?? '')
  const [modelDraft, setModelDraft] = useState(initialTask.model ?? '')
  const [effortDraft, setEffortDraft] = useState(initialTask.reasoningEffort ?? '')
  const [useWorktreeDraft, setUseWorktreeDraft] = useState(Boolean(initialClientTask.useWorktree))
  const [workspacePathDraft, setWorkspacePathDraft] = useState(initialTask.workspacePath ?? '')

  const [subgoalInput, setSubgoalInput] = useState('')
  const [subgoalRequired, setSubgoalRequired] = useState(true)
  const [showBulkPlan, setShowBulkPlan] = useState(false)
  const [bulkPlanText, setBulkPlanText] = useState('')
  const [refKind, setRefKind] = useState<TaskRefKind>('file')
  const [refTarget, setRefTarget] = useState('')
  const [refLabel, setRefLabel] = useState('')
  const [showReworkBox, setShowReworkBox] = useState(false)
  const [reworkText, setReworkText] = useState('')
  const [bindConvId, setBindConvId] = useState('')
  const [bindRole, setBindRole] = useState<ConversationRole>('primary')
  const [bindSubgoalId, setBindSubgoalId] = useState('')
  const [showAllConvs, setShowAllConvs] = useState(false)
  const [convSearch, setConvSearch] = useState('')
  const [convLimit, setConvLimit] = useState(100)
  const [queriedConvs, setQueriedConvs] = useState<DiscoveredConversation[] | null>(null)
  const [convHasMore, setConvHasMore] = useState(false)
  const [convLoading, setConvLoading] = useState(false)

  const [freezeGoal, setFreezeGoal] = useState(initialTask.freeze?.goal ?? '')
  const [freezeProgress, setFreezeProgress] = useState(initialTask.freeze?.progress ?? '')
  const [freezeNext, setFreezeNext] = useState(initialTask.freeze?.next ?? '')
  const [freezePaste, setFreezePaste] = useState('')
  const [showPasteBox, setShowPasteBox] = useState(false)

  const [handoverWsId, setHandoverWsId] = useState(initialTask.handover?.workspaceId ?? '')
  const [handoverMode, setHandoverMode] = useState(initialTask.handover?.mode ?? '')
  const [handoverPerm, setHandoverPerm] = useState<TaskPermission | ''>(initialTask.handover?.permission ?? '')
  const [handoverRefsRaw, setHandoverRefsRaw] = useState((initialTask.handover?.references ?? []).join('\n'))

  const [commentBodyDraft, setCommentBodyDraft] = useState('')
  const [commentAuthorDraft, setCommentAuthorDraft] = useState('user')

  const [worktreeDiff, setWorktreeDiff] = useState<WorktreeDiffResponse | null>(null)
  const [showFullDiff, setShowFullDiff] = useState(false)

  const [preview, setPreview] = useState<PreviewData | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [activeTab, setActiveTab] = useState<'human' | 'agent'>('human')
  const [showFullNotes, setShowFullNotes] = useState(false)
  const syncedDraftsRef = useRef({
    taskId: initialTask.id,
    title: initialTask.title,
    description: initialTask.description,
    userNotes: initialTask.userNotes ?? '',
    prompt: initialTask.prompt,
  })

  // Reset transient drafts cleanly when switching tasks (in addition to key={task.id})
  useEffect(() => {
    setReworkText('')
    setShowReworkBox(false)
    setPreview(null)
    setDueAtDraft(epochToDateTimeLocal(initialTask.dueAt))
    setCommentBodyDraft('')
    setShowBulkPlan(false)
    setBulkPlanText('')
    setShowPasteBox(false)
    setFreezePaste('')
    setDescEditing(!initialTask.description.trim())
    setUserNotesPreview(false)
    setContractEditing(!initialTask.prompt.trim())
    setContractExpanded(false)
    setShowFullNotes(false)
    setActiveTab('human')
    setBindConvId('')
    setBindRole('primary')
    setBindSubgoalId('')
    setConvSearch('')
    setConvLimit(100)
    setQueriedConvs(null)
    setConvHasMore(false)
    setWorktreeDiff(null)
    setShowFullDiff(false)
    setConfirmDelete(false)
  }, [initialTask.id])

  useEffect(() => {
    const ct = initialTask as ClientTaskRecord
    setTask(ct)
    if (ct.comments) setComments(ct.comments)

    const nextSynced = {
      taskId: initialTask.id,
      title: initialTask.title,
      description: initialTask.description,
      userNotes: initialTask.userNotes ?? '',
      prompt: initialTask.prompt,
    }
    const prevSynced = syncedDraftsRef.current
    const switchedTask = prevSynced.taskId !== nextSynced.taskId
    syncedDraftsRef.current = nextSynced

    if (switchedTask) {
      setTitleDraft(nextSynced.title)
      setDescDraft(nextSynced.description)
      setUserNotesDraft(nextSynced.userNotes)
      setPromptDraft(nextSynced.prompt)
    } else {
      setTitleDraft((cur) => (cur === prevSynced.title ? nextSynced.title : cur))
      setDescDraft((cur) => (cur === prevSynced.description ? nextSynced.description : cur))
      setUserNotesDraft((cur) => (cur === prevSynced.userNotes ? nextSynced.userNotes : cur))
      setPromptDraft((cur) => (cur === prevSynced.prompt ? nextSynced.prompt : cur))
    }

    setNextActionDraft(initialTask.nextAction ?? '')
    setDueAtDraft(epochToDateTimeLocal(initialTask.dueAt))
    setPriorityDraft(initialTask.priority)
    setPermissionDraft(initialTask.permission ?? '')
    setTagsDraft(initialTask.tags.map((t) => t.name).join(', '))
    setReuseDraft(initialTask.reuseSession)
    setModeDraft(initialTask.mode ?? '')
    setModelDraft(initialTask.model ?? '')
    setEffortDraft(initialTask.reasoningEffort ?? '')
    setUseWorktreeDraft(Boolean(ct.useWorktree))
    setWorkspacePathDraft(initialTask.workspacePath ?? '')
    setFreezeGoal(initialTask.freeze?.goal ?? '')
    setFreezeProgress(initialTask.freeze?.progress ?? '')
    setFreezeNext(initialTask.freeze?.next ?? '')
    setHandoverWsId(initialTask.handover?.workspaceId ?? '')
    setHandoverMode(initialTask.handover?.mode ?? '')
    setHandoverPerm(initialTask.handover?.permission ?? '')
    setHandoverRefsRaw((initialTask.handover?.references ?? []).join('\n'))
    setConfirmDelete(false)
  }, [initialTask])

  useEffect(() => {
    let cancelled = false
    void boardApi
      .getTaskDetail(initialTask.id)
      .then((res) => {
        if (cancelled) return
        setTask(res.task)
        setEvents(res.events)
        const nextComments = res.comments ?? res.task.comments
        if (nextComments) setComments(nextComments)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [initialTask.id, initialTask.updatedAt])

  useEffect(() => {
    if (activeTab !== 'agent') return
    let cancelled = false
    const timer = setTimeout(
      () => {
        setConvLoading(true)
        void boardApi
          .listConversations({
            ...(!showAllConvs && task.workspaceId ? { projectId: task.workspaceId } : {}),
            ...(!showAllConvs && task.workspacePath ? { workspacePath: task.workspacePath } : {}),
            ...(convSearch.trim() ? { query: convSearch.trim() } : {}),
            limit: convLimit,
          })
          .then((res) => {
            if (cancelled) return
            if (Array.isArray(res?.conversations) && res.available !== false) {
              setQueriedConvs(res.conversations)
              setConvHasMore(Boolean(res.hasMore))
            }
          })
          .catch(() => {
            if (!cancelled) {
              setQueriedConvs(null)
              setConvHasMore(false)
            }
          })
          .finally(() => {
            if (!cancelled) setConvLoading(false)
          })
      },
      convSearch.trim() ? 150 : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [activeTab, convLimit, convSearch, showAllConvs, task.workspaceId, task.workspacePath])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const needsPerm = requiresPermissionConfirmation(task, sessionDefaultPermission)
  const primaryConv = latestPrimaryConversation(task)
  const openExecution = hasOpenExecution(task)
  const sidecar = getSidecar()
  const folderChoices = useMemo(() => buildWorkspaceFolderChoices(workspaces), [workspaces])

  const selectedFolderChoiceKey = useMemo(() => {
    if (task.workspacePath) {
      const targetKey = pathComparisonKey(task.workspacePath)
      const exact =
        folderChoices.find(
          (c) =>
            pathComparisonKey(c.folderPath) === targetKey &&
            (!task.workspaceId || c.workspaceId === task.workspaceId),
        ) ?? folderChoices.find((c) => pathComparisonKey(c.folderPath) === targetKey)
      if (exact) return exact.key
      return '__custom_path__'
    }
    if (task.workspaceId) {
      const byWs = folderChoices.find((c) => c.workspaceId === task.workspaceId)
      if (byWs) return byWs.key
    }
    return ''
  }, [folderChoices, task.workspaceId, task.workspacePath])

  const runAction = async (fn: () => Promise<unknown>, toastMsg?: string) => {
    setBusy(true)
    try {
      await fn()
      await onTaskUpdated()
      const refreshed = await boardApi.getTaskDetail(task.id).catch(() => null)
      if (refreshed) {
        setTask(refreshed.task)
        setEvents(refreshed.events)
        const nextComments = refreshed.comments ?? refreshed.task.comments
        if (nextComments) setComments(nextComments)
      }
      if (toastMsg) onToast(toastMsg)
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleDispatchFromDetail = async (options: {
    subgoalId?: string
    mode: 'new' | 'resume' | 'rework'
    conversationId?: string
    reworkInstructions?: string
  }) => {
    const res = await boardApi.dispatch(task.id, {
      ...options,
      ...(useWorktreeDraft !== Boolean(task.useWorktree) || useWorktreeDraft
        ? { useWorktree: useWorktreeDraft }
        : {}),
      ...(effortDraft.trim() ? { reasoningEffort: effortDraft.trim() } : {}),
    })
    if (autoOpenSession && res.conversationId) {
      void boardApi.jumpToConversation(res.conversationId).catch(() => {})
    }
    return res
  }

  const handleSubgoalDragEnd = async (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const oldIdx = task.subgoals.findIndex((s) => s.id === active.id)
    const newIdx = task.subgoals.findIndex((s) => s.id === over.id)
    if (oldIdx === -1 || newIdx === -1) return
    const next = [...task.subgoals]
    const [moved] = next.splice(oldIdx, 1)
    next.splice(newIdx, 0, moved)
    const orderedIds = next.map((s) => s.id)
    await runAction(async () => {
      try {
        await boardApi.reorderSubgoals(task.id, orderedIds)
      } catch {
        for (let idx = 0; idx < next.length; idx += 1) {
          await boardApi.updateSubgoal(task.id, next[idx].id, { sortOrder: idx })
        }
      }
    })
  }

  const fallbackWorkspaceConvs = useMemo(() => {
    const base =
      showAllConvs || !task.workspacePath
        ? recentConversations
        : recentConversations.filter(
            (c) =>
              (task.workspaceId && c.projectId === task.workspaceId) ||
              c.workspacePaths.some(
                (p) => isPathEqualOrInside(p, task.workspacePath!) || isPathEqualOrInside(task.workspacePath!, p),
              ),
          )
    const q = convSearch.trim().toLowerCase()
    if (!q) return base
    return base.filter((c) => `${c.title}\n${c.preview}\n${c.conversationId}`.toLowerCase().includes(q))
  }, [convSearch, recentConversations, showAllConvs, task.workspaceId, task.workspacePath])

  const workspaceConvs = queriedConvs ?? fallbackWorkspaceConvs

  const resolveWorkspacePatchForDraft = (
    rawPath: string,
  ): { workspaceId: string | null; workspacePath: string | null } => {
    const trimmedPath = rawPath.trim()
    if (!trimmedPath) {
      return { workspaceId: null, workspacePath: null }
    }
    const matchedWs = matchWorkspaceForPath(trimmedPath, workspaces)
    if (matchedWs) {
      return { workspaceId: matchedWs.id, workspacePath: trimmedPath }
    }
    const currentWs = task.workspaceId
      ? workspaces.find((w) => w.id === task.workspaceId || w.antigravityProjectId === task.workspaceId)
      : undefined
    const staysInCurrent = Boolean(
      currentWs && collectWorkspaceFolders(currentWs).some((fp) => isPathEqualOrInside(trimmedPath, fp)),
    )
    return {
      workspaceId: staysInCurrent ? (task.workspaceId ?? null) : null,
      workspacePath: trimmedPath,
    }
  }

  const handleSaveDetails = (overridePatch?: Record<string, unknown>) => {
    const existingPrefixByName = new Map(task.tags.map((t) => [t.name, t.promptPrefix] as const))
    const tags = tagsDraft
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name) => {
        const promptPrefix = existingPrefixByName.get(name)
        return promptPrefix ? { name, promptPrefix } : { name }
      })
    const initialDueStr = epochToDateTimeLocal(task.dueAt)
    const dueAtEpoch = dateTimeLocalToEpoch(dueAtDraft)
    const patch: Record<string, unknown> = {
      priority: priorityDraft,
      nextAction: nextActionDraft.trim() || null,
      ...(dueAtDraft !== initialDueStr ? { dueAt: dueAtEpoch ?? null } : {}),
      permission: permissionDraft || null,
      reuseSession: reuseDraft,
      mode: modeDraft.trim() || null,
      model: modelDraft.trim() || null,
      reasoningEffort: effortDraft.trim() || null,
      tags,
      ...(overridePatch ?? {}),
    }
    if (useWorktreeDraft !== Boolean(task.useWorktree)) {
      patch.useWorktree = useWorktreeDraft
    }
    if (workspacePathDraft.trim() !== (task.workspacePath ?? '')) {
      Object.assign(patch, resolveWorkspacePatchForDraft(workspacePathDraft))
    }
    patch.title = titleDraft.trim() || task.title
    patch.description = descDraft
    patch.userNotes = userNotesDraft
    patch.prompt = promptDraft
    const saveToast = openExecution ? tr(locale, 'savedNextRoundHint') : tr(locale, 'saveSuccess')
    void runAction(() => boardApi.updateTask(task.id, patch), saveToast)
  }

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setBusy(true)
    try {
      await boardApi.deleteTask(task.id)
      await onTaskUpdated()
      onToast(locale === 'zh' ? '已删除' : 'Deleted')
      onClose()
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleOpenRefInFileView = async (ref: TaskRecord['refs'][number]) => {
    if (!sidecar?.ui?.toggleAuxPane) return
    if (isAbsoluteFsPath(ref.target)) {
      sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri: fsPathToFileUri(ref.target) })
      return
    }
    try {
      const res = await boardApi.previewRef(task.id, ref.id)
      if (res.resolvedPath && !res.isUrl) {
        sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri: fsPathToFileUri(res.resolvedPath) })
      } else {
        onToast(res.message || 'Cannot open reference in File View')
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleAddComment = () => {
    const body = commentBodyDraft.trim()
    if (!body) return
    void runAction(async () => {
      const res = await boardApi.addComment(task.id, {
        bodyMd: body,
        author: commentAuthorDraft.trim() || 'user',
      })
      const nextComments = res.comments ?? (res.task as ClientTaskRecord | undefined)?.comments
      if (nextComments) {
        setComments(nextComments)
      } else if (res.comment) {
        const added = res.comment
        setComments((prev) => (prev.some((c) => c.id === added.id) ? prev : [...prev, added]))
      }
      setCommentBodyDraft('')
    }, 'Comment added')
  }

  const handleLoadDiff = async () => {
    setBusy(true)
    try {
      const diff = await boardApi.getWorktreeDiff(task.id)
      setWorktreeDiff(diff)
      if (diff.ok === false && diff.message) onToast(diff.message)
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const renderWorktreeDiffBox = (diff: WorktreeDiffResponse, testId?: string) => (
    <div className="worktree-diff-box" data-testid={testId}>
      {(diff.message || diff.error) && (
        <div className="card-meta-line" style={{ whiteSpace: 'normal' }}>
          {diff.message || diff.error}
        </div>
      )}
      {(diff.stat || diff.diffStat || diff.summary || diff.status) && (
        <pre className="code-preview" style={{ maxHeight: 160 }}>
          {diff.stat || diff.diffStat || diff.summary || diff.status}
        </pre>
      )}
      {diff.ok !== false &&
        diff.hasChanges === false &&
        !diff.status &&
        !diff.stat &&
        !diff.diffStat &&
        !diff.summary &&
        !diff.diff &&
        !diff.patch &&
        !(diff.files && diff.files.length > 0) && (
          <div className="card-meta-line">{tr(locale, 'cleanWorktree')}</div>
        )}
      {(diff.diff || diff.patch) && (
        <div>
          <button type="button" className="btn btn-xs" onClick={() => setShowFullDiff((v) => !v)}>
            {showFullDiff ? tr(locale, 'hidePatch') : tr(locale, 'showPatch')}
          </button>
          {showFullDiff && (
            <pre className="code-preview" style={{ maxHeight: 220, marginTop: 6 }}>
              {diff.diff || diff.patch}
            </pre>
          )}
        </div>
      )}
    </div>
  )

  const canManualToggle = !needsPerm && !openExecution && task.phase !== 'active'
  const wsShortName = task.workspaceLabel || pathBasename(task.workspacePath) || ''
  const isReminderDue = Boolean(
    task.phase !== 'closed' &&
      ((task.phase === 'needs_you' && task.subPhase === 'reminder_due') ||
        (task.reminderAt !== undefined && task.reminderAt <= Date.now())),
  )
  const rawBlocked = task.blockedReason?.trim() ?? ''
  const showBlockedCallout = Boolean(
    rawBlocked && !(isReminderDue && /^reminder\s+due$/i.test(rawBlocked)),
  )
  const canApproveReview = Boolean(
    task.phase === 'needs_you' && !needsPerm && !openExecution && task.subgoalRollup.requiredRemaining === 0,
  )
  const isRecurringReview = canApproveReview && isRecurringActiveSchedule(task)
  const isDraft = task.phase === 'todo' && task.subPhase === 'draft'
  const isSnoozed = isTaskSnoozed(task, Date.now())
  const hasUnifiedStatusBanner = Boolean(
    needsPerm ||
      showBlockedCallout ||
      isReminderDue ||
      openExecution ||
      task.phase === 'active' ||
      isDraft ||
      worktreeDiff ||
      (task.phase === 'needs_you' && task.subPhase === 'review' && !needsPerm),
  )
  const memoSourceText = descDraft
  const memoInfo = useMemo(() => extractShortMemo(memoSourceText), [memoSourceText])
  const advancedBadges = [
    useWorktreeDraft || task.worktreePath ? 'Worktree' : null,
    task.schedule?.enabled ? 'Cron' : null,
    task.freeze ? 'Freeze' : null,
    task.writeGate === 'locked' ? tr(locale, 'writeGateLocked') : null,
    comments.length > 0 ? `${comments.length} ${tr(locale, 'comments')}` : null,
  ].filter(Boolean)

  const handleAcceptRecurringRound = () =>
    void runAction(async () => {
      const res = await boardApi.completeScheduleCycle(task.id)
      const nextAt = res.task.schedule?.nextRunAt
      const nextText = nextAt
        ? new Date(nextAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })
        : ''
      onToast(
        locale === 'zh'
          ? `已验收本轮${nextText ? ` · 下次：${nextText}` : ''}`
          : `Accepted round${nextText ? ` · Next: ${nextText}` : ''}`,
      )
    })

  return (
    <div
      className={`detail-surface is-${variant}`}
      data-testid="task-detail-drawer"
    >
      {/* Top Chrome: Pure Title + Unified 4-State Slot + Bright Connected Folder Tabs */}
      <div className="detail-chrome-header">
        <div className="drawer-header">
          <div className="row-wrap" style={{ flex: 1, minWidth: 0, flexWrap: 'nowrap' }}>
            {showBackButton && (
              <button type="button" className="btn btn-xs btn-ghost" onClick={onClose} aria-label={tr(locale, 'backToList')}>
                <ArrowLeft size={13} />
              </button>
            )}
            <button
              type="button"
              className="status-icon-btn"
              disabled={!canManualToggle}
              onClick={() =>
                void runAction(
                  () =>
                    boardApi.transitionTask(
                      task.id,
                      task.phase === 'closed' ? 'todo' : 'closed',
                      { subPhase: task.phase === 'closed' ? 'ready' : 'done' },
                    ),
                )
              }
              aria-label={task.phase === 'closed' ? tr(locale, 'restore') : tr(locale, 'approvePass')}
            >
              <StatusGlyph phase={task.phase} subPhase={task.subPhase} size={17} />
            </button>

            <div style={{ flex: 1, minWidth: 0 }}>
              <input
                className="detail-title-input"
                aria-label={tr(locale, 'title')}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleSaveDetails()
                  }
                }}
              />
            </div>
          </div>

          <div className="row-wrap" style={{ flexShrink: 0 }}>
            <button
              type="button"
              className={`btn btn-xs btn-ghost focus-pin-btn${task.userMarks?.pinnedAt ? ' is-pinned' : ''}`}
              onClick={() =>
                void runAction(
                  () => boardApi.setMarks(task.id, { pin: !task.userMarks?.pinnedAt }),
                  task.userMarks?.pinnedAt ? tr(locale, 'unpinFromFocus') : tr(locale, 'pinToFocus'),
                )
              }
              aria-label={task.userMarks?.pinnedAt ? (locale === 'zh' ? '取消星标' : 'Unstar') : (locale === 'zh' ? '星标置顶' : 'Star')}
              title={`${task.userMarks?.pinnedAt ? tr(locale, 'unpinFromFocus') : tr(locale, 'pinToFocus')} (F)`}
            >
              <Star size={12} fill={task.userMarks?.pinnedAt ? 'currentColor' : 'none'} />
            </button>

            {task.phase !== 'closed' && (
              <button
                type="button"
                className={`btn btn-xs btn-ghost detail-snooze-btn${isSnoozed ? ' is-snoozed' : ''}`}
                data-testid="detail-snooze-btn"
                disabled={busy}
                onClick={() =>
                  void runAction(
                    () =>
                      boardApi.setMarks(task.id, {
                        snoozeUntil: isSnoozed ? null : computeSnoozeTarget('2h', Date.now()),
                      }),
                    isSnoozed
                      ? tr(locale, 'unsnooze')
                      : locale === 'zh'
                        ? '已延后 2 小时'
                        : 'Snoozed +2h',
                  )
                }
                aria-label={isSnoozed ? tr(locale, 'unsnooze') : tr(locale, 'snooze')}
                title={`${isSnoozed ? tr(locale, 'unsnooze') : `${tr(locale, 'snooze')} (+2h)`} (S)`}
              >
                <Clock size={12} />
              </button>
            )}

            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() =>
                void runAction(
                  () => boardApi.setMarks(task.id, { ignore: !task.userMarks?.ignoredAt }),
                  task.userMarks?.ignoredAt ? tr(locale, 'unignoreTask') : tr(locale, 'ignoreTask'),
                )
              }
              title={task.userMarks?.ignoredAt ? tr(locale, 'unignoreTask') : tr(locale, 'ignoreTask')}
            >
              {task.userMarks?.ignoredAt ? <Eye size={12} /> : <EyeOff size={12} />}
            </button>

            {task.archivedAt === undefined ? (
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                disabled={openExecution}
                onClick={() => void runAction(() => boardApi.archiveTask(task.id), 'Archived')}
                title={tr(locale, 'archive')}
              >
                <Archive size={12} />
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-xs"
                onClick={() => void runAction(() => boardApi.restoreTask(task.id), 'Restored')}
              >
                {tr(locale, 'restore')}
              </button>
            )}

            <button
              type="button"
              className={`btn btn-xs ${confirmDelete ? 'btn-danger' : 'btn-ghost'}`}
              disabled={busy || openExecution}
              title={openExecution ? 'Settle open execution before deleting' : tr(locale, 'delete')}
              onClick={() => void handleDelete()}
            >
              <Trash2 size={12} />
              {confirmDelete && <span>{tr(locale, 'confirmDelete')}</span>}
            </button>

            {variant === 'drawer' && (
              <button type="button" className="btn btn-xs btn-ghost" onClick={onClose} aria-label={tr(locale, 'close')}>
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Unified Fixed 4-State Slot (persists above tabs; hidden 0px in normal state) */}
        {hasUnifiedStatusBanner && (
          <div className="detail-status-slot" data-testid="detail-status-slot">
            {isDraft && (
              <div className="detail-status-banner is-warn" data-testid="draft-banner">
                <div className="row-wrap" style={{ flex: 1, minWidth: 0 }}>
                  <span className="row-wrap text-warn" style={{ fontSize: 12, fontWeight: 600 }}>
                    <Sparkles size={14} />
                    <span>{tr(locale, 'draftBadge')}</span>
                  </span>
                  <span className="card-meta-line" style={{ whiteSpace: 'normal' }}>
                    {tr(locale, 'draftBanner')}
                  </span>
                  {task.originSummary && (
                    <span className="card-meta-line" style={{ whiteSpace: 'normal' }}>
                      {tr(locale, 'originSummary')}: {task.originSummary}
                    </span>
                  )}
                </div>
                <div className="row-wrap">
                  <button
                    type="button"
                    className="btn btn-xs btn-ok"
                    disabled={busy}
                    title={`${tr(locale, 'approveDraft')} (A)`}
                    onClick={() =>
                      void runAction(
                        () => boardApi.transitionTask(task.id, 'todo', { subPhase: 'ready' }),
                        locale === 'zh' ? '已审校，移入 Ready' : 'Approved to Ready',
                      )
                    }
                  >
                    <Check size={11} />
                    <span>{tr(locale, 'approveDraft')}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs"
                    disabled={busy}
                    onClick={() =>
                      void runAction(
                        () => boardApi.transitionTask(task.id, 'todo', { subPhase: 'backlog' }),
                        locale === 'zh' ? '已移入备选池' : 'Moved to Backlog',
                      )
                    }
                  >
                    {tr(locale, 'sendDraftBacklog')}
                  </button>
                </div>
              </div>
            )}
            {needsPerm && (
              <div className="detail-status-banner is-warn">
                <div className="row-wrap" style={{ flex: 1, minWidth: 0 }}>
                  <span className="row-wrap text-warn" style={{ fontSize: 12 }}>
                    <ShieldAlert size={14} />
                    <span>{tr(locale, 'permissionPendingBanner')}</span>
                  </span>
                  {task.handover && (
                    <div className="handover-inline-summary" style={{ width: '100%' }}>
                      <strong>{tr(locale, 'handoverBundle')}:</strong>{' '}
                      {task.handover.workspaceId ? `ws=${task.handover.workspaceId} · ` : ''}
                      {task.handover.mode ? `mode=${task.handover.mode} · ` : ''}
                      {task.handover.permission ? `perm=${task.handover.permission} · ` : ''}
                      refs={task.handover.references.length}
                      {task.handover.references.length > 0 && (
                        <div className="card-meta-line" style={{ whiteSpace: 'normal', marginTop: 2 }}>
                          {task.handover.references.join(', ')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-xs btn-primary"
                  disabled={busy}
                  onClick={() => void runAction(() => boardApi.confirmPermission(task.id), 'Permission confirmed')}
                >
                  <Check size={11} />
                  <span>{tr(locale, 'confirmPermission')}</span>
                </button>
              </div>
            )}

            {showBlockedCallout && (
              <div className="callout-blocked">
                <div className="callout-blocked-title">
                  <AlertTriangle size={13} />
                  <span>{tr(locale, 'blockedReason')}</span>
                </div>
                <MarkdownText content={rawBlocked} />
              </div>
            )}

            {!needsPerm && !openExecution && task.phase !== 'active' && isReminderDue && (
              <div className="detail-status-banner is-warn">
                <span className="row-wrap text-warn" style={{ fontWeight: 600 }}>
                  <Bell size={13} />
                  <span className="tabular-nums">
                    {tr(locale, 'reminderDueNow')}
                    {task.reminderAt !== undefined
                      ? ` · ${new Date(task.reminderAt).toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en-US', {
                          hour: '2-digit',
                          minute: '2-digit',
                          hour12: false,
                        })}`
                      : ''}
                  </span>
                </span>
                <div className="row-wrap">
                  <button
                    type="button"
                    className="btn btn-xs"
                    disabled={busy}
                    onClick={() =>
                      void runAction(
                        () => boardApi.setReminder(task.id, Date.now() + 3_600_000),
                        locale === 'zh' ? '已延后 1 小时提醒' : 'Snoozed reminder 1h',
                      )
                    }
                  >
                    {tr(locale, 'snooze1h')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs"
                    disabled={busy}
                    onClick={() =>
                      void runAction(async () => {
                        await boardApi.setReminder(task.id, null)
                        if (task.phase === 'needs_you' && task.subPhase === 'reminder_due') {
                          await boardApi.transitionTask(task.id, 'todo', { subPhase: 'ready' })
                        }
                      }, tr(locale, 'ackDismiss'))
                    }
                  >
                    {tr(locale, 'ackDismiss')}
                  </button>
                </div>
              </div>
            )}

            {(openExecution || task.phase === 'active') && (
              <div className="detail-status-banner is-active">
                <span className="row-wrap" style={{ color: 'var(--agy-active-fg)', fontWeight: 600 }}>
                  <StatusGlyph phase="active" size={13} />
                  <span>{tr(locale, 'agentRunningNow')}</span>
                </span>
                <div className="row-wrap">
                  <button
                    type="button"
                    className="btn btn-xs"
                    onClick={() => {
                      setActiveTab('agent')
                      setShowReworkBox(true)
                    }}
                  >
                    {tr(locale, 'interveneAgent')}
                  </button>
                  {primaryConv && (
                    <button
                      type="button"
                      className="btn btn-xs"
                      onClick={() =>
                        void boardApi.jumpToConversation(primaryConv.conversationId).then((r) => onToast(r.message))
                      }
                    >
                      <ExternalLink size={11} />
                      <span>{tr(locale, 'openSession')}</span>
                    </button>
                  )}
                  {openExecution && (
                    <button
                      type="button"
                      className="btn btn-xs btn-ok"
                      disabled={busy}
                      onClick={() =>
                        void runAction(() => boardApi.settle(task.id, 'succeeded', 'Settled from UI'), 'Execution settled')
                      }
                    >
                      {tr(locale, 'settleTurn')}
                    </button>
                  )}
                </div>
              </div>
            )}

            {!needsPerm && !openExecution && task.phase === 'needs_you' && task.subPhase === 'review' && (
              <div className="detail-status-banner is-ok">
                <span className="row-wrap" style={{ color: 'var(--agy-ok-fg)', fontWeight: 600 }}>
                  <CheckCircle2 size={13} />
                  <span>{tr(locale, 'reviewSubmitted')}</span>
                </span>
                <div className="row-wrap">
                  {task.worktreePath && (
                    <button
                      type="button"
                      className="btn btn-xs"
                      disabled={busy}
                      data-testid="review-worktree-diff-btn"
                      onClick={() => void handleLoadDiff()}
                    >
                      <GitBranch size={11} />
                      <span>{tr(locale, 'worktreeDiff')}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-xs"
                    onClick={() => setActiveTab('agent')}
                  >
                    {tr(locale, 'viewArtifacts')}
                  </button>
                  {canApproveReview && (
                    isRecurringReview ? (
                      <button
                        type="button"
                        className="btn btn-xs btn-ok"
                        disabled={busy}
                        onClick={handleAcceptRecurringRound}
                      >
                        {tr(locale, 'acceptRound')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-xs btn-ok"
                        disabled={busy}
                        onClick={() =>
                          void runAction(
                            () => boardApi.transitionTask(task.id, 'closed', { subPhase: 'done' }),
                            tr(locale, 'approvePass'),
                          )
                        }
                      >
                        {tr(locale, 'approvePass')}
                      </button>
                    )
                  )}
                </div>
              </div>
            )}

            {worktreeDiff && (
              <div className="detail-status-banner" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
                  <span className="row-wrap" style={{ fontWeight: 600, fontSize: 11.5 }}>
                    <GitBranch size={12} />
                    <span>{worktreeDiff.branch ? `Worktree (${worktreeDiff.branch})` : 'Worktree Diff'}</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    onClick={() => setWorktreeDiff(null)}
                    aria-label={tr(locale, 'close')}
                  >
                    <X size={11} />
                  </button>
                </div>
                {renderWorktreeDiffBox(worktreeDiff, 'quick-worktree-diff-box')}
              </div>
            )}
          </div>
        )}

        <details className="detail-capsule" data-testid="handoff-capsule">
          <summary>
            <span className="row-wrap" style={{ gap: 6 }}>
              <Sparkles size={12} />
              <span style={{ fontWeight: 600 }}>{tr(locale, 'handoffCapsule')}</span>
              <span className="badge">
                {task.conversations.filter((c) => c.includeInHandoff && c.summary?.trim()).length}
              </span>
            </span>
            <span className="card-meta-line">{tr(locale, 'handoffCapsuleHint')}</span>
          </summary>
          <div className="detail-capsule-body">
            {task.createdBy === 'ai' && (
              <div className="card-meta-line">
                <Bot size={11} /> {tr(locale, 'createdByAi')}
                {task.discoveredFromTaskId ? ` · ${tr(locale, 'discoveredFrom')} ${task.discoveredFromTaskId.slice(0, 8)}` : ''}
              </div>
            )}
            {task.userNotes?.trim() && (
              <div>
                <strong>{tr(locale, 'capsuleHumanNotes')}:</strong> {task.userNotes.trim()}
              </div>
            )}
            <div>
              <strong>{tr(locale, 'capsuleGoal')}:</strong> {task.title}
              {task.description.trim() ? ` — ${task.description.replace(/[#*`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200)}` : ''}
            </div>
            <div>
              <strong>{tr(locale, 'capsuleDecisions')}:</strong>
              {(() => {
                const promoted = task.conversations.filter((c) => c.includeInHandoff && c.summary?.trim())
                if (promoted.length === 0) return <span className="card-meta-line"> {tr(locale, 'capsuleEmpty')}</span>
                return (
                  <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                    {promoted.map((c) => (
                      <li key={`${c.subgoalId ?? ''}:${c.conversationId}`}>
                        <span className="badge">{formatConversationRole(c.role, locale)}</span> {c.summary}
                      </li>
                    ))}
                  </ul>
                )
              })()}
            </div>
            {(task.refs.length > 0 || (task.handover?.references?.length ?? 0) > 0) && (
              <div>
                <strong>{tr(locale, 'capsuleFiles')}:</strong>
                <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                  {task.refs.slice(0, 8).map((r) => (
                    <li key={r.id}>
                      [{r.kind}] {r.target}
                    </li>
                  ))}
                  {(task.handover?.references ?? [])
                    .filter((href) => !task.refs.some((r) => r.target === href))
                    .slice(0, 8)
                    .map((href) => (
                      <li key={href}>[handover] {href}</li>
                    ))}
                </ul>
              </div>
            )}
            <div>
              <strong>{tr(locale, 'capsuleNext')}:</strong> {task.nextAction?.trim() || task.prompt.trim().slice(0, 200) || '—'}
            </div>
            <button
              type="button"
              className="btn btn-xs"
              onClick={() => {
                const lines = [
                  ...(task.userNotes?.trim() ? [`${tr(locale, 'capsuleHumanNotes')}: ${task.userNotes.trim()}`] : []),
                  `${tr(locale, 'capsuleGoal')}: ${task.title}`,
                  ...(task.description.trim() ? [task.description.trim()] : []),
                  ...task.conversations
                    .filter((c) => c.includeInHandoff && c.summary?.trim())
                    .map((c) => `- (${c.role}) ${c.summary!.trim()}`),
                  ...task.refs.map((r) => `- [${r.kind}] ${r.target}`),
                  `${tr(locale, 'capsuleNext')}: ${task.nextAction?.trim() || task.prompt.trim() || '—'}`,
                ]
                if (navigator.clipboard?.writeText) {
                  void navigator.clipboard
                    .writeText(lines.join('\n'))
                    .then(() => onToast(locale === 'zh' ? '交接胶囊已复制' : 'Capsule copied'))
                    .catch(() => onToast(locale === 'zh' ? '复制失败' : 'Copy failed'))
                } else {
                  onToast(locale === 'zh' ? '当前环境不支持剪贴板' : 'Clipboard unavailable')
                }
              }}
            >
              {tr(locale, 'copyCapsule')}
            </button>
          </div>
        </details>

        {/* Bright Connected Folder Tabs */}
        <div className="detail-folder-tabs" role="tablist" aria-label="Task detail sections">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'human'}
            className={`detail-folder-tab${activeTab === 'human' ? ' is-active' : ''}`}
            onClick={() => setActiveTab('human')}
          >
            <User size={13} />
            <span>{tr(locale, 'tabMyView')}</span>
            {task.subgoalRollup.total > 0 && (
              <span className="tabular-nums" style={{ fontWeight: 400, color: 'var(--agy-muted-fg)' }}>
                {task.subgoalRollup.done}/{task.subgoalRollup.total}
              </span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'agent'}
            className={`detail-folder-tab${activeTab === 'agent' ? ' is-active' : ''}`}
            onClick={() => setActiveTab('agent')}
          >
            <Bot size={13} />
            <span>{tr(locale, 'tabAgentControl')}</span>
          </button>
        </div>
      </div>

      {/* Connected Bright Tab Body */}
      <div className="drawer-body">
        {activeTab === 'human' ? (
          <>
            {/* Zone 1A: Task Brief (1-3 sentence human-readable summary; extractShortMemo folds legacy over-long descriptions) */}
            <div className="detail-memo-card" data-testid="detail-memo-card">
              <div className="section-title">
                <span className="row-wrap" style={{ gap: 6 }}>
                  <Sparkles size={13} style={{ color: 'var(--agy-primary-text)' }} />
                  <span>{tr(locale, 'taskBrief')}</span>
                  {memoInfo.hasMore && (
                    <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--agy-muted-fg)' }}>
                      · {tr(locale, 'memoAutoDistilled')}
                    </span>
                  )}
                </span>
                <div className="row-wrap">
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    onClick={() => setDescEditing((v) => !v)}
                  >
                    {descEditing ? tr(locale, 'previewMode') : tr(locale, 'editMode')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs btn-primary"
                    disabled={busy}
                    onClick={() => handleSaveDetails()}
                  >
                    {tr(locale, 'save')}
                  </button>
                </div>
              </div>

              {!descEditing ? (
                <>
                  <div className="markdown-box" style={{ border: 'none', background: 'transparent', padding: 0 }}>
                    {memoSourceText.trim() ? (
                      memoInfo.hasMore && !showFullNotes ? (
                        <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--agy-fg)' }}>{memoInfo.memo}</div>
                      ) : (
                        <MarkdownText content={memoSourceText} />
                      )
                    ) : (
                      <span className="card-meta-line">{tr(locale, 'emptyNone')}</span>
                    )}
                  </div>
                  {memoInfo.hasMore && (
                    <div className="detail-memo-footer">
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost"
                        style={{ padding: '2px 4px' }}
                        onClick={() => setShowFullNotes((v) => !v)}
                      >
                        {showFullNotes ? `${tr(locale, 'collapseFullNotes')} ▴` : `${tr(locale, 'expandFullNotes')} ▾`}
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <textarea
                  className="textarea-field"
                  rows={2}
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                  placeholder={tr(locale, 'briefPlaceholder')}
                />
              )}
            </div>

            {/* Zone 1B: Human-Exclusive Never-Locked Notes & Alignment Control */}
            <div className="detail-human-notes-card" data-testid="human-notes-card">
              <div className="section-title">
                <span className="row-wrap" style={{ gap: 6 }}>
                  <User size={13} style={{ color: 'var(--agy-primary-text)' }} />
                  <span>{tr(locale, 'humanNotesTitle')}</span>
                  <span className="detail-ownership-pill">{tr(locale, 'humanNotesOwnershipHint')}</span>
                </span>
                <div className="row-wrap">
                  {userNotesDraft.trim() && (
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost"
                      onClick={() => setUserNotesPreview((v) => !v)}
                    >
                      {userNotesPreview ? tr(locale, 'editMode') : tr(locale, 'previewMode')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-xs btn-primary"
                    disabled={busy}
                    onClick={() => handleSaveDetails()}
                  >
                    {tr(locale, 'save')}
                  </button>
                </div>
              </div>

              {openExecution && (
                <div className="detail-nonblocking-hint" data-testid="human-notes-running-hint">
                  {tr(locale, 'editingWhileRunningHint')}
                </div>
              )}

              {userNotesPreview && userNotesDraft.trim() ? (
                <div className="markdown-box" style={{ border: 'none', background: 'transparent', padding: 0 }}>
                  <MarkdownText content={userNotesDraft} />
                </div>
              ) : (
                <textarea
                  className="textarea-field"
                  data-testid="human-notes-input"
                  aria-label={tr(locale, 'humanNotesTitle')}
                  rows={3}
                  value={userNotesDraft}
                  onChange={(e) => setUserNotesDraft(e.target.value)}
                  placeholder={tr(locale, 'humanNotesPlaceholder')}
                />
              )}
            </div>

            {/* Zone 2: Subgoals Checklist & Progress */}
            <div className="detail-section">
              <div className="section-title">
                <span className="tabular-nums">
                  {tr(locale, 'subgoals')}
                  {task.subgoalRollup.total > 0 && ` (${task.subgoalRollup.done}/${task.subgoalRollup.total})`}
                </span>
                <div className="row-wrap">
                  {task.subgoalRollup.readyForReview && (
                    <span className="badge badge-ok">{tr(locale, 'readyForReview')}</span>
                  )}
                  <button type="button" className="btn btn-xs btn-ghost" onClick={() => setShowBulkPlan((v) => !v)}>
                    {tr(locale, 'planBreakdown')}
                  </button>
                </div>
              </div>
              {task.subgoalRollup.total > 0 && (
                <div className="detail-progress-track">
                  <div
                    className="detail-progress-fill"
                    style={{ width: `${Math.round((task.subgoalRollup.done / task.subgoalRollup.total) * 100)}%` }}
                  />
                </div>
              )}

              {showBulkPlan && (
                <div className="form-label">
                  <textarea
                    className="textarea-field"
                    rows={3}
                    value={bulkPlanText}
                    onChange={(e) => setBulkPlanText(e.target.value)}
                    placeholder={tr(locale, 'subgoalsPlaceholder')}
                  />
                  <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className="btn btn-xs btn-primary"
                      disabled={!bulkPlanText.trim()}
                      onClick={() =>
                        void runAction(async () => {
                          const subgoals = bulkPlanText
                            .split(/\r?\n/)
                            .map((line) => line.trim())
                            .filter(Boolean)
                            .map((line) => {
                              const isOpt = /^\[opt\]\s*/i.test(line)
                              return {
                                title: line.replace(/^\[opt\]\s*/i, '').trim(),
                                required: !isOpt,
                              }
                            })
                          if (subgoals.length > 0) {
                            await boardApi.planBreakdown({ taskId: task.id, subgoals })
                            setBulkPlanText('')
                            setShowBulkPlan(false)
                          }
                        }, 'Added plan breakdown')
                      }
                    >
                      {tr(locale, 'save')}
                    </button>
                  </div>
                </div>
              )}

              {task.subgoals.length > 0 && (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={(e) => void handleSubgoalDragEnd(e)}
                >
                  <SortableContext items={task.subgoals.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {task.subgoals.map((sg) => (
                        <SortableSubgoalItem
                          key={sg.id}
                          subgoal={sg}
                          linkedConv={latestSubgoalConversation(task, sg)}
                          locale={locale}
                          busy={busy}
                          disabledDispatch={needsPerm || openExecution}
                          onToggleStatus={(item, next) =>
                            void runAction(() => boardApi.updateSubgoal(task.id, item.id, { status: next }))
                          }
                          onToggleRequired={(item) =>
                            void runAction(() => boardApi.updateSubgoal(task.id, item.id, { required: !item.required }))
                          }
                          onDispatchSubgoal={(item, mode, opts) =>
                            void runAction(async () => {
                              const res = await handleDispatchFromDetail({
                                subgoalId: item.id,
                                mode,
                                conversationId: opts?.conversationId,
                                reworkInstructions: opts?.reworkInstructions,
                              })
                              onToast(`Dispatched subgoal (${mode}) -> ${res.conversationId.slice(0, 8)}`)
                            })
                          }
                          onJump={(convId, opts) =>
                            void boardApi.jumpToConversation(convId, opts).then((r) => onToast(r.message))
                          }
                          onDelete={(id) => void runAction(() => boardApi.deleteSubgoal(task.id, id))}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}

              <div className="row-wrap">
                <input
                  className="input-field"
                  style={{ flex: 1 }}
                  value={subgoalInput}
                  onChange={(e) => setSubgoalInput(e.target.value)}
                  placeholder={tr(locale, 'addSubgoal')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && subgoalInput.trim()) {
                      e.preventDefault()
                      void runAction(async () => {
                        await boardApi.addSubgoal(task.id, { title: subgoalInput.trim(), required: subgoalRequired })
                        setSubgoalInput('')
                      })
                    }
                  }}
                />
                <label className="row-wrap" style={{ fontSize: 11.5 }}>
                  <input
                    type="checkbox"
                    checked={subgoalRequired}
                    onChange={(e) => setSubgoalRequired(e.target.checked)}
                  />
                  <span>{tr(locale, 'required')}</span>
                </label>
                <button
                  type="button"
                  className="btn btn-xs"
                  disabled={!subgoalInput.trim()}
                  onClick={() =>
                    void runAction(async () => {
                      await boardApi.addSubgoal(task.id, { title: subgoalInput.trim(), required: subgoalRequired })
                      setSubgoalInput('')
                    })
                  }
                  aria-label={tr(locale, 'addSubgoal')}
                >
                  <Plus size={12} />
                </button>
              </div>
            </div>

            {/* Zone 3: Properties & Neutral Schedule/Reminder Config */}
            <div className="detail-section">
              <div className="section-title">
                <span>{tr(locale, 'propsAndSchedule')}</span>
                <span
                  className="text-muted tabular-nums"
                  style={{ fontSize: 11, fontWeight: 400 }}
                  title={formatCreatedStamp(task.createdAt, Date.now(), locale).full}
                  data-testid="detail-created-at"
                >
                  {locale === 'zh'
                    ? `加入于 ${formatCreatedStamp(task.createdAt, Date.now(), locale).full}`
                    : `Added ${formatCreatedStamp(task.createdAt, Date.now(), locale).full}`}
                </span>
              </div>

              <div className="detail-prop-3col">
                <label className="detail-prop-cell">
                  <span className="detail-prop-cell-label">{tr(locale, 'status')}</span>
                  <div className="row-wrap" style={{ flexWrap: 'nowrap', gap: 4 }}>
                    <select
                      className="select-field"
                      style={{ flex: 1, minWidth: 0, padding: '3px 6px' }}
                      aria-label={tr(locale, 'status')}
                      value={task.phase}
                      onChange={(e) =>
                        void runAction(
                          () => boardApi.transitionTask(task.id, e.target.value as TaskPhase),
                          tr(locale, 'saveSuccess'),
                        )
                      }
                    >
                      <option value="needs_you">{formatPhaseLabel('needs_you', locale)}</option>
                      <option value="active">{formatPhaseLabel('active', locale)}</option>
                      <option value="on_hold">{formatPhaseLabel('on_hold', locale)}</option>
                      <option value="todo">{formatPhaseLabel('todo', locale)}</option>
                      <option value="closed">{formatPhaseLabel('closed', locale)}</option>
                    </select>
                    <select
                      className="select-field"
                      style={{ flex: 1, minWidth: 0, padding: '3px 6px' }}
                      aria-label={tr(locale, 'subPhase')}
                      value={task.subPhase}
                      onChange={(e) =>
                        void runAction(
                          () =>
                            boardApi.transitionTask(task.id, task.phase, {
                              subPhase: e.target.value as TaskSubPhase,
                            }),
                          tr(locale, 'saveSuccess'),
                        )
                      }
                    >
                      {SUBPHASES_BY_PHASE[task.phase].map((sp) => (
                        <option key={sp} value={sp}>
                          {formatPhaseSubPhaseLabel(task.phase, sp, locale)}
                        </option>
                      ))}
                    </select>
                  </div>
                </label>

                <label className="detail-prop-cell">
                  <span className="detail-prop-cell-label">{tr(locale, 'priority')}</span>
                  <select
                    className="select-field"
                    style={{ padding: '3px 6px' }}
                    aria-label={tr(locale, 'priority')}
                    value={priorityDraft}
                    onChange={(e) => setPriorityDraft(e.target.value as TaskPriority)}
                  >
                    <option value="urgent">{formatPriorityLabel('urgent', locale)}</option>
                    <option value="high">{formatPriorityLabel('high', locale)}</option>
                    <option value="normal">{formatPriorityLabel('normal', locale)}</option>
                    <option value="low">{formatPriorityLabel('low', locale)}</option>
                  </select>
                </label>

                <label className="detail-prop-cell">
                  <span className="detail-prop-cell-label">
                    <CalendarClock size={11} />
                    <span>{tr(locale, 'dueAt')}</span>
                  </span>
                  <div className="row-wrap" style={{ flexWrap: 'nowrap', gap: 3 }}>
                    <input
                      className="input-field"
                      type="datetime-local"
                      style={{ flex: 1, minWidth: 0, padding: '3px 6px', fontSize: 11.5 }}
                      value={dueAtDraft}
                      onChange={(e) => setDueAtDraft(e.target.value)}
                    />
                    {dueAtDraft && (
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost"
                        onClick={() => setDueAtDraft('')}
                        title={tr(locale, 'clear')}
                        aria-label={tr(locale, 'clear')}
                      >
                        <X size={11} />
                      </button>
                    )}
                  </div>
                </label>
              </div>

              <TaskScheduleBar
                task={task}
                locale={locale}
                defaultTimeZone={defaultTimeZone}
                sessionDefaultPermission={sessionDefaultPermission}
                busy={busy}
                onRunAction={runAction}
              />
            </div>
          </>
        ) : (
          <>
            {/* Tab 2 Zone 1: Agent Session & Human Intervention */}
            <div className="detail-cta-bar">
              <div className="row-wrap">
                {openExecution ? (
                  <>
                    {primaryConv && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() =>
                          void boardApi.jumpToConversation(primaryConv.conversationId).then((r) => onToast(r.message))
                        }
                      >
                        <ExternalLink size={12} />
                        <span>{tr(locale, 'openSession')}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-ok"
                      onClick={() =>
                        void runAction(() => boardApi.settle(task.id, 'succeeded', 'Settled from UI'), 'Execution settled')
                      }
                    >
                      {tr(locale, 'settleTurn')}
                    </button>
                  </>
                ) : (
                  <>
                    {primaryConv ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() =>
                            void boardApi.jumpToConversation(primaryConv.conversationId).then((r) => onToast(r.message))
                          }
                        >
                          <ExternalLink size={12} />
                          <span>{tr(locale, 'openSession')}</span>
                        </button>
                        {canApproveReview && (
                          isRecurringReview ? (
                            <>
                              <button type="button" className="btn btn-ok" onClick={handleAcceptRecurringRound}>
                                <CheckCircle2 size={12} />
                                <span>{tr(locale, 'acceptRound')}</span>
                              </button>
                              <button
                                type="button"
                                className="btn btn-xs btn-ghost"
                                onClick={() =>
                                  void runAction(async () => {
                                    await boardApi.setSchedule(task.id, { enabled: false })
                                    await boardApi.transitionTask(task.id, 'closed', { subPhase: 'done' })
                                  }, locale === 'zh' ? '已完结并停用定时' : 'Closed & stopped schedule')
                                }
                              >
                                <span>{tr(locale, 'closeAndStop')}</span>
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-ok"
                              onClick={() =>
                                void runAction(
                                  () => boardApi.transitionTask(task.id, 'closed', { subPhase: 'done' }),
                                  tr(locale, 'approvePass'),
                                )
                              }
                            >
                              <CheckCircle2 size={12} />
                              <span>{tr(locale, 'approvePass')}</span>
                            </button>
                          )
                        )}
                        {task.phase !== 'closed' && (
                          <button
                            type="button"
                            className="btn"
                            disabled={busy || needsPerm}
                            onClick={() =>
                              void runAction(
                                () =>
                                  handleDispatchFromDetail({
                                    mode: 'resume',
                                    conversationId: primaryConv.conversationId,
                                  }),
                                'Resumed session',
                              )
                            }
                          >
                            <RotateCcw size={12} />
                            <span>{tr(locale, 'continueSession')}</span>
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        {isRecurringReview && (
                          <>
                            <button type="button" className="btn btn-ok" onClick={handleAcceptRecurringRound}>
                              <CheckCircle2 size={12} />
                              <span>{tr(locale, 'acceptRound')}</span>
                            </button>
                            <button
                              type="button"
                              className="btn btn-xs btn-ghost"
                              onClick={() =>
                                void runAction(async () => {
                                  await boardApi.setSchedule(task.id, { enabled: false })
                                  await boardApi.transitionTask(task.id, 'closed', { subPhase: 'done' })
                                }, locale === 'zh' ? '已完结并停用定时' : 'Closed & stopped schedule')
                              }
                            >
                              <span>{tr(locale, 'closeAndStop')}</span>
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy || needsPerm}
                          onClick={() =>
                            void runAction(async () => {
                              const res = await handleDispatchFromDetail({ mode: 'new' })
                              onToast(`Started conversation ${res.conversationId.slice(0, 8)}`)
                            })
                          }
                        >
                          <Play size={12} />
                          <span>
                            {wsShortName ? `${tr(locale, 'startSessionIn')} ${wsShortName}` : tr(locale, 'startSession')}
                          </span>
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>

              {!openExecution && primaryConv && (
                <div className="row-wrap">
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    onClick={() =>
                      void boardApi
                        .jumpToConversation(primaryConv.conversationId, { split: 'right' })
                        .then((r) => onToast(r.message))
                    }
                  >
                    <Columns2 size={11} />
                    <span>{tr(locale, 'splitRight')}</span>
                  </button>
                  <button
                    type="button"
                    className={`btn btn-xs btn-ghost${showReworkBox ? ' is-active' : ''}`}
                    disabled={busy || needsPerm}
                    onClick={() => setShowReworkBox((v) => !v)}
                  >
                    <MessageSquareReply size={11} />
                    <span>{tr(locale, 'rework')}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    disabled={busy || needsPerm}
                    onClick={() =>
                      void runAction(async () => {
                        const res = await handleDispatchFromDetail({ mode: 'new' })
                        onToast(`Started conversation ${res.conversationId.slice(0, 8)}`)
                      })
                    }
                  >
                    <Plus size={11} />
                    <span>{tr(locale, 'relayNew')}</span>
                  </button>
                </div>
              )}
            </div>

            {/* Inline Rework Input */}
            {showReworkBox && primaryConv && !openExecution && (
              <div className="row-wrap">
                <input
                  className="input-field"
                  style={{ flex: 1 }}
                  value={reworkText}
                  onChange={(e) => setReworkText(e.target.value)}
                  placeholder={tr(locale, 'reworkPlaceholder')}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setShowReworkBox(false)
                    if (e.key === 'Enter' && !e.shiftKey && reworkText.trim() && !needsPerm && !busy) {
                      e.preventDefault()
                      void runAction(async () => {
                        await handleDispatchFromDetail({
                          mode: 'rework',
                          conversationId: primaryConv.conversationId,
                          reworkInstructions: reworkText.trim(),
                        })
                        setReworkText('')
                        setShowReworkBox(false)
                      }, 'Sent rework instructions')
                    }
                  }}
                  autoFocus
                />
                <button
                  type="button"
                  className="btn btn-xs btn-primary"
                  disabled={busy || needsPerm || !reworkText.trim()}
                  onClick={() =>
                    void runAction(async () => {
                      await handleDispatchFromDetail({
                        mode: 'rework',
                        conversationId: primaryConv.conversationId,
                        reworkInstructions: reworkText.trim(),
                      })
                      setReworkText('')
                      setShowReworkBox(false)
                    }, 'Sent rework instructions')
                  }
                >
                  <Send size={11} />
                  <span>{tr(locale, 'sendRework')}</span>
                </button>
              </div>
            )}

            {/* Tab 2 Zone 2: Agent Execution Contract / Task Plan (Markdown preview + expandable non-blocking editor) */}
            <div className="detail-contract-card" data-testid="agent-contract-card">
              <div className="section-title">
                <span className="row-wrap" style={{ gap: 6 }}>
                  <FileText size={13} style={{ color: 'var(--agy-primary-text)' }} />
                  <span>{tr(locale, 'agentContractTitle')}</span>
                  <span className="badge tabular-nums">rev #{task.planRevision}</span>
                  {userNotesDraft.trim() && (
                    <span className="detail-ownership-pill">{tr(locale, 'humanNotesActiveBadge')}</span>
                  )}
                </span>
                <div className="row-wrap">
                  {contractEditing && (
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost"
                      onClick={() => setContractExpanded((v) => !v)}
                    >
                      {contractExpanded ? tr(locale, 'collapseEditor') : tr(locale, 'expandEditor')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    onClick={() => setContractEditing((v) => !v)}
                  >
                    {contractEditing ? tr(locale, 'previewMode') : tr(locale, 'editMode')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs btn-primary"
                    disabled={busy}
                    onClick={() => handleSaveDetails()}
                  >
                    {tr(locale, 'save')}
                  </button>
                </div>
              </div>

              {openExecution && (
                <div className="detail-nonblocking-hint" data-testid="contract-running-hint">
                  {tr(locale, 'editingWhileRunningHint')}
                </div>
              )}

              {contractEditing ? (
                <textarea
                  className="textarea-field"
                  data-testid="agent-contract-input"
                  aria-label={tr(locale, 'agentContractTitle')}
                  rows={contractExpanded ? 12 : 5}
                  value={promptDraft}
                  onChange={(e) => setPromptDraft(e.target.value)}
                  placeholder={tr(locale, 'agentContractPlaceholder')}
                />
              ) : (
                <div className="markdown-box" style={{ border: 'none', background: 'transparent', padding: 0 }}>
                  {promptDraft.trim() ? (
                    <MarkdownText content={promptDraft} />
                  ) : (
                    <span className="card-meta-line">{tr(locale, 'emptyNone')}</span>
                  )}
                </div>
              )}
            </div>

            {/* Workspace Binding inside Agent Environment */}
            <label className="form-label">
              <span>{tr(locale, 'workspace')}</span>
              <select
                className="select-field"
                aria-label={tr(locale, 'workspace')}
                value={selectedFolderChoiceKey}
                onChange={(e) => {
                  const val = e.target.value
                  if (!val) {
                    void runAction(
                      () => boardApi.updateTask(task.id, { workspaceId: null, workspacePath: null }),
                      'Workspace unbound',
                    )
                    return
                  }
                  const decoded = decodeWorkspaceFolderValue(val)
                  if (decoded) {
                    void runAction(
                      () =>
                        boardApi.updateTask(task.id, {
                          workspaceId: decoded.workspaceId,
                          workspacePath: decoded.folderPath,
                        }),
                      'Workspace updated',
                    )
                  }
                }}
              >
                <option value="">-- {tr(locale, 'unboundBadge')} --</option>
                {selectedFolderChoiceKey === '__custom_path__' && task.workspacePath && (
                  <option value="__custom_path__">
                    {task.workspaceLabel ? `${task.workspaceLabel} — ` : ''}
                    {task.workspacePath}
                  </option>
                )}
                {folderChoices.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.pinned ? '★ ' : ''}
                    {c.label}
                  </option>
                ))}
              </select>
            </label>

            {/* Auxiliary Links, Refs & Collapsed Advanced Settings */}
            <div className="detail-aux-zone">
          {/* Linked Conversations */}
          <div className="detail-aux-section">
          <div className="section-title">
            <span>{tr(locale, 'conversations')}</span>
            <div className="row-wrap">
              {task.workspacePath && (
                <label className="row-wrap" style={{ fontSize: 11, fontWeight: 400 }}>
                  <input
                    type="checkbox"
                    checked={showAllConvs}
                    onChange={(e) => setShowAllConvs(e.target.checked)}
                  />
                  <span>{tr(locale, 'allWorkspaces')}</span>
                </label>
              )}
              <span className="badge">{task.conversations.length}</span>
            </div>
          </div>

          {task.conversations.map((c) => {
            const linkedSg = c.subgoalId ? task.subgoals.find((s) => s.id === c.subgoalId) : undefined
            return (
              <div key={`${c.subgoalId ?? ''}:${c.conversationId}`} className="row-wrap" style={{ justifyContent: 'space-between' }}>
                <span className="card-meta-line" style={{ flex: 1, minWidth: 0 }}>
                  <span className="badge">{formatConversationRole(c.role, locale)}</span>{' '}
                  <FolderGit2 size={11} /> {c.title || c.conversationId.slice(0, 8)}
                  {linkedSg ? ` · ${linkedSg.title}` : ''}
                  {c.isIdle !== undefined ? (c.isIdle ? ' · idle' : ' · running') : ''}
                  {c.summary?.trim() && (
                    <span style={{ display: 'block', whiteSpace: 'normal', color: 'var(--agy-muted-fg)' }}>
                      {c.summary.trim().slice(0, 160)}
                    </span>
                  )}
                </span>
                <div className="row-wrap">
                  <button
                    type="button"
                    className={`btn btn-xs ${c.includeInHandoff ? 'btn-ok' : 'btn-ghost'}`}
                    title={tr(locale, 'includeInHandoff')}
                    disabled={busy}
                    onClick={() =>
                      void runAction(
                        () =>
                          boardApi.updateConversationMeta(task.id, {
                            conversationId: c.conversationId,
                            subgoalId: c.subgoalId,
                            includeInHandoff: !c.includeInHandoff,
                          }),
                        c.includeInHandoff
                          ? locale === 'zh'
                            ? '已移出交接胶囊'
                            : 'Removed from handoff'
                          : locale === 'zh'
                            ? '已纳入交接胶囊'
                            : 'Added to handoff',
                      )
                    }
                  >
                    <Star size={11} fill={c.includeInHandoff ? 'currentColor' : 'none'} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    onClick={() => void boardApi.jumpToConversation(c.conversationId).then((r) => onToast(r.message))}
                    title={tr(locale, 'openSession')}
                  >
                    <ExternalLink size={11} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    title={tr(locale, 'splitRight')}
                    onClick={() =>
                      void boardApi
                        .jumpToConversation(c.conversationId, { split: 'right' })
                        .then((r) => onToast(r.message))
                    }
                  >
                    <Columns2 size={11} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    onClick={() =>
                      void runAction(() => boardApi.unlinkConversation(task.id, c.conversationId, c.subgoalId ?? ''))
                    }
                    title={tr(locale, 'delete')}
                  >
                    <X size={11} />
                  </button>
                </div>
              </div>
            )
          })}

          <div className="row-wrap" style={{ marginBottom: 6 }}>
            <input
              className="input-field"
              style={{ flex: '1 1 160px', fontSize: 11.5 }}
              value={convSearch}
              onChange={(e) => {
                setConvSearch(e.target.value)
                setConvLimit(100)
              }}
              placeholder={tr(locale, 'searchConversationsPlaceholder')}
              data-testid="conv-search-input"
            />
            {convLoading && (
              <span className="card-meta-line" style={{ fontSize: 11 }}>
                {tr(locale, 'loadingConversations')}
              </span>
            )}
            {convHasMore && (
              <button
                type="button"
                className="btn btn-xs"
                disabled={convLoading}
                data-testid="conv-load-more-btn"
                onClick={() => setConvLimit((n) => n + 100)}
              >
                {tr(locale, 'loadMoreConversations')}
              </button>
            )}
          </div>

          <div className="row-wrap">
            <select
              className="select-field"
              style={{ flex: '1 1 160px' }}
              value={bindConvId}
              onChange={(e) => setBindConvId(e.target.value)}
            >
              <option value="">{tr(locale, 'bindConversation')}</option>
              {workspaceConvs.map((c) => (
                <option key={c.conversationId} value={c.conversationId}>
                  {c.title} ({c.conversationId.slice(0, 8)})
                </option>
              ))}
            </select>
            <select
              className="select-field"
              style={{ width: 90 }}
              value={bindRole}
              onChange={(e) => setBindRole(e.target.value as ConversationRole)}
              aria-label="Conversation role"
            >
              <option value="primary">{locale === 'zh' ? '主会话' : 'primary'}</option>
              <option value="origin">{locale === 'zh' ? '来源' : 'origin'}</option>
              <option value="worker">{locale === 'zh' ? '协作' : 'worker'}</option>
              <option value="reviewer">{locale === 'zh' ? '审阅' : 'reviewer'}</option>
              <option value="reference">{locale === 'zh' ? '参考' : 'reference'}</option>
            </select>
            {task.subgoals.length > 0 && (
              <select
                className="select-field"
                style={{ maxWidth: 140 }}
                value={bindSubgoalId}
                onChange={(e) => {
                  const nextSg = e.target.value
                  setBindSubgoalId(nextSg)
                  if (nextSg && bindRole === 'primary') setBindRole('worker')
                }}
                aria-label="Subgoal target"
              >
                <option value="">{tr(locale, 'taskLevel')}</option>
                {task.subgoals.map((sg) => (
                  <option key={sg.id} value={sg.id}>
                    {sg.title}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="btn btn-xs"
              disabled={!bindConvId}
              onClick={() =>
                void runAction(async () => {
                  await boardApi.linkConversation(task.id, {
                    conversationId: bindConvId,
                    role: bindRole,
                    ...(bindSubgoalId ? { subgoalId: bindSubgoalId } : {}),
                  })
                  setBindConvId('')
                }, 'Conversation linked')
              }
              aria-label={tr(locale, 'bindConversation')}
            >
              <Link2 size={11} />
            </button>
          </div>
        </div>

        {/* TaskSpace Deliverables / Refs */}
        <div className="detail-aux-section">
          <div className="section-title">
            <span>{tr(locale, 'deliverables')}</span>
            <span className="badge">{task.refs.length}</span>
          </div>

          {task.refs.map((ref) => {
            const trimmedTarget = ref.target.trim()
            const hasNonFileUriScheme =
              /^[a-zA-Z][a-zA-Z0-9+.-]{1,}:/.test(trimmedTarget) && !trimmedTarget.toLowerCase().startsWith('file://')
            const canFileView =
              Boolean(sidecar?.ui?.toggleAuxPane) &&
              (ref.kind === 'file' || ref.kind === 'artifact' || ref.kind === 'doc') &&
              !hasNonFileUriScheme
            const safeUrl = isSafeExternalUrl(trimmedTarget)
            return (
              <div key={ref.id} className="row-wrap" style={{ justifyContent: 'space-between' }}>
                <span className="card-meta-line" style={{ flex: 1, minWidth: 0 }} title={ref.target}>
                  <span className="badge">{ref.kind}</span>{' '}
                  {ref.label ? <strong>{ref.label}: </strong> : null}
                  {safeUrl ? (
                    <a
                      href={ref.target}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="md-link"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {ref.target}
                    </a>
                  ) : (
                    ref.target
                  )}
                </span>
                <div className="row-wrap">
                  {safeUrl && (
                    <a
                      className="btn btn-xs btn-ghost"
                      href={ref.target}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={11} />
                    </a>
                  )}
                  {canFileView && (
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost"
                      onClick={() => void handleOpenRefInFileView(ref)}
                      title={tr(locale, 'openInAuxFileView')}
                    >
                      <ExternalLink size={11} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-xs"
                    onClick={() => void boardApi.previewRef(task.id, ref.id).then((res) => setPreview(res))}
                  >
                    <Eye size={11} />
                    <span>{tr(locale, 'preview')}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    onClick={() => void runAction(() => boardApi.removeRef(task.id, ref.id))}
                    aria-label={tr(locale, 'delete')}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>
            )
          })}

          <div className="row-wrap">
            <select
              className="select-field"
              value={refKind}
              onChange={(e) => setRefKind(e.target.value as TaskRefKind)}
            >
              <option value="file">{locale === 'zh' ? '文件' : 'file'}</option>
              <option value="url">{locale === 'zh' ? '链接' : 'url'}</option>
              <option value="artifact">{locale === 'zh' ? '产物' : 'artifact'}</option>
              <option value="command">{locale === 'zh' ? '命令' : 'command'}</option>
              <option value="doc">{locale === 'zh' ? '文档' : 'doc'}</option>
            </select>
            <input
              className="input-field"
              style={{ flex: '1 1 130px' }}
              value={refTarget}
              onChange={(e) => setRefTarget(e.target.value)}
              placeholder={tr(locale, 'addRefPlaceholder')}
            />
            <input
              className="input-field"
              style={{ width: 95 }}
              value={refLabel}
              onChange={(e) => setRefLabel(e.target.value)}
              placeholder={tr(locale, 'refLabelPlaceholder')}
            />
            <button
              type="button"
              className="btn btn-xs"
              disabled={!refTarget.trim()}
              onClick={() =>
                void runAction(async () => {
                  await boardApi.addRef(task.id, {
                    kind: refKind,
                    target: refTarget.trim(),
                    ...(refLabel.trim() ? { label: refLabel.trim() } : {}),
                  })
                  setRefTarget('')
                  setRefLabel('')
                })
              }
              aria-label={tr(locale, 'deliverables')}
            >
              <Plus size={12} />
            </button>
          </div>
        </div>

        {/* Progressive Disclosure: Collapsed Advanced Settings */}
        <details className="fold-section" data-testid="advanced-settings-fold">
          <summary className="fold-summary">
            <span className="row-wrap">
              <Sliders size={12} />
              <span>{tr(locale, 'advancedSettings')}</span>
              {advancedBadges.length > 0 && (
                <span className="text-muted" style={{ fontWeight: 400, fontSize: 11 }}>
                  · {advancedBadges.join(' · ')}
                </span>
              )}
            </span>
            <ChevronRight size={13} />
          </summary>

          <div className="fold-body">
            {/* Sub-fold 1: Execution Prompt, Subfolder Override, Worktree & Model */}
            <details className="fold-subitem">
              <summary className="fold-summary">
                <span className="row-wrap">
                  <GitBranch size={12} />
                  <span>{tr(locale, 'execAndWorktree')}</span>
                </span>
                <ChevronRight size={12} />
              </summary>
              <div className="fold-body">
                <label className="form-label">
                  <span>{tr(locale, 'nextAction')}</span>
                  <input
                    className="input-field"
                    value={nextActionDraft}
                    onChange={(e) => setNextActionDraft(e.target.value)}
                    placeholder="Next concrete step"
                  />
                </label>

                <div className="row-wrap">
                  <input
                    className="input-field"
                    style={{ flex: 1, fontSize: 11.5 }}
                    value={workspacePathDraft}
                    onChange={(e) => setWorkspacePathDraft(e.target.value)}
                    placeholder="Workspace subfolder path (optional)"
                  />
                  <button
                    type="button"
                    className="btn btn-xs"
                    disabled={busy || workspacePathDraft.trim() === (task.workspacePath ?? '')}
                    onClick={() =>
                      void runAction(
                        () => boardApi.updateTask(task.id, resolveWorkspacePatchForDraft(workspacePathDraft)),
                        'Workspace path saved',
                      )
                    }
                  >
                    {tr(locale, 'applyPath')}
                  </button>
                </div>

                <label className="form-label">
                  <span>{tr(locale, 'tags')}</span>
                  <input
                    className="input-field"
                    value={tagsDraft}
                    onChange={(e) => setTagsDraft(e.target.value)}
                  />
                </label>

                <div className="row-wrap">
                  <label className="form-label" style={{ flex: '1 1 95px' }}>
                    <span>{tr(locale, 'modeLabel')}</span>
                    <input
                      className="input-field"
                      value={modeDraft}
                      onChange={(e) => setModeDraft(e.target.value)}
                      placeholder="code / plan"
                    />
                  </label>
                  <label className="form-label" style={{ flex: '1 1 110px' }}>
                    <span>{tr(locale, 'modelLabel')}</span>
                    <input
                      className="input-field"
                      value={modelDraft}
                      onChange={(e) => setModelDraft(e.target.value)}
                      placeholder="optional"
                    />
                  </label>
                  <label className="form-label" style={{ flex: '1 1 105px' }}>
                    <span>{tr(locale, 'reasoningEffortLabel')}</span>
                    <input
                      className="input-field"
                      value={effortDraft}
                      onChange={(e) => setEffortDraft(e.target.value)}
                      placeholder="low/med/high"
                    />
                  </label>
                </div>

                <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
                  <div className="row-wrap">
                    <label className="row-wrap" style={{ fontSize: 11.5 }}>
                      <input
                        type="checkbox"
                        checked={reuseDraft}
                        onChange={(e) => setReuseDraft(e.target.checked)}
                      />
                      <span>{tr(locale, 'reuseSession')}</span>
                    </label>
                    <label className="row-wrap" style={{ fontSize: 11.5 }}>
                      <input
                        type="checkbox"
                        checked={useWorktreeDraft}
                        onChange={(e) => setUseWorktreeDraft(e.target.checked)}
                      />
                      <span>{tr(locale, 'useWorktree')}</span>
                    </label>
                  </div>
                  <button type="button" className="btn btn-xs btn-primary" disabled={busy} onClick={() => handleSaveDetails()}>
                    {tr(locale, 'save')}
                  </button>
                </div>

                {(useWorktreeDraft || Boolean(task.worktreePath) || Boolean(worktreeDiff)) && (
                  <div className="fold-subpanel">
                    <div className="section-title">
                      <span>Git Worktree</span>
                      <div className="row-wrap">
                        <button type="button" className="btn btn-xs" disabled={busy} onClick={() => void handleLoadDiff()}>
                          {tr(locale, 'worktreeDiff')}
                        </button>
                        {(task.worktreePath || worktreeDiff?.worktreePath || worktreeDiff?.exists) && (
                          <button
                            type="button"
                            className="btn btn-xs btn-danger"
                            disabled={busy || openExecution}
                            onClick={() =>
                              void runAction(async () => {
                                await boardApi.cleanupWorktree(task.id)
                                setWorktreeDiff(null)
                              }, 'Worktree cleaned up')
                            }
                          >
                            {tr(locale, 'cleanupWorktree')}
                          </button>
                        )}
                      </div>
                    </div>
                    {(task.worktreePath || worktreeDiff?.worktreePath) && (
                      <div className="card-meta-line" style={{ whiteSpace: 'normal' }}>
                        {task.worktreeBranch || worktreeDiff?.branch ? `[${task.worktreeBranch || worktreeDiff?.branch}] ` : ''}
                        {task.worktreePath || worktreeDiff?.worktreePath}
                      </div>
                    )}
                    {worktreeDiff && renderWorktreeDiffBox(worktreeDiff)}
                  </div>
                )}
              </div>
            </details>

            {/* Sub-fold 2: Write Gate, Permission & Handover Bundle */}
            <details className="fold-subitem">
              <summary className="fold-summary">
                <span className="row-wrap">
                  <Lock size={12} />
                  <span>{tr(locale, 'gateAndHandover')}</span>
                </span>
                <ChevronRight size={12} />
              </summary>
              <div className="fold-body">
                <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
                  <button
                    type="button"
                    className={`btn btn-xs ${task.writeGate === 'locked' ? 'btn-danger' : ''}`}
                    onClick={() =>
                      void runAction(
                        () =>
                          boardApi.updateTask(task.id, {
                            writeGate: task.writeGate === 'locked' ? 'unlocked' : 'locked',
                          }),
                        task.writeGate === 'locked' ? 'Write Gate unlocked' : 'Write Gate locked',
                      )
                    }
                  >
                    {task.writeGate === 'locked' ? <Lock size={11} /> : <Unlock size={11} />}
                    <span>{task.writeGate === 'locked' ? tr(locale, 'writeGateLocked') : tr(locale, 'writeGateUnlocked')}</span>
                  </button>

                  {task.phase !== 'closed' && !openExecution && (
                    <div className="row-wrap">
                      {task.subgoalRollup.requiredRemaining > 0 && (
                        <button
                          type="button"
                          className="btn btn-xs"
                          onClick={() =>
                            void runAction(
                              () => boardApi.transitionTask(task.id, 'closed', { subPhase: 'done', force: true }),
                              'Force closed',
                            )
                          }
                        >
                          {tr(locale, 'forceClose')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-xs"
                        onClick={() =>
                          void runAction(
                            () => boardApi.transitionTask(task.id, 'closed', { subPhase: 'cancelled' }),
                            'Task cancelled',
                          )
                        }
                      >
                        {tr(locale, 'cancelTask')}
                      </button>
                    </div>
                  )}
                </div>

                <div className="row-wrap">
                  <label className="form-label" style={{ width: 155 }}>
                    <span>{tr(locale, 'permission')}</span>
                    <select
                      className="select-field"
                      value={permissionDraft}
                      onChange={(e) => setPermissionDraft(e.target.value as TaskPermission | '')}
                    >
                      <option value="">inherit</option>
                      <option value="read-only">read-only</option>
                      <option value="workspace-write">workspace-write</option>
                      <option value="danger-full-access">danger-full-access</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className="btn btn-xs"
                    style={{ alignSelf: 'flex-end' }}
                    disabled={busy}
                    onClick={() => handleSaveDetails()}
                  >
                    {tr(locale, 'save')}
                  </button>
                </div>

                <div className="fold-subpanel">
                  <div className="section-title">
                    <span>{tr(locale, 'handoverBundle')}</span>
                    {task.handover && (
                      <span className="badge">
                        {task.handover.permission ?? 'inherit'} · {task.handover.references.length} refs
                      </span>
                    )}
                  </div>
                  <div className="row-wrap">
                    <label className="form-label" style={{ flex: '1 1 140px' }}>
                      <span>{tr(locale, 'workspace')}</span>
                      <select
                        className="select-field"
                        value={handoverWsId}
                        onChange={(e) => setHandoverWsId(e.target.value)}
                      >
                        <option value="">-- Inherit task workspace --</option>
                        {workspaces.map((ws) => (
                          <option key={ws.id} value={ws.id}>
                            {ws.name} ({ws.id})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="form-label" style={{ width: 105 }}>
                      <span>{tr(locale, 'handoverMode')}</span>
                      <input
                        className="input-field"
                        value={handoverMode}
                        onChange={(e) => setHandoverMode(e.target.value)}
                        placeholder="code / plan"
                      />
                    </label>
                    <label className="form-label" style={{ width: 135 }}>
                      <span>{tr(locale, 'permission')}</span>
                      <select
                        className="select-field"
                        value={handoverPerm}
                        onChange={(e) => setHandoverPerm(e.target.value as TaskPermission | '')}
                      >
                        <option value="">inherit</option>
                        <option value="read-only">read-only</option>
                        <option value="workspace-write">workspace-write</option>
                        <option value="danger-full-access">danger-full-access</option>
                      </select>
                    </label>
                  </div>
                  <label className="form-label">
                    <span>{tr(locale, 'handoverRefs')}</span>
                    <textarea
                      className="textarea-field"
                      rows={2}
                      value={handoverRefsRaw}
                      onChange={(e) => setHandoverRefsRaw(e.target.value)}
                      placeholder="src/client/App.tsx&#10;README.md"
                    />
                  </label>
                  <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
                    {task.handover && (
                      <button
                        type="button"
                        className="btn btn-xs btn-danger"
                        disabled={busy}
                        onClick={() =>
                          void runAction(() => boardApi.updateTask(task.id, { handover: null }), 'Handover cleared')
                        }
                      >
                        {tr(locale, 'clearHandover')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-xs"
                      disabled={busy}
                      onClick={() => {
                        const refs = handoverRefsRaw
                          .split(/\r?\n/)
                          .map((s) => s.trim())
                          .filter(Boolean)
                        void runAction(
                          () =>
                            boardApi.updateTask(task.id, {
                              handover: {
                                ...(handoverWsId.trim() ? { workspaceId: handoverWsId.trim() } : {}),
                                ...(handoverMode.trim() ? { mode: handoverMode.trim() } : {}),
                                ...(handoverPerm ? { permission: handoverPerm } : {}),
                                references: refs,
                              },
                            }),
                          'Handover saved',
                        )
                      }}
                    >
                      {tr(locale, 'saveHandover')}
                    </button>
                  </div>
                </div>
              </div>
            </details>

            {/* Sub-fold 3: Context Freeze Snapshot */}
            <details className="fold-subitem">
              <summary className="fold-summary">
                <span>{tr(locale, 'freezeSnapshot')}</span>
                <ChevronRight size={12} />
              </summary>
              <div className="fold-body">
                <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
                  <button type="button" className="btn btn-xs" onClick={() => setShowPasteBox((v) => !v)}>
                    {tr(locale, 'pasteFreeze')}
                  </button>
                </div>
                {showPasteBox && (
                  <div className="form-label">
                    <textarea
                      className="textarea-field"
                      rows={4}
                      value={freezePaste}
                      onChange={(e) => setFreezePaste(e.target.value)}
                      placeholder={'<<<FREEZE\nGoal:\n...\nProgress:\n...\nNext:\n...\n>>>FREEZE'}
                    />
                    <button
                      type="button"
                      className="btn btn-xs"
                      onClick={() => {
                        const parsed = parseFreezeRequest(freezePaste)
                        if (!parsed.ok) {
                          onToast(parsed.error.message)
                          return
                        }
                        setFreezeGoal(parsed.snapshot.goal)
                        setFreezeProgress(parsed.snapshot.progress)
                        setFreezeNext(parsed.snapshot.next)
                        setShowPasteBox(false)
                        if (parsed.warnings.includes('redacted')) onToast('Sensitive credentials redacted!')
                      }}
                    >
                      {tr(locale, 'applyParsedFreeze')}
                    </button>
                  </div>
                )}
                <input
                  className="input-field"
                  value={freezeGoal}
                  onChange={(e) => setFreezeGoal(e.target.value)}
                  placeholder={tr(locale, 'goal')}
                />
                <input
                  className="input-field"
                  value={freezeProgress}
                  onChange={(e) => setFreezeProgress(e.target.value)}
                  placeholder={tr(locale, 'progress')}
                />
                <input
                  className="input-field"
                  value={freezeNext}
                  onChange={(e) => setFreezeNext(e.target.value)}
                  placeholder={tr(locale, 'next')}
                />
                <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="btn btn-xs"
                    data-testid="save-freeze-btn"
                    onClick={() => {
                      const hasAny = Boolean(freezeGoal.trim() || freezeProgress.trim() || freezeNext.trim())
                      void runAction(
                        () =>
                          boardApi.updateTask(task.id, {
                            freeze: hasAny
                              ? { goal: freezeGoal.trim(), progress: freezeProgress.trim(), next: freezeNext.trim() }
                              : null,
                          }),
                        hasAny ? 'Freeze snapshot saved' : 'Freeze snapshot cleared',
                      )
                    }}
                  >
                    {tr(locale, 'save')}
                  </button>
                </div>
              </div>
            </details>

            {/* Sub-fold 5: Comments, Execution History & Events */}
            <details className="fold-subitem">
              <summary className="fold-summary">
                <span className="row-wrap">
                  <MessageSquare size={12} />
                  <span>{tr(locale, 'commentsAndHistory')}</span>
                </span>
                <ChevronRight size={12} />
              </summary>
              <div className="fold-body">
                {comments.length > 0 && (
                  <div className="comments-list">
                    {comments.map((c) => (
                      <div key={c.id} className="comment-card">
                        <div className="comment-meta">
                          <strong>{c.author || 'user'}</strong>
                          <span>{new Date(c.createdAt).toLocaleString()}</span>
                        </div>
                        <MarkdownText content={c.bodyMd} />
                      </div>
                    ))}
                  </div>
                )}

                <div className="form-label">
                  <textarea
                    className="textarea-field"
                    rows={2}
                    value={commentBodyDraft}
                    onChange={(e) => setCommentBodyDraft(e.target.value)}
                    placeholder={tr(locale, 'commentPlaceholder')}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault()
                        handleAddComment()
                      }
                    }}
                  />
                  <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
                    <input
                      className="input-field"
                      style={{ width: 105, fontSize: 11.5 }}
                      value={commentAuthorDraft}
                      onChange={(e) => setCommentAuthorDraft(e.target.value)}
                      placeholder="user"
                    />
                    <button
                      type="button"
                      className="btn btn-xs btn-primary"
                      disabled={busy || !commentBodyDraft.trim()}
                      onClick={handleAddComment}
                    >
                      <Send size={11} />
                      <span>{tr(locale, 'addComment')}</span>
                    </button>
                  </div>
                </div>

                {task.executions.length > 0 && (
                  <div className="exec-list">
                    <div className="sublane-label">{tr(locale, 'executions')}</div>
                    {[...task.executions].reverse().slice(0, 8).map((ex) => (
                      <div key={ex.id} className="exec-card">
                        <div className="exec-header">
                          <span className="row-wrap">
                            <span
                              className={`badge ${
                                ex.result === 'succeeded'
                                  ? 'badge-ok'
                                  : ex.result === 'failed'
                                    ? 'badge-danger'
                                    : ex.result === 'cancelled'
                                      ? 'badge-warn'
                                      : 'badge-active'
                              }`}
                            >
                              {ex.result ?? 'running'}
                            </span>
                            {ex.planRevision !== undefined && (
                              <span className="badge tabular-nums">rev #{ex.planRevision}</span>
                            )}
                            <span>{new Date(ex.startedAt).toLocaleString()}</span>
                          </span>
                          {ex.conversationId && (
                            <button
                              type="button"
                              className="btn btn-xs"
                              onClick={() =>
                                void boardApi.jumpToConversation(ex.conversationId!).then((r) => onToast(r.message))
                              }
                            >
                              <ExternalLink size={10} />
                              <span>{ex.conversationId.slice(0, 8)}</span>
                            </button>
                          )}
                        </div>
                        {ex.reworkInstructions && (
                          <div className="exec-subblock">
                            <strong>Rework:</strong> {ex.reworkInstructions}
                          </div>
                        )}
                        {ex.error && <div className="exec-subblock text-danger">Error: {ex.error}</div>}
                        {ex.summary && (
                          <div className="exec-summary">
                            <MarkdownText content={ex.summary} />
                          </div>
                        )}
                        {ex.contractSnapshot && (
                          <details className="exec-subblock" style={{ marginTop: 4 }}>
                            <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--agy-muted-fg)' }}>
                              {tr(locale, 'contractSnapshot')} (rev #{ex.contractSnapshot.planRevision})
                            </summary>
                            <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5 }}>
                              {ex.contractSnapshot.userNotes.trim() && (
                                <div>
                                  <strong>{tr(locale, 'humanNotesTitle')}:</strong> {ex.contractSnapshot.userNotes}
                                </div>
                              )}
                              {ex.contractSnapshot.description.trim() && (
                                <div>
                                  <strong>{tr(locale, 'taskBrief')}:</strong> {ex.contractSnapshot.description}
                                </div>
                              )}
                              {ex.contractSnapshot.prompt.trim() && (
                                <pre className="code-preview" style={{ maxHeight: 120, margin: 0 }}>
                                  {ex.contractSnapshot.prompt}
                                </pre>
                              )}
                            </div>
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {events.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div className="sublane-label">{tr(locale, 'timeline')}</div>
                    {events.slice(0, 12).map((ev) => (
                      <div key={ev.id} className="card-meta-line">
                        [{new Date(ev.createdAt).toLocaleTimeString()}] <strong>{ev.kind}</strong> ({ev.source})
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </details>
          </div>
        </details>
        </div>
          </>
        )}
      </div>

      {/* Concise Review Shortcut Hints */}
      <div className="shortcut-hint-bar detail-shortcut-bar" data-testid="detail-shortcut-hints">
        {isDraft && (
          <span className="shortcut-hint-item">
            <kbd className="shortcut-kbd">A</kbd>
            <span>{tr(locale, 'shortcutApproveReady')}</span>
          </span>
        )}
        <span className="shortcut-hint-item">
          <kbd className="shortcut-kbd">F</kbd>
          <span>{tr(locale, 'shortcutToggleFocus')}</span>
        </span>
        {task.phase !== 'closed' && (
          <span className="shortcut-hint-item">
            <kbd className="shortcut-kbd">S</kbd>
            <span>{tr(locale, 'shortcutSnooze')}</span>
          </span>
        )}
        {task.phase !== 'closed' && !openExecution && (
          <span className="shortcut-hint-item">
            <kbd className="shortcut-kbd">D</kbd>
            <span>{tr(locale, 'shortcutDispatch')}</span>
          </span>
        )}
      </div>

      {/* Consistent Sticky Footer: Quiet Left Context + Single Primary CTA */}
      <div className="detail-sticky-footer" data-testid="detail-sticky-footer">
        <div className="row-wrap" style={{ minWidth: 0 }}>
          {task.phase === 'needs_you' && task.subPhase === 'review' && primaryConv && !openExecution ? (
            <button
              type="button"
              className="btn btn-xs"
              disabled={busy || needsPerm}
              onClick={() => {
                setActiveTab('agent')
                setShowReworkBox(true)
              }}
            >
              <MessageSquareReply size={11} />
              <span>{tr(locale, 'rework')}</span>
            </button>
          ) : (
            <span className="card-meta-line">
              {task.writeGate === 'locked'
                ? tr(locale, 'writeGateLocked')
                : wsShortName
                  ? `${tr(locale, 'workspace')}: ${wsShortName}`
                  : tr(locale, 'unboundBadge')}
            </span>
          )}
        </div>

        <div className="row-wrap" style={{ flexShrink: 0 }}>
          {needsPerm ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void runAction(() => boardApi.confirmPermission(task.id), 'Permission confirmed')}
            >
              <Check size={12} />
              <span>{tr(locale, 'confirmPermission')}</span>
            </button>
          ) : openExecution && primaryConv ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                void boardApi.jumpToConversation(primaryConv.conversationId).then((r) => onToast(r.message))
              }
            >
              <ExternalLink size={12} />
              <span>{tr(locale, 'openSession')}</span>
            </button>
          ) : canApproveReview ? (
            isRecurringReview ? (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={handleAcceptRecurringRound}>
                <CheckCircle2 size={12} />
                <span>{tr(locale, 'acceptRound')}</span>
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() =>
                  void runAction(
                    () => boardApi.transitionTask(task.id, 'closed', { subPhase: 'done' }),
                    tr(locale, 'approvePass'),
                  )
                }
              >
                <CheckCircle2 size={12} />
                <span>{tr(locale, 'approvePass')}</span>
              </button>
            )
          ) : primaryConv && task.phase !== 'closed' ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                void boardApi.jumpToConversation(primaryConv.conversationId).then((r) => onToast(r.message))
              }
            >
              <ExternalLink size={12} />
              <span>{tr(locale, 'openSession')}</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || needsPerm}
              title={`${wsShortName ? `${tr(locale, 'startSessionIn')} ${wsShortName}` : tr(locale, 'startSession')} (D)`}
              onClick={() =>
                void runAction(async () => {
                  const res = await handleDispatchFromDetail({ mode: 'new' })
                  onToast(`Started conversation ${res.conversationId.slice(0, 8)}`)
                })
              }
            >
              <Play size={12} />
              <span>
                {wsShortName ? `${tr(locale, 'startSessionIn')} ${wsShortName}` : tr(locale, 'startSession')}
              </span>
            </button>
          )}
        </div>
      </div>

      {preview && (
        <RefPreviewModal
          locale={locale}
          preview={preview}
          onClose={() => setPreview(null)}
          onToast={onToast}
        />
      )}
    </div>
  )
}

export function TaskDetailDrawer(props: Omit<TaskDetailViewProps, 'variant' | 'showBackButton'>) {
  return (
    <div className="drawer-backdrop" onClick={props.onClose}>
      <div className="drawer-panel" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <TaskDetailView {...props} variant="drawer" showBackButton={false} />
      </div>
    </div>
  )
}
