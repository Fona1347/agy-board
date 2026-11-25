/**
 * Antigravity lifecycle hook entrypoint (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`).
 * Reads hook JSON from stdin and writes contract-compliant JSON to stdout.
 */
import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathComparisonKey } from '../core/index.ts'
import { BoardDatabase, BoardService, resolveHostPaths, type HostPathOverrides } from '../host/index.ts'
import { installEpipeGuard } from './server-core.ts'

export function processHookInput(
  rawInput: string,
  pathOverrides?: HostPathOverrides,
): Record<string, unknown> {
  const trimmed = rawInput.trim()
  if (!trimmed) return { decision: 'allow' }
  let payload: Record<string, unknown>
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { decision: 'allow' }
    payload = parsed as Record<string, unknown>
  } catch {
    return { decision: 'allow' }
  }

  let db: BoardDatabase | undefined
  try {
    const paths = resolveHostPaths(pathOverrides)
    if (paths.dbPath !== ':memory:' && !existsSync(paths.dbPath)) {
      return { decision: 'allow' }
    }
    db = new BoardDatabase(paths.dbPath, { recoverOrphans: false })
    const service = new BoardService(db, paths)
    return service.handleHookEvent(payload)
  } catch {
    return { decision: 'allow' }
  } finally {
    try {
      db?.close()
    } catch {
      // ignore
    }
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  installEpipeGuard()
  const input = await readAllStdin()
  const output = processHookInput(input)
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

function isMainHook(): boolean {
  if (!process.argv[1]) return false
  try {
    return (
      pathComparisonKey(realpathSync(resolve(process.argv[1]))) ===
      pathComparisonKey(realpathSync(fileURLToPath(import.meta.url)))
    )
  } catch {
    return process.argv[1].endsWith('hook.mjs') || process.argv[1].endsWith('hook.ts')
  }
}

if (isMainHook()) {
  void main()
}
