export interface CardSubgoal {
  id: string
  title: string
  detail?: string
  kind?: string
  required?: boolean
  status: 'open' | 'in_progress' | 'done' | 'skipped'
}

export interface CardSubgoalRollup {
  total: number
  done: number
  inProgress?: number
  open?: number
  skipped?: number
  requiredTotal: number
  requiredDone: number
  requiredRemaining?: number
}

export interface CardRef {
  id?: string
  kind: string
  target: string
  label?: string
}

export interface CardTag {
  name: string
}

export interface CardFreeze {
  goal: string
  progress: string
  next: string
}

export interface CardTask {
  id: string
  title: string
  description?: string
  userNotes?: string
  prompt?: string
  phase: string
  subPhase?: string
  priority?: 'urgent' | 'high' | 'normal' | 'low'
  workspaceId?: string
  workspacePath?: string
  workspaceLabel?: string
  blockedReason?: string
  nextAction?: string
  dueAt?: number
  writeGate?: 'unlocked' | 'locked'
  permission?: string
  permissionConfirmedAt?: number
  worktreeBranch?: string
  planRevision?: number
  originSummary?: string
  tags?: CardTag[]
  subgoals?: CardSubgoal[]
  subgoalRollup?: CardSubgoalRollup
  refs?: CardRef[]
  freeze?: CardFreeze
  conversations?: Array<{ conversationId: string; role?: string; title?: string }>
  hasUserNotes?: boolean
  updatedAt?: number
}

export interface CardCounts {
  needs_you?: number
  active?: number
  on_hold?: number
  todo?: number
  closed?: number
}

export interface CardListPayload {
  total?: number
  counts?: CardCounts
  tasks: CardTask[]
}

export interface ToolResultLike {
  isError?: boolean
  structuredContent?: Record<string, unknown>
  content?: Array<{ type?: string; text?: string }>
}

export type CallToolFn = (name: string, args: Record<string, unknown>) => Promise<ToolResultLike>

export type CardLocale = 'zh' | 'en'

export function resolveCardLocale(localeHint?: string): CardLocale {
  const raw = (
    localeHint ||
    (typeof navigator !== 'undefined' ? navigator.language : '') ||
    'en'
  ).toLowerCase()
  return raw.startsWith('zh') ? 'zh' : 'en'
}

export function extractPayloadFromToolResult(result: ToolResultLike | null | undefined): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent
  }
  if (Array.isArray(result.content)) {
    const firstText = result.content.find((c) => c && c.type === 'text' && typeof c.text === 'string')
    if (firstText?.text) {
      try {
        const parsed = JSON.parse(firstText.text)
        if (parsed && typeof parsed === 'object') {
          return parsed as Record<string, unknown>
        }
      } catch {
        return null
      }
    }
  }
  return null
}

export function extractErrorMessage(result: ToolResultLike | null | undefined, fallback: string): string {
  const payload = extractPayloadFromToolResult(result)
  if (payload && typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error.trim()
  }
  if (Array.isArray(result?.content)) {
    const firstText = result.content.find((c) => c && c.type === 'text' && typeof c.text === 'string')
    if (firstText?.text?.trim()) return firstText.text.trim()
  }
  return fallback
}

export function extractTaskFromPayload(payload: Record<string, unknown> | null | undefined): CardTask | null {
  if (!payload || typeof payload !== 'object') return null
  const full = payload.fullTask
  if (full && typeof full === 'object' && typeof (full as CardTask).id === 'string') {
    return full as CardTask
  }
  const single = payload.task
  if (single && typeof single === 'object' && typeof (single as CardTask).id === 'string') {
    return single as CardTask
  }
  return null
}

export function isTaskDraft(task: Pick<CardTask, 'phase' | 'subPhase'>): boolean {
  return task.phase === 'todo' && task.subPhase === 'draft'
}

export function isTaskPermissionPending(task: Pick<CardTask, 'subPhase'>): boolean {
  return task.subPhase === 'permission_pending'
}

export function isTaskDispatchable(task: Pick<CardTask, 'phase' | 'subPhase' | 'workspaceId' | 'workspacePath'>): boolean {
  if (isTaskDraft(task)) return false
  if (isTaskPermissionPending(task)) return false
  if (task.phase === 'closed') return false
  return Boolean(task.workspaceId || task.workspacePath)
}

interface CopyStrings {
  loading: string
  cancelled: string
  emptyList: string
  boardTitle: string
  backToList: string
  edit: string
  closeEdit: string
  save: string
  saving: string
  cancel: string
  detailsExpand: string
  detailsCollapse: string
  dispatch: string
  dispatching: string
  openInBoard: string
  reviewDraftInBoard: string
  confirmPermInBoard: string
  refresh: string
  titleLabel: string
  briefLabel: string
  briefHint: string
  nextActionLabel: string
  contractLabel: string
  statusNoteLabel: string
  humanNotesTitle: string
  humanNotesReadOnly: string
  freezeTitle: string
  refsTitle: string
  subgoalsTitle: string
  requiredTag: string
  optionalTag: string
  addSubgoalPlaceholder: string
  addSubgoalBtn: string
  draftBannerTitle: string
  draftBannerBody: string
  permBannerTitle: string
  permBannerBody: string
  writeGateLocked: string
  focusSentToast: string
  focusDraftToast: string
  savedToast: string
  dispatchedToast: string
  noWorkspaceDispatchTip: string
  draftDispatchTip: string
  permDispatchTip: string
  closedDispatchTip: string
  locateShort: string
  priorityLabel: string
  noContract: string
  originLabel: string
}

const COPY: Record<CardLocale, CopyStrings> = {
  zh: {
    loading: '正在加载 Agy Board 任务卡...',
    cancelled: '工具调用已取消。',
    emptyList: '暂无匹配任务。',
    boardTitle: 'Agy Board 任务',
    backToList: '← 返回列表',
    edit: '编辑',
    closeEdit: '收起编辑',
    save: '保存更改',
    saving: '保存中...',
    cancel: '取消',
    detailsExpand: '展开详情',
    detailsCollapse: '收起详情',
    dispatch: '一键派发',
    dispatching: '派发中...',
    openInBoard: '在右侧看板查看',
    reviewDraftInBoard: '去看板审校 → Ready',
    confirmPermInBoard: '去看板确认提权',
    refresh: '刷新',
    titleLabel: '任务标题',
    briefLabel: '任务简述 (Brief · 1-3 句 ≤150 字)',
    briefHint: '保持简短可读；详细执行计划请放在下方执行契约中。',
    nextActionLabel: '下一步行动 (Next Action)',
    contractLabel: '执行契约 / 详细计划 (Prompt)',
    statusNoteLabel: '状态说明',
    humanNotesTitle: '人类专属备注 · 最高优先级覆盖',
    humanNotesReadOnly: '仅可在右侧看板中由人类编辑（MCP 只读保护）',
    freezeTitle: '上下文冻结快照',
    refsTitle: '已登记引用 (TaskSpace Refs)',
    subgoalsTitle: '子目标进度',
    requiredTag: '必达',
    optionalTag: '可选',
    addSubgoalPlaceholder: '添加新子目标，回车确认...',
    addSubgoalBtn: '添加',
    draftBannerTitle: 'AI 草稿 · 待人工审校',
    draftBannerBody: '草稿审批门禁受保护：请在右侧 Agy Board 看板中点击「审校通过 → Ready」确认后再派发执行。',
    permBannerTitle: '等待提权确认',
    permBannerBody: '此任务请求了高于默认会话级别的权限，请前往右侧看板确认提权。',
    writeGateLocked: '写门禁已锁定',
    focusSentToast: '已定位到右侧看板 · 若侧栏未展开，请点击回复末尾的 [Agy Board] 胶囊打开。',
    focusDraftToast: '已在右侧看板定位该草稿 · 请在看板内点击「审校通过 → Ready」完成人工确认。',
    savedToast: '已写回 Agy Board 数据库。',
    dispatchedToast: '已派发会话：',
    noWorkspaceDispatchTip: '需先绑定工作区后方可派发',
    draftDispatchTip: 'AI 草稿需先在右侧看板审校通过为 Ready',
    permDispatchTip: '需先在右侧看板确认提权',
    closedDispatchTip: '已关闭任务不可直接派发',
    locateShort: '定位',
    priorityLabel: '优先级',
    noContract: '暂未填写详细执行契约。',
    originLabel: '来源线索',
  },
  en: {
    loading: 'Loading Agy Board card...',
    cancelled: 'Tool call cancelled.',
    emptyList: 'No matching tasks.',
    boardTitle: 'Agy Board',
    backToList: '← Back to list',
    edit: 'Edit',
    closeEdit: 'Close Edit',
    save: 'Save',
    saving: 'Saving...',
    cancel: 'Cancel',
    detailsExpand: 'Details',
    detailsCollapse: 'Hide Details',
    dispatch: 'Dispatch',
    dispatching: 'Dispatching...',
    openInBoard: 'Open in Board',
    reviewDraftInBoard: 'Review in Board → Ready',
    confirmPermInBoard: 'Confirm Permission in Board',
    refresh: 'Refresh',
    titleLabel: 'Title',
    briefLabel: 'Task Brief (1-3 sentences, <=150 chars)',
    briefHint: 'Keep concise; put full execution plans in the Contract below.',
    nextActionLabel: 'Next Action',
    contractLabel: 'Execution Contract (Prompt)',
    statusNoteLabel: 'Status Note',
    humanNotesTitle: 'Human Notes · Highest Priority Override',
    humanNotesReadOnly: 'Human-exclusive (edit inside Agy Board UI; read-only via MCP)',
    freezeTitle: 'Freeze Snapshot',
    refsTitle: 'TaskSpace References',
    subgoalsTitle: 'Subgoals',
    requiredTag: 'Required',
    optionalTag: 'Optional',
    addSubgoalPlaceholder: 'Add a subgoal and press Enter...',
    addSubgoalBtn: 'Add',
    draftBannerTitle: 'AI Draft · Pending Human Review',
    draftBannerBody: 'Draft approval is a protected human gate. Open this card in the right-hand Agy Board to approve it to Ready before dispatching.',
    permBannerTitle: 'Elevated Permission Required',
    permBannerBody: 'Confirm elevated permission inside the Agy Board UI before dispatching.',
    writeGateLocked: 'WRITE GATE LOCKED',
    focusSentToast: 'Focus signal sent to Agy Board. If the side pane is closed, click the [Agy Board] pill below.',
    focusDraftToast: 'Focused draft in Agy Board. Click "Approve → Ready" inside the board to confirm.',
    savedToast: 'Saved to Agy Board.',
    dispatchedToast: 'Dispatched session: ',
    noWorkspaceDispatchTip: 'Bind a workspace before dispatching',
    draftDispatchTip: 'Approve AI draft to Ready in Agy Board first',
    permDispatchTip: 'Confirm elevated permission in Agy Board first',
    closedDispatchTip: 'Closed tasks cannot be dispatched directly',
    locateShort: 'Locate',
    priorityLabel: 'Priority',
    noContract: 'No execution contract written yet.',
    originLabel: 'Origin',
  },
}

const PRIORITY_LABELS: Record<CardLocale, Record<'urgent' | 'high' | 'normal' | 'low', string>> = {
  zh: { urgent: '紧急', high: '高', normal: '普通', low: '低' },
  en: { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' },
}

export function formatPhaseBadge(phase: string, subPhase: string | undefined, locale: CardLocale): string {
  const isZh = locale === 'zh'
  if (phase === 'todo' && subPhase === 'draft') return isZh ? 'AI 草稿 · 待审' : 'AI Draft'
  if (phase === 'todo' && subPhase === 'backlog') return isZh ? '待办 · 储备' : 'Todo · Backlog'
  if (phase === 'todo') return isZh ? '待办 · 就绪' : 'Todo · Ready'
  if (phase === 'active') return isZh ? '运行中' : 'Active'
  if (phase === 'needs_you') {
    if (subPhase === 'permission_pending') return isZh ? '待你处理 · 待提权' : 'Needs You · Permission'
    if (subPhase === 'blocked') return isZh ? '待你处理 · 受阻' : 'Needs You · Blocked'
    if (subPhase === 'needs_input') return isZh ? '待你处理 · 待回复' : 'Needs You · Input'
    if (subPhase === 'reminder_due') return isZh ? '待你处理 · 到点提醒' : 'Needs You · Reminder'
    return isZh ? '待你处理 · 待验收' : 'Needs You · Review'
  }
  if (phase === 'on_hold') return isZh ? '已挂起' : 'On Hold'
  if (phase === 'closed') return subPhase === 'cancelled' ? (isZh ? '已取消' : 'Cancelled') : (isZh ? '已完成' : 'Done')
  return subPhase ? `${phase} / ${subPhase}` : phase
}

function resolveCardTint(task: CardTask): string {
  if (task.phase === 'todo' && task.subPhase === 'draft') return 'tint-warn'
  if (task.phase === 'needs_you') {
    if (task.subPhase === 'blocked') return 'tint-danger'
    if (task.subPhase === 'permission_pending' || task.subPhase === 'needs_input' || task.subPhase === 'reminder_due') {
      return 'tint-warn'
    }
    return 'tint-ok'
  }
  if (task.phase === 'active') return 'tint-active'
  if (task.phase === 'on_hold') return 'tint-danger'
  return ''
}

function resolvePillClass(phase: string, subPhase?: string): string {
  if (phase === 'todo' && subPhase === 'draft') return 'pill pill-warn'
  if (phase === 'needs_you') {
    if (subPhase === 'blocked') return 'pill pill-danger'
    if (subPhase === 'permission_pending' || subPhase === 'needs_input' || subPhase === 'reminder_due') {
      return 'pill pill-warn'
    }
    return 'pill pill-ok'
  }
  if (phase === 'active') return 'pill pill-active'
  if (phase === 'on_hold') return 'pill pill-danger'
  if (phase === 'closed') return 'pill pill-ok'
  return 'pill'
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string | number | null,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

export interface CardControllerOptions {
  root: HTMLElement
  callTool: CallToolFn
  locale?: CardLocale
  canCallTools?: () => boolean
  onRendered?: () => void
}

export interface CardAppController {
  setLocale(locale: CardLocale): void
  showLoading(hintTitle?: string): void
  showCancelled(): void
  handleToolResult(result: ToolResultLike): void
  handlePayload(payload: Record<string, unknown> | null | undefined): void
  getState(): {
    mode: 'loading' | 'cancelled' | 'single' | 'list'
    task: CardTask | null
    list: CardListPayload | null
    editing: boolean
    expanded: boolean
  }
}

export function createCardAppController(options: CardControllerOptions): CardAppController {
  const { root, callTool, onRendered } = options
  const canCallTools = options.canCallTools ?? (() => true)

  let locale: CardLocale = options.locale ?? resolveCardLocale()
  let mode: 'loading' | 'cancelled' | 'single' | 'list' = 'loading'
  let currentTask: CardTask | null = null
  let currentList: CardListPayload | null = null
  let editing = false
  let expanded = false
  let busyAction: string | null = null
  let feedback: { kind: 'ok' | 'info' | 'error'; text: string } | null = null

  // Draft values kept while inline edit form is open
  let draftTitle = ''
  let draftBrief = ''
  let draftNextAction = ''
  let draftPrompt = ''
  let newSubgoalDraft = ''

  const c = () => COPY[locale]

  function setFeedback(kind: 'ok' | 'info' | 'error', text: string) {
    feedback = { kind, text }
    render()
  }

  function syncDraftsFromTask(task: CardTask) {
    draftTitle = task.title ?? ''
    draftBrief = task.description ?? ''
    draftNextAction = task.nextAction ?? ''
    draftPrompt = task.prompt ?? ''
  }

  async function refreshTask(taskId: string): Promise<void> {
    const res = await callTool('board_get', { taskId })
    if (res.isError) {
      throw new Error(extractErrorMessage(res, 'Failed to refresh task'))
    }
    const payload = extractPayloadFromToolResult(res)
    const fresh = extractTaskFromPayload(payload)
    if (fresh) {
      currentTask = fresh
      if (!editing) syncDraftsFromTask(fresh)
    }
  }

  async function runAction(actionName: string, fn: () => Promise<void>) {
    if (busyAction) return
    busyAction = actionName
    render()
    try {
      await fn()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      feedback = { kind: 'error', text: msg }
    } finally {
      busyAction = null
      render()
    }
  }

  async function handleSaveEdits() {
    if (!currentTask) return
    const taskId = currentTask.id
    const trimmedTitle = draftTitle.trim()
    if (!trimmedTitle) {
      setFeedback('error', locale === 'zh' ? '标题不能为空。' : 'Title cannot be empty.')
      return
    }
    await runAction('save', async () => {
      const patch: Record<string, unknown> = {
        taskId,
        title: trimmedTitle,
        description: draftBrief.trim(),
        nextAction: draftNextAction.trim() ? draftNextAction.trim() : null,
        prompt: draftPrompt,
      }
      const res = await callTool('board_update', patch)
      if (res.isError) {
        throw new Error(extractErrorMessage(res, 'Failed to update task'))
      }
      const updated = extractTaskFromPayload(extractPayloadFromToolResult(res))
      if (updated && Array.isArray(updated.subgoals)) {
        currentTask = updated
      } else {
        await refreshTask(taskId)
      }
      editing = false
      if (currentTask) syncDraftsFromTask(currentTask)
      feedback = { kind: 'ok', text: c().savedToast }
    })
  }

  async function handlePriorityChange(priority: 'urgent' | 'high' | 'normal' | 'low') {
    if (!currentTask || currentTask.priority === priority) return
    const taskId = currentTask.id
    await runAction('priority', async () => {
      const res = await callTool('board_update', { taskId, priority })
      if (res.isError) {
        throw new Error(extractErrorMessage(res, 'Failed to update priority'))
      }
      const updated = extractTaskFromPayload(extractPayloadFromToolResult(res))
      if (updated && Array.isArray(updated.subgoals)) {
        currentTask = updated
      } else {
        await refreshTask(taskId)
      }
      feedback = { kind: 'ok', text: c().savedToast }
    })
  }

  async function handleToggleSubgoalStatus(sg: CardSubgoal) {
    if (!currentTask) return
    const taskId = currentTask.id
    const nextStatus = sg.status === 'done' ? 'open' : 'done'
    await runAction(`sg:${sg.id}`, async () => {
      const res = await callTool('board_subgoal_update', {
        taskId,
        subgoalId: sg.id,
        status: nextStatus,
      })
      if (res.isError) {
        throw new Error(extractErrorMessage(res, 'Failed to update subgoal'))
      }
      const updated = extractTaskFromPayload(extractPayloadFromToolResult(res))
      if (updated && Array.isArray(updated.subgoals)) {
        currentTask = updated
      } else {
        await refreshTask(taskId)
      }
    })
  }

  async function handleToggleSubgoalRequired(sg: CardSubgoal) {
    if (!currentTask) return
    const taskId = currentTask.id
    await runAction(`sg-req:${sg.id}`, async () => {
      const res = await callTool('board_subgoal_update', {
        taskId,
        subgoalId: sg.id,
        required: !sg.required,
      })
      if (res.isError) {
        throw new Error(extractErrorMessage(res, 'Failed to update subgoal'))
      }
      const updated = extractTaskFromPayload(extractPayloadFromToolResult(res))
      if (updated && Array.isArray(updated.subgoals)) {
        currentTask = updated
      } else {
        await refreshTask(taskId)
      }
    })
  }

  async function handleAddSubgoal() {
    if (!currentTask) return
    const title = newSubgoalDraft.trim()
    if (!title) return
    const taskId = currentTask.id
    await runAction('sg-add', async () => {
      const res = await callTool('board_subgoal_update', {
        taskId,
        title,
        required: true,
      })
      if (res.isError) {
        throw new Error(extractErrorMessage(res, 'Failed to add subgoal'))
      }
      newSubgoalDraft = ''
      const updated = extractTaskFromPayload(extractPayloadFromToolResult(res))
      if (updated && Array.isArray(updated.subgoals)) {
        currentTask = updated
      } else {
        await refreshTask(taskId)
      }
      feedback = { kind: 'ok', text: c().savedToast }
    })
  }

  async function handleFocusInBoard(taskId: string, isDraftHint = false) {
    await runAction(`focus:${taskId}`, async () => {
      const res = await callTool('board_card', { taskId, focusInBoard: true })
      if (res.isError) {
        throw new Error(extractErrorMessage(res, 'Failed to focus task in board'))
      }
      feedback = {
        kind: 'info',
        text: isDraftHint ? c().focusDraftToast : c().focusSentToast,
      }
    })
  }

  async function handleDispatch() {
    if (!currentTask) return
    const taskId = currentTask.id
    await runAction('dispatch', async () => {
      const res = await callTool('board_dispatch', { taskId, mode: 'auto' })
      if (res.isError) {
        throw new Error(extractErrorMessage(res, 'Failed to dispatch task'))
      }
      const payload = extractPayloadFromToolResult(res)
      const convId = typeof payload?.conversationId === 'string' ? payload.conversationId : ''
      const updated = extractTaskFromPayload(payload)
      if (updated && Array.isArray(updated.subgoals)) {
        currentTask = updated
      } else {
        await refreshTask(taskId)
      }
      feedback = {
        kind: 'ok',
        text: convId ? `${c().dispatchedToast}${convId.slice(0, 8)}` : c().savedToast,
      }
    })
  }

  async function handleOpenFromList(taskId: string) {
    await runAction(`open:${taskId}`, async () => {
      const res = await callTool('board_get', { taskId })
      if (res.isError) {
        throw new Error(extractErrorMessage(res, 'Failed to load task'))
      }
      const task = extractTaskFromPayload(extractPayloadFromToolResult(res))
      if (task) {
        currentTask = task
        syncDraftsFromTask(task)
        mode = 'single'
        editing = false
        expanded = false
        feedback = null
      }
    })
  }

  function renderSingleTask(task: CardTask) {
    const strings = c()
    const interactive = canCallTools()
    const draft = isTaskDraft(task)
    const permPending = isTaskPermissionPending(task)
    const dispatchable = isTaskDispatchable(task)
    const tint = resolveCardTint(task)

    const card = el('div', `agy-card${tint ? ` ${tint}` : ''}`)
    card.dataset.taskId = task.id

    // Optional back button if drilled down from list
    if (currentList) {
      const navRow = el('div', 'row between nav-strip')
      const backBtn = el('button', 'btn btn-ghost btn-xs', strings.backToList)
      backBtn.type = 'button'
      backBtn.addEventListener('click', () => {
        mode = 'list'
        editing = false
        feedback = null
        render()
      })
      navRow.appendChild(backBtn)
      card.appendChild(navRow)
    }

    // Top Header: Status dot + Title + Phase Pill + Priority Select
    const header = el('div', 'row between header-row')
    const titleWrap = el('div', 'title-group')
    const dot = el('span', `status-dot status-${task.phase}${draft ? ' status-draft' : ''}`)
    dot.setAttribute('aria-hidden', 'true')
    titleWrap.appendChild(dot)
    const h2 = el('h2', 'card-title', task.title || '(Untitled task)')
    titleWrap.appendChild(h2)
    header.appendChild(titleWrap)

    const rightPills = el('div', 'row pills-group')
    rightPills.appendChild(
      el('span', resolvePillClass(task.phase, task.subPhase), formatPhaseBadge(task.phase, task.subPhase, locale)),
    )

    if (interactive) {
      const prioSelect = el('select', `prio-select prio-${task.priority || 'normal'}`)
      prioSelect.setAttribute('aria-label', strings.priorityLabel)
      prioSelect.disabled = Boolean(busyAction)
      for (const p of ['urgent', 'high', 'normal', 'low'] as const) {
        const opt = el('option', '', PRIORITY_LABELS[locale][p])
        opt.value = p
        if ((task.priority || 'normal') === p) opt.selected = true
        prioSelect.appendChild(opt)
      }
      prioSelect.addEventListener('change', () => {
        void handlePriorityChange(prioSelect.value as 'urgent' | 'high' | 'normal' | 'low')
      })
      rightPills.appendChild(prioSelect)
    } else {
      rightPills.appendChild(el('span', 'pill', PRIORITY_LABELS[locale][task.priority || 'normal']))
    }

    if (task.writeGate === 'locked') {
      rightPills.appendChild(el('span', 'pill pill-danger', strings.writeGateLocked))
    }
    header.appendChild(rightPills)
    card.appendChild(header)

    // Meta row (workspace, worktree, due, planRevision, tags)
    const metaRow = el('div', 'row meta-row')
    if (task.workspaceLabel || task.workspacePath) {
      const wsChip = el('span', 'ws-chip', task.workspaceLabel || task.workspacePath)
      if (task.workspacePath) wsChip.title = task.workspacePath
      metaRow.appendChild(wsChip)
    }
    if (task.worktreeBranch) {
      metaRow.appendChild(el('span', 'meta-chip', `⎇ ${task.worktreeBranch}`))
    }
    if (task.dueAt) {
      metaRow.appendChild(el('span', 'meta-chip', `⏰ ${new Date(task.dueAt).toLocaleString()}`))
    }
    if (typeof task.planRevision === 'number' && task.planRevision > 0) {
      metaRow.appendChild(el('span', 'meta-chip', `rev #${task.planRevision}`))
    }
    if (Array.isArray(task.tags) && task.tags.length > 0) {
      for (const t of task.tags.slice(0, 6)) {
        metaRow.appendChild(el('span', 'tag-chip', `#${t.name}`))
      }
    }
    if (metaRow.childNodes.length > 0) {
      card.appendChild(metaRow)
    }

    // Draft Human Approval Gate Banner (NEVER bypasses MCP gate!)
    if (draft) {
      const banner = el('div', 'gate-banner gate-warn')
      banner.dataset.testid = 'draft-gate-banner'
      const textCol = el('div', 'gate-text')
      textCol.appendChild(el('div', 'gate-title', strings.draftBannerTitle))
      textCol.appendChild(el('div', 'gate-body', strings.draftBannerBody))
      banner.appendChild(textCol)
      if (interactive) {
        const reviewBtn = el('button', 'btn btn-warn btn-sm', strings.reviewDraftInBoard)
        reviewBtn.type = 'button'
        reviewBtn.dataset.action = 'review-draft'
        reviewBtn.disabled = Boolean(busyAction)
        reviewBtn.addEventListener('click', () => {
          void handleFocusInBoard(task.id, true)
        })
        banner.appendChild(reviewBtn)
      }
      card.appendChild(banner)
    } else if (permPending) {
      const banner = el('div', 'gate-banner gate-danger')
      const textCol = el('div', 'gate-text')
      textCol.appendChild(el('div', 'gate-title', strings.permBannerTitle))
      textCol.appendChild(el('div', 'gate-body', strings.permBannerBody))
      banner.appendChild(textCol)
      if (interactive) {
        const permBtn = el('button', 'btn btn-warn btn-sm', strings.confirmPermInBoard)
        permBtn.type = 'button'
        permBtn.disabled = Boolean(busyAction)
        permBtn.addEventListener('click', () => {
          void handleFocusInBoard(task.id, false)
        })
        banner.appendChild(permBtn)
      }
      card.appendChild(banner)
    }

    // Layer 2: Human-Exclusive Notes (Read-only callout, highest priority override)
    if (task.userNotes && task.userNotes.trim()) {
      const notesBox = el('div', 'human-notes-box')
      notesBox.dataset.testid = 'human-notes-box'
      const notesHdr = el('div', 'row between')
      notesHdr.appendChild(el('span', 'human-notes-title', `★ ${strings.humanNotesTitle}`))
      notesHdr.appendChild(el('span', 'muted-xs', strings.humanNotesReadOnly))
      notesBox.appendChild(notesHdr)
      notesBox.appendChild(el('div', 'pre-wrap notes-body', task.userNotes.trim()))
      card.appendChild(notesBox)
    }

    // Layer 1: Brief summary (when not editing)
    if (!editing) {
      if (task.description && task.description.trim()) {
        card.appendChild(el('div', 'brief-text pre-wrap', task.description.trim()))
      }
      if (task.blockedReason) {
        const noteSec = el('div', 'inline-callout callout-warn')
        noteSec.appendChild(el('span', 'callout-label', `${strings.statusNoteLabel}: `))
        noteSec.appendChild(el('span', '', task.blockedReason))
        card.appendChild(noteSec)
      }
      if (task.nextAction) {
        const nextSec = el('div', 'inline-callout')
        nextSec.appendChild(el('span', 'callout-label', `${strings.nextActionLabel}: `))
        nextSec.appendChild(el('span', '', task.nextAction))
        card.appendChild(nextSec)
      }
    }

    // Inline Edit Form (Title / Brief / Next Action / Contract Prompt)
    if (editing && interactive) {
      const form = el('div', 'edit-form')
      form.dataset.testid = 'inline-edit-form'

      const titleField = el('label', 'field-label')
      titleField.appendChild(el('span', 'field-caption', strings.titleLabel))
      const titleInput = el('input', 'field-input')
      titleInput.type = 'text'
      titleInput.name = 'title'
      titleInput.value = draftTitle
      titleInput.addEventListener('input', () => {
        draftTitle = titleInput.value
      })
      titleField.appendChild(titleInput)
      form.appendChild(titleField)

      const briefField = el('label', 'field-label')
      briefField.appendChild(el('span', 'field-caption', strings.briefLabel))
      const briefInput = el('textarea', 'field-textarea')
      briefInput.name = 'description'
      briefInput.rows = 2
      briefInput.value = draftBrief
      briefInput.addEventListener('input', () => {
        draftBrief = briefInput.value
      })
      briefField.appendChild(briefInput)
      briefField.appendChild(el('span', 'muted-xs', strings.briefHint))
      form.appendChild(briefField)

      const nextField = el('label', 'field-label')
      nextField.appendChild(el('span', 'field-caption', strings.nextActionLabel))
      const nextInput = el('input', 'field-input')
      nextInput.type = 'text'
      nextInput.name = 'nextAction'
      nextInput.value = draftNextAction
      nextInput.addEventListener('input', () => {
        draftNextAction = nextInput.value
      })
      nextField.appendChild(nextInput)
      form.appendChild(nextField)

      const promptField = el('label', 'field-label')
      promptField.appendChild(el('span', 'field-caption', strings.contractLabel))
      const promptInput = el('textarea', 'field-textarea field-mono')
      promptInput.name = 'prompt'
      promptInput.rows = 4
      promptInput.value = draftPrompt
      promptInput.addEventListener('input', () => {
        draftPrompt = promptInput.value
      })
      promptField.appendChild(promptInput)
      form.appendChild(promptField)

      const formActions = el('div', 'row edit-actions')
      const saveBtn = el('button', 'btn btn-primary btn-sm', busyAction === 'save' ? strings.saving : strings.save)
      saveBtn.type = 'button'
      saveBtn.dataset.action = 'save-edit'
      saveBtn.disabled = Boolean(busyAction)
      saveBtn.addEventListener('click', () => {
        void handleSaveEdits()
      })
      const cancelBtn = el('button', 'btn btn-ghost btn-sm', strings.cancel)
      cancelBtn.type = 'button'
      cancelBtn.disabled = Boolean(busyAction)
      cancelBtn.addEventListener('click', () => {
        editing = false
        syncDraftsFromTask(task)
        render()
      })
      formActions.appendChild(saveBtn)
      formActions.appendChild(cancelBtn)
      form.appendChild(formActions)
      card.appendChild(form)
    }

    // Subgoals Section (Interactive checkboxes + required toggle + quick add)
    const subgoals = Array.isArray(task.subgoals) ? task.subgoals : []
    const rollup = task.subgoalRollup ?? {
      total: subgoals.length,
      done: subgoals.filter((s) => s.status === 'done').length,
      requiredTotal: subgoals.filter((s) => s.required !== false).length,
      requiredDone: subgoals.filter((s) => s.required !== false && s.status === 'done').length,
    }
    if (rollup.total > 0 || interactive) {
      const sgSec = el('div', 'section')
      const sgHdr = el('div', 'row between')
      sgHdr.appendChild(el('span', 'sec-title', `${strings.subgoalsTitle} (${rollup.done}/${rollup.total})`))
      if (rollup.total > 0) {
        sgHdr.appendChild(
          el('span', 'muted-xs tabular-nums', `${strings.requiredTag}: ${rollup.requiredDone}/${rollup.requiredTotal}`),
        )
      }
      sgSec.appendChild(sgHdr)

      if (rollup.total > 0) {
        const barWrap = el('div', 'bar-wrap')
        const barFill = el('div', 'bar-fill')
        barFill.style.width = `${Math.round((rollup.done / Math.max(1, rollup.total)) * 100)}%`
        barWrap.appendChild(barFill)
        sgSec.appendChild(barWrap)
      }

      if (subgoals.length > 0) {
        const list = el('div', 'sg-list')
        for (const sg of subgoals) {
          const row = el('div', `sg-row${sg.status === 'done' ? ' is-done' : ''}`)
          const check = el('input', 'sg-check')
          check.type = 'checkbox'
          check.checked = sg.status === 'done'
          check.disabled = !interactive || Boolean(busyAction)
          check.setAttribute('aria-label', sg.title)
          check.addEventListener('change', () => {
            void handleToggleSubgoalStatus(sg)
          })
          row.appendChild(check)

          const titleSpan = el('span', 'sg-title', sg.title)
          row.appendChild(titleSpan)

          if (sg.status === 'in_progress' || sg.status === 'skipped') {
            row.appendChild(el('span', 'pill pill-xs', sg.status))
          }

          const reqBtn = el(
            'button',
            `sg-req-badge${sg.required !== false ? ' is-required' : ''}`,
            sg.required !== false ? strings.requiredTag : strings.optionalTag,
          )
          reqBtn.type = 'button'
          reqBtn.disabled = !interactive || Boolean(busyAction)
          reqBtn.addEventListener('click', () => {
            void handleToggleSubgoalRequired(sg)
          })
          row.appendChild(reqBtn)
          list.appendChild(row)
        }
        sgSec.appendChild(list)
      }

      if (interactive) {
        const addRow = el('div', 'sg-add-row')
        const addInput = el('input', 'field-input field-input-sm')
        addInput.type = 'text'
        addInput.placeholder = strings.addSubgoalPlaceholder
        addInput.value = newSubgoalDraft
        addInput.disabled = Boolean(busyAction)
        addInput.addEventListener('input', () => {
          newSubgoalDraft = addInput.value
        })
        addInput.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault()
            void handleAddSubgoal()
          }
        })
        const addBtn = el('button', 'btn btn-ghost btn-xs', strings.addSubgoalBtn)
        addBtn.type = 'button'
        addBtn.dataset.action = 'add-subgoal'
        addBtn.disabled = Boolean(busyAction)
        addBtn.addEventListener('click', () => {
          void handleAddSubgoal()
        })
        addRow.appendChild(addInput)
        addRow.appendChild(addBtn)
        sgSec.appendChild(addRow)
      }
      card.appendChild(sgSec)
    }

    // Expandable Layer 3 Details (Contract Prompt, Freeze, Refs, Origin)
    if (expanded) {
      const details = el('div', 'section details-panel')
      details.dataset.testid = 'details-panel'

      const contractBlock = el('div', 'detail-block')
      contractBlock.appendChild(el('div', 'sec-title', strings.contractLabel))
      contractBlock.appendChild(
        el(
          'div',
          task.prompt?.trim() ? 'contract-pre pre-wrap' : 'muted-xs',
          task.prompt?.trim() || strings.noContract,
        ),
      )
      details.appendChild(contractBlock)

      if (task.originSummary) {
        const origBlock = el('div', 'detail-block')
        origBlock.appendChild(el('div', 'sec-title', strings.originLabel))
        origBlock.appendChild(el('div', 'muted-xs', task.originSummary))
        details.appendChild(origBlock)
      }

      if (task.freeze) {
        const frBlock = el('div', 'detail-block')
        frBlock.appendChild(el('div', 'sec-title', strings.freezeTitle))
        frBlock.appendChild(el('div', 'muted-xs', `Goal: ${task.freeze.goal}`))
        if (task.freeze.progress) frBlock.appendChild(el('div', 'muted-xs', `Progress: ${task.freeze.progress}`))
        frBlock.appendChild(el('div', 'muted-xs', `Next: ${task.freeze.next}`))
        details.appendChild(frBlock)
      }

      if (Array.isArray(task.refs) && task.refs.length > 0) {
        const refBlock = el('div', 'detail-block')
        refBlock.appendChild(el('div', 'sec-title', `${strings.refsTitle} (${task.refs.length})`))
        const ul = el('ul', 'ref-list')
        for (const r of task.refs.slice(0, 10)) {
          ul.appendChild(el('li', 'ref-item', `[${r.kind}] ${r.label ? `${r.label} — ` : ''}${r.target}`))
        }
        refBlock.appendChild(ul)
        details.appendChild(refBlock)
      }

      card.appendChild(details)
    }

    // Action Footer Bar
    const footer = el('div', 'section row between action-footer')
    const leftBtns = el('div', 'row action-btns')

    if (interactive) {
      const editBtn = el('button', 'btn btn-sm', editing ? strings.closeEdit : strings.edit)
      editBtn.type = 'button'
      editBtn.dataset.action = 'toggle-edit'
      editBtn.disabled = Boolean(busyAction)
      editBtn.addEventListener('click', () => {
        editing = !editing
        if (editing) syncDraftsFromTask(task)
        render()
      })
      leftBtns.appendChild(editBtn)
    }

    const detailsBtn = el('button', 'btn btn-ghost btn-sm', expanded ? strings.detailsCollapse : strings.detailsExpand)
    detailsBtn.type = 'button'
    detailsBtn.dataset.action = 'toggle-details'
    detailsBtn.addEventListener('click', () => {
      expanded = !expanded
      render()
    })
    leftBtns.appendChild(detailsBtn)

    if (interactive) {
      const dispatchBtn = el(
        'button',
        `btn btn-sm${dispatchable ? ' btn-primary' : ''}`,
        busyAction === 'dispatch' ? strings.dispatching : strings.dispatch,
      )
      dispatchBtn.type = 'button'
      dispatchBtn.dataset.action = 'dispatch'
      dispatchBtn.disabled = !dispatchable || Boolean(busyAction)
      if (!dispatchable) {
        dispatchBtn.title = draft
          ? strings.draftDispatchTip
          : permPending
            ? strings.permDispatchTip
            : task.phase === 'closed'
              ? strings.closedDispatchTip
              : strings.noWorkspaceDispatchTip
      }
      dispatchBtn.addEventListener('click', () => {
        void handleDispatch()
      })
      leftBtns.appendChild(dispatchBtn)
    }

    footer.appendChild(leftBtns)

    const rightBtns = el('div', 'row action-btns')
    if (interactive) {
      const focusBtn = el('button', 'btn btn-accent-outline btn-sm', strings.openInBoard)
      focusBtn.type = 'button'
      focusBtn.dataset.action = 'focus-in-board'
      focusBtn.disabled = Boolean(busyAction)
      focusBtn.addEventListener('click', () => {
        void handleFocusInBoard(task.id, draft)
      })
      rightBtns.appendChild(focusBtn)

      const refreshBtn = el('button', 'btn btn-ghost btn-sm', strings.refresh)
      refreshBtn.type = 'button'
      refreshBtn.dataset.action = 'refresh'
      refreshBtn.disabled = Boolean(busyAction)
      refreshBtn.addEventListener('click', () => {
        void runAction('refresh', async () => {
          await refreshTask(task.id)
        })
      })
      rightBtns.appendChild(refreshBtn)
    }
    footer.appendChild(rightBtns)
    card.appendChild(footer)

    // Feedback Toast Banner
    if (feedback) {
      const fb = el('div', `feedback-bar feedback-${feedback.kind}`, feedback.text)
      fb.dataset.testid = 'card-feedback'
      card.appendChild(fb)
    }

    root.innerHTML = ''
    root.appendChild(card)
  }

  function renderTaskList(data: CardListPayload) {
    const strings = c()
    const interactive = canCallTools()
    const card = el('div', 'agy-card')

    const hdr = el('div', 'row between header-row')
    hdr.appendChild(el('h2', 'card-title', `${strings.boardTitle} (${data.total ?? data.tasks.length})`))
    if (data.counts) {
      hdr.appendChild(
        el(
          'span',
          'muted-xs tabular-nums',
          `needs_you: ${data.counts.needs_you ?? 0} · active: ${data.counts.active ?? 0} · todo: ${data.counts.todo ?? 0} · closed: ${data.counts.closed ?? 0}`,
        ),
      )
    }
    card.appendChild(hdr)

    const listWrap = el('div', 'section list-wrap')
    if (!data.tasks || data.tasks.length === 0) {
      listWrap.appendChild(el('div', 'muted-xs', strings.emptyList))
    } else {
      for (const t of data.tasks.slice(0, 12)) {
        const item = el('div', `list-row${interactive ? ' is-clickable' : ''}`)
        const topRow = el('div', 'row between')

        const left = el('div', 'title-group')
        const dot = el('span', `status-dot status-${t.phase}${isTaskDraft(t) ? ' status-draft' : ''}`)
        left.appendChild(dot)
        const titleBtn = el('button', 'list-title-btn', t.title)
        titleBtn.type = 'button'
        titleBtn.disabled = !interactive || Boolean(busyAction)
        titleBtn.addEventListener('click', () => {
          void handleOpenFromList(t.id)
        })
        left.appendChild(titleBtn)
        topRow.appendChild(left)

        const right = el('div', 'row pills-group')
        right.appendChild(el('span', resolvePillClass(t.phase, t.subPhase), formatPhaseBadge(t.phase, t.subPhase, locale)))
        if (t.writeGate === 'locked') right.appendChild(el('span', 'pill pill-danger', 'locked'))
        if (interactive) {
          const locBtn = el('button', 'btn btn-ghost btn-xs', strings.locateShort)
          locBtn.type = 'button'
          locBtn.title = strings.openInBoard
          locBtn.disabled = Boolean(busyAction)
          locBtn.addEventListener('click', (ev) => {
            ev.stopPropagation()
            void handleFocusInBoard(t.id, isTaskDraft(t))
          })
          right.appendChild(locBtn)
        }
        topRow.appendChild(right)
        item.appendChild(topRow)

        const sub: string[] = []
        if (t.workspaceLabel) sub.push(t.workspaceLabel)
        if (t.subgoalRollup && t.subgoalRollup.total > 0) {
          sub.push(`${strings.subgoalsTitle} ${t.subgoalRollup.done}/${t.subgoalRollup.total}`)
        }
        if (t.hasUserNotes) sub.push(locale === 'zh' ? '含人类备注' : 'Has human notes')
        if (sub.length > 0) {
          item.appendChild(el('div', 'muted-xs list-sub', sub.join(' · ')))
        }
        listWrap.appendChild(item)
      }
    }
    card.appendChild(listWrap)

    if (feedback) {
      const fb = el('div', `feedback-bar feedback-${feedback.kind}`, feedback.text)
      fb.dataset.testid = 'card-feedback'
      card.appendChild(fb)
    }

    root.innerHTML = ''
    root.appendChild(card)
  }

  function render() {
    if (mode === 'single' && currentTask) {
      renderSingleTask(currentTask)
    } else if (mode === 'list' && currentList) {
      renderTaskList(currentList)
    } else if (mode === 'cancelled') {
      root.innerHTML = ''
      const card = el('div', 'agy-card')
      card.appendChild(el('div', 'muted-xs', c().cancelled))
      root.appendChild(card)
    } else {
      root.innerHTML = ''
      const card = el('div', 'agy-card')
      card.appendChild(el('div', 'muted-xs', c().loading))
      root.appendChild(card)
    }
    onRendered?.()
  }

  return {
    setLocale(next: CardLocale) {
      if (locale === next) return
      locale = next
      render()
    },
    showLoading(hintTitle?: string) {
      mode = 'loading'
      root.innerHTML = ''
      const card = el('div', 'agy-card')
      card.appendChild(
        el('div', 'muted-xs', hintTitle ? `${c().loading} (${hintTitle})` : c().loading),
      )
      root.appendChild(card)
      onRendered?.()
    },
    showCancelled() {
      mode = 'cancelled'
      render()
    },
    handleToolResult(result: ToolResultLike) {
      if (result.isError) {
        feedback = { kind: 'error', text: extractErrorMessage(result, 'Tool call failed') }
        render()
        return
      }
      this.handlePayload(extractPayloadFromToolResult(result))
    },
    handlePayload(payload: Record<string, unknown> | null | undefined) {
      if (!payload) return
      const single = extractTaskFromPayload(payload)
      if (single) {
        currentTask = single
        syncDraftsFromTask(single)
        mode = 'single'
        editing = false
        feedback = null
        render()
        return
      }
      if (Array.isArray(payload.tasks)) {
        currentList = {
          total: typeof payload.total === 'number' ? payload.total : payload.tasks.length,
          counts: (payload.counts as CardCounts | undefined) ?? undefined,
          tasks: payload.tasks as CardTask[],
        }
        currentTask = null
        mode = 'list'
        editing = false
        feedback = null
        render()
      }
    },
    getState() {
      return {
        mode,
        task: currentTask,
        list: currentList,
        editing,
        expanded,
      }
    },
  }
}
