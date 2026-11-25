/**
 * Zone-aware 5-field Vixie cron parser and next-run computation, plus one-shot
 * schedule and reminder utilities. Zero external dependencies (Intl only).
 */
import type {
  ScheduleAction,
  ScheduleMisfirePolicy,
  ScheduleMode,
  ScheduleOverlapPolicy,
  ScheduleRule,
  ScheduleSessionMode,
} from './types.ts'

export interface CronSchedule {
  minutes: ReadonlySet<number>
  hours: ReadonlySet<number>
  days: ReadonlySet<number>
  months: ReadonlySet<number>
  weekdays: ReadonlySet<number>
  dayStarred: boolean
  weekdayStarred: boolean
}

const FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
]

export const HOST_TIME_ZONE_FALLBACK = 'UTC'
const IANA_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>()

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = FORMATTERS.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    FORMATTERS.set(timeZone, formatter)
  }
  return formatter
}

export function partsInZone(timeZone: string, epochMs: number): ZonedParts {
  const fields: Record<string, string> = {}
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') fields[part.type] = part.value
  }
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour),
    minute: Number(fields.minute),
  }
}

function offsetAt(timeZone: string, epochMs: number): number {
  const parts = partsInZone(timeZone, epochMs)
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - epochMs
}

export function zonedEpoch(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number | undefined {
  const naive = Date.UTC(year, month - 1, day, hour, minute)
  const offsets = new Set([
    offsetAt(timeZone, naive - 86_400_000),
    offsetAt(timeZone, naive),
    offsetAt(timeZone, naive + 86_400_000),
  ])
  let earliest: number | undefined
  for (const offset of offsets) {
    const candidate = naive - offset
    const parts = partsInZone(timeZone, candidate)
    if (parts.year !== year || parts.month !== month || parts.day !== day) continue
    if (parts.hour !== hour || parts.minute !== minute) continue
    if (earliest === undefined || candidate < earliest) earliest = candidate
  }
  return earliest
}

export function resolveHostTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone !== '' ? zone : HOST_TIME_ZONE_FALLBACK
  } catch {
    return HOST_TIME_ZONE_FALLBACK
  }
}

export function isValidTimeZone(value: string): boolean {
  if (value.trim() !== value || value === '') return false
  if (value !== 'UTC' && !IANA_ZONE.test(value)) return false
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone !== undefined
  } catch {
    return false
  }
}

function isDigits(value: string): boolean {
  return /^\d+$/.test(value)
}

function parseField(field: string, min: number, max: number, out: Set<number>): boolean {
  if (field === '*') {
    for (let value = min; value <= max; value++) out.add(value)
    return true
  }
  for (const part of field.split(',')) {
    if (part === '') return false
    const segments = part.split('/')
    if (segments.length > 2) return false
    const [range, stepRaw] = segments
    let low: number
    let high: number
    if (range === '*') {
      low = min
      high = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-')
      if (a === '' || b === '' || !isDigits(a) || !isDigits(b)) return false
      low = Number(a)
      high = Number(b)
    } else if (isDigits(range)) {
      low = Number(range)
      high = stepRaw === undefined ? low : max
    } else {
      return false
    }
    if (low < min || high > max || low > high) return false
    const step = stepRaw === undefined ? 1 : isDigits(stepRaw) ? Number(stepRaw) : NaN
    if (!Number.isInteger(step) || step < 1) return false
    for (let value = low; value <= high; value += step) out.add(value)
  }
  return true
}

export function parseCron(expr: string): CronSchedule | null {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const sets: Set<number>[] = []
  for (let index = 0; index < 5; index++) {
    const [min, max] = FIELD_RANGES[index]
    const set = new Set<number>()
    if (!parseField(fields[index], min, max, set)) return null
    sets.push(set)
  }
  const weekdays = new Set<number>()
  for (const day of sets[4]) weekdays.add(day === 7 ? 0 : day)
  return {
    minutes: sets[0],
    hours: sets[1],
    days: sets[2],
    months: sets[3],
    weekdays,
    dayStarred: fields[2].startsWith('*'),
    weekdayStarred: fields[4].startsWith('*'),
  }
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null
}

function dayCandidate(schedule: CronSchedule, year: number, month: number, day: number): boolean {
  const dayMatches = schedule.days.has(day)
  const weekdayMatches = schedule.weekdays.has(new Date(Date.UTC(year, month - 1, day)).getUTCDay())
  if (!schedule.dayStarred && !schedule.weekdayStarred) return dayMatches || weekdayMatches
  return dayMatches && weekdayMatches
}

function hasPossibleCalendarDay(schedule: CronSchedule): boolean {
  if (schedule.dayStarred || !schedule.weekdayStarred) return true
  const maximumDay = new Map<number, number>([
    [1, 31],
    [2, 29],
    [3, 31],
    [4, 30],
    [5, 31],
    [6, 30],
    [7, 31],
    [8, 31],
    [9, 30],
    [10, 31],
    [11, 30],
    [12, 31],
  ])
  for (const month of schedule.months) {
    const maximum = maximumDay.get(month) ?? 0
    if ([...schedule.days].some((day) => day <= maximum)) return true
  }
  return false
}

export function nextRunAtMs(expr: string, fromMs: number, timeZone?: string): number | undefined {
  const schedule = parseCron(expr)
  if (schedule === null) return undefined
  if (!hasPossibleCalendarDay(schedule)) return undefined
  const zone = timeZone ?? resolveHostTimeZone()
  const start = partsInZone(zone, fromMs)
  const limitMs = fromMs + 5 * 366 * 24 * 60 * 60 * 1000

  const sortedMinutes = [...schedule.minutes].sort((a, b) => a - b)
  const sortedHours = [...schedule.hours].sort((a, b) => a - b)
  const sortedMonths = [...schedule.months].sort((a, b) => a - b)

  let year = start.year
  let month = start.month
  let day = start.day
  let hour = start.hour
  let minute = start.minute + 1

  while (Date.UTC(year, month - 1, 1) <= limitMs + 86_400_000) {
    for (const candidateMonth of sortedMonths) {
      if (candidateMonth < month) continue
      const daysInMonth = new Date(Date.UTC(year, candidateMonth, 0)).getUTCDate()
      const dayStart = candidateMonth === month ? day : 1
      for (let candidateDay = dayStart; candidateDay <= daysInMonth; candidateDay += 1) {
        if (!dayCandidate(schedule, year, candidateMonth, candidateDay)) continue
        const hourStart = candidateMonth === month && candidateDay === day ? hour : 0
        for (const candidateHour of sortedHours) {
          if (candidateHour < hourStart) continue
          const minuteStart = candidateMonth === month && candidateDay === day && candidateHour === hour ? minute : 0
          for (const candidateMinute of sortedMinutes) {
            if (candidateMinute < minuteStart) continue
            const time = zonedEpoch(zone, year, candidateMonth, candidateDay, candidateHour, candidateMinute)
            if (time === undefined) continue
            if (time <= fromMs) continue
            if (time > limitMs) return undefined
            return time
          }
        }
      }
    }
    year += 1
    month = 1
    day = 1
    hour = 0
    minute = 0
  }
  return undefined
}

export function scheduleRunBudget(rule: ScheduleRule): number | undefined {
  if (rule.mode === 'once') return 1
  return rule.maxRuns
}

export function scheduleExhausted(rule: ScheduleRule): boolean {
  const budget = scheduleRunBudget(rule)
  return budget !== undefined && rule.runCount >= budget
}

export function schedulePlannedAt(rule: ScheduleRule): number | undefined {
  if (rule.mode === 'once') return rule.at
  return rule.nextRunAt
}

export function nextAfterCompletionAtMs(
  completedAtMs: number,
  intervalDays: number,
  timeZone?: string,
  atHour?: number,
  atMinute?: number,
): number {
  const days = Math.max(1, Math.trunc(intervalDays))
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : resolveHostTimeZone()
  const baseParts = partsInZone(zone, completedAtMs)
  const hour =
    atHour !== undefined && Number.isInteger(atHour) ? Math.min(23, Math.max(0, atHour)) : baseParts.hour
  const minute =
    atMinute !== undefined && Number.isInteger(atMinute) ? Math.min(59, Math.max(0, atMinute)) : baseParts.minute

  const resolveDayInstant = (dayOffset: number): number => {
    const targetDate = new Date(Date.UTC(baseParts.year, baseParts.month - 1, baseParts.day + dayOffset))
    const year = targetDate.getUTCFullYear()
    const month = targetDate.getUTCMonth() + 1
    const day = targetDate.getUTCDate()
    const direct = zonedEpoch(zone, year, month, day, hour, minute)
    if (direct !== undefined) return direct
    // Handle DST spring-forward gap by stepping forward minute-by-minute up to 3 hours in wall-clock time
    for (let offsetMin = 1; offsetMin <= 180; offsetMin += 1) {
      const totalMin = hour * 60 + minute + offsetMin
      const probeDate = new Date(Date.UTC(year, month - 1, day + Math.floor(totalMin / 1440)))
      const remMin = ((totalMin % 1440) + 1440) % 1440
      const resolved = zonedEpoch(
        zone,
        probeDate.getUTCFullYear(),
        probeDate.getUTCMonth() + 1,
        probeDate.getUTCDate(),
        Math.floor(remMin / 60),
        remMin % 60,
      )
      if (resolved !== undefined) return resolved
    }
    return Date.UTC(year, month - 1, day, hour, minute)
  }

  let candidate = resolveDayInstant(days)
  if (candidate <= completedAtMs) {
    candidate = resolveDayInstant(days + 1)
  }
  return candidate
}

export type VisualSchedulePreset =
  | 'once'
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'monthly'
  | 'after_completion'
  | 'custom_cron'

export interface VisualScheduleSpec {
  enabled: boolean
  action: ScheduleAction
  preset: VisualSchedulePreset
  at?: number
  hour: number
  minute: number
  weekdays: number[]
  dayOfMonth: number
  intervalDays: number
  useCustomTimeForAfterCompletion: boolean
  customCron: string
  timeZone: string
  sessionMode: ScheduleSessionMode
  misfirePolicy: ScheduleMisfirePolicy
  overlapPolicy: ScheduleOverlapPolicy
  maxRuns?: number
}

export interface SchedulePatch {
  enabled: boolean
  mode: ScheduleMode
  cron?: string
  at?: number
  intervalDays?: number
  atHour?: number
  atMinute?: number
  timeZone?: string | null
  action?: ScheduleAction
  sessionMode?: ScheduleSessionMode
  misfirePolicy?: ScheduleMisfirePolicy
  overlapPolicy?: ScheduleOverlapPolicy
  maxRuns?: number | null
}

function normalizeWeekdays(days: readonly number[]): number[] {
  const out = new Set<number>()
  for (const d of days) {
    if (!Number.isInteger(d)) continue
    if (d === 0 || d === 7) out.add(7)
    else if (d >= 1 && d <= 6) out.add(d)
  }
  return [...out].sort((a, b) => a - b)
}

function parseWeekdayPresetField(field: string): number[] | null {
  if (field.includes('/')) return null
  const out = new Set<number>()
  if (!parseField(field, 0, 7, out)) return null
  return normalizeWeekdays([...out])
}

export function ruleToVisualSchedule(rule?: ScheduleRule, defaultTz?: string): VisualScheduleSpec {
  const fallbackZone = defaultTz && isValidTimeZone(defaultTz) ? defaultTz : resolveHostTimeZone()
  const zone = rule?.timeZone && isValidTimeZone(rule.timeZone) ? rule.timeZone : fallbackZone
  const base: VisualScheduleSpec = {
    enabled: rule?.enabled ?? true,
    action: rule?.action ?? 'dispatch',
    preset: 'weekdays',
    at: rule?.at,
    hour: 9,
    minute: 0,
    weekdays: [1, 2, 3, 4, 5],
    dayOfMonth: 1,
    intervalDays: rule?.intervalDays && rule.intervalDays >= 1 ? Math.trunc(rule.intervalDays) : 3,
    useCustomTimeForAfterCompletion:
      rule?.mode === 'after_completion' ? rule.atHour !== undefined && rule.atMinute !== undefined : true,
    customCron: rule?.cron ?? '0 9 * * 1-5',
    timeZone: zone,
    sessionMode: rule?.sessionMode ?? (rule?.mode === 'once' ? 'auto' : 'new'),
    misfirePolicy: rule?.misfirePolicy ?? 'prompt',
    overlapPolicy: rule?.overlapPolicy ?? 'wait_review',
    maxRuns: rule?.maxRuns,
  }

  if (!rule) return base

  if (rule.mode === 'once') {
    const parts = rule.at !== undefined ? partsInZone(zone, rule.at) : undefined
    return {
      ...base,
      preset: 'once',
      at: rule.at,
      hour: parts?.hour ?? 9,
      minute: parts?.minute ?? 0,
    }
  }

  if (rule.mode === 'after_completion') {
    return {
      ...base,
      preset: 'after_completion',
      intervalDays: rule.intervalDays && rule.intervalDays >= 1 ? Math.trunc(rule.intervalDays) : 1,
      useCustomTimeForAfterCompletion: rule.atHour !== undefined && rule.atMinute !== undefined,
      hour: rule.atHour ?? 9,
      minute: rule.atMinute ?? 0,
    }
  }

  const rawCron = (rule.cron ?? '').trim()
  const fields = rawCron.split(/\s+/)
  if (fields.length === 5 && isDigits(fields[0]) && isDigits(fields[1]) && fields[3] === '*') {
    const minute = Number(fields[0])
    const hour = Number(fields[1])
    if (minute >= 0 && minute <= 59 && hour >= 0 && hour <= 23) {
      if (fields[2] === '*' && fields[4] === '*') {
        return {
          ...base,
          preset: 'daily',
          hour,
          minute,
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          customCron: rawCron,
        }
      }
      if (fields[2] === '*' && fields[4] !== '*') {
        const parsedDays = parseWeekdayPresetField(fields[4])
        if (parsedDays && parsedDays.length > 0) {
          if (parsedDays.length === 7) {
            return {
              ...base,
              preset: 'daily',
              hour,
              minute,
              weekdays: [1, 2, 3, 4, 5, 6, 7],
              customCron: rawCron,
            }
          }
          if (
            parsedDays.length === 5 &&
            parsedDays[0] === 1 &&
            parsedDays[1] === 2 &&
            parsedDays[2] === 3 &&
            parsedDays[3] === 4 &&
            parsedDays[4] === 5
          ) {
            return {
              ...base,
              preset: 'weekdays',
              hour,
              minute,
              weekdays: [1, 2, 3, 4, 5],
              customCron: rawCron,
            }
          }
          return {
            ...base,
            preset: 'weekly',
            hour,
            minute,
            weekdays: parsedDays,
            customCron: rawCron,
          }
        }
      }
      if (fields[4] === '*' && isDigits(fields[2])) {
        const dom = Number(fields[2])
        if (dom >= 1 && dom <= 31) {
          return {
            ...base,
            preset: 'monthly',
            hour,
            minute,
            dayOfMonth: dom,
            customCron: rawCron,
          }
        }
      }
    }
  }

  return {
    ...base,
    preset: 'custom_cron',
    customCron: rawCron || '0 9 * * 1-5',
  }
}

export function visualScheduleToPatch(spec: VisualScheduleSpec): SchedulePatch {
  const hour = Math.min(23, Math.max(0, Math.trunc(spec.hour)))
  const minute = Math.min(59, Math.max(0, Math.trunc(spec.minute)))
  const zone = spec.timeZone.trim()
  const common = {
    enabled: spec.enabled,
    action: spec.action,
    sessionMode: spec.sessionMode,
    misfirePolicy: spec.misfirePolicy,
    overlapPolicy: spec.overlapPolicy,
    timeZone: zone || null,
    maxRuns: spec.maxRuns && spec.maxRuns > 0 ? Math.trunc(spec.maxRuns) : null,
  }

  if (spec.preset === 'once') {
    return {
      ...common,
      mode: 'once',
      at: spec.at,
    }
  }

  if (spec.preset === 'after_completion') {
    const intervalDays = Math.max(1, Math.trunc(spec.intervalDays || 1))
    return {
      ...common,
      mode: 'after_completion',
      intervalDays,
      ...(spec.useCustomTimeForAfterCompletion ? { atHour: hour, atMinute: minute } : {}),
    }
  }

  if (spec.preset === 'daily') {
    return {
      ...common,
      mode: 'cron',
      cron: `${minute} ${hour} * * *`,
    }
  }

  if (spec.preset === 'weekdays') {
    return {
      ...common,
      mode: 'cron',
      cron: `${minute} ${hour} * * 1-5`,
    }
  }

  if (spec.preset === 'weekly') {
    const days = normalizeWeekdays(spec.weekdays)
    const cron =
      days.length === 7
        ? `${minute} ${hour} * * *`
        : days.length === 0
          ? `${minute} ${hour} * * 1`
          : days.length === 5 && days.every((d, i) => d === i + 1)
            ? `${minute} ${hour} * * 1-5`
            : `${minute} ${hour} * * ${days.join(',')}`
    return {
      ...common,
      mode: 'cron',
      cron,
    }
  }

  if (spec.preset === 'monthly') {
    const dom = Math.min(31, Math.max(1, Math.trunc(spec.dayOfMonth || 1)))
    return {
      ...common,
      mode: 'cron',
      cron: `${minute} ${hour} ${dom} * *`,
    }
  }

  return {
    ...common,
    mode: 'cron',
    cron: spec.customCron.trim(),
  }
}

export function computeNextRunPreviews(
  ruleOrSpec: ScheduleRule | VisualScheduleSpec,
  count = 3,
  fromMs = Date.now(),
): number[] {
  const limitCount = Math.max(0, Math.trunc(count))
  if (limitCount === 0) return []

  const isVisual = 'preset' in ruleOrSpec
  const patch = isVisual ? visualScheduleToPatch(ruleOrSpec) : undefined
  const mode: ScheduleMode = isVisual ? patch!.mode : ruleOrSpec.mode
  const rawZone = isVisual ? patch!.timeZone : ruleOrSpec.timeZone
  const zone = rawZone && isValidTimeZone(rawZone) ? rawZone : resolveHostTimeZone()
  const maxRuns = isVisual ? (patch!.maxRuns ?? undefined) : ruleOrSpec.maxRuns
  const runCount = isVisual ? 0 : ruleOrSpec.runCount
  const cappedCount =
    maxRuns !== undefined && maxRuns > 0
      ? Math.min(limitCount, Math.max(0, maxRuns - runCount))
      : limitCount

  if (cappedCount === 0) return []

  if (mode === 'once') {
    const at = isVisual ? patch!.at : ruleOrSpec.at
    return typeof at === 'number' && Number.isFinite(at) ? [at] : []
  }

  if (mode === 'after_completion') {
    const intervalDays = isVisual ? (patch!.intervalDays ?? 1) : (ruleOrSpec.intervalDays ?? 1)
    const atHour = isVisual ? patch!.atHour : ruleOrSpec.atHour
    const atMinute = isVisual ? patch!.atMinute : ruleOrSpec.atMinute
    const out: number[] = []
    let cursor = fromMs
    for (let i = 0; i < cappedCount; i += 1) {
      const next = nextAfterCompletionAtMs(cursor, intervalDays, zone, atHour, atMinute)
      out.push(next)
      cursor = next
    }
    return out
  }

  const cron = isVisual ? (patch!.cron ?? '') : (ruleOrSpec.cron ?? '')
  if (!isValidCron(cron)) return []
  const out: number[] = []
  let cursor = fromMs
  for (let i = 0; i < cappedCount; i += 1) {
    const next = nextRunAtMs(cron, cursor, zone)
    if (next === undefined) break
    out.push(next)
    cursor = next
  }
  return out
}

export function estimateCronIntervalMinutes(
  expr: string,
  timeZone?: string,
  fromMs = Date.now(),
): number | undefined {
  if (!isValidCron(expr)) return undefined
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : resolveHostTimeZone()
  const first = nextRunAtMs(expr, fromMs, zone)
  if (first === undefined) return undefined
  const second = nextRunAtMs(expr, first, zone)
  if (second === undefined) return undefined
  return Math.round((second - first) / 60_000)
}

const ZH_WEEKDAYS: Record<number, string> = {
  1: '一',
  2: '二',
  3: '三',
  4: '四',
  5: '五',
  6: '六',
  7: '日',
}

const EN_WEEKDAYS: Record<number, string> = {
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
  7: 'Sun',
}

export function formatScheduleSummary(
  rule: ScheduleRule,
  locale: 'zh' | 'en',
  now = Date.now(),
): string {
  const spec = ruleToVisualSchedule(rule)
  const pad = (n: number) => String(n).padStart(2, '0')
  const timeStr = `${pad(spec.hour)}:${pad(spec.minute)}`
  const isRemind = (rule.action ?? 'dispatch') === 'remind'
  const actionStr = isRemind
    ? locale === 'zh'
      ? '仅提醒'
      : 'Remind only'
    : locale === 'zh'
      ? '自动拉起会话'
      : 'Auto-dispatch'

  let cadenceStr = ''
  if (spec.preset === 'once') {
    const target = rule.at ?? rule.nextRunAt
    if (target !== undefined && Number.isFinite(target)) {
      const targetParts = partsInZone(spec.timeZone, target)
      const nowParts = partsInZone(spec.timeZone, now)
      const tmrwParts = partsInZone(spec.timeZone, now + 86_400_000)
      const sameDay = (a: ZonedParts, b: ZonedParts) =>
        a.year === b.year && a.month === b.month && a.day === b.day
      const tStr = `${pad(targetParts.hour)}:${pad(targetParts.minute)}`
      const dateStr = sameDay(targetParts, nowParts)
        ? locale === 'zh'
          ? '今天'
          : 'Today'
        : sameDay(targetParts, tmrwParts)
          ? locale === 'zh'
            ? '明天'
            : 'Tmrw'
          : `${pad(targetParts.month)}-${pad(targetParts.day)}`
      cadenceStr =
        locale === 'zh' ? `${dateStr} ${tStr} 单次` : `${dateStr} ${tStr} Once`
    } else {
      cadenceStr = locale === 'zh' ? '单次定时' : 'Once'
    }
  } else if (spec.preset === 'daily') {
    cadenceStr = locale === 'zh' ? `每天 ${timeStr}` : `Daily ${timeStr}`
  } else if (spec.preset === 'weekdays') {
    cadenceStr = locale === 'zh' ? `工作日 ${timeStr}` : `Weekdays ${timeStr}`
  } else if (spec.preset === 'weekly') {
    const days = spec.weekdays
    if (locale === 'zh') {
      const names = days.map((d) => ZH_WEEKDAYS[d] ?? String(d)).join('、')
      cadenceStr = `每周${names} ${timeStr}`
    } else {
      const names = days.map((d) => EN_WEEKDAYS[d] ?? String(d)).join(', ')
      cadenceStr = `${names} ${timeStr}`
    }
  } else if (spec.preset === 'monthly') {
    cadenceStr =
      locale === 'zh'
        ? `每月${spec.dayOfMonth}日 ${timeStr}`
        : `Monthly ${spec.dayOfMonth} ${timeStr}`
  } else if (spec.preset === 'after_completion') {
    const hasTime = rule.atHour !== undefined && rule.atMinute !== undefined
    const timeSuffix = hasTime ? ` ${timeStr}` : ''
    cadenceStr =
      locale === 'zh'
        ? `验收后 +${spec.intervalDays} 天${timeSuffix}`
        : `After review +${spec.intervalDays}d${timeSuffix}`
  } else {
    cadenceStr = `Cron (${rule.cron ?? ''})`
  }

  return `${cadenceStr} · ${actionStr}`
}
