/**
 * Read-only discovery of Antigravity projects/workspaces (`~/.gemini/config/projects/*.json`)
 * and recent conversations (`~/.gemini/antigravity/conversation_summaries.db`), merged
 * with custom workspaces stored in agy-board SQLite.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  fileUriToPath,
  isPathEqualOrInside,
  matchProjectIdForWorkspace,
  normalizeFsPath,
  pathComparisonKey,
  type DiscoveredConversation,
  type WorkspaceRecord,
} from '../core/index.ts'
import type { BoardDatabase } from './db.ts'
import type { HostPaths } from './paths.ts'

function summarizeCols(db: DatabaseSync): Set<string> {
  const rows = db.prepare('PRAGMA table_info(conversation_summaries)').all() as Array<{ name?: string }>
  return new Set(rows.map((r) => String(r.name ?? '')))
}

function rowToConversation(row: Record<string, unknown>, hasNotFullyIdle: boolean): DiscoveredConversation {
  let uris: string[] = []
  try {
    const raw = JSON.parse(String(row.workspace_uris ?? '[]'))
    if (Array.isArray(raw)) uris = raw.filter((v): v is string => typeof v === 'string')
  } catch {
    uris = []
  }
  const workspacePaths = uris.map((u) => normalizeFsPath(fileUriToPath(u))).filter(Boolean)
  const projectId = String(row.project_id ?? '')
  const status = String(row.status ?? '')
  const notFullyIdle = hasNotFullyIdle ? Boolean(row.not_fully_idle) : false
  const isIdle = status === 'CASCADE_RUN_STATUS_IDLE' && !notFullyIdle
  const parsedTime = Date.parse(String(row.last_modified_time ?? ''))

  return {
    conversationId: String(row.conversation_id),
    title: String(row.title ?? '').trim() || '(Untitled conversation)',
    preview: String(row.preview ?? '').slice(0, 160),
    projectId,
    workspacePaths,
    status,
    isIdle,
    stepCount: Number(row.step_count ?? 0),
    lastModifiedAt: Number.isFinite(parsedTime) ? parsedTime : 0,
  }
}

function extractFolderPathsFromProject(raw: Record<string, unknown>): string[] {
  const projectResources = raw.projectResources as Record<string, unknown> | undefined
  if (!projectResources || !Array.isArray(projectResources.resources)) return []
  const folders: string[] = []
  for (const res of projectResources.resources) {
    if (!res || typeof res !== 'object') continue
    const rec = res as Record<string, unknown>
    if (typeof rec.folderUri === 'string' && rec.folderUri.trim()) {
      folders.push(normalizeFsPath(fileUriToPath(rec.folderUri)))
    }
    const gitFolder = rec.gitFolder as Record<string, unknown> | undefined
    if (gitFolder && typeof gitFolder.folderUri === 'string' && gitFolder.folderUri.trim()) {
      folders.push(normalizeFsPath(fileUriToPath(gitFolder.folderUri)))
    }
  }
  return [...new Set(folders.filter(Boolean))]
}

export function readAntigravityProjects(paths: HostPaths): WorkspaceRecord[] {
  if (!existsSync(paths.projectsDir)) return []
  let files: string[]
  try {
    files = readdirSync(paths.projectsDir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }

  const workspaces: WorkspaceRecord[] = []
  for (const file of files) {
    const full = join(paths.projectsDir, file)
    try {
      const content = readFileSync(full, 'utf8').replace(/^\uFEFF/, '')
      const parsed = JSON.parse(content) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object') continue
      // Skip internal sidecar pseudo-projects (e.g. swarm/swarm_board with projectResources: {})
      if (parsed.sidecar) continue
      const id = String(parsed.id ?? basename(file, '.json'))
      const folderPaths = extractFolderPathsFromProject(parsed)
      if (folderPaths.length === 0 && id === 'default-cli-project') continue
      const rootPath = folderPaths[0] ?? ''
      const name = String(parsed.name ?? (rootPath ? basename(rootPath) : id))
      const mtimeMs = Math.round(statSync(full).mtimeMs)
      workspaces.push({
        id,
        name,
        rootPath,
        folderPaths,
        antigravityProjectId: id,
        source: 'antigravity',
        pinned: false,
        createdAt: mtimeMs,
      })
    } catch {
      // Ignore malformed project JSON
    }
  }
  return workspaces
}

export function listMergedWorkspaces(db: BoardDatabase, paths: HostPaths): WorkspaceRecord[] {
  const agy = readAntigravityProjects(paths)
  const custom = db.listCustomWorkspaces()
  const byId = new Map<string, WorkspaceRecord>()

  for (const ws of agy) {
    byId.set(ws.id, ws)
  }
  for (const ws of custom) {
    const existing = byId.get(ws.id)
    if (existing) {
      byId.set(ws.id, {
        ...existing,
        name: ws.name?.trim() ? ws.name : existing.name,
        pinned: ws.pinned ?? existing.pinned,
        lastUsedAt: ws.lastUsedAt ?? existing.lastUsedAt,
      })
    } else {
      byId.set(ws.id, ws)
    }
  }

  return [...byId.values()].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
    const aTime = a.lastUsedAt ?? a.createdAt
    const bTime = b.lastUsedAt ?? b.createdAt
    if (a.source !== b.source) return a.source === 'custom' ? -1 : 1
    return bTime - aTime
  })
}

export function updateCustomWorkspace(
  db: BoardDatabase,
  paths: HostPaths,
  workspaceId: string,
  patch: { name?: string; rootPath?: string; pinned?: boolean },
  now = Date.now(),
): WorkspaceRecord | { errorCode: string; message: string } {
  const merged = listMergedWorkspaces(db, paths)
  const existing = merged.find((w) => w.id === workspaceId)
  if (!existing) {
    return { errorCode: 'workspace-not-found', message: `No workspace with id '${workspaceId}'.` }
  }

  let nextRootPath = existing.rootPath
  let nextFolderPaths = existing.folderPaths
  let nextProjectId = existing.antigravityProjectId

  if (patch.rootPath !== undefined) {
    const normalized = normalizeFsPath(patch.rootPath)
    if (!normalized) {
      return { errorCode: 'invalid-workspace', message: 'Workspace rootPath must not be empty.' }
    }
    if (existing.source === 'antigravity' && pathComparisonKey(normalized) !== pathComparisonKey(existing.rootPath)) {
      return {
        errorCode: 'cannot-edit-host-workspace-path',
        message: 'Cannot alter rootPath of an Antigravity-managed project workspace.',
      }
    }
    if (existing.source === 'custom') {
      nextRootPath = normalized
      nextFolderPaths = [normalized]
      nextProjectId = matchProjectIdForWorkspace(undefined, normalized, merged.filter((w) => w.id !== workspaceId))
    }
  }

  const nextName = patch.name !== undefined ? patch.name.trim() || existing.name : existing.name
  const updated: WorkspaceRecord = {
    ...existing,
    name: nextName,
    rootPath: nextRootPath,
    folderPaths: nextFolderPaths,
    antigravityProjectId: nextProjectId,
    pinned: patch.pinned ?? existing.pinned ?? false,
    lastUsedAt: now,
  }
  db.upsertWorkspace(updated)
  return updated
}

export function deleteCustomWorkspace(
  db: BoardDatabase,
  paths: HostPaths,
  workspaceId: string,
): { ok: true } | { ok: false; errorCode: string; message: string } {
  const inDb = db.getWorkspace(workspaceId)
  const isHostProject = readAntigravityProjects(paths).some((w) => w.id === workspaceId)
  if (isHostProject || inDb?.source === 'antigravity') {
    return {
      ok: false,
      errorCode: 'cannot-delete-host-workspace',
      message: 'Cannot delete an Antigravity-managed project workspace.',
    }
  }
  if (!inDb) {
    return { ok: false, errorCode: 'workspace-not-found', message: `No custom workspace with id '${workspaceId}'.` }
  }
  db.deleteWorkspace(workspaceId)
  return { ok: true }
}

export function readRecentConversations(
  paths: HostPaths,
  options: { limit?: number; projectId?: string; workspacePath?: string } = {},
): { available: boolean; conversations: DiscoveredConversation[] } {
  if (!existsSync(paths.conversationSummariesDb)) {
    return { available: false, conversations: [] }
  }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(paths.conversationSummariesDb, { readOnly: true, timeout: 150 })
    const cols = summarizeCols(db)
    const hasNotFullyIdle = cols.has('not_fully_idle')
    const selectIdleCol = hasNotFullyIdle ? ', not_fully_idle' : ''
    const limit = Math.min(Math.max(options.limit ?? 80, 1), 300)
    const hasFilter = Boolean(options.projectId || options.workspacePath)
    const fetchLimit = hasFilter ? Math.max(limit * 10, 1000) : limit
    const rows = db
      .prepare(
        `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, project_id${selectIdleCol}
         FROM conversation_summaries
         WHERE COALESCE(parent_conversation_id, '') = '' AND COALESCE(killed, 0) = 0
         ORDER BY last_modified_time DESC
         LIMIT ?`,
      )
      .all(fetchLimit) as Array<Record<string, unknown>>

    const targetPathKey = options.workspacePath ? pathComparisonKey(options.workspacePath) : ''
    const conversations: DiscoveredConversation[] = []

    for (const row of rows) {
      const conv = rowToConversation(row, hasNotFullyIdle)

      if (options.projectId && conv.projectId !== options.projectId) {
        if (!targetPathKey) continue
      }
      if (options.workspacePath) {
        const matchesPath = conv.workspacePaths.some(
          (p) => isPathEqualOrInside(p, options.workspacePath!) || isPathEqualOrInside(options.workspacePath!, p),
        )
        if (!matchesPath && (!options.projectId || conv.projectId !== options.projectId)) continue
      }

      conversations.push(conv)
      if (conversations.length >= limit) break
    }

    return { available: true, conversations }
  } catch {
    return { available: false, conversations: [] }
  } finally {
    try {
      db?.close()
    } catch {
      // ignore close failure
    }
  }
}

export function findConversationsByIds(
  paths: HostPaths,
  conversationIds: readonly string[],
): { available: boolean; map: Map<string, DiscoveredConversation> } {
  const uniqueIds = [...new Set(conversationIds.map((id) => id.trim()).filter(Boolean))]
  const map = new Map<string, DiscoveredConversation>()
  if (uniqueIds.length === 0 || !existsSync(paths.conversationSummariesDb)) {
    return { available: existsSync(paths.conversationSummariesDb), map }
  }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(paths.conversationSummariesDb, { readOnly: true, timeout: 150 })
    const cols = summarizeCols(db)
    const hasNotFullyIdle = cols.has('not_fully_idle')
    const selectIdleCol = hasNotFullyIdle ? ', not_fully_idle' : ''

    for (let i = 0; i < uniqueIds.length; i += 200) {
      const chunk = uniqueIds.slice(i, i + 200)
      const placeholders = chunk.map(() => '?').join(',')
      const rows = db
        .prepare(
          `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, project_id${selectIdleCol}
           FROM conversation_summaries
           WHERE conversation_id IN (${placeholders})`,
        )
        .all(...chunk) as Array<Record<string, unknown>>
      for (const row of rows) {
        const conv = rowToConversation(row, hasNotFullyIdle)
        map.set(conv.conversationId, conv)
      }
    }
    return { available: true, map }
  } catch {
    return { available: false, map }
  } finally {
    try {
      db?.close()
    } catch {
      // ignore close failure
    }
  }
}

export interface ConversationLineage {
  parentConversationId?: string
  rootConversationId?: string
  nestingDepth: number
  ancestors: string[]
}

export function resolveConversationLineage(paths: HostPaths, conversationId: string): ConversationLineage {
  const convId = conversationId.trim()
  if (!convId || !existsSync(paths.conversationSummariesDb)) {
    return { nestingDepth: 0, ancestors: [] }
  }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(paths.conversationSummariesDb, { readOnly: true, timeout: 150 })
    const cols = summarizeCols(db)
    const hasParentCol = cols.has('parent_conversation_id')
    const hasDepthCol = cols.has('nesting_depth')
    const hasParentsTable = Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_parents'").get(),
    )

    const summaryStmt = hasParentCol
      ? db.prepare(
          `SELECT parent_conversation_id${hasDepthCol ? ', nesting_depth' : ''} FROM conversation_summaries WHERE conversation_id = ?`,
        )
      : undefined
    const parentTableStmt = hasParentsTable
      ? db.prepare('SELECT parent_id FROM conversation_parents WHERE conversation_id = ?')
      : undefined

    let directParent: string | undefined
    let nestingDepth = 0
    const ancestors: string[] = []
    const visited = new Set<string>([convId])
    let cursor = convId

    for (let hop = 0; hop < 8; hop += 1) {
      let nextParent = ''
      if (summaryStmt) {
        const row = summaryStmt.get(cursor) as { parent_conversation_id?: unknown; nesting_depth?: unknown } | undefined
        if (hop === 0 && typeof row?.nesting_depth === 'number' && Number.isFinite(row.nesting_depth)) {
          nestingDepth = row.nesting_depth
        }
        if (typeof row?.parent_conversation_id === 'string' && row.parent_conversation_id.trim()) {
          nextParent = row.parent_conversation_id.trim()
        }
      }
      if (!nextParent && parentTableStmt) {
        const row = parentTableStmt.get(cursor) as { parent_id?: unknown } | undefined
        if (typeof row?.parent_id === 'string' && row.parent_id.trim()) {
          nextParent = row.parent_id.trim()
        }
      }
      if (!nextParent || visited.has(nextParent)) break
      if (hop === 0) directParent = nextParent
      ancestors.push(nextParent)
      visited.add(nextParent)
      cursor = nextParent
    }

    return {
      parentConversationId: directParent,
      rootConversationId: ancestors.at(-1),
      nestingDepth: nestingDepth > 0 ? nestingDepth : ancestors.length,
      ancestors,
    }
  } catch {
    return { nestingDepth: 0, ancestors: [] }
  } finally {
    try {
      db?.close()
    } catch {
      // ignore close failure
    }
  }
}
