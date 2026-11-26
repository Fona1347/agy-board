/**
 * SQLite persistence layer built on Node 22+ native `node:sqlite`.
 * Implements idempotent migrations, WAL concurrency, monotonic revision tracking,
 * and normalized domain hydration.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  computeSubgoalRollup,
  normalizeTags,
  reconcilePhaseStatus,
  type CanonicalStatus,
  type ConversationLink,
  type ConversationRole,
  type ExecutionContractSnapshot,
  type ExecutionOutcome,
  type ExecutionRecord,
  type ScheduleRule,
  type SubgoalKind,
  type SubgoalRecord,
  type SubgoalStatus,
  type TaskCommentRecord,
  type TaskEventRecord,
  type TaskFreeze,
  type TaskHandover,
  type TaskPermission,
  type TaskPhase,
  type TaskPriority,
  type TaskRecord,
  type TaskRefKind,
  type TaskRefRecord,
  type TaskSubPhase,
  type TaskTag,
  type TaskUserMarks,
  type WorkspaceRecord,
  type WriteGateMode,
} from '../core/index.ts'

export interface Migration {
  version: number
  name: string
  sql: string
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: '0001_init_board',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS board_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        folder_paths_json TEXT NOT NULL DEFAULT '[]',
        antigravity_project_id TEXT,
        source TEXT NOT NULL DEFAULT 'custom',
        pinned INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workspaces_root_idx ON workspaces(root_path);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL DEFAULT '',
        phase TEXT NOT NULL DEFAULT 'todo',
        sub_phase TEXT NOT NULL DEFAULT 'ready',
        status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'normal',
        workspace_id TEXT,
        workspace_path TEXT,
        workspace_label TEXT,
        blocked_reason TEXT,
        next_action TEXT,
        due_at INTEGER,
        reminder_at INTEGER,
        reminded_at INTEGER,
        sort_order INTEGER NOT NULL DEFAULT 0,
        write_gate TEXT NOT NULL DEFAULT 'unlocked',
        mode TEXT,
        model TEXT,
        reasoning_effort TEXT,
        permission TEXT,
        permission_confirmed_at INTEGER,
        reuse_session INTEGER NOT NULL DEFAULT 1,
        freeze_json TEXT,
        handover_json TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        schedule_json TEXT,
        plan_revision INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        archived_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS tasks_phase_idx ON tasks(phase, sort_order, updated_at);
      CREATE INDEX IF NOT EXISTS tasks_workspace_idx ON tasks(workspace_id, workspace_path);
      CREATE INDEX IF NOT EXISTS tasks_reminder_idx ON tasks(reminder_at);
      CREATE INDEX IF NOT EXISTS tasks_archived_idx ON tasks(archived_at);

      CREATE TABLE IF NOT EXISTS task_subgoals (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'custom',
        required INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'open',
        sort_order INTEGER NOT NULL DEFAULT 0,
        dependencies_json TEXT NOT NULL DEFAULT '[]',
        added_by TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL,
        closed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS task_subgoals_task_idx ON task_subgoals(task_id, sort_order);

      CREATE TABLE IF NOT EXISTS task_refs (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        subgoal_id TEXT,
        kind TEXT NOT NULL,
        target TEXT NOT NULL,
        label TEXT,
        round INTEGER,
        added_by TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_refs_task_idx ON task_refs(task_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS task_refs_dedup_uidx ON task_refs(task_id, kind, target);

      CREATE TABLE IF NOT EXISTS task_conversations (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        subgoal_id TEXT NOT NULL DEFAULT '',
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'primary',
        workspace_id TEXT,
        linked_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, subgoal_id, conversation_id)
      );
      CREATE INDEX IF NOT EXISTS task_conversations_conv_idx ON task_conversations(conversation_id);
      CREATE INDEX IF NOT EXISTS task_conversations_subgoal_idx ON task_conversations(subgoal_id);

      CREATE TABLE IF NOT EXISTS task_executions (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        subgoal_id TEXT,
        conversation_id TEXT,
        workspace_id TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        result TEXT,
        error TEXT,
        summary TEXT,
        initiated_by TEXT,
        rework_instructions TEXT,
        frozen_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS task_executions_task_idx ON task_executions(task_id, started_at);
      CREATE INDEX IF NOT EXISTS task_executions_open_idx ON task_executions(ended_at);

      CREATE TABLE IF NOT EXISTS task_events (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        subgoal_id TEXT,
        conversation_id TEXT,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events(task_id, created_at);

      CREATE TABLE IF NOT EXISTS task_user_marks (
        task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        ignored_at INTEGER,
        acked_at INTEGER,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: '0002_comments_worktree_subgoal_pk',
    sql: `
      CREATE TABLE IF NOT EXISTS task_comments (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        author TEXT NOT NULL DEFAULT 'user',
        body_md TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_comments_task_idx ON task_comments(task_id, created_at);

      CREATE TABLE IF NOT EXISTS task_subgoals_v2 (
        id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'custom',
        required INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'open',
        sort_order INTEGER NOT NULL DEFAULT 0,
        dependencies_json TEXT NOT NULL DEFAULT '[]',
        added_by TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL,
        closed_at INTEGER,
        PRIMARY KEY (task_id, id)
      );
      INSERT OR IGNORE INTO task_subgoals_v2 (
        id, task_id, title, detail, kind, required, status, sort_order, dependencies_json, added_by, created_at, closed_at
      )
      SELECT id, task_id, title, detail, kind, required, status, sort_order, dependencies_json, added_by, created_at, closed_at
      FROM task_subgoals;
      DROP TABLE task_subgoals;
      ALTER TABLE task_subgoals_v2 RENAME TO task_subgoals;
      CREATE INDEX IF NOT EXISTS task_subgoals_task_idx ON task_subgoals(task_id, sort_order);
    `,
  },
  {
    version: 3,
    name: '0003_user_marks_focus_snooze',
    sql: `
      ALTER TABLE task_user_marks ADD COLUMN pinned_at INTEGER;
      ALTER TABLE task_user_marks ADD COLUMN snoozed_until INTEGER;
    `,
  },
  {
    // P0-1 draft/origin provenance + P0-2 handoff capsule columns.
    version: 4,
    name: '0004_draft_origin_handoff_capsule',
    sql: `
      ALTER TABLE tasks ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE tasks ADD COLUMN origin_conversation_id TEXT;
      ALTER TABLE tasks ADD COLUMN origin_summary TEXT;
      ALTER TABLE tasks ADD COLUMN discovered_from_task_id TEXT;
      ALTER TABLE task_conversations ADD COLUMN summary TEXT;
      ALTER TABLE task_conversations ADD COLUMN include_in_handoff INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS tasks_discovered_from_idx ON tasks(discovered_from_task_id);
      CREATE INDEX IF NOT EXISTS task_conversations_handoff_idx ON task_conversations(task_id, include_in_handoff);
    `,
  },
  {
    // Human-exclusive never-locked notes + per-execution dispatch contract snapshot.
    version: 5,
    name: '0005_human_notes_contract_snapshot',
    sql: `
      ALTER TABLE tasks ADD COLUMN user_notes TEXT NOT NULL DEFAULT '';
      ALTER TABLE task_executions ADD COLUMN plan_revision INTEGER;
      ALTER TABLE task_executions ADD COLUMN contract_snapshot_json TEXT;
    `,
  },
]

function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
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

export class BoardDatabase {
  readonly db: DatabaseSync
  readonly dbPath: string

  constructor(dbPath: string, options: { recoverOrphans?: boolean } = {}) {
    this.dbPath = dbPath
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true })
    }
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.migrate()
    if (options.recoverOrphans !== false) {
      this.recoverOrphanedExecutions()
    }
  }

  private isDispatchInFlight(executionId: string): boolean {
    if (!this.dbPath || this.dbPath === ':memory:') return false
    const lockFile = join(dirname(this.dbPath), `dispatch.lock.${executionId}`)
    if (!existsSync(lockFile)) return false
    try {
      const pid = Number(readFileSync(lockFile, 'utf8').trim())
      if (isPidAlive(pid)) return true
      unlinkSync(lockFile)
    } catch {
      // ignore unreadable or concurrently removed lock
    }
    return false
  }

  private ensureTaskColumns(): void {
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name),
    )
    if (!cols.has('use_worktree')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN use_worktree INTEGER NOT NULL DEFAULT 0;')
    }
    if (!cols.has('worktree_path')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN worktree_path TEXT;')
    }
    if (!cols.has('worktree_branch')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN worktree_branch TEXT;')
    }
    if (!cols.has('created_by')) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user';")
    }
    if (!cols.has('origin_conversation_id')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN origin_conversation_id TEXT;')
    }
    if (!cols.has('origin_summary')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN origin_summary TEXT;')
    }
    if (!cols.has('discovered_from_task_id')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN discovered_from_task_id TEXT;')
    }
    if (!cols.has('user_notes')) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN user_notes TEXT NOT NULL DEFAULT '';")
    }
  }

  private ensureExecutionColumns(): void {
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(task_executions)').all() as Array<{ name: string }>).map((c) => c.name),
    )
    if (!cols.has('plan_revision')) {
      this.db.exec('ALTER TABLE task_executions ADD COLUMN plan_revision INTEGER;')
    }
    if (!cols.has('contract_snapshot_json')) {
      this.db.exec('ALTER TABLE task_executions ADD COLUMN contract_snapshot_json TEXT;')
    }
  }

  private ensureConversationColumns(): void {
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(task_conversations)').all() as Array<{ name: string }>).map((c) => c.name),
    )
    if (!cols.has('summary')) {
      this.db.exec('ALTER TABLE task_conversations ADD COLUMN summary TEXT;')
    }
    if (!cols.has('include_in_handoff')) {
      this.db.exec('ALTER TABLE task_conversations ADD COLUMN include_in_handoff INTEGER NOT NULL DEFAULT 0;')
    }
  }

  private ensureUserMarksColumns(): void {
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(task_user_marks)').all() as Array<{ name: string }>).map((c) => c.name),
    )
    if (!cols.has('pinned_at')) {
      this.db.exec('ALTER TABLE task_user_marks ADD COLUMN pinned_at INTEGER;')
    }
    if (!cols.has('snoozed_until')) {
      this.db.exec('ALTER TABLE task_user_marks ADD COLUMN snoozed_until INTEGER;')
    }
  }

  private recoverOrphanedExecutions(): void {
    const rawOrphans = this.db
      .prepare('SELECT id, task_id FROM task_executions WHERE conversation_id IS NULL AND ended_at IS NULL')
      .all() as Array<{ id: string; task_id: string }>
    const orphans = rawOrphans.filter((row) => !this.isDispatchInFlight(row.id))
    if (orphans.length === 0) return
    const now = Date.now()
    const rec = reconcilePhaseStatus('needs_you', 'blocked')
    this.inTransaction(() => {
      const updateExecStmt = this.db.prepare(
        `UPDATE task_executions
         SET ended_at = ?, result = 'failed', error = COALESCE(error, 'Recovered orphaned pre-launch execution after unexpected shutdown')
         WHERE id = ? AND conversation_id IS NULL AND ended_at IS NULL`,
      )
      const affectedTaskIds = new Set<string>()
      for (const row of orphans) {
        const res = updateExecStmt.run(now, row.id)
        if (res.changes > 0) affectedTaskIds.add(row.task_id)
      }
      if (affectedTaskIds.size > 0) {
        const updateTaskStmt = this.db.prepare(
          `UPDATE tasks
           SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ?
           WHERE id = ? AND phase = 'active'
             AND NOT EXISTS (SELECT 1 FROM task_executions te WHERE te.task_id = tasks.id AND te.ended_at IS NULL)`,
        )
        for (const taskId of affectedTaskIds) {
          updateTaskStmt.run(
            rec.phase,
            rec.subPhase,
            rec.status,
            'Execution interrupted before conversation started',
            now,
            taskId,
          )
          this.db
            .prepare('UPDATE task_user_marks SET snoozed_until = NULL, updated_at = ? WHERE task_id = ? AND snoozed_until IS NOT NULL')
            .run(now, taskId)
        }
        this.bumpRevision()
      }
    })
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `)
    const applied = new Set<number>(
      (this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version),
    )
    const now = Date.now()
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue
      this.inTransaction(() => {
        if (m.version === 3) {
          this.ensureUserMarksColumns()
        } else if (m.version === 4) {
          this.ensureTaskColumns()
          this.ensureConversationColumns()
        } else if (m.version === 5) {
          this.ensureTaskColumns()
          this.ensureExecutionColumns()
        } else {
          this.db.exec(m.sql)
        }
        this.db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          now,
        )
      })
    }
    this.ensureTaskColumns()
    this.ensureUserMarksColumns()
    this.ensureConversationColumns()
    this.ensureExecutionColumns()
    this.db.prepare("INSERT OR IGNORE INTO board_meta (key, value) VALUES ('revision', '1')").run()
  }

  close(): void {
    this.db.close()
  }

  inTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE;')
    try {
      const result = fn()
      this.db.exec('COMMIT;')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore rollback failure if connection closed
      }
      throw error
    }
  }

  getRevision(): number {
    const row = this.db.prepare("SELECT value FROM board_meta WHERE key = 'revision'").get() as
      | { value: string }
      | undefined
    const num = row ? Number(row.value) : 1
    return Number.isFinite(num) ? num : 1
  }

  bumpRevision(): number {
    this.db
      .prepare(
        "INSERT INTO board_meta (key, value) VALUES ('revision', '2') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
      )
      .run()
    return this.getRevision()
  }

  // --- Workspaces ---
  listCustomWorkspaces(): WorkspaceRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM workspaces ORDER BY pinned DESC, COALESCE(last_used_at, created_at) DESC')
      .all() as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      rootPath: String(row.root_path),
      folderPaths: parseJsonSafe<string[]>(row.folder_paths_json as string, []),
      antigravityProjectId: row.antigravity_project_id ? String(row.antigravity_project_id) : undefined,
      source: (row.source === 'antigravity' ? 'antigravity' : 'custom') as 'antigravity' | 'custom',
      pinned: Boolean(row.pinned),
      lastUsedAt: typeof row.last_used_at === 'number' ? row.last_used_at : undefined,
      createdAt: Number(row.created_at),
    }))
  }

  getWorkspace(id: string): WorkspaceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return undefined
    return {
      id: String(row.id),
      name: String(row.name),
      rootPath: String(row.root_path),
      folderPaths: parseJsonSafe<string[]>(row.folder_paths_json as string, []),
      antigravityProjectId: row.antigravity_project_id ? String(row.antigravity_project_id) : undefined,
      source: (row.source === 'antigravity' ? 'antigravity' : 'custom') as 'antigravity' | 'custom',
      pinned: Boolean(row.pinned),
      lastUsedAt: typeof row.last_used_at === 'number' ? row.last_used_at : undefined,
      createdAt: Number(row.created_at),
    }
  }

  deleteWorkspace(id: string): boolean {
    const res = this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
    return res.changes > 0
  }

  upsertWorkspace(ws: WorkspaceRecord): void {
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, root_path, folder_paths_json, antigravity_project_id, source, pinned, last_used_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           root_path = excluded.root_path,
           folder_paths_json = excluded.folder_paths_json,
           antigravity_project_id = excluded.antigravity_project_id,
           pinned = excluded.pinned,
           last_used_at = COALESCE(excluded.last_used_at, workspaces.last_used_at)`,
      )
      .run(
        ws.id,
        ws.name,
        ws.rootPath,
        JSON.stringify(ws.folderPaths),
        ws.antigravityProjectId ?? null,
        ws.source,
        ws.pinned ? 1 : 0,
        ws.lastUsedAt ?? null,
        ws.createdAt,
      )
  }

  // --- Tasks hydration ---
  listTasks(options: { includeArchived?: boolean } = {}): TaskRecord[] {
    const whereClause = options.includeArchived === true ? '' : 'WHERE archived_at IS NULL'
    const taskRows = this.db
      .prepare(`SELECT * FROM tasks ${whereClause} ORDER BY sort_order ASC, updated_at DESC`)
      .all() as Array<Record<string, unknown>>
    return this.hydrateTasks(taskRows)
  }

  getTask(taskId: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined
    if (!row) return undefined
    return this.hydrateTasks([row])[0]
  }

  findTasksByConversationId(conversationId: string): TaskRecord[] {
    const taskRows = this.db
      .prepare(
        `SELECT DISTINCT t.* FROM tasks t
         INNER JOIN task_conversations tc ON tc.task_id = t.id
         WHERE tc.conversation_id = ?
         ORDER BY t.updated_at DESC`,
      )
      .all(conversationId) as Array<Record<string, unknown>>
    return this.hydrateTasks(taskRows)
  }

  updateConversationLinkMeta(
    taskId: string,
    conversationId: string,
    subgoalId: string,
    patch: { summary?: string | null; includeInHandoff?: boolean; role?: ConversationRole },
  ): void {
    const row = this.db
      .prepare(
        'SELECT summary, include_in_handoff, role FROM task_conversations WHERE task_id = ? AND subgoal_id = ? AND conversation_id = ?',
      )
      .get(taskId, subgoalId, conversationId) as
      | { summary?: string | null; include_in_handoff?: number; role?: string }
      | undefined
    if (!row) return
    const summary = patch.summary === undefined ? (row.summary ?? null) : patch.summary
    const include = patch.includeInHandoff === undefined ? Number(row.include_in_handoff ?? 0) : patch.includeInHandoff ? 1 : 0
    const role = patch.role ?? String(row.role ?? 'primary')
    this.db
      .prepare(
        'UPDATE task_conversations SET summary = ?, include_in_handoff = ?, role = ? WHERE task_id = ? AND subgoal_id = ? AND conversation_id = ?',
      )
      .run(summary, include, role, taskId, subgoalId, conversationId)
  }

  listTaskEvents(taskId: string, limit = 100): TaskEventRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(taskId, limit) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      subgoalId: row.subgoal_id ? String(row.subgoal_id) : undefined,
      conversationId: row.conversation_id ? String(row.conversation_id) : undefined,
      kind: String(row.kind),
      source: String(row.source) as TaskEventRecord['source'],
      payload: parseJsonSafe<Record<string, unknown>>(row.payload_json as string, {}),
      createdAt: Number(row.created_at),
    }))
  }

  private hydrateTasks(taskRows: Array<Record<string, unknown>>): TaskRecord[] {
    if (taskRows.length === 0) return []
    const ids = taskRows.map((r) => String(r.id))
    const placeholders = ids.map(() => '?').join(',')

    const subgoalRows = this.db
      .prepare(`SELECT * FROM task_subgoals WHERE task_id IN (${placeholders}) ORDER BY sort_order ASC, created_at ASC`)
      .all(...ids) as Array<Record<string, unknown>>
    const refRows = this.db
      .prepare(`SELECT * FROM task_refs WHERE task_id IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...ids) as Array<Record<string, unknown>>
    const convRows = this.db
      .prepare(`SELECT * FROM task_conversations WHERE task_id IN (${placeholders}) ORDER BY linked_at ASC`)
      .all(...ids) as Array<Record<string, unknown>>
    const execRows = this.db
      .prepare(`SELECT * FROM task_executions WHERE task_id IN (${placeholders}) ORDER BY started_at ASC`)
      .all(...ids) as Array<Record<string, unknown>>
    const commentRows = this.db
      .prepare(`SELECT * FROM task_comments WHERE task_id IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...ids) as Array<Record<string, unknown>>
    const markRows = this.db
      .prepare(`SELECT * FROM task_user_marks WHERE task_id IN (${placeholders})`)
      .all(...ids) as Array<Record<string, unknown>>

    const convsByTask = new Map<string, ConversationLink[]>()
    const convsBySubgoal = new Map<string, ConversationLink[]>()
    for (const r of convRows) {
      const subId = r.subgoal_id ? String(r.subgoal_id) : ''
      const link: ConversationLink = {
        taskId: String(r.task_id),
        ...(subId ? { subgoalId: subId } : {}),
        conversationId: String(r.conversation_id),
        role: (String(r.role) || 'primary') as ConversationRole,
        workspaceId: r.workspace_id ? String(r.workspace_id) : undefined,
        linkedAt: Number(r.linked_at),
        ...(r.summary ? { summary: String(r.summary) } : {}),
        ...(Number(r.include_in_handoff) ? { includeInHandoff: true } : {}),
      }
      const list = convsByTask.get(link.taskId) ?? []
      list.push(link)
      convsByTask.set(link.taskId, list)
      if (subId) {
        const key = `${link.taskId}\0${subId}`
        const sList = convsBySubgoal.get(key) ?? []
        sList.push(link)
        convsBySubgoal.set(key, sList)
      }
    }

    const subgoalsByTask = new Map<string, SubgoalRecord[]>()
    for (const r of subgoalRows) {
      const id = String(r.id)
      const taskId = String(r.task_id)
      const sg: SubgoalRecord = {
        id,
        taskId,
        title: String(r.title),
        detail: String(r.detail ?? ''),
        kind: (String(r.kind) || 'custom') as SubgoalKind,
        required: Boolean(r.required),
        status: (String(r.status) || 'open') as SubgoalStatus,
        sortOrder: Number(r.sort_order ?? 0),
        dependencies: parseJsonSafe<string[]>(r.dependencies_json as string, []),
        addedBy: String(r.added_by ?? 'user'),
        createdAt: Number(r.created_at),
        closedAt: typeof r.closed_at === 'number' ? r.closed_at : undefined,
        conversations: convsBySubgoal.get(`${taskId}\0${id}`) ?? [],
      }
      const list = subgoalsByTask.get(taskId) ?? []
      list.push(sg)
      subgoalsByTask.set(taskId, list)
    }

    const refsByTask = new Map<string, TaskRefRecord[]>()
    for (const r of refRows) {
      const taskId = String(r.task_id)
      const ref: TaskRefRecord = {
        id: String(r.id),
        taskId,
        subgoalId: r.subgoal_id ? String(r.subgoal_id) : undefined,
        kind: String(r.kind) as TaskRefKind,
        target: String(r.target),
        label: r.label ? String(r.label) : undefined,
        round: typeof r.round === 'number' ? r.round : undefined,
        addedBy: String(r.added_by ?? 'user'),
        createdAt: Number(r.created_at),
      }
      const list = refsByTask.get(taskId) ?? []
      list.push(ref)
      refsByTask.set(taskId, list)
    }

    const execsByTask = new Map<string, ExecutionRecord[]>()
    for (const r of execRows) {
      const taskId = String(r.task_id)
      const ex: ExecutionRecord = {
        id: String(r.id),
        taskId,
        subgoalId: r.subgoal_id ? String(r.subgoal_id) : undefined,
        conversationId: r.conversation_id ? String(r.conversation_id) : undefined,
        workspaceId: r.workspace_id ? String(r.workspace_id) : undefined,
        startedAt: Number(r.started_at),
        endedAt: typeof r.ended_at === 'number' ? r.ended_at : undefined,
        result: r.result ? (String(r.result) as ExecutionOutcome) : undefined,
        error: r.error ? String(r.error) : undefined,
        summary: r.summary ? String(r.summary) : undefined,
        initiatedBy: r.initiated_by ? String(r.initiated_by) : undefined,
        reworkInstructions: r.rework_instructions ? String(r.rework_instructions) : undefined,
        frozenAt: typeof r.frozen_at === 'number' ? r.frozen_at : undefined,
        planRevision: typeof r.plan_revision === 'number' ? r.plan_revision : undefined,
        contractSnapshot: parseJsonSafe<ExecutionContractSnapshot | undefined>(
          r.contract_snapshot_json as string | null,
          undefined,
        ),
      }
      const list = execsByTask.get(taskId) ?? []
      list.push(ex)
      execsByTask.set(taskId, list)
    }

    const commentsByTask = new Map<string, TaskCommentRecord[]>()
    for (const r of commentRows) {
      const taskId = String(r.task_id)
      const comment: TaskCommentRecord = {
        id: String(r.id),
        taskId,
        author: String(r.author ?? 'user'),
        bodyMd: String(r.body_md ?? ''),
        createdAt: Number(r.created_at),
      }
      const list = commentsByTask.get(taskId) ?? []
      list.push(comment)
      commentsByTask.set(taskId, list)
    }

    const marksByTask = new Map<string, TaskUserMarks>()
    for (const r of markRows) {
      const taskId = String(r.task_id)
      marksByTask.set(taskId, {
        taskId,
        ignoredAt: typeof r.ignored_at === 'number' ? r.ignored_at : undefined,
        ackedAt: typeof r.acked_at === 'number' ? r.acked_at : undefined,
        pinnedAt: typeof r.pinned_at === 'number' ? r.pinned_at : undefined,
        snoozedUntil: typeof r.snoozed_until === 'number' ? r.snoozed_until : undefined,
        updatedAt: Number(r.updated_at),
      })
    }

    return taskRows.map((row) => {
      const id = String(row.id)
      const subgoals = subgoalsByTask.get(id) ?? []
      const phase = String(row.phase) as TaskPhase
      const subPhase = String(row.sub_phase) as TaskSubPhase
      const reconciled = reconcilePhaseStatus(phase, subPhase)
      return {
        id,
        title: String(row.title),
        description: String(row.description ?? ''),
        userNotes: String(row.user_notes ?? ''),
        prompt: String(row.prompt ?? ''),
        phase: reconciled.phase,
        subPhase: reconciled.subPhase,
        status: (row.status ? String(row.status) : reconciled.status) as CanonicalStatus,
        priority: (String(row.priority) || 'normal') as TaskPriority,
        workspaceId: row.workspace_id ? String(row.workspace_id) : undefined,
        workspacePath: row.workspace_path ? String(row.workspace_path) : undefined,
        workspaceLabel: row.workspace_label ? String(row.workspace_label) : undefined,
        blockedReason: row.blocked_reason ? String(row.blocked_reason) : undefined,
        nextAction: row.next_action ? String(row.next_action) : undefined,
        dueAt: typeof row.due_at === 'number' ? row.due_at : undefined,
        reminderAt: typeof row.reminder_at === 'number' ? row.reminder_at : undefined,
        remindedAt: typeof row.reminded_at === 'number' ? row.reminded_at : undefined,
        sortOrder: Number(row.sort_order ?? 0),
        writeGate: (row.write_gate === 'locked' ? 'locked' : 'unlocked') as WriteGateMode,
        mode: row.mode ? String(row.mode) : undefined,
        model: row.model ? String(row.model) : undefined,
        reasoningEffort: row.reasoning_effort ? String(row.reasoning_effort) : undefined,
        permission: row.permission ? (String(row.permission) as TaskPermission) : undefined,
        permissionConfirmedAt:
          typeof row.permission_confirmed_at === 'number' ? row.permission_confirmed_at : undefined,
        reuseSession: Boolean(row.reuse_session),
        createdBy: row.created_by === 'ai' ? 'ai' : 'user',
        originConversationId: row.origin_conversation_id ? String(row.origin_conversation_id) : undefined,
        originSummary: row.origin_summary ? String(row.origin_summary) : undefined,
        discoveredFromTaskId: row.discovered_from_task_id ? String(row.discovered_from_task_id) : undefined,
        freeze: parseJsonSafe<TaskFreeze | undefined>(row.freeze_json as string | null, undefined),
        handover: parseJsonSafe<TaskHandover | undefined>(row.handover_json as string | null, undefined),
        tags: normalizeTags(parseJsonSafe<TaskTag[]>(row.tags_json as string, [])),
        schedule: parseJsonSafe<ScheduleRule | undefined>(row.schedule_json as string | null, undefined),
        planRevision: Number(row.plan_revision ?? 0),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        completedAt: typeof row.completed_at === 'number' ? row.completed_at : undefined,
        archivedAt: typeof row.archived_at === 'number' ? row.archived_at : undefined,
        subgoals,
        subgoalRollup: computeSubgoalRollup(subgoals),
        refs: refsByTask.get(id) ?? [],
        conversations: convsByTask.get(id) ?? [],
        executions: execsByTask.get(id) ?? [],
        comments: commentsByTask.get(id) ?? [],
        userMarks: marksByTask.get(id),
        useWorktree: Boolean(row.use_worktree),
        worktreePath: row.worktree_path ? String(row.worktree_path) : undefined,
        worktreeBranch: row.worktree_branch ? String(row.worktree_branch) : undefined,
      }
    })
  }
}
