import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MCP_APP_CARD_URI, MCP_APP_MIME_TYPE, createBoardMcpServer } from '../src/entry/mcp.ts'
import { BoardDatabase, BoardService, resolveHostPaths } from '../src/host/index.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const MCP_BUNDLE = join(REPO_ROOT, 'dist', 'mcp.mjs')
const HOOK_BUNDLE = join(REPO_ROOT, 'dist', 'hook.mjs')

function runHookProcess(
  payload: unknown,
  env: Record<string, string>,
): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      process.execPath,
      [HOOK_BUNDLE],
      { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 10_000 },
      (err, stdout) => {
        if (err) {
          rejectPromise(err)
          return
        }
        resolvePromise(JSON.parse(stdout.trim() || '{}') as Record<string, unknown>)
      },
    )
    child.stdin?.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
  })
}

describe('compiled MCP server (dist/mcp.mjs) & Hook handler (dist/hook.mjs)', () => {
  let tmpRoot: string
  let envVars: Record<string, string>

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'agy-board-e2e-'))
    const geminiConfigDir = join(tmpRoot, 'gemini-config')
    const agyDataDir = join(tmpRoot, 'gemini-antigravity')
    const wsDir = join(tmpRoot, 'sample-ws')
    mkdirSync(join(geminiConfigDir, 'projects'), { recursive: true })
    mkdirSync(agyDataDir, { recursive: true })
    mkdirSync(wsDir, { recursive: true })

    writeFileSync(
      join(geminiConfigDir, 'projects', 'ws-sample.json'),
      JSON.stringify({
        id: 'ws-sample',
        name: 'Sample Workspace',
        projectResources: { resources: [{ folderUri: `file:///${wsDir.replace(/\\/g, '/')}` }] },
      }),
    )

    envVars = {
      AGY_BOARD_DB_PATH: join(tmpRoot, 'board.db'),
      AGY_BOARD_GEMINI_CONFIG_DIR: geminiConfigDir,
      AGY_BOARD_ANTIGRAVITY_DATA_DIR: agyDataDir,
    }
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('serves all 15 MCP tools and ui://agy-board/card.html MCP App resource over stdio and omits confirm_permission', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_BUNDLE],
      env: { ...process.env, ...envVars } as Record<string, string>,
    })
    const client = new Client({ name: 'vitest-mcp-client', version: '1.0.0' })
    await client.connect(transport)

    try {
      const listed = await client.listTools()
      const names = listed.tools.map((t) => t.name).sort()
      expect(names).toEqual([
        'board_card',
        'board_comment_add',
        'board_create',
        'board_dispatch',
        'board_get',
        'board_list',
        'board_plan_breakdown',
        'board_ref_add',
        'board_schedule',
        'board_subgoal_update',
        'board_transition',
        'board_update',
        'board_workspaces',
        'next_ready_task',
        'plan_to_board',
      ])
      expect(names).not.toContain('confirm_permission')

      for (const uiTool of ['board_list', 'board_get', 'board_card']) {
        const toolDef = listed.tools.find((t) => t.name === uiTool)
        expect((toolDef?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri).toBe(
          MCP_APP_CARD_URI,
        )
      }

      const resources = await client.listResources()
      expect(resources.resources.some((r) => r.uri === MCP_APP_CARD_URI && r.mimeType === MCP_APP_MIME_TYPE)).toBe(true)
      const cardResource = await client.readResource({ uri: MCP_APP_CARD_URI })
      expect(cardResource.contents).toHaveLength(1)
      expect(cardResource.contents[0].mimeType).toBe(MCP_APP_MIME_TYPE)
      expect((cardResource.contents[0] as { _meta?: { ui?: { prefersBorder?: boolean } } })._meta?.ui).toEqual({
        prefersBorder: false,
      })
      expect((cardResource.contents[0] as { text?: string }).text).toContain('ui/initialize')

      const wsRes = await client.callTool({ name: 'board_workspaces', arguments: {} })
      const wsPayload = JSON.parse((wsRes.content as Array<{ text: string }>)[0].text)
      expect(wsPayload.workspaces.some((w: { id: string }) => w.id === 'ws-sample')).toBe(true)

      const created = await client.callTool({
        name: 'board_create',
        arguments: {
          title: 'MCP Kanban Task',
          workspaceId: 'ws-sample',
          tags: [{ name: 'mcp' }],
        },
      })
      const createdPayload = JSON.parse((created.content as Array<{ text: string }>)[0].text)
      expect(createdPayload.ok).toBe(true)
      const taskId = createdPayload.task.id as string

      const breakdown = await client.callTool({
        name: 'board_plan_breakdown',
        arguments: {
          taskId,
          subgoals: [
            { id: 'sg-1', title: 'Write schema', required: true },
            { id: 'sg-2', title: 'Add tests', required: true, dependencies: ['sg-1'] },
          ],
        },
      })
      const bdPayload = JSON.parse((breakdown.content as Array<{ text: string }>)[0].text)
      expect(bdPayload.planRevision).toBe(1)
      expect(bdPayload.subgoals).toHaveLength(2)

      await client.callTool({
        name: 'board_ref_add',
        arguments: { taskId, kind: 'file', target: 'README.md', label: 'Docs' },
      })

      await client.callTool({
        name: 'board_update',
        arguments: { taskId, nextAction: 'Finish unit tests', priority: 'high' },
      })

      await client.callTool({
        name: 'board_subgoal_update',
        arguments: { taskId, subgoalId: 'sg-1', status: 'done' },
      })

      await client.callTool({
        name: 'board_subgoal_update',
        arguments: { taskId, subgoalId: 'sg-2', status: 'done' },
      })

      await client.callTool({
        name: 'board_transition',
        arguments: { taskId, action: 'phase', phase: 'closed', subPhase: 'done' },
      })

      const schedRes = await client.callTool({
        name: 'board_schedule',
        arguments: { taskId, reminderAt: Date.now() + 3600_000 },
      })
      expect(JSON.parse((schedRes.content as Array<{ text: string }>)[0].text).ok).toBe(true)

      const mcpSchedCreate = await client.callTool({
        name: 'board_create',
        arguments: {
          title: 'MCP Recurring Task',
          workspaceId: 'ws-sample',
          schedule: {
            enabled: true,
            mode: 'after_completion',
            intervalDays: 3,
            atHour: 9,
            atMinute: 0,
            action: 'remind',
            misfirePolicy: 'catch_up_once',
          },
        },
      })
      const mcpSchedJson = JSON.parse((mcpSchedCreate.content as Array<{ text: string }>)[0].text)
      expect(mcpSchedJson.ok).toBe(true)
      expect(mcpSchedJson.fullTask.schedule.mode).toBe('after_completion')
      expect(mcpSchedJson.fullTask.schedule.intervalDays).toBe(3)
      expect(mcpSchedJson.fullTask.schedule.action).toBe('remind')

      const mcpSchedClear = await client.callTool({
        name: 'board_schedule',
        arguments: { taskId: mcpSchedJson.fullTask.id, schedule: { clear: true } },
      })
      const clearedJson = JSON.parse((mcpSchedClear.content as Array<{ text: string }>)[0].text)
      expect(clearedJson.ok).toBe(true)
      expect(clearedJson.schedule).toBeUndefined()

      const listRes = await client.callTool({
        name: 'board_list',
        arguments: { workspaceId: 'ws-sample', phase: 'closed' },
      })
      const listPayload = JSON.parse((listRes.content as Array<{ text: string }>)[0].text)
      expect(listPayload.total).toBe(1)

      const getRes = await client.callTool({ name: 'board_get', arguments: { taskId } })
      const got = JSON.parse((getRes.content as Array<{ text: string }>)[0].text)
      expect(got.task.refs).toHaveLength(1)
      expect(got.task.subgoalRollup.requiredTotal).toBe(2)
      expect(got.task.subgoalRollup.requiredDone).toBe(2)
      expect(got.task.phase).toBe('closed')

      // Exercise plan_to_board, board_comment_add, board_card, and next_ready_task
      const planned = await client.callTool({
        name: 'plan_to_board',
        arguments: {
          title: 'Planned Priority Task',
          workspaceId: 'ws-sample',
          priority: 'urgent',
          tags: ['alpha'],
          refs: [{ kind: 'file', target: 'README.md' }],
          subgoals: [
            { id: 'p-1', title: 'Step A', required: true },
            { id: 'p-2', title: 'Step B', required: true, dependencies: ['p-1'] },
          ],
        },
      })
      const planJson = JSON.parse((planned.content as Array<{ text: string }>)[0].text)
      expect(planJson.ok).toBe(true)
      expect(planJson.planRevision).toBe(1)
      const plannedId = planJson.taskId as string

      const commented = await client.callTool({
        name: 'board_comment_add',
        arguments: { taskId: plannedId, bodyMd: 'Initial **plan** note', author: 'planner-agent' },
      })
      expect(JSON.parse((commented.content as Array<{ text: string }>)[0].text).totalComments).toBe(1)

      // Update existing task via plan_to_board and verify board_card summary mode (without taskId)
      const replanned = await client.callTool({
        name: 'plan_to_board',
        arguments: {
          taskId: plannedId,
          description: 'Updated plan description',
          priority: 'high',
          refs: [{ kind: 'doc', target: 'docs/plan.md' }],
        },
      })
      const replanJson = JSON.parse((replanned.content as Array<{ text: string }>)[0].text)
      expect(replanJson.ok).toBe(true)
      expect(replanJson.task.priority).toBe('high')

      // Elevated unconfirmed task MUST be skipped by next_ready_task even if priority='urgent'
      await client.callTool({
        name: 'board_create',
        arguments: {
          title: 'Urgent Elevated Unconfirmed Task',
          workspaceId: 'ws-sample',
          priority: 'urgent',
          permission: 'workspace-write',
        },
      })

      const cardRes = await client.callTool({ name: 'board_card', arguments: { taskId: plannedId } })
      expect((cardRes.structuredContent as { task?: { id?: string } } | undefined)?.task?.id).toBe(plannedId)

      const summaryCardRes = await client.callTool({ name: 'board_card', arguments: { workspacePath: join(tmpRoot, 'sample-ws') } })
      const summaryTasks = (summaryCardRes.structuredContent as { tasks?: Array<{ id: string }> } | undefined)?.tasks ?? []
      expect(summaryTasks.some((t) => t.id === plannedId)).toBe(true)

      const nextRes = await client.callTool({
        name: 'next_ready_task',
        arguments: { workspaceId: 'ws-sample' },
      })
      const nextJson = JSON.parse((nextRes.content as Array<{ text: string }>)[0].text)
      expect(nextJson.ok).toBe(true)
      expect(nextJson.task.id).toBe(plannedId)
      expect(nextJson.nextSubgoals.map((s: { id: string }) => s.id)).toEqual(['p-1'])
    } finally {
      await client.close()
    }
  })

  it('runs compiled hook.mjs for SessionStart, PreToolUse write gate, PostToolUse ref capture, and Stop settlement', async () => {
    const paths = resolveHostPaths({
      dbPath: envVars.AGY_BOARD_DB_PATH,
      geminiConfigDir: envVars.AGY_BOARD_GEMINI_CONFIG_DIR,
      antigravityDataDir: envVars.AGY_BOARD_ANTIGRAVITY_DATA_DIR,
    })
    const db = new BoardDatabase(paths.dbPath)
    const service = new BoardService(db, paths, {
      agentBridge: {
        async startConversation() {
          return { conversationId: 'conv-hook-1', raw: {} }
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
      },
    })
    const task = service.createTask({
      title: 'Hook Driven Task',
      workspaceId: 'ws-sample',
      freeze: { goal: 'Verify hooks', progress: 'init', next: 'run' },
      subgoals: [{ title: 'Req 1', required: true }],
    })
    await service.dispatchTask(task.id, { mode: 'new' })
    db.close()

    // 1. SessionStart on linked conversation -> injects context
    const startOut = await runHookProcess(
      { hookEventName: 'SessionStart', conversationId: 'conv-hook-1' },
      envVars,
    )
    expect(Array.isArray(startOut.injectSteps)).toBe(true)

    // 2. Unlinked conversation PreToolUse -> fast allow
    const unlinkedPre = await runHookProcess(
      {
        hookEventName: 'PreToolUse',
        conversationId: 'conv-unrelated',
        toolCall: { name: 'write_to_file', args: { TargetFile: 'foo.ts' } },
      },
      envVars,
    )
    expect(unlinkedPre).toEqual({ decision: 'allow' })

    // 3. PostToolUse captures deliverable file into task_refs
    const targetFile = join(tmpRoot, 'sample-ws', 'deliverable.ts')
    await runHookProcess(
      {
        hookEventName: 'PostToolUse',
        conversationId: 'conv-hook-1',
        toolCall: { name: 'write_to_file', args: { TargetFile: targetFile } },
      },
      envVars,
    )

    // 4. Lock writeGate -> PreToolUse denies mutating tool
    const db2 = new BoardDatabase(paths.dbPath)
    const service2 = new BoardService(db2, paths)
    service2.updateTask(task.id, { writeGate: 'locked' })
    expect(service2.getTask(task.id)?.refs.some((r) => r.target.endsWith('deliverable.ts'))).toBe(true)
    db2.close()

    const lockedPre = await runHookProcess(
      {
        hookEventName: 'PreToolUse',
        conversationId: 'conv-hook-1',
        toolCall: { name: 'write_to_file', args: { TargetFile: targetFile } },
      },
      envVars,
    )
    expect(lockedPre.decision).toBe('deny')

    // 5. Stop hook settles task -> needs_you and extracts transcript summary
    const transcript = join(tmpRoot, 'transcript.jsonl')
    writeFileSync(
      transcript,
      JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Finished writing deliverable.ts and verified.' }) + '\n',
    )
    await runHookProcess(
      {
        hookEventName: 'Stop',
        conversationId: 'conv-hook-1',
        terminationReason: 'NO_TOOL_CALL',
        fullyIdle: true,
        transcriptPath: transcript,
      },
      envVars,
    )

    const db3 = new BoardDatabase(paths.dbPath)
    try {
      const finalTask = db3.getTask(task.id)!
      expect(finalTask.phase).toBe('needs_you')
      expect(finalTask.executions.at(-1)?.summary).toContain('Finished writing deliverable.ts')
    } finally {
      db3.close()
    }

    // 6. Failed PostToolUse must NOT capture failed target in task_refs
    const failedTarget = join(tmpRoot, 'sample-ws', 'failed-write.ts')
    await runHookProcess(
      {
        hookEventName: 'PostToolUse',
        conversationId: 'conv-hook-1',
        toolCall: { name: 'write_to_file', args: { TargetFile: failedTarget } },
        error: 'EACCES permission denied',
      },
      envVars,
    )

    // 7. Subagent PreToolUse falls back to parentConversationId and enforces Write Gate,
    //    while subagent Stop must NOT prematurely settle an active parent task.
    const db4 = new BoardDatabase(paths.dbPath)
    try {
      const service4 = new BoardService(db4, paths)
      expect(service4.getTask(task.id)?.refs.some((r) => r.target.endsWith('failed-write.ts'))).toBe(false)
      service4.transitionPhase(task.id, 'active', { subPhase: 'running' })
    } finally {
      db4.close()
    }

    const subPre = await runHookProcess(
      {
        hookEventName: 'PreToolUse',
        conversationId: 'conv-subagent-99',
        parentConversationId: 'conv-hook-1',
        rootConversationId: 'conv-hook-1',
        toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
      },
      envVars,
    )
    expect(subPre.decision).toBe('deny')

    await runHookProcess(
      {
        hookEventName: 'Stop',
        conversationId: 'conv-subagent-99',
        parentConversationId: 'conv-hook-1',
        rootConversationId: 'conv-hook-1',
        terminationReason: 'NO_TOOL_CALL',
        fullyIdle: true,
      },
      envVars,
    )

    const db5 = new BoardDatabase(paths.dbPath)
    try {
      expect(db5.getTask(task.id)?.phase).toBe('active')
    } finally {
      db5.close()
    }
  })

  it('exercises board_dispatch over MCP protocol including permission gate and agent launch', async () => {
    const paths = resolveHostPaths({
      dbPath: envVars.AGY_BOARD_DB_PATH,
      geminiConfigDir: envVars.AGY_BOARD_GEMINI_CONFIG_DIR,
      antigravityDataDir: envVars.AGY_BOARD_ANTIGRAVITY_DATA_DIR,
    })
    const db = new BoardDatabase(paths.dbPath)
    const launches: Array<{ projectId?: string; prompt: string }> = []
    const service = new BoardService(db, paths, {
      agentBridge: {
        async startConversation(req) {
          launches.push({ projectId: req.projectId, prompt: req.prompt })
          return { conversationId: 'conv-mcp-dispatched-1', raw: {} }
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
      },
    })
    const server = createBoardMcpServer(service)
    const client = new Client({ name: 'mcp-dispatch-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    try {
      const created = await client.callTool({
        name: 'board_create',
        arguments: { title: 'MCP Dispatch Task', workspaceId: 'ws-sample', prompt: 'Execute plan' },
      })
      const createdTask = JSON.parse((created.content as Array<{ text: string }>)[0].text).task as {
        id: string
        phase: string
        subPhase: string
      }
      const taskId = createdTask.id
      // Agent-created cards stage as todo/draft; a human must approve them first.
      expect(createdTask.subPhase).toBe('draft')
      const deniedApproval = await client.callTool({
        name: 'board_transition',
        arguments: { taskId, phase: 'todo', subPhase: 'ready' },
      })
      expect(JSON.parse((deniedApproval.content as Array<{ text: string }>)[0].text).ok).toBe(false)
      // Simulate the human approval in the board UI.
      service.transitionPhase(taskId, 'todo', { subPhase: 'ready', source: 'ui' })

      const disp = await client.callTool({
        name: 'board_dispatch',
        arguments: { taskId, mode: 'new', extraInstruction: 'Verify types' },
      })
      const dispJson = JSON.parse((disp.content as Array<{ text: string }>)[0].text)
      expect(dispJson.ok).toBe(true)
      expect(dispJson.conversationId).toBe('conv-mcp-dispatched-1')
      expect(dispJson.phase).toBe('active')
      expect(launches[0].projectId).toBe('ws-sample')
      expect(launches[0].prompt).toContain('Verify types')
    } finally {
      await client.close()
      await server.close()
      db.close()
    }
  })

  it('hook.mjs does not create a phantom board.db when absent and returns valid {"decision":"allow"}', async () => {
    const missingDir = join(tmpRoot, 'never-created-board-dir')
    const missingDb = join(missingDir, 'board.db')
    const cleanEnv = {
      ...envVars,
      AGY_BOARD_DB_PATH: missingDb,
    }

    for (const payload of [
      { hookEventName: 'SessionStart', conversationId: 'conv-phantom-1' },
      {
        hookEventName: 'PreToolUse',
        conversationId: 'conv-phantom-1',
        toolCall: { name: 'write_to_file', args: { TargetFile: 'foo.ts' } },
      },
      {
        hookEventName: 'PostToolUse',
        conversationId: 'conv-phantom-1',
        toolCall: { name: 'write_to_file', args: { TargetFile: 'foo.ts' } },
      },
      { hookEventName: 'Stop', conversationId: 'conv-phantom-1', terminationReason: 'NO_TOOL_CALL' },
      'not-json-at-all',
      '',
    ]) {
      const out = await runHookProcess(payload, cleanEnv)
      expect(out).toEqual({ decision: 'allow' })
    }
    expect(existsSync(missingDb)).toBe(false)
    expect(existsSync(`${missingDb}-wal`)).toBe(false)
    expect(existsSync(missingDir)).toBe(false)
  })

  it('enforces Dual Write Gate in both PreToolUse hook and MCP handler and protects board.db*, taskspace/, and handover.references even when unlocked', async () => {
    const paths = resolveHostPaths({
      dbPath: envVars.AGY_BOARD_DB_PATH,
      geminiConfigDir: envVars.AGY_BOARD_GEMINI_CONFIG_DIR,
      antigravityDataDir: envVars.AGY_BOARD_ANTIGRAVITY_DATA_DIR,
    })
    const wsDir = join(tmpRoot, 'sample-ws')
    mkdirSync(join(wsDir, 'docs'), { recursive: true })
    mkdirSync(join(wsDir, 'src'), { recursive: true })
    writeFileSync(join(wsDir, 'docs', 'spec.md'), '# Immutable Handover Spec\n')

    // Record subagent lineage in conversation_summaries.db
    const sumDb = new DatabaseSync(paths.conversationSummariesDb)
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        preview TEXT NOT NULL DEFAULT '',
        step_count INTEGER NOT NULL DEFAULT 0,
        last_modified_time DATETIME NOT NULL,
        workspace_uris TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL DEFAULT '',
        parent_conversation_id TEXT NOT NULL DEFAULT '',
        killed NUMERIC NOT NULL DEFAULT 0
      );
    `)
    sumDb
      .prepare(
        `INSERT INTO conversation_summaries (conversation_id, title, last_modified_time, parent_conversation_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run('conv-locked-sub', 'Subagent', new Date().toISOString(), 'conv-locked-parent')
    sumDb.close()

    const db = new BoardDatabase(paths.dbPath)
    const service = new BoardService(db, paths)
    const lockedTask = service.createTask({
      title: 'Locked Gate Task',
      workspaceId: 'ws-sample',
      phase: 'active',
      writeGate: 'locked',
    })
    service.linkConversation(lockedTask.id, { conversationId: 'conv-locked-parent', role: 'primary' })

    const unlockedTask = service.createTask({
      title: 'Unlocked With Protected Targets',
      workspaceId: 'ws-sample',
      phase: 'active',
      writeGate: 'unlocked',
      handover: { references: ['docs/spec.md'] },
    })
    service.linkConversation(unlockedTask.id, { conversationId: 'conv-unlocked-1', role: 'primary' })
    const taskspaceFile = join(paths.boardDir, 'taskspace', `${unlockedTask.id}.md`)
    expect(existsSync(taskspaceFile)).toBe(true)
    db.close()

    // 1. PreToolUse denies closing/archiving/deleting/unlocking from locked conversation AND subagent (via conversation_summaries.db lineage without parentConversationId in payload)
    for (const callerConv of ['conv-locked-parent', 'conv-locked-sub']) {
      for (const toolCall of [
        { name: 'mcp_agy-board_board_transition', args: { taskId: lockedTask.id, action: 'phase', phase: 'closed' } },
        { name: 'mcp_agy-board_agy-board_board_transition', args: { taskId: lockedTask.id, action: 'phase', phase: 'closed' } },
        { name: 'board_transition', args: { taskId: lockedTask.id, action: 'phase', phase: 'closed' } },
        { name: 'mcp_agy-board_board_transition', args: { taskId: lockedTask.id, action: 'archive' } },
        { name: 'mcp_agy-board_board_archive', args: { taskId: lockedTask.id } },
        { name: 'mcp_agy-board_board_update', args: { taskId: lockedTask.id, writeGate: 'unlocked' } },
        { name: 'mcp_agy-board_board_update', args: { taskId: lockedTask.id, patch: { writeGate: 'unlocked' } } },
        { name: 'mcp_agy-board_board_delete', args: { taskId: lockedTask.id } },
      ]) {
        const res = await runHookProcess(
          { hookEventName: 'PreToolUse', conversationId: callerConv, toolCall },
          envVars,
        )
        expect(res.decision).toBe('deny')
      }
    }

    // Non-unlocking board_update remains allowed by PreToolUse
    const allowedBoardUpdate = await runHookProcess(
      {
        hookEventName: 'PreToolUse',
        conversationId: 'conv-locked-parent',
        toolCall: { name: 'mcp_agy-board_board_update', args: { taskId: lockedTask.id, nextAction: 'Keep testing' } },
      },
      envVars,
    )
    expect(allowedBoardUpdate).toEqual({ decision: 'allow' })

    // 2. Compiled MCP handler itself ALSO blocks board_transition(closed/archive) & board_update(unlocked) from locked conv & subagent
    for (const callerConv of ['conv-locked-parent', 'conv-locked-sub']) {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [MCP_BUNDLE],
        env: { ...process.env, ...envVars, ANTIGRAVITY_CONVERSATION_ID: callerConv } as Record<string, string>,
      })
      const client = new Client({ name: `locked-mcp-${callerConv}`, version: '1.0.0' })
      await client.connect(transport)
      try {
        const closeAttempt = await client.callTool({
          name: 'board_transition',
          arguments: { taskId: lockedTask.id, action: 'phase', phase: 'closed' },
        })
        expect(closeAttempt.isError).toBe(true)
        expect((closeAttempt.content as Array<{ text: string }>)[0].text).toContain('Write Gate is LOCKED')

        const archiveAttempt = await client.callTool({
          name: 'board_transition',
          arguments: { taskId: lockedTask.id, action: 'archive' },
        })
        expect(archiveAttempt.isError).toBe(true)
        expect((archiveAttempt.content as Array<{ text: string }>)[0].text).toContain('Write Gate is LOCKED')

        const unlockAttempt = await client.callTool({
          name: 'board_update',
          arguments: { taskId: lockedTask.id, writeGate: 'unlocked' },
        })
        expect(unlockAttempt.isError).toBe(true)
      } finally {
        await client.close()
      }
    }

    // 3. Even when writeGate === 'unlocked', writes & shell rmdir/redirects to board.db*, taskspace/*.md, and handover.references are DENIED
    const deniedUnlockedTargets: Array<{ conv?: string; cwd?: string; toolCall: { name: string; args: Record<string, unknown> } }> = [
      { toolCall: { name: 'write_to_file', args: { TargetFile: paths.dbPath } } },
      { toolCall: { name: 'write_to_file', args: { TargetFile: `${paths.dbPath}-wal` } } },
      { toolCall: { name: 'write_to_file', args: { TargetFile: `${paths.dbPath}-shm` } } },
      { toolCall: { name: 'write_to_file', args: { TargetFile: taskspaceFile } } },
      { cwd: wsDir, toolCall: { name: 'write_to_file', args: { TargetFile: 'docs/spec.md' } } },
      { cwd: wsDir, toolCall: { name: 'delete_file', args: { AbsolutePath: join(wsDir, 'docs', 'spec.md') } } },
      { cwd: paths.boardDir, toolCall: { name: 'run_command', args: { CommandLine: 'rmdir /s /q taskspace' } } },
      { cwd: paths.boardDir, toolCall: { name: 'run_command', args: { CommandLine: 'echo corrupted > board.db' } } },
      { cwd: paths.boardDir, toolCall: { name: 'send_command_input', args: { Input: 'rm -rf taskspace' } } },
      { cwd: wsDir, toolCall: { name: 'run_command', args: { CommandLine: 'echo overwrite >> docs/spec.md' } } },
      // Even an unrelated unlinked conversation cannot overwrite board.db* or taskspace/*.md
      { conv: 'conv-stranger-unlinked', toolCall: { name: 'write_to_file', args: { TargetFile: paths.dbPath } } },
      { conv: 'conv-stranger-unlinked', toolCall: { name: 'write_to_file', args: { TargetFile: taskspaceFile } } },
    ]
    for (const item of deniedUnlockedTargets) {
      const out = await runHookProcess(
        {
          hookEventName: 'PreToolUse',
          conversationId: item.conv ?? 'conv-unlocked-1',
          ...(item.cwd ? { cwd: item.cwd } : {}),
          toolCall: item.toolCall,
        },
        envVars,
      )
      expect(out.decision).toBe('deny')
    }

    // Read-only command and normal workspace file write when writeGate === 'unlocked' are allowed
    for (const allowedCall of [
      { name: 'write_to_file', args: { TargetFile: 'src/app.ts' } },
      { name: 'run_command', args: { CommandLine: 'cat docs/spec.md' } },
    ]) {
      const out = await runHookProcess(
        {
          hookEventName: 'PreToolUse',
          conversationId: 'conv-unlocked-1',
          cwd: wsDir,
          toolCall: allowedCall,
        },
        envVars,
      )
      expect(out).toEqual({ decision: 'allow' })
    }
  })

  it('extracts CORTEX_STEP_TYPE_PLANNER_RESPONSE on Stop, enforces strict openExec conversationId match, and handles ask_question PreToolUse/PostToolUse including errors', async () => {
    const paths = resolveHostPaths({
      dbPath: envVars.AGY_BOARD_DB_PATH,
      geminiConfigDir: envVars.AGY_BOARD_GEMINI_CONFIG_DIR,
      antigravityDataDir: envVars.AGY_BOARD_ANTIGRAVITY_DATA_DIR,
    })
    const db = new BoardDatabase(paths.dbPath)
    let convSeq = 0
    const service = new BoardService(db, paths, {
      agentBridge: {
        async startConversation() {
          convSeq += 1
          return { conversationId: `conv-strict-${convSeq}`, raw: {} }
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
      },
    })
    const task = service.createTask({ title: 'Strict Stop & AskQuestion Task', workspaceId: 'ws-sample' })
    await service.dispatchTask(task.id, { mode: 'new' }) // conv-strict-1
    // Link a second unrelated/secondary conversation to the same task
    service.linkConversation(task.id, { conversationId: 'conv-secondary-2', role: 'worker' })
    db.close()

    // 1. ask_question PreToolUse transitions active -> needs_you/needs_input
    const preAsk = await runHookProcess(
      { hookEventName: 'PreToolUse', conversationId: 'conv-strict-1', toolCall: { name: 'ask_question', args: {} } },
      envVars,
    )
    expect(preAsk).toEqual({ decision: 'allow' })
    let dbCheck = new BoardDatabase(paths.dbPath)
    expect(dbCheck.getTask(task.id)?.phase).toBe('needs_you')
    expect(dbCheck.getTask(task.id)?.subPhase).toBe('needs_input')
    dbCheck.close()

    // 2. ask_question PostToolUse WITH error MUST NOT restore active/running
    await runHookProcess(
      {
        hookEventName: 'PostToolUse',
        conversationId: 'conv-strict-1',
        toolCall: { name: 'ask_question', args: {} },
        error: 'User dismissed ask_question dialog',
      },
      envVars,
    )
    dbCheck = new BoardDatabase(paths.dbPath)
    expect(dbCheck.getTask(task.id)?.phase).toBe('needs_you')
    expect(dbCheck.getTask(task.id)?.subPhase).toBe('needs_input')
    expect(dbCheck.listTaskEvents(task.id, 10).some((e) => e.kind === 'hook_tool_error')).toBe(true)
    dbCheck.close()

    // 3. ask_question PostToolUse WITHOUT error restores active/running
    await runHookProcess(
      {
        hookEventName: 'PostToolUse',
        conversationId: 'conv-strict-1',
        toolCall: { name: 'ask_question', args: {} },
      },
      envVars,
    )
    dbCheck = new BoardDatabase(paths.dbPath)
    expect(dbCheck.getTask(task.id)?.phase).toBe('active')
    expect(dbCheck.getTask(task.id)?.subPhase).toBe('running')
    dbCheck.close()

    // 4a. Stop with fullyIdle: false keeps active task running and does not settle open execution
    const partialStop = await runHookProcess(
      {
        hookEventName: 'Stop',
        conversationId: 'conv-strict-1',
        terminationReason: 'NO_TOOL_CALL',
        fullyIdle: false,
      },
      envVars,
    )
    expect(partialStop).toEqual({ decision: 'allow' })
    dbCheck = new BoardDatabase(paths.dbPath)
    expect(dbCheck.getTask(task.id)?.phase).toBe('active')
    expect(dbCheck.getTask(task.id)?.executions.find((e) => e.conversationId === 'conv-strict-1')?.endedAt).toBeUndefined()
    dbCheck.close()

    // 4b. Stop from secondary conversation must NOT close conv-strict-1's open execution or settle the active task
    await runHookProcess(
      {
        hookEventName: 'Stop',
        conversationId: 'conv-secondary-2',
        terminationReason: 'NO_TOOL_CALL',
        fullyIdle: true,
      },
      envVars,
    )
    dbCheck = new BoardDatabase(paths.dbPath)
    const afterOtherStop = dbCheck.getTask(task.id)!
    expect(afterOtherStop.phase).toBe('active')
    expect(afterOtherStop.executions.find((e) => e.conversationId === 'conv-strict-1')?.endedAt).toBeUndefined()
    dbCheck.close()

    // 5. Stop from conv-strict-1 extracts CORTEX_STEP_TYPE_PLANNER_RESPONSE and settles openExec strictly
    const cortexTranscript = join(tmpRoot, 'cortex-transcript.jsonl')
    writeFileSync(
      cortexTranscript,
      [
        JSON.stringify({ type: 'CORTEX_STEP_TYPE_USER_INPUT', content: 'Run tests' }),
        JSON.stringify({
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          step: {
            plannerResponse: {
              modifiedResponse: {
                parts: [{ text: 'Cortex planner verified all assertions cleanly.' }],
              },
            },
          },
        }),
      ].join('\n') + '\n',
    )
    await runHookProcess(
      {
        hookEventName: 'Stop',
        conversationId: 'conv-strict-1',
        terminationReason: 'NO_TOOL_CALL',
        fullyIdle: true,
        transcriptPath: cortexTranscript,
      },
      envVars,
    )
    dbCheck = new BoardDatabase(paths.dbPath)
    try {
      const settled = dbCheck.getTask(task.id)!
      expect(settled.phase).toBe('needs_you')
      const primaryExec = settled.executions.find((e) => e.conversationId === 'conv-strict-1')
      expect(primaryExec?.endedAt).toBeTypeOf('number')
      expect(primaryExec?.summary).toBe('Cortex planner verified all assertions cleanly.')
    } finally {
      dbCheck.close()
    }
  })
})
