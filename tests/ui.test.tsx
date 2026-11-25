// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/client/App.tsx'
import { KanbanView } from '../src/client/components/KanbanView.tsx'
import { NewTaskModal, type NewTaskPayload } from '../src/client/components/NewTaskModal.tsx'
import { RefPreviewModal } from '../src/client/components/RefPreviewModal.tsx'
import {
  ScheduleAlertBanner,
  ScheduleComposer,
  ScheduleMicroBadge,
  TaskScheduleBar,
} from '../src/client/components/ScheduleComposer.tsx'
import { StatusGlyph } from '../src/client/components/StatusGlyph.tsx'
import { TaskCard } from '../src/client/components/TaskCard.tsx'
import type { BoardSnapshot, TaskRecord } from '../src/core/types.ts'

const originalFetch = globalThis.fetch
const originalParentDescriptor = Object.getOwnPropertyDescriptor(window, 'parent')
const originalMatchMedia = window.matchMedia

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  delete window.sidecar
  if (originalParentDescriptor) {
    Object.defineProperty(window, 'parent', originalParentDescriptor)
  }
  if (originalMatchMedia) {
    window.matchMedia = originalMatchMedia
  } else {
    delete (window as { matchMedia?: unknown }).matchMedia
  }
  document.documentElement.style.removeProperty('--background')
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.themeSource
  try {
    globalThis.localStorage?.clear()
  } catch {
    // ignore
  }
})

function buildSampleSnapshot(): BoardSnapshot {
  const now = Date.now()
  return {
    revision: 1,
    serverTime: now,
    timeZone: 'Asia/Shanghai',
    sessionDefaultPermission: 'read-only',
    maxConcurrentLaunches: 3,
    workspaces: [
      {
        id: 'ws-alpha',
        name: 'Alpha Repo',
        rootPath: 'E:\\workspace\\Projects\\alpha',
        folderPaths: ['E:\\workspace\\Projects\\alpha'],
        antigravityProjectId: 'ws-alpha',
        source: 'antigravity',
        createdAt: now - 1000,
      },
      {
        id: 'ws-beta',
        name: 'Beta Research',
        rootPath: 'E:\\workspace\\research\\beta',
        folderPaths: ['E:\\workspace\\research\\beta'],
        antigravityProjectId: 'ws-beta',
        source: 'antigravity',
        createdAt: now - 2000,
      },
    ],
    activeWorkspacePaths: ['E:\\workspace\\Projects\\alpha'],
    activeProjectId: 'ws-alpha',
    recentConversations: [],
    counts: { needs_you: 1, active: 0, on_hold: 0, todo: 1, closed: 0, archived: 0, dueReminders: 0 },
    tasks: [
      {
        id: 't-alpha',
        title: 'Alpha Permission Card',
        description: 'Needs approval before launch',
        prompt: 'Run alpha migration',
        phase: 'needs_you',
        subPhase: 'permission_pending',
        status: 'in_progress',
        priority: 'high',
        workspaceId: 'ws-alpha',
        workspacePath: 'E:\\workspace\\Projects\\alpha',
        workspaceLabel: 'Alpha Repo',
        blockedReason: 'Waiting for permission confirmation',
        dueAt: now + 3_600_000,
        sortOrder: 0,
        writeGate: 'locked',
        permission: 'workspace-write',
        reuseSession: true,
        tags: [{ name: 'infra' }],
        planRevision: 1,
        createdAt: now - 1000,
        updatedAt: now - 500,
        subgoals: [
          {
            id: 'sg-1',
            taskId: 't-alpha',
            title: 'Verify SQL schema',
            detail: '',
            kind: 'acceptance',
            required: true,
            status: 'done',
            sortOrder: 0,
            dependencies: [],
            addedBy: 'user',
            createdAt: now - 900,
          },
        ],
        subgoalRollup: {
          total: 1,
          done: 1,
          inProgress: 0,
          open: 0,
          skipped: 0,
          requiredTotal: 1,
          requiredDone: 1,
          requiredRemaining: 0,
          allRequiredDone: true,
          readyForReview: true,
        },
        refs: [{ id: 'ref-1', taskId: 't-alpha', kind: 'file', target: 'README.md', addedBy: 'user', createdAt: now }],
        conversations: [],
        executions: [],
      },
      {
        id: 't-beta',
        title: 'Beta Literature Review',
        description: '',
        prompt: 'Summarize papers',
        phase: 'todo',
        subPhase: 'ready',
        status: 'pending',
        priority: 'normal',
        workspaceId: 'ws-beta',
        workspacePath: 'E:\\workspace\\research\\beta',
        workspaceLabel: 'Beta Research',
        sortOrder: 0,
        writeGate: 'unlocked',
        reuseSession: true,
        tags: [{ name: 'research' }],
        planRevision: 0,
        createdAt: now - 1000,
        updatedAt: now - 500,
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
      },
    ],
  }
}

describe('React UI views, DDL timeline, Filter Popover, and progressive disclosure detail', () => {
  it('defaults to Focus view with left DDL timeline sorted earliest-first, persists view choice, and filters via Popover & search', () => {
    const snap = buildSampleSnapshot()
    const baseTodo = snap.tasks[1]
    const now = snap.serverTime
    snap.tasks.push(
      {
        ...baseTodo,
        id: 't-overdue',
        title: 'Urgent Overdue Todo',
        dueAt: now - 3_600_000,
        priority: 'normal',
      },
      {
        ...baseTodo,
        id: 't-later',
        title: 'Later Next Week Todo',
        dueAt: now + 5 * 86_400_000,
        priority: 'urgent',
      },
      {
        ...baseTodo,
        id: 't-pinned-undated',
        title: 'Pinned Undated Todo',
        userMarks: { taskId: 't-pinned-undated', pinnedAt: now - 100, updatedAt: now - 100 },
      },
    )

    const { unmount } = render(<App initialSnapshot={snap} />)

    // Default first-visit view MUST be Focus view with left DDL timeline ticks
    const focus = screen.getByTestId('focus-view')
    expect(focus).toBeInTheDocument()
    const tickOverdue = within(focus).getByTestId('ddl-tick-t-overdue')
    const tickLater = within(focus).getByTestId('ddl-tick-t-later')
    const tickUndated = within(focus).getByTestId('ddl-tick-t-pinned-undated')
    expect(tickOverdue).toHaveTextContent(/Overdue|已逾期/)

    // Overdue must precede later-due, which must precede undated pinned
    expect(tickOverdue.compareDocumentPosition(tickLater) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(tickLater.compareDocumentPosition(tickUndated) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // Unpinned undated normal todo (t-beta) lives in Bottom Quiet Pool Drawer, NOT Today's Focus
    const poolBox = within(focus).getByTestId('quiet-pool-box')
    expect(within(focus).queryByTestId('ddl-tick-t-beta')).not.toBeInTheDocument()
    fireEvent.click(poolBox.querySelector('button')!)
    expect(within(poolBox).getByText('Beta Literature Review')).toBeInTheDocument()

    // Open Filter & Settings Popover -> Workspace select filter
    fireEvent.click(screen.getByRole('button', { name: /Filters & Settings|筛选与设置/i }))
    const popover = screen.getByTestId('filter-popover')
    const wsSelect = within(popover).getByLabelText(/Workspace|工作区/i)
    fireEvent.change(wsSelect, { target: { value: 'ws-alpha' } })
    expect(screen.getByText('Alpha Permission Card')).toBeInTheDocument()
    expect(screen.queryByText('Beta Literature Review')).not.toBeInTheDocument()

    // Clear filter and switch to Kanban -> List -> persists view across remount
    fireEvent.change(wsSelect, { target: { value: '' } })
    fireEvent.click(within(popover).getByRole('button', { name: /Close|关闭/i }))
    fireEvent.click(screen.getByRole('button', { name: /Kanban|看板/i }))
    expect(screen.getByTestId('kanban-view')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /List|列表/i }))
    expect(screen.getByTestId('list-view')).toBeInTheDocument()

    // Search filters out non-matching task
    const searchInput = screen.getByPlaceholderText(/Search todos|搜索待办/i)
    fireEvent.change(searchInput, { target: { value: 'Literature' } })
    expect(screen.queryByText('Alpha Permission Card')).not.toBeInTheDocument()
    expect(screen.getByText('Beta Literature Review')).toBeInTheDocument()

    unmount()
    render(<App initialSnapshot={snap} />)
    expect(screen.getByTestId('list-view')).toBeInTheDocument()
  })

  it('supports ignore & restore in FocusView, restrained zero-button normal cards, InboxCard actions, and never renders raw phase/subPhase strings', async () => {
    const snap = buildSampleSnapshot()
    snap.tasks.push({
      ...snap.tasks[1],
      id: 't-active',
      title: 'Running Task',
      phase: 'active',
      subPhase: 'running',
      status: 'in_progress',
      userMarks: { taskId: 't-active', ignoredAt: Date.now() - 1000, updatedAt: Date.now() - 1000 },
    })
    snap.tasks[1] = {
      ...snap.tasks[1],
      phase: 'needs_you',
      subPhase: 'review',
      status: 'in_progress',
      conversations: [{ taskId: 't-beta', conversationId: 'conv-r1', role: 'primary', linkedAt: Date.now() }],
    }

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/tasks/marks')) {
        snap.tasks[2].userMarks = undefined
        return new Response(JSON.stringify({ ok: true, task: snap.tasks[2] }), { status: 200 })
      }
      if (url.includes('/api/snapshot')) {
        return new Response(JSON.stringify(snap), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    render(<App initialSnapshot={snap} />)

    // Never expose raw English enums in rendered UI
    expect(document.body.textContent).not.toMatch(/needs_you\/permission_pending|needs_you\/review|active\/running/)

    // Ignored box in FocusView shows ignored count & restore button
    const ignoredBox = screen.getByTestId('ignored-box')
    expect(ignoredBox).toHaveTextContent(/1/)
    fireEvent.click(within(ignoredBox).getByRole('button', { name: /Ignored|已忽略/i }))
    expect(within(ignoredBox).getByText('Running Task')).toBeInTheDocument()
    fireEvent.click(within(ignoredBox).getByRole('button', { name: /Restore|寻回/i }))
    await waitFor(() => expect(screen.queryByTestId('ignored-box')).not.toBeInTheDocument())
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/tasks/marks'))).toBe(true)

    // Switch to Kanban and check Restrained Card Contract + full-card semantic tint grammar
    fireEvent.click(screen.getByRole('button', { name: /Kanban|看板/i }))
    const activeCard = screen.getByTestId('task-card-t-active')
    expect(activeCard).toHaveClass('tint-active')
    expect(within(activeCard).queryByRole('button', { name: /Open Session|Split|Rework|Resume|Start Session|打开会话|分屏|返工|继续/i })).not.toBeInTheDocument()

    // InboxCard on t-beta exposes ONLY Open Session + Split + Approve and uses green tint-ok
    const betaCard = screen.getByTestId('task-card-t-beta')
    expect(betaCard).toHaveClass('tint-ok')
    expect(within(betaCard).getByRole('button', { name: /Open Session|打开会话/i })).toBeInTheDocument()
    expect(within(betaCard).getByRole('button', { name: /Approve|验收通过/i })).toBeInTheDocument()
    expect(within(betaCard).queryByRole('button', { name: /Rework|返工/i })).not.toBeInTheDocument()

    // Permission-blocked InboxCard on t-alpha shows Confirm Elevated Permission and uses amber tint-warn
    const alphaCard = screen.getByTestId('task-card-t-alpha')
    expect(alphaCard).toHaveClass('tint-warn')
    expect(within(alphaCard).getByRole('button', { name: /Confirm Elevated Permission|确认提权/i })).toBeInTheDocument()
    expect(within(alphaCard).queryByRole('button', { name: /Approve|验收通过/i })).not.toBeInTheDocument()
  })

  it('KanbanView rejects manual drops onto On Hold (disabled col:on_hold and card-target fallback) and buckets Closed tasks by Today / Yesterday / Last 7 Days / Older', async () => {
    const now = new Date(2026, 6, 15, 14, 0, 0).getTime()
    const yesterday = new Date(2026, 6, 14, 15, 0, 0).getTime()
    const threeDaysAgo = new Date(2026, 6, 12, 12, 0, 0).getTime()
    const older = new Date(2026, 5, 10, 12, 0, 0).getTime()

    const mkTask = (overrides: Partial<TaskRecord> & { id: string; title: string }): TaskRecord => ({
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
    })

    const tasks: TaskRecord[] = [
      mkTask({ id: 't-needs', title: 'Needs Task', phase: 'needs_you', subPhase: 'review', status: 'in_progress' }),
      mkTask({ id: 't-hold', title: 'Paused System Task', phase: 'on_hold', subPhase: 'paused', status: 'in_progress' }),
      mkTask({ id: 't-todo', title: 'Todo Drag Source', phase: 'todo', subPhase: 'ready', status: 'pending' }),
      mkTask({ id: 't-c-today', title: 'Closed Today', phase: 'closed', subPhase: 'done', status: 'done', completedAt: now - 1000 }),
      mkTask({ id: 't-c-yest', title: 'Closed Yesterday', phase: 'closed', subPhase: 'done', status: 'done', completedAt: yesterday }),
      mkTask({ id: 't-c-7d', title: 'Closed 3 Days Ago', phase: 'closed', subPhase: 'done', status: 'done', completedAt: threeDaysAgo }),
      mkTask({ id: 't-c-old', title: 'Closed Older', phase: 'closed', subPhase: 'done', status: 'done', completedAt: older }),
    ]

    const onMovePhase = vi.fn()
    const onSwitchToList = vi.fn()
    const { rerender } = render(
      <KanbanView
        tasks={tasks}
        locale="en"
        layoutTier="wide"
        sessionDefaultPermission="read-only"
        now={now}
        onOpenTask={() => {}}
        onFilterWorkspace={() => {}}
        onJump={() => {}}
        onConfirmPermission={() => {}}
        onApproveAndClose={() => {}}
        onMovePhase={onMovePhase}
        onReorderPhase={() => {}}
        onSwitchToList={onSwitchToList}
      />,
    )

    const kanban = screen.getByTestId('kanban-view')
    const onHoldZone = kanban.querySelector('[data-dropzone="col:on_hold"]') as HTMLElement
    expect(onHoldZone).toHaveClass('is-drop-disabled')
    expect(screen.getByTestId('task-card-t-hold')).toHaveClass('tint-danger')
    expect(kanban.querySelectorAll('[role="button"] [role="button"]')).toHaveLength(0)

    const makeDomRect = (top: number, left = 300): DOMRect => ({
      top,
      bottom: top + 60,
      left,
      right: left + 240,
      width: 240,
      height: 60,
      x: left,
      y: top,
      toJSON: () => ({}),
    })
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const dropzone = this.getAttribute('data-dropzone')
      if (dropzone === 'col:needs_you') return makeDomRect(0, 300)
      if (dropzone === 'col:active') return makeDomRect(200, 0)
      if (dropzone === 'col:on_hold') return makeDomRect(200, 300)
      if (dropzone === 'col:todo') return makeDomRect(400, 300)
      if (dropzone === 'col:closed') return makeDomRect(600, 300)

      const childTestId = this.firstElementChild?.getAttribute('data-testid')
      const testId = this.getAttribute('data-testid') || childTestId
      if (testId === 'task-card-t-needs') return makeDomRect(0, 300)
      if (testId === 'task-card-t-hold') return makeDomRect(200, 300)
      if (testId === 'task-card-t-todo') return makeDomRect(400, 300)
      return makeDomRect(600, 300)
    })

    const pauseTick = () => new Promise((r) => setTimeout(r, 25))
    try {
      const todoSortable = screen.getByTestId('task-card-t-todo').parentElement!

      // Attempt drop onto on_hold card target (t-hold): card-target fallback blocked
      await act(async () => {
        fireEvent.keyDown(todoSortable, { code: 'Space', key: ' ' })
        await pauseTick()
      })
      await act(async () => {
        fireEvent.keyDown(document, { code: 'ArrowUp', key: 'ArrowUp' })
        await pauseTick()
      })
      expect(onHoldZone).not.toHaveClass('is-over')
      await act(async () => {
        fireEvent.keyDown(document, { code: 'Space', key: ' ' })
        await pauseTick()
      })
      expect(onMovePhase).not.toHaveBeenCalled()

      // Move up twice onto needs_you (t-needs) and drop: succeeds
      await act(async () => {
        fireEvent.keyDown(todoSortable, { code: 'Space', key: ' ' })
        await pauseTick()
      })
      await act(async () => {
        fireEvent.keyDown(document, { code: 'ArrowUp', key: 'ArrowUp' })
        await pauseTick()
      })
      await act(async () => {
        fireEvent.keyDown(document, { code: 'ArrowUp', key: 'ArrowUp' })
        await pauseTick()
      })
      await act(async () => {
        fireEvent.keyDown(document, { code: 'Space', key: ' ' })
        await pauseTick()
      })
      expect(onMovePhase).toHaveBeenCalledWith('t-todo', 'needs_you', expect.anything())

      // Expand Closed tier -> verifies 7-day cap (Today/Yesterday/Last 7 Days only) + older footer link
      fireEvent.click(screen.getByRole('button', { name: /Expand archive/i }))
      expect(screen.getByText('Today (1)')).toBeInTheDocument()
      expect(screen.getByText('Yesterday (1)')).toBeInTheDocument()
      expect(screen.getByText('Last 7 Days (1)')).toBeInTheDocument()
      expect(screen.queryByText(/Older \(1\)/)).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /View 1 older items/i }))
      expect(onSwitchToList).toHaveBeenCalledWith('status')

      // Empty On Hold lane skips disabled dropzone to active, and opens inline launch confirmation strip
      onMovePhase.mockClear()
      rerender(
        <KanbanView
          tasks={[tasks[2]]}
          locale="en"
          layoutTier="wide"
          sessionDefaultPermission="read-only"
          now={now}
          onOpenTask={() => {}}
          onFilterWorkspace={() => {}}
          onJump={() => {}}
          onConfirmPermission={() => {}}
          onApproveAndClose={() => {}}
          onMovePhase={onMovePhase}
          onReorderPhase={() => {}}
        />,
      )
      const todoOnlySortable = screen.getByTestId('task-card-t-todo').parentElement!
      await act(async () => {
        fireEvent.keyDown(todoOnlySortable, { code: 'Space', key: ' ' })
        await pauseTick()
      })
      await act(async () => {
        fireEvent.keyDown(document, { code: 'ArrowUp', key: 'ArrowUp' })
        await pauseTick()
      })
      expect(screen.getByTestId('kanban-view').querySelector('[data-dropzone="col:on_hold"]')).not.toHaveClass('is-over')
      await act(async () => {
        fireEvent.keyDown(document, { code: 'Space', key: ' ' })
        await pauseTick()
      })
      expect(onMovePhase).not.toHaveBeenCalledWith('t-todo', 'on_hold', expect.anything())
      expect(onMovePhase).not.toHaveBeenCalled()
      const launchStrip = screen.getByTestId('kanban-launch-strip')
      fireEvent.click(within(launchStrip).getByRole('button', { name: /Move Only \(Manual\)/i }))
      expect(onMovePhase).toHaveBeenCalledWith('t-todo', 'active', undefined)
    } finally {
      rectSpy.mockRestore()
    }
  })

  it('supports List Master-Detail inline pane, By Status vs By Workspace toggle, multi-folder dropdown, subfolder preservation, and NewTaskModal quick DDL', async () => {
    const now = Date.now()
    const snap = buildSampleSnapshot()
    snap.workspaces = [
      {
        id: 'ws-multi',
        name: 'Mono Repo',
        rootPath: 'E:\\mono\\core',
        folderPaths: ['E:\\mono\\core', 'E:\\mono\\web'],
        antigravityProjectId: 'ws-multi',
        source: 'antigravity',
        createdAt: now - 1000,
      },
      {
        id: 'ws-gamma',
        name: 'Gamma Empty',
        rootPath: 'E:\\workspace\\research\\gamma',
        folderPaths: ['E:\\workspace\\research\\gamma'],
        antigravityProjectId: 'ws-gamma',
        source: 'antigravity',
        createdAt: now - 500,
      },
    ]
    snap.activeWorkspacePaths = []
    snap.recentConversations = [
      {
        conversationId: 'conv-recent-web-1',
        title: 'Web Checkout Investigation',
        preview: 'Checked cart reducer',
        projectId: 'ws-multi',
        workspacePaths: ['E:\\mono\\web'],
        status: 'CASCADE_RUN_STATUS_IDLE',
        isIdle: true,
        stepCount: 4,
        lastModifiedAt: now - 500,
      },
    ]
    const baseTask = snap.tasks[0]
    snap.tasks = [
      {
        ...baseTask,
        id: 't-core',
        title: 'Core API Task',
        phase: 'todo',
        subPhase: 'ready',
        status: 'pending',
        permission: undefined,
        workspaceId: 'ws-multi',
        workspacePath: 'E:\\mono\\core',
        workspaceLabel: 'Mono Repo',
      },
      {
        ...baseTask,
        id: 't-web',
        title: 'Web Root Task',
        phase: 'todo',
        subPhase: 'ready',
        status: 'pending',
        permission: undefined,
        workspaceId: 'ws-multi',
        workspacePath: 'E:\\mono\\web',
        workspaceLabel: 'web',
      },
      {
        ...baseTask,
        id: 't-web-sub',
        title: 'Web Portal Subfolder Task',
        phase: 'todo',
        subPhase: 'ready',
        status: 'pending',
        permission: undefined,
        workspaceId: 'ws-multi',
        workspacePath: 'E:\\mono\\web\\apps\\portal',
        workspaceLabel: 'portal',
      },
    ]

    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/tasks/get')) {
        return new Response(JSON.stringify({ task: snap.tasks[0], events: [] }), { status: 200 })
      }
      if (url.includes('/api/tasks/create')) {
        return new Response(JSON.stringify({ ok: true, task: { ...snap.tasks[1], id: 't-created-conv' } }), { status: 200 })
      }
      if (url.includes('/api/tasks/conversation/link')) {
        return new Response(JSON.stringify({ ok: true, task: snap.tasks[1] }), { status: 200 })
      }
      if (url.includes('/api/snapshot')) {
        return new Response(JSON.stringify(snap), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    render(<App initialSnapshot={snap} />)

    // Multi-folder dropdown inside Filter Popover lists ws-multi + both folderPaths
    fireEvent.click(screen.getByRole('button', { name: /Filters & Settings|筛选与设置/i }))
    const popover = screen.getByTestId('filter-popover')
    const wsSelect = within(popover).getByLabelText(/Workspace/i) as HTMLSelectElement
    const optionValues = [...wsSelect.options].map((o) => o.value)
    expect(optionValues).toContain('ws-multi')
    expect(optionValues).toContain('path:E:\\mono\\core')
    expect(optionValues).toContain('path:E:\\mono\\web')

    fireEvent.change(wsSelect, { target: { value: 'path:E:\\mono\\web' } })
    fireEvent.click(within(popover).getByRole('button', { name: /Close|关闭/i }))
    expect(screen.queryByText('Core API Task')).not.toBeInTheDocument()
    expect(screen.getByText('Web Root Task')).toBeInTheDocument()
    expect(screen.getByText('Web Portal Subfolder Task')).toBeInTheDocument()

    // Clicking subfolder micro-tag filters strictly to E:\mono\web\apps\portal
    const portalCard = screen.getByTestId('task-card-t-web-sub')
    const portalWsBadge = within(portalCard).getByTitle('E:\\mono\\web\\apps\\portal')
    fireEvent.click(portalWsBadge)
    expect(screen.queryByText('Web Root Task')).not.toBeInTheDocument()
    expect(screen.getByText('Web Portal Subfolder Task')).toBeInTheDocument()

    // NewTaskModal opened while filtered to subfolder preserves exact subfolder path even with More Options collapsed
    fireEvent.click(screen.getByRole('button', { name: /New Todo|新建待办/i }))
    const modal = screen.getByTestId('new-task-modal')
    expect(within(modal).getByDisplayValue('E:\\mono\\web\\apps\\portal')).toBeInTheDocument()
    fireEvent.click(within(modal).getByRole('button', { name: /Close|关闭/i }))

    // Clear filter and switch to List Master-Detail view
    fireEvent.click(screen.getByRole('button', { name: /Clear filter|清除筛选/i }))
    fireEvent.click(screen.getByRole('button', { name: /List|列表/i }))
    const listView = screen.getByTestId('list-view')
    expect(within(listView).getByText(/Select a todo to view details/i)).toBeInTheDocument()
    expect(within(listView).queryByText(/Web Checkout Investigation/)).not.toBeInTheDocument()

    // Select a task -> renders inline TaskDetailView inside ListView (single instance, no overlay duplicate)
    fireEvent.click(within(listView).getByTestId('task-card-t-core'))
    expect(screen.getAllByTestId('task-detail-drawer')).toHaveLength(1)

    // Switching from List back to Focus clears inline selection so no overlay drawer pops up unexpectedly
    fireEvent.click(screen.getByRole('button', { name: /Focus|焦点/i }))
    expect(screen.queryByTestId('task-detail-drawer')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /List|列表/i }))
    const listViewReopened = screen.getByTestId('list-view')

    // Switch to By Workspace grouping -> discovers empty Gamma Empty workspace without flat-listed conversations
    fireEvent.click(within(listViewReopened).getByRole('button', { name: /By Workspace|按工作区分组/i }))
    fireEvent.click(within(listViewReopened).getByRole('button', { name: /Other Discovered Workspaces|其他已发现工作区/i }))
    expect(within(listViewReopened).getByText('Gamma Empty')).toBeInTheDocument()

    // Open NewTaskModal, fill quick DDL + Title + Subgoals + More Options -> Link recent session
    fireEvent.click(screen.getAllByRole('button', { name: /New Todo|新建待办/i })[0])
    const convModal = screen.getByTestId('new-task-modal')
    fireEvent.change(within(convModal).getByLabelText(/Due At|截止时间/i), {
      target: { value: '2026-12-01T18:00' },
    })
    fireEvent.change(within(convModal).getByPlaceholderText(/One subgoal/i), {
      target: { value: 'Step A\nStep B' },
    })
    const moreDetails = within(convModal).getByTestId('new-task-more-options')
    fireEvent.click(moreDetails.querySelector('summary')!)
    const convSelect = within(convModal).getByLabelText(/Link existing session|关联已有会话/i) as HTMLSelectElement
    fireEvent.change(convSelect, { target: { value: 'conv-recent-web-1' } })
    expect(within(convModal).getByDisplayValue('Web Checkout Investigation')).toBeInTheDocument()
    expect(within(convModal).getByDisplayValue('E:\\mono\\web')).toBeInTheDocument()

    fireEvent.click(within(convModal).getByRole('button', { name: /^Save$|^保存$/i }))
    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/tasks/create'))
      const linkCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/tasks/conversation/link'))
      expect(createCall).toBeTruthy()
      expect(linkCall).toBeTruthy()
      const createBody = JSON.parse(String(createCall![1]?.body))
      expect(createBody.workspacePath).toBe('E:\\mono\\web')
      expect(typeof createBody.dueAt).toBe('number')
      expect(createBody.subgoals).toEqual([
        { title: 'Step A', required: true },
        { title: 'Step B', required: true },
      ])
      const linkBody = JSON.parse(String(linkCall![1]?.body))
      expect(linkBody.conversationId).toBe('conv-recent-web-1')
    })
  })

  it('enforces !needsPerm guards, Split ↗ ({ split: right }), Auto-open Popover toggle, and inline Rework in TaskDetailView', async () => {
    const snap = buildSampleSnapshot()
    snap.tasks[0].conversations = [
      { taskId: 't-alpha', conversationId: 'conv-perm-blocked', role: 'primary', linkedAt: Date.now(), isIdle: true },
    ]
    snap.tasks[1] = {
      ...snap.tasks[1],
      phase: 'needs_you',
      subPhase: 'review',
      status: 'in_progress',
      conversations: [
        { taskId: 't-beta', conversationId: 'conv-ready-1', role: 'primary', linkedAt: Date.now(), isIdle: true },
      ],
    }

    const toggleConversation = vi.fn()
    Object.defineProperty(window, 'parent', { value: { fakeParent: true }, configurable: true })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/tasks/dispatch')) {
        return new Response(
          JSON.stringify({ ok: true, action: 'new', executionId: 'ex-1', conversationId: 'conv-auto-jump-9', task: snap.tasks[1] }),
          { status: 200 },
        )
      }
      if (url.includes('/api/tasks/get')) {
        const isBeta = url.includes('t-beta')
        return new Response(JSON.stringify({ task: isBeta ? snap.tasks[1] : snap.tasks[0], events: [] }), { status: 200 })
      }
      if (url.includes('/api/snapshot')) {
        return new Response(JSON.stringify(snap), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    window.sidecar = {
      fetch: fetchMock as unknown as typeof fetch,
      getWorkspaceUris: async () => [],
      onWorkspaceChange: () => () => {},
      ui: { toggleConversation },
    }

    render(<App initialSnapshot={snap} />)

    // !needsPerm guard inside TaskDetailDrawer disables Subgoal dispatch on Tab 1 and Relay / New, Continue Session, Rework on Agent Tab
    fireEvent.click(screen.getByTestId('task-card-t-alpha'))
    const drawer = screen.getByTestId('task-detail-drawer')
    expect(within(drawer).getByTitle(/Start Session|Relay \/ New/i)).toBeDisabled()
    fireEvent.click(within(drawer).getByRole('tab', { name: /Agent/i }))
    expect(within(drawer).getByRole('button', { name: /Relay \/ New/i })).toBeDisabled()
    expect(within(drawer).getByRole('button', { name: /Continue Session/i })).toBeDisabled()
    expect(within(drawer).getByRole('button', { name: /^Rework$/i })).toBeDisabled()
    fireEvent.click(within(drawer).getByRole('button', { name: /Close|关闭/i }))

    // Switch to Kanban to test InboxCard Split ↗ button directly
    fireEvent.click(screen.getByRole('button', { name: /Kanban|看板/i }))
    const betaCard = screen.getByTestId('task-card-t-beta')
    fireEvent.click(within(betaCard).getByTitle(/Split ↗/i))
    expect(toggleConversation).toHaveBeenCalledWith('conv-ready-1', { split: 'right' })

    // Turn Auto-open session OFF via Filter Popover, open t-beta detail, send inline Rework (should NOT auto-jump)
    fireEvent.click(screen.getByRole('button', { name: /Filters & Settings|筛选与设置/i }))
    const popover = screen.getByTestId('filter-popover')
    const autoOpenBtn = within(popover).getByRole('button', { name: /Auto-open session/i })
    if (autoOpenBtn.className.includes('is-active')) {
      fireEvent.click(autoOpenBtn)
    }
    fireEvent.click(within(popover).getByRole('button', { name: /Close|关闭/i }))
    toggleConversation.mockClear()

    fireEvent.click(betaCard)
    const betaDrawer = screen.getByTestId('task-detail-drawer')
    fireEvent.click(within(betaDrawer).getByRole('tab', { name: /Agent/i }))
    const reworkBtns = within(betaDrawer).getAllByRole('button', { name: /^Rework$/i })
    fireEvent.click(reworkBtns[0])
    fireEvent.change(within(betaDrawer).getByPlaceholderText(/Send rework instructions/i), {
      target: { value: 'Fix edge case please' },
    })
    fireEvent.click(within(betaDrawer).getByRole('button', { name: /Send Rework/i }))
    await waitFor(() => {
      const dispatchCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/tasks/dispatch'))
      expect(dispatchCall).toBeTruthy()
      const body = JSON.parse(String(dispatchCall![1]?.body))
      expect(body).toMatchObject({
        taskId: 't-beta',
        mode: 'rework',
        conversationId: 'conv-ready-1',
        reworkInstructions: 'Fix edge case please',
      })
    })
    expect(toggleConversation).not.toHaveBeenCalled()

    // Toggle Auto-open session ON -> click Relay / New inside detail -> auto-jumps to new conversation
    fireEvent.click(screen.getByRole('button', { name: /Filters & Settings|筛选与设置/i }))
    const popover2 = screen.getByTestId('filter-popover')
    fireEvent.click(within(popover2).getByRole('button', { name: /Auto-open session/i }))
    fireEvent.click(within(popover2).getByRole('button', { name: /Close|关闭/i }))
    toggleConversation.mockClear()

    fireEvent.click(within(screen.getByTestId('task-detail-drawer')).getByRole('button', { name: /Relay \/ New/i }))
    await waitFor(() => expect(toggleConversation).toHaveBeenCalledWith('conv-auto-jump-9'))

    // Standalone TaskCard Split ↗ & ListView smoke check
    delete window.sidecar
    if (originalParentDescriptor) Object.defineProperty(window, 'parent', originalParentDescriptor)
    const standaloneOnJump = vi.fn()
    const { container: standaloneCardWrap } = render(
      <TaskCard
        task={snap.tasks[1]}
        locale="en"
        sessionDefaultPermission="read-only"
        now={Date.now()}
        onOpen={() => {}}
        onFilterWorkspace={() => {}}
        onJump={standaloneOnJump}
        onConfirmPermission={() => {}}
      />,
    )
    fireEvent.click(within(standaloneCardWrap).getByTitle(/Split ↗/i))
    expect(standaloneOnJump).toHaveBeenCalledWith('conv-ready-1', { split: 'right' })
  })

  it('collapses Advanced Settings by default in TaskDetailView and supports Markdown, comments, Handover, dueAt, freeze: null, Apply Path unbind, key={task.id} reset, and RefPreviewModal guards', async () => {
    const snap = buildSampleSnapshot()
    const dueMs = new Date(2026, 7, 10, 16, 30, 0).getTime()
    snap.tasks[0] = {
      ...snap.tasks[0],
      description: '# Markdown Title\n\nCheck **bold** and `inline` plus [safe](https://example.com) and [xss](javascript:alert(1)).',
      blockedReason: '- Blocked on `review`\n- Check [docs](https://example.org)',
      dueAt: dueMs,
      freeze: { goal: 'Ship feature', progress: 'Halfway', next: 'Add tests', frozenAt: Date.now() - 2000 },
      handover: {
        workspaceId: 'ws-alpha',
        mode: 'plan',
        permission: 'workspace-write',
        references: ['src/core/types.ts', 'README.md'],
        bundledAt: Date.now() - 1000,
      },
      conversations: [
        { taskId: 't-alpha', conversationId: 'conv-a1', role: 'primary', linkedAt: Date.now() },
      ],
      executions: [
        { id: 'ex-open-1', taskId: 't-alpha', conversationId: 'conv-a1', startedAt: Date.now() - 5000 },
      ],
      comments: [],
    }
    snap.tasks[1] = {
      ...snap.tasks[1],
      title: 'Second Task For Reset',
      description: 'Clean second description',
      reminderAt: snap.serverTime - 1000,
      conversations: [
        { taskId: 't-beta', conversationId: 'conv-b1', role: 'primary', linkedAt: Date.now() },
      ],
    }

    const updateCalls: Array<{ taskId: string; patch: Record<string, unknown> }> = []
    const commentCalls: Array<{ taskId: string; bodyMd: string; author: string }> = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/tasks/get')) {
        const isBeta = url.includes('t-beta')
        return new Response(
          JSON.stringify({ task: isBeta ? snap.tasks[1] : snap.tasks[0], events: [] }),
          { status: 200 },
        )
      }
      if (url.includes('/api/tasks/update')) {
        const body = JSON.parse(String(init?.body)) as { taskId: string; patch: Record<string, unknown> }
        updateCalls.push(body)
        if ('dueAt' in body.patch) snap.tasks[0].dueAt = body.patch.dueAt as number | undefined
        if (body.patch.freeze === null) snap.tasks[0].freeze = undefined
        if (body.patch.handover === null) snap.tasks[0].handover = undefined
        else if (body.patch.handover) snap.tasks[0].handover = body.patch.handover as TaskRecord['handover']
        if (body.patch.workspaceId === null) snap.tasks[0].workspaceId = undefined
        if (body.patch.workspacePath === null) snap.tasks[0].workspacePath = undefined
        return new Response(JSON.stringify({ ok: true, task: snap.tasks[0] }), { status: 200 })
      }
      if (url.includes('/api/tasks/comment/add')) {
        const body = JSON.parse(String(init?.body)) as { taskId: string; bodyMd: string; author: string }
        commentCalls.push(body)
        const newComment = { id: 'c-1', taskId: body.taskId, author: body.author, bodyMd: body.bodyMd, createdAt: Date.now() }
        snap.tasks[0].comments = [...(snap.tasks[0].comments ?? []), newComment]
        return new Response(
          JSON.stringify({ ok: true, comment: newComment, comments: snap.tasks[0].comments, task: snap.tasks[0] }),
          { status: 200 },
        )
      }
      if (url.includes('/api/snapshot')) {
        return new Response(JSON.stringify(snap), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch

    render(<App initialSnapshot={snap} />)
    fireEvent.click(screen.getByTestId('task-card-t-alpha'))
    const drawer = screen.getByTestId('task-detail-drawer')

    // 0. Open execution Settle button visible in unified 4-state slot above tabs
    expect(within(drawer).getByTestId('detail-status-slot')).toHaveTextContent(/Settle Open Turn/i)

    // 1. Markdown rendering (description in Quick Memo + blockedReason in unified status slot) + XSS link neutralization
    expect(within(drawer).getByRole('heading', { name: 'Markdown Title', level: 1 })).toBeInTheDocument()
    expect(within(drawer).getByText('bold').tagName).toBe('STRONG')
    expect(within(drawer).getByText('inline').tagName).toBe('CODE')
    expect(within(drawer).getByRole('link', { name: 'safe' })).toHaveAttribute('href', 'https://example.com')
    expect(within(drawer).queryByRole('link', { name: 'xss' })).not.toBeInTheDocument()
    const blockedCallout = drawer.querySelector('.callout-blocked') as HTMLElement
    expect(within(blockedCallout).getByText('review').tagName).toBe('CODE')
    expect(within(blockedCallout).getByRole('link', { name: 'docs' })).toHaveAttribute('href', 'https://example.org')

    // 2. dueAt input edit on Tab 1 (My View) -> Save sends numeric dueAt, Clear -> dueAt: null
    const dueInput = within(drawer).getByLabelText(/Due At/i) as HTMLInputElement
    expect(dueInput.value).toBe('2026-08-10T16:30')
    fireEvent.change(dueInput, { target: { value: '2026-09-01T09:15' } })
    const saveButtons = within(drawer).getAllByRole('button', { name: /^Save$/i })
    fireEvent.click(saveButtons[0])
    await waitFor(() => expect(updateCalls.some((u) => typeof u.patch.dueAt === 'number')).toBe(true))
    await waitFor(() => expect(saveButtons[0]).not.toBeDisabled())

    fireEvent.click(within(drawer).getByTitle(/^Clear$/i))
    fireEvent.click(saveButtons[0])
    await waitFor(() => expect(updateCalls.some((u) => u.patch.dueAt === null)).toBe(true))
    await waitFor(() => expect(saveButtons[0]).not.toBeDisabled())

    // 3. Switch to Tab 2 (Agent Control) -> Advanced Settings collapsed by default -> Handover, Comments, Freeze: null, Apply Path unbind
    fireEvent.click(within(drawer).getByRole('tab', { name: /Agent/i }))
    const advFold = within(drawer).getByTestId('advanced-settings-fold') as HTMLDetailsElement
    expect(advFold.open).toBe(false)
    advFold.open = true
    advFold.querySelectorAll('details').forEach((d) => {
      d.open = true
    })

    const saveHandoverBtn = within(drawer).getByRole('button', { name: /Save Handover/i })
    fireEvent.click(saveHandoverBtn)
    await waitFor(() =>
      expect(
        updateCalls.some(
          (u) =>
            (u.patch.handover as { mode?: string; references?: string[] } | undefined)?.mode === 'plan' &&
            (u.patch.handover as { references?: string[] } | undefined)?.references?.length === 2,
        ),
      ).toBe(true),
    )
    await waitFor(() => expect(saveHandoverBtn).not.toBeDisabled())

    fireEvent.click(within(drawer).getByRole('button', { name: /Clear Handover/i }))
    await waitFor(() => expect(updateCalls.some((u) => u.patch.handover === null)).toBe(true))
    await waitFor(() => expect(saveHandoverBtn).not.toBeDisabled())

    fireEvent.change(within(drawer).getByPlaceholderText(/Add a Markdown note/i), {
      target: { value: 'Verified **edge** case' },
    })
    fireEvent.click(within(drawer).getByRole('button', { name: /Add Comment/i }))
    await waitFor(() => expect(commentCalls).toHaveLength(1))
    expect(commentCalls[0]).toMatchObject({ taskId: 't-alpha', bodyMd: 'Verified **edge** case', author: 'user' })
    await waitFor(() => expect(within(drawer).getByText('edge').tagName).toBe('STRONG'))

    fireEvent.change(within(drawer).getByPlaceholderText('Goal'), { target: { value: '' } })
    fireEvent.change(within(drawer).getByPlaceholderText('Progress'), { target: { value: '' } })
    fireEvent.change(within(drawer).getByPlaceholderText('Next'), { target: { value: '' } })
    fireEvent.click(within(drawer).getByTestId('save-freeze-btn'))
    await waitFor(() => expect(updateCalls.some((u) => u.patch.freeze === null)).toBe(true))
    await waitFor(() => expect(saveHandoverBtn).not.toBeDisabled())

    const pathInput = within(drawer).getByPlaceholderText(/Workspace subfolder path/i)
    fireEvent.change(pathInput, { target: { value: '' } })
    fireEvent.click(within(drawer).getByRole('button', { name: /Apply Path/i }))
    await waitFor(() =>
      expect(updateCalls.some((u) => u.patch.workspaceId === null && u.patch.workspacePath === null)).toBe(true),
    )

    // 4. key={task.id} resets unsaved transient drafts and resets active tab when switching directly from t-alpha to t-beta WITHOUT closing drawer
    fireEvent.change(within(drawer).getByPlaceholderText(/Add a Markdown note/i), {
      target: { value: 'Unsaved alpha comment' },
    })
    const dueBannerBtn = screen.getByRole('button', { name: /Second Task For Reset/i })
    fireEvent.click(dueBannerBtn)
    const drawerBeta = screen.getByTestId('task-detail-drawer')
    expect(drawerBeta).not.toBe(drawer)
    expect(within(drawerBeta).getByDisplayValue('Second Task For Reset')).toBeInTheDocument()
    fireEvent.click(within(drawerBeta).getByRole('tab', { name: /Agent/i }))
    const betaAdvFold = within(drawerBeta).getByTestId('advanced-settings-fold') as HTMLDetailsElement
    betaAdvFold.open = true
    betaAdvFold.querySelectorAll('details').forEach((d) => {
      d.open = true
    })
    expect((within(drawerBeta).getByPlaceholderText(/Add a Markdown note/i) as HTMLTextAreaElement).value).toBe('')

    // 5. RefPreviewModal encoded file:/// URI & URL/command preview comment guard
    const toggleAuxPane = vi.fn()
    const addArtifactComment = vi.fn()
    window.sidecar = {
      fetch: globalThis.fetch,
      getWorkspaceUris: async () => [],
      onWorkspaceChange: () => () => {},
      ui: { toggleAuxPane, addArtifactComment },
    }

    const { unmount } = render(
      <RefPreviewModal
        locale="en"
        preview={{
          ok: true,
          kind: 'file',
          target: 'docs/notes #1?.md',
          resolvedPath: 'E:\\my repo\\docs\\notes #1?.md',
          language: 'markdown',
          sizeBytes: 24,
          content: '# Note',
        }}
        onClose={() => {}}
        onToast={() => {}}
      />,
    )
    const fileModal = screen.getByTestId('ref-preview-modal')
    fireEvent.click(within(fileModal).getByRole('button', { name: /Open in File View/i }))
    expect(toggleAuxPane).toHaveBeenCalledWith({
      tabType: 'fileView',
      uri: 'file:///E:/my%20repo/docs/notes%20%231%3F.md',
    })
    fireEvent.change(within(fileModal).getByPlaceholderText(/Add read-only artifact comment/i), {
      target: { value: 'Review line 1' },
    })
    fireEvent.click(within(fileModal).getByRole('button', { name: /Comment to Agent/i }))
    expect(addArtifactComment).toHaveBeenCalledWith({
      uri: 'file:///E:/my%20repo/docs/notes%20%231%3F.md',
      comment: 'Review line 1',
      pageTitle: 'docs/notes #1?.md',
    })
    unmount()

    const { unmount: unmountUrl } = render(
      <RefPreviewModal
        locale="en"
        preview={{
          ok: true,
          kind: 'url',
          isUrl: true,
          target: 'https://example.com/spec',
          language: 'text',
          sizeBytes: 24,
          content: 'https://example.com/spec',
        }}
        onClose={() => {}}
        onToast={() => {}}
      />,
    )
    const urlModal = screen.getByTestId('ref-preview-modal')
    expect(within(urlModal).getByRole('link', { name: /Open URL/i })).toHaveAttribute('href', 'https://example.com/spec')
    expect(within(urlModal).queryByRole('button', { name: /Open in File View/i })).not.toBeInTheDocument()
    expect(within(urlModal).queryByRole('button', { name: /Comment to Agent/i })).not.toBeInTheDocument()
    unmountUrl()

    render(
      <RefPreviewModal
        locale="en"
        preview={{
          ok: true,
          kind: 'command',
          target: 'npx vitest run',
          language: 'bash',
          sizeBytes: 14,
          content: 'npx vitest run',
        }}
        onClose={() => {}}
        onToast={() => {}}
      />,
    )
    const cmdModal = screen.getByTestId('ref-preview-modal')
    expect(within(cmdModal).queryByRole('button', { name: /Open in File View/i })).not.toBeInTheDocument()
    expect(within(cmdModal).queryByRole('button', { name: /Comment to Agent/i })).not.toBeInTheDocument()
  })

  it('follows Antigravity host theme (pinned Light/Dark or OS inherit), reacts to sidecar theme-change messages, and exposes 3-way Follow Agy / Light / Dark selector', async () => {
    let prefersLight = true
    const listeners = new Set<() => void>()
    window.matchMedia = vi.fn().mockImplementation(() => ({
      get matches() {
        return prefersLight
      },
      media: '(prefers-color-scheme: light)',
      addEventListener: (_ev: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_ev: string, fn: () => void) => listeners.delete(fn),
    })) as unknown as typeof window.matchMedia

    // 1. Pinned host dark overrides OS light
    const snapDark = { ...buildSampleSnapshot(), hostTheme: 'dark' as const }
    const { unmount } = render(<App initialSnapshot={snapDark} />)
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.themeSource).toBe('host')
    unmount()

    // 2. Host system (inherit) follows OS matchMedia dynamically, even when flipped dark -> light
    prefersLight = false
    const snapInherit = { ...buildSampleSnapshot(), hostTheme: 'system' as const }
    render(<App initialSnapshot={snapInherit} />)
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.themeSource).toBe('host')

    act(() => {
      prefersLight = true
      for (const fn of listeners) fn()
    })
    expect(document.documentElement.dataset.theme).toBe('light')

    // 3. Sidecar preload theme-change message overrides live --background theme immediately
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'theme-change', payload: { cssVariables: { '--background': '#262624' } } },
        }),
      )
    })
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.themeSource).toBe('host')

    // 4. Filter Popover 3-way selector switches Follow Agy / Light / Dark
    fireEvent.click(screen.getByRole('button', { name: /Filters & Settings|筛选与设置/i }))
    const popover = screen.getByTestId('filter-popover')
    const themeGroup = within(popover).getByRole('group', { name: /Theme|外观主题/i })

    fireEvent.click(within(themeGroup).getByRole('button', { name: /Light|浅色/i }))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.dataset.themeSource).toBe('user')
    expect(globalThis.localStorage.getItem('agy-board:theme')).toBe('light')

    fireEvent.click(within(themeGroup).getByRole('button', { name: /Dark|深色/i }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.themeSource).toBe('user')
    expect(globalThis.localStorage.getItem('agy-board:theme')).toBe('dark')

    fireEvent.click(within(themeGroup).getByRole('button', { name: /Follow Agy|跟随 agy/i }))
    expect(document.documentElement.dataset.themeSource).toBe('host')
    expect(globalThis.localStorage.getItem('agy-board:theme')).toBeNull()
  })

  it('supports FocusView active quick-jump, ★ pin toggle, Snooze menu, Quiet Pool auto-expand, and NewTaskModal defaultPinToFocus', async () => {
    const snap = buildSampleSnapshot()
    const now = snap.serverTime
    snap.tasks = [
      {
        ...snap.tasks[0],
        id: 't-active-focus',
        title: 'Active Focus Run',
        phase: 'active',
        subPhase: 'running',
        status: 'in_progress',
        conversations: [{ taskId: 't-active-focus', conversationId: 'conv-focus-1', role: 'primary', linkedAt: now }],
        executions: [{ id: 'ex-f1', taskId: 't-active-focus', conversationId: 'conv-focus-1', startedAt: now - 30_000 }],
      },
      {
        ...snap.tasks[1],
        id: 't-today-focus',
        title: 'Urgent Focus Item',
        priority: 'urgent',
      },
      {
        ...snap.tasks[1],
        id: 't-someday-pool',
        title: 'Someday Pool Item',
        priority: 'normal',
      },
    ]

    const marksCalls: Array<{ taskId: string; pin?: boolean; snoozeUntil?: number | null }> = []
    const createBodies: Array<Record<string, unknown>> = []
    const toggleConversation = vi.fn()
    Object.defineProperty(window, 'parent', { value: { fakeParent: true }, configurable: true })

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/tasks/marks')) {
        const body = JSON.parse(String(init?.body)) as { taskId: string; pin?: boolean; snoozeUntil?: number | null }
        marksCalls.push(body)
        return new Response(JSON.stringify({ ok: true, task: snap.tasks[1] }), { status: 200 })
      }
      if (url.includes('/api/tasks/create')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        createBodies.push(body)
        return new Response(JSON.stringify({ ok: true, task: { ...snap.tasks[1], id: 't-new-pinned' } }), { status: 200 })
      }
      if (url.includes('/api/snapshot')) {
        return new Response(JSON.stringify(snap), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch

    window.sidecar = {
      fetch: globalThis.fetch,
      getWorkspaceUris: async () => [],
      onWorkspaceChange: () => () => {},
      ui: { toggleConversation },
    }

    const { unmount } = render(<App initialSnapshot={snap} />)
    const focus = screen.getByTestId('focus-view')

    // Zone 2 active card exposes Open Session + Split ↗
    const activeRow = within(focus).getByTestId('task-card-t-active-focus')
    fireEvent.click(within(activeRow).getByRole('button', { name: /Open Session|打开会话/i }))
    expect(toggleConversation).toHaveBeenCalledWith('conv-focus-1')

    // Star pin toggle on Focus row
    const urgentRow = within(focus).getByTestId('task-card-t-today-focus')
    fireEvent.click(within(urgentRow).getByRole('button', { name: /Star|星标置顶/i }))
    await waitFor(() => expect(marksCalls.some((m) => m.taskId === 't-today-focus' && m.pin === true)).toBe(true))

    // Snooze menu (+2 hours) sets snoozeUntil without touching dueAt
    fireEvent.click(within(urgentRow).getByRole('button', { name: /Snooze|延后/i }))
    const snoozeMenu = within(focus).getByTestId('snooze-menu-t-today-focus')
    fireEvent.click(within(snoozeMenu).getByRole('menuitem', { name: /\+2 hours|\+2 小时/i }))
    await waitFor(() =>
      expect(marksCalls.some((m) => m.taskId === 't-today-focus' && typeof m.snoozeUntil === 'number')).toBe(true),
    )

    // NewTaskModal opened inside FocusView defaults "Add to Today's Focus" ON and sends pin: true
    fireEvent.click(screen.getByRole('button', { name: /New Todo|新建待办/i }))
    const modal = screen.getByTestId('new-task-modal')
    const pinCheckbox = within(modal).getByRole('checkbox', { name: /Add to Today's Focus|加入今日聚焦/i }) as HTMLInputElement
    expect(pinCheckbox.checked).toBe(true)
    fireEvent.change(within(modal).getByPlaceholderText(/What needs to be done|记一条/i), {
      target: { value: 'New Focus Task' },
    })
    fireEvent.click(within(modal).getByRole('button', { name: /^Save$|^保存$/i }))
    await waitFor(() => expect(createBodies.some((b) => b.pin === true && b.title === 'New Focus Task')).toBe(true))
    unmount()

    // When Zones 1-3 are completely empty while Quiet Pool has items, Quiet Pool auto-expands with calm hint
    const emptyPrimarySnap = buildSampleSnapshot()
    emptyPrimarySnap.tasks = [
      {
        ...snap.tasks[2],
        id: 't-pool-only',
        title: 'Pool Only Item',
        priority: 'normal',
      },
      {
        ...snap.tasks[2],
        id: 't-snoozed-pool',
        title: 'Snoozed Pool Item',
        userMarks: { taskId: 't-snoozed-pool', snoozedUntil: now + 7_200_000, updatedAt: now },
      },
    ]
    render(<App initialSnapshot={emptyPrimarySnap} />)
    const pool = screen.getByTestId('quiet-pool-box')
    expect(within(pool).getByText(/Nothing urgent today|今日无紧急事项/i)).toBeInTheDocument()
    expect(within(pool).getByText('Pool Only Item')).toBeInTheDocument()
    expect(within(pool).getByRole('button', { name: /Unsnooze|解除延后/i })).toBeInTheDocument()
  })

  it('renders KanbanView concurrency pill, elapsed timer, next subgoal, worktree branch, and actionable todo -> active confirmation strip', async () => {
    vi.useFakeTimers()
    const now = new Date(2026, 6, 15, 14, 0, 0).getTime()
    vi.setSystemTime(now)

    try {
      const snap = buildSampleSnapshot()
      const base = snap.tasks[1]
      const tasks: TaskRecord[] = [
        {
          ...base,
          id: 't-run',
          title: 'Live Active Run',
          phase: 'active',
          subPhase: 'running',
          status: 'in_progress',
          worktreeBranch: 'agy-board/t-run',
          conversations: [{ taskId: 't-run', conversationId: 'conv-run-1', role: 'primary', linkedAt: now - 65_000 }],
          executions: [{ id: 'ex-1', taskId: 't-run', conversationId: 'conv-run-1', startedAt: now - 65_000 }],
          subgoals: [
            { id: 'sg-done', taskId: 't-run', title: 'Setup DB', detail: '', kind: 'implementation', required: true, status: 'done', sortOrder: 0, dependencies: [], addedBy: 'user', createdAt: now },
            { id: 'sg-next', taskId: 't-run', title: 'Write tests', detail: '', kind: 'acceptance', required: true, status: 'open', sortOrder: 1, dependencies: [], addedBy: 'user', createdAt: now },
          ],
          subgoalRollup: { total: 2, done: 1, inProgress: 0, open: 1, skipped: 0, requiredTotal: 2, requiredDone: 1, requiredRemaining: 1, allRequiredDone: false, readyForReview: false },
        },
        {
          ...base,
          id: 't-ready-bound',
          title: 'Bound Ready Task',
          phase: 'todo',
          subPhase: 'ready',
          workspaceId: 'ws-alpha',
          workspacePath: 'E:\\workspace\\Projects\\alpha',
        },
        {
          ...base,
          id: 't-backlog-hidden',
          title: 'Hidden Backlog Task',
          phase: 'todo',
          subPhase: 'backlog',
        },
      ]

      const onDispatchTask = vi.fn()
      const onJump = vi.fn()
      render(
        <KanbanView
          tasks={tasks}
          locale="en"
          layoutTier="wide"
          sessionDefaultPermission="read-only"
          maxConcurrentLaunches={4}
          now={now}
          onOpenTask={() => {}}
          onFilterWorkspace={() => {}}
          onJump={onJump}
          onConfirmPermission={() => {}}
          onApproveAndClose={() => {}}
          onMovePhase={() => {}}
          onReorderPhase={() => {}}
          onDispatchTask={onDispatchTask}
        />,
      )

      // Concurrency pill + live elapsed timer ticking + next subgoal + worktree branch + jump button
      expect(screen.getByTestId('kanban-concurrency-pill')).toHaveTextContent('Running 1/4')
      expect(screen.getByTestId('elapsed-t-run')).toHaveTextContent('01:05')
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(screen.getByTestId('elapsed-t-run')).toHaveTextContent('01:06')

      const runCard = screen.getByTestId('task-card-t-run')
      expect(within(runCard).getByText(/↳ 1\/2: Write tests/)).toBeInTheDocument()
      expect(within(runCard).getByText('agy-board/t-run')).toBeInTheDocument()
      fireEvent.click(within(runCard).getByRole('button', { name: /Open Session/i }))
      expect(onJump).toHaveBeenCalledWith('conv-run-1')

      // Backlog hidden from Tier 3 with 1-line summary
      expect(screen.queryByText('Hidden Backlog Task')).not.toBeInTheDocument()
      expect(screen.getByTestId('kanban-hidden-summary')).toHaveTextContent(/Backlog \(1\)/)

      // Drag bound Ready task -> col:active opens launch confirmation strip & invokes onDispatchTask
      const makeDomRect = (top: number): DOMRect => ({
        top,
        bottom: top + 60,
        left: 0,
        right: 240,
        width: 240,
        height: 60,
        x: 0,
        y: top,
        toJSON: () => ({}),
      })
      const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement,
      ) {
        const dropzone = this.getAttribute('data-dropzone')
        if (dropzone === 'col:needs_you') return makeDomRect(0)
        if (dropzone === 'col:active') return makeDomRect(200)
        if (dropzone === 'col:on_hold') return makeDomRect(200)
        if (dropzone === 'col:todo') return makeDomRect(400)
        if (dropzone === 'col:closed') return makeDomRect(600)
        const tid = this.getAttribute('data-testid') || this.firstElementChild?.getAttribute('data-testid')
        if (tid === 'task-card-t-run') return makeDomRect(200)
        return makeDomRect(400)
      })

      try {
        const readySortable = screen.getByTestId('task-card-t-ready-bound').parentElement!
        await act(async () => {
          fireEvent.keyDown(readySortable, { code: 'Space', key: ' ' })
          vi.advanceTimersByTime(30)
        })
        await act(async () => {
          fireEvent.keyDown(document, { code: 'ArrowUp', key: 'ArrowUp' })
          vi.advanceTimersByTime(30)
        })
        await act(async () => {
          fireEvent.keyDown(document, { code: 'Space', key: ' ' })
          vi.advanceTimersByTime(30)
        })
        const strip = screen.getByTestId('kanban-launch-strip')
        fireEvent.click(within(strip).getByRole('button', { name: /Start AI Session/i }))
        expect(onDispatchTask).toHaveBeenCalledWith('t-ready-bound')
      } finally {
        rectSpy.mockRestore()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('supports ListView 4-axis grouping (workspace/status/schedule/tag), sort, Ready<->Backlog toggle, Shift+Click multi-select, Batch Bar, and Arrow stepping', async () => {
    const snap = buildSampleSnapshot()
    const now = snap.serverTime
    snap.tasks = [
      {
        ...snap.tasks[1],
        id: 't-1',
        title: 'First Ready Task',
        phase: 'todo',
        subPhase: 'ready',
        priority: 'high',
        dueAt: now + 10_000,
        updatedAt: now - 100,
        tags: [{ name: 'backend' }],
        schedule: { enabled: true, mode: 'cron', cron: '0 9 * * *', nextRunAt: now + 3_600_000, runCount: 1 },
      },
      {
        ...snap.tasks[1],
        id: 't-2',
        title: 'Second Backlog Task',
        phase: 'todo',
        subPhase: 'backlog',
        priority: 'urgent',
        dueAt: now + 20_000,
        updatedAt: now - 200,
        tags: [{ name: 'frontend' }],
        schedule: { enabled: false, mode: 'once', at: now - 5000, runCount: 0, endedReason: 'missed' },
      },
      {
        ...snap.tasks[1],
        id: 't-3',
        title: 'Third Ready Task',
        phase: 'todo',
        subPhase: 'ready',
        priority: 'low',
        dueAt: now + 30_000,
        updatedAt: now - 300,
        tags: [],
      },
    ]

    const batchCalls: Array<Record<string, unknown>> = []
    const transitionCalls: Array<Record<string, unknown>> = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/tasks/batch')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        batchCalls.push(body)
        return new Response(
          JSON.stringify({ ok: true, action: body.action, affectedIds: body.taskIds, skippedIds: [], tasks: [] }),
          { status: 200 },
        )
      }
      if (url.includes('/api/tasks/transition')) {
        transitionCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(JSON.stringify({ ok: true, task: snap.tasks[0] }), { status: 200 })
      }
      if (url.includes('/api/tasks/get')) {
        return new Response(JSON.stringify({ task: snap.tasks[0], events: [] }), { status: 200 })
      }
      if (url.includes('/api/snapshot')) {
        return new Response(JSON.stringify(snap), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch

    render(<App initialSnapshot={snap} />)
    fireEvent.click(screen.getByRole('button', { name: /List|列表/i }))
    const listView = screen.getByTestId('list-view')

    // 1. Default grouping is By Workspace; switch across By Schedule, By Tag, By Status
    fireEvent.click(within(listView).getByRole('button', { name: /By Schedule|按定时/i }))
    expect(within(listView).getByText(/Schedule Alerts|调度异常/i)).toBeInTheDocument()
    expect(within(listView).getByText(/Recurring Active|周期运行中/i)).toBeInTheDocument()

    fireEvent.click(within(listView).getByRole('button', { name: /By Tag|按标签/i }))
    expect(within(listView).getByText('#backend')).toBeInTheDocument()
    expect(within(listView).getByText('#frontend')).toBeInTheDocument()

    fireEvent.click(within(listView).getByRole('button', { name: /By Status|按状态|按阶段/i }))
    expect(within(listView).getAllByText(/想法池 Backlog|^Backlog$/i).length).toBeGreaterThanOrEqual(2)

    // 2. Sort by due date -> t-1 before t-3 in Ready group
    fireEvent.change(within(listView).getByTestId('list-sort-select'), { target: { value: 'due' } })

    // 3. Inline Ready <-> Backlog 1-click pill toggle
    fireEvent.click(within(listView).getByTestId('toggle-subphase-t-1'))
    await waitFor(() =>
      expect(transitionCalls.some((c) => c.taskId === 't-1' && c.subPhase === 'backlog')).toBe(true),
    )

    // 4. Shift+Click range selection across visible rows -> sticky Batch Action Bar
    fireEvent.click(within(listView).getByRole('checkbox', { name: /Select First Ready Task/i }))
    fireEvent.click(within(listView).getByRole('checkbox', { name: /Select Second Backlog Task/i }), {
      shiftKey: true,
    })
    const batchBar = within(listView).getByTestId('list-batch-bar')
    expect(batchBar).toHaveTextContent(/3 selected|已选 3 项/)

    // Execute batch pin + 2-step delete
    fireEvent.click(within(batchBar).getByRole('button', { name: /★ Pin|★ 聚焦/i }))
    await waitFor(() =>
      expect(batchCalls.some((c) => c.action === 'pin' && (c.taskIds as string[]).length === 3)).toBe(true),
    )

    fireEvent.click(within(batchBar).getByRole('button', { name: /^Delete$|^删除$/i }))
    fireEvent.click(within(batchBar).getByRole('button', { name: /Confirm Delete|确认删除/i }))
    await waitFor(() =>
      expect(batchCalls.some((c) => c.action === 'delete' && (c.taskIds as string[]).length === 3)).toBe(true),
    )

    // 5. ArrowDown keyboard stepping in Master pane selects first task
    const masterPane = within(listView).getByTestId('list-master-pane')
    fireEvent.keyDown(masterPane, { key: 'ArrowDown' })
    expect(within(listView).getByTestId('task-card-t-1')).toHaveClass('is-selected')
  })

  it('renders zero-Cron ScheduleComposer guardrails, weekly auto-sync, high-freq Cron warning, and next-3 previews', () => {
    const onSave = vi.fn()
    const { rerender } = render(
      <ScheduleComposer
        locale="zh"
        workspacePath=""
        onSave={onSave}
        onCancel={() => {}}
      />,
    )

    // Unbound workspace + action='dispatch' shows guardrail and disables Save
    expect(screen.getByTestId('schedule-workspace-guardrail')).toBeInTheDocument()
    const saveBtn = screen.getByRole('button', { name: '保存' })
    expect(saveBtn).toBeDisabled()

    // Switching to "仅到点提醒我" unblocks Save and clears guardrail
    fireEvent.click(screen.getByRole('button', { name: /仅到点提醒我/i }))
    expect(screen.queryByTestId('schedule-workspace-guardrail')).not.toBeInTheDocument()
    expect(saveBtn).not.toBeDisabled()

    // Next 3 previews are rendered
    const previews = screen.getByTestId('schedule-previews')
    expect(previews.querySelectorAll('.sched-preview-chip')).toHaveLength(3)

    // Weekly pill -> toggling Sat & Sun on top of Mon-Fri auto-syncs to '每天'
    fireEvent.click(screen.getByRole('button', { name: '每周' }))
    fireEvent.click(screen.getByRole('button', { name: '六' }))
    fireEvent.click(screen.getByRole('button', { name: '日' }))
    fireEvent.click(saveBtn)
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'cron',
        cron: '0 9 * * *',
        action: 'remind',
      }),
    )

    // Custom Cron < 60m shows high-frequency warning
    rerender(
      <ScheduleComposer
        locale="zh"
        workspacePath="E:\\repo\\demo"
        onSave={onSave}
        onCancel={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cron' }))
    fireEvent.change(screen.getByLabelText('Cron 表达式'), { target: { value: '*/15 * * * *' } })
    expect(screen.getByTestId('high-freq-warning')).toBeInTheDocument()
  })

  it('renders TaskScheduleBar actions, NewTaskModal quick schedule, ScheduleAlertBanner catch-up, recurring Accept Round, and Only-Scheduled filter', async () => {
    const snap = buildSampleSnapshot()
    const now = snap.serverTime
    snap.tasks[0] = {
      ...snap.tasks[0],
      phase: 'needs_you',
      subPhase: 'review',
      permission: 'read-only',
      schedule: {
        enabled: true,
        mode: 'cron',
        cron: '0 9 * * 1-5',
        nextRunAt: now + 3_600_000,
        missedSlotAt: now - 1_800_000,
        skippedReason: 'missed',
        runCount: 2,
      },
    }
    snap.tasks[1] = {
      ...snap.tasks[1],
      dueAt: undefined,
      reminderAt: now - 1_000,
    }

    const calledUrls: string[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      calledUrls.push(url)
      if (url.includes('/api/tasks/get')) {
        return new Response(JSON.stringify({ task: snap.tasks[0], events: [] }), { status: 200 })
      }
      if (url.includes('/api/tasks/schedule/complete-cycle')) {
        snap.tasks[0] = { ...snap.tasks[0], phase: 'todo', subPhase: 'ready', status: 'pending' }
        return new Response(JSON.stringify({ ok: true, task: snap.tasks[0] }), { status: 200 })
      }
      if (url.includes('/api/tasks/schedule/catch-up')) {
        snap.tasks[0].schedule = { ...snap.tasks[0].schedule!, missedSlotAt: undefined, skippedReason: undefined }
        return new Response(JSON.stringify({ ok: true, task: snap.tasks[0] }), { status: 200 })
      }
      if (url.includes('/api/tasks/schedule/run-now')) {
        return new Response(JSON.stringify({ ok: true, task: snap.tasks[0] }), { status: 200 })
      }
      if (url.includes('/api/tasks/schedule')) {
        return new Response(JSON.stringify({ ok: true, task: snap.tasks[0] }), { status: 200 })
      }
      if (url.includes('/api/snapshot')) {
        return new Response(JSON.stringify(snap), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch

    render(<App initialSnapshot={snap} />)

    // 1. Top ScheduleAlertBanner renders missed schedule & due reminder actions
    const alertBanner = screen.getByTestId('schedule-alert-banner')
    expect(alertBanner).toBeInTheDocument()
    expect(within(alertBanner).getByRole('button', { name: /Catch Up Now|立即补跑/i })).toBeInTheDocument()
    expect(within(alertBanner).getByRole('button', { name: /Snooze 1h|延后 1h/i })).toBeInTheDocument()

    // 2. FocusView shows ScheduleMicroBadge & recurring Accept Round button
    const alphaCard = screen.getByTestId('task-card-t-alpha')
    expect(within(alphaCard).getByTestId('schedule-micro-badge')).toBeInTheDocument()
    fireEvent.click(within(alphaCard).getByRole('button', { name: /Accept Round|验收本轮/i }))
    await waitFor(() => expect(calledUrls.some((u) => u.includes('/api/tasks/schedule/complete-cycle'))).toBe(true))

    // 3. Filter Popover "Scheduled only" isolates scheduled tasks
    fireEvent.click(screen.getByRole('button', { name: /Filters & Settings|筛选与设置/i }))
    fireEvent.click(screen.getByTestId('filter-only-scheduled'))
    expect(screen.getByTestId('task-card-t-alpha')).toBeInTheDocument()

    // 4. Open TaskDetailDrawer -> TaskScheduleBar is promoted outside Advanced Settings
    fireEvent.click(screen.getByTestId('task-card-t-alpha'))
    const drawer = screen.getByTestId('task-detail-drawer')
    const bar = within(drawer).getByTestId('task-schedule-bar')
    expect(bar).toBeInTheDocument()
    fireEvent.click(within(bar).getByRole('button', { name: /Run Now|试跑/i }))
    await waitFor(() => expect(calledUrls.some((u) => u.includes('/api/tasks/schedule/run-now'))).toBe(true))

    // 5. Standalone NewTaskModal persists quick schedule in payload
    const onCreate = vi.fn(async (_input: NewTaskPayload) => {})
    render(
      <NewTaskModal
        locale="zh"
        workspaces={snap.workspaces}
        onClose={() => {}}
        onCreate={onCreate}
      />,
    )
    const modal = screen.getByTestId('new-task-modal')
    fireEvent.change(within(modal).getByPlaceholderText(/记一条需要处理的待办/i), {
      target: { value: 'Daily Standup Sync' },
    })
    fireEvent.click(within(modal).getByRole('button', { name: '明早 09:00' }))
    fireEvent.click(within(modal).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalled())
    const createdArg = onCreate.mock.calls[0][0]
    expect(createdArg.schedule).toMatchObject({ enabled: true, mode: 'once' })

    // 6. Standalone ScheduleMicroBadge & ScheduleAlertBanner catch-up skip check
    const onCatchUpSkip = vi.fn()
    const { container: alertWrap } = render(
      <ScheduleAlertBanner
        locale="en"
        now={now}
        dueReminders={[]}
        missedSchedules={[snap.tasks[0]]}
        onOpenTask={() => {}}
        onStartSession={() => {}}
        onSnoozeReminder={() => {}}
        onAckReminder={() => {}}
        onCatchUpRun={() => {}}
        onCatchUpSkip={onCatchUpSkip}
      />,
    )
    fireEvent.click(within(alertWrap).getByRole('button', { name: 'Skip' }))
    expect(onCatchUpSkip).toHaveBeenCalledWith('t-alpha')

    render(<ScheduleMicroBadge task={snap.tasks[0]} locale="en" now={now} />)
    const { container: remBar } = render(
      <TaskScheduleBar
        task={snap.tasks[1]}
        locale="en"
        sessionDefaultPermission="read-only"
        onRunAction={async (fn) => {
          await fn()
        }}
      />,
    )
    fireEvent.click(within(remBar).getByRole('button', { name: 'Add schedule…' }))
    expect(within(remBar).getByTestId('schedule-composer')).toBeTruthy()

    const { container: idleGlyph } = render(<StatusGlyph phase="active" animate={false} />)
    expect(idleGlyph.querySelector('.agy-spin')).toBeNull()
    const { container: spinningGlyph } = render(<StatusGlyph phase="active" animate={true} />)
    expect(spinningGlyph.querySelector('.agy-spin')).toBeTruthy()
    const { container: blockedGlyph } = render(<StatusGlyph phase="needs_you" subPhase="blocked" />)
    expect(blockedGlyph.querySelector('svg')).toHaveStyle({ color: 'var(--agy-danger-fg)' })
  })

  it('supports Demo Sandbox mode with full-state samples, zero backend/sidecar calls, sample reset, and clean live restore', async () => {
    const snap = buildSampleSnapshot()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const toggleConversationMock = vi.fn()
    window.sidecar = {
      fetch: fetchMock as unknown as typeof fetch,
      getWorkspaceUris: async () => [],
      onWorkspaceChange: () => () => {},
      ui: {
        toggleConversation: toggleConversationMock,
      },
    }

    render(<App initialSnapshot={snap} />)

    // Before entering sandbox, formal tasks are visible and banner is absent
    expect(screen.getByText('Alpha Permission Card')).toBeInTheDocument()
    expect(screen.queryByTestId('demo-sandbox-banner')).not.toBeInTheDocument()

    // Apply a workspace filter first to verify sandbox isolates & restores live filters cleanly
    fireEvent.click(screen.getByRole('button', { name: /Filters & Settings|筛选与设置/i }))
    const popover = screen.getByTestId('filter-popover')
    fireEvent.change(within(popover).getByLabelText(/Workspace|工作区/i), { target: { value: 'ws-alpha' } })
    expect(screen.queryByText('Beta Literature Review')).not.toBeInTheDocument()

    // Toggle Demo Sandbox ON from bottom of Filter & Settings popover
    fireEvent.click(within(popover).getByTestId('demo-sandbox-toggle'))

    // Banner appears, popover closes, formal tasks are hidden, and full-state samples appear
    const banner = screen.getByTestId('demo-sandbox-banner')
    expect(banner).toBeInTheDocument()
    expect(screen.queryByTestId('filter-popover')).not.toBeInTheDocument()
    expect(screen.queryByText('Alpha Permission Card')).not.toBeInTheDocument()

    // Full-state samples in Focus view
    expect(screen.getByTestId('task-card-demo-reminder-due')).toBeInTheDocument()
    expect(screen.getByTestId('task-card-demo-permission-pending')).toBeInTheDocument()
    expect(screen.getByTestId('task-card-demo-review')).toBeInTheDocument()
    expect(screen.getByTestId('task-card-demo-needs-input')).toBeInTheDocument()
    expect(screen.getByTestId('task-card-demo-active')).toBeInTheDocument()
    expect(screen.getByTestId('task-card-demo-on-hold')).toBeInTheDocument()
    expect(screen.getByTestId('task-card-demo-todo-overdue')).toBeInTheDocument()
    expect(screen.getByTestId('task-card-demo-todo-today')).toBeInTheDocument()
    expect(screen.getByTestId('task-card-demo-cron')).toBeInTheDocument()
    expect(screen.getByTestId('task-card-demo-after-completion')).toBeInTheDocument()
    expect(screen.getByTestId('schedule-alert-banner')).toBeInTheDocument()

    // Quiet Pool has backlog sample & Completed Today has closed sample
    const poolBox = screen.getByTestId('quiet-pool-box')
    fireEvent.click(poolBox.querySelector('button')!)
    expect(within(poolBox).getByTestId('quiet-pool-row-demo-backlog')).toBeInTheDocument()

    // Completed Today section has closed/done sample
    const completedHeading = screen.getByText(/Completed Today|今日已完成/i)
    fireEvent.click(completedHeading.closest('button')!)
    expect(screen.getByTestId('task-card-demo-closed-today')).toBeInTheDocument()

    // Perform in-memory mutations: approve review card -> moves out of Needs Attention into Completed Today
    const reviewCard = screen.getByTestId('task-card-demo-review')
    fireEvent.click(within(reviewCard).getByRole('button', { name: /Open Session|打开会话/i }))
    fireEvent.click(within(reviewCard).getByRole('button', { name: /Approve|验收通过/i }))
    await waitFor(() => expect(screen.queryByTestId('focus-row-demo-review')).not.toBeInTheDocument())
    expect(screen.getByTestId('task-card-demo-review')).toBeInTheDocument()

    // Switch to Kanban & List views inside sandbox to verify all-view rendering
    const viewTabs = screen.getByRole('tablist', { name: /View mode/i })
    fireEvent.click(within(viewTabs).getByRole('button', { name: /Kanban|看板/i }))
    expect(screen.getByTestId('kanban-view')).toBeInTheDocument()
    expect(screen.getByTestId('task-card-demo-on-hold')).toBeInTheDocument()

    fireEvent.click(within(viewTabs).getByRole('button', { name: /List|列表/i }))
    expect(screen.getByTestId('list-view')).toBeInTheDocument()
    fireEvent.click(within(viewTabs).getByRole('button', { name: /Focus|焦点/i }))
    expect(screen.getByTestId('focus-view')).toBeInTheDocument()

    // Dispatch a todo task via TaskDetailDrawer -> simulates turning into active without hitting /api/tasks/dispatch
    fireEvent.click(screen.getByTestId('task-card-demo-todo-today'))
    const drawer = screen.getByTestId('task-detail-drawer')
    fireEvent.click(within(drawer).getByRole('tab', { name: /Agent Control|Agent 控制面/i }))
    fireEvent.click(within(drawer).getAllByRole('button', { name: /Start Session|开始会话/i })[0])
    await waitFor(() => expect(within(drawer).getByTestId('detail-status-slot')).toHaveTextContent(/Agent running|Agent 执行中/i))
    fireEvent.click(within(drawer).getByRole('button', { name: /Close|关闭/i }))

    // Create a brand new task inside sandbox
    fireEvent.click(screen.getByRole('button', { name: /New Todo|新建待办/i }))
    const modal = screen.getByTestId('new-task-modal')
    fireEvent.change(within(modal).getByPlaceholderText(/What needs to be done|记一条需要处理的待办/i), {
      target: { value: 'Sandbox Ephemeral Todo' },
    })
    fireEvent.click(within(modal).getByRole('button', { name: /Save|保存/i }))
    await waitFor(() => expect(screen.getByText('Sandbox Ephemeral Todo')).toBeInTheDocument())

    // Verify ZERO real HTTP requests or real sidecar conversation jumps happened
    expect(fetchMock).not.toHaveBeenCalled()
    expect(toggleConversationMock).not.toHaveBeenCalled()

    // Reset Samples restores initial state (approved review card returns to Needs Attention, ephemeral task removed)
    fireEvent.click(screen.getByTestId('demo-sandbox-reset'))
    await waitFor(() => expect(screen.getByTestId('focus-row-demo-review')).toBeInTheDocument())
    expect(screen.queryByText('Sandbox Ephemeral Todo')).not.toBeInTheDocument()

    // Exit Sandbox restores formal snapshot & previous workspace filter
    fireEvent.click(screen.getByTestId('demo-sandbox-exit'))
    expect(screen.queryByTestId('demo-sandbox-banner')).not.toBeInTheDocument()
    expect(screen.getByText('Alpha Permission Card')).toBeInTheDocument()
    expect(screen.queryByText('Beta Literature Review')).not.toBeInTheDocument()
    expect(screen.queryByTestId('task-card-demo-review')).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
