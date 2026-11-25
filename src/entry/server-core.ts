/**
 * Shared standalone loopback server & static asset helpers (no top-level auto-start).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BoardDatabase, BoardScheduler, BoardService, resolveHostPaths, type HostPathOverrides } from '../host/index.ts'
import { buildBoardApiRoutes, formatApiError } from './router.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

export const MIME_TYPES: ReadonlyMap<string, string> = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.json', 'application/json; charset=utf-8'],
  ['.woff2', 'font/woff2'],
])

const EPIPE_GUARD_SYM = Symbol.for('agy-board.epipe-guard')

export function installEpipeGuard(proc: NodeJS.Process = process): void {
  const flagged = proc as unknown as Record<symbol, boolean>
  if (flagged[EPIPE_GUARD_SYM]) return
  flagged[EPIPE_GUARD_SYM] = true
  const isEpipe = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'EPIPE'
  for (const stream of [proc.stdout, proc.stderr]) {
    stream?.on?.('error', (err) => {
      if (!isEpipe(err)) throw err
    })
  }
  const onFatal = (err: unknown) => {
    if (isEpipe(err)) return
    try {
      console.error('[agy-board] fatal:', err)
    } catch {
      // ignore stderr failure
    }
    proc.exit(1)
  }
  proc.on('uncaughtException', onFatal)
  proc.on('unhandledRejection', onFatal)
}

export function releasePluginCwdLock(dbPath: string): void {
  if (!dbPath || dbPath === ':memory:') return
  const targetDir = dirname(dbPath)
  try {
    if (existsSync(targetDir)) {
      process.chdir(targetDir)
    }
  } catch {
    // Ignore chdir failures in restricted or test environments
  }
}

export function resolvePublicDir(explicitDir?: string): string {
  if (explicitDir && existsSync(explicitDir)) return explicitDir
  const candidates = [
    join(HERE, 'public'),
    resolve(HERE, '..', '..', 'sidecars', 'board', 'public'),
    resolve(HERE, '..', 'sidecars', 'board', 'public'),
  ]
  for (const cand of candidates) {
    if (existsSync(join(cand, 'index.html'))) return cand
  }
  return candidates[0]
}

export function collectStaticFiles(rootDir: string, prefix = ''): Map<string, { filePath: string; contentType: string }> {
  const map = new Map<string, { filePath: string; contentType: string }>()
  if (!existsSync(rootDir)) return map
  for (const entry of readdirSync(rootDir)) {
    const full = join(rootDir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      for (const [k, v] of collectStaticFiles(full, `${prefix}/${entry}`)) {
        map.set(k, v)
      }
    } else if (st.isFile()) {
      const urlPath = `${prefix}/${entry}`
      const contentType = MIME_TYPES.get(extname(entry).toLowerCase()) ?? 'application/octet-stream'
      map.set(urlPath, { filePath: full, contentType })
      if (urlPath === '/index.html') {
        map.set('/', { filePath: full, contentType })
      }
    }
  }
  return map
}

export interface StandaloneServerHandle {
  server: Server
  port: number
  url: string
  service: BoardService
  scheduler: BoardScheduler
  close(): Promise<void>
}

export async function startStandaloneServer(options: {
  port?: number
  publicDir?: string
  paths?: HostPathOverrides
  schedulerIntervalMs?: number
  boardOptions?: ConstructorParameters<typeof BoardService>[2]
} = {}): Promise<StandaloneServerHandle> {
  const paths = resolveHostPaths(options.paths)
  const db = new BoardDatabase(paths.dbPath)
  const sseClients = new Set<ServerResponse>()
  let lastBroadcastRevision = db.getRevision()

  const broadcastRevision = (rev: number) => {
    if (rev === lastBroadcastRevision) return
    lastBroadcastRevision = rev
    const payload = `event: revision\ndata: ${JSON.stringify({ revision: rev })}\n\n`
    for (const res of sseClients) {
      try {
        res.write(payload)
      } catch {
        sseClients.delete(res)
      }
    }
  }

  const service = new BoardService(db, paths, {
    ...options.boardOptions,
    onChanged: (rev) => {
      options.boardOptions?.onChanged?.(rev)
      broadcastRevision(rev)
    },
  })
  const scheduler = new BoardScheduler(service, options.schedulerIntervalMs ?? 15_000)
  scheduler.start()

  // Poll SQLite revision every 900ms so cross-process MCP/Hook updates reach SSE clients cleanly
  const revPollTimer = setInterval(() => {
    try {
      const current = db.getRevision()
      if (current !== lastBroadcastRevision) broadcastRevision(current)
    } catch {
      // ignore transient poll error
    }
  }, 900)
  revPollTimer.unref?.()

  const routes = buildBoardApiRoutes(service)
  const routeMap = new Map<string, (data: Record<string, unknown>) => Promise<unknown> | unknown>()
  for (const r of routes) {
    routeMap.set(`${r.method} ${r.path}`, r.handler)
  }

  const publicDir = resolvePublicDir(options.publicDir)

  const server = createServer(async (req, res) => {
    const hostHeader = req.headers.host || '127.0.0.1'
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(hostHeader)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }
    const url = new URL(req.url ?? '/', `http://${hostHeader}`)
    const method = (req.method ?? 'GET').toUpperCase()

    if (method === 'GET' && url.pathname === '/preload.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end('// Standalone preview: no Antigravity host iframe bridge.\n')
      return
    }

    if (method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(`event: revision\ndata: ${JSON.stringify({ revision: db.getRevision() })}\n\n`)
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }

    const apiHandler = routeMap.get(`${method} ${url.pathname}`)
    if (apiHandler) {
      let bodyText = ''
      for await (const chunk of req) {
        bodyText += chunk
        if (bodyText.length > 2 * 1024 * 1024) {
          res.writeHead(413, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Payload too large' }))
          return
        }
      }
      const data: Record<string, unknown> = {}
      for (const [k, v] of url.searchParams.entries()) {
        if (k.toLowerCase() !== 'token') data[k] = v
      }
      if (bodyText.trim()) {
        try {
          Object.assign(data, JSON.parse(bodyText))
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON request body' }))
          return
        }
      }
      try {
        const result = await apiHandler(data)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(result))
      } catch (err) {
        const formatted = formatApiError(err)
        res.writeHead(formatted.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(formatted.body))
      }
      return
    }

    if (method === 'GET') {
      const staticMap = collectStaticFiles(publicDir)
      const asset = staticMap.get(url.pathname) ?? (url.pathname.startsWith('/api/') ? undefined : staticMap.get('/'))
      if (asset && existsSync(asset.filePath)) {
        res.writeHead(200, {
          'Content-Type': asset.contentType,
          'Cache-Control': url.pathname === '/' ? 'no-store' : 'public, max-age=3600',
        })
        res.end(readFileSync(asset.filePath))
        return
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'Not found' }))
  })

  const requestedPort = options.port ?? Number(process.env.AGY_BOARD_PORT ?? 17910)
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(requestedPort, '127.0.0.1', () => {
      server.removeListener('error', rejectListen)
      resolveListen()
    })
  })
  const addr = server.address()
  const actualPort = typeof addr === 'object' && addr ? addr.port : requestedPort

  return {
    server,
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    service,
    scheduler,
    close: async () => {
      clearInterval(revPollTimer)
      scheduler.stop()
      for (const client of sseClients) {
        try {
          client.end()
        } catch {
          // ignore
        }
      }
      sseClients.clear()
      service.admissionQueue.drain()
      await new Promise<void>((r) => server.close(() => r()))
      db.close()
    },
  }
}
