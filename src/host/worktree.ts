/**
 * Safe Git worktree isolation helpers for task execution.
 * Creates/reuses `.worktrees/agy-board-<taskId>` inside a git repo without shell interpolation.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { isPathEqualOrInside, normalizeFsPath } from '../core/index.ts'

export type GitExecFn = (
  file: string,
  args: readonly string[],
  options: { encoding: 'utf8'; windowsHide: boolean; maxBuffer: number; timeout: number },
) => Promise<{ stdout: string; stderr: string }>

function defaultGitExec(
  file: string,
  args: readonly string[],
  options: { encoding: 'utf8'; windowsHide: boolean; maxBuffer: number; timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(file, [...args], options, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message
        rejectPromise(new Error(msg))
        return
      }
      resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

export interface WorktreeEnsureResult {
  ok: true
  repoRoot: string
  worktreePath: string
  worktreeBranch: string
  reused: boolean
}

export interface WorktreeErrorResult {
  ok: false
  reason: 'invalid-path' | 'not-git-repo' | 'git-failed' | 'unsafe-path'
  message: string
}

export interface WorktreeDiffResult {
  ok: true
  worktreePath: string
  branch: string
  status: string
  diff: string
  hasChanges: boolean
  truncated: boolean
}

export interface WorktreeCleanupResult {
  ok: true
  removedPath: string
  branchDeleted: boolean
}

const MAX_DIFF_CHARS = 256 * 1024

function sanitizeTaskSegment(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'task'
}

async function runGit(args: readonly string[], execImpl: GitExecFn): Promise<string> {
  const { stdout } = await execImpl('git', args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 15_000,
  })
  return stdout
}

export async function ensureTaskWorktree(
  workspacePath: string,
  taskId: string,
  execImpl: GitExecFn = defaultGitExec,
): Promise<WorktreeEnsureResult | WorktreeErrorResult> {
  const trimmed = workspacePath?.trim()
  if (!trimmed) {
    return { ok: false, reason: 'invalid-path', message: 'Workspace path is required for git worktree isolation.' }
  }
  const absWorkspace = resolve(trimmed)
  try {
    if (!existsSync(absWorkspace) || !statSync(absWorkspace).isDirectory()) {
      return { ok: false, reason: 'invalid-path', message: `Workspace directory does not exist: ${absWorkspace}` }
    }
  } catch {
    return { ok: false, reason: 'invalid-path', message: `Workspace directory is inaccessible: ${absWorkspace}` }
  }

  let repoRoot: string
  try {
    repoRoot = normalizeFsPath((await runGit(['-C', absWorkspace, 'rev-parse', '--show-toplevel'], execImpl)).trim())
  } catch (err) {
    return {
      ok: false,
      reason: 'not-git-repo',
      message: err instanceof Error ? err.message : 'Not a git repository.',
    }
  }
  if (!repoRoot) {
    return { ok: false, reason: 'not-git-repo', message: 'Could not resolve git repository root.' }
  }

  const safeId = sanitizeTaskSegment(taskId)
  const worktreesRoot = join(repoRoot, '.worktrees')
  const worktreeDir = normalizeFsPath(join(worktreesRoot, `agy-board-${safeId}`))
  const branchName = `agy-board/${safeId}`

  if (existsSync(worktreeDir)) {
    try {
      const inside = (await runGit(['-C', worktreeDir, 'rev-parse', '--is-inside-work-tree'], execImpl)).trim()
      if (inside === 'true') {
        const currentBranch = (
          await runGit(['-C', worktreeDir, 'rev-parse', '--abbrev-ref', 'HEAD'], execImpl).catch(() => branchName)
        ).trim()
        return {
          ok: true,
          repoRoot,
          worktreePath: worktreeDir,
          worktreeBranch: currentBranch || branchName,
          reused: true,
        }
      }
    } catch {
      return {
        ok: false,
        reason: 'git-failed',
        message: `Existing path at ${worktreeDir} is not a valid git worktree.`,
      }
    }
  }

  mkdirSync(worktreesRoot, { recursive: true })
  let branchExists = false
  try {
    await runGit(['-C', repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], execImpl)
    branchExists = true
  } catch {
    branchExists = false
  }

  try {
    if (branchExists) {
      await runGit(['-C', repoRoot, 'worktree', 'add', worktreeDir, branchName], execImpl)
    } else {
      await runGit(['-C', repoRoot, 'worktree', 'add', '-b', branchName, worktreeDir], execImpl)
    }
    return {
      ok: true,
      repoRoot,
      worktreePath: worktreeDir,
      worktreeBranch: branchName,
      reused: false,
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'git-failed',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function getTaskWorktreeDiff(
  worktreePath: string,
  execImpl: GitExecFn = defaultGitExec,
): Promise<WorktreeDiffResult | WorktreeErrorResult> {
  const absWorktree = resolve(worktreePath)
  if (!existsSync(absWorktree)) {
    return { ok: false, reason: 'invalid-path', message: `Worktree does not exist: ${absWorktree}` }
  }
  try {
    const inside = (await runGit(['-C', absWorktree, 'rev-parse', '--is-inside-work-tree'], execImpl)).trim()
    if (inside !== 'true') {
      return { ok: false, reason: 'not-git-repo', message: `Not a git worktree: ${absWorktree}` }
    }
    const branch = (await runGit(['-C', absWorktree, 'rev-parse', '--abbrev-ref', 'HEAD'], execImpl).catch(() => '')).trim()
    const status = (await runGit(['-C', absWorktree, 'status', '--porcelain=v1'], execImpl)).trimEnd()
    const unstaged = await runGit(['-C', absWorktree, 'diff'], execImpl)
    const staged = await runGit(['-C', absWorktree, 'diff', '--cached'], execImpl)
    let combined = [staged ? `# Staged\n${staged}` : '', unstaged ? `# Unstaged\n${unstaged}` : '']
      .filter(Boolean)
      .join('\n')
    const truncated = combined.length > MAX_DIFF_CHARS
    if (truncated) combined = combined.slice(0, MAX_DIFF_CHARS)
    return {
      ok: true,
      worktreePath: normalizeFsPath(absWorktree),
      branch,
      status,
      diff: combined,
      hasChanges: Boolean(status.trim() || combined.trim()),
      truncated,
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'git-failed',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function cleanupTaskWorktree(
  workspacePath: string | undefined,
  worktreePath: string,
  branch?: string,
  force = false,
  execImpl: GitExecFn = defaultGitExec,
): Promise<WorktreeCleanupResult | WorktreeErrorResult> {
  const absWorktree = resolve(worktreePath)
  const dirName = basename(absWorktree)
  if (!dirName.startsWith('agy-board-')) {
    return { ok: false, reason: 'unsafe-path', message: `Refusing to remove non-agy-board path: ${absWorktree}` }
  }
  const parentRepo = workspacePath?.trim() ? resolve(workspacePath.trim()) : resolve(absWorktree, '..', '..')
  let repoRoot: string
  try {
    repoRoot = normalizeFsPath((await runGit(['-C', parentRepo, 'rev-parse', '--show-toplevel'], execImpl)).trim())
  } catch (err) {
    return {
      ok: false,
      reason: 'not-git-repo',
      message: err instanceof Error ? err.message : 'Not a git repository.',
    }
  }
  const allowedRoot = join(repoRoot, '.worktrees')
  if (!isPathEqualOrInside(absWorktree, allowedRoot) || absWorktree === resolve(allowedRoot)) {
    return { ok: false, reason: 'unsafe-path', message: `Worktree path escapes .worktrees root: ${absWorktree}` }
  }

  try {
    if (existsSync(absWorktree)) {
      const removeArgs = ['-C', repoRoot, 'worktree', 'remove']
      if (force) removeArgs.push('--force')
      removeArgs.push(absWorktree)
      await runGit(removeArgs, execImpl)
    }
    await runGit(['-C', repoRoot, 'worktree', 'prune'], execImpl).catch(() => '')
  } catch (err) {
    return {
      ok: false,
      reason: 'git-failed',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  let branchDeleted = false
  if (branch && branch.startsWith('agy-board/')) {
    try {
      await runGit(['-C', repoRoot, 'branch', force ? '-D' : '-d', branch], execImpl)
      branchDeleted = true
    } catch {
      branchDeleted = false
    }
  }

  return {
    ok: true,
    removedPath: normalizeFsPath(absWorktree),
    branchDeleted,
  }
}
