/**
 * Workspace URI/path normalization and Antigravity project matching.
 * Pure functions so Windows/POSIX paths and file:/// URIs behave consistently.
 */
import type { WorkspaceRecord } from './types.ts'

export function normalizeFsPath(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  let normalized = trimmed
  if (normalized.toLowerCase().startsWith('file://')) {
    normalized = fileUriToPath(normalized)
  }
  // Normalize slashes and trailing separator
  const hasWindowsDrive = /^[A-Za-z]:[\\/]/.test(normalized) || /^[A-Za-z]:$/.test(normalized)
  if (hasWindowsDrive) {
    normalized = normalized.replace(/\//g, '\\')
    if (/^[a-z]:/.test(normalized)) {
      normalized = normalized[0].toUpperCase() + normalized.slice(1)
    }
    if (normalized.length > 3) {
      normalized = normalized.replace(/\\+$/, '')
    }
    return normalized
  }
  normalized = normalized.replace(/\\+/g, '/')
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/, '')
  }
  return normalized
}

export function fileUriToPath(uri: string): string {
  const trimmed = uri.trim()
  if (!trimmed.toLowerCase().startsWith('file://')) return trimmed
  try {
    const parsed = new URL(trimmed)
    let pathname = decodeURIComponent(parsed.pathname)
    // Windows file:///e%3A/foo -> /E:/foo -> E:\foo
    if (/^\/[A-Za-z]:/.test(pathname)) {
      pathname = pathname.slice(1)
      return pathname[0].toUpperCase() + pathname.slice(1).replace(/\//g, '\\')
    }
    if (parsed.hostname && parsed.hostname !== 'localhost') {
      return `\\\\${parsed.hostname}${pathname.replace(/\//g, '\\')}`
    }
    return pathname
  } catch {
    return trimmed.replace(/^file:\/\//i, '')
  }
}

export function pathComparisonKey(raw: string): string {
  const norm = normalizeFsPath(raw)
  if (!norm) return ''
  const isWin = /^[A-Za-z]:/.test(norm) || norm.startsWith('\\\\')
  return isWin ? norm.replace(/\\/g, '/').toLowerCase() : norm
}

export function isPathEqualOrInside(candidateRaw: string, parentRaw: string): boolean {
  const candidate = pathComparisonKey(candidateRaw)
  const parent = pathComparisonKey(parentRaw)
  if (!candidate || !parent) return false
  if (candidate === parent) return true
  const prefix = parent.endsWith('/') ? parent : `${parent}/`
  return candidate.startsWith(prefix)
}

/**
 * Find the best matching WorkspaceRecord (and its antigravityProjectId) for a local folder path.
 * Uses longest-prefix matching across workspace rootPath and folderPaths.
 */
export function matchWorkspaceForPath(
  targetPath: string,
  workspaces: readonly WorkspaceRecord[],
): WorkspaceRecord | undefined {
  const targetKey = pathComparisonKey(targetPath)
  if (!targetKey) return undefined
  let best: WorkspaceRecord | undefined
  let bestScore = -1
  for (const ws of workspaces) {
    const candidates = [ws.rootPath, ...ws.folderPaths].filter(Boolean)
    for (const candidate of candidates) {
      if (!isPathEqualOrInside(targetPath, candidate)) continue
      const score = pathComparisonKey(candidate).length + (ws.source === 'custom' ? 0.5 : 0)
      if (score > bestScore) {
        bestScore = score
        best = ws
      }
    }
  }
  return best
}

export function matchProjectIdForWorkspace(
  workspaceId: string | undefined,
  workspacePath: string | undefined,
  workspaces: readonly WorkspaceRecord[],
): string | undefined {
  if (workspaceId) {
    const exact = workspaces.find((w) => w.id === workspaceId || w.antigravityProjectId === workspaceId)
    if (exact?.antigravityProjectId) return exact.antigravityProjectId
    if (exact?.source === 'antigravity') return exact.id
  }
  if (workspacePath) {
    const matched = matchWorkspaceForPath(workspacePath, workspaces)
    if (matched?.antigravityProjectId) return matched.antigravityProjectId
    if (matched?.source === 'antigravity') return matched.id
  }
  return undefined
}
