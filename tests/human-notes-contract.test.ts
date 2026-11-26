import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildDispatchPrompt,
  buildReworkPrompt,
  computeSubgoalRollup,
  hasOpenExecution,
  isTaskContentFrozen,
  type TaskRecord,
} from '../src/core/index.ts'
import { createBoardMcpServer } from '../src/entry/mcp.ts'
import {
  BoardDatabase,
  BoardService,
  resolveHostPaths,
  type AgentBridge,
  type HostPaths,
} from '../src/host/index.ts'

function createCaptureBridge() {
  let seq = 0
  const started: Array<{ prompt: string; title?: string }> = []
  const sent: Array<{ conversationId: string; message: string }> = []
  const bridge: AgentBridge = {
    async startConversation(req) {
      seq += 1
      started.push({ prompt: req.prompt, title: req.title })
      return { conversationId: `conv-round-${seq}`, raw: {} }
    },
    async sendMessage(req) {
      sent.push({ conversationId: req.conversationId, message: req.message })
      return { conversationId: req.conversationId, raw: {} }
    },
    async getConversationMetadata(conversationId) {
      return { conversationId, title: `Session ${conversationId}` }
    },
    async jumpToConversation(conversationId) {
      return { ok: true, method: 'cdp', conversationId }
    },
  }
  return { bridge, started, sent }
}

describe('Human Notes, Agent Execution Contract & Dispatch Snapshots', () => {
  let tmpRoot: string
  let paths: HostPaths
  let db: BoardDatabase

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'agy-board-contract-'))
    paths = resolveHostPaths({
      dbPath: join(tmpRoot, 'board-data', 'board.db'),
      geminiConfigDir: join(tmpRoot, 'gemini-config'),
      antigravityDataDir: join(tmpRoot, 'antigravity-data'),
    })
    db = new BoardDatabase(paths.dbPath)
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // ignore if already closed
    }
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('migrates a legacy v4 database to version 5 with user_notes and execution contract snapshot columns', () => {
    const legacyDbPath = join(tmpRoot, 'legacy-v4.db')
    const raw = new DatabaseSync(legacyDbPath)
    raw.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
      CREATE TABLE board_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, root_path TEXT NOT NULL, folder_paths_json TEXT NOT NULL DEFAULT '[]', antigravity_project_id TEXT, source TEXT NOT NULL DEFAULT 'custom', pinned INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL DEFAULT '', phase TEXT NOT NULL DEFAULT 'todo', sub_phase TEXT NOT NULL DEFAULT 'ready', status TEXT NOT NULL DEFAULT 'pending', priority TEXT NOT NULL DEFAULT 'normal', workspace_id TEXT, workspace_path TEXT, workspace_label TEXT, blocked_reason TEXT, next_action TEXT, due_at INTEGER, reminder_at INTEGER, reminded_at INTEGER, sort_order INTEGER NOT NULL DEFAULT 0, write_gate TEXT NOT NULL DEFAULT 'unlocked', mode TEXT, model TEXT, reasoning_effort TEXT, permission TEXT, permission_confirmed_at INTEGER, reuse_session INTEGER NOT NULL DEFAULT 1, freeze_json TEXT, handover_json TEXT, tags_json TEXT NOT NULL DEFAULT '[]', schedule_json TEXT, plan_revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER, archived_at INTEGER, use_worktree INTEGER NOT NULL DEFAULT 0, worktree_path TEXT, worktree_branch TEXT, created_by TEXT NOT NULL DEFAULT 'user', origin_conversation_id TEXT, origin_summary TEXT, discovered_from_task_id TEXT);
      CREATE TABLE task_subgoals (id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'custom', required INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'open', sort_order INTEGER NOT NULL DEFAULT 0, dependencies_json TEXT NOT NULL DEFAULT '[]', added_by TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL, closed_at INTEGER, PRIMARY KEY (task_id, id));
      CREATE TABLE task_refs (id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, subgoal_id TEXT, kind TEXT NOT NULL, target TEXT NOT NULL, label TEXT, round INTEGER, added_by TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL);
      CREATE TABLE task_conversations (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, subgoal_id TEXT NOT NULL DEFAULT '', conversation_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'primary', workspace_id TEXT, linked_at INTEGER NOT NULL, summary TEXT, include_in_handoff INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (task_id, subgoal_id, conversation_id));
      CREATE TABLE task_executions (id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, subgoal_id TEXT, conversation_id TEXT, workspace_id TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, result TEXT, error TEXT, summary TEXT, initiated_by TEXT, rework_instructions TEXT, frozen_at INTEGER);
      CREATE TABLE task_events (id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, subgoal_id TEXT, conversation_id TEXT, kind TEXT NOT NULL, source TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
      CREATE TABLE task_user_marks (task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, ignored_at INTEGER, acked_at INTEGER, pinned_at INTEGER, snoozed_until INTEGER, updated_at INTEGER NOT NULL);
      CREATE TABLE task_comments (id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, author TEXT NOT NULL DEFAULT 'user', body_md TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO schema_migrations (version, name, applied_at) VALUES
        (1, '0001_init_board', 1000),
        (2, '0002_comments_worktree_subgoal_pk', 1000),
        (3, '0003_user_marks_focus_snooze', 1000),
        (4, '0004_draft_origin_handoff_capsule', 1000);
      INSERT INTO tasks (id, title, description, prompt, created_at, updated_at)
      VALUES ('t-v4', 'Legacy v4 Card', 'Short brief', 'Detailed plan', 1000, 1000);
    `)
    raw.close()

    const migrated = new BoardDatabase(legacyDbPath)
    try {
      const m5 = migrated.db
        .prepare('SELECT version, name FROM schema_migrations WHERE version = 5')
        .get() as { version: number; name: string }
      expect(m5).toEqual({ version: 5, name: '0005_human_notes_contract_snapshot' })

      const taskCols = new Set(
        (migrated.db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name),
      )
      expect(taskCols.has('user_notes')).toBe(true)

      const execCols = new Set(
        (migrated.db.prepare('PRAGMA table_info(task_executions)').all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      )
      expect(execCols.has('plan_revision')).toBe(true)
      expect(execCols.has('contract_snapshot_json')).toBe(true)

      const hydrated = migrated.getTask('t-v4')!
      expect(hydrated.userNotes).toBe('')
      expect(hydrated.description).toBe('Short brief')
      expect(hydrated.prompt).toBe('Detailed plan')
    } finally {
      migrated.close()
    }
  })

  it('never blocks edits during active execution or with freeze, protects userNotes from AI/MCP, and snapshots each dispatch', async () => {
    const capture = createCaptureBridge()
    const service = new BoardService(db, paths, { agentBridge: capture.bridge })

    // 1. MCP/hook cannot set userNotes on createTask
    expect(() =>
      service.createTask(
        { title: 'Blocked Agent Notes', userNotes: 'Agent trying to inject human notes' },
        'mcp',
      ),
    ).toThrow(/user-notes-human-only/)
    expect(() =>
      service.createTask(
        { title: 'Blocked Hook Notes', userNotes: 'Hook trying to inject human notes' },
        'hook',
      ),
    ).toThrow(/user-notes-human-only/)

    // 2. Human UI creates card with brief description, human notes, full contract prompt, and freeze snapshot
    const created = service.createTask(
      {
        title: 'Refactor Checkout Flow',
        description: 'Split brief, human alignment notes, and execution contract.',
        userNotes: 'Must keep backward compatibility with v1 API payloads.',
        prompt: '## Plan\n1. Update schema\n2. Update dispatch serializer',
        freeze: { goal: 'Clean separation', progress: 'Schema ready', next: 'Wire UI' },
        subgoals: [{ id: 'sg-1', title: 'Migrate DB', required: true }],
        refs: [{ kind: 'file', target: 'src/core/types.ts', label: 'Core types' }],
      },
      'ui',
    )
    expect(created.userNotes).toBe('Must keep backward compatibility with v1 API payloads.')
    expect(created.planRevision).toBe(1) // initial subgoals set revision 1
    expect(isTaskContentFrozen(created)).toBe(false)

    // 3. Round 1 dispatch captures immutable contractSnapshot and increments planRevision
    const round1 = await service.dispatchTask(created.id, { mode: 'new' })
    expect(hasOpenExecution(round1.task)).toBe(true)
    expect(isTaskContentFrozen(round1.task)).toBe(false)
    expect(round1.task.planRevision).toBe(2)

    const exec1 = round1.task.executions[0]
    expect(exec1.planRevision).toBe(2)
    expect(exec1.contractSnapshot).toBeDefined()
    expect(exec1.contractSnapshot?.title).toBe('Refactor Checkout Flow')
    expect(exec1.contractSnapshot?.userNotes).toBe('Must keep backward compatibility with v1 API payloads.')
    expect(exec1.contractSnapshot?.description).toBe('Split brief, human alignment notes, and execution contract.')
    expect(exec1.contractSnapshot?.prompt).toContain('1. Update schema')
    expect(exec1.contractSnapshot?.dispatchedPrompt).toBe(capture.started[0].prompt)

    // 4. While Round 1 is ACTIVELY RUNNING, human can edit title, description, userNotes, and prompt with ZERO frozen-content error!
    const editedMidRun = service.updateTask(
      created.id,
      {
        title: 'Refactor Checkout Flow (v2)',
        description: 'Updated concise brief while running.',
        userNotes: 'OVERRIDE: Drop XML support and prioritize JSON streaming.',
        prompt: '## Plan v2\n1. Stream JSON\n2. Add contract snapshot tests',
      },
      'ui',
    )
    expect(editedMidRun.title).toBe('Refactor Checkout Flow (v2)')
    expect(editedMidRun.userNotes).toBe('OVERRIDE: Drop XML support and prioritize JSON streaming.')
    // Round 1's stored snapshot remains completely immutable!
    expect(editedMidRun.executions[0].contractSnapshot?.title).toBe('Refactor Checkout Flow')
    expect(editedMidRun.executions[0].contractSnapshot?.userNotes).toBe(
      'Must keep backward compatibility with v1 API payloads.',
    )

    // 5. MCP/hook still cannot overwrite human userNotes, even though MCP can update prompt/description or append comments
    expect(() =>
      service.updateTask(created.id, { userNotes: 'AI overwrite attempt' }, 'mcp'),
    ).toThrow(/user-notes-human-only/)
    expect(() =>
      service.updateTask(created.id, { userNotes: 'Hook overwrite attempt' }, 'hook'),
    ).toThrow(/user-notes-human-only/)

    // MCP can still append progress comments without touching userNotes
    const commented = service.addTaskComment(created.id, { bodyMd: 'Round 1 halfway done', author: 'agent' }, 'mcp')
    expect(commented.task.userNotes).toBe('OVERRIDE: Drop XML support and prioritize JSON streaming.')

    // 6. Settle Round 1 -> Round 2 (new) receives latest userNotes & contract in highest priority and increments planRevision
    service.settleExecution(created.id, 'succeeded', { summary: 'Round 1 complete' })
    const round2 = await service.dispatchTask(created.id, { mode: 'new' })
    expect(round2.task.planRevision).toBe(3)
    expect(round2.task.executions).toHaveLength(2)
    expect(round2.task.executions[1].planRevision).toBe(3)
    expect(round2.task.executions[1].contractSnapshot?.userNotes).toBe(
      'OVERRIDE: Drop XML support and prioritize JSON streaming.',
    )
    expect(capture.started[1].prompt).toContain('OVERRIDE: Drop XML support and prioritize JSON streaming.')
    expect(capture.started[1].prompt).toContain('## Plan v2')

    // 7. Settle Round 2 -> Rework also injects latest human userNotes into rework prompt
    service.settleExecution(created.id, 'succeeded', { summary: 'Round 2 complete' })
    service.updateTask(created.id, { userNotes: 'REWORK OVERRIDE: Keep latency under 20ms.' }, 'ui')
    await service.dispatchTask(created.id, {
      mode: 'rework',
      conversationId: round2.conversationId,
      reworkInstructions: 'Tighten error handling on empty payloads.',
    })
    expect(capture.sent).toHaveLength(1)
    expect(capture.sent[0].message).toContain('## Human Notes & Alignment Overrides (Highest Priority)')
    expect(capture.sent[0].message).toContain('REWORK OVERRIDE: Keep latency under 20ms.')
    expect(capture.sent[0].message).toContain('Tighten error handling on empty payloads.')
  })

  it('assembles buildDispatchPrompt strictly in priority order: Human Notes -> Brief -> Contract -> Subgoals & Handoff', () => {
    const task: TaskRecord = {
      id: 't-order',
      title: 'Priority Order Task',
      description: 'Concise 2-sentence brief for humans.',
      userNotes: 'HUMAN RULE #1: Do not modify public CLI flags.',
      prompt: 'Full execution contract with detailed technical steps.',
      phase: 'todo',
      subPhase: 'ready',
      status: 'pending',
      priority: 'high',
      sortOrder: 0,
      writeGate: 'unlocked',
      reuseSession: false,
      tags: [],
      planRevision: 2,
      createdAt: 1,
      updatedAt: 2,
      subgoals: [
        {
          id: 'sg-1',
          taskId: 't-order',
          title: 'Add migration v5',
          detail: '',
          kind: 'implementation',
          required: true,
          status: 'open',
          sortOrder: 0,
          dependencies: [],
          addedBy: 'user',
          createdAt: 1,
        },
      ],
      subgoalRollup: computeSubgoalRollup([]),
      refs: [],
      conversations: [
        {
          taskId: 't-order',
          conversationId: 'conv-origin',
          role: 'origin',
          linkedAt: 1,
          summary: 'Agreed to keep description <= 150 chars.',
          includeInHandoff: true,
        },
      ],
      executions: [],
    }

    const prompt = buildDispatchPrompt(task)
    const idxHuman = prompt.indexOf('## Human Notes & Alignment Overrides (Highest Priority)')
    const idxDesc = prompt.indexOf('## Description')
    const idxContract = prompt.indexOf('## Execution Instruction')
    const idxSubgoals = prompt.indexOf('## Subgoals')
    const idxHandoff = prompt.indexOf('## Handoff Conclusions (★ included)')

    expect(idxHuman).toBeGreaterThan(-1)
    expect(idxDesc).toBeGreaterThan(idxHuman)
    expect(idxContract).toBeGreaterThan(idxDesc)
    expect(idxSubgoals).toBeGreaterThan(idxContract)
    expect(idxHandoff).toBeGreaterThan(idxSubgoals)

    const rework = buildReworkPrompt(task, 'Fix edge case on empty note.')
    expect(rework.indexOf('HUMAN RULE #1')).toBeGreaterThan(-1)
    expect(rework.indexOf('HUMAN RULE #1')).toBeLessThan(rework.indexOf('Fix edge case on empty note.'))
  })

  it('enforces MCP tool descriptions and prevents MCP board_create/board_update from overwriting userNotes', async () => {
    const capture = createCaptureBridge()
    const service = new BoardService(db, paths, { agentBridge: capture.bridge })
    const server = createBoardMcpServer(service)
    const client = new Client({ name: 'test-client', version: '0.1.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    try {
      const tools = await client.listTools()
      const createTool = tools.tools.find((t) => t.name === 'board_create')!
      const updateTool = tools.tools.find((t) => t.name === 'board_update')!

      // Brief vs Contract guidance documented in MCP tool metadata
      expect(createTool.description).toMatch(/1–3 sentence|<=150 chars/i)
      expect(createTool.description).toMatch(/prompt/i)
      expect(updateTool.description).toMatch(/userNotes/i)
      expect(updateTool.description).toMatch(/board_comment_add/i)

      // userNotes is intentionally NOT exposed in MCP write tool input schemas
      const createProps = (createTool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
      const updateProps = (updateTool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
      expect('userNotes' in createProps).toBe(false)
      expect('userNotes' in updateProps).toBe(false)

      // Human creates a task with userNotes and starts an execution
      const task = service.createTask(
        {
          title: 'MCP Guarded Task',
          description: 'Short brief.',
          userNotes: 'Human sacred alignment note.',
          prompt: 'Original contract',
        },
        'ui',
      )
      await service.dispatchTask(task.id, { mode: 'new' })

      // Agent calls board_update during active execution -> succeeds (no frozen-content) and preserves userNotes
      const res = await client.callTool({
        name: 'board_update',
        arguments: {
          taskId: task.id,
          description: 'Updated concise brief from agent.',
          prompt: 'Refined contract from agent.',
        },
      })
      expect(res.isError).not.toBe(true)

      const after = service.getTask(task.id)!
      expect(after.description).toBe('Updated concise brief from agent.')
      expect(after.prompt).toBe('Refined contract from agent.')
      expect(after.userNotes).toBe('Human sacred alignment note.')
    } finally {
      await client.close()
      await server.close()
    }
  })
})
