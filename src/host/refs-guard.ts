/**
 * Strict read-only TaskSpace deliverable / reference preview guard.
 * Only files explicitly registered on the task (`task.refs` or `task.handover.references`)
 * may be read, preventing arbitrary filesystem disclosure.
 */
import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileUriToPath, isPathEqualOrInside, type TaskRecord, type TaskRefRecord } from '../core/index.ts'

export const MAX_PREVIEW_BYTES = 256 * 1024

export interface RefPreviewResult {
  ok: true
  refId: string
  kind: string
  target: string
  resolvedPath?: string
  isUrl?: boolean
  isBinary?: boolean
  language: string
  sizeBytes: number
  truncated: boolean
  content: string
}

export interface RefPreviewError {
  ok: false
  code: 'not-registered' | 'invalid-path' | 'not-found' | 'not-a-file' | 'symlink-escape' | 'unreadable'
  message: string
}

const LANGUAGE_BY_EXT: ReadonlyMap<string, string> = new Map([
  ['.ts', 'typescript'],
  ['.tsx', 'tsx'],
  ['.js', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.jsx', 'jsx'],
  ['.json', 'json'],
  ['.md', 'markdown'],
  ['.mdx', 'markdown'],
  ['.py', 'python'],
  ['.sql', 'sql'],
  ['.css', 'css'],
  ['.html', 'html'],
  ['.yml', 'yaml'],
  ['.yaml', 'yaml'],
  ['.sh', 'bash'],
  ['.ps1', 'powershell'],
  ['.txt', 'text'],
  ['.log', 'text'],
])

const WINDOWS_DEVICE_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

export function toFileUri(fsPath: string): string {
  const normalized = fsPath.trim().toLowerCase().startsWith('file://') ? fileUriToPath(fsPath) : fsPath.trim()
  return pathToFileURL(resolve(normalized)).href
}

export function resolveAllowedRefPath(
  target: string,
  workspacePath?: string,
): { ok: true; path: string } | { ok: false; message: string } {
  let trimmed = target.trim()
  if (trimmed.toLowerCase().startsWith('file://')) {
    trimmed = fileUriToPath(trimmed)
  }
  if (!trimmed || trimmed.includes('\0')) {
    return { ok: false, message: 'Empty or invalid path containing NUL byte.' }
  }
  if (trimmed.startsWith('\\\\?\\') || trimmed.startsWith('\\\\.\\')) {
    return { ok: false, message: 'Device paths are not permitted.' }
  }
  const baseSegment = trimmed.split(/[\\/]/).pop() ?? ''
  if (WINDOWS_DEVICE_RE.test(baseSegment)) {
    return { ok: false, message: 'Reserved device names are not permitted.' }
  }

  if (isAbsolute(trimmed)) {
    return { ok: true, path: resolve(trimmed) }
  }
  if (!workspacePath) {
    return { ok: false, message: 'Relative ref path requires a task workspacePath.' }
  }
  const resolvedRoot = resolve(workspacePath.toLowerCase().startsWith('file://') ? fileUriToPath(workspacePath) : workspacePath)
  const resolvedTarget = resolve(resolvedRoot, trimmed)
  if (!isPathEqualOrInside(resolvedTarget, resolvedRoot)) {
    return { ok: false, message: 'Relative ref escapes task workspace root.' }
  }
  return { ok: true, path: resolvedTarget }
}

export function previewTaskRef(
  task: TaskRecord,
  refIdOrTarget: string,
): RefPreviewResult | RefPreviewError {
  const registeredRef: TaskRefRecord | undefined = task.refs.find(
    (r) => r.id === refIdOrTarget || r.target === refIdOrTarget,
  )
  const registeredHandover = task.handover?.references.find((r) => r === refIdOrTarget)

  if (!registeredRef && !registeredHandover) {
    return {
      ok: false,
      code: 'not-registered',
      message: 'Target is not registered in this task TaskSpace references.',
    }
  }

  const kind = registeredRef?.kind ?? 'doc'
  const target = registeredRef?.target ?? registeredHandover!
  const refId = registeredRef?.id ?? `handover:${target}`

  if (kind === 'url' || isHttpUrl(target)) {
    return {
      ok: true,
      refId,
      kind: 'url',
      target,
      isUrl: true,
      language: 'text',
      sizeBytes: Buffer.byteLength(target, 'utf8'),
      truncated: false,
      content: target,
    }
  }

  if (kind === 'command') {
    return {
      ok: true,
      refId,
      kind: 'command',
      target,
      language: 'bash',
      sizeBytes: Buffer.byteLength(target, 'utf8'),
      truncated: false,
      content: target,
    }
  }

  const normalizedTarget = target.trim().toLowerCase().startsWith('file://') ? fileUriToPath(target) : target.trim()
  const pathCheck = resolveAllowedRefPath(normalizedTarget, task.workspacePath)
  if (!pathCheck.ok) {
    return { ok: false, code: 'invalid-path', message: pathCheck.message }
  }

  const resolvedPath = pathCheck.path
  try {
    // Ensure target exists (even as a dangling symlink) before resolving realpath
    lstatSync(resolvedPath)
    const realTarget = realpathSync(resolvedPath)
    if (
      task.workspacePath &&
      (!isAbsolute(normalizedTarget) || isPathEqualOrInside(resolvedPath, resolve(task.workspacePath)))
    ) {
      const realRoot = realpathSync(resolve(task.workspacePath))
      if (!isPathEqualOrInside(realTarget, realRoot)) {
        return { ok: false, code: 'symlink-escape', message: 'Symlink escapes workspace boundary.' }
      }
    }
    const st = statSync(realTarget)
    if (!st.isFile()) {
      return { ok: false, code: 'not-a-file', message: 'Registered reference does not point to a regular file.' }
    }

    const totalBytes = st.size
    const truncated = totalBytes > MAX_PREVIEW_BYTES
    const toRead = Math.min(totalBytes, MAX_PREVIEW_BYTES)
    const slice = Buffer.allocUnsafe(toRead)
    if (toRead > 0) {
      const fd = openSync(realTarget, 'r')
      try {
        let offset = 0
        while (offset < toRead) {
          const n = readSync(fd, slice, offset, toRead - offset, offset)
          if (n <= 0) break
          offset += n
        }
      } finally {
        closeSync(fd)
      }
    }

    const isBinary = slice.subarray(0, Math.min(slice.length, 4096)).includes(0)
    const ext = extname(realTarget).toLowerCase()
    const language = LANGUAGE_BY_EXT.get(ext) ?? 'text'

    if (isBinary) {
      return {
        ok: true,
        refId,
        kind,
        target,
        resolvedPath: realTarget,
        isBinary: true,
        language,
        sizeBytes: totalBytes,
        truncated: false,
        content: `[Binary file: ${ext || 'unknown'}, ${totalBytes} bytes]`,
      }
    }

    return {
      ok: true,
      refId,
      kind,
      target,
      resolvedPath: realTarget,
      isBinary: false,
      language,
      sizeBytes: totalBytes,
      truncated,
      content: slice.toString('utf8'),
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      return { ok: false, code: 'not-found', message: `Referenced file not found: ${resolvedPath}` }
    }
    return {
      ok: false,
      code: 'unreadable',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}
