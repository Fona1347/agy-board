/**
 * Standalone CLI for agy-board (`serve`, `doctor`, `workspaces`, `list`, `create`, `dispatch`).
 */
import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BoardDatabase,
  BoardService,
  discoverVerifiedLsDaemon,
  readAntigravityProjects,
  readDevToolsPort,
  readRecentConversations,
  resolveAgentApiExecutable,
  resolveHostPaths,
  type HostPathOverrides,
} from '../host/index.ts'
import {
  isPathEqualOrInside,
  matchProjectIdForWorkspace,
  pathComparisonKey,
  type TaskPhase,
  type TaskPriority,
} from '../core/index.ts'
import { installEpipeGuard, startStandaloneServer, type StandaloneServerHandle } from './server-core.ts'

const BOOLEAN_FLAGS = new Set([
  'json',
  'force',
  'dry-run',
  'help',
  'all',
  'include-archived',
  'archived',
  'use-worktree',
])

export function parseCliArgs(argv: string[]): { command: string; positional: string[]; flags: Map<string, string | boolean> } {
  const flags = new Map<string, string | boolean>()
  const positional: string[] = []
  let stopFlags = false

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!stopFlags && token === '--') {
      stopFlags = true
      continue
    }
    if (!stopFlags && (token === '-h' || token === '--help')) {
      flags.set('help', true)
      continue
    }
    if (!stopFlags && token.startsWith('--')) {
      const eq = token.indexOf('=')
      if (eq !== -1) {
        const key = token.slice(2, eq)
        const rawVal = token.slice(eq + 1)
        if (BOOLEAN_FLAGS.has(key)) {
          flags.set(key, rawVal !== 'false' && rawVal !== '0')
        } else {
          flags.set(key, rawVal)
        }
      } else {
        const key = token.slice(2)
        if (BOOLEAN_FLAGS.has(key)) {
          flags.set(key, true)
        } else {
          const next = argv[i + 1]
          if (next !== undefined && !next.startsWith('--')) {
            flags.set(key, next)
            i += 1
          } else {
            flags.set(key, true)
          }
        }
      }
    } else {
      positional.push(token)
    }
  }
  const command = flags.get('help') === true && positional.length === 0 ? 'help' : (positional.shift() ?? 'help')
  return { command, positional, flags }
}

function parseTimestampFlag(raw: string | boolean | undefined): number | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const trimmed = raw.trim()
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed)
    return Number.isFinite(num) ? Math.trunc(num) : undefined
  }
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

export async function runCli(
  argv: string[],
  pathOverrides?: HostPathOverrides,
): Promise<{ exitCode: number; output: string; command?: string; handle?: StandaloneServerHandle }> {
  const { command, positional, flags } = parseCliArgs(argv)
  const dbOverride = typeof flags.get('db') === 'string' ? (flags.get('db') as string) : pathOverrides?.dbPath
  const overrides: HostPathOverrides = { ...pathOverrides, ...(dbOverride ? { dbPath: dbOverride } : {}) }
  const asJson = flags.get('json') === true

  if (flags.get('help') === true || command === 'help') {
    return {
      command: 'help',
      exitCode: 0,
      output: [
        'agy-board CLI',
        '  serve [--port 17910] [--db path]',
        '  doctor [--json]',
        '  workspaces [--json]',
        '  list [--phase needs_you|active|on_hold|todo|closed] [--workspace str] [--include-archived|--archived|--all] [--json]',
        '  create --title "..." [--workspace path] [--priority urgent|high|normal|low] [--due iso|ms] [--use-worktree] [--json]',
        '  dispatch <taskId> [--mode auto|new|resume|rework] [--rework "..."] [--model str] [--use-worktree] [--dry-run] [--json]',
      ].join('\n'),
    }
  }

  if (command === 'serve') {
    const port = typeof flags.get('port') === 'string' ? Number(flags.get('port')) : undefined
    const handle = await startStandaloneServer({ port, paths: overrides })
    return { command: 'serve', exitCode: 0, output: `Listening on ${handle.url}`, handle }
  }

  const knownCommands = new Set(['serve', 'doctor', 'workspaces', 'list', 'create', 'dispatch'])
  if (!knownCommands.has(command)) {
    return {
      command,
      exitCode: 2,
      output: [
        `Unknown command: ${command}`,
        'agy-board CLI',
        '  serve [--port 17910] [--db path]',
        '  doctor [--json]',
        '  workspaces [--json]',
        '  list [--phase needs_you|active|on_hold|todo|closed] [--workspace str] [--include-archived|--archived|--all] [--json]',
        '  create --title "..." [--workspace path] [--priority urgent|high|normal|low] [--due iso|ms] [--use-worktree] [--json]',
        '  dispatch <taskId> [--mode auto|new|resume|rework] [--rework "..."] [--model str] [--use-worktree] [--dry-run] [--json]',
      ].join('\n'),
    }
  }

  const paths = resolveHostPaths(overrides)

  if (command === 'doctor') {
    const agentExe = resolveAgentApiExecutable()
    const cdpPort = readDevToolsPort(paths.devToolsActivePortFile)
    const dbExists = existsSync(paths.dbPath)
    let workspacesCount = readAntigravityProjects(paths).length
    if (dbExists) {
      const db = new BoardDatabase(paths.dbPath, { recoverOrphans: false })
      try {
        const service = new BoardService(db, paths)
        workspacesCount = service.listWorkspaces().length
      } finally {
        db.close()
      }
    }
    const convs = readRecentConversations(paths, { limit: 10 })
    const daemon = await discoverVerifiedLsDaemon(paths.daemonDir)
    const report = {
      ok: true,
      readOnly: !dbExists,
      dbPath: paths.dbPath,
      dbExists,
      projectsDir: paths.projectsDir,
      projectsDirExists: existsSync(paths.projectsDir),
      workspacesCount,
      conversationSummariesExists: existsSync(paths.conversationSummariesDb),
      recentConversationsSample: convs.conversations.length,
      agentApi: agentExe,
      lsDaemon: daemon ? { address: daemon.address, lsVersion: daemon.lsVersion ?? null, pid: daemon.pid ?? null } : null,
      cdpPort: cdpPort ?? null,
      agyKitSchemeBCompatible: true,
    }
    return {
      command,
      exitCode: 0,
      output: asJson
        ? JSON.stringify(report, null, 2)
        : [
            `agy-board doctor [OK]`,
            `  db: ${report.dbPath} (exists=${report.dbExists})`,
            `  workspaces: ${report.workspacesCount} (projectsDir=${report.projectsDirExists})`,
            `  conversationsDb: ${report.conversationSummariesExists}`,
            `  agentapi: ${report.agentApi.file}`,
            `  lsDaemon: ${report.lsDaemon?.address ?? 'not-detected'}`,
            `  cdpPort: ${report.cdpPort ?? 'not-detected'}`,
          ].join('\n'),
    }
  }

  const db = new BoardDatabase(paths.dbPath, { recoverOrphans: false })
  const service = new BoardService(db, paths)

  try {
    if (command === 'workspaces') {
      const workspaces = service.listWorkspaces()
      return {
        command,
        exitCode: 0,
        output: asJson
          ? JSON.stringify({ workspaces }, null, 2)
          : workspaces.map((w) => `- ${w.name} [${w.source}] ${w.rootPath || '(no path)'} (${w.id})`).join('\n'),
      }
    }

    if (command === 'list') {
      const includeArchived =
        flags.get('include-archived') === true || flags.get('archived') === true || flags.get('all') === true
      const snap = service.getSnapshot({ includeArchived })
      const phaseFilter = typeof flags.get('phase') === 'string' ? (flags.get('phase') as TaskPhase) : undefined
      const wsRaw = typeof flags.get('workspace') === 'string' ? String(flags.get('workspace')).trim() : ''
      const wsKey = wsRaw ? pathComparisonKey(wsRaw) : ''
      const wsLower = wsRaw.toLowerCase()
      const wsProjectId = wsRaw ? matchProjectIdForWorkspace(wsRaw, wsRaw, snap.workspaces) : undefined

      const tasks = snap.tasks.filter((t) => {
        if (!includeArchived && t.archivedAt !== undefined) return false
        if (phaseFilter && t.phase !== phaseFilter) return false
        if (wsRaw) {
          const matchesId = t.workspaceId === wsRaw || (wsProjectId !== undefined && t.workspaceId === wsProjectId)
          const matchesNormalizedPath = Boolean(
            t.workspacePath &&
              (isPathEqualOrInside(t.workspacePath, wsRaw) ||
                isPathEqualOrInside(wsRaw, t.workspacePath) ||
                (wsKey && pathComparisonKey(t.workspacePath).includes(wsKey))),
          )
          const matchesText =
            (t.workspacePath ?? '').toLowerCase().includes(wsLower) ||
            (t.workspaceLabel ?? '').toLowerCase().includes(wsLower)
          if (!matchesId && !matchesNormalizedPath && !matchesText) return false
        }
        return true
      })
      return {
        command,
        exitCode: 0,
        output: asJson
          ? JSON.stringify({ counts: snap.counts, tasks }, null, 2)
          : tasks
              .map(
                (t) =>
                  `[${t.phase}/${t.subPhase}] ${t.title} (${t.id.slice(0, 8)})` +
                  (t.workspaceLabel ? ` @ ${t.workspaceLabel}` : ''),
              )
              .join('\n') || '(no tasks)',
      }
    }

    if (command === 'create') {
      const title = typeof flags.get('title') === 'string' ? String(flags.get('title')) : positional.join(' ')
      const dueRaw = flags.get('due') ?? flags.get('due-at') ?? flags.get('dueAt')
      const dueAt = parseTimestampFlag(dueRaw)
      if (dueRaw !== undefined && dueAt === undefined) {
        throw new Error(`Invalid --due timestamp: ${String(dueRaw)}`)
      }
      const remRaw = flags.get('reminder') ?? flags.get('reminder-at') ?? flags.get('reminderAt')
      const reminderAt = parseTimestampFlag(remRaw)
      if (remRaw !== undefined && reminderAt === undefined) {
        throw new Error(`Invalid --reminder timestamp: ${String(remRaw)}`)
      }
      const task = service.createTask(
        {
          title,
          description: typeof flags.get('description') === 'string' ? String(flags.get('description')) : undefined,
          prompt: typeof flags.get('prompt') === 'string' ? String(flags.get('prompt')) : undefined,
          workspaceId: typeof flags.get('workspace-id') === 'string' ? String(flags.get('workspace-id')) : undefined,
          workspacePath: typeof flags.get('workspace') === 'string' ? String(flags.get('workspace')) : undefined,
          priority: typeof flags.get('priority') === 'string' ? (flags.get('priority') as TaskPriority) : undefined,
          nextAction: typeof flags.get('next-action') === 'string' ? String(flags.get('next-action')) : undefined,
          mode: typeof flags.get('mode') === 'string' ? String(flags.get('mode')) : undefined,
          model: typeof flags.get('model') === 'string' ? String(flags.get('model')) : undefined,
          dueAt,
          reminderAt,
          useWorktree: flags.get('use-worktree') === true,
        },
        'cli',
      )
      return {
        command,
        exitCode: 0,
        output: asJson ? JSON.stringify({ ok: true, task }, null, 2) : `Created ${task.id}: ${task.title}`,
      }
    }

    if (command === 'dispatch') {
      const taskId = positional[0] ?? (typeof flags.get('task') === 'string' ? String(flags.get('task')) : '')
      const mode = typeof flags.get('mode') === 'string' ? String(flags.get('mode')) : 'auto'
      const rework = typeof flags.get('rework') === 'string' ? String(flags.get('rework')) : undefined
      const dryRun = flags.get('dry-run') === true
      if (dryRun) {
        const task = service.getTask(taskId)
        if (!task) throw new Error(`No task with id '${taskId}'.`)
        const summary = {
          ok: true,
          dryRun: true,
          taskId: task.id,
          title: task.title,
          mode,
          workspaceId: task.workspaceId ?? null,
          workspacePath: task.workspacePath ?? null,
          useWorktree: flags.get('use-worktree') === true || Boolean(task.useWorktree),
        }
        return {
          command,
          exitCode: 0,
          output: asJson ? JSON.stringify(summary, null, 2) : `Dry-run dispatch for ${task.id} (${mode})`,
        }
      }
      const res = await service.dispatchTask(taskId, {
        mode: mode as 'auto' | 'new' | 'resume' | 'rework',
        reworkInstructions: rework,
        subgoalId: typeof flags.get('subgoal') === 'string' ? String(flags.get('subgoal')) : undefined,
        model: typeof flags.get('model') === 'string' ? String(flags.get('model')) : undefined,
        profile: typeof flags.get('profile') === 'string' ? String(flags.get('profile')) : undefined,
        useWorktree: flags.get('use-worktree') === true ? true : undefined,
        source: 'cli',
      })
      return {
        command,
        exitCode: 0,
        output: asJson
          ? JSON.stringify({ ok: true, ...res }, null, 2)
          : `Dispatched (${res.action}) -> conversation ${res.conversationId}`,
      }
    }
    return { command, exitCode: 2, output: '' }
  } finally {
    db.close()
  }
}

function isMainCli(): boolean {
  if (!process.argv[1]) return false
  try {
    return (
      pathComparisonKey(realpathSync(resolve(process.argv[1]))) ===
      pathComparisonKey(realpathSync(fileURLToPath(import.meta.url)))
    )
  } catch {
    return pathComparisonKey(resolve(process.argv[1])) === pathComparisonKey(fileURLToPath(import.meta.url))
  }
}

if (isMainCli()) {
  installEpipeGuard()
  void runCli(process.argv.slice(2))
    .then((res) => {
      if (res.output) console.log(res.output)
      if (res.command === 'serve' && res.handle) {
        const handle = res.handle
        let closing = false
        const shutdown = async () => {
          if (closing) return
          closing = true
          try {
            await handle.close()
          } finally {
            process.exit(0)
          }
        }
        for (const sig of ['SIGINT', 'SIGTERM'] as const) {
          process.once(sig, () => {
            void shutdown()
          })
        }
      } else {
        process.exit(res.exitCode)
      }
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    })
}
