import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildBoardApiRoutes } from '../src/entry/router.ts'
import {
  BoardDatabase,
  BoardService,
  fetchPaginatedConversationsFromBridge,
  readRecentConversations,
  resolveHostPaths,
  type AgentBridge,
} from '../src/host/index.ts'

describe('Unbounded workspace conversation history & paginated bridge lookup', () => {
  let tmpRoot: string
  let db: BoardDatabase
  let paths: ReturnType<typeof resolveHostPaths>
  let wsAlphaDir: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'agy-board-convhist-'))
    const geminiConfigDir = join(tmpRoot, 'gemini-config')
    const agyDataDir = join(tmpRoot, 'gemini-antigravity')
    wsAlphaDir = join(tmpRoot, 'repo-alpha')
    mkdirSync(join(geminiConfigDir, 'projects'), { recursive: true })
    mkdirSync(agyDataDir, { recursive: true })
    mkdirSync(wsAlphaDir, { recursive: true })

    writeFileSync(
      join(geminiConfigDir, 'projects', 'proj-alpha.json'),
      JSON.stringify({
        id: 'proj-alpha',
        name: 'Alpha Repo',
        projectResources: {
          resources: [{ folderUri: `file:///${wsAlphaDir.replace(/\\/g, '/')}` }],
        },
      }),
    )

    const sumDb = new DatabaseSync(join(agyDataDir, 'conversation_summaries.db'))
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        preview TEXT NOT NULL DEFAULT '',
        step_count INTEGER NOT NULL DEFAULT 0,
        last_modified_time DATETIME NOT NULL,
        workspace_uris TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL DEFAULT '',
        parent_conversation_id TEXT NOT NULL DEFAULT '',
        killed NUMERIC NOT NULL DEFAULT 0
      );
    `)
    const stmt = sumDb.prepare(
      `INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    // Seed 2 older target-workspace conversations buried beneath 1,200 other-workspace chats
    const oldBase = Date.UTC(2025, 0, 1, 0, 0, 0)
    stmt.run(
      'conv-alpha-oldest',
      'Alpha Legacy Architecture',
      'Deep buried architectural decision',
      18,
      new Date(oldBase).toISOString(),
      JSON.stringify([`file:///${wsAlphaDir.replace(/\\/g, '/')}`]),
      'CASCADE_RUN_STATUS_IDLE',
      'proj-alpha',
    )
    stmt.run(
      'conv-alpha-second',
      'Alpha Recent Cleanup',
      'Second alpha chat',
      7,
      new Date(oldBase + 60_000).toISOString(),
      JSON.stringify([`file:///${wsAlphaDir.replace(/\\/g, '/')}`]),
      'CASCADE_RUN_STATUS_IDLE',
      'proj-alpha',
    )

    const newerBase = Date.UTC(2026, 5, 1, 0, 0, 0)
    for (let i = 0; i < 1200; i += 1) {
      stmt.run(
        `conv-other-${i}`,
        `Other Chat ${i}`,
        'noise',
        1,
        new Date(newerBase + i * 1000).toISOString(),
        JSON.stringify(['file:///e%3A/unrelated/repo']),
        'CASCADE_RUN_STATUS_IDLE',
        'proj-other',
      )
    }
    sumDb.close()

    paths = resolveHostPaths({
      dbPath: join(tmpRoot, 'board.db'),
      geminiConfigDir,
      antigravityDataDir: agyDataDir,
    })
    db = new BoardDatabase(paths.dbPath)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('finds workspace conversations buried past 1,200 newer global rows and supports query/offset pagination', () => {
    // Global default read returns 200 (not truncated at 50) and reports hasMore
    const globalPage1 = readRecentConversations(paths)
    expect(globalPage1.available).toBe(true)
    expect(globalPage1.conversations).toHaveLength(200)
    expect(globalPage1.hasMore).toBe(true)

    // Filtering by workspacePath streams full SQLite history and recovers chats past row #1,200
    const alphaAll = readRecentConversations(paths, { workspacePath: wsAlphaDir, limit: 50 })
    expect(alphaAll.conversations.map((c) => c.conversationId)).toEqual([
      'conv-alpha-second',
      'conv-alpha-oldest',
    ])
    expect(alphaAll.hasMore).toBe(false)

    // Offset & limit pagination across filtered workspace rows
    const alphaPage1 = readRecentConversations(paths, { workspacePath: wsAlphaDir, limit: 1, offset: 0 })
    expect(alphaPage1.conversations.map((c) => c.conversationId)).toEqual(['conv-alpha-second'])
    expect(alphaPage1.hasMore).toBe(true)

    const alphaPage2 = readRecentConversations(paths, { workspacePath: wsAlphaDir, limit: 1, offset: 1 })
    expect(alphaPage2.conversations.map((c) => c.conversationId)).toEqual(['conv-alpha-oldest'])
    expect(alphaPage2.hasMore).toBe(false)

    // Query search matches title/preview across full history
    const queryHit = readRecentConversations(paths, { query: 'Architectural Decision' })
    expect(queryHit.conversations.map((c) => c.conversationId)).toEqual(['conv-alpha-oldest'])
  })

  it('paginates AgentBridge.listConversations past 50 items and integrates with BoardService.queryConversations & /api/conversations', async () => {
    const pages: Record<string, Array<Record<string, unknown>>> = {
      '': Array.from({ length: 45 }, (_, i) => ({
        conversationId: `live-conv-${i}`,
        title: `Live Session ${i}`,
        preview: 'live',
        projectId: 'proj-alpha',
        workspaceUris: [`file:///${wsAlphaDir.replace(/\\/g, '/')}`],
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastModifiedTime: new Date(Date.UTC(2026, 6, 1, 0, 0, 0) - i * 1000).toISOString(),
      })),
      'page-2': Array.from({ length: 45 }, (_, i) => ({
        conversation_id: `live-conv-${45 + i}`,
        title: `Live Session ${45 + i}`,
        summary: i === 44 ? 'Target Deep Live Match' : 'live',
        project_id: 'proj-alpha',
        workspace_uris: [`file:///${wsAlphaDir.replace(/\\/g, '/')}`],
        status: 'CASCADE_RUN_STATUS_IDLE',
        last_modified_time: new Date(Date.UTC(2026, 6, 1, 0, 0, 0) - (45 + i) * 1000).toISOString(),
      })),
    }

    const mockBridge: AgentBridge = {
      async startConversation() {
        return { conversationId: 'conv-1', raw: {} }
      },
      async sendMessage(req) {
        return { conversationId: req.conversationId, raw: {} }
      },
      async getConversationMetadata(id) {
        return { conversationId: id }
      },
      async jumpToConversation(id) {
        return { ok: true, method: 'cdp', conversationId: id }
      },
      async listConversations(req = {}) {
        const token = req.pageToken ?? ''
        return {
          conversations: pages[token] ?? [],
          ...(token === '' ? { nextPageToken: 'page-2' } : {}),
        }
      },
    }

    const paginated = await fetchPaginatedConversationsFromBridge(mockBridge, {
      workspacePath: wsAlphaDir,
      pageSize: 45,
      limit: 100,
    })
    expect(paginated.conversations).toHaveLength(90)
    expect(paginated.conversations.at(-1)?.conversationId).toBe('live-conv-89')

    const service = new BoardService(db, paths, { agentBridge: mockBridge })
    const routes = buildBoardApiRoutes(service)
    const convRoute = routes.find((r) => r.method === 'GET' && r.path === '/api/conversations')!

    const res = (await convRoute.handler({
      workspacePath: wsAlphaDir,
      query: 'Target Deep Live Match',
      includeLive: 'true',
      limit: '20',
    })) as { available: boolean; conversations: Array<{ conversationId: string }> }

    expect(res.available).toBe(true)
    expect(res.conversations.map((c) => c.conversationId)).toEqual(['live-conv-89'])
  })

  it('normalizes Antigravity 2.35+ nested Connect Conversation objects and filters child conversations', async () => {
    const mockBridge: AgentBridge = {
      async startConversation() {
        return { conversationId: 'conv-1', raw: {} }
      },
      async sendMessage(req) {
        return { conversationId: req.conversationId, raw: {} }
      },
      async getConversationMetadata(id) {
        return { conversationId: id }
      },
      async jumpToConversation(id) {
        return { ok: true, method: 'cdp', conversationId: id }
      },
      async listConversations() {
        return {
          conversations: [
            {
              id: 'conv-connect-top',
              metadata: {
                projectId: 'proj-alpha',
                createTime: '2026-11-26T09:00:00Z',
              },
              annotations: {
                title: '[Board] Nested Connect Chat',
                archived: false,
              },
              state: {
                summary: 'Auto summary fallback',
                runState: 'RUN_STATE_IDLE',
                updateTime: '2026-11-26T10:30:00Z',
              },
            },
            {
              id: 'conv-connect-child',
              metadata: {
                projectId: 'proj-alpha',
                parentConversationId: 'conv-connect-top',
              },
              annotations: {
                title: 'Child subagent chat',
              },
              state: {
                runState: 'RUN_STATE_RUNNING',
                updateTime: '2026-11-26T10:35:00Z',
              },
            },
          ],
        }
      },
    }

    const res = await fetchPaginatedConversationsFromBridge(mockBridge, {
      projectId: 'proj-alpha',
      limit: 20,
    })
    expect(res.conversations).toHaveLength(1)
    expect(res.conversations[0]).toMatchObject({
      conversationId: 'conv-connect-top',
      title: '[Board] Nested Connect Chat',
      preview: 'Auto summary fallback',
      projectId: 'proj-alpha',
      status: 'RUN_STATE_IDLE',
      isIdle: true,
      lastModifiedAt: Date.parse('2026-11-26T10:30:00Z'),
    })
  })
})
