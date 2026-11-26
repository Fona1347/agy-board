/**
 * Antigravity ConversationService (Connect HTTP+JSON), AgentAPI CLI, Daemon Discovery,
 * and loopback CDP bridge.
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveDevToolsPortFileCandidates, type HostPaths } from './paths.ts'

export const SAFE_CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{4,120}$/

export interface NewConversationRequest {
  prompt: string
  title?: string
  model?: string
  profile?: string
  projectId?: string
  tags?: string[]
}

export interface SendMessageRequest {
  conversationId: string
  message: string
  title?: string
  projectId?: string
}

export interface ListConversationsRequest {
  pageSize?: number
  pageToken?: string
  projectId?: string
  parentConversationId?: string
  tags?: string[]
  includeArchived?: boolean
}

export interface UpdateConversationAnnotations {
  title?: string
  archived?: boolean
  pinned?: boolean
  starred?: boolean
  tags?: string[]
  conversationGroupId?: string
}

export interface AgentLaunchResult {
  conversationId: string
  raw: Record<string, unknown>
}

export interface JumpResult {
  ok: boolean
  method: 'cdp' | 'none'
  conversationId: string
  port?: number
  navigatedPath?: string
  reason?: string
}

export interface AgentBridge {
  startConversation(req: NewConversationRequest): Promise<AgentLaunchResult>
  sendMessage(req: SendMessageRequest): Promise<AgentLaunchResult>
  getConversationMetadata(conversationId: string): Promise<Record<string, unknown>>
  jumpToConversation(conversationId: string, options?: { excludeOrigin?: string }): Promise<JumpResult>
  getConversation?(conversationId: string): Promise<Record<string, unknown>>
  listConversations?(req?: ListConversationsRequest): Promise<Record<string, unknown>>
  updateConversation?(conversationId: string, annotations: UpdateConversationAnnotations): Promise<Record<string, unknown>>
}

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { encoding: 'utf8'; env: NodeJS.ProcessEnv; windowsHide: boolean; maxBuffer: number; timeout: number },
) => Promise<{ stdout: string; stderr: string }>

export interface ConnectFetchResponse {
  ok: boolean
  status: number
  text(): Promise<string>
}

export type ConnectFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; timeoutMs?: number },
) => Promise<ConnectFetchResponse>

export interface AgentBridgeOptions {
  execImpl?: ExecFileFn
  fetchImpl?: ConnectFetchFn
  env?: NodeJS.ProcessEnv
  useDaemonDiscovery?: boolean
}

export interface LsConnectionInfo {
  address: string
  httpsAddress?: string
  csrfToken: string
  pid?: number
  lsVersion?: string
  source: 'env' | 'daemon'
}

function defaultExecFile(
  file: string,
  args: readonly string[],
  options: { encoding: 'utf8'; env: NodeJS.ProcessEnv; windowsHide: boolean; maxBuffer: number; timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], options, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message
        reject(new Error(`agentapi failed: ${msg}`))
        return
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

function isLoopbackHost(hostname: string): boolean {
  const clean = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return clean === '127.0.0.1' || clean === 'localhost' || clean === '::1'
}

export function defaultConnectFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; timeoutMs?: number },
): Promise<ConnectFetchResponse> {
  return new Promise((resolve, reject) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch (err) {
      reject(err)
      return
    }
    const isHttps = parsed.protocol === 'https:'
    if (!isHttps && parsed.protocol !== 'http:') {
      reject(new Error(`Unsupported protocol: ${parsed.protocol}`))
      return
    }
    const timeoutMs = init.timeoutMs ?? 15_000
    const reqFn = isHttps ? httpsRequest : httpRequest
    const reqOpts = {
      hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
      port: parsed.port ? Number(parsed.port) : isHttps ? 443 : 80,
      path: `${parsed.pathname}${parsed.search}`,
      method: init.method,
      agent: false,
      headers: {
        ...init.headers,
        Connection: 'close',
        'Content-Length': String(Buffer.byteLength(init.body, 'utf8')),
      },
      timeout: timeoutMs,
      ...(isHttps ? { rejectUnauthorized: !isLoopbackHost(parsed.hostname) } : {}),
    }

    let settled = false
    const finishOk = (res: ConnectFetchResponse) => {
      if (settled) return
      settled = true
      resolve(res)
    }
    const finishErr = (err: unknown) => {
      if (settled) return
      settled = true
      reject(err instanceof Error ? err : new Error(String(err)))
    }

    const req = reqFn(reqOpts, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      res.on('error', finishErr)
      res.on('end', () => {
        const status = res.statusCode ?? 0
        const rawText = Buffer.concat(chunks).toString('utf8')
        finishOk({
          ok: status >= 200 && status < 300,
          status,
          text: async () => rawText,
        })
      })
    })
    req.on('socket', (socket) => {
      socket.on('error', finishErr)
    })
    req.on('error', finishErr)
    req.on('timeout', () => {
      const err = new Error(`Connect HTTP timeout after ${timeoutMs}ms`)
      req.destroy(err)
      finishErr(err)
    })
    if (init.body) req.write(init.body)
    req.end()
  })
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH'
  }
}

async function probeLoopbackHealthz(
  url: string,
  fetchImpl: ConnectFetchFn,
  timeoutMs = 450,
): Promise<boolean> {
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {},
      body: '',
      timeoutMs,
    })
    return res.ok
  } catch {
    return false
  }
}

export async function discoverVerifiedLsDaemon(
  daemonDir: string,
  fetchImpl: ConnectFetchFn = defaultConnectFetch,
): Promise<LsConnectionInfo | undefined> {
  if (!daemonDir || !existsSync(daemonDir)) return undefined
  let files: Array<{ path: string; mtimeMs: number }>
  try {
    files = readdirSync(daemonDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const full = join(daemonDir, f)
        try {
          return { path: full, mtimeMs: statSync(full).mtimeMs }
        } catch {
          return { path: full, mtimeMs: 0 }
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch {
    return undefined
  }

  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(file.path, 'utf8')) as {
        pid?: unknown
        httpPort?: unknown
        httpsPort?: unknown
        csrfToken?: unknown
        lsVersion?: unknown
      }
      const csrfToken = typeof parsed.csrfToken === 'string' ? parsed.csrfToken.trim() : ''
      if (!csrfToken) continue

      const pid = typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) ? parsed.pid : undefined
      if (pid !== undefined && !isPidAlive(pid)) continue

      const httpPort =
        typeof parsed.httpPort === 'number' && parsed.httpPort >= 1 && parsed.httpPort <= 65535
          ? parsed.httpPort
          : undefined
      const httpsPort =
        typeof parsed.httpsPort === 'number' && parsed.httpsPort >= 1 && parsed.httpsPort <= 65535
          ? parsed.httpsPort
          : undefined
      if (!httpPort && !httpsPort) continue

      const httpAddress = httpPort ? `127.0.0.1:${httpPort}` : undefined
      const httpsAddress = httpsPort ? `127.0.0.1:${httpsPort}` : undefined

      let verifiedHttp = false
      let verifiedHttps = false
      if (httpAddress) {
        verifiedHttp = await probeLoopbackHealthz(`http://${httpAddress}/healthz`, fetchImpl)
      }
      if (!verifiedHttp && httpsAddress) {
        verifiedHttps = await probeLoopbackHealthz(`https://${httpsAddress}/healthz`, fetchImpl)
      }
      if (!verifiedHttp && !verifiedHttps) continue

      return {
        address: verifiedHttp && httpAddress ? `http://${httpAddress}` : `https://${httpsAddress!}`,
        ...(httpsAddress ? { httpsAddress: `https://${httpsAddress}` } : {}),
        csrfToken,
        pid,
        lsVersion: typeof parsed.lsVersion === 'string' ? parsed.lsVersion : undefined,
        source: 'daemon',
      }
    } catch {
      // ignore malformed or unreadable hub file
    }
  }
  return undefined
}

export function resolveAgentApiExecutable(env: NodeJS.ProcessEnv = process.env): { file: string; prefixArgs: string[] } {
  if (env.ANTIGRAVITY_AGENTAPI_EXE && existsSync(env.ANTIGRAVITY_AGENTAPI_EXE)) {
    return { file: env.ANTIGRAVITY_AGENTAPI_EXE, prefixArgs: ['agentapi'] }
  }

  const candidates: string[] = []
  if (process.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    const programFiles = env.ProgramFiles || 'C:\\Program Files'
    candidates.push(
      join(localAppData, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe'),
      join(localAppData, 'Programs', 'Antigravity', 'resources', 'bin', 'language_server.exe'),
      join(
        localAppData,
        'Programs',
        'antigravity',
        'resources',
        'app',
        'extensions',
        'antigravity',
        'bin',
        'language_server_windows_x64.exe',
      ),
      join(
        localAppData,
        'Programs',
        'Antigravity',
        'resources',
        'app',
        'extensions',
        'antigravity',
        'bin',
        'language_server_windows_x64.exe',
      ),
      join(programFiles, 'Antigravity', 'resources', 'bin', 'language_server.exe'),
      join(
        programFiles,
        'Antigravity',
        'resources',
        'app',
        'extensions',
        'antigravity',
        'bin',
        'language_server_windows_x64.exe',
      ),
    )
  } else if (process.platform === 'darwin') {
    const home = homedir()
    candidates.push(
      '/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm',
      '/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_x64',
      '/Applications/Antigravity.app/Contents/Resources/bin/language_server',
      join(
        home,
        'Applications',
        'Antigravity.app',
        'Contents',
        'Resources',
        'app',
        'extensions',
        'antigravity',
        'bin',
        'language_server_macos_arm',
      ),
      join(
        home,
        'Applications',
        'Antigravity.app',
        'Contents',
        'Resources',
        'app',
        'extensions',
        'antigravity',
        'bin',
        'language_server_macos_x64',
      ),
      join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'bin', 'language_server'),
    )
  } else {
    const home = homedir()
    candidates.push(
      '/usr/share/antigravity/resources/app/extensions/antigravity/bin/language_server_linux_x64',
      '/usr/share/antigravity/resources/app/extensions/antigravity/bin/language_server_linux_arm64',
      '/opt/antigravity/resources/app/extensions/antigravity/bin/language_server_linux_x64',
      '/usr/lib/antigravity/resources/app/extensions/antigravity/bin/language_server_linux_x64',
      '/usr/share/antigravity/resources/bin/language_server',
      join(home, '.local', 'share', 'antigravity', 'resources', 'bin', 'language_server'),
      join(
        home,
        '.local',
        'share',
        'antigravity',
        'resources',
        'app',
        'extensions',
        'antigravity',
        'bin',
        'language_server_linux_x64',
      ),
    )
  }

  for (const cand of candidates) {
    if (existsSync(cand)) return { file: cand, prefixArgs: ['agentapi'] }
  }
  return { file: 'agentapi', prefixArgs: [] }
}

function asObj(val: unknown): Record<string, unknown> | undefined {
  return val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, unknown>) : undefined
}

function readConvIdFromObj(obj: Record<string, unknown> | undefined): string | undefined {
  if (!obj) return undefined
  const direct = obj.conversationId ?? obj.conversation_id ?? obj.id
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  return undefined
}

export function extractConversationId(payload: Record<string, unknown>): string | undefined {
  const candidates: Array<Record<string, unknown> | undefined> = [
    payload,
    asObj(payload.newConversation),
    asObj(payload.new_conversation),
    asObj(payload.conversation),
    asObj(payload.response),
    asObj(asObj(payload.response)?.newConversation),
    asObj(asObj(payload.response)?.new_conversation),
    asObj(asObj(payload.response)?.conversation),
    asObj(asObj(payload.response)?.conversationMetadata),
    asObj(asObj(payload.response)?.conversation_metadata),
    asObj(payload.payload),
    asObj(asObj(payload.payload)?.newConversation),
    asObj(asObj(payload.payload)?.new_conversation),
  ]
  for (const cand of candidates) {
    const id = readConvIdFromObj(cand)
    if (id) return id
  }
  if (typeof payload.rawOutput === 'string') {
    const m = payload.rawOutput.match(/Conversation ID:\s*([A-Za-z0-9_-]{4,120})/i)
    if (m?.[1]) return m[1].trim()
  }
  return undefined
}

export function readDevToolsPort(portFile: string): number | undefined {
  const envPort = process.env.AGY_BOARD_CDP_PORT
  if (envPort) {
    const p = Number(envPort.trim())
    if (Number.isInteger(p) && p >= 1 && p <= 65535) return p
    return undefined
  }
  const candidates = existsSync(portFile) ? [portFile] : resolveDevToolsPortFileCandidates()
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const firstLine = readFileSync(candidate, 'utf8').split(/\r?\n/)[0]?.trim()
      const port = Number(firstLine)
      if (Number.isInteger(port) && port >= 1 && port <= 65535) return port
    } catch {
      // try next candidate
    }
  }
  return undefined
}

export interface CdpTarget {
  type?: string
  title?: string
  url?: string
  webSocketDebuggerUrl?: string
}

function isExcludedTargetOrigin(targetUrl: URL, excludeOrigin?: string): boolean {
  if (!excludeOrigin) return false
  try {
    const ex = new URL(excludeOrigin)
    const isLoopback = (h: string) => h === '127.0.0.1' || h === 'localhost'
    if (isLoopback(targetUrl.hostname) && isLoopback(ex.hostname)) {
      const effPort = (u: URL) => u.port || (u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '')
      return targetUrl.protocol === ex.protocol && effPort(targetUrl) === effPort(ex)
    }
    return targetUrl.origin.toLowerCase() === ex.origin.toLowerCase()
  } catch {
    return false
  }
}

export function selectHubTarget(targets: readonly CdpTarget[], options?: { excludeOrigin?: string }): CdpTarget | undefined {
  const localPages: CdpTarget[] = []
  const fallbackPages: CdpTarget[] = []
  for (const t of targets) {
    if (!t || t.type !== 'page' || !t.webSocketDebuggerUrl) continue
    if (String(t.title ?? '').trim().toLowerCase() === 'agy board') continue
    const url = String(t.url ?? '')
    const lower = url.toLowerCase()
    if (
      lower.startsWith('devtools://') ||
      lower.startsWith('data:') ||
      lower.startsWith('about:') ||
      lower.startsWith('chrome-extension://')
    ) {
      continue
    }
    try {
      const parsed = new URL(url)
      if (isExcludedTargetOrigin(parsed, options?.excludeOrigin)) continue
      if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
        localPages.push(t)
      } else {
        fallbackPages.push(t)
      }
    } catch {
      fallbackPages.push(t)
    }
  }
  if (localPages.length > 0) {
    const convHub = localPages.find((t) => {
      try {
        return new URL(String(t.url ?? '')).pathname.startsWith('/c/')
      } catch {
        return false
      }
    })
    if (convHub) return convHub
    const rootHub = localPages.find((t) => {
      try {
        return new URL(String(t.url ?? '')).pathname === '/'
      } catch {
        return false
      }
    })
    return rootHub ?? localPages[0]
  }
  return fallbackPages[0]
}

function fetchCdpTargets(port: number, timeoutMs = 1500): Promise<CdpTarget[]> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/json/list',
        method: 'GET',
        agent: false,
        headers: { Connection: 'close' },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            resolve(Array.isArray(parsed) ? (parsed as CdpTarget[]) : [])
          } catch (err) {
            reject(err)
          }
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('CDP /json/list timeout')))
    req.end()
  })
}

async function cdpEvaluateNavigate(wsUrl: string, conversationId: string, timeoutMs = 2000): Promise<string | undefined> {
  const parsed = new URL(wsUrl)
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error(`Refusing non-loopback CDP WebSocket host: ${parsed.hostname}`)
  }
  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port <= 0) throw new Error('Invalid CDP WebSocket port')
  const path = `${parsed.pathname || '/'}${parsed.search || ''}`
  const wsKey = randomBytes(16).toString('base64')
  const expectedAccept = createHash('sha1').update(`${wsKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')

  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: parsed.hostname, port })
    socket.setTimeout(timeoutMs)
    let buf = Buffer.alloc(0)
    let handshakeDone = false
    let settled = false
    let navResult: string | undefined

    const finish = (err?: Error, navPath?: string) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        // ignore
      }
      if (err) reject(err)
      else resolve(navPath)
    }

    const sendText = (text: string) => {
      const payload = Buffer.from(text, 'utf8')
      const mask = randomBytes(4)
      const header: number[] = [0x81]
      if (payload.length < 126) {
        header.push(0x80 | payload.length)
      } else if (payload.length < 65536) {
        header.push(0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff)
      } else {
        throw new Error('CDP frame too large')
      }
      const masked = Buffer.allocUnsafe(payload.length)
      for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i & 3]
      socket.write(Buffer.concat([Buffer.from(header), mask, masked]))
    }

    const parseFrames = () => {
      while (buf.length >= 2) {
        const b1 = buf[0]
        const b2 = buf[1]
        const opcode = b1 & 0x0f
        const isMasked = Boolean(b2 & 0x80)
        let len = b2 & 0x7f
        let offset = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          offset = 4
        } else if (len === 127) {
          if (buf.length < 10) return
          len = Number(buf.readBigUInt64BE(2))
          offset = 10
        }
        const totalLen = offset + (isMasked ? 4 : 0) + len
        if (buf.length < totalLen) return
        let payload = buf.subarray(offset + (isMasked ? 4 : 0), totalLen)
        if (isMasked) {
          const mask = buf.subarray(offset, offset + 4)
          const copy = Buffer.allocUnsafe(len)
          for (let i = 0; i < len; i += 1) copy[i] = payload[i] ^ mask[i & 3]
          payload = copy
        }
        buf = buf.subarray(totalLen)
        if (opcode === 0x8) {
          finish(new Error('CDP WebSocket closed'))
          return
        }
        if (opcode === 0x1) {
          try {
            const msg = JSON.parse(payload.toString('utf8')) as {
              id?: number
              result?: { result?: { value?: string } }
              error?: { message?: string }
            }
            if (msg.id === 1) {
              const nav = msg.result?.result?.value
              navResult = typeof nav === 'string' ? nav : `/c/${conversationId}`
              sendText(JSON.stringify({ id: 2, method: 'Page.bringToFront' }))
            } else if (msg.id === 2) {
              finish(undefined, navResult ?? `/c/${conversationId}`)
              return
            }
          } catch {
            // ignore non-json frames
          }
        }
      }
    }

    socket.on('connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: ${parsed.hostname}:${port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${wsKey}\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`,
      )
    })

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (!handshakeDone) {
        const marker = buf.indexOf('\r\n\r\n')
        if (marker === -1) return
        const head = buf.subarray(0, marker).toString('latin1')
        buf = buf.subarray(marker + 4)
        if (!head.includes(' 101 ') || !head.includes(expectedAccept)) {
          finish(new Error('CDP WebSocket handshake rejected'))
          return
        }
        handshakeDone = true
        const expr = `(() => { const target = '/c/' + encodeURIComponent(${JSON.stringify(conversationId)}); if (window.location.pathname !== target) { window.history.pushState(null, '', target); window.dispatchEvent(new PopStateEvent('popstate')); } try { window.focus(); } catch (_) {} return window.location.pathname; })()`
        sendText(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression: expr, returnByValue: true },
          }),
        )
      }
      if (handshakeDone) parseFrames()
    })

    socket.on('timeout', () => finish(new Error('CDP WebSocket timeout')))
    socket.on('error', (err) => finish(err))
  })
}

export class DefaultAgentBridge implements AgentBridge {
  private readonly exec: ExecFileFn
  private readonly fetchFn: ConnectFetchFn
  private readonly paths: HostPaths
  private readonly envOverride?: NodeJS.ProcessEnv
  private readonly preferConnect: boolean
  private readonly useDaemonDiscovery: boolean

  constructor(
    paths: HostPaths,
    execImplOrOptions?: ExecFileFn | AgentBridgeOptions,
    options?: AgentBridgeOptions,
  ) {
    this.paths = paths
    const opts =
      typeof execImplOrOptions === 'function'
        ? { ...options, execImpl: execImplOrOptions }
        : { ...execImplOrOptions, ...options }
    const hasCustomExec = opts.execImpl !== undefined && opts.execImpl !== defaultExecFile
    const hasExplicitFetch = opts.fetchImpl !== undefined
    this.exec = opts.execImpl ?? defaultExecFile
    this.fetchFn = opts.fetchImpl ?? defaultConnectFetch
    this.envOverride = opts.env
    this.preferConnect = hasExplicitFetch || !hasCustomExec
    this.useDaemonDiscovery = opts.useDaemonDiscovery ?? true
  }

  private getEnv(): NodeJS.ProcessEnv {
    return this.envOverride ?? process.env
  }

  private async resolveLsConnection(): Promise<LsConnectionInfo | undefined> {
    const env = this.getEnv()
    const rawAddr = env.ANTIGRAVITY_LS_ADDRESS?.trim()
    const csrfToken = env.ANTIGRAVITY_CSRF_TOKEN?.trim()
    if (rawAddr && csrfToken) {
      return {
        address: /^https?:\/\//i.test(rawAddr) ? rawAddr : `http://${rawAddr}`,
        csrfToken,
        source: 'env',
      }
    }
    if (!this.useDaemonDiscovery) return undefined
    return discoverVerifiedLsDaemon(this.paths.daemonDir, this.fetchFn)
  }

  private async callConversationService(
    method: 'CreateConversation' | 'GetConversation' | 'ListConversations' | 'UpdateConversation',
    body: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown>> {
    const conn = await this.resolveLsConnection()
    if (!conn) {
      throw new Error('Antigravity Language Server address/CSRF token unavailable.')
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'x-codeium-csrf-token': conn.csrfToken,
      'x-antigravity-csrf-token': conn.csrfToken,
    }
    const payloadText = JSON.stringify(body)
    const urls = [conn.address]
    if (conn.httpsAddress && conn.httpsAddress !== conn.address) {
      urls.push(conn.httpsAddress)
    } else if (!conn.httpsAddress && conn.address.startsWith('http://')) {
      urls.push(conn.address.replace(/^http:\/\//i, 'https://'))
    }

    let lastErr: unknown
    for (let i = 0; i < urls.length; i += 1) {
      const base = urls[i].replace(/\/+$/, '')
      try {
        const res = await this.fetchFn(`${base}/product.v1.ConversationService/${method}`, {
          method: 'POST',
          headers,
          body: payloadText,
          timeoutMs,
        })
        const rawText = await res.text()
        let parsed: Record<string, unknown> = {}
        if (rawText.trim()) {
          try {
            const val = JSON.parse(rawText) as unknown
            if (val && typeof val === 'object' && !Array.isArray(val)) {
              parsed = val as Record<string, unknown>
            }
          } catch {
            if (res.ok) {
              throw new Error(`ConversationService/${method} returned invalid JSON`)
            }
          }
        }
        if (!res.ok) {
          const errMsg =
            typeof parsed.message === 'string'
              ? parsed.message
              : typeof parsed.error === 'string'
                ? parsed.error
                : rawText || `HTTP ${res.status}`
          const tlsSchemeMismatch =
            base.startsWith('http://') &&
            (res.status === 400 || res.status === 426) &&
            /\bhttps\b|\btls\b/i.test(rawText)
          const err = new Error(`ConversationService/${method} failed (${res.status}): ${errMsg}`)
          if (tlsSchemeMismatch && i + 1 < urls.length) {
            lastErr = err
            continue
          }
          throw err
        }
        return parsed
      } catch (err) {
        lastErr = err
        // Retry on alternate scheme only on transport error or TLS mismatch
        if (err instanceof Error && err.message.startsWith(`ConversationService/${method} failed (`)) {
          throw err
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  async createConversation(req: NewConversationRequest): Promise<AgentLaunchResult> {
    const body: Record<string, unknown> = {
      prompt: [{ text: req.prompt }],
    }
    if (req.projectId) body.projectId = req.projectId
    if (req.model) body.model = req.model
    if (req.title) body.title = req.title
    if (req.tags && req.tags.length > 0) {
      const normalizedTags = [...new Set(req.tags.map((t) => t.trim()).filter(Boolean))]
      if (normalizedTags.length > 0) body.tags = normalizedTags
    }
    const raw = await this.callConversationService('CreateConversation', body, 20_000)
    const conversationId = extractConversationId(raw)
    if (!conversationId) {
      throw new Error('ConversationService/CreateConversation did not return a conversationId')
    }
    return { conversationId, raw }
  }

  async getConversation(conversationId: string): Promise<Record<string, unknown>> {
    if (!SAFE_CONVERSATION_ID_RE.test(conversationId)) {
      throw new Error(`Invalid conversationId: ${conversationId}`)
    }
    return this.callConversationService('GetConversation', { conversationId }, 5_000)
  }

  async listConversations(req: ListConversationsRequest = {}): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {}
    if (req.pageSize !== undefined) body.pageSize = req.pageSize
    if (req.pageToken !== undefined) body.pageToken = req.pageToken
    if (req.projectId !== undefined) body.projectId = req.projectId
    if (req.parentConversationId !== undefined) body.parentConversationId = req.parentConversationId
    if (req.tags !== undefined) body.tags = req.tags
    if (req.includeArchived !== undefined) body.includeArchived = req.includeArchived
    return this.callConversationService('ListConversations', body, 5_000)
  }

  async updateConversation(
    conversationId: string,
    annotations: UpdateConversationAnnotations,
  ): Promise<Record<string, unknown>> {
    if (!SAFE_CONVERSATION_ID_RE.test(conversationId)) {
      throw new Error(`Invalid conversationId: ${conversationId}`)
    }
    const cleanAnnotations: UpdateConversationAnnotations = {}
    if (annotations.title !== undefined) cleanAnnotations.title = annotations.title
    if (annotations.archived !== undefined) cleanAnnotations.archived = annotations.archived
    if (annotations.pinned !== undefined) cleanAnnotations.pinned = annotations.pinned
    if (annotations.starred !== undefined) cleanAnnotations.starred = annotations.starred
    if (annotations.tags !== undefined) {
      const normalizedTags = [...new Set(annotations.tags.map((t) => t.trim()).filter(Boolean))]
      if (normalizedTags.length > 0) cleanAnnotations.tags = normalizedTags
    }
    if (annotations.conversationGroupId !== undefined) {
      cleanAnnotations.conversationGroupId = annotations.conversationGroupId
    }
    if (Object.keys(cleanAnnotations).length === 0) {
      return {}
    }
    return this.callConversationService(
      'UpdateConversation',
      { conversationId, annotations: cleanAnnotations },
      5_000,
    )
  }

  private async runAgentApi(args: string[], projectId?: string): Promise<Record<string, unknown>> {
    const baseEnv = this.getEnv()
    const { file, prefixArgs } = resolveAgentApiExecutable(baseEnv)
    const env: NodeJS.ProcessEnv = { ...baseEnv }
    if (projectId) {
      env.ANTIGRAVITY_PROJECT_ID = projectId
    } else {
      delete env.ANTIGRAVITY_PROJECT_ID
    }
    delete env.ANTIGRAVITY_CONVERSATION_ID
    if ((!env.ANTIGRAVITY_LS_ADDRESS || !env.ANTIGRAVITY_CSRF_TOKEN) && this.useDaemonDiscovery) {
      const discovered = await discoverVerifiedLsDaemon(this.paths.daemonDir, this.fetchFn)
      if (discovered) {
        env.ANTIGRAVITY_LS_ADDRESS = discovered.address.replace(/^https?:\/\//i, '')
        env.ANTIGRAVITY_CSRF_TOKEN = discovered.csrfToken
      }
    }
    const { stdout } = await this.exec(file, [...prefixArgs, ...args], {
      encoding: 'utf8',
      env,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    })
    const trimmed = stdout.trim()
    if (!trimmed) return {}
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      if (parsed && typeof parsed === 'object' && parsed.error) {
        const errText =
          typeof parsed.error === 'string'
            ? parsed.error
            : typeof (parsed.error as Record<string, unknown>)?.message === 'string'
              ? String((parsed.error as Record<string, unknown>).message)
              : JSON.stringify(parsed.error)
        if (errText.trim()) throw new Error(`agentapi error: ${errText}`)
      }
      return parsed
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('agentapi error:')) throw err
      return { rawOutput: trimmed }
    }
  }

  async startConversation(req: NewConversationRequest): Promise<AgentLaunchResult> {
    const startViaCli = async (): Promise<AgentLaunchResult> => {
      const args = ['new-conversation']
      if (req.model) args.push('--model', req.model)
      if (req.title) args.push('--title', req.title)
      if (req.profile) args.push('--profile', req.profile)
      if (req.prompt.startsWith('-')) args.push('--')
      args.push(req.prompt)
      const raw = await this.runAgentApi(args, req.projectId)
      const conversationId = extractConversationId(raw)
      if (!conversationId) {
        throw new Error('agentapi new-conversation did not return a conversationId')
      }
      return { conversationId, raw }
    }

    if (this.preferConnect && !req.profile) {
      try {
        return await this.createConversation(req)
      } catch (connectErr) {
        try {
          return await startViaCli()
        } catch {
          throw connectErr
        }
      }
    }
    if (this.preferConnect && req.profile) {
      try {
        return await startViaCli()
      } catch (cliErr) {
        try {
          return await this.createConversation(req)
        } catch {
          throw cliErr
        }
      }
    }
    return startViaCli()
  }

  async sendMessage(req: SendMessageRequest): Promise<AgentLaunchResult> {
    if (!SAFE_CONVERSATION_ID_RE.test(req.conversationId)) {
      throw new Error(`Invalid conversationId: ${req.conversationId}`)
    }
    const args = ['send-message']
    if (req.title) args.push('--title', req.title)
    if (req.conversationId.startsWith('-') || req.message.startsWith('-')) args.push('--')
    args.push(req.conversationId, req.message)
    const raw = await this.runAgentApi(args, req.projectId)
    return { conversationId: extractConversationId(raw) ?? req.conversationId, raw }
  }

  async getConversationMetadata(conversationId: string): Promise<Record<string, unknown>> {
    if (!SAFE_CONVERSATION_ID_RE.test(conversationId)) {
      throw new Error(`Invalid conversationId: ${conversationId}`)
    }
    if (this.preferConnect) {
      try {
        const res = await this.getConversation(conversationId)
        const conv = asObj(res.conversation) ?? res
        const meta = asObj(conv.metadata) ?? {}
        return {
          ...res,
          conversation: conv,
          metadata: meta,
          response: asObj(res.response) ?? {
            conversationMetadata: {
              conversationId: conv.id ?? conversationId,
              metadata: meta,
            },
          },
        }
      } catch {
        // Fallback to agentapi CLI
      }
    }
    return this.runAgentApi(['get-conversation-metadata', conversationId])
  }

  async jumpToConversation(conversationId: string, options?: { excludeOrigin?: string }): Promise<JumpResult> {
    if (!SAFE_CONVERSATION_ID_RE.test(conversationId)) {
      return { ok: false, method: 'none', conversationId, reason: 'Invalid conversationId format.' }
    }
    const port = readDevToolsPort(this.paths.devToolsActivePortFile)
    if (port === undefined) {
      return {
        ok: false,
        method: 'none',
        conversationId,
        reason: 'Antigravity DevToolsActivePort not found (start via CDP launcher or open inside Sidecar Aux Pane).',
      }
    }
    try {
      const targets = await fetchCdpTargets(port)
      const hub = selectHubTarget(targets, options)
      if (!hub?.webSocketDebuggerUrl) {
        return { ok: false, method: 'none', conversationId, port, reason: 'No Antigravity Hub page target found.' }
      }
      const navigatedPath = await cdpEvaluateNavigate(hub.webSocketDebuggerUrl, conversationId)
      return { ok: true, method: 'cdp', conversationId, port, navigatedPath }
    } catch (err) {
      return {
        ok: false,
        method: 'none',
        conversationId,
        port,
        reason: err instanceof Error ? err.message : String(err),
      }
    }
  }
}
