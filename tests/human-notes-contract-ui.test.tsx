// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskDetailView } from '../src/client/components/TaskDetailDrawer.tsx'
import { computeSubgoalRollup, type TaskRecord } from '../src/core/index.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function buildRunningTaskWithFreeze(): TaskRecord {
  const now = Date.now()
  return {
    id: 't-split-ui',
    title: 'Split Brief, Human Notes & Contract',
    description:
      'Sentence one explains the legacy long overview. Sentence two adds extra background details. Sentence three continues the explanation. Sentence four exceeds the three-sentence memo threshold and triggers backward-compat folding so humans stay focused.',
    userNotes: 'Keep API backward compatible and never lock this box.',
    prompt: '## Execution Contract\n- Implement migration v5\n- Store per-round dispatch snapshot',
    phase: 'active',
    subPhase: 'running',
    status: 'in_progress',
    priority: 'high',
    workspaceId: 'ws-demo',
    workspacePath: '/workspace/demo-repo',
    workspaceLabel: 'demo-repo',
    sortOrder: 0,
    writeGate: 'unlocked',
    reuseSession: true,
    freeze: {
      goal: 'Ship clean separation',
      progress: 'Backend complete',
      next: 'Verify UI',
      frozenAt: now - 10_000,
    },
    tags: [],
    planRevision: 2,
    createdAt: now - 60_000,
    updatedAt: now - 1_000,
    subgoals: [],
    subgoalRollup: computeSubgoalRollup([]),
    refs: [],
    conversations: [
      {
        taskId: 't-split-ui',
        conversationId: 'conv-run-1',
        role: 'primary',
        linkedAt: now - 5_000,
        isIdle: false,
      },
    ],
    executions: [
      {
        id: 'ex-open-ui',
        taskId: 't-split-ui',
        conversationId: 'conv-run-1',
        startedAt: now - 5_000,
        planRevision: 2,
        contractSnapshot: {
          planRevision: 2,
          capturedAt: now - 5_000,
          title: 'Split Brief, Human Notes & Contract',
          description: 'Snapshot brief',
          userNotes: 'Snapshot human note',
          prompt: 'Snapshot contract plan',
          subgoals: [],
          refs: [],
          dispatchedPrompt: '# Task: Split Brief, Human Notes & Contract',
        },
      },
    ],
    comments: [],
  }
}

describe('TaskDetailView dual-tab separation (Brief / Human Notes / Agent Contract)', () => {
  it('keeps title, brief, human notes, and agent contract editable during active execution with freeze and shows non-blocking next-round hints', async () => {
    const task = buildRunningTaskWithFreeze()
    const updatePatches: Array<Record<string, unknown>> = []
    const toasts: string[] = []

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/tasks/get')) {
        return new Response(JSON.stringify({ task, events: [] }), { status: 200 })
      }
      if (url.includes('/api/tasks/update')) {
        const body = JSON.parse(String(init?.body)) as { taskId: string; patch: Record<string, unknown> }
        updatePatches.push(body.patch)
        if (typeof body.patch.title === 'string') task.title = body.patch.title
        if (typeof body.patch.description === 'string') task.description = body.patch.description
        if (typeof body.patch.userNotes === 'string') task.userNotes = body.patch.userNotes
        if (typeof body.patch.prompt === 'string') task.prompt = body.patch.prompt
        return new Response(JSON.stringify({ ok: true, task }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch

    render(
      <TaskDetailView
        task={task}
        locale="zh"
        workspaces={[]}
        recentConversations={[]}
        sessionDefaultPermission="read-only"
        onClose={() => {}}
        onTaskUpdated={async () => {}}
        onToast={(m) => toasts.push(m)}
      />,
    )

    const drawer = screen.getByTestId('task-detail-drawer')

    // 1. Title is NEVER locked even with openExecution + freeze (no FROZEN / 已锁定 badge)
    const titleInput = within(drawer).getByLabelText('标题') as HTMLInputElement
    expect(titleInput).not.toBeDisabled()
    expect(titleInput.value).toBe('Split Brief, Human Notes & Contract')
    expect(within(drawer).queryByText(/已锁定|FROZEN/)).not.toBeInTheDocument()

    // 2. Tab 1 Zone 1A: Task Brief keeps extractShortMemo folding fallback for legacy long descriptions
    const briefCard = within(drawer).getByTestId('detail-memo-card')
    expect(briefCard).toHaveTextContent('任务简述')
    expect(within(briefCard).getByRole('button', { name: /展开完整备注/ })).toBeInTheDocument()
    expect(within(briefCard).getByRole('button', { name: '编辑' })).toBeInTheDocument()

    // 3. Tab 1 Zone 1B: Human-Exclusive Notes card has ownership pill, non-blocking running hint, and editable textarea
    const humanCard = within(drawer).getByTestId('human-notes-card')
    expect(humanCard).toHaveTextContent('我的备注 / 对齐控制')
    expect(humanCard).toHaveTextContent('仅由你控制，下轮自动生效')
    expect(within(humanCard).getByTestId('human-notes-running-hint')).toHaveTextContent('下轮派发/返工生效')

    const notesInput = within(humanCard).getByTestId('human-notes-input') as HTMLTextAreaElement
    expect(notesInput).not.toBeDisabled()
    expect(notesInput.value).toBe('Keep API backward compatible and never lock this box.')

    fireEvent.change(notesInput, { target: { value: 'Updated human override while AI is running.' } })
    fireEvent.click(within(humanCard).getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(updatePatches).toHaveLength(1)
      expect(updatePatches[0].userNotes).toBe('Updated human override while AI is running.')
      expect(updatePatches[0].title).toBe('Split Brief, Human Notes & Contract')
    })
    expect(toasts.some((t) => t.includes('已保存，将在下轮派发/返工生效'))).toBe(true)

    // 4. Tab 2: Agent Execution Contract card supports Markdown preview, expandable non-blocking edit, and snapshot view
    fireEvent.click(within(drawer).getByRole('tab', { name: /Agent/ }))
    const contractCard = within(drawer).getByTestId('agent-contract-card')
    expect(contractCard).toHaveTextContent('执行合同 / 任务计划 (Contract)')
    expect(contractCard).toHaveTextContent('rev #2')
    expect(contractCard).toHaveTextContent('已含人类覆写备注')
    expect(within(contractCard).getByTestId('contract-running-hint')).toHaveTextContent('下轮派发/返工生效')
    // Starts in Markdown preview mode because prompt is non-empty
    expect(within(contractCard).getByRole('heading', { name: 'Execution Contract' })).toBeInTheDocument()

    // Switch to edit mode & expand editor -> never disabled while running
    fireEvent.click(within(contractCard).getByRole('button', { name: '编辑' }))
    const contractInput = within(contractCard).getByTestId('agent-contract-input') as HTMLTextAreaElement
    expect(contractInput).not.toBeDisabled()
    expect(contractInput.rows).toBe(5)
    fireEvent.click(within(contractCard).getByRole('button', { name: '展开编辑' }))
    expect(contractInput.rows).toBe(12)

    fireEvent.change(contractInput, { target: { value: '## Contract v3\n- Ship cleanly' } })
    fireEvent.click(within(contractCard).getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(updatePatches).toHaveLength(2)
      expect(updatePatches[1].prompt).toBe('## Contract v3\n- Ship cleanly')
    })

    // Execution history exposes the per-round contract snapshot
    const advFold = within(drawer).getByTestId('advanced-settings-fold') as HTMLDetailsElement
    advFold.open = true
    advFold.querySelectorAll('details').forEach((d) => {
      d.open = true
    })
    expect(drawer).toHaveTextContent('当轮派发合同快照 (rev #2)')
    expect(drawer).toHaveTextContent('Snapshot human note')
  })

  it('preserves dirty title, brief, human notes, and contract drafts across polling updates and resets when switching tasks', async () => {
    const taskV1 = buildRunningTaskWithFreeze()
    taskV1.description = 'Short initial brief.'

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/tasks/get')) {
        return new Response(JSON.stringify({ task: taskV1, events: [] }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch

    const { rerender } = render(
      <TaskDetailView
        task={taskV1}
        locale="zh"
        workspaces={[]}
        recentConversations={[]}
        sessionDefaultPermission="read-only"
        onClose={() => {}}
        onTaskUpdated={async () => {}}
        onToast={() => {}}
      />,
    )

    const drawer = screen.getByTestId('task-detail-drawer')
    const titleInput = within(drawer).getByLabelText('标题') as HTMLInputElement
    expect(titleInput.value).toBe('Split Brief, Human Notes & Contract')
    const briefCard = within(drawer).getByTestId('detail-memo-card')
    fireEvent.click(within(briefCard).getByRole('button', { name: '编辑' }))
    const briefInput = briefCard.querySelector('textarea') as HTMLTextAreaElement
    const notesInput = within(drawer).getByTestId('human-notes-input') as HTMLTextAreaElement

    // Dirty brief, human notes, and agent contract; leave title untouched
    fireEvent.change(briefInput, { target: { value: 'Unsaved brief edit while running' } })
    fireEvent.change(notesInput, { target: { value: 'Unsaved human alignment override' } })

    fireEvent.click(within(drawer).getByRole('tab', { name: /Agent/ }))
    const contractCard = within(drawer).getByTestId('agent-contract-card')
    fireEvent.click(within(contractCard).getByRole('button', { name: '编辑' }))
    const contractInput = within(contractCard).getByTestId('agent-contract-input') as HTMLTextAreaElement
    fireEvent.change(contractInput, { target: { value: '## Unsaved Contract Draft' } })

    // Simulate 1.5s polling refresh triggered by board_ref_add / board_subgoal_update
    const polledTaskV2: TaskRecord = {
      ...taskV1,
      title: 'Server Updated Title From Poll',
      updatedAt: taskV1.updatedAt + 1_500,
      refs: [
        {
          id: 'ref-poll-1',
          taskId: taskV1.id,
          kind: 'file',
          target: 'src/host/board-service.ts',
          addedBy: 'mcp',
          createdAt: taskV1.updatedAt + 1_500,
        },
      ],
    }

    rerender(
      <TaskDetailView
        task={polledTaskV2}
        locale="zh"
        workspaces={[]}
        recentConversations={[]}
        sessionDefaultPermission="read-only"
        onClose={() => {}}
        onTaskUpdated={async () => {}}
        onToast={() => {}}
      />,
    )

    // Untouched title syncs from server, while dirty contract & human notes are preserved
    expect((within(drawer).getByLabelText('标题') as HTMLInputElement).value).toBe('Server Updated Title From Poll')
    expect((within(drawer).getByTestId('agent-contract-input') as HTMLTextAreaElement).value).toBe(
      '## Unsaved Contract Draft',
    )

    fireEvent.click(within(drawer).getByRole('tab', { name: /我的视图/ }))
    expect((within(drawer).getByTestId('human-notes-input') as HTMLTextAreaElement).value).toBe(
      'Unsaved human alignment override',
    )
    expect((within(drawer).getByTestId('detail-memo-card').querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      'Unsaved brief edit while running',
    )

    // Switching to another task resets all drafts cleanly
    const otherTask: TaskRecord = {
      ...buildRunningTaskWithFreeze(),
      id: 't-other-task',
      title: 'Another Task Title',
      description: 'Another task brief',
      userNotes: 'Another task notes',
      prompt: 'Another task contract',
    }

    rerender(
      <TaskDetailView
        task={otherTask}
        locale="zh"
        workspaces={[]}
        recentConversations={[]}
        sessionDefaultPermission="read-only"
        onClose={() => {}}
        onTaskUpdated={async () => {}}
        onToast={() => {}}
      />,
    )

    expect((within(drawer).getByLabelText('标题') as HTMLInputElement).value).toBe('Another Task Title')
    expect((within(drawer).getByTestId('human-notes-input') as HTMLTextAreaElement).value).toBe('Another task notes')
  })
})
