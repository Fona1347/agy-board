import type { ConversationLink, SubgoalRecord, TaskRecord, WorkspaceRecord } from '../core/types.ts'
import { isPathEqualOrInside, normalizeFsPath, pathComparisonKey } from '../core/workspace.ts'
import type { Locale } from './i18n.ts'

export function latestPrimaryConversation(
  task: Pick<TaskRecord, 'conversations'>,
): ConversationLink | undefined {
  const primaries = task.conversations.filter((c) => c.role === 'primary')
  return primaries.at(-1) ?? task.conversations.at(-1)
}

export function latestSubgoalConversation(
  task: Pick<TaskRecord, 'conversations'>,
  subgoal: Pick<SubgoalRecord, 'id' | 'conversations'>,
): ConversationLink | undefined {
  const fromSub = subgoal.conversations?.at(-1)
  if (fromSub) return fromSub
  return task.conversations.filter((c) => c.subgoalId === subgoal.id).at(-1)
}

export function isInsideSidecarIframe(): boolean {
  try {
    return typeof window !== 'undefined' && window.parent !== window
  } catch {
    return true
  }
}

export function pathBasename(rawPath?: string): string {
  if (!rawPath) return ''
  const norm = normalizeFsPath(rawPath)
  const parts = norm.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? norm
}

export function isAbsoluteFsPath(rawPath: string): boolean {
  const trimmed = rawPath.trim()
  if (!trimmed) return false
  return (
    trimmed.toLowerCase().startsWith('file://') ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith('\\\\') ||
    trimmed.startsWith('/')
  )
}

/**
 * Convert a local/UNC filesystem path to a properly percent-encoded file:/// URI.
 * Handles spaces, `#`, `?`, `%`, and Unicode characters cleanly.
 */
export function fsPathToFileUri(rawPath: string): string {
  const trimmed = rawPath.trim()
  if (!trimmed) return ''
  if (trimmed.toLowerCase().startsWith('file://')) {
    try {
      return new URL(trimmed).href
    } catch {
      return trimmed
    }
  }
  const slashPath = trimmed.replace(/\\/g, '/')

  // UNC path: //server/share/dir/file
  if (slashPath.startsWith('//')) {
    const withoutSlashes = slashPath.replace(/^\/+/, '')
    const [host, ...segments] = withoutSlashes.split('/')
    const encodedRest = segments.filter((s) => s.length > 0).map((s) => encodeURIComponent(s))
    return `file://${encodeURIComponent(host)}/${encodedRest.join('/')}`
  }

  // Windows drive path: C:/dir/file -> file:///C:/dir/file
  if (/^[A-Za-z]:/.test(slashPath)) {
    const drive = `${slashPath[0].toUpperCase()}:`
    const rest = slashPath.slice(2).split('/').filter((s) => s.length > 0).map((s) => encodeURIComponent(s))
    return `file:///${drive}/${rest.join('/')}`
  }

  // POSIX absolute path: /dir/file -> file:///dir/file
  const rest = slashPath.split('/').filter((s) => s.length > 0).map((s) => encodeURIComponent(s))
  return `file:///${rest.join('/')}`
}

export function isSafeExternalUrl(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:'
  } catch {
    return false
  }
}

export interface WorkspaceFolderChoice {
  key: string
  workspaceId: string
  workspaceName: string
  folderPath: string
  folderName: string
  label: string
  pinned: boolean
  source: WorkspaceRecord['source']
}

export function collectWorkspaceFolders(ws: WorkspaceRecord): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (raw?: string) => {
    if (!raw) return
    const norm = normalizeFsPath(raw)
    const key = pathComparisonKey(norm)
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(norm)
  }
  for (const fp of ws.folderPaths) add(fp)
  add(ws.rootPath)
  return out
}

export function buildWorkspaceFolderChoices(workspaces: readonly WorkspaceRecord[]): WorkspaceFolderChoice[] {
  const choices: WorkspaceFolderChoice[] = []
  for (const ws of workspaces) {
    const folders = collectWorkspaceFolders(ws)
    for (const folderPath of folders) {
      const folderName = pathBasename(folderPath) || folderPath
      const sameName = folderName.toLowerCase() === ws.name.trim().toLowerCase()
      const label =
        sameName && folders.length === 1
          ? ws.name
          : `${ws.name} / ${folderName}`
      choices.push({
        key: encodeWorkspaceFolderValue(ws.id, folderPath),
        workspaceId: ws.id,
        workspaceName: ws.name,
        folderPath,
        folderName,
        label,
        pinned: Boolean(ws.pinned),
        source: ws.source,
      })
    }
  }
  return choices
}

export function encodeWorkspaceFolderValue(workspaceId: string, folderPath: string): string {
  return `${encodeURIComponent(workspaceId)}|${encodeURIComponent(normalizeFsPath(folderPath))}`
}

export function decodeWorkspaceFolderValue(value: string): { workspaceId: string; folderPath: string } | null {
  const sep = value.indexOf('|')
  if (sep <= 0) return null
  try {
    return {
      workspaceId: decodeURIComponent(value.slice(0, sep)),
      folderPath: decodeURIComponent(value.slice(sep + 1)),
    }
  } catch {
    return null
  }
}

export function formatWorkspaceBadge(
  task: Pick<TaskRecord, 'workspaceLabel' | 'workspacePath' | 'workspaceId'>,
  unboundLabel: string,
): { label: string; isUnbound: boolean; filterKey: string } {
  const folderName = pathBasename(task.workspacePath)
  const wsLabel = task.workspaceLabel?.trim()
  if (!wsLabel && !folderName && !task.workspaceId) {
    return { label: unboundLabel, isUnbound: true, filterKey: '__unbound__' }
  }
  let label = wsLabel || folderName || task.workspaceId || unboundLabel
  if (wsLabel && folderName) {
    const lowerLabel = wsLabel.toLowerCase()
    const lowerFolder = folderName.toLowerCase()
    if (lowerLabel === lowerFolder) {
      label = folderName
    } else if (lowerLabel.includes(lowerFolder)) {
      label = wsLabel
    } else {
      label = `${wsLabel} / ${folderName}`
    }
  }
  const filterKey = task.workspacePath
    ? `path:${normalizeFsPath(task.workspacePath)}`
    : task.workspaceId
      ? `ws:${task.workspaceId}`
      : '__unbound__'
  return { label, isUnbound: false, filterKey }
}

export type ParsedWorkspaceFilter =
  | { kind: 'all' }
  | { kind: 'unbound' }
  | { kind: 'workspace'; id: string }
  | { kind: 'path'; path: string }

export function parseWorkspaceFilter(raw: string, workspaces: readonly WorkspaceRecord[]): ParsedWorkspaceFilter {
  const trimmed = raw.trim()
  if (!trimmed) return { kind: 'all' }
  if (trimmed === '__unbound__') return { kind: 'unbound' }
  if (trimmed.startsWith('ws:')) {
    const id = trimmed.slice(3).trim()
    return id ? { kind: 'workspace', id } : { kind: 'all' }
  }
  if (trimmed.startsWith('path:')) {
    const dir = normalizeFsPath(trimmed.slice(5))
    return dir ? { kind: 'path', path: dir } : { kind: 'all' }
  }
  const byId = workspaces.find((w) => w.id === trimmed || w.antigravityProjectId === trimmed)
  if (byId) return { kind: 'workspace', id: byId.id }
  if (isAbsoluteFsPath(trimmed)) return { kind: 'path', path: normalizeFsPath(trimmed) }
  return { kind: 'workspace', id: trimmed }
}

export function matchesWorkspaceFilter(
  task: TaskRecord,
  rawFilter: string,
  workspaces: readonly WorkspaceRecord[],
): boolean {
  const parsed = parseWorkspaceFilter(rawFilter, workspaces)
  if (parsed.kind === 'all') return true
  if (parsed.kind === 'unbound') {
    return !task.workspaceId && !task.workspacePath
  }
  if (parsed.kind === 'path') {
    return Boolean(task.workspacePath && isPathEqualOrInside(task.workspacePath, parsed.path))
  }
  const ws = workspaces.find((w) => w.id === parsed.id || w.antigravityProjectId === parsed.id)
  if (ws) {
    const idMatch =
      task.workspaceId === ws.id || Boolean(ws.antigravityProjectId && task.workspaceId === ws.antigravityProjectId)
    const folders = collectWorkspaceFolders(ws)
    const pathMatch = Boolean(
      task.workspacePath && folders.some((fp) => isPathEqualOrInside(task.workspacePath!, fp)),
    )
    return idMatch || pathMatch
  }
  return task.workspaceId === parsed.id
}

export function epochToDateTimeLocal(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function dateTimeLocalToEpoch(val: string): number | undefined {
  const trimmed = val.trim()
  if (!trimmed) return undefined
  const ms = new Date(trimmed).getTime()
  return Number.isFinite(ms) ? ms : undefined
}

export function formatShortDue(
  dueAt: number,
  now: number,
  locale: Locale,
): { text: string; isOverdue: boolean; isSoon: boolean } {
  const isOverdue = dueAt <= now
  const isSoon = !isOverdue && dueAt - now <= 24 * 60 * 60 * 1000
  const d = new Date(dueAt)
  const today = new Date(now)
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  const timeStr = d.toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const dateStr = d.toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
  })
  const label = sameDay ? timeStr : `${dateStr} ${timeStr}`
  if (isOverdue) {
    return { text: locale === 'zh' ? `已逾期 ${label}` : `Overdue ${label}`, isOverdue: true, isSoon: false }
  }
  return { text: locale === 'zh' ? `截止 ${label}` : `Due ${label}`, isOverdue: false, isSoon }
}

export type ClosedTimeBucket = 'today' | 'yesterday' | 'last7Days' | 'older'

export function bucketClosedTasks(
  closedTasks: readonly TaskRecord[],
  now: number,
): Array<{ bucket: ClosedTimeBucket; tasks: TaskRecord[] }> {
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const startOfToday = todayStart.getTime()

  const yesterdayStart = new Date(todayStart)
  yesterdayStart.setDate(yesterdayStart.getDate() - 1)
  const startOfYesterday = yesterdayStart.getTime()

  const sevenDaysStart = new Date(todayStart)
  sevenDaysStart.setDate(sevenDaysStart.getDate() - 6)
  const startOf7Days = sevenDaysStart.getTime()

  const buckets: Record<ClosedTimeBucket, TaskRecord[]> = {
    today: [],
    yesterday: [],
    last7Days: [],
    older: [],
  }

  for (const task of closedTasks) {
    const ts = task.completedAt ?? task.updatedAt ?? task.createdAt
    if (ts >= startOfToday) buckets.today.push(task)
    else if (ts >= startOfYesterday) buckets.yesterday.push(task)
    else if (ts >= startOf7Days) buckets.last7Days.push(task)
    else buckets.older.push(task)
  }

  const order: ClosedTimeBucket[] = ['today', 'yesterday', 'last7Days', 'older']
  return order
    .filter((b) => buckets[b].length > 0)
    .map((bucket) => ({ bucket, tasks: buckets[bucket] }))
}

function srgbChannelToLinear(c255: number): number {
  const c = Math.min(Math.max(c255, 0), 255) / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function hslToRgb(hDeg: number, sPct: number, lPct: number): [number, number, number] {
  const h = ((hDeg % 360) + 360) % 360
  const s = Math.min(Math.max(sPct, 0), 100) / 100
  const l = Math.min(Math.max(lPct, 0), 100) / 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

export function detectColorLuminanceTheme(rawColor: string): 'dark' | 'light' | null {
  const val = rawColor.trim()
  if (!val) return null

  let rgb: [number, number, number] | null = null

  // #rgb / #rrggbb / #rrggbbaa
  const hexMatch = val.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
  if (hexMatch) {
    const hex = hexMatch[1]
    if (hex.length === 3 || hex.length === 4) {
      rgb = [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
      ]
    } else {
      rgb = [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ]
    }
  }

  // rgb(...) / rgba(...)
  if (!rgb) {
    const rgbMatch = val.match(/^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)/i)
    if (rgbMatch) {
      rgb = [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])]
    }
  }

  // hsl(...) / hsla(...)
  if (!rgb) {
    const hslMatch = val.match(/^hsla?\(\s*([\d.]+)(?:deg)?\s*[,\s]\s*([\d.]+)%\s*[,\s]\s*([\d.]+)%/i)
    if (hslMatch) {
      rgb = hslToRgb(Number(hslMatch[1]), Number(hslMatch[2]), Number(hslMatch[3]))
    }
  }

  // Tailwind bare hsl triplet: "40 20% 97%" or "40 20% 97% / 1"
  if (!rgb) {
    const bareHsl = val.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%(?:\s*\/\s*[\d.%]+)?$/)
    if (bareHsl) {
      rgb = hslToRgb(Number(bareHsl[1]), Number(bareHsl[2]), Number(bareHsl[3]))
    }
  }

  if (!rgb || rgb.some((n) => !Number.isFinite(n))) return null
  const lum =
    0.2126 * srgbChannelToLinear(rgb[0]) +
    0.7152 * srgbChannelToLinear(rgb[1]) +
    0.0722 * srgbChannelToLinear(rgb[2])
  return lum > 0.45 ? 'light' : 'dark'
}

export function formatRelativeAge(ts: number, now: number, locale: Locale): string {
  const diff = Math.max(0, now - ts)
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return locale === 'zh' ? '刚刚' : 'now'
  if (mins < 60) return locale === 'zh' ? `${mins}分钟` : `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return locale === 'zh' ? `${hours}小时` : `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return locale === 'zh' ? `${days}天` : `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 8) return locale === 'zh' ? `${weeks}周` : `${weeks}w`
  const months = Math.max(1, Math.floor(days / 30))
  return locale === 'zh' ? `${months}月` : `${months}mo`
}

export interface TimelineTick {
  primary: string
  secondary?: string
  tone: 'overdue' | 'soon' | 'upcoming' | 'none'
}

export function formatTimelineTick(
  dueAt: number | undefined,
  now: number,
  locale: Locale,
  scheduleFallback?: { nextRunAt?: number; reminderAt?: number; isRecurring?: boolean },
): TimelineTick {
  const effectiveTs =
    dueAt !== undefined && Number.isFinite(dueAt)
      ? dueAt
      : scheduleFallback?.nextRunAt !== undefined && Number.isFinite(scheduleFallback.nextRunAt)
        ? scheduleFallback.nextRunAt
        : scheduleFallback?.reminderAt !== undefined && Number.isFinite(scheduleFallback.reminderAt)
          ? scheduleFallback.reminderAt
          : undefined
  const isFallback = dueAt === undefined || !Number.isFinite(dueAt)

  if (effectiveTs === undefined) {
    return {
      primary: '—',
      secondary: locale === 'zh' ? '无截止' : 'No DDL',
      tone: 'none',
    }
  }
  const d = new Date(effectiveTs)
  const today = new Date(now)
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)

  const pad = (n: number) => String(n).padStart(2, '0')
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

  const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const dateShort = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const dayLabel = sameDay(d, today)
    ? locale === 'zh'
      ? '今天'
      : 'Today'
    : sameDay(d, tomorrow)
      ? locale === 'zh'
        ? '明天'
        : 'Tmrw'
      : dateShort

  if (!isFallback && effectiveTs < now) {
    return {
      primary: locale === 'zh' ? '已逾期' : 'Overdue',
      secondary: sameDay(d, today) ? timeStr : `${dateShort} ${timeStr}`,
      tone: 'overdue',
    }
  }
  const isSoon = sameDay(d, today) || (effectiveTs >= now && effectiveTs - now <= 24 * 60 * 60 * 1000)
  const prefix = isFallback ? (scheduleFallback?.isRecurring ? '↻ ' : '⏰ ') : ''
  return {
    primary: dayLabel,
    secondary: `${prefix}${timeStr}`,
    tone: isSoon ? 'soon' : 'upcoming',
  }
}

const PRIO_WEIGHT: Record<TaskRecord['priority'], number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
}

export interface CreatedStamp {
  label: string
  full: string
  isStale: boolean
}

export function formatCreatedStamp(createdAt: number, now: number, locale: Locale): CreatedStamp {
  const d = new Date(createdAt)
  const today = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  const dateShort = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const full = `${d.getFullYear()}-${dateShort} ${timeStr}`
  const days = Math.max(0, Math.floor((now - createdAt) / 86_400_000))
  const isStale = days >= 7

  if (sameDay) {
    return {
      label: locale === 'zh' ? `今天 ${timeStr} 加入` : `Added ${timeStr}`,
      full,
      isStale: false,
    }
  }
  if (isStale) {
    return {
      label: locale === 'zh' ? `${dateShort} 加入 · ${days}天` : `Added ${dateShort} · ${days}d`,
      full,
      isStale: true,
    }
  }
  return {
    label: locale === 'zh' ? `${dateShort} 加入` : `Added ${dateShort}`,
    full,
    isStale: false,
  }
}

export function sortTasksByDeadline(tasks: readonly TaskRecord[]): TaskRecord[] {
  return [...tasks].sort((a, b) => {
    const aDue = a.dueAt
    const bDue = b.dueAt
    const aHas = typeof aDue === 'number' && Number.isFinite(aDue)
    const bHas = typeof bDue === 'number' && Number.isFinite(bDue)
    if (aHas && !bHas) return -1
    if (!aHas && bHas) return 1
    if (aHas && bHas && aDue !== bDue) return (aDue as number) - (bDue as number)
    if (!aHas && !bHas && a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
    const pa = PRIO_WEIGHT[a.priority] ?? 2
    const pb = PRIO_WEIGHT[b.priority] ?? 2
    if (pa !== pb) return pa - pb
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
    return b.createdAt - a.createdAt
  })
}
