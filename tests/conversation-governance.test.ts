import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildBoardApiRoutes } from '../src/entry/router.ts'
import {
  BOARD_CONVERSATION_TAG,
  BoardDatabase,
  BoardService,
  DEFAULT_CONVERSATION_GOVERNANCE,
  DEFAULT_CONVERSATION_GROUP_ID,
  DefaultAgentBridge,
  formatGovernedConversationTitle,
  resolveHostPaths,
  type AgentBridge,
  type UpdateConversationAnnotations,
} from '../src/host/index.ts'

describe('Antigravity 2.35+ conversation governance', () => {
  let tmpRoot: string
  let db: BoardDatabase
  let paths: ReturnType<typeof resolveHostPaths>

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'agy-board-gov-'))
    const geminiConfigDir = join(tmpRoot, 'gemini-config')
    const agyDataDir = join(tmpRoot, 'gemini-antigravity')
    mkdirSync(join(geminiConfigDir, 'projects'), { recursive: true })
    mkdirSync(agyDataDir, { recursive: true })
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

  it('matches ConversationService UpdateConversation & CreateConversation HTTP+JSON contract', async () => {
    const received: Array<{
      url: string
      headers: IncomingMessage['headers']
      body: Record<string, unknown>
    }> = []

    const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
        received.push({ url: req.url ?? '', headers: req.headers, body })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        if (req.url?.endsWith('/CreateConversation')) {
          res.end(JSON.stringify({ conversation: { id: 'conv-connect-101' } }))
          return
        }
        res.end(
          JSON.stringify({
            id: body.conversationId ?? 'conv-connect-101',
            annotations: body.annotations ?? {},
          }),
        )
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    try {
      const bridge = new DefaultAgentBridge(paths, {
        env: {
          ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${port}`,
          ANTIGRAVITY_CSRF_TOKEN: 'csrf-test-token',
        },
        useDaemonDiscovery: false,
      })

      const created = await bridge.createConversation({
        prompt: 'Audit build pipeline',
        title: '[Board] Audit build pipeline',
        tags: ['agy-board', ' ci ', 'agy-board', ''],
      })
      expect(created.conversationId).toBe('conv-connect-101')

      await bridge.updateConversation('conv-connect-101', {
        title: '[Board] Audit build pipeline',
        tags: ['agy-board', 'ci', 'agy-board'],
        conversationGroupId: 'agy-board',
      })

      // Clearing group uses explicit empty string while omitting unset fields
      await bridge.updateConversation('conv-connect-101', {
        conversationGroupId: '',
        tags: [],
      })

      // Archiving sends archived: true only
      await bridge.updateConversation('conv-connect-101', {
        archived: true,
      })

      // Empty annotations is a no-op and sends no HTTP request
      const noop = await bridge.updateConversation('conv-connect-101', {})
      expect(noop).toEqual({})

      expect(received).toHaveLength(4)

      expect(received[0].url).toBe('/product.v1.ConversationService/CreateConversation')
      expect(received[0].headers['connect-protocol-version']).toBe('1')
      expect(received[0].headers['x-antigravity-csrf-token']).toBe('csrf-test-token')
      expect(received[0].body.tags).toEqual(['agy-board', 'ci'])

      expect(received[1].url).toBe('/product.v1.ConversationService/UpdateConversation')
      expect(received[1].body).toEqual({
        conversationId: 'conv-connect-101',
        annotations: {
          title: '[Board] Audit build pipeline',
          tags: ['agy-board', 'ci'],
          conversationGroupId: 'agy-board',
        },
      })

      expect(received[2].url).toBe('/product.v1.ConversationService/UpdateConversation')
      expect(received[2].body).toEqual({
        conversationId: 'conv-connect-101',
        annotations: {
          conversationGroupId: '',
        },
      })

      expect(received[3].url).toBe('/product.v1.ConversationService/UpdateConversation')
      expect(received[3].body).toEqual({
        conversationId: 'conv-connect-101',
        annotations: {
          archived: true,
        },
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('auto-renames, tags, and groups on dispatchTask(new), respects config toggles, skips resume/rework, and degrades gracefully on errors', async () => {
    let seq = 0
    let failUpdates = false
    const startCalls: Array<{ title?: string; tags?: string[] }> = []
    const updateCalls: Array<{ conversationId: string; annotations: UpdateConversationAnnotations }> = []

    const bridge: AgentBridge = {
      async startConversation(req) {
        seq += 1
        startCalls.push({ title: req.title, tags: req.tags })
        return { conversationId: `conv-gov-${seq}`, raw: { id: `conv-gov-${seq}` } }
      },
      async sendMessage(req) {
        return { conversationId: req.conversationId, raw: { id: req.conversationId } }
      },
      async getConversationMetadata(id) {
        return { conversationId: id }
      },
      async jumpToConversation(id) {
        return { ok: true, method: 'cdp', conversationId: id }
      },
      async updateConversation(conversationId, annotations) {
        if (failUpdates) throw new Error('LS unavailable (2.34)')
        updateCalls.push({ conversationId, annotations })
        return { id: conversationId, annotations }
      },
    }

    const service = new BoardService(db, paths, { agentBridge: bridge })
    expect(service.getConversationGovernanceConfig()).toEqual(DEFAULT_CONVERSATION_GOVERNANCE)
    expect(formatGovernedConversationTitle('[Board] Already Prefixed', undefined, '[Board]')).toBe(
      '[Board] Already Prefixed',
    )

    // 1. Default dispatch applies title, tags, and conversationGroupId
    const task = service.createTask({
      title: 'Sidebar governance rollout',
      tags: [{ name: 'infra' }, { name: 'agy-board' }],
      subgoals: [{ title: 'Wire UpdateConversation', required: true }],
    })
    const dispatched = await service.dispatchTask(task.id, {
      mode: 'new',
      subgoalId: task.subgoals[0].id,
    })
    expect(dispatched.conversationId).toBe('conv-gov-1')
    expect(startCalls[0]).toEqual({
      title: '[Board] Sidebar governance rollout · Wire UpdateConversation',
      tags: [BOARD_CONVERSATION_TAG, 'infra'],
    })
    expect(updateCalls).toEqual([
      {
        conversationId: 'conv-gov-1',
        annotations: {
          title: '[Board] Sidebar governance rollout · Wire UpdateConversation',
          tags: [BOARD_CONVERSATION_TAG, 'infra'],
          conversationGroupId: DEFAULT_CONVERSATION_GROUP_ID,
        },
      },
    ])

    // 2. Rework / resume do not clobber existing conversation annotations
    service.settleExecution(task.id, 'succeeded')
    const countBeforeRework = updateCalls.length
    await service.dispatchTask(task.id, {
      mode: 'rework',
      conversationId: 'conv-gov-1',
      reworkInstructions: 'Tighten error handling',
    })
    expect(updateCalls).toHaveLength(countBeforeRework)

    // 3. Custom governance toggles persist in board_meta across BoardService instances
    service.updateConversationGovernanceConfig({
      autoRename: true,
      titlePrefix: '[Kanban]',
      autoTag: false,
      autoGroup: true,
      conversationGroupId: 'custom-board-group',
    })
    const reloadedService = new BoardService(db, paths, { agentBridge: bridge })
    expect(reloadedService.getConversationGovernanceConfig()).toEqual({
      autoRename: true,
      titlePrefix: '[Kanban]',
      autoTag: false,
      autoGroup: true,
      conversationGroupId: 'custom-board-group',
      autoArchiveOnFinish: true,
    })

    const task2 = reloadedService.createTask({ title: 'Custom group check', tags: [{ name: 'ui' }] })
    await reloadedService.dispatchTask(task2.id, { mode: 'new' })
    expect(updateCalls.at(-1)).toEqual({
      conversationId: 'conv-gov-2',
      annotations: {
        title: '[Kanban] Custom group check',
        conversationGroupId: 'custom-board-group',
      },
    })

    // 4. All dispatch toggles off -> skips updateConversation completely
    reloadedService.updateConversationGovernanceConfig({
      autoRename: false,
      autoTag: false,
      autoGroup: false,
    })
    const countBeforeDisabled = updateCalls.length
    const task3 = reloadedService.createTask({ title: 'No-op governance task' })
    await reloadedService.dispatchTask(task3.id, { mode: 'new' })
    expect(updateCalls).toHaveLength(countBeforeDisabled)

    // 5. Fault-tolerant degradation when updateConversation fails
    reloadedService.updateConversationGovernanceConfig({ autoRename: true, autoTag: true, autoGroup: true })
    failUpdates = true
    const task4 = reloadedService.createTask({ title: 'Offline LS task' })
    const offlineDispatch = await reloadedService.dispatchTask(task4.id, { mode: 'new' })
    expect(offlineDispatch.conversationId).toBe('conv-gov-4')
    expect(offlineDispatch.task.phase).toBe('active')
  })

  it('auto-archives conversations on close, archive, completeScheduleCycle, and batchTasks while protecting origin & shared open chats', async () => {
    let seq = 0
    let failArchiveFor = new Set<string>()
    const archivedCalls: Array<{ conversationId: string; annotations: UpdateConversationAnnotations }> = []

    const bridge: AgentBridge = {
      async startConversation() {
        seq += 1
        return { conversationId: `conv-life-${seq}`, raw: { id: `conv-life-${seq}` } }
      },
      async sendMessage(req) {
        return { conversationId: req.conversationId, raw: { id: req.conversationId } }
      },
      async getConversationMetadata(id) {
        return { conversationId: id }
      },
      async jumpToConversation(id) {
        return { ok: true, method: 'cdp', conversationId: id }
      },
      async updateConversation(conversationId, annotations) {
        if (annotations.archived && failArchiveFor.has(conversationId)) {
          throw new Error(`Archive failed for ${conversationId}`)
        }
        if (annotations.archived) {
          archivedCalls.push({ conversationId, annotations })
        }
        return { id: conversationId, annotations }
      },
    }

    const service = new BoardService(db, paths, { agentBridge: bridge })

    // 1. transitionPhase(closed) archives primary chat but NOT origin/reference or shared open chat
    const sharedOpenTask = service.createTask({ title: 'Still active sibling' })
    service.linkConversation(sharedOpenTask.id, { conversationId: 'conv-shared-open', role: 'primary' })

    const closeTask = service.createTask({ title: 'Close sync task' })
    service.linkConversation(closeTask.id, { conversationId: 'conv-origin-main', role: 'origin' })
    service.linkConversation(closeTask.id, { conversationId: 'conv-ref-note', role: 'reference' })
    service.linkConversation(closeTask.id, { conversationId: 'conv-shared-open', role: 'worker' })
    await service.dispatchTask(closeTask.id, { mode: 'new' }) // conv-life-1
    service.settleExecution(closeTask.id, 'succeeded')

    service.transitionPhase(closeTask.id, 'closed', { subPhase: 'done' })
    await service.flushConversationGovernance()
    expect(archivedCalls.map((c) => c.conversationId)).toEqual(['conv-life-1'])
    expect(archivedCalls[0].annotations).toEqual({ archived: true })

    // 2. archiveTask archives linked primary conversation
    archivedCalls.length = 0
    const archTask = service.createTask({ title: 'Archive sync task' })
    await service.dispatchTask(archTask.id, { mode: 'new' }) // conv-life-2
    service.settleExecution(archTask.id, 'succeeded')
    service.archiveTask(archTask.id)
    await service.flushConversationGovernance()
    expect(archivedCalls.map((c) => c.conversationId)).toEqual(['conv-life-2'])

    // 3. completeScheduleCycle archives completed round's chat (for sessionMode: 'new'), skips when auto + reuseSession
    archivedCalls.length = 0
    const cycleTask = service.createTask({
      title: 'Recurring digest',
      schedule: {
        enabled: true,
        mode: 'after_completion',
        intervalDays: 2,
        sessionMode: 'new',
        timeZone: 'UTC',
      },
    })
    await service.dispatchTask(cycleTask.id, { mode: 'new' }) // conv-life-3
    service.settleExecution(cycleTask.id, 'succeeded')
    service.completeScheduleCycle(cycleTask.id)
    await service.flushConversationGovernance()
    expect(archivedCalls.map((c) => c.conversationId)).toEqual(['conv-life-3'])

    archivedCalls.length = 0
    const resumeCycleTask = service.createTask({
      title: 'Recurring reuse chat',
      reuseSession: true,
      schedule: {
        enabled: true,
        mode: 'after_completion',
        intervalDays: 2,
        sessionMode: 'auto',
        timeZone: 'UTC',
      },
    })
    await service.dispatchTask(resumeCycleTask.id, { mode: 'new' }) // conv-life-4
    service.settleExecution(resumeCycleTask.id, 'succeeded')
    service.completeScheduleCycle(resumeCycleTask.id)
    await service.flushConversationGovernance()
    expect(archivedCalls).toHaveLength(0)

    // 4. batchTasks('close') and batchTasks('archive') sync archive cleanly
    archivedCalls.length = 0
    const b1 = service.createTask({ title: 'Batch close 1' })
    const b2 = service.createTask({ title: 'Batch archive 2' })
    await service.dispatchTask(b1.id, { mode: 'new' }) // conv-life-5
    service.settleExecution(b1.id, 'succeeded')
    await service.dispatchTask(b2.id, { mode: 'new' }) // conv-life-6
    service.settleExecution(b2.id, 'succeeded')

    service.batchTasks({ taskIds: [b1.id], action: 'close' })
    await service.flushConversationGovernance()
    expect(archivedCalls.map((c) => c.conversationId)).toEqual(['conv-life-5'])

    archivedCalls.length = 0
    service.batchTasks({ taskIds: [b2.id], action: 'archive' })
    await service.flushConversationGovernance()
    expect(archivedCalls.map((c) => c.conversationId)).toEqual(['conv-life-6'])

    // 5. Turning off autoArchiveOnFinish suppresses automatic archiving; failure does not throw
    service.updateConversationGovernanceConfig({ autoArchiveOnFinish: false })
    archivedCalls.length = 0
    const quietTask = service.createTask({ title: 'Keep sidebar open' })
    await service.dispatchTask(quietTask.id, { mode: 'new' }) // conv-life-7
    service.settleExecution(quietTask.id, 'succeeded')
    service.transitionPhase(quietTask.id, 'closed')
    await service.flushConversationGovernance()
    expect(archivedCalls).toHaveLength(0)

    // 6. Router endpoints: GET /api/conversations/governance, POST /api/conversations/governance/update, POST /api/conversations/cleanup-finished
    const routes = new Map(buildBoardApiRoutes(service).map((r) => [`${r.method} ${r.path}`, r.handler]))
    const getGov = routes.get('GET /api/conversations/governance')!
    const updateGov = routes.get('POST /api/conversations/governance/update')!
    const cleanupRoute = routes.get('POST /api/conversations/cleanup-finished')!

    const govRes = (await getGov({})) as { ok: boolean; config: { autoArchiveOnFinish: boolean } }
    expect(govRes.ok).toBe(true)
    expect(govRes.config.autoArchiveOnFinish).toBe(false)

    const updatedGov = (await updateGov({ autoArchiveOnFinish: true })) as {
      ok: boolean
      config: { autoArchiveOnFinish: boolean }
    }
    expect(updatedGov.ok).toBe(true)
    expect(updatedGov.config.autoArchiveOnFinish).toBe(true)

    // Dry-run cleanup previews candidates and skipped shared chat without calling updateConversation
    archivedCalls.length = 0
    const dryRes = (await cleanupRoute({ dryRun: true })) as {
      ok: boolean
      available: boolean
      dryRun: boolean
      candidateCount: number
      archivedIds: string[]
      skippedIds: string[]
    }
    expect(dryRes.ok).toBe(true)
    expect(dryRes.available).toBe(true)
    expect(dryRes.dryRun).toBe(true)
    expect(dryRes.candidateCount).toBeGreaterThanOrEqual(4)
    expect(dryRes.archivedIds).toEqual([])
    expect(dryRes.skippedIds).toContain('conv-shared-open')
    expect(archivedCalls).toHaveLength(0)

    // Live cleanup handles partial failures gracefully without aborting other conversations
    failArchiveFor = new Set(['conv-life-2'])
    const liveRes = (await cleanupRoute({})) as {
      ok: boolean
      archivedIds: string[]
      failedIds: string[]
      skippedIds: string[]
      errors: Array<{ conversationId: string; error: string }>
    }
    expect(liveRes.ok).toBe(true)
    expect(liveRes.archivedIds).toContain('conv-life-1')
    expect(liveRes.archivedIds).toContain('conv-life-5')
    expect(liveRes.archivedIds).toContain('conv-life-6')
    expect(liveRes.archivedIds).toContain('conv-life-7')
    expect(liveRes.archivedIds).not.toContain('conv-origin-main')
    expect(liveRes.archivedIds).not.toContain('conv-ref-note')
    expect(liveRes.archivedIds).not.toContain('conv-shared-open')
    expect(liveRes.failedIds).toEqual(['conv-life-2'])
    expect(liveRes.errors).toHaveLength(1)

    // 7. Protected origin & reference conversations stay excluded even if present in settled task_executions
    archivedCalls.length = 0
    const protectedExecTask = service.createTask({ title: 'Origin/Reference with settled executions' })
    service.linkConversation(protectedExecTask.id, { conversationId: 'conv-origin-exec', role: 'origin' })
    service.linkConversation(protectedExecTask.id, { conversationId: 'conv-ref-exec', role: 'reference' })
    await service.dispatchTask(protectedExecTask.id, { mode: 'resume', conversationId: 'conv-origin-exec' })
    service.settleExecution(protectedExecTask.id, 'succeeded')
    await service.dispatchTask(protectedExecTask.id, { mode: 'resume', conversationId: 'conv-ref-exec' })
    service.settleExecution(protectedExecTask.id, 'succeeded')

    service.transitionPhase(protectedExecTask.id, 'closed', { subPhase: 'done' })
    await service.flushConversationGovernance()
    expect(archivedCalls.map((c) => c.conversationId)).not.toContain('conv-origin-exec')
    expect(archivedCalls.map((c) => c.conversationId)).not.toContain('conv-ref-exec')

    const protectedCleanup = (await cleanupRoute({})) as { archivedIds: string[] }
    expect(protectedCleanup.archivedIds).not.toContain('conv-origin-exec')
    expect(protectedCleanup.archivedIds).not.toContain('conv-ref-exec')

    // 8. Force-closing a task with an open execution settles the execution and still auto-archives its conversation
    archivedCalls.length = 0
    const forceCloseTask = service.createTask({ title: 'Force accept & auto-archive' })
    const forceDispatched = await service.dispatchTask(forceCloseTask.id, { mode: 'new' })
    const forceClosed = service.transitionPhase(forceCloseTask.id, 'closed', { subPhase: 'done', force: true })
    await service.flushConversationGovernance()
    expect(forceClosed.executions[0]?.endedAt).toBeDefined()
    expect(forceClosed.executions[0]?.result).toBe('succeeded')
    expect(archivedCalls.map((c) => c.conversationId)).toEqual([forceDispatched.conversationId])
  })
})
