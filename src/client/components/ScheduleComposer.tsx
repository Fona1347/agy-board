import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bell,
  ChevronDown,
  ChevronRight,
  Clock,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Trash2,
  Zap,
} from 'lucide-react'
import { requiresPermissionConfirmation } from '../../core/handover.ts'
import {
  computeNextRunPreviews,
  estimateCronIntervalMinutes,
  formatScheduleSummary,
  isValidCron,
  partsInZone,
  resolveHostTimeZone,
  ruleToVisualSchedule,
  visualScheduleToPatch,
  zonedEpoch,
  type SchedulePatch,
  type VisualSchedulePreset,
  type VisualScheduleSpec,
} from '../../core/schedule.ts'
import type {
  ScheduleMisfirePolicy,
  ScheduleOverlapPolicy,
  ScheduleRule,
  ScheduleSessionMode,
  TaskPermission,
  TaskRecord,
} from '../../core/types.ts'
import { boardApi, type ScheduleMutationPatch } from '../api.ts'
import { tr, type Locale } from '../i18n.ts'
import { dateTimeLocalToEpoch, epochToDateTimeLocal } from '../utils.ts'

const CURATED_TIME_ZONES = [
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
] as const

const WEEKDAY_ITEMS: ReadonlyArray<{ bit: number; zh: string; en: string }> = [
  { bit: 1, zh: '一', en: 'Mon' },
  { bit: 2, zh: '二', en: 'Tue' },
  { bit: 3, zh: '三', en: 'Wed' },
  { bit: 4, zh: '四', en: 'Thu' },
  { bit: 5, zh: '五', en: 'Fri' },
  { bit: 6, zh: '六', en: 'Sat' },
  { bit: 7, zh: '日', en: 'Sun' },
]

export function hasAnyScheduleOrReminder(task: Pick<TaskRecord, 'schedule' | 'reminderAt'>): boolean {
  return Boolean(task.schedule || task.reminderAt !== undefined)
}

export function isRecurringActiveSchedule(task: Pick<TaskRecord, 'schedule'>): boolean {
  return Boolean(
    task.schedule?.enabled &&
      (task.schedule.mode === 'cron' || task.schedule.mode === 'after_completion'),
  )
}

export function isMissedSchedule(sched?: ScheduleRule): boolean {
  return Boolean(sched && (sched.missedSlotAt !== undefined || sched.skippedReason === 'missed'))
}

export function computeQuickOnceTimestamp(
  kind: '30m' | '1h' | 'tonight' | 'tomorrow9' | 'nextMon9',
  now = Date.now(),
  timeZone = resolveHostTimeZone(),
): number {
  if (kind === '30m') return now + 30 * 60_000
  if (kind === '1h') return now + 60 * 60_000
  const p = partsInZone(timeZone, now)
  if (kind === 'tonight') {
    if (p.hour < 19 || (p.hour === 19 && p.minute < 30)) {
      const tonight = zonedEpoch(timeZone, p.year, p.month, p.day, 20, 0)
      if (tonight !== undefined && tonight > now) return tonight
    }
    return now + 2 * 60 * 60_000
  }
  if (kind === 'tomorrow9') {
    const tmrw = new Date(Date.UTC(p.year, p.month - 1, p.day + 1))
    return (
      zonedEpoch(timeZone, tmrw.getUTCFullYear(), tmrw.getUTCMonth() + 1, tmrw.getUTCDate(), 9, 0) ??
      now + 24 * 60 * 60_000
    )
  }
  // nextMon9
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() // 0=Sun, 1=Mon
  const daysToMon = dow === 0 ? 1 : 8 - dow
  const mon = new Date(Date.UTC(p.year, p.month - 1, p.day + daysToMon))
  return (
    zonedEpoch(timeZone, mon.getUTCFullYear(), mon.getUTCMonth() + 1, mon.getUTCDate(), 9, 0) ??
    now + daysToMon * 24 * 60 * 60_000
  )
}

function formatTimeShort(ts: number, locale: Locale, now = Date.now()): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const today = new Date(now)
  const tmrw = new Date(now)
  tmrw.setDate(tmrw.getDate() + 1)
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(d, today)) return `${locale === 'zh' ? '今天' : 'Today'} ${hhmm}`
  if (sameDay(d, tmrw)) return `${locale === 'zh' ? (d.getHours() < 12 ? '明早' : '明天') : 'Tmrw'} ${hhmm}`
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}`
}

function formatClockHHMM(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function parseClockHHMM(val: string): { hour: number; minute: number } | null {
  const match = val.match(/^(\d{2}):(\d{2})$/)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute }
}

export interface ScheduleComposerProps {
  locale: Locale
  initialRule?: ScheduleRule
  initialSpec?: VisualScheduleSpec
  defaultTimeZone?: string
  task?: TaskRecord
  workspacePath?: string
  sessionDefaultPermission?: TaskPermission
  compact?: boolean
  embedded?: boolean
  busy?: boolean
  onConfirmPermission?: () => void | Promise<void>
  onChange?: (patch: SchedulePatch, isValid: boolean) => void
  onSave?: (patch: SchedulePatch) => void | Promise<void>
  onCancel?: () => void
}

export function ScheduleComposer({
  locale,
  initialRule,
  initialSpec,
  defaultTimeZone,
  task,
  workspacePath,
  sessionDefaultPermission = 'read-only',
  compact = false,
  embedded = false,
  busy = false,
  onConfirmPermission,
  onChange,
  onSave,
  onCancel,
}: ScheduleComposerProps) {
  const [spec, setSpec] = useState<VisualScheduleSpec>(() => {
    const base = initialSpec ?? ruleToVisualSchedule(initialRule, defaultTimeZone)
    if (base.preset === 'once' && !base.at) {
      return { ...base, at: computeQuickOnceTimestamp('tomorrow9', Date.now(), base.timeZone) }
    }
    return base
  })
  const [showMore, setShowMore] = useState(false)

  useEffect(() => {
    if (initialSpec) setSpec(initialSpec)
    else if (initialRule) setSpec(ruleToVisualSchedule(initialRule, defaultTimeZone))
  }, [initialRule, initialSpec, defaultTimeZone])

  const effectiveWorkspacePath = workspacePath ?? task?.workspacePath
  const missingWorkspaceForDispatch = spec.action === 'dispatch' && !effectiveWorkspacePath
  const needsPerm = Boolean(
    task && spec.action === 'dispatch' && requiresPermissionConfirmation(task, sessionDefaultPermission),
  )

  const patch = useMemo(() => visualScheduleToPatch(spec), [spec])

  const validationError = useMemo(() => {
    if (missingWorkspaceForDispatch) {
      return locale === 'zh'
        ? '未绑定工作区时无法后台拉起会话，请先绑定工作区或改用「仅到点提醒」'
        : 'Cannot dispatch a background session without a bound workspace. Bind a workspace first or switch to "Remind only".'
    }
    if (spec.preset === 'once') {
      if (!spec.at || !Number.isFinite(spec.at) || spec.at <= Date.now()) {
        return locale === 'zh' ? '请选择将来的触发时间' : 'Pick a future date & time'
      }
    }
    if (spec.preset === 'custom_cron' && !isValidCron(spec.customCron)) {
      return locale === 'zh' ? 'Cron 表达式须为合法 5 段格式' : 'Enter a valid 5-field cron expression'
    }
    if (spec.preset === 'after_completion' && (!Number.isFinite(spec.intervalDays) || spec.intervalDays < 1)) {
      return locale === 'zh' ? '间隔天数至少为 1 天' : 'Interval days must be >= 1'
    }
    return null
  }, [missingWorkspaceForDispatch, spec, locale])

  const isValid = validationError === null
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    onChangeRef.current?.(patch, isValid)
  }, [patch, isValid])

  const highFreqMinutes = useMemo(() => {
    if (spec.preset !== 'custom_cron') return undefined
    const mins = estimateCronIntervalMinutes(spec.customCron, spec.timeZone)
    return mins !== undefined && mins < 60 ? mins : undefined
  }, [spec.preset, spec.customCron, spec.timeZone])

  const previewRule: ScheduleRule = useMemo(
    () => ({
      enabled: true,
      mode: patch.mode,
      cron: patch.cron,
      at: patch.at,
      intervalDays: patch.intervalDays,
      atHour: patch.atHour,
      atMinute: patch.atMinute,
      timeZone: patch.timeZone ?? undefined,
      action: patch.action,
      sessionMode: patch.sessionMode,
      misfirePolicy: patch.misfirePolicy,
      overlapPolicy: patch.overlapPolicy,
      maxRuns: patch.maxRuns ?? undefined,
      runCount: 0,
    }),
    [patch],
  )

  const summaryLine = useMemo(() => formatScheduleSummary(previewRule, locale), [previewRule, locale])
  const previewTimestamps = useMemo(() => computeNextRunPreviews(spec, 3), [spec])

  const nowParts = useMemo(() => partsInZone(spec.timeZone || resolveHostTimeZone(), Date.now()), [spec.timeZone])
  const tonightLabel = useMemo(() => {
    const before1930 = nowParts.hour < 19 || (nowParts.hour === 19 && nowParts.minute < 30)
    if (locale === 'zh') return before1930 ? '今晚 20:00' : '+2小时'
    return before1930 ? 'Tonight 20:00' : '+2h'
  }, [nowParts, locale])

  const updateSpec = (partial: Partial<VisualScheduleSpec>) => {
    setSpec((prev) => ({ ...prev, ...partial }))
  }

  const selectPreset = (preset: VisualSchedulePreset) => {
    setSpec((prev) => {
      const next: VisualScheduleSpec = { ...prev, preset, enabled: true }
      if (preset === 'once' && (!prev.at || prev.at <= Date.now())) {
        next.at = computeQuickOnceTimestamp('tomorrow9', Date.now(), prev.timeZone)
      }
      if (preset === 'daily') next.weekdays = [1, 2, 3, 4, 5, 6, 7]
      if (preset === 'weekdays') next.weekdays = [1, 2, 3, 4, 5]
      if (preset === 'weekly' && (prev.weekdays.length === 0 || prev.weekdays.length === 7)) {
        next.weekdays = [1, 3, 5]
      }
      if (preset === 'custom_cron' && !prev.customCron.trim()) {
        next.customCron = visualScheduleToPatch(prev).cron ?? '0 9 * * 1-5'
      }
      return next
    })
  }

  const toggleWeekday = (bit: number) => {
    setSpec((prev) => {
      const exists = prev.weekdays.includes(bit)
      const nextDays = exists ? prev.weekdays.filter((d) => d !== bit) : [...prev.weekdays, bit].sort((a, b) => a - b)
      if (nextDays.length === 0) return prev
      if (nextDays.length === 7) {
        return { ...prev, preset: 'daily', weekdays: nextDays }
      }
      if (nextDays.length === 5 && nextDays.every((d, i) => d === i + 1)) {
        return { ...prev, preset: 'weekdays', weekdays: nextDays }
      }
      return { ...prev, preset: 'weekly', weekdays: nextDays }
    })
  }

  const timeZones = useMemo(() => {
    const list = [...CURATED_TIME_ZONES] as string[]
    if (spec.timeZone && !list.includes(spec.timeZone)) {
      list.unshift(spec.timeZone)
    }
    return list
  }, [spec.timeZone])

  const presetLabels: ReadonlyArray<{ id: VisualSchedulePreset; zh: string; en: string }> = [
    { id: 'once', zh: '单次', en: 'Once' },
    { id: 'daily', zh: '每天', en: 'Daily' },
    { id: 'weekdays', zh: '工作日', en: 'Weekdays' },
    { id: 'weekly', zh: '每周', en: 'Weekly' },
    { id: 'monthly', zh: '每月', en: 'Monthly' },
    { id: 'after_completion', zh: '验收后', en: 'After review' },
    { id: 'custom_cron', zh: 'Cron', en: 'Cron' },
  ]

  return (
    <div
      className={`sched-composer${embedded ? ' is-embedded' : ''}`}
      data-testid="schedule-composer"
    >
      {/* 1. Action Toggle */}
      <div className="sched-section-row">
        <span className="sched-row-label">{locale === 'zh' ? '触发动作' : 'Action'}</span>
        <div className="sched-seg-group" role="group" aria-label={locale === 'zh' ? '触发动作' : 'Schedule action'}>
          <button
            type="button"
            className={`btn btn-xs btn-pill${spec.action === 'dispatch' ? ' is-active' : ''}`}
            onClick={() => updateSpec({ action: 'dispatch' })}
          >
            <Zap size={11} />
            <span>{locale === 'zh' ? '自动拉起 AI 会话' : 'Auto-dispatch AI'}</span>
          </button>
          <button
            type="button"
            className={`btn btn-xs btn-pill${spec.action === 'remind' ? ' is-active' : ''}`}
            onClick={() => updateSpec({ action: 'remind' })}
          >
            <Bell size={11} />
            <span>{locale === 'zh' ? '仅到点提醒我' : 'Remind only'}</span>
          </button>
        </div>
      </div>

      {/* 2. Frequency Pills */}
      <div className="sched-section-row">
        <span className="sched-row-label">{locale === 'zh' ? '执行频率' : 'Cadence'}</span>
        <div className="sched-pill-row" role="group" aria-label={locale === 'zh' ? '执行频率' : 'Frequency'}>
          {presetLabels.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`btn btn-xs btn-pill${spec.preset === p.id ? ' is-active' : ''}`}
              onClick={() => selectPreset(p.id)}
            >
              {locale === 'zh' ? p.zh : p.en}
            </button>
          ))}
        </div>
      </div>

      {/* 3. Dynamic Sub-row */}
      {spec.preset === 'once' && (
        <div className="sched-section-row">
          <span className="sched-row-label">{locale === 'zh' ? '触发时间' : 'Run at'}</span>
          <div className="sched-pill-row" style={{ flex: 1 }}>
            <button
              type="button"
              className="btn btn-xs"
              onClick={() => updateSpec({ at: computeQuickOnceTimestamp('30m') })}
            >
              {locale === 'zh' ? '+30分钟' : '+30m'}
            </button>
            <button
              type="button"
              className="btn btn-xs"
              onClick={() => updateSpec({ at: computeQuickOnceTimestamp('tonight', Date.now(), spec.timeZone) })}
            >
              {tonightLabel}
            </button>
            <button
              type="button"
              className="btn btn-xs"
              onClick={() => updateSpec({ at: computeQuickOnceTimestamp('tomorrow9', Date.now(), spec.timeZone) })}
            >
              {locale === 'zh' ? '明早 09:00' : 'Tmrw 09:00'}
            </button>
            <button
              type="button"
              className="btn btn-xs"
              onClick={() => updateSpec({ at: computeQuickOnceTimestamp('nextMon9', Date.now(), spec.timeZone) })}
            >
              {locale === 'zh' ? '下周一 09:00' : 'Next Mon 09:00'}
            </button>
            <input
              type="datetime-local"
              className="input-field sched-dt-input"
              aria-label={locale === 'zh' ? '单次触发时间' : 'One-shot datetime'}
              value={epochToDateTimeLocal(spec.at)}
              onChange={(e) => {
                const ts = dateTimeLocalToEpoch(e.target.value)
                updateSpec({ at: ts })
              }}
            />
          </div>
        </div>
      )}

      {(spec.preset === 'daily' || spec.preset === 'weekdays') && (
        <div className="sched-section-row">
          <span className="sched-row-label">{locale === 'zh' ? '时刻' : 'Time'}</span>
          <div className="sched-pill-row">
            <input
              type="time"
              className="input-field sched-time-input"
              aria-label={locale === 'zh' ? '触发时刻' : 'Trigger time'}
              value={formatClockHHMM(spec.hour, spec.minute)}
              onChange={(e) => {
                const parsed = parseClockHHMM(e.target.value)
                if (parsed) updateSpec(parsed)
              }}
            />
            {[
              { h: 9, m: 0, label: '09:00' },
              { h: 14, m: 0, label: '14:00' },
              { h: 21, m: 0, label: '21:00' },
            ].map((q) => (
              <button
                key={q.label}
                type="button"
                className={`btn btn-xs${spec.hour === q.h && spec.minute === q.m ? ' is-active' : ''}`}
                onClick={() => updateSpec({ hour: q.h, minute: q.m })}
              >
                {q.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {spec.preset === 'weekly' && (
        <>
          <div className="sched-section-row">
            <span className="sched-row-label">{locale === 'zh' ? '星期' : 'Days'}</span>
            <div className="sched-pill-row">
              {WEEKDAY_ITEMS.map((d) => (
                <button
                  key={d.bit}
                  type="button"
                  className={`btn btn-xs btn-pill sched-weekday-btn${spec.weekdays.includes(d.bit) ? ' is-active' : ''}`}
                  aria-pressed={spec.weekdays.includes(d.bit)}
                  onClick={() => toggleWeekday(d.bit)}
                >
                  {locale === 'zh' ? d.zh : d.en}
                </button>
              ))}
            </div>
          </div>
          <div className="sched-section-row">
            <span className="sched-row-label">{locale === 'zh' ? '时刻' : 'Time'}</span>
            <div className="sched-pill-row">
              <input
                type="time"
                className="input-field sched-time-input"
                aria-label={locale === 'zh' ? '触发时刻' : 'Trigger time'}
                value={formatClockHHMM(spec.hour, spec.minute)}
                onChange={(e) => {
                  const parsed = parseClockHHMM(e.target.value)
                  if (parsed) updateSpec(parsed)
                }}
              />
              {[
                { h: 9, m: 0, label: '09:00' },
                { h: 14, m: 0, label: '14:00' },
                { h: 21, m: 0, label: '21:00' },
              ].map((q) => (
                <button
                  key={q.label}
                  type="button"
                  className={`btn btn-xs${spec.hour === q.h && spec.minute === q.m ? ' is-active' : ''}`}
                  onClick={() => updateSpec({ hour: q.h, minute: q.m })}
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {spec.preset === 'monthly' && (
        <div className="sched-section-row">
          <span className="sched-row-label">{locale === 'zh' ? '日期与时刻' : 'Day & Time'}</span>
          <div className="sched-pill-row">
            <span className="text-muted" style={{ fontSize: 11.5 }}>{locale === 'zh' ? '每月第' : 'Day'}</span>
            <input
              type="number"
              min={1}
              max={31}
              className="input-field sched-num-input"
              aria-label={locale === 'zh' ? '每月几号' : 'Day of month'}
              value={spec.dayOfMonth}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n)) updateSpec({ dayOfMonth: Math.min(31, Math.max(1, Math.trunc(n))) })
              }}
            />
            <span className="text-muted" style={{ fontSize: 11.5 }}>{locale === 'zh' ? '日' : ''}</span>
            <input
              type="time"
              className="input-field sched-time-input"
              aria-label={locale === 'zh' ? '触发时刻' : 'Trigger time'}
              value={formatClockHHMM(spec.hour, spec.minute)}
              onChange={(e) => {
                const parsed = parseClockHHMM(e.target.value)
                if (parsed) updateSpec(parsed)
              }}
            />
          </div>
        </div>
      )}

      {spec.preset === 'after_completion' && (
        <div className="sched-section-row">
          <span className="sched-row-label">{locale === 'zh' ? '周期间隔' : 'Interval'}</span>
          <div className="sched-pill-row">
            <span className="text-muted" style={{ fontSize: 11.5 }}>
              {locale === 'zh' ? '验收通过后' : 'After review +'}
            </span>
            <input
              type="number"
              min={1}
              className="input-field sched-num-input"
              aria-label={locale === 'zh' ? '间隔天数' : 'Interval days'}
              value={spec.intervalDays}
              onChange={(e) => {
                const n = Number(e.target.value)
                updateSpec({ intervalDays: Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 1 })
              }}
            />
            <span className="text-muted" style={{ fontSize: 11.5 }}>{locale === 'zh' ? '天' : 'days'}</span>
            <label className="row-wrap" style={{ fontSize: 11.5 }}>
              <input
                type="checkbox"
                checked={spec.useCustomTimeForAfterCompletion}
                onChange={(e) => updateSpec({ useCustomTimeForAfterCompletion: e.target.checked })}
              />
              <span>{locale === 'zh' ? '指定时刻' : 'At time'}</span>
            </label>
            {spec.useCustomTimeForAfterCompletion && (
              <input
                type="time"
                className="input-field sched-time-input"
                aria-label={locale === 'zh' ? '触发时刻' : 'Trigger time'}
                value={formatClockHHMM(spec.hour, spec.minute)}
                onChange={(e) => {
                  const parsed = parseClockHHMM(e.target.value)
                  if (parsed) updateSpec(parsed)
                }}
              />
            )}
          </div>
        </div>
      )}

      {spec.preset === 'custom_cron' && (
        <div className="sched-section-row">
          <span className="sched-row-label">Cron</span>
          <div className="sched-pill-row" style={{ flex: 1 }}>
            <input
              className="input-field"
              style={{ flex: '1 1 160px', fontFamily: 'monospace' }}
              aria-label={locale === 'zh' ? 'Cron 表达式' : 'Cron expression'}
              value={spec.customCron}
              onChange={(e) => updateSpec({ customCron: e.target.value })}
              placeholder="0 9 * * 1-5"
            />
          </div>
        </div>
      )}

      {highFreqMinutes !== undefined && (
        <div className="sched-guardrail" data-testid="high-freq-warning">
          <span className="row-wrap">
            <AlertTriangle size={12} />
            <span>
              {locale === 'zh'
                ? `高频提示：当前 Cron 约每 ${highFreqMinutes} 分钟触发一次（< 60 分钟），请确认符合预期。`
                : `High-frequency warning: triggers every ~${highFreqMinutes}m (< 60m).`}
            </span>
          </span>
        </div>
      )}

      {/* 4. Session Continuity & Safety Row */}
      {spec.action === 'dispatch' && (
        <div className="sched-section-row">
          <span className="sched-row-label">{locale === 'zh' ? '会话模式' : 'Session'}</span>
          <div className="sched-seg-group">
            <button
              type="button"
              className={`btn btn-xs btn-pill${spec.sessionMode === 'new' ? ' is-active' : ''}`}
              onClick={() => updateSpec({ sessionMode: 'new' as ScheduleSessionMode })}
            >
              {locale === 'zh' ? '每次新建独立会话(带记忆)' : 'New clean session (with context)'}
            </button>
            <button
              type="button"
              className={`btn btn-xs btn-pill${spec.sessionMode === 'auto' ? ' is-active' : ''}`}
              onClick={() => updateSpec({ sessionMode: 'auto' as ScheduleSessionMode })}
            >
              {locale === 'zh' ? '续跑同一会话' : 'Continue same session'}
            </button>
          </div>
        </div>
      )}

      {/* 5. More Options Fold */}
      <div>
        <button
          type="button"
          className="sched-advanced-toggle"
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
        >
          {showMore ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>{locale === 'zh' ? '更多选项' : 'More options'}</span>
        </button>

        {showMore && (
          <div className="sched-advanced-grid">
            <label className="form-label">
              <span>{tr(locale, 'timeZoneLabel')}</span>
              <select
                className="select-field"
                aria-label={tr(locale, 'timeZoneLabel')}
                value={spec.timeZone}
                onChange={(e) => updateSpec({ timeZone: e.target.value })}
              >
                <option value="">
                  {locale === 'zh' ? `跟随系统 (${resolveHostTimeZone()})` : `System (${resolveHostTimeZone()})`}
                </option>
                {timeZones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </label>

            <label className="form-label">
              <span>{locale === 'zh' ? '休眠错过策略' : 'Misfire policy'}</span>
              <select
                className="select-field"
                aria-label={locale === 'zh' ? '休眠错过策略' : 'Misfire policy'}
                value={spec.misfirePolicy}
                onChange={(e) => updateSpec({ misfirePolicy: e.target.value as ScheduleMisfirePolicy })}
              >
                <option value="prompt">{locale === 'zh' ? '唤醒提示补跑' : 'Prompt on wake'}</option>
                <option value="catch_up_once">{locale === 'zh' ? '唤醒自动补跑1次' : 'Auto catch up once'}</option>
                <option value="skip">{locale === 'zh' ? '跳过' : 'Skip'}</option>
              </select>
            </label>

            {spec.action === 'dispatch' && (
              <label className="form-label">
                <span>{locale === 'zh' ? '未验收防叠跑' : 'Overlap policy'}</span>
                <select
                  className="select-field"
                  aria-label={locale === 'zh' ? '未验收防叠跑' : 'Overlap policy'}
                  value={spec.overlapPolicy}
                  onChange={(e) => updateSpec({ overlapPolicy: e.target.value as ScheduleOverlapPolicy })}
                >
                  <option value="wait_review">{locale === 'zh' ? '等待本轮验收' : 'Wait for review'}</option>
                  <option value="allow_replace">{locale === 'zh' ? '允许直接覆盖' : 'Allow overwrite'}</option>
                </select>
              </label>
            )}

            {spec.preset !== 'once' && (
              <label className="form-label">
                <span>{tr(locale, 'maxRunsLabel')}</span>
                <input
                  type="number"
                  min={1}
                  className="input-field"
                  aria-label={tr(locale, 'maxRunsLabel')}
                  value={spec.maxRuns ?? ''}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    updateSpec({ maxRuns: e.target.value.trim() && Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined })
                  }}
                  placeholder={locale === 'zh' ? '不限' : 'Unlimited'}
                />
              </label>
            )}
          </div>
        )}
      </div>

      {/* 6. Inline Pre-Flight Guardrails */}
      {missingWorkspaceForDispatch && (
        <div className="sched-guardrail" data-testid="schedule-workspace-guardrail">
          <span className="row-wrap">
            <AlertTriangle size={13} />
            <span>{validationError}</span>
          </span>
        </div>
      )}

      {!missingWorkspaceForDispatch && needsPerm && (
        <div className="sched-guardrail" data-testid="schedule-permission-guardrail">
          <span className="row-wrap">
            <AlertTriangle size={13} />
            <span>{tr(locale, 'permissionPendingBanner')}</span>
          </span>
          {onConfirmPermission && (
            <button
              type="button"
              className="btn btn-xs btn-primary"
              disabled={busy}
              onClick={() => void onConfirmPermission()}
            >
              {locale === 'zh' ? '确认提权' : 'Confirm Permission'}
            </button>
          )}
        </div>
      )}

      {/* 7. Live Footer: Human Summary + Next 3 Previews + Actions */}
      <div className="sched-footer">
        <div className="sched-footer-top">
          <span className="sched-summary-text">{summaryLine}</span>
          {!compact && (
            <div className="row-wrap">
              {onCancel && (
                <button type="button" className="btn btn-xs" onClick={onCancel} disabled={busy}>
                  {tr(locale, 'cancel')}
                </button>
              )}
              {onSave && (
                <button
                  type="button"
                  className="btn btn-xs btn-primary"
                  disabled={busy || !isValid}
                  onClick={() => void onSave(patch)}
                >
                  {tr(locale, 'save')}
                </button>
              )}
            </div>
          )}
        </div>

        {previewTimestamps.length > 0 && (
          <div className="sched-preview-list" data-testid="schedule-previews">
            <span>
              {spec.preset === 'after_completion'
                ? locale === 'zh'
                  ? '若现在验收，预计：'
                  : 'If accepted now:'
                : locale === 'zh'
                  ? '接下来触发：'
                  : 'Next runs:'}
            </span>
            {previewTimestamps.map((ts, idx) => (
              <span key={`${ts}-${idx}`} className="sched-preview-chip">
                {formatTimeShort(ts, locale)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export interface TaskScheduleBarProps {
  task: TaskRecord
  locale: Locale
  now?: number
  defaultTimeZone?: string
  sessionDefaultPermission: TaskPermission
  busy?: boolean
  onRunAction: (fn: () => Promise<unknown>, toastMsg?: string) => Promise<void>
}

export function TaskScheduleBar({
  task,
  locale,
  now = Date.now(),
  defaultTimeZone,
  sessionDefaultPermission,
  busy = false,
  onRunAction,
}: TaskScheduleBarProps) {
  const [editing, setEditing] = useState(false)
  const sched = task.schedule
  const missed = isMissedSchedule(sched)

  const handleQuickSchedule = (kind: '1h' | 'tomorrow9' | 'weekdays') => {
    const zone = defaultTimeZone || resolveHostTimeZone()
    const action = task.workspacePath ? 'dispatch' : 'remind'
    if (kind === 'weekdays') {
      void onRunAction(
        () =>
          boardApi.setSchedule(task.id, {
            enabled: true,
            mode: 'cron',
            cron: '0 9 * * 1-5',
            timeZone: zone,
            action,
            sessionMode: 'new',
          }),
        locale === 'zh' ? '已启用工作日 09:00 定时' : 'Armed weekdays 09:00',
      )
      return
    }
    const at = computeQuickOnceTimestamp(kind, Date.now(), zone)
    void onRunAction(
      () =>
        boardApi.setSchedule(task.id, {
          enabled: true,
          mode: 'once',
          at,
          timeZone: zone,
          action,
          sessionMode: 'auto',
        }),
      kind === '1h'
        ? locale === 'zh'
          ? '已设 1 小时后触发'
          : 'Armed +1h'
        : locale === 'zh'
          ? '已设明早 09:00 触发'
          : 'Armed tomorrow 09:00',
    )
  }

  if (!sched && task.reminderAt === undefined) {
    return (
      <div className={`sched-bar is-unset${editing ? ' is-editing' : ''}`} data-testid="task-schedule-bar">
        <div className="sched-bar-head">
          <button
            type="button"
            className="btn btn-xs"
            disabled={busy}
            onClick={() => setEditing((v) => !v)}
          >
            <Clock size={12} />
            <span>{tr(locale, 'addSchedule')}</span>
          </button>
          <div className="sched-bar-actions">
            <button type="button" className="btn btn-xs btn-ghost" disabled={busy} onClick={() => handleQuickSchedule('1h')}>
              {locale === 'zh' ? '+1小时' : '+1h'}
            </button>
            <button type="button" className="btn btn-xs btn-ghost" disabled={busy} onClick={() => handleQuickSchedule('tomorrow9')}>
              {locale === 'zh' ? '明早 09:00' : 'Tmrw 09:00'}
            </button>
            <button type="button" className="btn btn-xs btn-ghost" disabled={busy} onClick={() => handleQuickSchedule('weekdays')}>
              {locale === 'zh' ? '每工作日' : 'Weekdays'}
            </button>
          </div>
        </div>
        {editing && (
          <ScheduleComposer
            locale={locale}
            embedded
            defaultTimeZone={defaultTimeZone}
            task={task}
            sessionDefaultPermission={sessionDefaultPermission}
            busy={busy}
            onConfirmPermission={() => onRunAction(() => boardApi.confirmPermission(task.id), 'Permission confirmed')}
            onSave={async (patch: ScheduleMutationPatch) => {
              await onRunAction(
                () => boardApi.setSchedule(task.id, patch),
                locale === 'zh' ? '定时计划已保存' : 'Schedule saved',
              )
              setEditing(false)
            }}
            onCancel={() => setEditing(false)}
          />
        )}
      </div>
    )
  }

  const summary = sched ? formatScheduleSummary(sched, locale, now) : ''
  const nextLabel = sched?.nextRunAt
    ? formatTimeShort(sched.nextRunAt, locale, now)
    : sched?.mode === 'after_completion' && sched.enabled && (task.phase === 'needs_you' || task.phase === 'active')
      ? locale === 'zh'
        ? '本轮验收后开始倒计时'
        : 'Starts countdown after round review'
      : undefined

  return (
    <div className="sched-bar" data-testid="task-schedule-bar">
      {sched && (
        <>
          <div className="sched-bar-head">
            <div className="sched-bar-summary">
              <span
                className={`sched-status-dot${
                  missed || sched.skippedReason === 'awaiting-review'
                    ? ' is-warn'
                    : sched.enabled
                      ? ' is-on'
                      : ''
                }`}
              />
              <span>{summary}</span>
            </div>

            <div className="sched-bar-actions">
              <button
                type="button"
                className="btn btn-xs"
                disabled={busy}
                onClick={() =>
                  void onRunAction(
                    () => boardApi.runScheduleNow(task.id),
                    locale === 'zh' ? '已立即试跑一轮' : 'Triggered immediate run',
                  )
                }
              >
                <Play size={11} />
                <span>{tr(locale, 'runNow')}</span>
              </button>

              <button
                type="button"
                className={`btn btn-xs${sched.enabled ? ' is-active' : ''}`}
                disabled={busy}
                onClick={() =>
                  void onRunAction(
                    () => boardApi.setSchedule(task.id, { enabled: !sched.enabled }),
                    sched.enabled
                      ? locale === 'zh'
                        ? '已暂停定时'
                        : 'Schedule paused'
                      : locale === 'zh'
                        ? '已启用定时'
                        : 'Schedule enabled',
                  )
                }
              >
                {sched.enabled ? <Pause size={11} /> : <RotateCcw size={11} />}
                <span>{sched.enabled ? tr(locale, 'scheduleEnabled') : tr(locale, 'schedulePaused')}</span>
              </button>

              {sched.enabled && sched.mode === 'cron' && sched.nextRunAt !== undefined && (
                <button
                  type="button"
                  className="btn btn-xs btn-ghost"
                  disabled={busy}
                  onClick={() =>
                    void onRunAction(
                      () => boardApi.skipScheduleCycle(task.id),
                      locale === 'zh' ? '已跳过本轮' : 'Cycle skipped',
                    )
                  }
                >
                  <SkipForward size={11} />
                  <span>{tr(locale, 'skipCycle')}</span>
                </button>
              )}

              <button
                type="button"
                className={`btn btn-xs btn-ghost${editing ? ' is-active' : ''}`}
                disabled={busy}
                onClick={() => setEditing((v) => !v)}
              >
                <span>{locale === 'zh' ? '编辑' : 'Edit'}</span>
                {editing ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              </button>

              <button
                type="button"
                className="btn btn-xs btn-ghost"
                disabled={busy}
                title={tr(locale, 'clear')}
                aria-label={locale === 'zh' ? '清除定时' : 'Clear schedule'}
                onClick={() =>
                  void onRunAction(
                    () => boardApi.setSchedule(task.id, { clear: true }),
                    locale === 'zh' ? '已清除定时' : 'Schedule cleared',
                  )
                }
              >
                <Trash2 size={11} />
              </button>
            </div>
          </div>

          <div className="sched-bar-meta">
            {nextLabel && (
              <span>
                {tr(locale, 'nextRunAt')}: {nextLabel}
              </span>
            )}
            <span>
              {locale === 'zh' ? '已执行' : 'Runs'} {sched.runCount}
              {sched.maxRuns ? `/${sched.maxRuns}` : ''}
              {locale === 'zh' ? ' 次' : ''}
            </span>
            {sched.skippedReason === 'awaiting-review' && (
              <span className="badge badge-warn">{tr(locale, 'awaitingReviewHold')}</span>
            )}
            {missed && (
              <span className="row-wrap">
                <span className="badge badge-warn">
                  {locale === 'zh'
                    ? `错过 ${formatTimeShort(sched.missedSlotAt ?? sched.skippedAt ?? now, locale, now)}`
                    : `Missed ${formatTimeShort(sched.missedSlotAt ?? sched.skippedAt ?? now, locale, now)}`}
                </span>
                <button
                  type="button"
                  className="btn btn-xs btn-primary"
                  disabled={busy}
                  onClick={() =>
                    void onRunAction(
                      () => boardApi.catchUpSchedule(task.id, 'run'),
                      locale === 'zh' ? '已立即补跑' : 'Caught up schedule',
                    )
                  }
                >
                  <Play size={10} />
                  <span>{tr(locale, 'catchUpRun')}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-xs"
                  disabled={busy}
                  onClick={() =>
                    void onRunAction(
                      () => boardApi.catchUpSchedule(task.id, 'skip'),
                      locale === 'zh' ? '已跳过本次补跑' : 'Dismissed missed slot',
                    )
                  }
                >
                  {tr(locale, 'skipOnce')}
                </button>
              </span>
            )}
          </div>
        </>
      )}

      {task.reminderAt !== undefined && (
        <div className="sched-bar-head" style={sched ? { borderTop: '1px solid var(--agy-border)', paddingTop: 6 } : undefined}>
          <span className="sched-bar-meta">
            <Bell size={12} />
            <span>
              {locale === 'zh' ? '一次性提醒：' : 'Reminder: '}
              {formatTimeShort(task.reminderAt, locale, now)}
            </span>
          </span>
          <div className="sched-bar-actions">
            {!sched && (
              <button
                type="button"
                className="btn btn-xs"
                disabled={busy}
                onClick={() => setEditing((v) => !v)}
              >
                <Clock size={12} />
                <span>{tr(locale, 'addSchedule')}</span>
              </button>
            )}
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              disabled={busy}
              onClick={() =>
                void onRunAction(
                  () => boardApi.setReminder(task.id, null),
                  locale === 'zh' ? '已清除提醒' : 'Reminder cleared',
                )
              }
            >
              {locale === 'zh' ? '清除提醒' : 'Clear Reminder'}
            </button>
          </div>
        </div>
      )}

      {editing && (
        <ScheduleComposer
          locale={locale}
          embedded
          initialRule={sched}
          defaultTimeZone={defaultTimeZone}
          task={task}
          sessionDefaultPermission={sessionDefaultPermission}
          busy={busy}
          onConfirmPermission={() => onRunAction(() => boardApi.confirmPermission(task.id), 'Permission confirmed')}
          onSave={async (patch: ScheduleMutationPatch) => {
            await onRunAction(
              () => boardApi.setSchedule(task.id, patch),
              locale === 'zh' ? '定时计划已保存' : 'Schedule saved',
            )
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </div>
  )
}

export function ScheduleMicroBadge({
  task,
  locale,
  now,
}: {
  task: Pick<TaskRecord, 'phase' | 'schedule' | 'reminderAt' | 'remindedAt'>
  locale: Locale
  now: number
}) {
  if (task.phase === 'closed') return null
  const sched = task.schedule

  if (sched) {
    if (isMissedSchedule(sched)) {
      const ts = sched.missedSlotAt ?? sched.skippedAt ?? now
      const d = new Date(ts)
      const hhmm = formatClockHHMM(d.getHours(), d.getMinutes())
      return (
        <span className="sched-micro-badge is-warn" data-testid="schedule-micro-badge">
          {locale === 'zh' ? `错过 ${hhmm}` : `Missed ${hhmm}`}
        </span>
      )
    }
    if (sched.skippedReason === 'awaiting-review') {
      return (
        <span className="sched-micro-badge is-warn" data-testid="schedule-micro-badge">
          {tr(locale, 'awaitingReviewHold')}
        </span>
      )
    }
    if (!sched.enabled) {
      if (sched.endedReason === 'fired' || sched.endedReason === 'limit') return null
      return (
        <span className="sched-micro-badge is-paused" data-testid="schedule-micro-badge">
          ○ {tr(locale, 'schedulePaused')}
        </span>
      )
    }
    if (sched.mode === 'after_completion') {
      const days = sched.intervalDays ?? 1
      return (
        <span className="sched-micro-badge is-active" data-testid="schedule-micro-badge">
          ↻ {locale === 'zh' ? `验收后+${days}天` : `Review+${days}d`}
        </span>
      )
    }
    if (sched.mode === 'cron' && sched.nextRunAt !== undefined) {
      return (
        <span className="sched-micro-badge is-active" data-testid="schedule-micro-badge">
          ↻ {formatTimeShort(sched.nextRunAt, locale, now)}
        </span>
      )
    }
    if (sched.mode === 'once' && (sched.nextRunAt ?? sched.at) !== undefined) {
      const target = (sched.nextRunAt ?? sched.at)!
      const d = new Date(target)
      return (
        <span className="sched-micro-badge is-active" data-testid="schedule-micro-badge">
          ⏰ {formatClockHHMM(d.getHours(), d.getMinutes())}
        </span>
      )
    }
  }

  if (task.reminderAt !== undefined && (task.remindedAt === undefined || task.remindedAt < task.reminderAt)) {
    const d = new Date(task.reminderAt)
    return (
      <span className="sched-micro-badge" data-testid="schedule-micro-badge">
        ⏰ {formatClockHHMM(d.getHours(), d.getMinutes())}
      </span>
    )
  }

  return null
}

export interface ScheduleAlertBannerProps {
  locale: Locale
  now: number
  dueReminders: TaskRecord[]
  missedSchedules: TaskRecord[]
  onOpenTask: (taskId: string) => void
  onStartSession: (task: TaskRecord) => void
  onSnoozeReminder: (task: TaskRecord) => void
  onAckReminder: (task: TaskRecord) => void
  onCatchUpRun: (taskId: string) => void
  onCatchUpSkip: (taskId: string) => void
}

export function ScheduleAlertBanner({
  locale,
  now,
  dueReminders,
  missedSchedules,
  onOpenTask,
  onStartSession,
  onSnoozeReminder,
  onAckReminder,
  onCatchUpRun,
  onCatchUpSkip,
}: ScheduleAlertBannerProps) {
  if (dueReminders.length === 0 && missedSchedules.length === 0) return null

  return (
    <div className="sched-alert-banner" data-testid="schedule-alert-banner">
      {dueReminders.length > 0 && (
        <div className="sched-alert-row">
          <div className="sched-alert-items">
            <Bell size={13} />
            <span>
              {dueReminders.length} {tr(locale, 'dueReminders')}
            </span>
            {dueReminders.slice(0, 3).map((t) => (
              <span key={t.id} className="sched-alert-item">
                <button
                  type="button"
                  className="btn btn-xs"
                  onClick={() => onOpenTask(t.id)}
                >
                  {t.title.slice(0, 24)}
                </button>
                <button
                  type="button"
                  className="btn btn-xs btn-primary"
                  onClick={() => onStartSession(t)}
                >
                  {tr(locale, 'startSession')}
                </button>
                <button
                  type="button"
                  className="btn btn-xs btn-ghost"
                  onClick={() => onSnoozeReminder(t)}
                >
                  {tr(locale, 'snooze1h')}
                </button>
                <button
                  type="button"
                  className="btn btn-xs btn-ghost"
                  onClick={() => onAckReminder(t)}
                >
                  {tr(locale, 'ackDismiss')}
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {missedSchedules.length > 0 && (
        <div className="sched-alert-row">
          <div className="sched-alert-items">
            <AlertTriangle size={13} />
            <span>
              {missedSchedules.length} {tr(locale, 'missedSchedules')}
            </span>
            {missedSchedules.slice(0, 3).map((t) => {
              const missedAt = t.schedule?.missedSlotAt ?? t.schedule?.skippedAt ?? now
              return (
                <span key={t.id} className="sched-alert-item">
                  <button
                    type="button"
                    className="btn btn-xs"
                    onClick={() => onOpenTask(t.id)}
                  >
                    {t.title.slice(0, 22)} · {formatTimeShort(missedAt, locale, now)}
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs btn-primary"
                    onClick={() => onCatchUpRun(t.id)}
                  >
                    <Play size={10} />
                    <span>{tr(locale, 'catchUpRun')}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    onClick={() => onCatchUpSkip(t.id)}
                  >
                    {tr(locale, 'skipOnce')}
                  </button>
                </span>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
