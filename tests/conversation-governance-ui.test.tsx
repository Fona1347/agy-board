// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/client/App.tsx'
import type { BoardSnapshot } from '../src/core/types.ts'

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

function buildSnapshotWithFinishedConversation(): BoardSnapshot {
  const now = Date.now()
  return {
    revision: 1,
    serverTime: now,
    timeZone: 'UTC',
    sessionDefaultPermission: 'read-only',
    maxConcurrentLaunches: 3,
    workspaces: [],
    activeWorkspacePaths: [],
    recentConversations: [],
    counts: { needs_you: 0, active: 0, on_hold: 0, todo: 0, closed: 1, archived: 0, dueReminders: 0 },
    tasks: [
      {
        id: 't-closed-1',
        title: 'Finished Sidebar Task',
        description: '',
        prompt: '',
        phase: 'closed',
        subPhase: 'done',
        status: 'done',
        priority: 'normal',
        sortOrder: 0,
        writeGate: 'unlocked',
        reuseSession: false,
        tags: [],
        planRevision: 0,
        createdAt: now - 3600_000,
        updatedAt: now - 1000,
        completedAt: now - 1000,
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
        conversations: [
          {
            taskId: 't-closed-1',
            conversationId: 'conv-done-1',
            role: 'primary',
            linkedAt: now - 2000,
          },
          {
            taskId: 't-closed-1',
            conversationId: 'conv-origin-1',
            role: 'origin',
            linkedAt: now - 3000,
          },
        ],
        executions: [],
      },
    ],
  }
}

describe('Sidebar governance controls in Filter & Settings popover', () => {
  it('toggles governance preferences and triggers one-click cleanup for finished conversations', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      calls.push({ url, body })
      if (url === '/api/conversations/governance/update') {
        return new Response(
          JSON.stringify({
            ok: true,
            config: {
              autoRename: true,
              titlePrefix: '[Board]',
              autoTag: true,
              autoGroup: false,
              conversationGroupId: 'agy-board',
              autoArchiveOnFinish: true,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url === '/api/conversations/cleanup-finished') {
        return new Response(
          JSON.stringify({
            ok: true,
            available: true,
            dryRun: false,
            scannedTasks: 1,
            candidateCount: 1,
            archivedIds: ['conv-done-1'],
            skippedIds: [],
            failedIds: [],
            errors: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch

    render(<App initialSnapshot={buildSnapshotWithFinishedConversation()} />)

    // Open Filters & Settings popover
    const filterBtn = screen.getByRole('button', { name: /Filters & Settings|筛选与设置/i })
    fireEvent.click(filterBtn)

    const groupToggle = screen.getByTestId('gov-toggle-group')
    expect(groupToggle).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(groupToggle)

    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/conversations/governance/update' && c.body?.autoGroup === false)).toBe(
        true,
      )
      expect(groupToggle).toHaveAttribute('aria-pressed', 'false')
    })

    // Candidate count excludes origin role and includes primary finished chat (1)
    const cleanupBtn = screen.getByTestId('gov-cleanup-finished')
    expect(cleanupBtn.textContent).toContain('(1)')
    fireEvent.click(cleanupBtn)

    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/conversations/cleanup-finished')).toBe(true)
    })
  })
})
