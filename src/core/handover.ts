/**
 * Handover bundle validation and permission elevation gate.
 * Ensures elevated permissions require explicit human UI confirmation and
 * any change to permission/handover re-arms the confirmation gate.
 */
import { isTaskPermission, type TaskHandover, type TaskHandoverInput, type TaskPermission, type TaskRecord } from './types.ts'

export const HANDOVER_MAX_REFERENCES = 32
export const HANDOVER_MAX_REFERENCE_BYTES = 512
export const HANDOVER_MAX_TOTAL_BYTES = 8 * 1024
export const HANDOVER_MAX_TARGET_BYTES = 256

export const DEFAULT_SESSION_PERMISSION: TaskPermission = 'read-only'

export const PERMISSION_RANK: ReadonlyMap<TaskPermission, number> = new Map([
  ['read-only', 0],
  ['workspace-write', 1],
  ['danger-full-access', 2],
])

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

export function sanitizeHandover(value: unknown): TaskHandoverInput | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const bundle = value as Record<string, unknown>
  const keys = Object.keys(bundle)
  if (!keys.every((key) => ['workspaceId', 'mode', 'permission', 'references', 'bundledAt'].includes(key))) {
    return undefined
  }
  const refs = bundle.references ?? []
  if (!Array.isArray(refs) || refs.length > HANDOVER_MAX_REFERENCES) return undefined
  let total = 0
  const cleanRefs: string[] = []
  for (const reference of refs) {
    if (typeof reference !== 'string') return undefined
    const trimmed = reference.trim()
    if (trimmed === '') continue
    const size = byteLength(trimmed)
    if (size > HANDOVER_MAX_REFERENCE_BYTES) return undefined
    total += size
    if (total > HANDOVER_MAX_TOTAL_BYTES) return undefined
    cleanRefs.push(trimmed)
  }
  for (const key of ['workspaceId', 'mode'] as const) {
    const target = bundle[key]
    if (target !== undefined && (typeof target !== 'string' || byteLength(target) > HANDOVER_MAX_TARGET_BYTES)) {
      return undefined
    }
  }
  if (bundle.permission !== undefined && !isTaskPermission(bundle.permission)) return undefined
  return {
    ...(typeof bundle.workspaceId === 'string' && bundle.workspaceId.trim() ? { workspaceId: bundle.workspaceId.trim() } : {}),
    ...(typeof bundle.mode === 'string' && bundle.mode.trim() ? { mode: bundle.mode.trim() } : {}),
    ...(bundle.permission === undefined ? {} : { permission: bundle.permission }),
    references: cleanRefs,
  }
}

export function handoverOf(input: TaskHandoverInput, now: number): TaskHandover {
  return { ...input, bundledAt: now }
}

export function effectivePermission(task: Pick<TaskRecord, 'permission' | 'handover'>): TaskPermission | undefined {
  return task.handover?.permission ?? task.permission
}

export function exceedsSessionDefault(
  permission: TaskPermission | undefined,
  sessionDefault: TaskPermission = DEFAULT_SESSION_PERMISSION,
): boolean {
  if (permission === undefined) return false
  return (PERMISSION_RANK.get(permission) ?? -1) > (PERMISSION_RANK.get(sessionDefault) ?? -1)
}

export function requiresPermissionConfirmation(
  task: Pick<TaskRecord, 'permission' | 'handover' | 'permissionConfirmedAt'>,
  sessionDefault: TaskPermission = DEFAULT_SESSION_PERMISSION,
): boolean {
  return exceedsSessionDefault(effectivePermission(task), sessionDefault) && task.permissionConfirmedAt === undefined
}
