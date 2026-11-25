import { useMemo, useState } from 'react'
import { CalendarClock, ChevronRight, Clock, Repeat, X } from 'lucide-react'
import { parseFreezeRequest } from '../../core/freeze.ts'
import type { SchedulePatch } from '../../core/schedule.ts'
import type {
  DiscoveredConversation,
  TaskPermission,
  TaskPriority,
  WorkspaceRecord,
  WriteGateMode,
} from '../../core/types.ts'
import { isPathEqualOrInside, matchWorkspaceForPath, pathComparisonKey } from '../../core/workspace.ts'
import type { ScheduleMutationPatch } from '../api.ts'
import { formatPriorityLabel, tr, type Locale } from '../i18n.ts'
import {
  buildWorkspaceFolderChoices,
  dateTimeLocalToEpoch,
  decodeWorkspaceFolderValue,
} from '../utils.ts'
import { computeQuickOnceTimestamp, ScheduleComposer } from './ScheduleComposer.tsx'

export interface NewTaskPayload {
  title: string
  description?: string
  prompt?: string
  priority: TaskPriority
  workspaceId?: string
  workspacePath?: string
  nextAction?: string
  dueAt?: number
  pin?: boolean
  permission?: TaskPermission
  writeGate?: WriteGateMode
  mode?: string
  model?: string
  useWorktree?: boolean
  tags?: Array<{ name: string }>
  freeze?: { goal: string; progress: string; next: string }
  subgoals?: Array<{ title: string; required: boolean }>
  reminderAt?: number
  schedule?: ScheduleMutationPatch & { enabled: boolean }
}

interface NewTaskModalProps {
  locale: Locale
  workspaces: WorkspaceRecord[]
  recentConversations?: DiscoveredConversation[]
  defaultWorkspaceId?: string
  defaultWorkspacePath?: string
  defaultTitle?: string
  defaultConversationId?: string
  defaultPinToFocus?: boolean
  onClose: () => void
  onCreate: (input: NewTaskPayload, linkConversationId?: string) => Promise<void>
}

export function NewTaskModal({
  locale,
  workspaces,
  recentConversations = [],
  defaultWorkspaceId,
  defaultWorkspacePath,
  defaultTitle,
  defaultConversationId,
  defaultPinToFocus = false,
  onClose,
  onCreate,
}: NewTaskModalProps) {
  const folderChoices = useMemo(() => buildWorkspaceFolderChoices(workspaces), [workspaces])

  const initialSelection = useMemo(() => {
    if (defaultWorkspacePath) {
      const targetKey = pathComparisonKey(defaultWorkspacePath)
      const exact =
        folderChoices.find(
          (c) =>
            pathComparisonKey(c.folderPath) === targetKey &&
            (!defaultWorkspaceId || c.workspaceId === defaultWorkspaceId),
        ) ?? folderChoices.find((c) => pathComparisonKey(c.folderPath) === targetKey)
      if (exact) {
        return { choiceKey: exact.key, workspaceId: exact.workspaceId, workspacePath: defaultWorkspacePath }
      }
      const containing =
        folderChoices.find(
          (c) =>
            isPathEqualOrInside(defaultWorkspacePath, c.folderPath) &&
            (!defaultWorkspaceId || c.workspaceId === defaultWorkspaceId),
        ) ?? folderChoices.find((c) => isPathEqualOrInside(defaultWorkspacePath, c.folderPath))
      if (containing) {
        return {
          choiceKey: containing.key,
          workspaceId: containing.workspaceId,
          workspacePath: defaultWorkspacePath,
        }
      }
      return {
        choiceKey: '',
        workspaceId: defaultWorkspaceId ?? '',
        workspacePath: defaultWorkspacePath,
      }
    }
    if (defaultWorkspaceId) {
      const match = folderChoices.find((c) => c.workspaceId === defaultWorkspaceId)
      if (match) {
        return { choiceKey: match.key, workspaceId: match.workspaceId, workspacePath: match.folderPath }
      }
      return { choiceKey: '', workspaceId: defaultWorkspaceId, workspacePath: '' }
    }
    return { choiceKey: '', workspaceId: '', workspacePath: '' }
  }, [defaultWorkspaceId, defaultWorkspacePath, folderChoices])

  const [title, setTitle] = useState(defaultTitle ?? '')
  const [dueAtRaw, setDueAtRaw] = useState('')
  const [selectedChoiceKey, setSelectedChoiceKey] = useState(initialSelection.choiceKey)
  const [workspaceId, setWorkspaceId] = useState(initialSelection.workspaceId)
  const [customPath, setCustomPath] = useState(initialSelection.workspacePath)
  const [priority, setPriority] = useState<TaskPriority>('normal')
  const [pinToFocus, setPinToFocus] = useState(Boolean(defaultPinToFocus))
  const [description, setDescription] = useState('')
  const [subgoalsRaw, setSubgoalsRaw] = useState('')

  // Advanced / More options (kept mounted even while collapsed so defaults submit cleanly)
  const [prompt, setPrompt] = useState('')
  const [nextAction, setNextAction] = useState('')
  const [tagsRaw, setTagsRaw] = useState('')
  const [freezeGoal, setFreezeGoal] = useState('')
  const [freezeProgress, setFreezeProgress] = useState('')
  const [freezeNext, setFreezeNext] = useState('')
  const [showPasteFreeze, setShowPasteFreeze] = useState(false)
  const [freezePaste, setFreezePaste] = useState('')
  const [permission, setPermission] = useState<TaskPermission | ''>('')
  const [writeGate, setWriteGate] = useState<WriteGateMode>('unlocked')
  const [mode, setMode] = useState('')
  const [model, setModel] = useState('')
  const [useWorktree, setUseWorktree] = useState(false)
  const [scheduleModeChoice, setScheduleModeChoice] = useState<'none' | 'tonight' | 'tomorrow9' | 'custom'>('none')
  const [customSchedulePatch, setCustomSchedulePatch] = useState<SchedulePatch | null>(null)
  const [customScheduleValid, setCustomScheduleValid] = useState(true)
  const [selectedConvId, setSelectedConvId] = useState(defaultConversationId ?? '')
  const [linkConv, setLinkConv] = useState(Boolean(defaultConversationId))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) {
      setError(locale === 'zh' ? '请输入待办标题' : 'Title is required')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const tags = tagsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((name) => ({ name }))
      const subgoals = subgoalsRaw
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((sgTitle) => ({ title: sgTitle, required: true }))
      const freeze =
        freezeGoal.trim() || freezeProgress.trim() || freezeNext.trim()
          ? { goal: freezeGoal.trim(), progress: freezeProgress.trim(), next: freezeNext.trim() }
          : undefined
      const dueAt = dateTimeLocalToEpoch(dueAtRaw)
      const hasBoundWorkspace = Boolean(customPath.trim() || workspaceId)
      let schedule: NewTaskPayload['schedule']
      if (scheduleModeChoice === 'tonight') {
        schedule = {
          enabled: true,
          mode: 'once',
          at: computeQuickOnceTimestamp('tonight'),
          action: hasBoundWorkspace ? 'dispatch' : 'remind',
          sessionMode: 'auto',
        }
      } else if (scheduleModeChoice === 'tomorrow9') {
        schedule = {
          enabled: true,
          mode: 'once',
          at: computeQuickOnceTimestamp('tomorrow9'),
          action: hasBoundWorkspace ? 'dispatch' : 'remind',
          sessionMode: 'auto',
        }
      } else if (scheduleModeChoice === 'custom' && customSchedulePatch) {
        if (!customScheduleValid) {
          setError(locale === 'zh' ? '请先完善定时计划设置' : 'Complete schedule configuration before saving')
          setSubmitting(false)
          return
        }
        schedule = customSchedulePatch
      }

      const payload: NewTaskPayload = {
        title: title.trim(),
        description: description.trim() || undefined,
        prompt: prompt.trim() || undefined,
        priority,
        workspaceId: workspaceId || undefined,
        workspacePath: customPath.trim() || undefined,
        nextAction: nextAction.trim() || undefined,
        ...(dueAt !== undefined ? { dueAt } : {}),
        ...(pinToFocus ? { pin: true } : {}),
        permission: permission || undefined,
        ...(writeGate !== 'unlocked' ? { writeGate } : {}),
        ...(mode.trim() ? { mode: mode.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(useWorktree ? { useWorktree: true } : {}),
        tags: tags.length > 0 ? tags : undefined,
        subgoals: subgoals.length > 0 ? subgoals : undefined,
        freeze,
        ...(schedule ? { schedule } : {}),
      }

      const convToLink = selectedConvId && (defaultConversationId ? linkConv : true) ? selectedConvId : undefined
      await onCreate(payload, convToLink)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-box"
        role="dialog"
        aria-modal="true"
        aria-label={tr(locale, 'newTask')}
        onClick={(e) => e.stopPropagation()}
        data-testid="new-task-modal"
      >
        <div className="drawer-header">
          <strong style={{ fontSize: 14 }}>{tr(locale, 'newTask')}</strong>
          <button type="button" className="btn btn-xs btn-ghost" onClick={onClose} aria-label={tr(locale, 'close')}>
            <X size={14} />
          </button>
        </div>

        <form className="modal-body" onSubmit={handleSubmit}>
          {error && <div className="badge badge-danger">{error}</div>}

          <label className="form-label">
            <span>{tr(locale, 'title')} *</span>
            <input
              className="input-field"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={tr(locale, 'titlePlaceholder')}
              autoFocus
            />
          </label>

          {/* First-class DDL + Workspace row */}
          <div className="detail-prop-grid">
            <label className="form-label">
              <span className="row-wrap">
                <CalendarClock size={11} />
                <span>{tr(locale, 'dueAt')}</span>
              </span>
              <input
                className="input-field"
                type="datetime-local"
                aria-label={tr(locale, 'dueAt')}
                value={dueAtRaw}
                onChange={(e) => setDueAtRaw(e.target.value)}
              />
            </label>

            <label className="form-label">
              <span>{tr(locale, 'workspaceFolder')}</span>
              <select
                className="select-field"
                aria-label={tr(locale, 'workspaceFolder')}
                value={selectedChoiceKey}
                onChange={(e) => {
                  const val = e.target.value
                  setSelectedChoiceKey(val)
                  if (!val) {
                    setWorkspaceId('')
                    setCustomPath('')
                    return
                  }
                  const decoded = decodeWorkspaceFolderValue(val)
                  if (decoded) {
                    setWorkspaceId(decoded.workspaceId)
                    setCustomPath(decoded.folderPath)
                  }
                }}
              >
                <option value="">-- {tr(locale, 'unboundBadge')} --</option>
                {folderChoices.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.pinned ? '★ ' : ''}
                    {c.label} ({c.folderPath})
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="form-label">
            <span>{tr(locale, 'priority')}</span>
            <div className="prio-pill-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="row-wrap">
                {(['low', 'normal', 'high', 'urgent'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`btn btn-xs btn-pill${priority === p ? ' is-active' : ''}`}
                    onClick={() => setPriority(p)}
                  >
                    {formatPriorityLabel(p, locale)}
                  </button>
                ))}
              </div>
              <label className="row-wrap" style={{ fontSize: 12, color: 'var(--agy-fg)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={pinToFocus}
                  onChange={(e) => setPinToFocus(e.target.checked)}
                />
                <span>★ {tr(locale, 'addToTodayFocus')}</span>
              </label>
            </div>
          </div>

          <label className="form-label">
            <span>{tr(locale, 'description')}</span>
            <textarea
              className="textarea-field"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={tr(locale, 'notesPlaceholder')}
            />
          </label>

          <label className="form-label">
            <span>{tr(locale, 'subgoals')}</span>
            <textarea
              className="textarea-field"
              rows={2}
              value={subgoalsRaw}
              onChange={(e) => setSubgoalsRaw(e.target.value)}
              placeholder={tr(locale, 'subgoalsPlaceholder')}
            />
          </label>

          {/* 1-Line Quick Schedule Row */}
          <div className="sched-quick-modal-row" data-testid="new-task-schedule-row">
            <div className="row-wrap">
              <span className="row-wrap" style={{ fontSize: 11.5, color: 'var(--agy-muted-fg)' }}>
                <Clock size={11} />
                <span>{tr(locale, 'schedulePlan')}:</span>
              </span>
              <button
                type="button"
                className={`btn btn-xs btn-pill${scheduleModeChoice === 'none' ? ' is-active' : ''}`}
                onClick={() => setScheduleModeChoice('none')}
              >
                {tr(locale, 'scheduleNone')}
              </button>
              <button
                type="button"
                className={`btn btn-xs btn-pill${scheduleModeChoice === 'tonight' ? ' is-active' : ''}`}
                onClick={() => setScheduleModeChoice('tonight')}
              >
                {locale === 'zh' ? '今晚 20:00' : 'Tonight 20:00'}
              </button>
              <button
                type="button"
                className={`btn btn-xs btn-pill${scheduleModeChoice === 'tomorrow9' ? ' is-active' : ''}`}
                onClick={() => setScheduleModeChoice('tomorrow9')}
              >
                {locale === 'zh' ? '明早 09:00' : 'Tmrw 09:00'}
              </button>
              <button
                type="button"
                className={`btn btn-xs btn-pill${scheduleModeChoice === 'custom' ? ' is-active' : ''}`}
                onClick={() => setScheduleModeChoice((cur) => (cur === 'custom' ? 'none' : 'custom'))}
              >
                <Repeat size={10} />
                <span>{locale === 'zh' ? '周期例行…' : 'Recurring…'}</span>
              </button>
            </div>
            {scheduleModeChoice === 'custom' && (
              <ScheduleComposer
                locale={locale}
                compact
                workspacePath={customPath.trim() || undefined}
                onChange={(patch, valid) => {
                  setCustomSchedulePatch(patch)
                  setCustomScheduleValid(valid)
                }}
              />
            )}
          </div>

          {/* Collapsed More Options */}
          <details className="fold-section" data-testid="new-task-more-options">
            <summary className="fold-summary">
              <span>{tr(locale, 'moreOptions')}</span>
              <ChevronRight size={12} />
            </summary>

            <div className="fold-body">
              {defaultConversationId ? (
                <label className="row-wrap" style={{ fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={linkConv}
                    onChange={(e) => setLinkConv(e.target.checked)}
                  />
                  <span>Link session {defaultConversationId.slice(0, 8)}</span>
                </label>
              ) : (
                recentConversations.length > 0 && (
                  <label className="form-label">
                    <span>{tr(locale, 'linkExistingSessionOptional')}</span>
                    <select
                      className="select-field"
                      value={selectedConvId}
                      onChange={(e) => {
                        const convId = e.target.value
                        setSelectedConvId(convId)
                        setLinkConv(Boolean(convId))
                        const conv = recentConversations.find((c) => c.conversationId === convId)
                        if (!conv) return
                        if (!title.trim() && conv.title) setTitle(conv.title)
                        const firstPath = conv.workspacePaths[0]
                        if (!customPath.trim() && firstPath) {
                          setCustomPath(firstPath)
                          const targetKey = pathComparisonKey(firstPath)
                          const exact = folderChoices.find((c) => pathComparisonKey(c.folderPath) === targetKey)
                          if (exact) {
                            setSelectedChoiceKey(exact.key)
                            setWorkspaceId(exact.workspaceId)
                          } else {
                            const matchedWs = matchWorkspaceForPath(firstPath, workspaces)
                            setWorkspaceId(matchedWs?.id ?? (conv.projectId || ''))
                            const containing = folderChoices.find((c) => isPathEqualOrInside(firstPath, c.folderPath))
                            setSelectedChoiceKey(containing?.key ?? '')
                          }
                        }
                      }}
                    >
                      <option value="">{tr(locale, 'noneStartFresh')}</option>
                      {recentConversations.map((c) => (
                        <option key={c.conversationId} value={c.conversationId}>
                          [{c.isIdle ? 'idle' : 'running'}] {c.title || c.conversationId.slice(0, 8)}
                          {c.workspacePaths[0] ? ` (${c.workspacePaths[0].split(/[\\/]/).filter(Boolean).pop()})` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )
              )}

              <label className="form-label">
                <span>Workspace Folder Path (optional sub-repo override)</span>
                <input
                  className="input-field"
                  value={customPath}
                  onChange={(e) => {
                    const nextPath = e.target.value
                    setCustomPath(nextPath)
                    const trimmed = nextPath.trim()
                    if (!trimmed) {
                      setSelectedChoiceKey('')
                      setWorkspaceId('')
                      return
                    }
                    const targetKey = pathComparisonKey(trimmed)
                    const exact = folderChoices.find((c) => pathComparisonKey(c.folderPath) === targetKey)
                    if (exact) {
                      setSelectedChoiceKey(exact.key)
                      setWorkspaceId(exact.workspaceId)
                    } else {
                      const matchedWs = matchWorkspaceForPath(trimmed, workspaces)
                      setWorkspaceId(matchedWs?.id ?? '')
                      const containing = folderChoices.find((c) => isPathEqualOrInside(trimmed, c.folderPath))
                      setSelectedChoiceKey(containing?.key ?? '')
                    }
                  }}
                  placeholder="/path/to/my-repo"
                />
              </label>

              <label className="form-label">
                <span>{tr(locale, 'prompt')}</span>
                <textarea
                  className="textarea-field"
                  rows={2}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="What should the Antigravity session execute when dispatched?"
                />
              </label>

              <label className="form-label">
                <span>{tr(locale, 'nextAction')}</span>
                <input
                  className="input-field"
                  value={nextAction}
                  onChange={(e) => setNextAction(e.target.value)}
                  placeholder="Short 1-line next step"
                />
              </label>

              <div className="row-wrap">
                <label className="form-label" style={{ flex: '1 1 130px' }}>
                  <span>{tr(locale, 'tags')}</span>
                  <input
                    className="input-field"
                    value={tagsRaw}
                    onChange={(e) => setTagsRaw(e.target.value)}
                    placeholder="backend, bugfix"
                  />
                </label>
                <label className="form-label" style={{ width: 140 }}>
                  <span>{tr(locale, 'permission')}</span>
                  <select
                    className="select-field"
                    value={permission}
                    onChange={(e) => setPermission(e.target.value as TaskPermission | '')}
                  >
                    <option value="">Default (inherit)</option>
                    <option value="read-only">read-only</option>
                    <option value="workspace-write">workspace-write</option>
                    <option value="danger-full-access">danger-full-access</option>
                  </select>
                </label>
                <label className="form-label" style={{ width: 120 }}>
                  <span>Write Gate</span>
                  <select
                    className="select-field"
                    value={writeGate}
                    onChange={(e) => setWriteGate(e.target.value as WriteGateMode)}
                  >
                    <option value="unlocked">{tr(locale, 'writeGateUnlocked')}</option>
                    <option value="locked">{tr(locale, 'writeGateLocked')}</option>
                  </select>
                </label>
              </div>

              <div className="row-wrap">
                <label className="form-label" style={{ flex: '1 1 90px' }}>
                  <span>{tr(locale, 'modeLabel')}</span>
                  <input
                    className="input-field"
                    value={mode}
                    onChange={(e) => setMode(e.target.value)}
                    placeholder="code / plan"
                  />
                </label>
                <label className="form-label" style={{ flex: '1 1 100px' }}>
                  <span>{tr(locale, 'modelLabel')}</span>
                  <input
                    className="input-field"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="optional"
                  />
                </label>
              </div>

              <label className="row-wrap" style={{ fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={useWorktree}
                  onChange={(e) => setUseWorktree(e.target.checked)}
                />
                <span>{tr(locale, 'useWorktree')}</span>
              </label>

              <details className="fold-section">
                <summary className="fold-summary">
                  <span>{tr(locale, 'freezeSnapshot')}</span>
                  <ChevronRight size={11} />
                </summary>
                <div className="fold-body" style={{ marginTop: 6 }}>
                  <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className="btn btn-xs"
                      onClick={() => setShowPasteFreeze((v) => !v)}
                    >
                      {tr(locale, 'pasteFreeze')}
                    </button>
                  </div>
                  {showPasteFreeze && (
                    <div className="form-label">
                      <textarea
                        className="textarea-field"
                        rows={3}
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
                            setError(parsed.error.message)
                            return
                          }
                          setError(null)
                          setFreezeGoal(parsed.snapshot.goal)
                          setFreezeProgress(parsed.snapshot.progress)
                          setFreezeNext(parsed.snapshot.next)
                          setShowPasteFreeze(false)
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
                </div>
              </details>
            </div>
          </details>

          <div className="row-wrap" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
            <button type="button" className="btn" onClick={onClose}>
              {tr(locale, 'cancel')}
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {tr(locale, 'save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
