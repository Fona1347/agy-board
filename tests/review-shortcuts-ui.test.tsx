// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/client/App.tsx'
import {
  isEditableElement,
  resolveReviewShortcut,
  shouldIgnoreBoardShortcut,
} from '../src/client/shortcuts.ts'
import type { BoardSnapshot, TaskRecord } from '../src/core/types.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  try {
    globalThis.localStorage?.clear()
  } catch {
    // ignore
  }
})

function buildShortcutSnapshot(): BoardSnapshot {
  const now = Date.now()
  return {
    revision: 1,
    serverTime: now,
    timeZone: 'Asia/Shanghai',
    sessionDefaultPermission: 'read-only',
    maxConcurrentLaunches: 3,
    workspaces: [
      {
        id: 'ws-1',
        name: 'Board Repo',
        rootPath: 'E:\\workspace\\agy-board',
        folderPaths: ['E:\\workspace\\agy-board'],
        antigravityProjectId: 'ws-1',
        source: 'antigravity',
        createdAt: now - 10_000,
      },
    ],
    activeWorkspacePaths: ['E:\\workspace\\agy-board'],
    activeProjectId: 'ws-1',
    recentConversations: [
      {
        conversationId: 'conv-recent-1',
        title: 'Recent Snapshot Chat',
        preview: 'recent',
        projectId: 'ws-1',
        workspacePaths: ['E:\\workspace\\agy-board'],
        status: 'CASCADE_RUN_STATUS_IDLE',
        isIdle: true,
        stepCount: 3,
        lastModifiedAt: now - 5_000,
      },
    ],
    counts: { needs_you: 1, active: 0, on_hold: 0, todo: 2, closed: 0, archived: 0, dueReminders: 0 },
    tasks: [
      {
        id: 't-draft',
        title: 'AI Draft Shortcut Task',
        description: 'Review me with shortcuts',
        prompt: 'Implement review shortcuts',
        phase: 'todo',
        subPhase: 'draft',
        status: 'pending',
        priority: 'normal',
        createdBy: 'ai',
        workspaceId: 'ws-1',
        workspacePath: 'E:\\workspace\\agy-board',
        workspaceLabel: 'Board Repo',
        dueAt: now + 3_600_000,
        sortOrder: 0,
        writeGate: 'unlocked',
        reuseSession: false,
        tags: [],
        planRevision: 0,
        createdAt: now - 2_000,
        updatedAt: now - 1_000,
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
      {
        id: 't-review-wt',
        title: 'Worktree Review Task',
        description: 'Ready for review with diff',
        prompt: 'Check diff',
        phase: 'needs_you',
        subPhase: 'review',
        status: 'in_progress',
        priority: 'high',
        workspaceId: 'ws-1',
        workspacePath: 'E:\\workspace\\agy-board',
        workspaceLabel: 'Board Repo',
        dueAt: now + 7_200_000,
        sortOrder: 1,
        writeGate: 'unlocked',
        reuseSession: false,
        useWorktree: true,
        worktreePath: 'E:\\workspace\\agy-board\\.worktrees\\agy-board-t-review-wt',
        worktreeBranch: 'agy-board/t-review-wt',
        tags: [],
        planRevision: 1,
        createdAt: now - 5_000,
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
          readyForReview: true,
        },
        refs: [],
        conversations: [],
        executions: [],
      },
      {
        id: 't-ready',
        title: 'Ready Dispatch Task',
        description: 'Ready for quick dispatch',
        prompt: 'Run task',
        phase: 'todo',
        subPhase: 'ready',
        status: 'pending',
        priority: 'normal',
        workspaceId: 'ws-1',
        workspacePath: 'E:\\workspace\\agy-board',
        workspaceLabel: 'Board Repo',
        dueAt: now + 10_800_000,
        sortOrder: 2,
        writeGate: 'unlocked',
        reuseSession: false,
        tags: [],
        planRevision: 0,
        createdAt: now - 3_000,
        updatedAt: now - 800,
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

describe('Review shortcuts (A/F/S/D), input guards, quick Worktree Diff, and paginated conversation lookup', () => {
  it('guards editable elements, contenteditable, IME composition, and modifier keys accurately', () => {
    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    const select = document.createElement('select')
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const editableChild = document.createElement('span')
    editable.appendChild(editableChild)
    const plainBtn = document.createElement('button')
    const host = document.createElement('div')
    host.append(input, textarea, select, editable, plainBtn)
    document.body.appendChild(host)
    try {
      expect(isEditableElement(input)).toBe(true)
      expect(isEditableElement(textarea)).toBe(true)
      expect(isEditableElement(select)).toBe(true)
      expect(isEditableElement(editable)).toBe(true)
      expect(isEditableElement(editableChild)).toBe(true)
      expect(isEditableElement(plainBtn)).toBe(false)

      expect(shouldIgnoreBoardShortcut({ key: 'a', target: input })).toBe(true)
      expect(shouldIgnoreBoardShortcut({ key: 'f', target: textarea })).toBe(true)
      expect(shouldIgnoreBoardShortcut({ key: 's', target: select })).toBe(true)
      expect(shouldIgnoreBoardShortcut({ key: 'd', target: editableChild })).toBe(true)

      // Active element guard even when event target is window/body
      input.focus()
      expect(shouldIgnoreBoardShortcut({ key: 'a', target: document.body }, document)).toBe(true)
      plainBtn.focus()
      expect(shouldIgnoreBoardShortcut({ key: 'a', target: document.body }, document)).toBe(false)

      // Modifier chords and IME composition must be ignored
      expect(shouldIgnoreBoardShortcut({ key: 'a', ctrlKey: true, target: plainBtn })).toBe(true)
      expect(shouldIgnoreBoardShortcut({ key: 'f', metaKey: true, target: plainBtn })).toBe(true)
      expect(shouldIgnoreBoardShortcut({ key: 's', altKey: true, target: plainBtn })).toBe(true)
      expect(shouldIgnoreBoardShortcut({ key: 'd', isComposing: true, target: plainBtn })).toBe(true)
      expect(shouldIgnoreBoardShortcut({ key: 'a', keyCode: 229, target: plainBtn })).toBe(true)

      expect(resolveReviewShortcut('a')).toBe('approve_draft')
      expect(resolveReviewShortcut('A')).toBe('approve_draft')
      expect(resolveReviewShortcut('f')).toBe('toggle_focus')
      expect(resolveReviewShortcut('s')).toBe('snooze')
      expect(resolveReviewShortcut('d')).toBe('dispatch')
      expect(resolveReviewShortcut('x')).toBeNull()
    } finally {
      host.remove()
    }
  })

  it('supports A/F/S/D shortcuts in TaskDetailDrawer with strict input/modifier guards', async () => {
    const snap = buildShortcutSnapshot()
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = []

    const updateTask = (taskId: string, updater: (t: TaskRecord) => TaskRecord) => {
      snap.tasks = snap.tasks.map((t) => (t.id === taskId ? updater(t) : t))
      snap.revision += 1
      return snap.tasks.find((t) => t.id === taskId)!
    }

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      calls.push({ url, body })

      if (url.includes('/api/revision')) {
        return new Response(JSON.stringify({ revision: snap.revision, serverTime: snap.serverTime }), { status: 200 })
      }
      if (url.includes('/api/snapshot')) {
        return new Response(JSON.stringify(snap), { status: 200 })
      }
      if (url.includes('/api/tasks/get')) {
        const id = new URL(url, 'http://localhost').searchParams.get('taskId') ?? ''
        const task = snap.tasks.find((t) => t.id === id)
        return new Response(JSON.stringify({ task, events: [] }), { status: 200 })
      }
      if (url.includes('/api/tasks/transition')) {
        const updated = updateTask(String(body?.taskId), (t) => ({
          ...t,
          phase: (body?.phase as TaskRecord['phase']) ?? t.phase,
          subPhase: (body?.subPhase as TaskRecord['subPhase']) ?? t.subPhase,
        }))
        return new Response(JSON.stringify({ ok: true, task: updated }), { status: 200 })
      }
      if (url.includes('/api/tasks/marks')) {
        const updated = updateTask(String(body?.taskId), (t) => ({
          ...t,
          userMarks: {
            taskId: t.id,
            updatedAt: Date.now(),
            pinnedAt:
              body?.pin === undefined ? t.userMarks?.pinnedAt : body.pin ? Date.now() : undefined,
            snoozedUntil:
              body?.snoozeUntil === undefined
                ? t.userMarks?.snoozedUntil
                : body.snoozeUntil === null
                  ? undefined
                  : Number(body.snoozeUntil),
          },
        }))
        return new Response(JSON.stringify({ ok: true, task: updated }), { status: 200 })
      }
      if (url.includes('/api/tasks/dispatch')) {
        const updated = updateTask(String(body?.taskId), (t) => ({
          ...t,
          phase: 'active',
          subPhase: 'running',
        }))
        return new Response(
          JSON.stringify({ ok: true, task: updated, executionId: 'exec-1', conversationId: 'conv-launched-1', action: 'new' }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch

    render(<App initialSnapshot={snap} />)

    // Open Draft task from FocusView
    fireEvent.click(screen.getByText('AI Draft Shortcut Task'))

    const drawer = await screen.findByTestId('task-detail-drawer')
    expect(within(drawer).getByTestId('detail-shortcut-hints')).toBeInTheDocument()

    // 1. Input & modifier guards inside drawer: typing in title input / notes textarea / select / contenteditable / Ctrl+A must NOT trigger shortcuts
    const titleInput = within(drawer).getByLabelText(/Title|标题/i)
    titleInput.focus()
    fireEvent.keyDown(titleInput, { key: 'a' })
    fireEvent.keyDown(window, { key: 'f' }) // document.activeElement is titleInput!

    const notesInput = within(drawer).getByTestId('human-notes-input')
    notesInput.focus()
    fireEvent.keyDown(notesInput, { key: 's' })

    const statusSelect = within(drawer).getByLabelText(/Status|状态/i)
    statusSelect.focus()
    fireEvent.keyDown(statusSelect, { key: 'd' })

    const ceDiv = document.createElement('div')
    ceDiv.setAttribute('contenteditable', 'true')
    drawer.appendChild(ceDiv)
    ceDiv.focus()
    fireEvent.keyDown(ceDiv, { key: 'a' })
    ceDiv.remove()

    ;(document.activeElement as HTMLElement | null)?.blur?.()
    fireEvent.keyDown(window, { key: 'a', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    fireEvent.keyDown(window, { key: 's', altKey: true })

    expect(
      calls.some(
        (c) =>
          c.url.includes('/api/tasks/transition') ||
          c.url.includes('/api/tasks/marks') ||
          c.url.includes('/api/tasks/dispatch'),
      ),
    ).toBe(false)

    // 2. Press A -> approves Draft to Ready
    fireEvent.keyDown(window, { key: 'a' })
    await waitFor(() => {
      expect(
        calls.some((c) => c.url.includes('/api/tasks/transition') && c.body?.taskId === 't-draft' && c.body?.subPhase === 'ready'),
      ).toBe(true)
      expect(within(drawer).queryByTestId('draft-banner')).not.toBeInTheDocument()
    })

    // 3. Press F -> toggles Today's Focus pin on/off
    fireEvent.keyDown(window, { key: 'f' })
    await waitFor(() => {
      expect(
        calls.some((c) => c.url.includes('/api/tasks/marks') && c.body?.taskId === 't-draft' && c.body?.pin === true),
      ).toBe(true)
      expect(within(drawer).getByRole('button', { name: /Unstar|取消星标/i })).toBeInTheDocument()
    })
    fireEvent.keyDown(window, { key: 'f' })
    await waitFor(() => {
      expect(
        calls.some((c) => c.url.includes('/api/tasks/marks') && c.body?.taskId === 't-draft' && c.body?.pin === false),
      ).toBe(true)
      expect(within(drawer).getByRole('button', { name: /^Star$|^星标置顶$/i })).toBeInTheDocument()
    })

    // 4. Press S -> quick snooze (+2h), then press S again -> unsnooze (null)
    fireEvent.keyDown(window, { key: 's' })
    await waitFor(() => {
      expect(
        calls.some(
          (c) =>
            c.url.includes('/api/tasks/marks') &&
            c.body?.taskId === 't-draft' &&
            typeof c.body?.snoozeUntil === 'number',
        ),
      ).toBe(true)
      expect(within(drawer).getByTestId('detail-snooze-btn')).toHaveClass('is-snoozed')
    })
    fireEvent.keyDown(window, { key: 's' })
    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.url.includes('/api/tasks/marks') && c.body?.taskId === 't-draft' && c.body?.snoozeUntil === null,
        ),
      ).toBe(true)
      expect(within(drawer).getByTestId('detail-snooze-btn')).not.toHaveClass('is-snoozed')
    })

    // 5. Press D -> opens dispatch confirmation dialog, Escape cancels, D + Enter dispatches
    fireEvent.keyDown(window, { key: 'd' })
    const confirmDlg = await screen.findByTestId('dispatch-confirm-dialog')
    expect(confirmDlg).toHaveTextContent('AI Draft Shortcut Task')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('dispatch-confirm-dialog')).not.toBeInTheDocument())
    expect(calls.some((c) => c.url.includes('/api/tasks/dispatch'))).toBe(false)

    fireEvent.keyDown(window, { key: 'd' })
    await screen.findByTestId('dispatch-confirm-dialog')
    fireEvent.keyDown(window, { key: 'Enter' })
    await waitFor(() => {
      expect(
        calls.some((c) => c.url.includes('/api/tasks/dispatch') && c.body?.taskId === 't-draft'),
      ).toBe(true)
    })
  })

  it('supports A/F/S/D shortcuts when selecting a task in ListView and surfaces quick Worktree Diff + conversation search', async () => {
    const snap = buildShortcutSnapshot()
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = []

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      calls.push({ url, body })

      if (url.includes('/api/revision')) {
        return new Response(JSON.stringify({ revision: snap.revision, serverTime: snap.serverTime }), { status: 200 })
      }
      if (url.includes('/api/snapshot')) {
        return new Response(JSON.stringify(snap), { status: 200 })
      }
      if (url.includes('/api/tasks/get')) {
        const id = new URL(url, 'http://localhost').searchParams.get('taskId') ?? ''
        const task = snap.tasks.find((t) => t.id === id)
        return new Response(JSON.stringify({ task, events: [] }), { status: 200 })
      }
      if (url.includes('/api/tasks/worktree/diff')) {
        return new Response(
          JSON.stringify({
            ok: true,
            branch: 'agy-board/t-review-wt',
            status: 'M src/client/App.tsx',
            diff: '+export const reviewed = true',
            hasChanges: true,
            truncated: false,
          }),
          { status: 200 },
        )
      }
      if (url.includes('/api/conversations')) {
        const parsed = new URL(url, 'http://localhost')
        const q = parsed.searchParams.get('query') ?? ''
        const limit = Number(parsed.searchParams.get('limit') ?? '100')
        if (q === 'legacy') {
          return new Response(
            JSON.stringify({
              available: true,
              hasMore: false,
              conversations: [
                {
                  conversationId: 'conv-legacy-999',
                  title: 'Legacy Auth Migration',
                  preview: 'old decision',
                  projectId: 'ws-1',
                  workspacePaths: ['E:\\workspace\\agy-board'],
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  isIdle: true,
                  stepCount: 12,
                  lastModifiedAt: Date.now() - 86_400_000 * 30,
                },
              ],
            }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify({
            available: true,
            hasMore: limit < 200,
            conversations: [
              ...snap.recentConversations,
              ...(limit >= 200
                ? [
                    {
                      conversationId: 'conv-page-2',
                      title: 'Older Page 2 Chat',
                      preview: 'loaded more',
                      projectId: 'ws-1',
                      workspacePaths: ['E:\\workspace\\agy-board'],
                      status: 'CASCADE_RUN_STATUS_IDLE',
                      isIdle: true,
                      stepCount: 5,
                      lastModifiedAt: Date.now() - 86_400_000 * 10,
                    },
                  ]
                : []),
            ],
          }),
          { status: 200 },
        )
      }
      if (url.includes('/api/tasks/marks')) {
        const t = snap.tasks.find((item) => item.id === body?.taskId)!
        if (body?.pin !== undefined) {
          t.userMarks = { taskId: t.id, updatedAt: Date.now(), pinnedAt: body.pin ? Date.now() : undefined }
        }
        return new Response(JSON.stringify({ ok: true, task: t }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch

    render(<App initialSnapshot={snap} />)

    // Switch to ListView and verify shortcut hint bar
    fireEvent.click(screen.getByRole('button', { name: /List|列表/i }))
    const listView = screen.getByTestId('list-view')
    expect(within(listView).getByTestId('list-shortcut-hints')).toBeInTheDocument()

    // Select first task via ArrowDown in Master Pane -> press F to pin
    const masterPane = within(listView).getByTestId('list-master-pane')
    masterPane.focus()
    fireEvent.keyDown(masterPane, { key: 'ArrowDown' })
    expect(within(listView).getByTestId('task-card-t-draft')).toHaveClass('is-selected')

    fireEvent.keyDown(window, { key: 'f' })
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/tasks/marks') && c.body?.taskId === 't-draft' && c.body?.pin === true)).toBe(true)
    })

    // Select worktree review task -> click quick Worktree Diff button directly in status banner
    fireEvent.click(within(listView).getByTestId('task-card-t-review-wt'))
    const diffBtn = await within(listView).findByTestId('review-worktree-diff-btn')
    fireEvent.click(diffBtn)
    const diffBox = await within(listView).findByTestId('quick-worktree-diff-box')
    expect(diffBox).toHaveTextContent('M src/client/App.tsx')
    fireEvent.click(within(diffBox).getByRole('button', { name: /Show Patch|展开 Patch/i }))
    expect(diffBox).toHaveTextContent('+export const reviewed = true')

    // Switch to Agent Control tab -> verify workspace conversation load-more & search
    fireEvent.click(within(listView).getByRole('tab', { name: /Agent Control|Agent 控制面/i }))
    const loadMoreBtn = await within(listView).findByTestId('conv-load-more-btn')
    fireEvent.click(loadMoreBtn)
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/conversations') && c.url.includes('limit=200'))).toBe(true)
    })
    expect(within(listView).getByText(/Older Page 2 Chat/)).toBeInTheDocument()

    const convSearchInput = within(listView).getByTestId('conv-search-input')
    fireEvent.change(convSearchInput, { target: { value: 'legacy' } })
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/conversations') && c.url.includes('query=legacy'))).toBe(true)
    })
    await waitFor(() => {
      expect(within(listView).getByText(/Legacy Auth Migration/)).toBeInTheDocument()
    })
  })
})
