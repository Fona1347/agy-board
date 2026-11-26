import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MCP_APP_CARD_URI,
  MCP_APP_MIME_TYPE,
  createBoardMcpServer,
  renderMcpAppCardHtml,
} from '../src/entry/mcp.ts'
import { startStandaloneServer, type StandaloneServerHandle } from '../src/entry/sidecar.ts'
import {
  BoardDatabase,
  BoardService,
  FOCUS_REQUEST_META_KEY,
  resolveHostPaths,
} from '../src/host/index.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const MCP_BUNDLE = join(REPO_ROOT, 'dist', 'mcp.mjs')

describe('MCP App interactive card, board_create UI attachment, and cross-process board focus', () => {
  let tmpRoot: string
  let dbPath: string
  let geminiConfigDir: string
  let agyDataDir: string
  let wsDir: string
  let serverHandle: StandaloneServerHandle | undefined

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'agy-board-mcp-card-'))
    dbPath = join(tmpRoot, 'board.db')
    geminiConfigDir = join(tmpRoot, 'gemini-config')
    agyDataDir = join(tmpRoot, 'gemini-antigravity')
    wsDir = join(tmpRoot, 'sample-ws')
    mkdirSync(join(geminiConfigDir, 'projects'), { recursive: true })
    mkdirSync(agyDataDir, { recursive: true })
    mkdirSync(wsDir, { recursive: true })

    writeFileSync(
      join(geminiConfigDir, 'projects', 'ws-card.json'),
      JSON.stringify({
        id: 'ws-card',
        name: 'Card Workspace',
        projectResources: { resources: [{ folderUri: `file:///${wsDir.replace(/\\/g, '/')}` }] },
      }),
    )
  })

  afterEach(async () => {
    if (serverHandle) {
      await serverHandle.close()
      serverHandle = undefined
    }
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('attaches ui://agy-board/card.html to board_create with structured task payload and preserves draft human gate', async () => {
    const paths = resolveHostPaths({ dbPath, geminiConfigDir, antigravityDataDir: agyDataDir })
    const db = new BoardDatabase(paths.dbPath)
    const service = new BoardService(db, paths)
    const mcpServer = createBoardMcpServer(service)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-card-client', version: '1.0.0' })

    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)])

    try {
      const listed = await client.listTools()
      expect(listed.tools).toHaveLength(15)

      for (const name of ['board_create', 'board_get', 'board_card', 'board_list']) {
        const def = listed.tools.find((t) => t.name === name)
        expect((def?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri).toBe(
          MCP_APP_CARD_URI,
        )
      }

      const created = await client.callTool({
        name: 'board_create',
        arguments: {
          title: 'Draft Card With Contract',
          description: 'Concise brief shown directly on the card.',
          prompt: '## Execution Contract\n1. Step one\n2. Step two',
          workspaceId: 'ws-card',
          priority: 'high',
          subgoals: [{ id: 'sg-a', title: 'Acceptance check', required: true }],
          refs: [{ kind: 'file', target: 'README.md', label: 'Readme' }],
        },
      })

      expect(created.isError).not.toBe(true)
      const contentJson = JSON.parse((created.content as Array<{ text: string }>)[0].text)
      expect(contentJson.ok).toBe(true)
      expect(contentJson.task.title).toBe('Draft Card With Contract')
      expect(contentJson.fullTask.phase).toBe('todo')
      expect(contentJson.fullTask.subPhase).toBe('draft')

      const structured = created.structuredContent as {
        ok: boolean
        task: {
          id: string
          title: string
          description: string
          prompt: string
          userNotes: string
          phase: string
          subPhase: string
          subgoals: Array<{ id: string; title: string }>
          refs: Array<{ target: string }>
        }
      }
      expect(structured.ok).toBe(true)
      expect(structured.task.description).toBe('Concise brief shown directly on the card.')
      expect(structured.task.prompt).toContain('Execution Contract')
      expect(structured.task.userNotes).toBe('')
      expect(structured.task.phase).toBe('todo')
      expect(structured.task.subPhase).toBe('draft')
      expect(structured.task.subgoals).toHaveLength(1)
      expect(structured.task.refs).toHaveLength(1)

      const taskId = structured.task.id

      // Human gate MUST remain enforced over MCP (explicit ready, backlog, or implicit todo)
      for (const badArgs of [
        { taskId, action: 'phase', phase: 'todo', subPhase: 'ready' },
        { taskId, action: 'phase', phase: 'todo', subPhase: 'backlog' },
        { taskId, action: 'phase', phase: 'todo' },
      ]) {
        const denied = await client.callTool({ name: 'board_transition', arguments: badArgs })
        expect(denied.isError).toBe(true)
        const errPayload = JSON.parse((denied.content as Array<{ text: string }>)[0].text)
        expect(errPayload.error).toContain('Draft approval is a human gate')
      }

      // Human-exclusive userNotes written from UI shows up in board_get structuredContent
      service.updateTask(taskId, { userNotes: 'Must keep strict CSP compliance.' }, 'ui')
      const got = await client.callTool({ name: 'board_get', arguments: { taskId } })
      const gotStructured = got.structuredContent as { task: { userNotes: string } }
      expect(gotStructured.task.userNotes).toBe('Must keep strict CSP compliance.')

      // Verify board_update & board_subgoal_update also return fresh structuredContent.task
      const updated = await client.callTool({
        name: 'board_update',
        arguments: { taskId, priority: 'urgent', nextAction: 'Review in board' },
      })
      const updStructured = updated.structuredContent as { task: { priority: string; nextAction: string } }
      expect(updStructured.task.priority).toBe('urgent')
      expect(updStructured.task.nextAction).toBe('Review in board')

      const sgUpdated = await client.callTool({
        name: 'board_subgoal_update',
        arguments: { taskId, subgoalId: 'sg-a', status: 'done' },
      })
      const sgStructured = sgUpdated.structuredContent as { task: { subgoalRollup: { done: number } } }
      expect(sgStructured.task.subgoalRollup.done).toBe(1)

      // Verify no new DB migration was added (stays at v5, uses board_meta KV)
      const maxMig = db.db
        .prepare('SELECT MAX(version) as v FROM schema_migrations')
        .get() as { v: number }
      expect(maxMig.v).toBe(5)
    } finally {
      await client.close()
      await mcpServer.close()
      db.close()
    }
  })

  it('serves bundled @modelcontextprotocol/ext-apps HTML resource from renderMcpAppCardHtml and dist/mcp.mjs', async () => {
    const html = renderMcpAppCardHtml()
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('--color-background-primary')
    expect(html).toContain('ui/initialize')
    expect(html).toContain('board_card')
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(2 * 1024 * 1024)

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_BUNDLE],
      env: {
        ...process.env,
        AGY_BOARD_DB_PATH: dbPath,
        AGY_BOARD_GEMINI_CONFIG_DIR: geminiConfigDir,
        AGY_BOARD_ANTIGRAVITY_DATA_DIR: agyDataDir,
      } as Record<string, string>,
    })
    const client = new Client({ name: 'vitest-card-stdio', version: '1.0.0' })
    await client.connect(transport)

    try {
      const listed = await client.listTools()
      const createDef = listed.tools.find((t) => t.name === 'board_create')
      expect((createDef?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri).toBe(
        MCP_APP_CARD_URI,
      )

      const res = await client.readResource({ uri: MCP_APP_CARD_URI })
      expect(res.contents).toHaveLength(1)
      expect(res.contents[0].mimeType).toBe(MCP_APP_MIME_TYPE)
      const text = (res.contents[0] as { text?: string }).text ?? ''
      expect(text).toContain('ui/initialize')
      expect(text).toContain('agy-board-card')
      expect(text).toContain('--color-background-secondary')
    } finally {
      await client.close()
    }
  })

  it('propagates cross-process focus_request from MCP board_card through board_meta to /api/revision and SSE', async () => {
    // 1. Start standalone HTTP server (process/connection A)
    serverHandle = await startStandaloneServer({
      port: 0,
      paths: { dbPath, geminiConfigDir, antigravityDataDir: agyDataDir },
    })

    // 2. Connect compiled stdio MCP server (separate OS process B!) pointing to the SAME SQLite dbPath
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_BUNDLE],
      env: {
        ...process.env,
        AGY_BOARD_DB_PATH: dbPath,
        AGY_BOARD_GEMINI_CONFIG_DIR: geminiConfigDir,
        AGY_BOARD_ANTIGRAVITY_DATA_DIR: agyDataDir,
      } as Record<string, string>,
    })
    const client = new Client({ name: 'vitest-focus-stdio', version: '1.0.0' })
    await client.connect(transport)

    try {
      const created = await client.callTool({
        name: 'board_create',
        arguments: { title: 'Cross-Process Focus Target', workspaceId: 'ws-card' },
      })
      const taskId = (created.structuredContent as { task: { id: string } }).task.id

      // Open SSE stream before triggering focus
      const sseAbort = new AbortController()
      const sseRes = await fetch(`${serverHandle.url}/api/events`, { signal: sseAbort.signal })
      expect(sseRes.status).toBe(200)
      const reader = sseRes.body!.getReader()
      await reader.read() // initial revision chunk

      // Trigger focus from the separate MCP stdio process!
      const focusRes = await client.callTool({
        name: 'board_card',
        arguments: { taskId, focusInBoard: true },
      })
      expect(focusRes.isError).not.toBe(true)
      const focusPayload = focusRes.structuredContent as {
        ok: boolean
        sidecarUri: string
        focusRequest: { taskId: string; nonce: string; ts: number }
      }
      expect(focusPayload.ok).toBe(true)
      expect(focusPayload.sidecarUri).toBe('sidecar://agy-board/board/')
      expect(focusPayload.focusRequest.taskId).toBe(taskId)
      expect(focusPayload.focusRequest.nonce).toBeTruthy()

      // Verify /api/revision immediately exposes the cross-process board_meta focus signal
      const revRes = await fetch(`${serverHandle.url}/api/revision`)
      expect(revRes.status).toBe(200)
      const revJson = (await revRes.json()) as {
        revision: number
        serverTime: number
        focus: { taskId: string; nonce: string; ts: number } | null
      }
      expect(revJson.focus).toEqual(focusPayload.focusRequest)

      // Verify persisted in board_meta KV
      const row = serverHandle.service.db.db
        .prepare('SELECT value FROM board_meta WHERE key = ?')
        .get(FOCUS_REQUEST_META_KEY) as { value?: string } | undefined
      expect(row?.value).toBeTruthy()
      expect(JSON.parse(row!.value!)).toEqual(focusPayload.focusRequest)

      // Verify Standalone SSE also broadcasts `event: focus` within ~1.5s
      let receivedFocusEvent = false
      const deadline = Date.now() + 3000
      while (!receivedFocusEvent && Date.now() < deadline) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((r) =>
            setTimeout(() => r({ done: true, value: undefined }), 1800),
          ),
        ])
        if (chunk.done || !chunk.value) break
        const text = Buffer.from(chunk.value).toString('utf8')
        if (text.includes('event: focus') && text.includes(taskId)) {
          receivedFocusEvent = true
        }
      }
      sseAbort.abort()
      expect(receivedFocusEvent).toBe(true)

      // Also verify POST /api/tasks/focus works directly and returns 404 for missing tasks
      const httpFocus = await fetch(`${serverHandle.url}/api/tasks/focus`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      })
      expect(httpFocus.status).toBe(200)
      const httpFocusJson = (await httpFocus.json()) as {
        ok: boolean
        focus: { taskId: string; nonce: string }
      }
      expect(httpFocusJson.ok).toBe(true)
      expect(httpFocusJson.focus.taskId).toBe(taskId)
      expect(httpFocusJson.focus.nonce).not.toBe(focusPayload.focusRequest.nonce)

      const missingFocus = await fetch(`${serverHandle.url}/api/tasks/focus`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: 'does-not-exist' }),
      })
      expect(missingFocus.status).toBe(404)
    } finally {
      await client.close()
    }
  })

  it('documents sidecar:// navigation pill and precision focus guidance in skills/agy-board/SKILL.md', () => {
    const skillMd = readFileSync(join(REPO_ROOT, 'skills', 'agy-board', 'SKILL.md'), 'utf8')
    expect(skillMd).toContain('[Agy Board](sidecar://agy-board/board/)')
    expect(skillMd).toContain('focusInBoard')
    expect(skillMd).toContain('?taskId=')
    expect(skillMd).toContain('审校通过 → Ready')
  })
})
