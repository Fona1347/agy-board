import { execFile, spawn } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BoardDatabase,
  BoardScheduler,
  BoardService,
  DefaultAgentBridge,
  SidecarOwner,
  cleanupTaskWorktree,
  ensureTaskWorktree,
  extractConversationId,
  findConversationsByIds,
  getTaskWorktreeDiff,
  readAntigravityProjects,
  readRecentConversations,
  resolveHostPaths,
  type AgentBridge,
} from '../src/host/index.ts'

const execFileAsync = promisify(execFile)

function generateSelfSignedLoopbackCert(): { key: string; cert: string } {
  const lenEnc = (n: number) => {
    if (n < 128) return Buffer.from([n])
    const bytes: number[] = []
    let v = n
    while (v > 0) {
      bytes.unshift(v & 0xff)
      v >>= 8
    }
    return Buffer.from([0x80 | bytes.length, ...bytes])
  }
  const der = (tag: number, buf: Buffer) => Buffer.concat([Buffer.from([tag]), lenEnc(buf.length), buf])
  const seq = (...items: Buffer[]) => der(0x30, Buffer.concat(items))
  const set = (...items: Buffer[]) => der(0x31, Buffer.concat(items))
  const oid = (bytes: number[]) => der(0x06, Buffer.from(bytes))
  const utf8 = (s: string) => der(0x0c, Buffer.from(s, 'utf8'))
  const utc = (s: string) => der(0x17, Buffer.from(s, 'ascii'))
  const bitStr = (b: Buffer) => der(0x03, Buffer.concat([Buffer.from([0]), b]))

  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const sha256Rsa = seq(oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), der(0x05, Buffer.alloc(0)))
  const name = seq(set(seq(oid([0x55, 0x04, 0x03]), utf8('127.0.0.1'))))
  const validity = seq(utc('250101000000Z'), utc('350101000000Z'))
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), sha256Rsa, name, validity, name, spki)
  const sig = sign('sha256', tbs, privateKey)
  const certDer = seq(tbs, sha256Rsa, bitStr(sig))
  const certPem = `-----BEGIN CERTIFICATE-----\n${certDer.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  return { key: keyPem, cert: certPem }
}

describe('host/BoardService integration', () => {
  let tmpRoot: string
  let db: BoardDatabase
  let launchedCalls: Array<{ kind: 'start' | 'send'; projectId?: string; conversationId?: string; prompt: string }>

  const makeMockBridge = (delayMs = 5): AgentBridge => {
    let seq = 0
    return {
      async startConversation(req) {
        await new Promise((r) => setTimeout(r, delayMs))
        seq += 1
        const conversationId = `conv-new-${seq}`
        launchedCalls.push({ kind: 'start', projectId: req.projectId, conversationId, prompt: req.prompt })
        return { conversationId, raw: { conversationId } }
      },
      async sendMessage(req) {
        await new Promise((r) => setTimeout(r, delayMs))
        launchedCalls.push({
          kind: 'send',
          projectId: req.projectId,
          conversationId: req.conversationId,
          prompt: req.message,
        })
        return { conversationId: req.conversationId, raw: { conversationId: req.conversationId } }
      },
      async getConversationMetadata(id) {
        return { conversationId: id }
      },
      async jumpToConversation(id) {
        return { ok: true, method: 'cdp', conversationId: id }
      },
    }
  }

  let paths: ReturnType<typeof resolveHostPaths>
  let workspaceDir: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'agy-board-host-'))
    const geminiConfigDir = join(tmpRoot, 'gemini-config')
    const agyDataDir = join(tmpRoot, 'gemini-antigravity')
    workspaceDir = join(tmpRoot, 'repo-alpha')
    mkdirSync(join(geminiConfigDir, 'projects'), { recursive: true })
    mkdirSync(agyDataDir, { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })

    // Write Antigravity project manifest
    writeFileSync(
      join(geminiConfigDir, 'projects', 'proj-alpha.json'),
      JSON.stringify({
        id: 'proj-alpha',
        name: 'Alpha Repo',
        projectResources: {
          resources: [{ folderUri: `file:///${workspaceDir.replace(/\\/g, '/')}` }],
        },
      }),
    )

    // Write synthetic conversation_summaries.db
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
    sumDb
      .prepare(
        `INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, project_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'conv-idle-1',
        'Existing Alpha Chat',
        'last step summary',
        4,
        new Date().toISOString(),
        JSON.stringify([`file:///${workspaceDir.replace(/\\/g, '/')}`]),
        'CASCADE_RUN_STATUS_IDLE',
        'proj-alpha',
      )
    sumDb.close()

    launchedCalls = []
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

  it('discovers Antigravity workspaces, binds tasks, and passes ANTIGRAVITY_PROJECT_ID on dispatch', async () => {
    const service = new BoardService(db, paths, { agentBridge: makeMockBridge() })
    const workspaces = service.listWorkspaces()
    expect(workspaces.some((w) => w.id === 'proj-alpha' && w.name === 'Alpha Repo')).toBe(true)

    const task = service.createTask({
      title: 'Implement OAuth flow',
      workspacePath: join(workspaceDir, 'packages', 'auth'),
      prompt: 'Build OAuth refresh handler',
      tags: [{ name: 'auth', promptPrefix: 'Follow strict security rules.' }],
      freeze: '<<<FREEZE\nGoal:\nAdd refresh\nProgress:\nStarted token\nNext:\nWrite tests with sk-secret1234567890\n>>>FREEZE',
    })
    expect(task.workspaceId).toBe('proj-alpha')
    expect(task.freeze?.redacted).toBe(true)
    expect(task.freeze?.next).toContain('[REDACTED]')

    const dispatched = await service.dispatchTask(task.id, { mode: 'new' })
    expect(dispatched.conversationId).toBe('conv-new-1')
    expect(launchedCalls[0].projectId).toBe('proj-alpha')
    expect(launchedCalls[0].prompt).toContain('Follow strict security rules.')
    expect(launchedCalls[0].prompt).toContain('Context Freeze Snapshot')
    expect(dispatched.task.phase).toBe('active')

    // Content stays editable during active execution while round-1 contract snapshot stays immutable
    const editedWhileRunning = service.updateTask(task.id, { title: 'Changed after run' })
    expect(editedWhileRunning.title).toBe('Changed after run')
    expect(editedWhileRunning.executions[0]?.contractSnapshot?.title).toBe(task.title)
  })

  it('enforces human permission confirmation gate and re-arms on permission/handover change', async () => {
    const service = new BoardService(db, paths, {
      sessionDefaultPermission: 'read-only',
      agentBridge: makeMockBridge(),
    })
    const task = service.createTask({
      title: 'Elevated task',
      workspaceId: 'proj-alpha',
      permission: 'workspace-write',
    })

    await expect(service.dispatchTask(task.id, { mode: 'new' })).rejects.toThrow(/confirmation-required/)
    expect(service.getTask(task.id)?.subPhase).toBe('permission_pending')

    // Human confirms in UI
    const confirmed = service.confirmPermission(task.id)
    expect(confirmed.permissionConfirmedAt).toBeTypeOf('number')

    // Changing permission re-arms the gate (blocks confirm-then-swap)
    const escalated = service.updateTask(task.id, { permission: 'danger-full-access' })
    expect(escalated.permissionConfirmedAt).toBeUndefined()
    await expect(service.dispatchTask(task.id, { mode: 'new' })).rejects.toThrow(/confirmation-required/)
  })

  it('bounds concurrent launches via LaunchAdmissionQueue and supports same-session rework', async () => {
    const service = new BoardService(db, paths, {
      maxConcurrentLaunches: 2,
      agentBridge: makeMockBridge(25),
    })

    const tasks = Array.from({ length: 5 }, (_, i) =>
      service.createTask({ title: `Burst ${i}`, workspaceId: 'proj-alpha' }),
    )
    await Promise.all(tasks.map((t, i) => service.dispatchTask(t.id, { mode: 'new', runGroupId: `g-${i % 2}` })))
    expect(service.admissionQueue.peakInFlight).toBeLessThanOrEqual(2)
    expect(launchedCalls).toHaveLength(5)

    // Settle task 0 and send same-session rework
    service.settleExecution(tasks[0].id, 'succeeded')
    const rework = await service.dispatchTask(tasks[0].id, {
      mode: 'rework',
      reworkInstructions: 'Please also add error handling.',
    })
    expect(rework.action).toBe('rework')
    expect(rework.conversationId).toBe('conv-new-1')
    const lastExec = rework.task.executions.at(-1)
    expect(lastExec?.reworkInstructions).toBe('Please also add error handling.')
  })

  it('rolls active task to needs_you/review when all required subgoals finish and guards refs preview', async () => {
    const service = new BoardService(db, paths, { agentBridge: makeMockBridge() })
    const secretFile = join(tmpRoot, 'outside-secret.txt')
    const allowedFile = join(workspaceDir, 'notes.md')
    const binFile = join(workspaceDir, 'blob.bin')
    writeFileSync(secretFile, 'SECRET_OUTSIDE')
    writeFileSync(allowedFile, '# Deliverable\nOK')
    writeFileSync(binFile, Buffer.from([0x00, 0x01, 0x02, 0x03]))

    const task = service.createTask({
      title: 'Subgoal Rollup Task',
      workspaceId: 'proj-alpha',
      subgoals: [
        { title: 'Step 1', required: true },
        { title: 'Step 2', required: false },
      ],
      refs: [{ kind: 'file', target: 'notes.md' }],
    })
    await service.dispatchTask(task.id, { mode: 'new' })

    // Cannot close while required subgoal open
    expect(() => service.transitionPhase(task.id, 'closed', { force: true })).not.toThrow()
    service.transitionPhase(task.id, 'active')
    expect(() => service.transitionPhase(task.id, 'closed')).toThrow(/required-subgoals-open/)

    // Completing required subgoal rolls active task -> needs_you/review
    const reqSg = service.getTask(task.id)!.subgoals[0]
    const rolled = service.updateSubgoal(task.id, reqSg.id, { status: 'done' })
    expect(rolled.phase).toBe('needs_you')
    expect(rolled.subPhase).toBe('review')

    // Ref preview allowlist security check
    const okPreview = service.previewRef(task.id, 'notes.md')
    expect(okPreview.ok).toBe(true)
    if (okPreview.ok) expect(okPreview.content).toContain('# Deliverable')

    const denied = service.previewRef(task.id, secretFile)
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.code).toBe('not-registered')

    service.addTaskRef(task.id, { kind: 'file', target: '../outside-secret.txt' })
    const traversal = service.previewRef(task.id, '../outside-secret.txt')
    expect(traversal.ok).toBe(false)
    if (!traversal.ok) expect(traversal.code).toBe('invalid-path')

    service.addTaskRef(task.id, { kind: 'file', target: 'blob.bin' })
    const binPreview = service.previewRef(task.id, 'blob.bin')
    expect(binPreview.ok).toBe(true)
    if (binPreview.ok) expect(binPreview.isBinary).toBe(true)
  })

  it('processes due reminders, cron budget limits, and skips missed one-shots', async () => {
    let fakeNow = Date.UTC(2026, 5, 1, 10, 0, 0)
    const service = new BoardService(db, paths, {
      now: () => fakeNow,
      agentBridge: makeMockBridge(),
    })

    const remTask = service.createTask({
      title: 'Due reminder task',
      workspaceId: 'proj-alpha',
      reminderAt: fakeNow + 60_000,
    })

    const cronTask = service.createTask({
      title: 'Capped cron task',
      workspaceId: 'proj-alpha',
      schedule: { enabled: true, mode: 'cron', cron: '* * * * *', timeZone: 'UTC', maxRuns: 1 },
    })

    const missedOnce = service.createTask({
      title: 'Missed one-shot',
      workspaceId: 'proj-alpha',
      schedule: { enabled: true, mode: 'once', at: fakeNow + 10_000, timeZone: 'UTC' },
    })

    // Advance 20 minutes: missedOnce (>5m stale) is surfaced for catch-up instead of being killed; reminder fires; cron fires & hits maxRuns=1
    fakeNow += 20 * 60_000
    // Realign cronTask's nextRunAt within 5m window so it fires rather than misses
    service.setTaskSchedule(cronTask.id, { enabled: true, mode: 'cron', cron: '* * * * *', timeZone: 'UTC', maxRuns: 1 })
    fakeNow += 61_000

    const tick = await service.runSchedulerTick(fakeNow)
    expect(tick.firedReminders).toContain(remTask.id)
    expect(tick.firedSchedules).toContain(cronTask.id)
    expect(tick.firedSchedules).not.toContain(missedOnce.id)

    expect(service.getTask(remTask.id)?.phase).toBe('needs_you')
    expect(service.getTask(remTask.id)?.subPhase).toBe('reminder_due')
    expect(service.getTask(cronTask.id)?.schedule?.endedReason).toBe('limit')
    expect(service.getTask(cronTask.id)?.schedule?.enabled).toBe(false)
    const missedRule = service.getTask(missedOnce.id)?.schedule
    // P0-3 Bug 3: wake-from-sleep must not silently drop a one-shot rule.
    expect(missedRule?.endedReason).toBeUndefined()
    expect(missedRule?.enabled).toBe(true)
    expect(missedRule?.skippedReason).toBe('missed')
    expect(typeof missedRule?.missedSlotAt).toBe('number')
  })

  it('stages agent drafts behind human approval, records provenance, and fills the handoff capsule', async () => {
    const service = new BoardService(db, paths, { agentBridge: makeMockBridge() })
    const parent = service.createTask({ title: 'Investigate auth paths', workspaceId: 'proj-alpha' })

    const draft = service.createTask(
      {
        title: 'Add refresh token rotation',
        description: 'Background and constraints for the reviewer.',
        prompt: 'Implement rotation with tests.',
        workspaceId: 'proj-alpha',
        discoveredFromTaskId: parent.id,
        originSummary: 'Spotted while auditing auth paths',
        originConversationId: 'conv-idle-1',
        subgoals: [{ title: 'Rotation covered by tests', kind: 'acceptance', required: true }],
      },
      'mcp',
    )
    expect(draft.phase).toBe('todo')
    expect(draft.subPhase).toBe('draft')
    expect(draft.createdBy).toBe('ai')
    expect(draft.reuseSession).toBe(false)
    expect(draft.discoveredFromTaskId).toBe(parent.id)
    expect(draft.originSummary).toBe('Spotted while auditing auth paths')
    expect(draft.originConversationId).toBe('conv-idle-1')
    const originLink = draft.conversations.find((c) => c.role === 'origin')
    expect(originLink?.conversationId).toBe('conv-idle-1')
    expect(originLink?.includeInHandoff).toBe(true)

    await expect(service.dispatchTask(draft.id, { mode: 'new' })).rejects.toThrow(/draft-not-approved/)
    expect(() =>
      service.createTask({ title: 'Dangling origin', discoveredFromTaskId: 'task-does-not-exist' }, 'mcp'),
    ).toThrow(/discovered-from-not-found/)

    // An untransferred /btw id is kept as provenance but never becomes a dead link.
    const btw = service.createTask(
      { title: 'Side-chat idea', originConversationId: 'conv-btw-ephemeral' },
      'mcp',
    )
    expect(btw.originConversationId).toBe('conv-btw-ephemeral')
    expect(btw.conversations).toHaveLength(0)
    // Known mainline parent gets bound instead.
    const btwWithParent = service.createTask(
      {
        title: 'Side-chat idea with parent',
        originConversationId: 'conv-btw-ephemeral',
        parentConversationId: 'conv-idle-1',
      },
      'mcp',
    )
    expect(btwWithParent.conversations.find((c) => c.role === 'origin')?.conversationId).toBe('conv-idle-1')

    // Human approval unlocks dispatch.
    service.transitionPhase(draft.id, 'todo', { subPhase: 'ready', source: 'ui' })
    const dispatched = await service.dispatchTask(draft.id, { mode: 'new' })
    expect(dispatched.task.phase).toBe('active')

    // Settling mirrors the distilled conclusion into the capsule and ★-includes it.
    const settled = service.settleExecution(draft.id, 'succeeded', { summary: 'Rotation implemented and tested' })
    const capsule = settled.conversations.find((c) => c.conversationId === dispatched.conversationId)
    expect(capsule?.summary).toBe('Rotation implemented and tested')
    expect(capsule?.includeInHandoff).toBe(true)

    const toggled = service.updateConversationMeta(draft.id, {
      conversationId: dispatched.conversationId,
      includeInHandoff: false,
    })
    expect(
      toggled.conversations.find((c) => c.conversationId === dispatched.conversationId)?.includeInHandoff,
    ).toBeFalsy()
  })

  it('resolves one shared DB path across Sidecar, MCP/Hook PLUGIN_DATA, and CLI', () => {
    const appDataDir = join(tmpRoot, 'gemini-antigravity')
    const prevExec = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR
    const prevPluginData = process.env.PLUGIN_DATA
    const prevDbPath = process.env.AGY_BOARD_DB_PATH
    delete process.env.AGY_BOARD_DB_PATH
    try {
      process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = join(appDataDir, 'sidecar_data', 'agy-board', 'board', 'data')
      delete process.env.PLUGIN_DATA
      const sidecarPaths = resolveHostPaths()

      delete process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR
      process.env.PLUGIN_DATA = join(appDataDir, 'plugin_data', 'agy-board')
      const mcpPaths = resolveHostPaths()

      delete process.env.PLUGIN_DATA
      const cliPaths = resolveHostPaths({ antigravityDataDir: appDataDir })

      expect(sidecarPaths.dbPath).toBe(join(appDataDir, 'agy-board', 'board.db'))
      expect(mcpPaths.dbPath).toBe(sidecarPaths.dbPath)
      expect(cliPaths.dbPath).toBe(sidecarPaths.dbPath)
    } finally {
      if (prevExec === undefined) delete process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR
      else process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = prevExec
      if (prevPluginData === undefined) delete process.env.PLUGIN_DATA
      else process.env.PLUGIN_DATA = prevPluginData
      if (prevDbPath === undefined) delete process.env.AGY_BOARD_DB_PATH
      else process.env.AGY_BOARD_DB_PATH = prevDbPath
    }
  })

  it('skips sidecar pseudo-projects with empty projectResources and filters old workspace conversations', () => {
    writeFileSync(
      join(paths.geminiConfigDir, 'projects', 'swarm.json'),
      JSON.stringify({
        id: 'swarm-id',
        name: 'swarm/swarm_board',
        projectResources: {},
        sidecar: { sidecarId: 'swarm/swarm_board' },
      }),
    )
    const agyProjects = readAntigravityProjects(paths)
    expect(agyProjects.some((p) => p.id === 'swarm-id')).toBe(false)

    // Insert 120 newer conversations in another workspace; target workspace conv must still be found
    const sumDb = new DatabaseSync(paths.conversationSummariesDb)
    const stmt = sumDb.prepare(
      `INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const baseMs = Date.now() + 10_000
    for (let i = 0; i < 120; i += 1) {
      stmt.run(
        `conv-other-${i}`,
        `Other ${i}`,
        'noise',
        1,
        new Date(baseMs + i * 1000).toISOString(),
        JSON.stringify(['file:///e%3A/other/ws']),
        'CASCADE_RUN_STATUS_IDLE',
        'proj-other',
      )
    }
    sumDb.close()

    const found = readRecentConversations(paths, { workspacePath: workspaceDir, limit: 10 })
    expect(found.conversations.some((c) => c.conversationId === 'conv-idle-1')).toBe(true)
  })

  it('extracts SidecarEvent protojson conversationId, rejects error payloads, and enforces busy check on rework', async () => {
    expect(
      extractConversationId({ response: { newConversation: { conversationId: 'conv-proto-1' } } }),
    ).toBe('conv-proto-1')
    expect(
      extractConversationId({ payload: { new_conversation: { conversation_id: 'conv-proto-2' } } }),
    ).toBe('conv-proto-2')
    expect(extractConversationId({ rawOutput: 'Conversation ID: conv-plain-3\n' })).toBe('conv-plain-3')

    const bridge = new DefaultAgentBridge(paths, async (_file, args) => {
      if (args.includes('new-conversation')) {
        return {
          stdout: JSON.stringify({ response: { newConversation: { conversationId: 'conv-proto-99' } } }),
          stderr: '',
        }
      }
      return { stdout: JSON.stringify({ error: 'recipient busy' }), stderr: '' }
    })
    const started = await bridge.startConversation({ prompt: '- hyphen-leading prompt', projectId: 'proj-alpha' })
    expect(started.conversationId).toBe('conv-proto-99')
    await expect(bridge.sendMessage({ conversationId: 'conv-proto-99', message: 'hi' })).rejects.toThrow(/recipient busy/)

    // Mark conversation running in conversation_summaries.db -> rework must reject session-busy
    const sumDb = new DatabaseSync(paths.conversationSummariesDb)
    sumDb
      .prepare(
        `INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, project_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'conv-running-1',
        'Running Chat',
        'busy',
        2,
        new Date().toISOString(),
        JSON.stringify([`file:///${workspaceDir.replace(/\\/g, '/')}`]),
        'CASCADE_RUN_STATUS_RUNNING',
        'proj-alpha',
      )
    sumDb.close()

    const service = new BoardService(db, paths, { agentBridge: makeMockBridge() })
    const task = service.createTask({ title: 'Busy rework test', workspaceId: 'proj-alpha' })
    service.linkConversation(task.id, { conversationId: 'conv-running-1', role: 'primary' })
    await expect(
      service.dispatchTask(task.id, { mode: 'rework', reworkInstructions: 'Fix it' }),
    ).rejects.toThrow(/session-busy/)
  })

  it('guards intermediate directory symlink escapes, allows internal symlinks, and caps huge file previews', () => {
    const service = new BoardService(db, paths, { agentBridge: makeMockBridge() })
    const secretDir = join(tmpRoot, 'outside-dir')
    const internalSubDir = join(workspaceDir, 'real-sub')
    mkdirSync(secretDir, { recursive: true })
    mkdirSync(internalSubDir, { recursive: true })
    writeFileSync(join(secretDir, 'secret.txt'), 'TOP_SECRET')
    writeFileSync(join(internalSubDir, 'inside.txt'), 'SAFE_INSIDE')
    writeFileSync(join(workspaceDir, 'huge.log'), 'A'.repeat(300 * 1024))

    symlinkSync(secretDir, join(workspaceDir, 'linked-outside'), 'junction')
    symlinkSync(internalSubDir, join(workspaceDir, 'linked-inside'), 'junction')

    const task = service.createTask({
      title: 'Ref Security Task',
      workspaceId: 'proj-alpha',
      refs: [
        { kind: 'file', target: 'linked-outside/secret.txt' },
        { kind: 'file', target: 'linked-inside/inside.txt' },
        { kind: 'file', target: 'huge.log' },
      ],
    })

    const escaped = service.previewRef(task.id, 'linked-outside/secret.txt')
    expect(escaped.ok).toBe(false)
    if (!escaped.ok) expect(escaped.code).toBe('symlink-escape')

    const internalOk = service.previewRef(task.id, 'linked-inside/inside.txt')
    expect(internalOk.ok).toBe(true)
    if (internalOk.ok) expect(internalOk.content).toBe('SAFE_INSIDE')

    const hugePreview = service.previewRef(task.id, 'huge.log')
    expect(hugePreview.ok).toBe(true)
    if (hugePreview.ok) {
      expect(hugePreview.truncated).toBe(true)
      expect(hugePreview.sizeBytes).toBe(300 * 1024)
      expect(hugePreview.content.length).toBe(256 * 1024)
    }
  })

  it('cleans sibling dependencies on deleteSubgoal, rejects duplicate planBreakdown IDs, skips closed schedules, and refunds failed maxRuns=1', async () => {
    let fakeNow = Date.UTC(2026, 5, 1, 10, 0, 0)
    let failLaunch = true
    const flakyBridge: AgentBridge = {
      async startConversation() {
        if (failLaunch) throw new Error('agentapi transient failure')
        return { conversationId: 'conv-recovered-1', raw: {} }
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
    }
    const service = new BoardService(db, paths, { now: () => fakeNow, agentBridge: flakyBridge })

    const t = service.createTask({ title: 'Subgoal & Schedule Edge', workspaceId: 'proj-alpha' })
    service.planBreakdown({
      taskId: t.id,
      subgoals: [
        { id: 's0', title: 'Done req', required: true },
        { id: 's1', title: 'First', required: true },
        { id: 's2', title: 'Second', required: false, dependencies: ['s1'] },
      ],
    })
    service.updateSubgoal(t.id, 's0', { status: 'done' })
    expect(() =>
      service.planBreakdown({ taskId: t.id, subgoals: [{ id: 's1', title: 'Dup' }] }),
    ).toThrow(/duplicate-subgoal-id/)

    service.transitionPhase(t.id, 'active')
    const afterDel = service.deleteSubgoal(t.id, 's1')
    expect(afterDel.subgoals.find((s) => s.id === 's2')?.dependencies).toEqual([])
    expect(afterDel.phase).toBe('needs_you')
    expect(afterDel.subPhase).toBe('review')

    // A recurring rule survives an accidental close (legacy rows) and revives on the next tick
    const closedCron = service.createTask({
      title: 'Closed Cron',
      workspaceId: 'proj-alpha',
      phase: 'closed',
      schedule: { enabled: true, mode: 'cron', cron: '* * * * *', timeZone: 'UTC' },
    })

    // maxRuns=1 cron fails first launch -> refunded with enabled: true and nextRunAt
    const capped = service.createTask({
      title: 'Refund Cron',
      workspaceId: 'proj-alpha',
      schedule: { enabled: true, mode: 'cron', cron: '* * * * *', timeZone: 'UTC', maxRuns: 1 },
    })

    fakeNow += 61_000
    const tick1 = await service.runSchedulerTick(fakeNow)
    // Both due rules are attempted (launch fails in this tick); the closed
    // recurring task is no longer silently skipped.
    expect(tick1.firedSchedules).toEqual([])
    expect(service.getTask(closedCron.id)?.phase).toBe('needs_you')
    const refunded = service.getTask(capped.id)!
    expect(refunded.schedule?.enabled).toBe(true)
    expect(refunded.schedule?.runCount).toBe(0)
    expect(refunded.schedule?.skippedReason).toBe('launch-failed')
    expect(typeof refunded.schedule?.nextRunAt).toBe('number')

    // Next tick succeeds when agentapi recovers
    failLaunch = false
    fakeNow += 61_000
    const tick2 = await service.runSchedulerTick(fakeNow)
    expect(tick2.firedSchedules).toContain(capped.id)
    expect(tick2.firedSchedules).toContain(closedCron.id)
    expect(service.getTask(closedCron.id)?.phase).toBe('active')
    expect(service.getTask(capped.id)?.schedule?.endedReason).toBe('limit')
  })

  it('protects in-flight dispatches via dispatch.lock and recoverOrphans:false while recovering dead-PID orphans', async () => {
    let releaseLaunch!: () => void
    const launchGate = new Promise<void>((r) => {
      releaseLaunch = r
    })
    let launchEntered!: () => void
    const enteredPromise = new Promise<void>((r) => {
      launchEntered = r
    })

    const service = new BoardService(db, paths, {
      agentBridge: {
        async startConversation() {
          launchEntered()
          await launchGate
          return { conversationId: 'conv-inflight-ok', raw: {} }
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

    const liveTask = service.createTask({ title: 'In-Flight Dispatch', workspaceId: 'proj-alpha' })
    const dispatchPromise = service.dispatchTask(liveTask.id, { mode: 'new' })
    await enteredPromise

    const liveOpenExec = service.getTask(liveTask.id)!.executions.find((e) => e.endedAt === undefined)!
    const liveLockFile = join(paths.boardDir, `dispatch.lock.${liveOpenExec.id}`)
    expect(existsSync(liveLockFile)).toBe(true)

    // Opening concurrent DBs (both recoverOrphans:false and default recoverOrphans:true) must NOT abort in-flight dispatch
    const roDb = new BoardDatabase(paths.dbPath, { recoverOrphans: false })
    expect(roDb.getTask(liveTask.id)?.phase).toBe('active')
    expect(roDb.getTask(liveTask.id)?.executions.at(-1)?.endedAt).toBeUndefined()
    roDb.close()

    const defaultConcurrentDb = new BoardDatabase(paths.dbPath)
    expect(defaultConcurrentDb.getTask(liveTask.id)?.phase).toBe('active')
    expect(defaultConcurrentDb.getTask(liveTask.id)?.executions.at(-1)?.endedAt).toBeUndefined()
    expect(existsSync(liveLockFile)).toBe(true)
    defaultConcurrentDb.close()

    releaseLaunch()
    const completed = await dispatchPromise
    expect(completed.conversationId).toBe('conv-inflight-ok')
    expect(existsSync(liveLockFile)).toBe(false)

    // Create a guaranteed dead PID by spawning a short-lived no-op node process
    const deadChild = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
    const deadPid = deadChild.pid!
    await new Promise<void>((r) => deadChild.once('exit', () => r()))

    const deadTask = service.createTask({ title: 'Crashed Dispatch', workspaceId: 'proj-alpha', phase: 'active' })
    const deadExecId = 'exec-dead-orphan-1'
    db.db
      .prepare(
        `INSERT INTO task_executions (id, task_id, conversation_id, started_at, initiated_by)
         VALUES (?, ?, NULL, ?, 'ui')`,
      )
      .run(deadExecId, deadTask.id, Date.now() - 10_000)
    const deadLockFile = join(paths.boardDir, `dispatch.lock.${deadExecId}`)
    writeFileSync(deadLockFile, String(deadPid), 'utf8')

    // Opening with recoverOrphans:false leaves it untouched; opening with recoverOrphans:true recovers it & unlinks stale lock
    const noRecoverDb = new BoardDatabase(paths.dbPath, { recoverOrphans: false })
    expect(noRecoverDb.getTask(deadTask.id)?.phase).toBe('active')
    expect(existsSync(deadLockFile)).toBe(true)
    noRecoverDb.close()

    const recoverDb = new BoardDatabase(paths.dbPath)
    try {
      const recovered = recoverDb.getTask(deadTask.id)!
      expect(recovered.phase).toBe('needs_you')
      expect(recovered.subPhase).toBe('blocked')
      expect(recovered.executions.at(-1)?.result).toBe('failed')
      expect(existsSync(deadLockFile)).toBe(false)
    } finally {
      recoverDb.close()
    }

    // Pre-launch failure cleans up dispatch.lock.<execId> and keeps task content unfrozen for edits
    const failBridgeService = new BoardService(db, paths, {
      agentBridge: {
        async startConversation() {
          throw new Error('pre-launch agentapi error')
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
    const preLaunchFailTask = failBridgeService.createTask({ title: 'Prelaunch Fail Title', workspaceId: 'proj-alpha' })
    await expect(failBridgeService.dispatchTask(preLaunchFailTask.id, { mode: 'new' })).rejects.toThrow(
      /pre-launch agentapi error/,
    )
    const afterPreFail = failBridgeService.getTask(preLaunchFailTask.id)!
    expect(afterPreFail.phase).toBe('needs_you')
    expect(afterPreFail.subPhase).toBe('blocked')
    expect(existsSync(join(paths.boardDir, `dispatch.lock.${afterPreFail.executions[0].id}`))).toBe(false)
    const editedAfterFail = failBridgeService.updateTask(preLaunchFailTask.id, {
      title: 'Editable After Prelaunch Failure',
      prompt: 'Updated prompt',
    })
    expect(editedAfterFail.title).toBe('Editable After Prelaunch Failure')
  })

  it('supports composite (task_id, id) subgoals across tasks and settles open executions on auto-rollup', async () => {
    const service = new BoardService(db, paths, { agentBridge: makeMockBridge() })
    const t1 = service.createTask({
      title: 'Task One',
      workspaceId: 'proj-alpha',
      subgoals: [{ id: 'sg-1', title: 'Task 1 sg-1', required: true }],
    })
    const t2 = service.createTask({
      title: 'Task Two',
      workspaceId: 'proj-alpha',
      subgoals: [
        { id: 'sg-done', title: 'Already done', required: true },
        { id: 'sg-1', title: 'Task 2 sg-1', required: true },
      ],
    })
    expect(t1.subgoals[0].id).toBe('sg-1')
    expect(t2.subgoals[1].id).toBe('sg-1')

    await service.dispatchTask(t1.id, { mode: 'new' })
    await service.dispatchTask(t2.id, { mode: 'new' })
    service.updateSubgoal(t2.id, 'sg-done', { status: 'done' })

    // Updating t1 sg-1 auto-rolls t1 -> needs_you/review AND settles open execution cleanly, leaving t2 untouched
    const rolled1 = service.updateSubgoal(t1.id, 'sg-1', { status: 'done' })
    expect(rolled1.phase).toBe('needs_you')
    expect(rolled1.subPhase).toBe('review')
    expect(rolled1.executions.at(-1)?.endedAt).toBeTypeOf('number')
    expect(rolled1.executions.at(-1)?.result).toBe('succeeded')
    expect(service.getTask(t2.id)?.subgoals.find((s) => s.id === 'sg-1')?.status).toBe('open')

    // Close succeeds immediately without execution-open deadlock
    const closed1 = service.transitionPhase(t1.id, 'closed')
    expect(closed1.phase).toBe('closed')

    // Deleting last remaining open required subgoal on t2 auto-rolls & settles open execution so deleteTask succeeds
    // AND does NOT affect t1's sg-1 (composite PK isolation)
    const rolled2 = service.deleteSubgoal(t2.id, 'sg-1')
    expect(rolled2.phase).toBe('needs_you')
    expect(rolled2.executions.at(-1)?.endedAt).toBeTypeOf('number')
    expect(() => service.deleteTask(t2.id)).not.toThrow()
    expect(service.getTask(t2.id)).toBeUndefined()
    expect(service.getTask(t1.id)?.subgoals.find((s) => s.id === 'sg-1')?.status).toBe('done')
  })

  it('handles comments, subgoal reordering, custom workspace updates/deletes, multi-folder labeling, and not_fully_idle + full lookup', async () => {
    const folderA = join(tmpRoot, 'mono', 'core')
    const folderB = join(tmpRoot, 'mono', 'web-ui')
    const subFolder = join(folderA, 'packages', 'auth')
    mkdirSync(subFolder, { recursive: true })
    mkdirSync(folderB, { recursive: true })
    writeFileSync(
      join(paths.geminiConfigDir, 'projects', 'proj-multi.json'),
      JSON.stringify({
        id: 'proj-multi',
        name: 'Mono Root',
        projectResources: {
          resources: [
            { folderUri: `file:///${folderA.replace(/\\/g, '/')}` },
            { folderUri: `file:///${folderB.replace(/\\/g, '/')}` },
          ],
        },
      }),
    )

    const service = new BoardService(db, paths, { agentBridge: makeMockBridge() })

    // Multi-folder workspace labeling: root gets ws.name; sibling folder and subfolder get leaf folder name (both with & without workspaceId)
    const rootTask = service.createTask({ title: 'Root Task', workspaceId: 'proj-multi', workspacePath: folderA })
    const siblingTask = service.createTask({ title: 'Web UI Task', workspaceId: 'proj-multi', workspacePath: folderB })
    const nestedTask = service.createTask({ title: 'Nested Task', workspaceId: 'proj-multi', workspacePath: subFolder })
    const inferredNested = service.createTask({ title: 'Inferred Nested', workspacePath: subFolder })
    expect(rootTask.workspaceLabel).toBe('Mono Root')
    expect(siblingTask.workspaceLabel).toBe('web-ui')
    expect(nestedTask.workspaceLabel).toBe('auth')
    expect(inferredNested.workspaceId).toBe('proj-multi')
    expect(inferredNested.workspaceLabel).toBe('auth')

    // Task comments & subgoal reordering
    expect(() => service.addTaskComment(rootTask.id, { bodyMd: '   ' })).toThrow(/invalid-comment/)
    const { task: commented, comment } = service.addTaskComment(rootTask.id, {
      author: 'reviewer',
      bodyMd: '**Looks good** — verify `edge` case.',
    })
    expect(comment.author).toBe('reviewer')
    expect(commented.comments).toHaveLength(1)
    expect(service.getTask(rootTask.id)?.comments?.[0].bodyMd).toContain('**Looks good**')

    service.planBreakdown({
      taskId: rootTask.id,
      subgoals: [
        { id: 'sg-a', title: 'First' },
        { id: 'sg-b', title: 'Second' },
        { id: 'sg-c', title: 'Third' },
      ],
    })
    const reordered = service.reorderSubgoals(rootTask.id, ['sg-c', 'sg-a'])
    expect(reordered.subgoals.map((s) => s.id)).toEqual(['sg-c', 'sg-a', 'sg-b'])
    expect(reordered.subgoals.map((s) => s.sortOrder)).toEqual([0, 1, 2])

    // Custom workspace update & delete + Antigravity host guardrails (overlay pin/rename allowed, rootPath/delete blocked)
    const customDir = join(tmpRoot, 'custom-ws')
    const customDir2 = join(tmpRoot, 'custom-ws-2')
    mkdirSync(customDir, { recursive: true })
    mkdirSync(customDir2, { recursive: true })
    const customWs = service.registerCustomWorkspace({ name: 'Custom Alpha', rootPath: customDir, pinned: true })
    const updatedWs = service.updateCustomWorkspace(customWs.id, {
      name: 'Custom Renamed',
      rootPath: customDir2,
      pinned: false,
    })
    expect(updatedWs.name).toBe('Custom Renamed')
    expect(updatedWs.pinned).toBe(false)
    const hostPinned = service.updateCustomWorkspace('proj-alpha', { name: 'Alpha Pinned', pinned: true })
    expect(hostPinned.name).toBe('Alpha Pinned')
    expect(hostPinned.pinned).toBe(true)
    expect(() => service.updateCustomWorkspace('proj-alpha', { rootPath: customDir2 })).toThrow(
      /cannot-edit-host-workspace-path/,
    )
    expect(() => service.deleteCustomWorkspace('proj-alpha')).toThrow(/cannot-delete-host-workspace/)
    expect(() => service.updateCustomWorkspace('ws-missing', { name: 'Nope' })).toThrow(/workspace-not-found/)
    expect(() => service.deleteCustomWorkspace('ws-missing')).toThrow(/workspace-not-found/)
    service.deleteCustomWorkspace(customWs.id)
    expect(service.listWorkspaces().some((w) => w.id === customWs.id)).toBe(false)

    // Rebuild conversation_summaries.db WITH not_fully_idle column & 160 newer rows to test conditional reading + full lookup
    const sumDb = new DatabaseSync(paths.conversationSummariesDb)
    sumDb.exec(`
      DROP TABLE conversation_summaries;
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
        killed NUMERIC NOT NULL DEFAULT 0,
        not_fully_idle INTEGER NOT NULL DEFAULT 0
      );
    `)
    const stmt = sumDb.prepare(
      `INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, project_id, not_fully_idle)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const oldTs = new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString()
    stmt.run(
      'conv-old-half-idle',
      'Half Idle Bound Chat',
      'pending tool',
      5,
      oldTs,
      JSON.stringify([`file:///${workspaceDir.replace(/\\/g, '/')}`]),
      'CASCADE_RUN_STATUS_IDLE',
      'proj-alpha',
      1,
    )
    stmt.run(
      'conv-old-truly-idle',
      'Truly Idle Bound Chat',
      'done',
      6,
      oldTs,
      JSON.stringify([`file:///${workspaceDir.replace(/\\/g, '/')}`]),
      'CASCADE_RUN_STATUS_IDLE',
      'proj-alpha',
      0,
    )
    const baseMs = Date.UTC(2026, 5, 1, 0, 0, 0)
    for (let i = 0; i < 160; i += 1) {
      stmt.run(
        `conv-newer-${i}`,
        `Newer ${i}`,
        'recent',
        1,
        new Date(baseMs + i * 1000).toISOString(),
        JSON.stringify([`file:///${workspaceDir.replace(/\\/g, '/')}`]),
        'CASCADE_RUN_STATUS_IDLE',
        'proj-alpha',
        i === 159 ? 1 : 0,
      )
    }
    sumDb.close()

    // Old conversations fall outside top-150 recent window, yet full lookup finds & hydrates not_fully_idle accurately;
    // recent window also respects not_fully_idle on conv-newer-159
    const recent150 = readRecentConversations(paths, { limit: 150 }).conversations
    expect(recent150.some((c) => c.conversationId === 'conv-old-half-idle')).toBe(false)
    expect(recent150.find((c) => c.conversationId === 'conv-newer-159')?.isIdle).toBe(false)
    expect(recent150.find((c) => c.conversationId === 'conv-newer-158')?.isIdle).toBe(true)
    const direct = findConversationsByIds(paths, ['conv-old-half-idle', 'conv-old-truly-idle'])
    expect(direct.map.get('conv-old-half-idle')?.isIdle).toBe(false)
    expect(direct.map.get('conv-old-truly-idle')?.isIdle).toBe(true)

    const linkedTask = service.createTask({ title: 'Linked Old Half-Idle', workspaceId: 'proj-alpha' })
    service.linkConversation(linkedTask.id, { conversationId: 'conv-old-half-idle', role: 'primary' })
    const snap = service.getSnapshot()
    const hydratedLink = snap.tasks.find((t) => t.id === linkedTask.id)?.conversations[0]
    expect(hydratedLink?.title).toBe('Half Idle Bound Chat')
    expect(hydratedLink?.isIdle).toBe(false)

    await expect(
      service.dispatchTask(linkedTask.id, { mode: 'rework', reworkInstructions: 'Continue work' }),
    ).rejects.toThrow(/session-busy/)
  })

  it('calls ConversationService CreateConversation via Connect HTTP+JSON (with HTTP 400 -> HTTPS TLS fallback) and strips caller env on unbound CLI', async () => {
    const requests: Array<{ url: string; headers: Record<string, string>; body: string }> = []
    let mode: 'http-ok' | 'tls-fallback' = 'http-ok'

    const bridge = new DefaultAgentBridge(paths, {
      env: {
        ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:43210',
        ANTIGRAVITY_CSRF_TOKEN: 'csrf-secret-1',
      },
      fetchImpl: async (url, init) => {
        requests.push({ url, headers: init.headers, body: init.body })
        if (mode === 'tls-fallback' && url.startsWith('http://')) {
          return {
            ok: false,
            status: 400,
            text: async () => 'Client sent an HTTP request to an HTTPS server.',
          }
        }
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              newConversation: {
                conversationId: mode === 'tls-fallback' ? 'conv-https-fallback' : 'conv-connect-direct',
              },
            }),
        }
      },
    })

    const res1 = await bridge.startConversation({
      prompt: 'Create via Connect',
      title: 'Connect Title',
      projectId: 'proj-alpha',
      tags: ['urgent'],
    })
    expect(res1.conversationId).toBe('conv-connect-direct')
    expect(requests[0].url).toBe('http://127.0.0.1:43210/product.v1.ConversationService/CreateConversation')
    expect(requests[0].headers['Connect-Protocol-Version']).toBe('1')
    expect(requests[0].headers['x-antigravity-csrf-token']).toBe('csrf-secret-1')
    expect(JSON.parse(requests[0].body)).toMatchObject({
      prompt: [{ text: 'Create via Connect' }],
      projectId: 'proj-alpha',
      title: 'Connect Title',
      tags: ['urgent'],
    })

    mode = 'tls-fallback'
    const res2 = await bridge.startConversation({ prompt: 'TLS fallback test' })
    expect(res2.conversationId).toBe('conv-https-fallback')
    expect(requests.map((r) => r.url)).toEqual([
      'http://127.0.0.1:43210/product.v1.ConversationService/CreateConversation',
      'http://127.0.0.1:43210/product.v1.ConversationService/CreateConversation',
      'https://127.0.0.1:43210/product.v1.ConversationService/CreateConversation',
    ])

    // Daemon discovery mode (no ANTIGRAVITY_LS_ADDRESS env) probes /healthz and dispatches over Connect HTTP+JSON
    mkdirSync(paths.daemonDir, { recursive: true })
    writeFileSync(
      join(paths.daemonDir, 'ls-hub.json'),
      JSON.stringify({ pid: process.pid, httpPort: 44111, httpsPort: 44112, csrfToken: 'daemon-csrf' }),
    )
    const daemonUrls: string[] = []
    const daemonBridge = new DefaultAgentBridge(paths, {
      env: {},
      fetchImpl: async (url) => {
        daemonUrls.push(url)
        if (url.endsWith('/healthz')) return { ok: true, status: 200, text: async () => 'ok' }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ newConversation: { conversationId: 'conv-daemon-1' } }),
        }
      },
    })
    const daemonRes = await daemonBridge.startConversation({ prompt: 'Via daemon discovery' })
    expect(daemonRes.conversationId).toBe('conv-daemon-1')
    expect(daemonUrls).toEqual([
      'http://127.0.0.1:44111/healthz',
      'http://127.0.0.1:44111/product.v1.ConversationService/CreateConversation',
    ])

    // Real TCP/TLS loopback test using defaultConnectFetch (HTTP 400 -> self-signed HTTPS TLS fallback)
    const { key, cert } = generateSelfSignedLoopbackCert()
    const realHttpServer = createHttpServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200)
        res.end('ok')
        return
      }
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Client sent an HTTP request to an HTTPS server.')
    })
    const realHttpsServer = createHttpsServer({ key, cert }, (req, res) => {
      if (req.url === '/product.v1.ConversationService/CreateConversation') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ newConversation: { conversationId: 'conv-real-tls-1' } }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((r) => realHttpServer.listen(0, '127.0.0.1', () => r()))
    await new Promise<void>((r) => realHttpsServer.listen(0, '127.0.0.1', () => r()))
    try {
      const httpPort = (realHttpServer.address() as { port: number }).port
      const httpsPort = (realHttpsServer.address() as { port: number }).port
      writeFileSync(
        join(paths.daemonDir, 'ls-hub.json'),
        JSON.stringify({ pid: process.pid, httpPort, httpsPort, csrfToken: 'real-tls-csrf' }),
      )
      const realTlsBridge = new DefaultAgentBridge(paths, { env: {} })
      const realTlsRes = await realTlsBridge.startConversation({ prompt: 'Real loopback TLS fallback' })
      expect(realTlsRes.conversationId).toBe('conv-real-tls-1')
    } finally {
      realHttpServer.closeAllConnections?.()
      realHttpsServer.closeAllConnections?.()
      await Promise.all([
        new Promise<void>((r) => realHttpServer.close(() => r())),
        new Promise<void>((r) => realHttpsServer.close(() => r())),
      ])
    }

    // Unbound CLI dispatch strips inherited ANTIGRAVITY_CONVERSATION_ID and ANTIGRAVITY_PROJECT_ID (for both startConversation and sendMessage)
    const capturedEnvs: Array<NodeJS.ProcessEnv> = []
    const cliBridge = new DefaultAgentBridge(paths, {
      env: {
        ANTIGRAVITY_CONVERSATION_ID: 'caller-conv-should-strip',
        ANTIGRAVITY_PROJECT_ID: 'caller-proj-should-strip',
      },
      useDaemonDiscovery: false,
      execImpl: async (_file, _args, options) => {
        capturedEnvs.push({ ...options.env })
        return { stdout: JSON.stringify({ conversationId: 'conv-cli-stripped' }), stderr: '' }
      },
    })

    await cliBridge.startConversation({ prompt: 'Unbound task' })
    expect(capturedEnvs[0].ANTIGRAVITY_CONVERSATION_ID).toBeUndefined()
    expect(capturedEnvs[0].ANTIGRAVITY_PROJECT_ID).toBeUndefined()

    await cliBridge.startConversation({ prompt: 'Bound task', projectId: 'proj-explicit' })
    expect(capturedEnvs[1].ANTIGRAVITY_CONVERSATION_ID).toBeUndefined()
    expect(capturedEnvs[1].ANTIGRAVITY_PROJECT_ID).toBe('proj-explicit')

    await cliBridge.sendMessage({ conversationId: 'conv-existing-1', message: 'Unbound rework' })
    expect(capturedEnvs[2].ANTIGRAVITY_CONVERSATION_ID).toBeUndefined()
    expect(capturedEnvs[2].ANTIGRAVITY_PROJECT_ID).toBeUndefined()
  })

  it('enforces SidecarOwner single-leader locking and refunds failed once schedules', async () => {
    let fakeNow = Date.UTC(2026, 6, 1, 12, 0, 0)
    const ownerA = new SidecarOwner(paths.dbPath, { ownerId: 'owner-a', ttlMs: 10_000, now: () => fakeNow })
    const ownerB = new SidecarOwner(paths.dbPath, { ownerId: 'owner-b', ttlMs: 10_000, now: () => fakeNow })

    expect(ownerA.tryAcquireOrRenew(fakeNow)).toBe(true)
    expect(ownerB.tryAcquireOrRenew(fakeNow + 1_000)).toBe(false)
    expect(ownerA.isOwner(fakeNow + 1_000)).toBe(true)
    expect(ownerB.isOwner(fakeNow + 1_000)).toBe(false)

    // Non-owner BoardScheduler skips tick cleanly while ownerA holds a fresh lease
    let failLaunch = true
    const service = new BoardService(db, paths, {
      now: () => fakeNow,
      agentBridge: {
        async startConversation() {
          if (failLaunch) throw new Error('temporary launch outage')
          return { conversationId: 'conv-once-recovered', raw: {} }
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
    const onceTask = service.createTask({
      title: 'Once Refund Task',
      workspaceId: 'proj-alpha',
      schedule: { enabled: true, mode: 'once', at: fakeNow + 30_000, timeZone: 'UTC' },
    })

    const nonOwnerScheduler = new BoardScheduler(service, 15_000, {
      ownerId: 'owner-b',
      ttlMs: 10_000,
      now: () => fakeNow,
    })
    fakeNow += 5_000
    expect(ownerA.tryAcquireOrRenew(fakeNow)).toBe(true)
    const skippedTick = await nonOwnerScheduler.tick()
    expect(skippedTick).toEqual({ firedReminders: [], firedSchedules: [] })

    // Dead-PID owner lock with recent heartbeat is treated as stale and immediately recoverable
    const deadChild = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
    const deadPid = deadChild.pid!
    await new Promise<void>((r) => deadChild.once('exit', () => r()))
    writeFileSync(
      ownerA.lockFile!,
      JSON.stringify({ ownerId: 'crashed-owner', pid: deadPid, acquiredAt: fakeNow, heartbeatAt: fakeNow, ttlMs: 60_000 }),
      'utf8',
    )
    expect(ownerB.tryAcquireOrRenew(fakeNow)).toBe(true)
    ownerB.release()

    // Re-acquire as ownerA, advance past ownerA's TTL -> ownerB takes over
    expect(ownerA.tryAcquireOrRenew(fakeNow)).toBe(true)
    fakeNow += 15_000 // base + 20_000 (past 10s TTL)
    expect(ownerB.tryAcquireOrRenew(fakeNow)).toBe(true)
    expect(ownerA.isOwner(fakeNow)).toBe(false)
    ownerA.release() // releasing non-owner must NOT remove ownerB's lock
    expect(ownerB.isOwner(fakeNow)).toBe(true)
    ownerB.release()
    expect(ownerB.readCurrent()).toBeUndefined()

    // BoardScheduler.start() acquires lock and stop() releases it
    const ownedScheduler = new BoardScheduler(service, 60_000, {
      ownerId: 'owner-sched',
      ttlMs: 10_000,
      now: () => fakeNow,
    })
    ownedScheduler.start()
    expect(ownedScheduler.owner.isOwner(fakeNow)).toBe(true)
    ownedScheduler.stop()
    expect(ownedScheduler.owner.readCurrent()).toBeUndefined()

    // Now advance past onceTask.at (base + 40_000, within 5m grace window): first launch fails -> schedule refunded!
    fakeNow += 20_000
    const tickFail = await service.runSchedulerTick(fakeNow)
    expect(tickFail.firedSchedules).toEqual([])
    const refunded = service.getTask(onceTask.id)!
    expect(refunded.schedule?.enabled).toBe(true)
    expect(refunded.schedule?.runCount).toBe(0)
    expect(refunded.schedule?.nextRunAt).toBe(onceTask.schedule?.at)
    expect(refunded.schedule?.endedAt).toBeUndefined()
    expect(refunded.schedule?.skippedReason).toBe('launch-failed')

    // Launch recovers within 5m window -> fires once and closes schedule
    failLaunch = false
    fakeNow += 5_000
    const tickOk = await service.runSchedulerTick(fakeNow)
    expect(tickOk.firedSchedules).toContain(onceTask.id)
    const fired = service.getTask(onceTask.id)!
    expect(fired.schedule?.enabled).toBe(false)
    expect(fired.schedule?.runCount).toBe(1)
    expect(fired.schedule?.endedReason).toBe('fired')
  })

  it('completes a real git worktree roundtrip (ensureTaskWorktree -> getTaskWorktreeDiff -> cleanupTaskWorktree)', async () => {
    const gitRepoDir = join(tmpRoot, 'real-git-repo')
    mkdirSync(gitRepoDir, { recursive: true })
    await execFileAsync('git', ['init'], { cwd: gitRepoDir })
    await execFileAsync('git', ['config', 'user.name', 'Agy Tester'], { cwd: gitRepoDir })
    await execFileAsync('git', ['config', 'user.email', 'tester@example.com'], { cwd: gitRepoDir })
    writeFileSync(join(gitRepoDir, 'hello.txt'), 'line 1\n', 'utf8')
    await execFileAsync('git', ['add', '.'], { cwd: gitRepoDir })
    await execFileAsync('git', ['commit', '-m', 'Initial commit'], { cwd: gitRepoDir })

    // Direct helper roundtrip + reuse + unsafe cleanup guard
    const ensured = await ensureTaskWorktree(gitRepoDir, 'wt-direct-1')
    expect(ensured.ok).toBe(true)
    if (!ensured.ok) return
    expect(ensured.worktreeBranch).toBe('agy-board/wt-direct-1')
    expect(ensured.reused).toBe(false)
    expect(existsSync(ensured.worktreePath)).toBe(true)

    const reensured = await ensureTaskWorktree(gitRepoDir, 'wt-direct-1')
    expect(reensured.ok).toBe(true)
    if (reensured.ok) expect(reensured.reused).toBe(true)

    writeFileSync(join(ensured.worktreePath, 'hello.txt'), 'line 1\nline 2 from worktree\n', 'utf8')
    const directDiff = await getTaskWorktreeDiff(ensured.worktreePath)
    expect(directDiff.ok).toBe(true)
    if (directDiff.ok) {
      expect(directDiff.hasChanges).toBe(true)
      expect(directDiff.diff).toContain('line 2 from worktree')
    }
    const unsafeCleanup = await cleanupTaskWorktree(gitRepoDir, join(gitRepoDir, 'not-a-worktree'), 'main', true)
    expect(unsafeCleanup.ok).toBe(false)
    if (!unsafeCleanup.ok) expect(unsafeCleanup.reason).toBe('unsafe-path')

    const cleaned = await cleanupTaskWorktree(gitRepoDir, ensured.worktreePath, ensured.worktreeBranch, true)
    expect(cleaned.ok).toBe(true)
    expect(existsSync(ensured.worktreePath)).toBe(false)

    // BoardService integration roundtrip (including rework worktree prompt & non-git repo graceful skip)
    const service = new BoardService(db, paths, { agentBridge: makeMockBridge() })
    const nonGitTask = service.createTask({
      title: 'Non-git Worktree Graceful Skip',
      workspacePath: workspaceDir,
      useWorktree: true,
    })
    const nonGitDispatch = await service.dispatchTask(nonGitTask.id, { mode: 'new' })
    expect(nonGitDispatch.task.worktreePath).toBeUndefined()
    expect(service.listTaskEvents(nonGitTask.id, 10).some((e) => e.kind === 'worktree_skipped')).toBe(true)

    const task = service.createTask({
      title: 'Worktree Service Task',
      workspacePath: gitRepoDir,
      useWorktree: true,
    })
    const dispatched = await service.dispatchTask(task.id, { mode: 'new' })
    expect(dispatched.task.worktreePath).toBeTruthy()
    expect(dispatched.task.worktreeBranch).toBe(`agy-board/${task.id}`)
    expect(launchedCalls.at(-1)?.prompt).toContain(dispatched.task.worktreePath!)

    service.settleExecution(task.id, 'succeeded')
    const reworked = await service.dispatchTask(task.id, {
      mode: 'rework',
      reworkInstructions: 'Keep all edits inside the worktree',
    })
    expect(reworked.action).toBe('rework')
    expect(launchedCalls.at(-1)?.prompt).toContain(`Worktree: ${dispatched.task.worktreePath!}`)
    expect(launchedCalls.at(-1)?.prompt).toContain(`(branch: agy-board/${task.id})`)
    expect(service.listTaskEvents(task.id, 10).some((e) => e.kind === 'worktree_ready')).toBe(true)

    writeFileSync(join(dispatched.task.worktreePath!, 'feature.ts'), 'export const x = 1\n', 'utf8')
    const svcDiff = await service.getTaskWorktreeDiff(task.id)
    expect(svcDiff.ok).toBe(true)
    if (svcDiff.ok) {
      expect(svcDiff.hasChanges).toBe(true)
      expect(svcDiff.status).toContain('feature.ts')
    }

    const afterCleanup = await service.cleanupTaskWorktree(task.id, true)
    expect(afterCleanup.worktreePath).toBeUndefined()
    expect(afterCleanup.worktreeBranch).toBeUndefined()
    expect(readdirSync(join(gitRepoDir, '.worktrees')).filter((n) => n.startsWith('agy-board-'))).toHaveLength(0)
  })

  it('supports scheduled state machine: misfire policies, needs_you overlap guard, remind action, completeScheduleCycle, catch-up, skip-cycle, run-now, and recurring prompt edits', async () => {
    let fakeNow = Date.UTC(2026, 4, 10, 8, 55, 0) // 08:55 UTC
    const service = new BoardService(db, paths, {
      now: () => fakeNow,
      agentBridge: makeMockBridge(),
    })

    // 1. Misfire policy 'prompt' vs 'catch_up_once' vs 'skip'
    const promptOnce = service.createTask({
      title: 'Prompt Once Misfire',
      workspaceId: 'proj-alpha',
      schedule: { enabled: true, mode: 'once', at: fakeNow + 5 * 60_000, timeZone: 'UTC', misfirePolicy: 'prompt' },
    })
    const catchUpCron = service.createTask({
      title: 'Catch Up Once Cron',
      workspaceId: 'proj-alpha',
      schedule: {
        enabled: true,
        mode: 'cron',
        cron: '0 9 * * *',
        timeZone: 'UTC',
        misfirePolicy: 'catch_up_once',
      },
    })
    const skipCron = service.createTask({
      title: 'Skip Misfire Cron',
      workspaceId: 'proj-alpha',
      schedule: { enabled: true, mode: 'cron', cron: '0 9 * * *', timeZone: 'UTC', misfirePolicy: 'skip' },
    })

    // Sleep 2 days + 15 mins past 09:00 -> 2026-05-12 09:15 UTC
    fakeNow = Date.UTC(2026, 4, 12, 9, 15, 0)
    const misfireTick = await service.runSchedulerTick(fakeNow)
    expect(misfireTick.firedSchedules).toContain(catchUpCron.id)
    expect(misfireTick.firedSchedules).not.toContain(promptOnce.id)
    expect(misfireTick.firedSchedules).not.toContain(skipCron.id)

    const afterPromptOnce = service.getTask(promptOnce.id)!
    // Prompt misfire keeps the one-shot recoverable instead of ending it.
    expect(afterPromptOnce.schedule?.endedReason).toBeUndefined()
    expect(afterPromptOnce.schedule?.enabled).toBe(true)
    expect(afterPromptOnce.schedule?.skippedReason).toBe('missed')
    expect(afterPromptOnce.schedule?.missedSlotAt).toBe(Date.UTC(2026, 4, 10, 9, 0, 0))

    const afterSkipCron = service.getTask(skipCron.id)!
    expect(afterSkipCron.schedule?.skippedReason).toBe('skipped')
    expect(afterSkipCron.schedule?.missedSlotAt).toBeUndefined()

    const catchUpEvents = service.listTaskEvents(catchUpCron.id, 10)
    expect(catchUpEvents.some((e) => e.kind === 'schedule_caught_up')).toBe(true)

    // 2. Manual catch-up 'run' on missed one-shot
    const caughtUpOnce = await service.handleMissedSchedule(promptOnce.id, 'run')
    expect(caughtUpOnce.schedule?.missedSlotAt).toBeUndefined()
    expect(caughtUpOnce.schedule?.runCount).toBe(1)
    expect(caughtUpOnce.phase).toBe('active')

    // 3. overlapPolicy 'wait_review' holds unreviewed needs_you; 'allow_replace' dispatches over needs_you
    service.settleExecution(catchUpCron.id, 'succeeded', { summary: 'Round 1 done' })
    expect(service.getTask(catchUpCron.id)?.phase).toBe('needs_you')
    // Allow prompt edits on recurring task between runs
    const editedPrompt = service.updateTask(catchUpCron.id, { prompt: 'Updated round 2 prompt' })
    expect(editedPrompt.prompt).toBe('Updated round 2 prompt')

    const allowReplaceTask = service.createTask({
      title: 'Allow Replace Cron',
      workspaceId: 'proj-alpha',
      phase: 'needs_you',
      subPhase: 'review',
      schedule: {
        enabled: true,
        mode: 'cron',
        cron: '20 9 * * *',
        timeZone: 'UTC',
        overlapPolicy: 'allow_replace',
      },
    })
    service.setTaskSchedule(catchUpCron.id, { enabled: true, mode: 'cron', cron: '20 9 * * *', timeZone: 'UTC' })

    fakeNow = Date.UTC(2026, 4, 12, 9, 20, 0)
    const overlapTick = await service.runSchedulerTick(fakeNow)
    expect(overlapTick.firedSchedules).not.toContain(catchUpCron.id)
    expect(overlapTick.firedSchedules).toContain(allowReplaceTask.id)
    expect(service.getTask(catchUpCron.id)?.schedule?.skippedReason).toBe('awaiting-review')
    expect(service.listTaskEvents(catchUpCron.id, 10).some((e) => e.kind === 'schedule_held_for_review')).toBe(true)

    // 4. completeScheduleCycle resets subgoals, clears stale dueAt, preserves taskId & execution history, and arms next run
    const afterCompletionTask = service.createTask({
      title: 'After Completion Cycle Task',
      workspaceId: 'proj-alpha',
      dueAt: fakeNow - 1000,
      subgoals: [{ title: 'Verify report', required: true }],
      schedule: {
        enabled: true,
        mode: 'after_completion',
        intervalDays: 3,
        atHour: 9,
        atMinute: 0,
        timeZone: 'UTC',
      },
    })
    await service.dispatchTask(afterCompletionTask.id, { mode: 'new' })
    const sgId = service.getTask(afterCompletionTask.id)!.subgoals[0].id
    service.updateSubgoal(afterCompletionTask.id, sgId, { status: 'done' })
    expect(service.getTask(afterCompletionTask.id)?.phase).toBe('needs_you')

    const accepted = service.completeScheduleCycle(afterCompletionTask.id)
    expect(accepted.id).toBe(afterCompletionTask.id)
    expect(accepted.phase).toBe('todo')
    expect(accepted.dueAt).toBeUndefined()
    expect(accepted.subgoals[0].status).toBe('open')
    expect(accepted.executions).toHaveLength(1)
    expect(accepted.schedule?.nextRunAt).toBe(Date.UTC(2026, 4, 15, 9, 0, 0))

    // 5. action: 'remind' zero-token trigger (does NOT call agentBridge)
    const callsBeforeRemind = launchedCalls.length
    const remindTask = service.createTask({
      title: 'Zero Token Schedule Reminder',
      permission: 'danger-full-access', // Even with elevated permission, remind does not launch AI
      schedule: {
        enabled: true,
        mode: 'cron',
        cron: '25 9 * * *',
        timeZone: 'UTC',
        action: 'remind',
      },
    })
    fakeNow = Date.UTC(2026, 4, 12, 9, 25, 0)
    const remindTick = await service.runSchedulerTick(fakeNow)
    expect(remindTick.firedSchedules).toContain(remindTask.id)
    expect(launchedCalls.length).toBe(callsBeforeRemind)
    const reminded = service.getTask(remindTask.id)!
    expect(reminded.phase).toBe('needs_you')
    expect(reminded.subPhase).toBe('reminder_due')
    expect(reminded.blockedReason).toBe('Scheduled reminder due')

    // 6. runScheduleNow preserves future once schedule, skipScheduleCycle advances cron, clear removes schedule
    const futureOnce = service.createTask({
      title: 'Future Once Run Now',
      workspaceId: 'proj-alpha',
      schedule: { enabled: true, mode: 'once', at: fakeNow + 3_600_000, timeZone: 'UTC' },
    })
    const ranNow = await service.runScheduleNow(futureOnce.id)
    expect(ranNow.schedule?.runCount).toBe(1)
    expect(ranNow.schedule?.enabled).toBe(true)
    expect(ranNow.schedule?.nextRunAt).toBe(fakeNow + 3_600_000)

    const cronToSkip = service.createTask({
      title: 'Skip Cycle Cron',
      workspaceId: 'proj-alpha',
      schedule: { enabled: true, mode: 'cron', cron: '0 10 * * *', timeZone: 'UTC' },
    })
    const firstNext = service.getTask(cronToSkip.id)!.schedule!.nextRunAt!
    const skipped = service.skipScheduleCycle(cronToSkip.id)
    expect(skipped.schedule?.nextRunAt).toBeGreaterThan(firstNext)
    expect(skipped.schedule?.skippedReason).toBe('skipped')

    const cleared = service.setTaskSchedule(cronToSkip.id, { clear: true })
    expect(cleared.schedule).toBeUndefined()
  })

  it('migrates v2 DB to 0003 (pinned_at / snoozed_until), auto-unsnoozes on needs_you, and executes atomic batchTasks', async () => {
    // 1. Construct a real v2 SQLite DB without pinned_at / snoozed_until columns
    const legacyDbPath = join(tmpRoot, 'legacy-v2.db')
    const raw = new DatabaseSync(legacyDbPath)
    raw.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
      CREATE TABLE board_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, root_path TEXT NOT NULL, folder_paths_json TEXT NOT NULL DEFAULT '[]', antigravity_project_id TEXT, source TEXT NOT NULL DEFAULT 'custom', pinned INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL DEFAULT '', phase TEXT NOT NULL DEFAULT 'todo', sub_phase TEXT NOT NULL DEFAULT 'ready', status TEXT NOT NULL DEFAULT 'pending', priority TEXT NOT NULL DEFAULT 'normal', workspace_id TEXT, workspace_path TEXT, workspace_label TEXT, blocked_reason TEXT, next_action TEXT, due_at INTEGER, reminder_at INTEGER, reminded_at INTEGER, sort_order INTEGER NOT NULL DEFAULT 0, write_gate TEXT NOT NULL DEFAULT 'unlocked', mode TEXT, model TEXT, reasoning_effort TEXT, permission TEXT, permission_confirmed_at INTEGER, reuse_session INTEGER NOT NULL DEFAULT 1, freeze_json TEXT, handover_json TEXT, tags_json TEXT NOT NULL DEFAULT '[]', schedule_json TEXT, plan_revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER, archived_at INTEGER, use_worktree INTEGER NOT NULL DEFAULT 0, worktree_path TEXT, worktree_branch TEXT);
      CREATE TABLE task_subgoals (id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'custom', required INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'open', sort_order INTEGER NOT NULL DEFAULT 0, dependencies_json TEXT NOT NULL DEFAULT '[]', added_by TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL, closed_at INTEGER, PRIMARY KEY (task_id, id));
      CREATE TABLE task_refs (id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, subgoal_id TEXT, kind TEXT NOT NULL, target TEXT NOT NULL, label TEXT, round INTEGER, added_by TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL);
      CREATE TABLE task_conversations (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, subgoal_id TEXT NOT NULL DEFAULT '', conversation_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'primary', workspace_id TEXT, linked_at INTEGER NOT NULL, PRIMARY KEY (task_id, subgoal_id, conversation_id));
      CREATE TABLE task_executions (id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, subgoal_id TEXT, conversation_id TEXT, workspace_id TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, result TEXT, error TEXT, summary TEXT, initiated_by TEXT, rework_instructions TEXT, frozen_at INTEGER);
      CREATE TABLE task_events (id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, subgoal_id TEXT, conversation_id TEXT, kind TEXT NOT NULL, source TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
      CREATE TABLE task_user_marks (task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, ignored_at INTEGER, acked_at INTEGER, updated_at INTEGER NOT NULL);
      CREATE TABLE task_comments (id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, author TEXT NOT NULL DEFAULT 'user', body_md TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, '0001_init_board', 1000), (2, '0002_comments_worktree_subgoal_pk', 1000);
      INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t-v2', 'Legacy v2 Task', 1000, 1000);
      INSERT INTO task_user_marks (task_id, acked_at, updated_at) VALUES ('t-v2', 1000, 1000);
    `)
    raw.close()

    const migratedDb = new BoardDatabase(legacyDbPath)
    try {
      const mRow = migratedDb.db.prepare('SELECT version, name FROM schema_migrations WHERE version = 3').get() as {
        version: number
        name: string
      }
      expect(mRow).toEqual({ version: 3, name: '0003_user_marks_focus_snooze' })

      const v4Row = migratedDb.db
        .prepare('SELECT version, name FROM schema_migrations WHERE version = 4')
        .get() as { version: number; name: string }
      expect(v4Row).toEqual({ version: 4, name: '0004_draft_origin_handoff_capsule' })
      const legacyTask = migratedDb.getTask('t-v2')!
      expect(legacyTask.createdBy).toBe('user')
      expect(legacyTask.originConversationId).toBeUndefined()
      expect(legacyTask.reuseSession).toBe(true) // legacy rows keep hard-resume
      const convCols = new Set(
        (migratedDb.db.prepare('PRAGMA table_info(task_conversations)').all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      )
      expect(convCols.has('summary')).toBe(true)
      expect(convCols.has('include_in_handoff')).toBe(true)

      const fakeNow = 2_000_000
      const service = new BoardService(migratedDb, paths, {
        now: () => fakeNow,
        agentBridge: makeMockBridge(),
      })

      // 2. Pin & Snooze persistence + createTask({ pin: true })
      const snoozeTarget = fakeNow + 3_600_000
      const marked = service.setUserMarks('t-v2', { pin: true, snoozeUntil: snoozeTarget })
      expect(marked.userMarks?.pinnedAt).toBe(fakeNow)
      expect(marked.userMarks?.snoozedUntil).toBe(snoozeTarget)
      expect(marked.userMarks?.ackedAt).toBe(1000)

      const pinnedCreated = service.createTask({ title: 'Pinned On Create', pin: true, subPhase: 'backlog' })
      expect(pinnedCreated.subPhase).toBe('backlog')
      expect(pinnedCreated.userMarks?.pinnedAt).toBe(fakeNow)

      // 3. Auto-unsnooze on entering needs_you (via transitionPhase, Stop hook, settleExecution, reminder)
      const transitioned = service.transitionPhase('t-v2', 'needs_you', { subPhase: 'needs_input' })
      expect(transitioned.userMarks?.snoozedUntil).toBeUndefined()

      // Via Hook Stop
      const hookTask = service.createTask({ title: 'Hook Auto Unsnooze', workspaceId: 'proj-alpha' })
      await service.dispatchTask(hookTask.id, { mode: 'new' })
      service.setUserMarks(hookTask.id, { snoozeUntil: fakeNow + 7_200_000 })
      expect(service.getTask(hookTask.id)?.userMarks?.snoozedUntil).toBe(fakeNow + 7_200_000)
      service.handleHookEvent({
        hookEventName: 'Stop',
        conversationId: 'conv-new-1',
        terminationReason: 'NO_TOOL_CALL',
      })
      expect(service.getTask(hookTask.id)?.phase).toBe('needs_you')
      expect(service.getTask(hookTask.id)?.userMarks?.snoozedUntil).toBeUndefined()

      // Via settleExecution
      const settleTask = service.createTask({ title: 'Settle Auto Unsnooze', workspaceId: 'proj-alpha' })
      await service.dispatchTask(settleTask.id, { mode: 'new' })
      service.setUserMarks(settleTask.id, { snoozeUntil: fakeNow + 7_200_000 })
      service.settleExecution(settleTask.id, 'succeeded')
      expect(service.getTask(settleTask.id)?.userMarks?.snoozedUntil).toBeUndefined()

      // Via scheduler reminder
      const remTask = service.createTask({ title: 'Reminder Auto Unsnooze', reminderAt: fakeNow - 100 })
      service.setUserMarks(remTask.id, { snoozeUntil: fakeNow + 7_200_000 })
      await service.runSchedulerTick(fakeNow)
      expect(service.getTask(remTask.id)?.phase).toBe('needs_you')
      expect(service.getTask(remTask.id)?.userMarks?.snoozedUntil).toBeUndefined()

      // 4. Atomic batchTasks & active-execution guard
      const b1 = service.createTask({ title: 'Batch One', subPhase: 'ready' })
      const b2 = service.createTask({ title: 'Batch Two', subPhase: 'ready' })
      const revBefore = migratedDb.getRevision()

      const subRes = service.batchTasks({ taskIds: [b1.id, b2.id], action: 'set_sub_phase', subPhase: 'backlog' })
      expect(subRes.affectedIds).toEqual([b1.id, b2.id])
      expect(migratedDb.getRevision()).toBe(revBefore + 1)
      expect(service.getTask(b1.id)?.subPhase).toBe('backlog')
      expect(service.getTask(b2.id)?.subPhase).toBe('backlog')

      service.batchTasks({ taskIds: [b1.id, b2.id], action: 'set_priority', priority: 'urgent' })
      expect(service.getTask(b1.id)?.priority).toBe('urgent')

      service.batchTasks({ taskIds: [b1.id, b2.id], action: 'set_workspace', workspaceId: 'proj-alpha' })
      expect(service.getTask(b1.id)?.workspaceId).toBe('proj-alpha')

      // Active running task blocks batch delete atomically (b1 must NOT be deleted)
      const runningBatchTask = service.createTask({ title: 'Batch Running', workspaceId: 'proj-alpha' })
      await service.dispatchTask(runningBatchTask.id, { mode: 'new' })
      expect(() =>
        service.batchTasks({ taskIds: [b1.id, runningBatchTask.id], action: 'delete' }),
      ).toThrow(/execution-open/)
      expect(service.getTask(b1.id)).toBeDefined()

      expect(() =>
        service.batchTasks({ taskIds: [b1.id, runningBatchTask.id], action: 'archive' }),
      ).toThrow(/execution-open/)
      expect(service.getTask(b1.id)?.archivedAt).toBeUndefined()

      // Archive + unarchive + delete when idle
      service.batchTasks({ taskIds: [b1.id, b2.id], action: 'archive' })
      expect(service.getTask(b1.id)?.archivedAt).toBe(fakeNow)
      service.batchTasks({ taskIds: [b1.id, b2.id], action: 'unarchive' })
      expect(service.getTask(b1.id)?.archivedAt).toBeUndefined()
      service.batchTasks({ taskIds: [b1.id, b2.id], action: 'delete' })
      expect(service.getTask(b1.id)).toBeUndefined()
      expect(service.getTask(b2.id)).toBeUndefined()
    } finally {
      migratedDb.close()
    }
  })
})
