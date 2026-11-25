/**
 * Dual-mode Sidecar & Standalone Web Server entrypoint for agy-board.
 * - When ANTIGRAVITY_SIDECAR_WEB_PORT is set, attaches to Antigravity's `sidecar_sdk`.
 * - Otherwise launches a loopback-only HTTP server with SSE live updates.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pathComparisonKey } from '../core/index.ts'
import { BoardDatabase, BoardScheduler, BoardService, resolveHostPaths } from '../host/index.ts'
import { buildBoardApiRoutes, formatApiError } from './router.ts'
import {
  collectStaticFiles,
  installEpipeGuard,
  releasePluginCwdLock,
  resolvePublicDir,
  startStandaloneServer,
} from './server-core.ts'

export { installEpipeGuard, releasePluginCwdLock, resolvePublicDir, startStandaloneServer, type StandaloneServerHandle } from './server-core.ts'

async function loadSidecarSdkModule(geminiConfigDir: string, antigravityDataDir: string): Promise<{
  SidecarApp: new () => {
    page(path: string, handler: () => unknown): void
    api(path: string, handler: (data: Record<string, unknown>) => unknown, method?: string): void
    run(): Promise<unknown>
    close(): Promise<void>
  }
  Response: new (body: string | Buffer, opts?: { contentType?: string; status?: number; headers?: Record<string, string> }) => unknown
}> {
  const pkgName = 'sidecar_sdk'
  try {
    return (await import(pkgName)) as never
  } catch {
    try {
      const resolved = createRequire(import.meta.url).resolve(pkgName)
      return (await import(pathToFileURL(resolved).href)) as never
    } catch {
      const candidates = [
        process.env.ANTIGRAVITY_SIDECAR_SDK_PATH,
        join(antigravityDataDir, 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'),
        join(geminiConfigDir, 'node_modules', 'sidecar_sdk', 'index.mjs'),
        join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'),
      ].filter((p): p is string => Boolean(p && p.trim()))
      const found = candidates.find((p) => existsSync(p)) ?? candidates[0]
      return (await import(pathToFileURL(found).href)) as never
    }
  }
}

function isMainModule(metaUrl: string): boolean {
  if (!process.argv[1]) return false
  try {
    const argvReal = realpathSync(resolve(process.argv[1]))
    const metaReal = realpathSync(fileURLToPath(metaUrl))
    return pathComparisonKey(argvReal) === pathComparisonKey(metaReal)
  } catch {
    return pathComparisonKey(resolve(process.argv[1])) === pathComparisonKey(fileURLToPath(metaUrl))
  }
}

export async function main(): Promise<void> {
  installEpipeGuard()
  if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
    const paths = resolveHostPaths()
    const db = new BoardDatabase(paths.dbPath)
    const service = new BoardService(db, paths)
    const scheduler = new BoardScheduler(service)
    const { SidecarApp, Response } = await loadSidecarSdkModule(paths.geminiConfigDir, paths.antigravityDataDir)
    const app = new SidecarApp()

    const publicDir = resolvePublicDir()
    releasePluginCwdLock(paths.dbPath)
    const staticMap = collectStaticFiles(publicDir)
    for (const [urlPath, asset] of staticMap.entries()) {
      const serveAsset = () =>
        new Response(readFileSync(asset.filePath), {
          contentType: asset.contentType,
          headers: { 'Cache-Control': urlPath === '/' || urlPath === '/index.html' ? 'no-store' : 'public, max-age=3600' },
        })
      if (urlPath === '/' || urlPath === '/index.html') {
        app.page(urlPath, serveAsset)
      } else {
        app.api(urlPath, serveAsset, 'GET')
      }
    }

    for (const route of buildBoardApiRoutes(service)) {
      app.api(
        route.path,
        async (data: Record<string, unknown>) => {
          try {
            return await route.handler(data)
          } catch (err) {
            const formatted = formatApiError(err)
            return new Response(JSON.stringify(formatted.body), {
              status: formatted.status,
              contentType: 'application/json; charset=utf-8',
              headers: { 'Cache-Control': 'no-store' },
            })
          }
        },
        route.method,
      )
    }

    await app.run()

    // Override sidecar_sdk's synchronous execFileSync /_sidecar/* handlers AFTER app.run()
    // with fast async ConversationService Connect HTTP+JSON / async agentapi fallback.
    app.api(
      '/_sidecar/get-conversation-metadata',
      async (data: Record<string, unknown> = {}) => {
        const convId = String(data.conversationId ?? '').trim()
        if (!convId) return {}
        return service.agentBridge.getConversationMetadata(convId)
      },
      'POST',
    )
    app.api(
      '/_sidecar/new-conversation',
      async (data: Record<string, unknown> = {}) => {
        const prompt = String(data.message ?? data.prompt ?? '')
        const res = await service.agentBridge.startConversation({
          prompt,
          title: typeof data.title === 'string' ? data.title : undefined,
          model: typeof data.model === 'string' ? data.model : undefined,
          profile: typeof data.profile === 'string' ? data.profile : undefined,
          projectId: typeof data.projectId === 'string' && data.projectId.trim() ? data.projectId.trim() : undefined,
        })
        return {
          ...res.raw,
          conversationId: res.conversationId,
          response: (res.raw as Record<string, unknown>).response ?? {
            newConversation: { conversationId: res.conversationId },
          },
        }
      },
      'POST',
    )
    app.api(
      '/_sidecar/send-message',
      async (data: Record<string, unknown> = {}) => {
        const res = await service.agentBridge.sendMessage({
          conversationId: String(data.conversationId ?? ''),
          message: String(data.message ?? ''),
          title: typeof data.title === 'string' ? data.title : undefined,
          projectId: typeof data.projectId === 'string' && data.projectId.trim() ? data.projectId.trim() : undefined,
        })
        return {
          ...res.raw,
          conversationId: res.conversationId,
        }
      },
      'POST',
    )

    scheduler.start()

    const shutdown = async () => {
      scheduler.stop()
      service.admissionQueue.drain()
      await app.close()
      db.close()
      process.exit(0)
    }
    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.once(sig, () => {
        void shutdown()
      })
    }
  } else {
    const handle = await startStandaloneServer()
    releasePluginCwdLock(handle.service.db.dbPath)
    console.log(`Agy Board standalone server listening at ${handle.url}`)
    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.once(sig, () => {
        void handle.close().then(() => process.exit(0))
      })
    }
  }
}

if (isMainModule(import.meta.url)) {
  void main()
}
