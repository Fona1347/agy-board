/**
 * Freeze-request parser and security gate:
 * - Parses `<<<FREEZE ... >>>FREEZE` blocks (supports Chinese or English headers)
 * - Sanitizes structured FreezeSnapshot objects
 * - Redacts sensitive tokens/keys to `[REDACTED]`
 * - Rejects lines starting with `/` (slash-command injection protection)
 * - Enforces 8 KiB UTF-8 byte cap per field
 */
import type { FreezeSnapshot } from './types.ts'

export const FREEZE_FIELD_BYTE_LIMIT = 8 * 1024
export const REDACTED_MARKER = '[REDACTED]'

export type FreezeWarning = 'redacted'

export type FreezeResult =
  | { ok: true; snapshot: FreezeSnapshot; warnings: FreezeWarning[] }
  | { ok: false; error: { code: string; message: string } }

const BEGIN = '<<<FREEZE'
const END = '>>>FREEZE'

type SectionKey = 'goal' | 'progress' | 'next'
const SECTION_ORDER: readonly SectionKey[] = ['goal', 'progress', 'next']

const SECTION_KEYS: ReadonlyMap<string, SectionKey> = new Map([
  ['目标:', 'goal'],
  ['目标：', 'goal'],
  ['Goal:', 'goal'],
  ['goal:', 'goal'],
  ['进度:', 'progress'],
  ['进度：', 'progress'],
  ['Progress:', 'progress'],
  ['progress:', 'progress'],
  ['下一步:', 'next'],
  ['下一步：', 'next'],
  ['Next:', 'next'],
  ['next:', 'next'],
])

const SECTION_NAMES: Record<SectionKey, string> = {
  goal: 'goal',
  progress: 'progress',
  next: 'next',
}

const SENSITIVE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /Bearer\s+[A-Za-z0-9._~+/=:-]{8,}/gi,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /glpat-[A-Za-z0-9_-]{15,}/g,
  /xox[bpars]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
]

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

export function redactSensitive(text: string): { text: string; redacted: boolean } {
  let out = text
  let redacted = false
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(out)) {
      redacted = true
      pattern.lastIndex = 0
      out = out.replace(pattern, REDACTED_MARKER)
    }
    pattern.lastIndex = 0
  }
  return { text: out, redacted }
}

export function hasSlashCommandLines(text: string): boolean {
  return text.split(/\r?\n/).some((line) => /^[ \t]*\//.test(line))
}

export function sanitizeFreezeSnapshot(
  value: unknown,
  extraKeys: readonly string[] = [],
):
  | { ok: true; snapshot: FreezeSnapshot; redacted: boolean; extras: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } } {
  const bad = (code: string, message: string) => ({ ok: false as const, error: { code, message } })
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return bad('invalid-freeze', 'Freeze snapshot must be an object with goal, progress, and next strings.')
  }
  const record = value as Record<string, unknown>
  const allowed = new Set(['goal', 'progress', 'next', ...extraKeys])
  if (!Object.keys(record).every((key) => allowed.has(key))) {
    return bad('invalid-freeze', 'Freeze snapshot contains unsupported fields.')
  }
  for (const key of SECTION_ORDER) {
    if (typeof record[key] !== 'string') {
      return bad('invalid-freeze', `Freeze snapshot field '${SECTION_NAMES[key]}' must be a string.`)
    }
  }
  for (const key of SECTION_ORDER) {
    if (hasSlashCommandLines(record[key] as string)) {
      return bad('slash-command-line', `Freeze field '${SECTION_NAMES[key]}' contains a line starting with '/', rejected for safety.`)
    }
  }
  let redacted = false
  const snapshot: Record<SectionKey, string> = { goal: '', progress: '', next: '' }
  for (const key of SECTION_ORDER) {
    const res = redactSensitive(record[key] as string)
    snapshot[key] = res.text
    redacted = redacted || res.redacted
  }
  for (const key of SECTION_ORDER) {
    if (utf8Bytes(snapshot[key]) > FREEZE_FIELD_BYTE_LIMIT) {
      return bad('field-too-large', `Freeze snapshot field '${SECTION_NAMES[key]}' exceeds 8 KiB UTF-8 limit.`)
    }
  }
  const extras: Record<string, unknown> = {}
  for (const key of extraKeys) {
    if (key in record) extras[key] = record[key]
  }
  return {
    ok: true,
    snapshot: { goal: snapshot.goal, progress: snapshot.progress, next: snapshot.next },
    redacted,
    extras,
  }
}

const SECTION_HEADER_RE = /^(目标[:：]|Goal:|goal:|进度[:：]|Progress:|progress:|下一步[:：]|Next:|next:)\s*(.*)$/

export function parseFreezeRequest(input: string): FreezeResult {
  const beginIndex = input.indexOf(BEGIN)
  if (beginIndex === -1) {
    return { ok: false, error: { code: 'missing-block', message: 'Missing <<<FREEZE ... >>>FREEZE block.' } }
  }
  const bodyStart = beginIndex + BEGIN.length
  const endIndex = input.indexOf(END, bodyStart)
  if (endIndex === -1) {
    return { ok: false, error: { code: 'unterminated-block', message: 'Unterminated freeze block (missing >>>FREEZE).' } }
  }
  const block = input.slice(bodyStart, endIndex)
  const raw = new Map<SectionKey, string[]>()
  let current: SectionKey | undefined
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim()
    const match = trimmed.match(SECTION_HEADER_RE)
    const key = match ? SECTION_KEYS.get(match[1]) : undefined
    if (key !== undefined) {
      if (raw.has(key)) {
        return { ok: false, error: { code: 'duplicate-section', message: `Duplicate freeze section '${key}'.` } }
      }
      const bucket: string[] = []
      if (match && match[2]) bucket.push(match[2])
      raw.set(key, bucket)
      current = key
    } else if (current !== undefined) {
      raw.get(current)!.push(line)
    }
  }

  const candidate: Record<SectionKey, string> = { goal: '', progress: '', next: '' }
  for (const key of SECTION_ORDER) {
    if (!raw.has(key)) {
      return { ok: false, error: { code: 'missing-section', message: `Missing freeze section '${key}'.` } }
    }
    const lines = raw.get(key)!
    while (lines.length > 0 && lines[0].trim() === '') lines.shift()
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    candidate[key] = lines.join('\n')
  }

  const sanitized = sanitizeFreezeSnapshot(candidate)
  if (!sanitized.ok) return sanitized
  return {
    ok: true,
    snapshot: sanitized.snapshot,
    warnings: sanitized.redacted ? ['redacted'] : [],
  }
}
