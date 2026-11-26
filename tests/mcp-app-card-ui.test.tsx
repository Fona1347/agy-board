// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/client/App.tsx'
import type { BoardSnapshot, TaskRecord } from '../src/core/types.ts'
import { createCardAppController, type CardTask, type ToolResultLike } from '../src/mcp-app/card-ui.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  delete window.sidecar
  window.history.replaceState(null, '', '/')
  try {
    globalThis.localStorage?.clear()
    globalThis.sessionStorage?.clear()
  } catch {
    // ignore
  }
})

function makeCardTask(overrides: Partial<CardTask> = {}): CardTask {
  return {
    id: 'task-card-1',
    title: 'Upgrade MCP App Card',
    description: 'Concise brief for inline card.',
    userNotes: 'Human override: keep draft approval gated.',
    prompt: '## Plan\n1. Register board_create UI\n2. Add focus signal',
    phase: 'todo',
    subPhase: 'draft',
    priority: 'high',
    workspaceId: 'ws-board',
    workspacePath: 'E:\\Projects\\agy-board',
    workspaceLabel: 'agy-board',
    nextAction: 'Review draft in sidebar',
    writeGate: 'unlocked',
    planRevision: 2,
    tags: [{ name: 'mcp-app' }],
    subgoals: [
      { id: 'sg-1', title: 'Attach resourceUri', required: true, status: 'open' },
      { id: 'sg-2', title: 'Add tests', required: true, status: 'done' },
    ],
    subgoalRollup: { total: 2, done: 1, requiredTotal: 2, requiredDone: 1 },
    refs: [{ kind: 'file', target: 'src/entry/mcp.ts', label: 'MCP Entry' }],
    ...overrides,
  }
}

function makeBoardSnapshot(tasks: TaskRecord[]): BoardSnapshot {
  const now = Date.now()
  return {
    revision: 1,
    serverTime: now,
    timeZone: 'Asia/Shanghai',
    sessionDefaultPermission: 'read-only',
    maxConcurrentLaunches: 3,
    workspaces: [
      {
        id: 'ws-board',
        name: 'agy-board',
        rootPath: 'E:\\Projects\\agy-board',
        folderPaths: ['E:\\Projects\\agy-board'],
        antigravityProjectId: 'ws-board',
        source: 'antigravity',
        createdAt: now - 10_000,
      },
    ],
    activeWorkspacePaths: ['E:\\Projects\\agy-board'],
    activeProjectId: 'ws-board',
    recentConversations: [],
    counts: {
      needs_you: 0,
      active: 0,
      on_hold: 0,
      todo: tasks.length,
      closed: 0,
      archived: 0,
      dueReminders: 0,
    },
    tasks,
  }
}

function makeDomainTask(id: string, title: string): TaskRecord {
  const now = Date.now()
  return {
    id,
    title,
    description: `Brief for ${title}`,
    userNotes: '',
    prompt: `Contract for ${title}`,
    phase: 'todo',
    subPhase: 'ready',
    status: 'pending',
    priority: 'normal',
    workspaceId: 'ws-board',
    workspacePath: 'E:\\Projects\\agy-board',
    workspaceLabel: 'agy-board',
    sortOrder: 0,
    writeGate: 'unlocked',
    reuseSession: true,
    tags: [],
    planRevision: 1,
    createdAt: now - 5000,
    updatedAt: now - 1000,
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
    comments: [],
  }
}

describe('MCP App interactive card UI (card-ui.ts)', () => {
  it('renders 3-layer card, blocks draft dispatch, routes draft review to board focus (never board_transition), and supports inline edits & subgoals', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)

    let current = makeCardTask()
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>): Promise<ToolResultLike> => {
      calls.push({ name, args })
      if (name === 'board_update') {
        current = {
          ...current,
          title: (args.title as string) ?? current.title,
          description: (args.description as string) ?? current.description,
          nextAction: args.nextAction === null ? undefined : ((args.nextAction as string) ?? current.nextAction),
          prompt: (args.prompt as string) ?? current.prompt,
          priority: (args.priority as CardTask['priority']) ?? current.priority,
        }
        return { structuredContent: { ok: true, task: current } }
      }
      if (name === 'board_subgoal_update') {
        if (!args.subgoalId) {
          const added = {
            id: 'sg-3',
            title: String(args.title),
            required: args.required !== false,
            status: 'open' as const,
          }
          current = {
            ...current,
            subgoals: [...(current.subgoals ?? []), added],
            subgoalRollup: { total: 3, done: 1, requiredTotal: 3, requiredDone: 1 },
          }
        } else {
          current = {
            ...current,
            subgoals: (current.subgoals ?? []).map((s) =>
              s.id === args.subgoalId
                ? {
                    ...s,
                    status: (args.status as typeof s.status) ?? s.status,
                    required: args.required !== undefined ? Boolean(args.required) : s.required,
                  }
                : s,
            ),
            subgoalRollup: { total: 2, done: 2, requiredTotal: 2, requiredDone: 2 },
          }
        }
        return { structuredContent: { ok: true, task: current } }
      }
      if (name === 'board_card') {
        return {
          structuredContent: {
            ok: true,
            task: current,
            focusRequest: { taskId: current.id, nonce: 'n-1', ts: Date.now() },
          },
        }
      }
      return { structuredContent: { ok: true, task: current } }
    })

    const controller = createCardAppController({ root, callTool, locale: 'zh' })
    controller.handleToolResult({ structuredContent: { ok: true, task: current } })

    // 3-layer separation visible: Brief + read-only Human Notes + expandable Contract
    expect(root.textContent).toContain('Upgrade MCP App Card')
    expect(root.textContent).toContain('Concise brief for inline card.')
    expect(root.querySelector('[data-testid="human-notes-box"]')?.textContent).toContain(
      'Human override: keep draft approval gated.',
    )
    expect(root.querySelector('[data-testid="details-panel"]')).toBeNull()

    // Expand details reveals Execution Contract + Refs
    fireEvent.click(root.querySelector('[data-action="toggle-details"]')!)
    expect(root.querySelector('[data-testid="details-panel"]')?.textContent).toContain('Register board_create UI')
    expect(root.querySelector('[data-testid="details-panel"]')?.textContent).toContain('src/entry/mcp.ts')

    // Draft task: Dispatch button disabled; Review-in-Board triggers focus (NEVER board_transition)
    const dispatchBtn = root.querySelector('[data-action="dispatch"]') as HTMLButtonElement
    expect(dispatchBtn.disabled).toBe(true)

    fireEvent.click(root.querySelector('[data-action="review-draft"]')!)
    await waitFor(() => {
      expect(calls.some((c) => c.name === 'board_card' && c.args.focusInBoard === true)).toBe(true)
    })
    expect(calls.some((c) => c.name === 'board_transition')).toBe(false)
    expect(root.querySelector('[data-testid="card-feedback"]')?.textContent).toContain('审校通过 → Ready')

    // Inline priority selector saves via board_update
    const prioSelect = root.querySelector('.prio-select') as HTMLSelectElement
    fireEvent.change(prioSelect, { target: { value: 'urgent' } })
    await waitFor(() => {
      expect(calls.some((c) => c.name === 'board_update' && c.args.priority === 'urgent')).toBe(true)
    })

    // Inline edit form updates title/brief/prompt via board_update
    fireEvent.click(root.querySelector('[data-action="toggle-edit"]')!)
    const form = root.querySelector('[data-testid="inline-edit-form"]')!
    fireEvent.input(form.querySelector('input[name="title"]')!, { target: { value: 'Renamed Card Title' } })
    fireEvent.input(form.querySelector('textarea[name="description"]')!, {
      target: { value: 'Updated concise brief.' },
    })
    fireEvent.click(form.querySelector('[data-action="save-edit"]')!)
    await waitFor(() => {
      expect(
        calls.some(
          (c) =>
            c.name === 'board_update' &&
            c.args.title === 'Renamed Card Title' &&
            c.args.description === 'Updated concise brief.',
        ),
      ).toBe(true)
    })
    expect(root.textContent).toContain('Renamed Card Title')

    // Subgoal checkbox toggles done via board_subgoal_update
    const sgCheckbox = root.querySelector('input.sg-check[aria-label="Attach resourceUri"]') as HTMLInputElement
    fireEvent.click(sgCheckbox)
    await waitFor(() => {
      expect(
        calls.some((c) => c.name === 'board_subgoal_update' && c.args.subgoalId === 'sg-1' && c.args.status === 'done'),
      ).toBe(true)
    })

    // Quick add subgoal via input + button
    const addInput = root.querySelector('.sg-add-row input') as HTMLInputElement
    fireEvent.input(addInput, { target: { value: 'Verify build bundle' } })
    fireEvent.click(root.querySelector('[data-action="add-subgoal"]')!)
    await waitFor(() => {
      expect(
        calls.some((c) => c.name === 'board_subgoal_update' && c.args.title === 'Verify build bundle'),
      ).toBe(true)
    })

    root.remove()
  })

  it('enables one-click Dispatch for approved Ready tasks and supports list-to-detail drill-down', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)

    const readyTask = makeCardTask({
      id: 'task-ready-1',
      title: 'Ready To Dispatch',
      phase: 'todo',
      subPhase: 'ready',
      userNotes: '',
    })

    const callTool = vi.fn(async (name: string, args: Record<string, unknown>): Promise<ToolResultLike> => {
      if (name === 'board_get' && args.taskId === 'task-ready-1') {
        return { structuredContent: { ok: true, task: readyTask } }
      }
      if (name === 'board_dispatch' && args.taskId === 'task-ready-1') {
        return {
          structuredContent: {
            ok: true,
            conversationId: 'conv-abc123456789',
            task: { ...readyTask, phase: 'active', subPhase: 'running' },
          },
        }
      }
      return { structuredContent: { ok: true } }
    })

    const controller = createCardAppController({ root, callTool, locale: 'en' })
    controller.handlePayload({
      total: 1,
      counts: { needs_you: 0, active: 0, todo: 1, closed: 0 },
      tasks: [readyTask],
    })

    // Click row title to drill down into single interactive card
    fireEvent.click(root.querySelector('.list-title-btn')!)
    await waitFor(() => {
      expect(root.querySelector('[data-action="dispatch"]')).not.toBeNull()
    })

    const dispatchBtn = root.querySelector('[data-action="dispatch"]') as HTMLButtonElement
    expect(dispatchBtn.disabled).toBe(false)
    fireEvent.click(dispatchBtn)

    await waitFor(() => {
      expect(callTool).toHaveBeenCalledWith('board_dispatch', { taskId: 'task-ready-1', mode: 'auto' })
    })
    expect(root.querySelector('[data-testid="card-feedback"]')?.textContent).toContain('conv-abc')

    root.remove()
  })
})

describe('Right-hand Board App.tsx precision focus (?taskId= & polled board_meta focus)', () => {
  it('opens TaskDetailDrawer automatically from initial URL ?taskId= parameter', async () => {
    const target = makeDomainTask('t-url-focus', 'URL Focused Task')
    const other = makeDomainTask('t-other', 'Other Task')
    const snap = makeBoardSnapshot([other, target])

    window.history.replaceState(null, '', '/?taskId=t-url-focus')

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/tasks/get')) {
        return new Response(JSON.stringify({ task: target, events: [] }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch

    render(<App initialSnapshot={snap} />)

    await waitFor(() => {
      // TaskDetailDrawer renders the task title in an input or heading inside the drawer
      expect(screen.getByDisplayValue('URL Focused Task')).toBeInTheDocument()
    })
  })

  it('opens TaskDetailDrawer in Sidecar polling mode when /api/revision returns a fresh focus signal and ignores stale ones', async () => {
    const t1 = makeDomainTask('t-poll-1', 'Polled Focus Target')
    const t2 = makeDomainTask('t-poll-2', 'Stale Focus Target')
    const snap = makeBoardSnapshot([t1, t2])
    const now = Date.now()

    let revisionResponse: {
      revision: number
      serverTime: number
      hostTheme: 'dark'
      focus: { taskId: string; nonce: string; ts: number } | null
    } = {
      revision: 1,
      serverTime: now,
      hostTheme: 'dark',
      // Fresh focus signal (2s old)
      focus: { taskId: 't-poll-1', nonce: 'nonce-fresh-1', ts: now - 2000 },
    }

    window.sidecar = {
      fetch: vi.fn(async (url: string) => {
        if (url.startsWith('/api/snapshot')) {
          return new Response(JSON.stringify(snap), { status: 200 })
        }
        if (url.startsWith('/api/revision')) {
          return new Response(JSON.stringify(revisionResponse), { status: 200 })
        }
        if (url.startsWith('/api/tasks/get')) {
          return new Response(JSON.stringify({ task: t1, events: [] }), { status: 200 })
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }),
      getWorkspaceUris: vi.fn(async () => []),
      onWorkspaceChange: vi.fn(() => () => {}),
    }

    render(<App />)

    await waitFor(() => {
      expect(screen.getByDisplayValue('Polled Focus Target')).toBeInTheDocument()
    })

    // Unmount and re-mount with a STALE (>30s old) focus signal -> must NOT open drawer
    cleanup()
    globalThis.sessionStorage.clear()
    revisionResponse = {
      revision: 1,
      serverTime: now,
      hostTheme: 'dark',
      focus: { taskId: 't-poll-2', nonce: 'nonce-stale-2', ts: now - 120_000 },
    }

    render(<App />)
    await waitFor(() => {
      expect(screen.getByText('Stale Focus Target')).toBeInTheDocument()
    })
    expect(screen.queryByDisplayValue('Stale Focus Target')).not.toBeInTheDocument()
  })
})
