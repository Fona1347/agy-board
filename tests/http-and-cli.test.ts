import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseCliArgs, runCli } from '../src/entry/cli.ts'
import { startStandaloneServer, type StandaloneServerHandle } from '../src/entry/sidecar.ts'
import { DefaultAgentBridge, resolveHostPaths, selectHubTarget } from '../src/host/index.ts'

const execFileAsync = promisify(execFile)
const REPO_ROOT = resolve(import.meta.dirname, '..')
const SIDECAR_BUNDLE = join(REPO_ROOT, 'sidecars', 'board', 'server.mjs')
const CLI_BUNDLE = join(REPO_ROOT, 'dist', 'cli.mjs')

describe('HTTP Sidecar API, SSE live sync, CDP Jump, and CLI', () => {
  let tmpRoot: string
  let serverHandle: StandaloneServerHandle | undefined

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'agy-board-http-'))
    mkdirSync(join(tmpRoot, 'gemini-config', 'projects'), { recursive: true })
    mkdirSync(join(tmpRoot, 'gemini-antigravity'), { recursive: true })
    mkdirSync(join(tmpRoot, 'repo'), { recursive: true })
    writeFileSync(join(tmpRoot, 'repo', 'README.md'), '# Repo Docs\nHello Agy Board')
  })

  afterEach(async () => {
    if (serverHandle) {
      await serverHandle.close()
      serverHandle = undefined
    }
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('serves API routes, previews registered refs, enforces permission gate, and pushes SSE revisions', async () => {
    let convSeq = 0
    serverHandle = await startStandaloneServer({
      port: 0,
      paths: {
        dbPath: join(tmpRoot, 'board.db'),
        geminiConfigDir: join(tmpRoot, 'gemini-config'),
        antigravityDataDir: join(tmpRoot, 'gemini-antigravity'),
      },
      boardOptions: {
        agentBridge: {
          async startConversation(req) {
            convSeq += 1
            return { conversationId: `conv-http-${convSeq}`, raw: { title: req.title } }
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
      },
    })

    const base = serverHandle.url

    // Open SSE stream
    const sseController = new AbortController()
    const sseRes = await fetch(`${base}/api/events`, { signal: sseController.signal })
    expect(sseRes.status).toBe(200)
    const reader = sseRes.body!.getReader()
    const firstChunk = await reader.read()
    expect(Buffer.from(firstChunk.value ?? new Uint8Array()).toString('utf8')).toContain('event: revision')

    // Create elevated task via HTTP POST
    const createRes = await fetch(`${base}/api/tasks/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'HTTP End-to-End Task',
        workspacePath: join(tmpRoot, 'repo'),
        permission: 'workspace-write',
        refs: [{ kind: 'file', target: 'README.md' }],
      }),
    })
    expect(createRes.status).toBe(200)
    const created = (await createRes.json()) as { task: { id: string; refs: Array<{ id: string }> } }

    // SSE receives revision bump
    const nextChunk = await reader.read()
    expect(Buffer.from(nextChunk.value ?? new Uint8Array()).toString('utf8')).toContain('event: revision')
    sseController.abort()

    // Dispatch fails with 409 confirmation-required until human confirms
    const blockedDispatch = await fetch(`${base}/api/tasks/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: created.task.id, mode: 'new' }),
    })
    expect(blockedDispatch.status).toBe(409)

    await fetch(`${base}/api/tasks/confirm-permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: created.task.id }),
    })

    const okDispatch = await fetch(`${base}/api/tasks/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: created.task.id, mode: 'new' }),
    })
    expect(okDispatch.status).toBe(200)
    const dispJson = (await okDispatch.json()) as { conversationId: string }
    expect(dispJson.conversationId).toBe('conv-http-1')

    // Preview registered README.md
    const prevRes = await fetch(
      `${base}/api/tasks/ref/preview?taskId=${created.task.id}&refId=${created.task.refs[0].id}`,
    )
    const prevJson = (await prevRes.json()) as { ok: boolean; content: string }
    expect(prevJson.ok).toBe(true)
    expect(prevJson.content).toContain('# Repo Docs')

    // CLI doctor against non-existent DB must stay 100% read-only
    const phantomDb = join(tmpRoot, 'phantom-doctor.db')
    const phantomDoc = await runCli(['doctor', '--json', '--db', phantomDb], {
      geminiConfigDir: join(tmpRoot, 'gemini-config'),
      antigravityDataDir: join(tmpRoot, 'gemini-antigravity'),
    })
    expect(phantomDoc.exitCode).toBe(0)
    expect(JSON.parse(phantomDoc.output).dbExists).toBe(false)
    expect(existsSync(phantomDb)).toBe(false)

    // CLI doctor & list against same DB
    const doc = await runCli(['doctor', '--json', '--db', join(tmpRoot, 'board.db')], {
      geminiConfigDir: join(tmpRoot, 'gemini-config'),
      antigravityDataDir: join(tmpRoot, 'gemini-antigravity'),
    })
    expect(doc.exitCode).toBe(0)
    expect(JSON.parse(doc.output).ok).toBe(true)
  })

  it('navigates loopback CDP WebSocket on jumpToConversation and rejects invalid conversation ids', async () => {
    let evaluatedExpr = ''
    const mockCdp = createHttpServer((req, res) => {
      if (req.url === '/json/list') {
        const addr = mockCdp.address() as { port: number }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify([
            {
              type: 'page',
              title: 'Agy Board',
              url: 'http://127.0.0.1:17919/',
              webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/page/board-self`,
            },
            {
              type: 'page',
              title: 'Caller Tab',
              url: 'http://127.0.0.1:17920/',
              webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/page/caller`,
            },
            {
              type: 'page',
              title: 'Antigravity',
              url: `http://127.0.0.1:${addr.port}/c/old`,
              webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/page/1`,
            },
          ]),
        )
        return
      }
      res.writeHead(404)
      res.end()
    })

    const upgradedSockets = new Set<import('node:stream').Duplex>()
    const upgradedPaths: string[] = []
    mockCdp.on('upgrade', (req, socket) => {
      upgradedPaths.push(String(req.url ?? ''))
      upgradedSockets.add(socket)
      socket.on('close', () => upgradedSockets.delete(socket))
      const key = String(req.headers['sec-websocket-key'])
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      )
      let wsBuf = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        wsBuf = Buffer.concat([wsBuf, chunk])
        while (wsBuf.length >= 2) {
          const len = wsBuf[1] & 0x7f
          let offset = 2
          let actualLen = len
          if (len === 126) {
            if (wsBuf.length < 4) return
            actualLen = wsBuf.readUInt16BE(2)
            offset = 4
          }
          if (wsBuf.length < offset + 4 + actualLen) return
          const mask = wsBuf.subarray(offset, offset + 4)
          const payload = Buffer.allocUnsafe(actualLen)
          for (let i = 0; i < actualLen; i += 1) payload[i] = wsBuf[offset + 4 + i] ^ mask[i & 3]
          wsBuf = wsBuf.subarray(offset + 4 + actualLen)
          const msg = JSON.parse(payload.toString('utf8')) as {
            id: number
            method: string
            params?: { expression?: string }
          }
          const sendReply = (obj: unknown) => {
            const reply = Buffer.from(JSON.stringify(obj))
            const hdr =
              reply.length < 126
                ? Buffer.from([0x81, reply.length])
                : Buffer.from([0x81, 126, reply.length >> 8, reply.length & 0xff])
            socket.write(Buffer.concat([hdr, reply]))
          }
          if (msg.method === 'Runtime.evaluate') {
            evaluatedExpr = msg.params?.expression ?? ''
            sendReply({ id: msg.id, result: { result: { value: '/c/conv-target-42' } } })
          } else if (msg.method === 'Page.bringToFront') {
            sendReply({ id: msg.id, result: {} })
          }
        }
      })
    })

    await new Promise<void>((r) => mockCdp.listen(0, '127.0.0.1', () => r()))
    const port = (mockCdp.address() as { port: number }).port
    const portFile = join(tmpRoot, 'DevToolsActivePort')
    writeFileSync(portFile, `${port}\n/devtools/browser/abc\n`)

    const bridge = new DefaultAgentBridge(resolveHostPaths({ devToolsActivePortFile: portFile }))
    const bad = await bridge.jumpToConversation('bad/id?x=1')
    expect(bad.ok).toBe(false)

    // selectHubTarget excludes Agy Board tabs and callerOrigin (including loopback hostname equivalence)
    const selected = selectHubTarget(
      [
        { type: 'page', title: 'Agy Board', url: 'http://127.0.0.1:17919/', webSocketDebuggerUrl: 'ws://127.0.0.1:9/self' },
        { type: 'page', title: 'Local', url: 'http://127.0.0.1:17920/', webSocketDebuggerUrl: 'ws://127.0.0.1:9/caller' },
        { type: 'page', title: 'Hub Root', url: 'http://127.0.0.1:9222/', webSocketDebuggerUrl: 'ws://127.0.0.1:9/root' },
        { type: 'page', title: 'Antigravity', url: 'http://127.0.0.1:9222/c/old', webSocketDebuggerUrl: 'ws://127.0.0.1:9/hub' },
      ],
      { excludeOrigin: 'http://localhost:17920' },
    )
    expect(selected?.url).toBe('http://127.0.0.1:9222/c/old')
    expect(
      selectHubTarget([
        { type: 'page', title: 'Agy Board', url: 'http://127.0.0.1:17919/c/hijacked', webSocketDebuggerUrl: 'ws://127.0.0.1:9/self' },
      ]),
    ).toBeUndefined()

    const good = await bridge.jumpToConversation('conv-target-42', { excludeOrigin: 'http://localhost:17920' })
    expect(good.ok).toBe(true)
    expect(good.navigatedPath).toBe('/c/conv-target-42')
    expect(evaluatedExpr).toContain('conv-target-42')

    // HTTP POST /api/conversations/jump forwards callerOrigin to agentBridge.jumpToConversation
    serverHandle = await startStandaloneServer({
      port: 0,
      paths: {
        dbPath: join(tmpRoot, 'jump-board.db'),
        geminiConfigDir: join(tmpRoot, 'gemini-config'),
        antigravityDataDir: join(tmpRoot, 'gemini-antigravity'),
        devToolsActivePortFile: portFile,
      },
    })
    const httpJumpRes = await fetch(`${serverHandle.url}/api/conversations/jump`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conv-target-99', callerOrigin: 'http://localhost:17920' }),
    })
    expect(httpJumpRes.status).toBe(200)
    const httpJumpJson = (await httpJumpRes.json()) as { ok: boolean; navigatedPath?: string }
    expect(httpJumpJson.ok).toBe(true)
    expect(evaluatedExpr).toContain('conv-target-99')
    expect(upgradedPaths).toEqual(['/devtools/page/1', '/devtools/page/1'])
    await serverHandle.close()
    serverHandle = undefined

    for (const s of upgradedSockets) s.destroy()
    mockCdp.closeAllConnections?.()
    await new Promise<void>((r) => mockCdp.close(() => r()))
  })

  it('boots compiled sidecars/board/server.mjs bundle and serves built UI + APIs', async () => {
    const child = spawn(process.execPath, [SIDECAR_BUNDLE], {
      env: {
        ...process.env,
        AGY_BOARD_PORT: '0',
        AGY_BOARD_DB_PATH: join(tmpRoot, 'bundle-board.db'),
        AGY_BOARD_GEMINI_CONFIG_DIR: join(tmpRoot, 'gemini-config'),
        AGY_BOARD_ANTIGRAVITY_DATA_DIR: join(tmpRoot, 'gemini-antigravity'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    try {
      const listeningUrl = await new Promise<string>((resolveUrl, rejectUrl) => {
        const timeout = setTimeout(() => rejectUrl(new Error('Sidecar bundle did not start in time')), 6000)
        let out = ''
        child.stdout.on('data', (d) => {
          out += String(d)
          const m = out.match(/http:\/\/127\.0\.0\.1:\d+/)
          if (m) {
            clearTimeout(timeout)
            resolveUrl(m[0])
          }
        })
        child.stderr.on('data', (d) => {
          out += String(d)
        })
        child.once('exit', (code) => {
          clearTimeout(timeout)
          rejectUrl(new Error(`Sidecar bundle exited early (${code}): ${out}`))
        })
      })

      const htmlRes = await fetch(`${listeningUrl}/`)
      expect(htmlRes.status).toBe(200)
      const html = await htmlRes.text()
      expect(html).toContain('<div id="root"')
      expect(html).toContain('/preload.js')

      const preloadRes = await fetch(`${listeningUrl}/preload.js`)
      expect(preloadRes.status).toBe(200)

      const healthRes = await fetch(`${listeningUrl}/api/health`)
      expect(healthRes.status).toBe(200)
      const health = (await healthRes.json()) as { ok: boolean }
      expect(health.ok).toBe(true)
    } finally {
      child.kill('SIGTERM')
      await new Promise<void>((r) => {
        if (child.exitCode !== null) r()
        else child.once('exit', () => r())
      })
    }
  })

  it('boots compiled sidecars/board/server.mjs in Antigravity SidecarApp mode when sidecar_sdk is available', async () => {
    const hostSdkDir = join(homedir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk')
    if (!existsSync(join(hostSdkDir, 'index.mjs'))) return

    const freePort = await new Promise<number>((resPort, rejPort) => {
      const probe = createNetServer()
      probe.once('error', rejPort)
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address() as { port: number }
        probe.close(() => resPort(addr.port))
      })
    })

    // Mock Connect HTTP+JSON Language Server to verify async /_sidecar/* overrides after app.run()
    let lsGetCalls = 0
    let lsCreateCalls = 0
    const mockLs = createHttpServer((req, res) => {
      if (req.method === 'POST' && req.url === '/product.v1.ConversationService/GetConversation') {
        lsGetCalls += 1
        let body = ''
        req.on('data', (c) => {
          body += String(c)
        })
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}') as { conversationId?: string }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              conversation: {
                id: parsed.conversationId,
                metadata: { title: 'Async Metadata Override', stepCount: 7 },
              },
            }),
          )
        })
        return
      }
      if (req.method === 'POST' && req.url === '/product.v1.ConversationService/CreateConversation') {
        lsCreateCalls += 1
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ newConversation: { conversationId: 'conv-sidecar-async-new-1' } }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((r) => mockLs.listen(0, '127.0.0.1', () => r()))
    const lsPort = (mockLs.address() as { port: number }).port

    const child = spawn(process.execPath, [SIDECAR_BUNDLE], {
      env: {
        ...process.env,
        ANTIGRAVITY_SIDECAR_WEB_PORT: String(freePort),
        ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${lsPort}`,
        ANTIGRAVITY_CSRF_TOKEN: 'test-csrf',
        ANTIGRAVITY_SIDECAR_UI_TOKEN: 'test-sidecar-tok',
        ANTIGRAVITY_AGENTAPI_EXE: join(tmpRoot, 'nonexistent-agentapi.exe'),
        AGY_BOARD_DB_PATH: join(tmpRoot, 'sdk-board.db'),
        AGY_BOARD_GEMINI_CONFIG_DIR: join(tmpRoot, 'gemini-config'),
        AGY_BOARD_ANTIGRAVITY_DATA_DIR: join(tmpRoot, 'gemini-antigravity'),
        NODE_PATH: join(homedir(), '.gemini', 'config', 'node_modules'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(() => rejectReady(new Error('SidecarApp mode timed out')), 6000)
        let out = ''
        child.stdout.on('data', (d) => {
          out += String(d)
          if (out.includes(`[sidecar] listening on 127.0.0.1:${freePort}`)) {
            clearTimeout(timer)
            resolveReady()
          }
        })
        child.stderr.on('data', (d) => {
          out += String(d)
        })
        child.once('exit', (code) => {
          clearTimeout(timer)
          rejectReady(new Error(`SidecarApp exited early (${code}): ${out}`))
        })
      })

      const base = `http://127.0.0.1:${freePort}`
      const pageRes = await fetch(`${base}/`)
      expect(pageRes.status).toBe(200)
      const pageHtml = await pageRes.text()
      expect(pageHtml).toContain('<div id="root"')

      // Verify self-contained single-file HTML bundle served cleanly via SidecarApp (no external /assets/* or crossorigin module traps)
      expect(pageHtml).toContain('<script src="/preload.js"></script>')
      expect(pageHtml).toContain('<style>')
      expect(pageHtml).toContain('board-header')
      expect(pageHtml).not.toMatch(/<(?:script|link)\b[^>]*\bcrossorigin\b/i)
      expect(pageHtml).not.toMatch(/<script\b[^>]*\btype="module"/i)
      expect(pageHtml).not.toMatch(/(?:src|href)="\/?assets\//i)

      const preloadRes = await fetch(`${base}/preload.js`)
      expect(preloadRes.status).toBe(200)
      expect(await preloadRes.text()).toContain('window.sidecar')

      // POST without token must be rejected 401 by sidecar_sdk
      const unauth = await fetch(`${base}/api/tasks/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'No token' }),
      })
      expect(unauth.status).toBe(401)

      // POST with X-Sidecar-Token creates task via SidecarApp
      const authed = await fetch(`${base}/api/tasks/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': 'test-sidecar-tok' },
        body: JSON.stringify({ title: 'SidecarApp Verified Task' }),
      })
      expect(authed.status).toBe(200)
      const created = (await authed.json()) as { task: { title: string } }
      expect(created.task.title).toBe('SidecarApp Verified Task')

      // POST /_sidecar/get-conversation-metadata and /_sidecar/new-conversation hit async Connect overrides installed AFTER app.run()
      const metaRes = await fetch(`${base}/_sidecar/get-conversation-metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': 'test-sidecar-tok' },
        body: JSON.stringify({ conversationId: 'conv-async-meta-1' }),
      })
      expect(metaRes.status).toBe(200)
      const metaJson = (await metaRes.json()) as {
        metadata?: { title?: string }
        response?: { conversationMetadata?: { conversationId?: string } }
      }
      expect(lsGetCalls).toBe(1)
      expect(metaJson.metadata?.title).toBe('Async Metadata Override')
      expect(metaJson.response?.conversationMetadata?.conversationId).toBe('conv-async-meta-1')

      const newConvRes = await fetch(`${base}/_sidecar/new-conversation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': 'test-sidecar-tok' },
        body: JSON.stringify({ prompt: 'Hello from sidecar override', projectId: 'proj-1' }),
      })
      expect(newConvRes.status).toBe(200)
      const newConvJson = (await newConvRes.json()) as {
        conversationId?: string
        response?: { newConversation?: { conversationId?: string } }
      }
      expect(lsCreateCalls).toBe(1)
      expect(newConvJson.conversationId).toBe('conv-sidecar-async-new-1')
      expect(newConvJson.response?.newConversation?.conversationId).toBe('conv-sidecar-async-new-1')
    } finally {
      child.kill('SIGTERM')
      await new Promise<void>((r) => {
        if (child.exitCode !== null) r()
        else child.once('exit', () => r())
      })
      mockLs.closeAllConnections?.()
      await new Promise<void>((r) => mockLs.close(() => r()))
    }
  })

  it('runs runtime_entries cleanly in an isolated directory with zero node_modules (agy-kit deployment simulation)', async () => {
    const compat = JSON.parse(readFileSync(join(REPO_ROOT, 'agy-kit.compat.json'), 'utf8')) as {
      runtime_entries: string[]
    }
    const deployedDir = join(tmpRoot, 'deployed-agy-board')
    mkdirSync(deployedDir, { recursive: true })
    for (const entry of compat.runtime_entries) {
      cpSync(join(REPO_ROOT, entry), join(deployedDir, entry), { recursive: true })
    }
    expect(existsSync(join(deployedDir, 'node_modules'))).toBe(false)

    // Verify plugin.json, mcp_config.json, hooks.json, and sidecar.json contracts
    const mcpCfg = JSON.parse(readFileSync(join(deployedDir, 'mcp_config.json'), 'utf8')) as {
      mcpServers: { 'agy-board': { args: string[] } }
    }
    expect(mcpCfg.mcpServers['agy-board'].args[0]).toBe('${PLUGIN_ROOT}/dist/mcp.mjs')

    const sharedDb = join(tmpRoot, 'shared-antigravity', 'agy-board', 'board.db')
    const isolatedEnv = {
      ...process.env,
      AGY_BOARD_GEMINI_CONFIG_DIR: join(tmpRoot, 'gemini-config'),
      AGY_BOARD_ANTIGRAVITY_DATA_DIR: join(tmpRoot, 'shared-antigravity'),
    }

    // Boot compiled CLI `help` & `doctor` against non-existent DB from isolated deployment (must NOT create default board.db!)
    const defaultBoardDb = join(tmpRoot, 'shared-antigravity', 'agy-board', 'board.db')
    rmSync(join(tmpRoot, 'shared-antigravity', 'agy-board'), { recursive: true, force: true })
    await new Promise<void>((resHelp, rejHelp) => {
      const p = spawn(process.execPath, [join(deployedDir, 'dist', 'cli.mjs'), 'help'], {
        env: isolatedEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      p.once('exit', (code) => (code === 0 ? resHelp() : rejHelp(new Error(`cli help exited ${code}`))))
    })
    expect(existsSync(defaultBoardDb)).toBe(false)

    // Boot compiled MCP server from isolated runtime_entries (no node_modules)
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(deployedDir, 'dist', 'mcp.mjs')],
      env: isolatedEnv as Record<string, string>,
    })
    const client = new Client({ name: 'isolated-runtime-client', version: '1.0.0' })
    await client.connect(transport)
    try {
      const created = await client.callTool({
        name: 'board_create',
        arguments: { title: 'Isolated Runtime Task' },
      })
      expect(JSON.parse((created.content as Array<{ text: string }>)[0].text).ok).toBe(true)
    } finally {
      await client.close()
    }
    expect(existsSync(sharedDb)).toBe(true)

    // Boot compiled sidecar bundle from isolated runtime_entries (no node_modules) and verify it sees the MCP-created task
    const sidecarChild = spawn(process.execPath, [join(deployedDir, 'sidecars', 'board', 'server.mjs')], {
      env: { ...isolatedEnv, AGY_BOARD_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      const url = await new Promise<string>((resolveUrl, rejectUrl) => {
        const timer = setTimeout(() => rejectUrl(new Error('Isolated sidecar timed out')), 6000)
        let out = ''
        sidecarChild.stdout.on('data', (d) => {
          out += String(d)
          const m = out.match(/http:\/\/127\.0\.0\.1:\d+/)
          if (m) {
            clearTimeout(timer)
            resolveUrl(m[0])
          }
        })
        sidecarChild.stderr.on('data', (d) => {
          out += String(d)
        })
        sidecarChild.once('exit', (code) => {
          clearTimeout(timer)
          rejectUrl(new Error(`Isolated sidecar exited (${code}): ${out}`))
        })
      })
      const snapRes = await fetch(`${url}/api/snapshot`)
      expect(snapRes.status).toBe(200)
      const snap = (await snapRes.json()) as { tasks: Array<{ title: string }> }
      expect(snap.tasks.some((t) => t.title === 'Isolated Runtime Task')).toBe(true)
    } finally {
      sidecarChild.kill('SIGTERM')
      await new Promise<void>((r) => {
        if (sidecarChild.exitCode !== null) r()
        else sidecarChild.once('exit', () => r())
      })
    }
  })

  it('serves new HTTP routes (comments, subgoals/reorder, workspaces update/delete, worktree/diff, reminder validation)', async () => {
    const gitDir = join(tmpRoot, 'http-git-repo')
    mkdirSync(gitDir, { recursive: true })
    await execFileAsync('git', ['init'], { cwd: gitDir })
    await execFileAsync('git', ['config', 'user.name', 'HTTP Tester'], { cwd: gitDir })
    await execFileAsync('git', ['config', 'user.email', 'http@example.com'], { cwd: gitDir })
    writeFileSync(join(gitDir, 'index.ts'), 'export const v = 1\n', 'utf8')
    await execFileAsync('git', ['add', '.'], { cwd: gitDir })
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: gitDir })

    writeFileSync(
      join(tmpRoot, 'gemini-config', 'projects', 'host-proj.json'),
      JSON.stringify({
        id: 'host-proj',
        name: 'Host Managed',
        projectResources: { resources: [{ folderUri: `file:///${gitDir.replace(/\\/g, '/')}` }] },
      }),
    )

    serverHandle = await startStandaloneServer({
      port: 0,
      paths: {
        dbPath: join(tmpRoot, 'routes-board.db'),
        geminiConfigDir: join(tmpRoot, 'gemini-config'),
        antigravityDataDir: join(tmpRoot, 'gemini-antigravity'),
      },
      boardOptions: {
        agentBridge: {
          async startConversation() {
            return { conversationId: 'conv-wt-http-1', raw: {} }
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
      },
    })
    const base = serverHandle.url

    // Workspaces update & delete
    const customDir = join(tmpRoot, 'custom-ws-route')
    mkdirSync(customDir, { recursive: true })
    const wsReg = await fetch(`${base}/api/workspaces/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Route WS', rootPath: customDir, pinned: false }),
    })
    expect(wsReg.status).toBe(200)
    const wsId = ((await wsReg.json()) as { workspace: { id: string } }).workspace.id

    const wsUpd = await fetch(`${base}/api/workspaces/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: wsId, name: 'Route WS Updated', pinned: true }),
    })
    expect(wsUpd.status).toBe(200)
    expect(((await wsUpd.json()) as { workspace: { name: string; pinned: boolean } }).workspace).toMatchObject({
      name: 'Route WS Updated',
      pinned: true,
    })

    const hostDel = await fetch(`${base}/api/workspaces/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'host-proj' }),
    })
    expect(hostDel.status).toBe(409)

    const wsDel = await fetch(`${base}/api/workspaces/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: wsId }),
    })
    expect(wsDel.status).toBe(200)

    // Create task with subgoals & worktree
    const createRes = await fetch(`${base}/api/tasks/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Route Test Task',
        workspacePath: gitDir,
        useWorktree: true,
        subgoals: [
          { id: 'sg-1', title: 'Step 1' },
          { id: 'sg-2', title: 'Step 2' },
        ],
      }),
    })
    expect(createRes.status).toBe(200)
    const taskId = ((await createRes.json()) as { task: { id: string } }).task.id

    // Comments add + blank comment 400 validation
    const badComment = await fetch(`${base}/api/tasks/comment/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, bodyMd: '   ' }),
    })
    expect(badComment.status).toBe(400)

    const okComment = await fetch(`${base}/api/tasks/comment/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, author: 'reviewer', bodyMd: 'Check **diff** route.' }),
    })
    expect(okComment.status).toBe(200)
    const commentJson = (await okComment.json()) as { ok: boolean; comment: { author: string; bodyMd: string } }
    expect(commentJson.ok).toBe(true)
    expect(commentJson.comment.author).toBe('reviewer')

    // Subgoals reorder
    const reorderRes = await fetch(`${base}/api/tasks/subgoals/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, orderedIds: ['sg-2', 'sg-1'] }),
    })
    expect(reorderRes.status).toBe(200)
    const reorderedTask = ((await reorderRes.json()) as { task: { subgoals: Array<{ id: string }> } }).task
    expect(reorderedTask.subgoals.map((s) => s.id)).toEqual(['sg-2', 'sg-1'])

    // Create/update dueAt 400 validation + Reminder 400 validation + valid update + null clear
    const badCreateDue = await fetch(`${base}/api/tasks/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Bad Due Create', dueAt: 'not-an-epoch' }),
    })
    expect(badCreateDue.status).toBe(400)
    expect(((await badCreateDue.json()) as { code: string }).code).toBe('invalid-due-at')

    const badUpdateDue = await fetch(`${base}/api/tasks/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, patch: { dueAt: 'bad-date' } }),
    })
    expect(badUpdateDue.status).toBe(400)
    expect(((await badUpdateDue.json()) as { code: string }).code).toBe('invalid-due-at')

    const badReminder = await fetch(`${base}/api/tasks/reminder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, reminderAt: 'not-an-epoch' }),
    })
    expect(badReminder.status).toBe(400)
    expect(((await badReminder.json()) as { code: string }).code).toBe('invalid-reminder')

    const okReminder = await fetch(`${base}/api/tasks/reminder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, reminderAt: String(Date.now() + 60_000) }),
    })
    expect(okReminder.status).toBe(200)

    const clearReminder = await fetch(`${base}/api/tasks/reminder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, reminderAt: null }),
    })
    expect(clearReminder.status).toBe(200)

    // Worktree diff 404 before dispatch, 200 after dispatch + file modification
    const noWtDiff = await fetch(`${base}/api/tasks/worktree/diff?taskId=${taskId}`)
    expect(noWtDiff.status).toBe(404)

    const dispRes = await fetch(`${base}/api/tasks/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, mode: 'new' }),
    })
    expect(dispRes.status).toBe(200)
    const wtPath = ((await dispRes.json()) as { task: { worktreePath: string } }).task.worktreePath
    writeFileSync(join(wtPath, 'index.ts'), 'export const v = 2\n', 'utf8')

    const diffRes = await fetch(`${base}/api/tasks/worktree/diff?taskId=${taskId}`)
    expect(diffRes.status).toBe(200)
    const diffJson = (await diffRes.json()) as { ok: boolean; hasChanges: boolean; diff: string }
    expect(diffJson.ok).toBe(true)
    expect(diffJson.hasChanges).toBe(true)
    expect(diffJson.diff).toContain('export const v = 2')

    const cleanRes = await fetch(`${base}/api/tasks/worktree/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, force: true }),
    })
    expect(cleanRes.status).toBe(200)
  })

  it('validates cli.mjs boolean flags, dangling --due validation, and --db serve lifecycle', async () => {
    const parsed = parseCliArgs(['create', '--json', 'Boolean Title Task', '--use-worktree'])
    expect(parsed.command).toBe('create')
    expect(parsed.flags.get('json')).toBe(true)
    expect(parsed.flags.get('use-worktree')).toBe(true)
    expect(parsed.positional).toEqual(['Boolean Title Task'])

    const cliDb = join(tmpRoot, 'cli-flags.db')

    // Dangling --due (followed by flag or at end of argv), invalid --due, and dangling --reminder validation
    for (const badArgs of [
      ['create', '--title', 'Dangling Due', '--due', '--db', cliDb],
      ['create', '--title', 'End Dangling Due', '--db', cliDb, '--due'],
      ['create', '--title', 'Bad Due', '--due', 'not-a-timestamp', '--db', cliDb],
    ]) {
      await expect(
        runCli(badArgs, {
          geminiConfigDir: join(tmpRoot, 'gemini-config'),
          antigravityDataDir: join(tmpRoot, 'gemini-antigravity'),
        }),
      ).rejects.toThrow(/Invalid --due timestamp/)
    }

    await expect(
      runCli(['create', '--title', 'Dangling Rem', '--reminder', '--db', cliDb], {
        geminiConfigDir: join(tmpRoot, 'gemini-config'),
        antigravityDataDir: join(tmpRoot, 'gemini-antigravity'),
      }),
    ).rejects.toThrow(/Invalid --reminder timestamp/)

    // Compiled dist/cli.mjs `create --json "Title"` keeps title positional instead of swallowing it into --json
    const { stdout: createOut } = await execFileAsync(
      process.execPath,
      [CLI_BUNDLE, 'create', '--json', 'Positional Title With Boolean Json', '--db', cliDb],
      {
        env: {
          ...process.env,
          AGY_BOARD_GEMINI_CONFIG_DIR: join(tmpRoot, 'gemini-config'),
          AGY_BOARD_ANTIGRAVITY_DATA_DIR: join(tmpRoot, 'gemini-antigravity'),
        },
        timeout: 10_000,
      },
    )
    const createdCli = JSON.parse(createOut) as { ok: boolean; task: { title: string } }
    expect(createdCli.ok).toBe(true)
    expect(createdCli.task.title).toBe('Positional Title With Boolean Json')

    // In-process runCli serve handle starts and closes cleanly
    const inProcServe = await runCli(['--db', cliDb, 'serve', '--port', '0'], {
      geminiConfigDir: join(tmpRoot, 'gemini-config'),
      antigravityDataDir: join(tmpRoot, 'gemini-antigravity'),
    })
    expect(inProcServe.command).toBe('serve')
    expect(inProcServe.handle).toBeTruthy()
    const inProcSnap = await fetch(`${inProcServe.handle!.url}/api/snapshot`)
    expect(inProcSnap.status).toBe(200)
    await inProcServe.handle!.close()

    // Compiled `dist/cli.mjs --db ... serve --port 0` starts cleanly, serves the created task, and stops on signal
    const cliServer = spawn(process.execPath, [CLI_BUNDLE, '--db', cliDb, 'serve', '--port', '0'], {
      env: {
        ...process.env,
        AGY_BOARD_GEMINI_CONFIG_DIR: join(tmpRoot, 'gemini-config'),
        AGY_BOARD_ANTIGRAVITY_DATA_DIR: join(tmpRoot, 'gemini-antigravity'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    try {
      const listeningUrl = await new Promise<string>((resolveUrl, rejectUrl) => {
        const timeout = setTimeout(() => rejectUrl(new Error('CLI serve did not start in time')), 6000)
        let out = ''
        cliServer.stdout.on('data', (d) => {
          out += String(d)
          const m = out.match(/http:\/\/127\.0\.0\.1:\d+/)
          if (m) {
            clearTimeout(timeout)
            resolveUrl(m[0])
          }
        })
        cliServer.stderr.on('data', (d) => {
          out += String(d)
        })
        cliServer.once('exit', (code) => {
          clearTimeout(timeout)
          rejectUrl(new Error(`CLI serve exited early (${code}): ${out}`))
        })
      })

      const snapRes = await fetch(`${listeningUrl}/api/snapshot`)
      expect(snapRes.status).toBe(200)
      const snap = (await snapRes.json()) as { tasks: Array<{ title: string }> }
      expect(snap.tasks.some((t) => t.title === 'Positional Title With Boolean Json')).toBe(true)
    } finally {
      cliServer.kill('SIGTERM')
      const exitCode = await new Promise<number | null>((r) => {
        if (cliServer.exitCode !== null) r(cliServer.exitCode)
        else cliServer.once('exit', (code) => r(code))
      })
      if (process.platform !== 'win32') {
        expect(exitCode).toBe(0)
      }
    }
  })

  it('serves /api/tasks/schedule/* cycle, catch-up, skip-cycle, run-now, clear, and /api/tasks/marks routes', async () => {
    const dbPath = join(tmpRoot, 'sched-http-board.db')
    const geminiConfigDir = join(tmpRoot, 'gemini-config')
    const antigravityDataDir = join(tmpRoot, 'gemini-antigravity')
    serverHandle = await startStandaloneServer({
      port: 0,
      paths: { dbPath, geminiConfigDir, antigravityDataDir },
    })
    const baseUrl = serverHandle.url

    const createRes = await fetch(`${baseUrl}/api/tasks/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'HTTP Scheduled Reminder Task',
        subgoals: [{ title: 'Check metrics', required: true }],
        schedule: {
          enabled: true,
          mode: 'cron',
          cron: '0 9 * * 1-5',
          action: 'remind',
          timeZone: 'UTC',
        },
      }),
    })
    expect(createRes.status).toBe(200)
    const created = (await createRes.json()) as { ok: boolean; task: { id: string; schedule?: { action?: string; nextRunAt?: number } } }
    expect(created.ok).toBe(true)
    expect(created.task.schedule?.action).toBe('remind')
    const taskId = created.task.id
    const firstNext = created.task.schedule!.nextRunAt!

    // /api/tasks/schedule/run-now (zero-token remind transitions to needs_you/reminder_due)
    const runNowRes = await fetch(`${baseUrl}/api/tasks/schedule/run-now`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    })
    expect(runNowRes.status).toBe(200)
    const runNowJson = (await runNowRes.json()) as { ok: boolean; task: { phase: string; subPhase: string; schedule?: { runCount: number } } }
    expect(runNowJson.task.phase).toBe('needs_you')
    expect(runNowJson.task.subPhase).toBe('reminder_due')
    expect(runNowJson.task.schedule?.runCount).toBe(1)

    // /api/tasks/schedule/complete-cycle (fails without force while required subgoal open, succeeds with force)
    const blockedCycleRes = await fetch(`${baseUrl}/api/tasks/schedule/complete-cycle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    })
    expect(blockedCycleRes.status).toBe(409)

    const cycleRes = await fetch(`${baseUrl}/api/tasks/schedule/complete-cycle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, force: true }),
    })
    expect(cycleRes.status).toBe(200)
    const cycleJson = (await cycleRes.json()) as { ok: boolean; task: { phase: string } }
    expect(cycleJson.task.phase).toBe('todo')

    // /api/tasks/schedule/skip-cycle advances nextRunAt
    const skipCycleRes = await fetch(`${baseUrl}/api/tasks/schedule/skip-cycle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    })
    expect(skipCycleRes.status).toBe(200)
    const skipCycleJson = (await skipCycleRes.json()) as { ok: boolean; task: { schedule?: { nextRunAt?: number } } }
    expect(skipCycleJson.task.schedule!.nextRunAt!).toBeGreaterThan(firstNext)

    // /api/tasks/schedule/catch-up ('skip' & validation)
    const badCatchUpRes = await fetch(`${baseUrl}/api/tasks/schedule/catch-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, action: 'invalid' }),
    })
    expect(badCatchUpRes.status).toBe(400)

    const catchUpSkipRes = await fetch(`${baseUrl}/api/tasks/schedule/catch-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, action: 'skip' }),
    })
    expect(catchUpSkipRes.status).toBe(200)

    // /api/tasks/marks
    const marksRes = await fetch(`${baseUrl}/api/tasks/marks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, ignore: true }),
    })
    expect(marksRes.status).toBe(200)
    const marksJson = (await marksRes.json()) as { ok: boolean; task: { userMarks?: { ignoredAt?: number } } }
    expect(marksJson.task.userMarks?.ignoredAt).toBeTypeOf('number')

    // /api/tasks/schedule clear: true
    const clearRes = await fetch(`${baseUrl}/api/tasks/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, clear: true }),
    })
    expect(clearRes.status).toBe(200)
    const clearJson = (await clearRes.json()) as { ok: boolean; task: { schedule?: unknown } }
    expect(clearJson.task.schedule).toBeUndefined()
  })

  it('serves POST /api/tasks/batch, /api/tasks/marks (pin & snoozeUntil), and create-time pin', async () => {
    serverHandle = await startStandaloneServer({
      port: 0,
      paths: {
        dbPath: join(tmpRoot, 'batch-http.db'),
        geminiConfigDir: join(tmpRoot, 'gemini-config'),
        antigravityDataDir: join(tmpRoot, 'gemini-antigravity'),
      },
      boardOptions: {
        agentBridge: {
          async startConversation() {
            return { conversationId: 'conv-batch-1', raw: {} }
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
      },
    })
    const base = serverHandle.url

    const create1 = await fetch(`${base}/api/tasks/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'HTTP Batch 1', pin: true, workspacePath: join(tmpRoot, 'repo') }),
    })
    const t1 = (await create1.json()) as { task: { id: string; userMarks?: { pinnedAt?: number } } }
    expect(t1.task.userMarks?.pinnedAt).toBeTypeOf('number')

    const create2 = await fetch(`${base}/api/tasks/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'HTTP Batch 2' }),
    })
    const t2 = (await create2.json()) as { task: { id: string } }

    // Snooze + unsnooze via /api/tasks/marks
    const future = Date.now() + 7_200_000
    const snoozeRes = await fetch(`${base}/api/tasks/marks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: t2.task.id, snoozeUntil: future }),
    })
    expect(snoozeRes.status).toBe(200)
    const snoozedJson = (await snoozeRes.json()) as { task: { userMarks?: { snoozedUntil?: number } } }
    expect(snoozedJson.task.userMarks?.snoozedUntil).toBe(future)

    // Batch set_sub_phase & set_priority
    const batchRes = await fetch(`${base}/api/tasks/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskIds: [t1.task.id, t2.task.id], action: 'set_sub_phase', subPhase: 'backlog' }),
    })
    expect(batchRes.status).toBe(200)
    const batchJson = (await batchRes.json()) as { ok: boolean; affectedIds: string[]; tasks: Array<{ subPhase: string }> }
    expect(batchJson.ok).toBe(true)
    expect(batchJson.affectedIds).toHaveLength(2)
    expect(batchJson.tasks.every((t) => t.subPhase === 'backlog')).toBe(true)

    // Batch delete returns 409 when one task has an open running execution
    await fetch(`${base}/api/tasks/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: t1.task.id, mode: 'new' }),
    })
    const badBatch = await fetch(`${base}/api/tasks/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskIds: [t1.task.id, t2.task.id], action: 'delete' }),
    })
    expect(badBatch.status).toBe(409)
  })
})
