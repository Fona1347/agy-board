import { createRequire as __agyCreateRequire } from 'node:module'; const require = __agyCreateRequire(import.meta.url);

// src/entry/hook.ts
import { existsSync as existsSync9, realpathSync as realpathSync3 } from "node:fs";
import { resolve as resolve6 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/core/types.ts
var TASK_PERMISSIONS = ["read-only", "workspace-write", "danger-full-access"];
function isTaskPermission(value) {
  return typeof value === "string" && TASK_PERMISSIONS.includes(value);
}
var TASK_PHASES = ["needs_you", "active", "on_hold", "todo", "closed"];
function isTaskPhase(value) {
  return typeof value === "string" && TASK_PHASES.includes(value);
}
var TASK_PRIORITIES = ["urgent", "high", "normal", "low"];
function isTaskPriority(value) {
  return typeof value === "string" && TASK_PRIORITIES.includes(value);
}
var TASK_TAG_LIMIT = 8;
var TAG_NAME_MAX_LENGTH = 32;
var TAG_PROMPT_MAX_LENGTH = 200;
function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of value) {
    if (typeof item === "string") {
      const name = item.trim();
      if (!name || name.length > TAG_NAME_MAX_LENGTH || seen.has(name)) continue;
      seen.add(name);
      result.push({ name });
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const rec = item;
      if (typeof rec.name !== "string") continue;
      const name = rec.name.trim();
      if (!name || name.length > TAG_NAME_MAX_LENGTH || seen.has(name)) continue;
      const rawPrefix = typeof rec.promptPrefix === "string" ? rec.promptPrefix.trim() : "";
      const promptPrefix = rawPrefix ? rawPrefix.slice(0, TAG_PROMPT_MAX_LENGTH) : void 0;
      seen.add(name);
      result.push(promptPrefix ? { name, promptPrefix } : { name });
    }
    if (result.length >= TASK_TAG_LIMIT) break;
  }
  return result;
}
var DEFAULT_SUBPHASE_FOR_PHASE = {
  needs_you: "review",
  active: "running",
  on_hold: "paused",
  todo: "ready",
  closed: "done"
};
function reconcilePhaseStatus(phase, subPhase) {
  const validSubPhases = {
    needs_you: ["review", "blocked", "needs_input", "permission_pending", "reminder_due"],
    active: ["running", "working"],
    on_hold: ["paused", "waiting"],
    todo: ["draft", "ready", "backlog"],
    closed: ["done", "cancelled"]
  };
  const resolvedSub = subPhase && validSubPhases[phase].includes(subPhase) ? subPhase : DEFAULT_SUBPHASE_FOR_PHASE[phase];
  let status;
  if (phase === "todo") status = "pending";
  else if (phase === "closed") status = resolvedSub === "cancelled" ? "cancelled" : "done";
  else status = "in_progress";
  return { phase, subPhase: resolvedSub, status };
}
function hasOpenExecution(task) {
  return task.executions.some((e) => e.endedAt === void 0);
}
function isRecurringSchedule(schedule) {
  return Boolean(schedule && (schedule.mode === "cron" || schedule.mode === "after_completion"));
}
function isTaskContentFrozen(task) {
  return hasOpenExecution(task);
}

// src/core/freeze.ts
var FREEZE_FIELD_BYTE_LIMIT = 8 * 1024;
var REDACTED_MARKER = "[REDACTED]";
var BEGIN = "<<<FREEZE";
var END = ">>>FREEZE";
var SECTION_ORDER = ["goal", "progress", "next"];
var SECTION_KEYS = /* @__PURE__ */ new Map([
  ["\u76EE\u6807:", "goal"],
  ["\u76EE\u6807\uFF1A", "goal"],
  ["Goal:", "goal"],
  ["goal:", "goal"],
  ["\u8FDB\u5EA6:", "progress"],
  ["\u8FDB\u5EA6\uFF1A", "progress"],
  ["Progress:", "progress"],
  ["progress:", "progress"],
  ["\u4E0B\u4E00\u6B65:", "next"],
  ["\u4E0B\u4E00\u6B65\uFF1A", "next"],
  ["Next:", "next"],
  ["next:", "next"]
]);
var SECTION_NAMES = {
  goal: "goal",
  progress: "progress",
  next: "next"
};
var SENSITIVE_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /Bearer\s+[A-Za-z0-9._~+/=:-]{8,}/gi,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /glpat-[A-Za-z0-9_-]{15,}/g,
  /xox[bpars]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{20,}/g
];
function utf8Bytes(text) {
  return new TextEncoder().encode(text).length;
}
function redactSensitive(text) {
  let out = text;
  let redacted = false;
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(out)) {
      redacted = true;
      pattern.lastIndex = 0;
      out = out.replace(pattern, REDACTED_MARKER);
    }
    pattern.lastIndex = 0;
  }
  return { text: out, redacted };
}
function hasSlashCommandLines(text) {
  return text.split(/\r?\n/).some((line) => /^[ \t]*\//.test(line));
}
function sanitizeFreezeSnapshot(value, extraKeys = []) {
  const bad = (code, message) => ({ ok: false, error: { code, message } });
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return bad("invalid-freeze", "Freeze snapshot must be an object with goal, progress, and next strings.");
  }
  const record = value;
  const allowed = /* @__PURE__ */ new Set(["goal", "progress", "next", ...extraKeys]);
  if (!Object.keys(record).every((key) => allowed.has(key))) {
    return bad("invalid-freeze", "Freeze snapshot contains unsupported fields.");
  }
  for (const key of SECTION_ORDER) {
    if (typeof record[key] !== "string") {
      return bad("invalid-freeze", `Freeze snapshot field '${SECTION_NAMES[key]}' must be a string.`);
    }
  }
  for (const key of SECTION_ORDER) {
    if (hasSlashCommandLines(record[key])) {
      return bad("slash-command-line", `Freeze field '${SECTION_NAMES[key]}' contains a line starting with '/', rejected for safety.`);
    }
  }
  let redacted = false;
  const snapshot = { goal: "", progress: "", next: "" };
  for (const key of SECTION_ORDER) {
    const res = redactSensitive(record[key]);
    snapshot[key] = res.text;
    redacted = redacted || res.redacted;
  }
  for (const key of SECTION_ORDER) {
    if (utf8Bytes(snapshot[key]) > FREEZE_FIELD_BYTE_LIMIT) {
      return bad("field-too-large", `Freeze snapshot field '${SECTION_NAMES[key]}' exceeds 8 KiB UTF-8 limit.`);
    }
  }
  const extras = {};
  for (const key of extraKeys) {
    if (key in record) extras[key] = record[key];
  }
  return {
    ok: true,
    snapshot: { goal: snapshot.goal, progress: snapshot.progress, next: snapshot.next },
    redacted,
    extras
  };
}
var SECTION_HEADER_RE = /^(目标[:：]|Goal:|goal:|进度[:：]|Progress:|progress:|下一步[:：]|Next:|next:)\s*(.*)$/;
function parseFreezeRequest(input) {
  const beginIndex = input.indexOf(BEGIN);
  if (beginIndex === -1) {
    return { ok: false, error: { code: "missing-block", message: "Missing <<<FREEZE ... >>>FREEZE block." } };
  }
  const bodyStart = beginIndex + BEGIN.length;
  const endIndex = input.indexOf(END, bodyStart);
  if (endIndex === -1) {
    return { ok: false, error: { code: "unterminated-block", message: "Unterminated freeze block (missing >>>FREEZE)." } };
  }
  const block = input.slice(bodyStart, endIndex);
  const raw = /* @__PURE__ */ new Map();
  let current;
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = trimmed.match(SECTION_HEADER_RE);
    const key = match ? SECTION_KEYS.get(match[1]) : void 0;
    if (key !== void 0) {
      if (raw.has(key)) {
        return { ok: false, error: { code: "duplicate-section", message: `Duplicate freeze section '${key}'.` } };
      }
      const bucket = [];
      if (match && match[2]) bucket.push(match[2]);
      raw.set(key, bucket);
      current = key;
    } else if (current !== void 0) {
      raw.get(current).push(line);
    }
  }
  const candidate = { goal: "", progress: "", next: "" };
  for (const key of SECTION_ORDER) {
    if (!raw.has(key)) {
      return { ok: false, error: { code: "missing-section", message: `Missing freeze section '${key}'.` } };
    }
    const lines = raw.get(key);
    while (lines.length > 0 && lines[0].trim() === "") lines.shift();
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    candidate[key] = lines.join("\n");
  }
  const sanitized = sanitizeFreezeSnapshot(candidate);
  if (!sanitized.ok) return sanitized;
  return {
    ok: true,
    snapshot: sanitized.snapshot,
    warnings: sanitized.redacted ? ["redacted"] : []
  };
}

// src/core/handover.ts
var HANDOVER_MAX_REFERENCES = 32;
var HANDOVER_MAX_REFERENCE_BYTES = 512;
var HANDOVER_MAX_TOTAL_BYTES = 8 * 1024;
var HANDOVER_MAX_TARGET_BYTES = 256;
var DEFAULT_SESSION_PERMISSION = "read-only";
var PERMISSION_RANK = /* @__PURE__ */ new Map([
  ["read-only", 0],
  ["workspace-write", 1],
  ["danger-full-access", 2]
]);
function byteLength(value) {
  return new TextEncoder().encode(value).length;
}
function sanitizeHandover(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
  const bundle = value;
  const keys = Object.keys(bundle);
  if (!keys.every((key) => ["workspaceId", "mode", "permission", "references", "bundledAt"].includes(key))) {
    return void 0;
  }
  const refs = bundle.references ?? [];
  if (!Array.isArray(refs) || refs.length > HANDOVER_MAX_REFERENCES) return void 0;
  let total = 0;
  const cleanRefs = [];
  for (const reference of refs) {
    if (typeof reference !== "string") return void 0;
    const trimmed = reference.trim();
    if (trimmed === "") continue;
    const size = byteLength(trimmed);
    if (size > HANDOVER_MAX_REFERENCE_BYTES) return void 0;
    total += size;
    if (total > HANDOVER_MAX_TOTAL_BYTES) return void 0;
    cleanRefs.push(trimmed);
  }
  for (const key of ["workspaceId", "mode"]) {
    const target = bundle[key];
    if (target !== void 0 && (typeof target !== "string" || byteLength(target) > HANDOVER_MAX_TARGET_BYTES)) {
      return void 0;
    }
  }
  if (bundle.permission !== void 0 && !isTaskPermission(bundle.permission)) return void 0;
  return {
    ...typeof bundle.workspaceId === "string" && bundle.workspaceId.trim() ? { workspaceId: bundle.workspaceId.trim() } : {},
    ...typeof bundle.mode === "string" && bundle.mode.trim() ? { mode: bundle.mode.trim() } : {},
    ...bundle.permission === void 0 ? {} : { permission: bundle.permission },
    references: cleanRefs
  };
}
function handoverOf(input, now) {
  return { ...input, bundledAt: now };
}
function effectivePermission(task) {
  return task.handover?.permission ?? task.permission;
}
function exceedsSessionDefault(permission, sessionDefault = DEFAULT_SESSION_PERMISSION) {
  if (permission === void 0) return false;
  return (PERMISSION_RANK.get(permission) ?? -1) > (PERMISSION_RANK.get(sessionDefault) ?? -1);
}
function requiresPermissionConfirmation(task, sessionDefault = DEFAULT_SESSION_PERMISSION) {
  return exceedsSessionDefault(effectivePermission(task), sessionDefault) && task.permissionConfirmedAt === void 0;
}

// src/core/schedule.ts
var FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7]
];
var HOST_TIME_ZONE_FALLBACK = "UTC";
var IANA_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/;
var FORMATTERS = /* @__PURE__ */ new Map();
function zoneFormatter(timeZone) {
  let formatter = FORMATTERS.get(timeZone);
  if (formatter === void 0) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
    FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}
function partsInZone(timeZone, epochMs) {
  const fields = {};
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") fields[part.type] = part.value;
  }
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour),
    minute: Number(fields.minute)
  };
}
function offsetAt(timeZone, epochMs) {
  const parts = partsInZone(timeZone, epochMs);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - epochMs;
}
function zonedEpoch(timeZone, year, month, day, hour, minute) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = /* @__PURE__ */ new Set([
    offsetAt(timeZone, naive - 864e5),
    offsetAt(timeZone, naive),
    offsetAt(timeZone, naive + 864e5)
  ]);
  let earliest;
  for (const offset of offsets) {
    const candidate = naive - offset;
    const parts = partsInZone(timeZone, candidate);
    if (parts.year !== year || parts.month !== month || parts.day !== day) continue;
    if (parts.hour !== hour || parts.minute !== minute) continue;
    if (earliest === void 0 || candidate < earliest) earliest = candidate;
  }
  return earliest;
}
function resolveHostTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone !== "" ? zone : HOST_TIME_ZONE_FALLBACK;
  } catch {
    return HOST_TIME_ZONE_FALLBACK;
  }
}
function isValidTimeZone(value) {
  if (value.trim() !== value || value === "") return false;
  if (value !== "UTC" && !IANA_ZONE.test(value)) return false;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone !== void 0;
  } catch {
    return false;
  }
}
function isDigits(value) {
  return /^\d+$/.test(value);
}
function parseField(field, min, max, out) {
  if (field === "*") {
    for (let value = min; value <= max; value++) out.add(value);
    return true;
  }
  for (const part of field.split(",")) {
    if (part === "") return false;
    const segments = part.split("/");
    if (segments.length > 2) return false;
    const [range, stepRaw] = segments;
    let low;
    let high;
    if (range === "*") {
      low = min;
      high = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      if (a === "" || b === "" || !isDigits(a) || !isDigits(b)) return false;
      low = Number(a);
      high = Number(b);
    } else if (isDigits(range)) {
      low = Number(range);
      high = stepRaw === void 0 ? low : max;
    } else {
      return false;
    }
    if (low < min || high > max || low > high) return false;
    const step = stepRaw === void 0 ? 1 : isDigits(stepRaw) ? Number(stepRaw) : NaN;
    if (!Number.isInteger(step) || step < 1) return false;
    for (let value = low; value <= high; value += step) out.add(value);
  }
  return true;
}
function parseCron(expr) {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets = [];
  for (let index = 0; index < 5; index++) {
    const [min, max] = FIELD_RANGES[index];
    const set = /* @__PURE__ */ new Set();
    if (!parseField(fields[index], min, max, set)) return null;
    sets.push(set);
  }
  const weekdays = /* @__PURE__ */ new Set();
  for (const day of sets[4]) weekdays.add(day === 7 ? 0 : day);
  return {
    minutes: sets[0],
    hours: sets[1],
    days: sets[2],
    months: sets[3],
    weekdays,
    dayStarred: fields[2].startsWith("*"),
    weekdayStarred: fields[4].startsWith("*")
  };
}
function isValidCron(expr) {
  return parseCron(expr) !== null;
}
function dayCandidate(schedule, year, month, day) {
  const dayMatches = schedule.days.has(day);
  const weekdayMatches = schedule.weekdays.has(new Date(Date.UTC(year, month - 1, day)).getUTCDay());
  if (!schedule.dayStarred && !schedule.weekdayStarred) return dayMatches || weekdayMatches;
  return dayMatches && weekdayMatches;
}
function hasPossibleCalendarDay(schedule) {
  if (schedule.dayStarred || !schedule.weekdayStarred) return true;
  const maximumDay = /* @__PURE__ */ new Map([
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
    [12, 31]
  ]);
  for (const month of schedule.months) {
    const maximum = maximumDay.get(month) ?? 0;
    if ([...schedule.days].some((day) => day <= maximum)) return true;
  }
  return false;
}
function nextRunAtMs(expr, fromMs, timeZone) {
  const schedule = parseCron(expr);
  if (schedule === null) return void 0;
  if (!hasPossibleCalendarDay(schedule)) return void 0;
  const zone = timeZone ?? resolveHostTimeZone();
  const start = partsInZone(zone, fromMs);
  const limitMs = fromMs + 5 * 366 * 24 * 60 * 60 * 1e3;
  const sortedMinutes = [...schedule.minutes].sort((a, b) => a - b);
  const sortedHours = [...schedule.hours].sort((a, b) => a - b);
  const sortedMonths = [...schedule.months].sort((a, b) => a - b);
  let year = start.year;
  let month = start.month;
  let day = start.day;
  let hour = start.hour;
  let minute = start.minute + 1;
  while (Date.UTC(year, month - 1, 1) <= limitMs + 864e5) {
    for (const candidateMonth of sortedMonths) {
      if (candidateMonth < month) continue;
      const daysInMonth = new Date(Date.UTC(year, candidateMonth, 0)).getUTCDate();
      const dayStart = candidateMonth === month ? day : 1;
      for (let candidateDay = dayStart; candidateDay <= daysInMonth; candidateDay += 1) {
        if (!dayCandidate(schedule, year, candidateMonth, candidateDay)) continue;
        const hourStart = candidateMonth === month && candidateDay === day ? hour : 0;
        for (const candidateHour of sortedHours) {
          if (candidateHour < hourStart) continue;
          const minuteStart = candidateMonth === month && candidateDay === day && candidateHour === hour ? minute : 0;
          for (const candidateMinute of sortedMinutes) {
            if (candidateMinute < minuteStart) continue;
            const time = zonedEpoch(zone, year, candidateMonth, candidateDay, candidateHour, candidateMinute);
            if (time === void 0) continue;
            if (time <= fromMs) continue;
            if (time > limitMs) return void 0;
            return time;
          }
        }
      }
    }
    year += 1;
    month = 1;
    day = 1;
    hour = 0;
    minute = 0;
  }
  return void 0;
}
function scheduleRunBudget(rule) {
  if (rule.mode === "once") return 1;
  return rule.maxRuns;
}
function scheduleExhausted(rule) {
  const budget = scheduleRunBudget(rule);
  return budget !== void 0 && rule.runCount >= budget;
}
function nextAfterCompletionAtMs(completedAtMs, intervalDays, timeZone, atHour, atMinute) {
  const days = Math.max(1, Math.trunc(intervalDays));
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : resolveHostTimeZone();
  const baseParts = partsInZone(zone, completedAtMs);
  const hour = atHour !== void 0 && Number.isInteger(atHour) ? Math.min(23, Math.max(0, atHour)) : baseParts.hour;
  const minute = atMinute !== void 0 && Number.isInteger(atMinute) ? Math.min(59, Math.max(0, atMinute)) : baseParts.minute;
  const resolveDayInstant = (dayOffset) => {
    const targetDate = new Date(Date.UTC(baseParts.year, baseParts.month - 1, baseParts.day + dayOffset));
    const year = targetDate.getUTCFullYear();
    const month = targetDate.getUTCMonth() + 1;
    const day = targetDate.getUTCDate();
    const direct = zonedEpoch(zone, year, month, day, hour, minute);
    if (direct !== void 0) return direct;
    for (let offsetMin = 1; offsetMin <= 180; offsetMin += 1) {
      const totalMin = hour * 60 + minute + offsetMin;
      const probeDate = new Date(Date.UTC(year, month - 1, day + Math.floor(totalMin / 1440)));
      const remMin = (totalMin % 1440 + 1440) % 1440;
      const resolved = zonedEpoch(
        zone,
        probeDate.getUTCFullYear(),
        probeDate.getUTCMonth() + 1,
        probeDate.getUTCDate(),
        Math.floor(remMin / 60),
        remMin % 60
      );
      if (resolved !== void 0) return resolved;
    }
    return Date.UTC(year, month - 1, day, hour, minute);
  };
  let candidate = resolveDayInstant(days);
  if (candidate <= completedAtMs) {
    candidate = resolveDayInstant(days + 1);
  }
  return candidate;
}

// src/core/subgoals.ts
function computeSubgoalRollup(subgoals) {
  let done = 0;
  let inProgress = 0;
  let open = 0;
  let skipped = 0;
  let requiredTotal = 0;
  let requiredDone = 0;
  for (const sg of subgoals) {
    if (sg.status === "done") done += 1;
    else if (sg.status === "in_progress") inProgress += 1;
    else if (sg.status === "skipped") skipped += 1;
    else open += 1;
    if (sg.required) {
      requiredTotal += 1;
      if (sg.status === "done") requiredDone += 1;
    }
  }
  const requiredRemaining = Math.max(0, requiredTotal - requiredDone);
  const allRequiredDone = requiredRemaining === 0;
  const readyForReview = requiredTotal > 0 && requiredRemaining === 0;
  return {
    total: subgoals.length,
    done,
    inProgress,
    open,
    skipped,
    requiredTotal,
    requiredDone,
    requiredRemaining,
    allRequiredDone,
    readyForReview
  };
}
function canCloseTaskWithSubgoals(subgoals, force = false) {
  if (force) return { allowed: true };
  const incompleteRequired = subgoals.filter((sg) => sg.required && sg.status !== "done");
  if (incompleteRequired.length === 0) return { allowed: true };
  return {
    allowed: false,
    reason: `Cannot close task while ${incompleteRequired.length} required subgoal(s) remain incomplete.`,
    remainingRequiredIds: incompleteRequired.map((sg) => sg.id)
  };
}
function checkSubgoalDependencies(subgoals) {
  const byId = new Map(subgoals.map((s) => [s.id, s]));
  for (const sg of subgoals) {
    for (const dep of sg.dependencies) {
      if (dep === sg.id) {
        return { ok: false, error: `Subgoal '${sg.id}' cannot depend on itself.` };
      }
      if (!byId.has(dep)) {
        return { ok: false, error: `Subgoal '${sg.id}' references unknown dependency '${dep}'.` };
      }
    }
  }
  const visiting = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  function dfs(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const node = byId.get(id);
    if (node) {
      for (const dep of node.dependencies) {
        if (dfs(dep)) return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  for (const sg of subgoals) {
    if (dfs(sg.id)) {
      return { ok: false, error: `Subgoal dependency cycle detected involving '${sg.id}'.` };
    }
  }
  return { ok: true };
}

// src/core/session-reuse.ts
function reusableSessionId(task, idleSessionIds, options = {}) {
  if (options.force !== true && task.reuseSession !== true) return void 0;
  if (idleSessionIds === void 0) return void 0;
  if (options.subgoalId) {
    const subLinks = task.conversations.filter((c) => c.subgoalId === options.subgoalId);
    for (let i = subLinks.length - 1; i >= 0; i -= 1) {
      if (idleSessionIds.has(subLinks[i].conversationId)) {
        return subLinks[i].conversationId;
      }
    }
  }
  let lastSettled;
  for (let index = task.executions.length - 1; index >= 0; index -= 1) {
    const candidate = task.executions[index];
    if (candidate.conversationId !== void 0 && candidate.endedAt !== void 0 && (!options.subgoalId || candidate.subgoalId === options.subgoalId)) {
      lastSettled = candidate;
      break;
    }
  }
  if (lastSettled?.conversationId && idleSessionIds.has(lastSettled.conversationId)) {
    return lastSettled.conversationId;
  }
  const primary = task.conversations.find((c) => c.role === "primary") ?? task.conversations[0];
  if (primary && idleSessionIds.has(primary.conversationId)) {
    return primary.conversationId;
  }
  return void 0;
}
function buildDispatchPrompt(task, options = {}) {
  const sections = [];
  const tagPrefixes = task.tags.map((tag) => tag.promptPrefix?.trim()).filter((v) => Boolean(v));
  if (tagPrefixes.length > 0) {
    sections.push(tagPrefixes.join("\n"));
  }
  const headerParts = [`# Task: ${task.title}`, `Task ID: ${task.id}`];
  if (task.workspacePath) headerParts.push(`Workspace: ${task.workspacePath}`);
  if (options.subgoal) {
    headerParts.push(`Scoped Subgoal (${options.subgoal.id}): ${options.subgoal.title}`);
  }
  sections.push(headerParts.join("\n"));
  if (task.description.trim()) {
    sections.push(`## Description
${task.description.trim()}`);
  }
  const provenance = [];
  if (task.originSummary?.trim()) provenance.push(`Why captured: ${task.originSummary.trim()}`);
  if (task.originConversationId) provenance.push(`Origin conversation: ${task.originConversationId}`);
  if (task.discoveredFromTaskId) provenance.push(`Discovered from task: ${task.discoveredFromTaskId}`);
  if (provenance.length > 0) {
    sections.push(`## Origin / Discovered From
${provenance.join("\n")}`);
  }
  const handoffConvs = task.conversations.filter((c) => c.includeInHandoff && c.summary?.trim());
  if (handoffConvs.length > 0) {
    const lines = handoffConvs.map((c) => `- (${c.role}) ${c.conversationId}: ${c.summary.trim()}`);
    sections.push(`## Handoff Conclusions (\u2605 included)
${lines.join("\n")}`);
  }
  const bodyPrompt = options.subgoal ? options.subgoal.detail.trim() || options.subgoal.title : task.prompt.trim() || task.title;
  sections.push(`## Execution Instruction
${bodyPrompt}`);
  if (task.nextAction?.trim()) {
    sections.push(`## Next Action
${task.nextAction.trim()}`);
  }
  if (task.blockedReason?.trim()) {
    sections.push(`## Blocked / Status Note
${task.blockedReason.trim()}`);
  }
  if (task.freeze) {
    sections.push(
      [
        "## Context Freeze Snapshot",
        `Goal: ${task.freeze.goal}`,
        `Progress: ${task.freeze.progress}`,
        `Next: ${task.freeze.next}`
      ].join("\n")
    );
  }
  if (task.subgoals.length > 0) {
    const lines = task.subgoals.map((sg) => {
      const mark = sg.status === "done" ? "x" : sg.status === "in_progress" ? "~" : sg.status === "skipped" ? "-" : " ";
      const req = sg.required ? " [required]" : " [optional]";
      return `- [${mark}] (${sg.id}) ${sg.title}${req}`;
    });
    sections.push(`## Subgoals
${lines.join("\n")}`);
  }
  const settledHistory = task.executions.filter((e) => e.endedAt !== void 0 && (e.summary?.trim() || e.error?.trim() || e.reworkInstructions?.trim())).slice(-5);
  if (settledHistory.length > 0) {
    const histLines = settledHistory.map((e, index) => {
      const parts = [`#${index + 1} (${e.result ?? "settled"})`];
      if (e.reworkInstructions?.trim()) parts.push(`Rework: ${e.reworkInstructions.trim()}`);
      if (e.summary?.trim()) parts.push(`Summary: ${e.summary.trim()}`);
      if (e.error?.trim()) parts.push(`Error: ${e.error.trim()}`);
      return `- ${parts.join(" | ")}`;
    });
    sections.push(`## Prior Executions
${histLines.join("\n")}`);
  }
  if (task.comments && task.comments.length > 0) {
    const recentComments = task.comments.slice(-5);
    const commentLines = recentComments.map((c) => `- [${c.author}] ${c.bodyMd.trim()}`);
    sections.push(`## Comments
${commentLines.join("\n")}`);
  }
  const refLines = [];
  for (const ref of task.refs) {
    refLines.push(`- [${ref.kind}] ${ref.target}${ref.label ? ` (${ref.label})` : ""}`);
  }
  for (const href of task.handover?.references ?? []) {
    if (!task.refs.some((r) => r.target === href)) {
      refLines.push(`- [handover] ${href}`);
    }
  }
  if (refLines.length > 0) {
    sections.push(`## Registered TaskSpace References
${refLines.join("\n")}`);
  }
  if (options.extraInstruction?.trim()) {
    sections.push(`## Additional Instructions
${options.extraInstruction.trim()}`);
  }
  return sections.join("\n\n");
}
function buildReworkPrompt(task, instructions, subgoal) {
  const lines = [
    `[Rework Request for Task ${task.id}: ${task.title}]`,
    ...task.worktreePath ? [
      `Worktree: ${task.worktreePath}${task.worktreeBranch ? ` (branch: ${task.worktreeBranch})` : ""}`
    ] : [],
    ...subgoal ? [`Subgoal (${subgoal.id}): ${subgoal.title}`] : [],
    "",
    instructions.trim()
  ];
  if (task.refs.length > 0) {
    lines.push("", "Registered references:");
    for (const ref of task.refs.slice(0, 12)) {
      lines.push(`- [${ref.kind}] ${ref.target}`);
    }
  }
  return lines.join("\n");
}

// src/core/workspace.ts
function normalizeFsPath(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let normalized = trimmed;
  if (normalized.toLowerCase().startsWith("file://")) {
    normalized = fileUriToPath(normalized);
  }
  const hasWindowsDrive = /^[A-Za-z]:[\\/]/.test(normalized) || /^[A-Za-z]:$/.test(normalized);
  if (hasWindowsDrive) {
    normalized = normalized.replace(/\//g, "\\");
    if (/^[a-z]:/.test(normalized)) {
      normalized = normalized[0].toUpperCase() + normalized.slice(1);
    }
    if (normalized.length > 3) {
      normalized = normalized.replace(/\\+$/, "");
    }
    return normalized;
  }
  normalized = normalized.replace(/\\+/g, "/");
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/, "");
  }
  return normalized;
}
function fileUriToPath(uri) {
  const trimmed = uri.trim();
  if (!trimmed.toLowerCase().startsWith("file://")) return trimmed;
  try {
    const parsed = new URL(trimmed);
    let pathname = decodeURIComponent(parsed.pathname);
    if (/^\/[A-Za-z]:/.test(pathname)) {
      pathname = pathname.slice(1);
      return pathname[0].toUpperCase() + pathname.slice(1).replace(/\//g, "\\");
    }
    if (parsed.hostname && parsed.hostname !== "localhost") {
      return `\\\\${parsed.hostname}${pathname.replace(/\//g, "\\")}`;
    }
    return pathname;
  } catch {
    return trimmed.replace(/^file:\/\//i, "");
  }
}
function pathComparisonKey(raw) {
  const norm = normalizeFsPath(raw);
  if (!norm) return "";
  const isWin = /^[A-Za-z]:/.test(norm) || norm.startsWith("\\\\");
  return isWin ? norm.replace(/\\/g, "/").toLowerCase() : norm;
}
function isPathEqualOrInside(candidateRaw, parentRaw) {
  const candidate = pathComparisonKey(candidateRaw);
  const parent = pathComparisonKey(parentRaw);
  if (!candidate || !parent) return false;
  if (candidate === parent) return true;
  const prefix = parent.endsWith("/") ? parent : `${parent}/`;
  return candidate.startsWith(prefix);
}
function matchWorkspaceForPath(targetPath, workspaces) {
  const targetKey = pathComparisonKey(targetPath);
  if (!targetKey) return void 0;
  let best;
  let bestScore = -1;
  for (const ws of workspaces) {
    const candidates = [ws.rootPath, ...ws.folderPaths].filter(Boolean);
    for (const candidate of candidates) {
      if (!isPathEqualOrInside(targetPath, candidate)) continue;
      const score = pathComparisonKey(candidate).length + (ws.source === "custom" ? 0.5 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = ws;
      }
    }
  }
  return best;
}
function matchProjectIdForWorkspace(workspaceId, workspacePath, workspaces) {
  if (workspaceId) {
    const exact = workspaces.find((w) => w.id === workspaceId || w.antigravityProjectId === workspaceId);
    if (exact?.antigravityProjectId) return exact.antigravityProjectId;
    if (exact?.source === "antigravity") return exact.id;
  }
  if (workspacePath) {
    const matched = matchWorkspaceForPath(workspacePath, workspaces);
    if (matched?.antigravityProjectId) return matched.antigravityProjectId;
    if (matched?.source === "antigravity") return matched.id;
  }
  return void 0;
}

// src/host/paths.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
function deriveAppDataDirFromEnv(envVar, expectedAncestor) {
  if (!envVar || envVar.includes("${")) return void 0;
  let cur = resolve(envVar);
  for (let i = 0; i < 6; i += 1) {
    const parent = dirname(cur);
    if (basename(cur) === expectedAncestor) {
      return parent;
    }
    if (parent === cur) break;
    cur = parent;
  }
  return void 0;
}
function resolveDevToolsPortFileCandidates(home = homedir()) {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    return [
      join(appData, "Antigravity", "DevToolsActivePort"),
      join(appData, "antigravity", "DevToolsActivePort"),
      join(appData, "Antigravity IDE", "DevToolsActivePort")
    ];
  }
  if (process.platform === "darwin") {
    const appSupport = join(home, "Library", "Application Support");
    return [
      join(appSupport, "Antigravity", "DevToolsActivePort"),
      join(appSupport, "antigravity", "DevToolsActivePort"),
      join(appSupport, "Antigravity IDE", "DevToolsActivePort")
    ];
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");
  return [
    join(xdgConfig, "antigravity", "DevToolsActivePort"),
    join(xdgConfig, "Antigravity", "DevToolsActivePort"),
    join(xdgConfig, "Antigravity IDE", "DevToolsActivePort")
  ];
}
function resolveHostPaths(overrides = {}) {
  const home = homedir();
  const geminiConfigDir = resolve(
    overrides.geminiConfigDir ?? process.env.AGY_BOARD_GEMINI_CONFIG_DIR ?? process.env.ANTIGRAVITY_CONFIG_DIR ?? join(home, ".gemini", "config")
  );
  const rawPluginData = [process.env.PLUGIN_DATA, process.env.AGY_BOARD_PLUGIN_DATA].find(
    (v) => typeof v === "string" && v.trim() !== "" && !v.includes("${")
  );
  let antigravityDataDir = overrides.antigravityDataDir ?? process.env.AGY_BOARD_ANTIGRAVITY_DATA_DIR;
  if (!antigravityDataDir) {
    antigravityDataDir = deriveAppDataDirFromEnv(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR, "sidecar_data");
  }
  if (!antigravityDataDir && rawPluginData) {
    const candidate = deriveAppDataDirFromEnv(rawPluginData, "plugin_data");
    if (candidate && (existsSync(join(candidate, "brain")) || existsSync(join(candidate, "conversation_summaries.db")))) {
      antigravityDataDir = candidate;
    }
  }
  if (!antigravityDataDir) {
    const defaultCandidates = ["antigravity", "antigravity-ide", "antigravity-cli"].map(
      (p) => join(home, ".gemini", p)
    );
    antigravityDataDir = defaultCandidates.find(
      (c) => existsSync(join(c, "conversation_summaries.db")) || existsSync(join(c, "brain"))
    ) ?? defaultCandidates[0];
  }
  antigravityDataDir = resolve(antigravityDataDir);
  const explicitDataDir = process.env.AGY_BOARD_DATA_DIR;
  const dbPath = resolve(
    overrides.dbPath ?? process.env.AGY_BOARD_DB_PATH ?? (explicitDataDir ? join(explicitDataDir, "board.db") : join(antigravityDataDir, "agy-board", "board.db"))
  );
  const devToolsCandidates = resolveDevToolsPortFileCandidates(home);
  const detectedPortFile = devToolsCandidates.find((p) => existsSync(p)) ?? devToolsCandidates[0];
  const devToolsActivePortFile = resolve(
    overrides.devToolsActivePortFile ?? process.env.AGY_BOARD_DEVTOOLS_PORT_FILE ?? detectedPortFile
  );
  const summariesDbPath = join(antigravityDataDir, "conversation_summaries.db");
  return {
    dbPath,
    boardDir: dirname(dbPath),
    geminiConfigDir,
    antigravityDataDir,
    brainDir: join(antigravityDataDir, "brain"),
    daemonDir: join(antigravityDataDir, "daemon"),
    projectsDir: join(geminiConfigDir, "projects"),
    conversationSummariesDb: summariesDbPath,
    summariesDbPath,
    devToolsActivePortFile,
    ...rawPluginData ? { pluginDataDir: resolve(rawPluginData) } : {}
  };
}
function readHostThemeMode(geminiConfigDir) {
  try {
    const cfgFile = join(geminiConfigDir, "config.json");
    if (!existsSync(cfgFile)) return void 0;
    const raw = readFileSync(cfgFile, "utf8").replace(/^\uFEFF/, "");
    if (raw.length > 1024 * 1024) return void 0;
    const parsed = JSON.parse(raw);
    const mode = parsed?.userSettings?.themeMode;
    if (mode === "THEME_MODE_LIGHT" || mode === "light") return "light";
    if (mode === "THEME_MODE_DARK" || mode === "dark") return "dark";
    if (mode === "THEME_MODE_SYSTEM" || mode === "THEME_MODE_INHERIT" || mode === "THEME_MODE_UNSPECIFIED" || mode === "system" || mode === "inherit") {
      return "system";
    }
  } catch {
  }
  return void 0;
}

// src/host/db.ts
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, unlinkSync } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
import { DatabaseSync } from "node:sqlite";
var MIGRATIONS = [
  {
    version: 1,
    name: "0001_init_board",
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
    `
  },
  {
    version: 2,
    name: "0002_comments_worktree_subgoal_pk",
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
    `
  },
  {
    version: 3,
    name: "0003_user_marks_focus_snooze",
    sql: `
      ALTER TABLE task_user_marks ADD COLUMN pinned_at INTEGER;
      ALTER TABLE task_user_marks ADD COLUMN snoozed_until INTEGER;
    `
  },
  {
    // P0-1 draft/origin provenance + P0-2 handoff capsule columns.
    version: 4,
    name: "0004_draft_origin_handoff_capsule",
    sql: `
      ALTER TABLE tasks ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE tasks ADD COLUMN origin_conversation_id TEXT;
      ALTER TABLE tasks ADD COLUMN origin_summary TEXT;
      ALTER TABLE tasks ADD COLUMN discovered_from_task_id TEXT;
      ALTER TABLE task_conversations ADD COLUMN summary TEXT;
      ALTER TABLE task_conversations ADD COLUMN include_in_handoff INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS tasks_discovered_from_idx ON tasks(discovered_from_task_id);
      CREATE INDEX IF NOT EXISTS task_conversations_handoff_idx ON task_conversations(task_id, include_in_handoff);
    `
  }
];
function parseJsonSafe(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}
var BoardDatabase = class {
  db;
  dbPath;
  constructor(dbPath, options = {}) {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") {
      mkdirSync(dirname2(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
    if (options.recoverOrphans !== false) {
      this.recoverOrphanedExecutions();
    }
  }
  isDispatchInFlight(executionId) {
    if (!this.dbPath || this.dbPath === ":memory:") return false;
    const lockFile = join2(dirname2(this.dbPath), `dispatch.lock.${executionId}`);
    if (!existsSync2(lockFile)) return false;
    try {
      const pid = Number(readFileSync2(lockFile, "utf8").trim());
      if (isPidAlive(pid)) return true;
      unlinkSync(lockFile);
    } catch {
    }
    return false;
  }
  ensureTaskColumns() {
    const cols = new Set(
      this.db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name)
    );
    if (!cols.has("use_worktree")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN use_worktree INTEGER NOT NULL DEFAULT 0;");
    }
    if (!cols.has("worktree_path")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN worktree_path TEXT;");
    }
    if (!cols.has("worktree_branch")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN worktree_branch TEXT;");
    }
    if (!cols.has("created_by")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user';");
    }
    if (!cols.has("origin_conversation_id")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN origin_conversation_id TEXT;");
    }
    if (!cols.has("origin_summary")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN origin_summary TEXT;");
    }
    if (!cols.has("discovered_from_task_id")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN discovered_from_task_id TEXT;");
    }
  }
  ensureConversationColumns() {
    const cols = new Set(
      this.db.prepare("PRAGMA table_info(task_conversations)").all().map((c) => c.name)
    );
    if (!cols.has("summary")) {
      this.db.exec("ALTER TABLE task_conversations ADD COLUMN summary TEXT;");
    }
    if (!cols.has("include_in_handoff")) {
      this.db.exec("ALTER TABLE task_conversations ADD COLUMN include_in_handoff INTEGER NOT NULL DEFAULT 0;");
    }
  }
  ensureUserMarksColumns() {
    const cols = new Set(
      this.db.prepare("PRAGMA table_info(task_user_marks)").all().map((c) => c.name)
    );
    if (!cols.has("pinned_at")) {
      this.db.exec("ALTER TABLE task_user_marks ADD COLUMN pinned_at INTEGER;");
    }
    if (!cols.has("snoozed_until")) {
      this.db.exec("ALTER TABLE task_user_marks ADD COLUMN snoozed_until INTEGER;");
    }
  }
  recoverOrphanedExecutions() {
    const rawOrphans = this.db.prepare("SELECT id, task_id FROM task_executions WHERE conversation_id IS NULL AND ended_at IS NULL").all();
    const orphans = rawOrphans.filter((row) => !this.isDispatchInFlight(row.id));
    if (orphans.length === 0) return;
    const now = Date.now();
    const rec = reconcilePhaseStatus("needs_you", "blocked");
    this.inTransaction(() => {
      const updateExecStmt = this.db.prepare(
        `UPDATE task_executions
         SET ended_at = ?, result = 'failed', error = COALESCE(error, 'Recovered orphaned pre-launch execution after unexpected shutdown')
         WHERE id = ? AND conversation_id IS NULL AND ended_at IS NULL`
      );
      const affectedTaskIds = /* @__PURE__ */ new Set();
      for (const row of orphans) {
        const res = updateExecStmt.run(now, row.id);
        if (res.changes > 0) affectedTaskIds.add(row.task_id);
      }
      if (affectedTaskIds.size > 0) {
        const updateTaskStmt = this.db.prepare(
          `UPDATE tasks
           SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ?
           WHERE id = ? AND phase = 'active'
             AND NOT EXISTS (SELECT 1 FROM task_executions te WHERE te.task_id = tasks.id AND te.ended_at IS NULL)`
        );
        for (const taskId of affectedTaskIds) {
          updateTaskStmt.run(
            rec.phase,
            rec.subPhase,
            rec.status,
            "Execution interrupted before conversation started",
            now,
            taskId
          );
          this.db.prepare("UPDATE task_user_marks SET snoozed_until = NULL, updated_at = ? WHERE task_id = ? AND snoozed_until IS NOT NULL").run(now, taskId);
        }
        this.bumpRevision();
      }
    });
  }
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
    const applied = new Set(
      this.db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version)
    );
    const now = Date.now();
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.inTransaction(() => {
        if (m.version === 3) {
          this.ensureUserMarksColumns();
        } else if (m.version === 4) {
          this.ensureTaskColumns();
          this.ensureConversationColumns();
        } else {
          this.db.exec(m.sql);
        }
        this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
          m.version,
          m.name,
          now
        );
      });
    }
    this.ensureTaskColumns();
    this.ensureUserMarksColumns();
    this.ensureConversationColumns();
    this.db.prepare("INSERT OR IGNORE INTO board_meta (key, value) VALUES ('revision', '1')").run();
  }
  close() {
    this.db.close();
  }
  inTransaction(fn) {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
      }
      throw error;
    }
  }
  getRevision() {
    const row = this.db.prepare("SELECT value FROM board_meta WHERE key = 'revision'").get();
    const num = row ? Number(row.value) : 1;
    return Number.isFinite(num) ? num : 1;
  }
  bumpRevision() {
    this.db.prepare(
      "INSERT INTO board_meta (key, value) VALUES ('revision', '2') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)"
    ).run();
    return this.getRevision();
  }
  // --- Workspaces ---
  listCustomWorkspaces() {
    const rows = this.db.prepare("SELECT * FROM workspaces ORDER BY pinned DESC, COALESCE(last_used_at, created_at) DESC").all();
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      rootPath: String(row.root_path),
      folderPaths: parseJsonSafe(row.folder_paths_json, []),
      antigravityProjectId: row.antigravity_project_id ? String(row.antigravity_project_id) : void 0,
      source: row.source === "antigravity" ? "antigravity" : "custom",
      pinned: Boolean(row.pinned),
      lastUsedAt: typeof row.last_used_at === "number" ? row.last_used_at : void 0,
      createdAt: Number(row.created_at)
    }));
  }
  getWorkspace(id) {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
    if (!row) return void 0;
    return {
      id: String(row.id),
      name: String(row.name),
      rootPath: String(row.root_path),
      folderPaths: parseJsonSafe(row.folder_paths_json, []),
      antigravityProjectId: row.antigravity_project_id ? String(row.antigravity_project_id) : void 0,
      source: row.source === "antigravity" ? "antigravity" : "custom",
      pinned: Boolean(row.pinned),
      lastUsedAt: typeof row.last_used_at === "number" ? row.last_used_at : void 0,
      createdAt: Number(row.created_at)
    };
  }
  deleteWorkspace(id) {
    const res = this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
    return res.changes > 0;
  }
  upsertWorkspace(ws) {
    this.db.prepare(
      `INSERT INTO workspaces (id, name, root_path, folder_paths_json, antigravity_project_id, source, pinned, last_used_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           root_path = excluded.root_path,
           folder_paths_json = excluded.folder_paths_json,
           antigravity_project_id = excluded.antigravity_project_id,
           pinned = excluded.pinned,
           last_used_at = COALESCE(excluded.last_used_at, workspaces.last_used_at)`
    ).run(
      ws.id,
      ws.name,
      ws.rootPath,
      JSON.stringify(ws.folderPaths),
      ws.antigravityProjectId ?? null,
      ws.source,
      ws.pinned ? 1 : 0,
      ws.lastUsedAt ?? null,
      ws.createdAt
    );
  }
  // --- Tasks hydration ---
  listTasks(options = {}) {
    const whereClause = options.includeArchived === true ? "" : "WHERE archived_at IS NULL";
    const taskRows = this.db.prepare(`SELECT * FROM tasks ${whereClause} ORDER BY sort_order ASC, updated_at DESC`).all();
    return this.hydrateTasks(taskRows);
  }
  getTask(taskId) {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!row) return void 0;
    return this.hydrateTasks([row])[0];
  }
  findTasksByConversationId(conversationId) {
    const taskRows = this.db.prepare(
      `SELECT DISTINCT t.* FROM tasks t
         INNER JOIN task_conversations tc ON tc.task_id = t.id
         WHERE tc.conversation_id = ?
         ORDER BY t.updated_at DESC`
    ).all(conversationId);
    return this.hydrateTasks(taskRows);
  }
  updateConversationLinkMeta(taskId, conversationId, subgoalId, patch) {
    const row = this.db.prepare(
      "SELECT summary, include_in_handoff, role FROM task_conversations WHERE task_id = ? AND subgoal_id = ? AND conversation_id = ?"
    ).get(taskId, subgoalId, conversationId);
    if (!row) return;
    const summary = patch.summary === void 0 ? row.summary ?? null : patch.summary;
    const include = patch.includeInHandoff === void 0 ? Number(row.include_in_handoff ?? 0) : patch.includeInHandoff ? 1 : 0;
    const role = patch.role ?? String(row.role ?? "primary");
    this.db.prepare(
      "UPDATE task_conversations SET summary = ?, include_in_handoff = ?, role = ? WHERE task_id = ? AND subgoal_id = ? AND conversation_id = ?"
    ).run(summary, include, role, taskId, subgoalId, conversationId);
  }
  listTaskEvents(taskId, limit = 100) {
    const rows = this.db.prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at DESC LIMIT ?").all(taskId, limit);
    return rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      subgoalId: row.subgoal_id ? String(row.subgoal_id) : void 0,
      conversationId: row.conversation_id ? String(row.conversation_id) : void 0,
      kind: String(row.kind),
      source: String(row.source),
      payload: parseJsonSafe(row.payload_json, {}),
      createdAt: Number(row.created_at)
    }));
  }
  hydrateTasks(taskRows) {
    if (taskRows.length === 0) return [];
    const ids = taskRows.map((r) => String(r.id));
    const placeholders = ids.map(() => "?").join(",");
    const subgoalRows = this.db.prepare(`SELECT * FROM task_subgoals WHERE task_id IN (${placeholders}) ORDER BY sort_order ASC, created_at ASC`).all(...ids);
    const refRows = this.db.prepare(`SELECT * FROM task_refs WHERE task_id IN (${placeholders}) ORDER BY created_at ASC`).all(...ids);
    const convRows = this.db.prepare(`SELECT * FROM task_conversations WHERE task_id IN (${placeholders}) ORDER BY linked_at ASC`).all(...ids);
    const execRows = this.db.prepare(`SELECT * FROM task_executions WHERE task_id IN (${placeholders}) ORDER BY started_at ASC`).all(...ids);
    const commentRows = this.db.prepare(`SELECT * FROM task_comments WHERE task_id IN (${placeholders}) ORDER BY created_at ASC`).all(...ids);
    const markRows = this.db.prepare(`SELECT * FROM task_user_marks WHERE task_id IN (${placeholders})`).all(...ids);
    const convsByTask = /* @__PURE__ */ new Map();
    const convsBySubgoal = /* @__PURE__ */ new Map();
    for (const r of convRows) {
      const subId = r.subgoal_id ? String(r.subgoal_id) : "";
      const link = {
        taskId: String(r.task_id),
        ...subId ? { subgoalId: subId } : {},
        conversationId: String(r.conversation_id),
        role: String(r.role) || "primary",
        workspaceId: r.workspace_id ? String(r.workspace_id) : void 0,
        linkedAt: Number(r.linked_at),
        ...r.summary ? { summary: String(r.summary) } : {},
        ...Number(r.include_in_handoff) ? { includeInHandoff: true } : {}
      };
      const list = convsByTask.get(link.taskId) ?? [];
      list.push(link);
      convsByTask.set(link.taskId, list);
      if (subId) {
        const key = `${link.taskId}\0${subId}`;
        const sList = convsBySubgoal.get(key) ?? [];
        sList.push(link);
        convsBySubgoal.set(key, sList);
      }
    }
    const subgoalsByTask = /* @__PURE__ */ new Map();
    for (const r of subgoalRows) {
      const id = String(r.id);
      const taskId = String(r.task_id);
      const sg = {
        id,
        taskId,
        title: String(r.title),
        detail: String(r.detail ?? ""),
        kind: String(r.kind) || "custom",
        required: Boolean(r.required),
        status: String(r.status) || "open",
        sortOrder: Number(r.sort_order ?? 0),
        dependencies: parseJsonSafe(r.dependencies_json, []),
        addedBy: String(r.added_by ?? "user"),
        createdAt: Number(r.created_at),
        closedAt: typeof r.closed_at === "number" ? r.closed_at : void 0,
        conversations: convsBySubgoal.get(`${taskId}\0${id}`) ?? []
      };
      const list = subgoalsByTask.get(taskId) ?? [];
      list.push(sg);
      subgoalsByTask.set(taskId, list);
    }
    const refsByTask = /* @__PURE__ */ new Map();
    for (const r of refRows) {
      const taskId = String(r.task_id);
      const ref = {
        id: String(r.id),
        taskId,
        subgoalId: r.subgoal_id ? String(r.subgoal_id) : void 0,
        kind: String(r.kind),
        target: String(r.target),
        label: r.label ? String(r.label) : void 0,
        round: typeof r.round === "number" ? r.round : void 0,
        addedBy: String(r.added_by ?? "user"),
        createdAt: Number(r.created_at)
      };
      const list = refsByTask.get(taskId) ?? [];
      list.push(ref);
      refsByTask.set(taskId, list);
    }
    const execsByTask = /* @__PURE__ */ new Map();
    for (const r of execRows) {
      const taskId = String(r.task_id);
      const ex = {
        id: String(r.id),
        taskId,
        subgoalId: r.subgoal_id ? String(r.subgoal_id) : void 0,
        conversationId: r.conversation_id ? String(r.conversation_id) : void 0,
        workspaceId: r.workspace_id ? String(r.workspace_id) : void 0,
        startedAt: Number(r.started_at),
        endedAt: typeof r.ended_at === "number" ? r.ended_at : void 0,
        result: r.result ? String(r.result) : void 0,
        error: r.error ? String(r.error) : void 0,
        summary: r.summary ? String(r.summary) : void 0,
        initiatedBy: r.initiated_by ? String(r.initiated_by) : void 0,
        reworkInstructions: r.rework_instructions ? String(r.rework_instructions) : void 0,
        frozenAt: typeof r.frozen_at === "number" ? r.frozen_at : void 0
      };
      const list = execsByTask.get(taskId) ?? [];
      list.push(ex);
      execsByTask.set(taskId, list);
    }
    const commentsByTask = /* @__PURE__ */ new Map();
    for (const r of commentRows) {
      const taskId = String(r.task_id);
      const comment = {
        id: String(r.id),
        taskId,
        author: String(r.author ?? "user"),
        bodyMd: String(r.body_md ?? ""),
        createdAt: Number(r.created_at)
      };
      const list = commentsByTask.get(taskId) ?? [];
      list.push(comment);
      commentsByTask.set(taskId, list);
    }
    const marksByTask = /* @__PURE__ */ new Map();
    for (const r of markRows) {
      const taskId = String(r.task_id);
      marksByTask.set(taskId, {
        taskId,
        ignoredAt: typeof r.ignored_at === "number" ? r.ignored_at : void 0,
        ackedAt: typeof r.acked_at === "number" ? r.acked_at : void 0,
        pinnedAt: typeof r.pinned_at === "number" ? r.pinned_at : void 0,
        snoozedUntil: typeof r.snoozed_until === "number" ? r.snoozed_until : void 0,
        updatedAt: Number(r.updated_at)
      });
    }
    return taskRows.map((row) => {
      const id = String(row.id);
      const subgoals = subgoalsByTask.get(id) ?? [];
      const phase = String(row.phase);
      const subPhase = String(row.sub_phase);
      const reconciled = reconcilePhaseStatus(phase, subPhase);
      return {
        id,
        title: String(row.title),
        description: String(row.description ?? ""),
        prompt: String(row.prompt ?? ""),
        phase: reconciled.phase,
        subPhase: reconciled.subPhase,
        status: row.status ? String(row.status) : reconciled.status,
        priority: String(row.priority) || "normal",
        workspaceId: row.workspace_id ? String(row.workspace_id) : void 0,
        workspacePath: row.workspace_path ? String(row.workspace_path) : void 0,
        workspaceLabel: row.workspace_label ? String(row.workspace_label) : void 0,
        blockedReason: row.blocked_reason ? String(row.blocked_reason) : void 0,
        nextAction: row.next_action ? String(row.next_action) : void 0,
        dueAt: typeof row.due_at === "number" ? row.due_at : void 0,
        reminderAt: typeof row.reminder_at === "number" ? row.reminder_at : void 0,
        remindedAt: typeof row.reminded_at === "number" ? row.reminded_at : void 0,
        sortOrder: Number(row.sort_order ?? 0),
        writeGate: row.write_gate === "locked" ? "locked" : "unlocked",
        mode: row.mode ? String(row.mode) : void 0,
        model: row.model ? String(row.model) : void 0,
        reasoningEffort: row.reasoning_effort ? String(row.reasoning_effort) : void 0,
        permission: row.permission ? String(row.permission) : void 0,
        permissionConfirmedAt: typeof row.permission_confirmed_at === "number" ? row.permission_confirmed_at : void 0,
        reuseSession: Boolean(row.reuse_session),
        createdBy: row.created_by === "ai" ? "ai" : "user",
        originConversationId: row.origin_conversation_id ? String(row.origin_conversation_id) : void 0,
        originSummary: row.origin_summary ? String(row.origin_summary) : void 0,
        discoveredFromTaskId: row.discovered_from_task_id ? String(row.discovered_from_task_id) : void 0,
        freeze: parseJsonSafe(row.freeze_json, void 0),
        handover: parseJsonSafe(row.handover_json, void 0),
        tags: normalizeTags(parseJsonSafe(row.tags_json, [])),
        schedule: parseJsonSafe(row.schedule_json, void 0),
        planRevision: Number(row.plan_revision ?? 0),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        completedAt: typeof row.completed_at === "number" ? row.completed_at : void 0,
        archivedAt: typeof row.archived_at === "number" ? row.archived_at : void 0,
        subgoals,
        subgoalRollup: computeSubgoalRollup(subgoals),
        refs: refsByTask.get(id) ?? [],
        conversations: convsByTask.get(id) ?? [],
        executions: execsByTask.get(id) ?? [],
        comments: commentsByTask.get(id) ?? [],
        userMarks: marksByTask.get(id),
        useWorktree: Boolean(row.use_worktree),
        worktreePath: row.worktree_path ? String(row.worktree_path) : void 0,
        worktreeBranch: row.worktree_branch ? String(row.worktree_branch) : void 0
      };
    });
  }
};

// src/host/workspaces.ts
import { existsSync as existsSync3, readdirSync, readFileSync as readFileSync3, statSync } from "node:fs";
import { basename as basename2, join as join3 } from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
function summarizeCols(db) {
  const rows = db.prepare("PRAGMA table_info(conversation_summaries)").all();
  return new Set(rows.map((r) => String(r.name ?? "")));
}
function rowToConversation(row, hasNotFullyIdle) {
  let uris = [];
  try {
    const raw = JSON.parse(String(row.workspace_uris ?? "[]"));
    if (Array.isArray(raw)) uris = raw.filter((v) => typeof v === "string");
  } catch {
    uris = [];
  }
  const workspacePaths = uris.map((u) => normalizeFsPath(fileUriToPath(u))).filter(Boolean);
  const projectId = String(row.project_id ?? "");
  const status = String(row.status ?? "");
  const notFullyIdle = hasNotFullyIdle ? Boolean(row.not_fully_idle) : false;
  const isIdle = status === "CASCADE_RUN_STATUS_IDLE" && !notFullyIdle;
  const parsedTime = Date.parse(String(row.last_modified_time ?? ""));
  return {
    conversationId: String(row.conversation_id),
    title: String(row.title ?? "").trim() || "(Untitled conversation)",
    preview: String(row.preview ?? "").slice(0, 160),
    projectId,
    workspacePaths,
    status,
    isIdle,
    stepCount: Number(row.step_count ?? 0),
    lastModifiedAt: Number.isFinite(parsedTime) ? parsedTime : 0
  };
}
function extractFolderPathsFromProject(raw) {
  const projectResources = raw.projectResources;
  if (!projectResources || !Array.isArray(projectResources.resources)) return [];
  const folders = [];
  for (const res of projectResources.resources) {
    if (!res || typeof res !== "object") continue;
    const rec = res;
    if (typeof rec.folderUri === "string" && rec.folderUri.trim()) {
      folders.push(normalizeFsPath(fileUriToPath(rec.folderUri)));
    }
    const gitFolder = rec.gitFolder;
    if (gitFolder && typeof gitFolder.folderUri === "string" && gitFolder.folderUri.trim()) {
      folders.push(normalizeFsPath(fileUriToPath(gitFolder.folderUri)));
    }
  }
  return [...new Set(folders.filter(Boolean))];
}
function readAntigravityProjects(paths) {
  if (!existsSync3(paths.projectsDir)) return [];
  let files;
  try {
    files = readdirSync(paths.projectsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const workspaces = [];
  for (const file of files) {
    const full = join3(paths.projectsDir, file);
    try {
      const content = readFileSync3(full, "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== "object") continue;
      if (parsed.sidecar) continue;
      const id = String(parsed.id ?? basename2(file, ".json"));
      const folderPaths = extractFolderPathsFromProject(parsed);
      if (folderPaths.length === 0 && id === "default-cli-project") continue;
      const rootPath = folderPaths[0] ?? "";
      const name = String(parsed.name ?? (rootPath ? basename2(rootPath) : id));
      const mtimeMs = Math.round(statSync(full).mtimeMs);
      workspaces.push({
        id,
        name,
        rootPath,
        folderPaths,
        antigravityProjectId: id,
        source: "antigravity",
        pinned: false,
        createdAt: mtimeMs
      });
    } catch {
    }
  }
  return workspaces;
}
function listMergedWorkspaces(db, paths) {
  const agy = readAntigravityProjects(paths);
  const custom = db.listCustomWorkspaces();
  const byId = /* @__PURE__ */ new Map();
  for (const ws of agy) {
    byId.set(ws.id, ws);
  }
  for (const ws of custom) {
    const existing = byId.get(ws.id);
    if (existing) {
      byId.set(ws.id, {
        ...existing,
        name: ws.name?.trim() ? ws.name : existing.name,
        pinned: ws.pinned ?? existing.pinned,
        lastUsedAt: ws.lastUsedAt ?? existing.lastUsedAt
      });
    } else {
      byId.set(ws.id, ws);
    }
  }
  return [...byId.values()].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    const aTime = a.lastUsedAt ?? a.createdAt;
    const bTime = b.lastUsedAt ?? b.createdAt;
    if (a.source !== b.source) return a.source === "custom" ? -1 : 1;
    return bTime - aTime;
  });
}
function updateCustomWorkspace(db, paths, workspaceId, patch, now = Date.now()) {
  const merged = listMergedWorkspaces(db, paths);
  const existing = merged.find((w) => w.id === workspaceId);
  if (!existing) {
    return { errorCode: "workspace-not-found", message: `No workspace with id '${workspaceId}'.` };
  }
  let nextRootPath = existing.rootPath;
  let nextFolderPaths = existing.folderPaths;
  let nextProjectId = existing.antigravityProjectId;
  if (patch.rootPath !== void 0) {
    const normalized = normalizeFsPath(patch.rootPath);
    if (!normalized) {
      return { errorCode: "invalid-workspace", message: "Workspace rootPath must not be empty." };
    }
    if (existing.source === "antigravity" && pathComparisonKey(normalized) !== pathComparisonKey(existing.rootPath)) {
      return {
        errorCode: "cannot-edit-host-workspace-path",
        message: "Cannot alter rootPath of an Antigravity-managed project workspace."
      };
    }
    if (existing.source === "custom") {
      nextRootPath = normalized;
      nextFolderPaths = [normalized];
      nextProjectId = matchProjectIdForWorkspace(void 0, normalized, merged.filter((w) => w.id !== workspaceId));
    }
  }
  const nextName = patch.name !== void 0 ? patch.name.trim() || existing.name : existing.name;
  const updated = {
    ...existing,
    name: nextName,
    rootPath: nextRootPath,
    folderPaths: nextFolderPaths,
    antigravityProjectId: nextProjectId,
    pinned: patch.pinned ?? existing.pinned ?? false,
    lastUsedAt: now
  };
  db.upsertWorkspace(updated);
  return updated;
}
function deleteCustomWorkspace(db, paths, workspaceId) {
  const inDb = db.getWorkspace(workspaceId);
  const isHostProject = readAntigravityProjects(paths).some((w) => w.id === workspaceId);
  if (isHostProject || inDb?.source === "antigravity") {
    return {
      ok: false,
      errorCode: "cannot-delete-host-workspace",
      message: "Cannot delete an Antigravity-managed project workspace."
    };
  }
  if (!inDb) {
    return { ok: false, errorCode: "workspace-not-found", message: `No custom workspace with id '${workspaceId}'.` };
  }
  db.deleteWorkspace(workspaceId);
  return { ok: true };
}
function readRecentConversations(paths, options = {}) {
  if (!existsSync3(paths.conversationSummariesDb)) {
    return { available: false, conversations: [] };
  }
  let db;
  try {
    db = new DatabaseSync2(paths.conversationSummariesDb, { readOnly: true, timeout: 150 });
    const cols = summarizeCols(db);
    const hasNotFullyIdle = cols.has("not_fully_idle");
    const selectIdleCol = hasNotFullyIdle ? ", not_fully_idle" : "";
    const limit = Math.min(Math.max(options.limit ?? 80, 1), 300);
    const hasFilter = Boolean(options.projectId || options.workspacePath);
    const fetchLimit = hasFilter ? Math.max(limit * 10, 1e3) : limit;
    const rows = db.prepare(
      `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, project_id${selectIdleCol}
         FROM conversation_summaries
         WHERE COALESCE(parent_conversation_id, '') = '' AND COALESCE(killed, 0) = 0
         ORDER BY last_modified_time DESC
         LIMIT ?`
    ).all(fetchLimit);
    const targetPathKey = options.workspacePath ? pathComparisonKey(options.workspacePath) : "";
    const conversations = [];
    for (const row of rows) {
      const conv = rowToConversation(row, hasNotFullyIdle);
      if (options.projectId && conv.projectId !== options.projectId) {
        if (!targetPathKey) continue;
      }
      if (options.workspacePath) {
        const matchesPath = conv.workspacePaths.some(
          (p) => isPathEqualOrInside(p, options.workspacePath) || isPathEqualOrInside(options.workspacePath, p)
        );
        if (!matchesPath && (!options.projectId || conv.projectId !== options.projectId)) continue;
      }
      conversations.push(conv);
      if (conversations.length >= limit) break;
    }
    return { available: true, conversations };
  } catch {
    return { available: false, conversations: [] };
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}
function findConversationsByIds(paths, conversationIds) {
  const uniqueIds = [...new Set(conversationIds.map((id) => id.trim()).filter(Boolean))];
  const map = /* @__PURE__ */ new Map();
  if (uniqueIds.length === 0 || !existsSync3(paths.conversationSummariesDb)) {
    return { available: existsSync3(paths.conversationSummariesDb), map };
  }
  let db;
  try {
    db = new DatabaseSync2(paths.conversationSummariesDb, { readOnly: true, timeout: 150 });
    const cols = summarizeCols(db);
    const hasNotFullyIdle = cols.has("not_fully_idle");
    const selectIdleCol = hasNotFullyIdle ? ", not_fully_idle" : "";
    for (let i = 0; i < uniqueIds.length; i += 200) {
      const chunk = uniqueIds.slice(i, i + 200);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, project_id${selectIdleCol}
           FROM conversation_summaries
           WHERE conversation_id IN (${placeholders})`
      ).all(...chunk);
      for (const row of rows) {
        const conv = rowToConversation(row, hasNotFullyIdle);
        map.set(conv.conversationId, conv);
      }
    }
    return { available: true, map };
  } catch {
    return { available: false, map };
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}
function resolveConversationLineage(paths, conversationId) {
  const convId = conversationId.trim();
  if (!convId || !existsSync3(paths.conversationSummariesDb)) {
    return { nestingDepth: 0, ancestors: [] };
  }
  let db;
  try {
    db = new DatabaseSync2(paths.conversationSummariesDb, { readOnly: true, timeout: 150 });
    const cols = summarizeCols(db);
    const hasParentCol = cols.has("parent_conversation_id");
    const hasDepthCol = cols.has("nesting_depth");
    const hasParentsTable = Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_parents'").get()
    );
    const summaryStmt = hasParentCol ? db.prepare(
      `SELECT parent_conversation_id${hasDepthCol ? ", nesting_depth" : ""} FROM conversation_summaries WHERE conversation_id = ?`
    ) : void 0;
    const parentTableStmt = hasParentsTable ? db.prepare("SELECT parent_id FROM conversation_parents WHERE conversation_id = ?") : void 0;
    let directParent;
    let nestingDepth = 0;
    const ancestors = [];
    const visited = /* @__PURE__ */ new Set([convId]);
    let cursor = convId;
    for (let hop = 0; hop < 8; hop += 1) {
      let nextParent = "";
      if (summaryStmt) {
        const row = summaryStmt.get(cursor);
        if (hop === 0 && typeof row?.nesting_depth === "number" && Number.isFinite(row.nesting_depth)) {
          nestingDepth = row.nesting_depth;
        }
        if (typeof row?.parent_conversation_id === "string" && row.parent_conversation_id.trim()) {
          nextParent = row.parent_conversation_id.trim();
        }
      }
      if (!nextParent && parentTableStmt) {
        const row = parentTableStmt.get(cursor);
        if (typeof row?.parent_id === "string" && row.parent_id.trim()) {
          nextParent = row.parent_id.trim();
        }
      }
      if (!nextParent || visited.has(nextParent)) break;
      if (hop === 0) directParent = nextParent;
      ancestors.push(nextParent);
      visited.add(nextParent);
      cursor = nextParent;
    }
    return {
      parentConversationId: directParent,
      rootConversationId: ancestors.at(-1),
      nestingDepth: nestingDepth > 0 ? nestingDepth : ancestors.length,
      ancestors
    };
  } catch {
    return { nestingDepth: 0, ancestors: [] };
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}

// src/host/launch-admission.ts
var LaunchAdmissionQueue = class {
  constructor(width) {
    this.width = width;
  }
  waiting = /* @__PURE__ */ new Map();
  rotation = [];
  inFlight = /* @__PURE__ */ new Set();
  peakInFlight = 0;
  get pendingCount() {
    let total = 0;
    for (const queue of this.waiting.values()) total += queue.length;
    return total;
  }
  get inFlightCount() {
    return this.inFlight.size;
  }
  enqueue(launch) {
    const queue = this.waiting.get(launch.groupId);
    if (queue === void 0) {
      this.waiting.set(launch.groupId, [launch]);
      this.rotation.push(launch.groupId);
    } else {
      queue.push(launch);
    }
    this.pump();
  }
  drain() {
    const abandoned = [];
    for (const groupId of this.rotation) {
      for (const launch of this.waiting.get(groupId) ?? []) abandoned.push(launch);
    }
    this.rotation = [];
    this.waiting.clear();
    for (const launch of abandoned) launch.abandon();
    return abandoned;
  }
  pump() {
    const cap = Math.max(1, Math.trunc(this.width()));
    while (this.inFlight.size < cap) {
      const launch = this.takeNext();
      if (launch === void 0) return;
      this.admit(launch);
    }
  }
  takeNext() {
    while (this.rotation.length > 0) {
      const groupId = this.rotation.shift();
      if (groupId === void 0) return void 0;
      const queue = this.waiting.get(groupId);
      if (queue === void 0 || queue.length === 0) {
        this.waiting.delete(groupId);
        continue;
      }
      const launch = queue.shift();
      if (launch === void 0) continue;
      if (queue.length === 0) this.waiting.delete(groupId);
      else this.rotation.push(groupId);
      return launch;
    }
    return void 0;
  }
  admit(launch) {
    const release = () => {
      this.inFlight.delete(release);
      this.pump();
    };
    this.inFlight.add(release);
    if (this.inFlight.size > this.peakInFlight) this.peakInFlight = this.inFlight.size;
    void Promise.resolve().then(() => launch.start()).catch(() => {
    }).then(release);
  }
};

// src/host/agent-bridge.ts
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync as existsSync4, readdirSync as readdirSync2, readFileSync as readFileSync4, statSync as statSync2 } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { homedir as homedir2 } from "node:os";
import { join as join4 } from "node:path";
var SAFE_CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{4,120}$/;
function defaultExecFile(file, args, options) {
  return new Promise((resolve7, reject) => {
    execFile(file, [...args], options, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        reject(new Error(`agentapi failed: ${msg}`));
        return;
      }
      resolve7({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}
function isLoopbackHost(hostname) {
  const clean = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return clean === "127.0.0.1" || clean === "localhost" || clean === "::1";
}
function defaultConnectFetch(url, init) {
  return new Promise((resolve7, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const isHttps = parsed.protocol === "https:";
    if (!isHttps && parsed.protocol !== "http:") {
      reject(new Error(`Unsupported protocol: ${parsed.protocol}`));
      return;
    }
    const timeoutMs = init.timeoutMs ?? 15e3;
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const reqOpts = {
      hostname: parsed.hostname.replace(/^\[|\]$/g, ""),
      port: parsed.port ? Number(parsed.port) : isHttps ? 443 : 80,
      path: `${parsed.pathname}${parsed.search}`,
      method: init.method,
      agent: false,
      headers: {
        ...init.headers,
        Connection: "close",
        "Content-Length": String(Buffer.byteLength(init.body, "utf8"))
      },
      timeout: timeoutMs,
      ...isHttps ? { rejectUnauthorized: !isLoopbackHost(parsed.hostname) } : {}
    };
    let settled = false;
    const finishOk = (res) => {
      if (settled) return;
      settled = true;
      resolve7(res);
    };
    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const req = reqFn(reqOpts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on("error", finishErr);
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        const rawText = Buffer.concat(chunks).toString("utf8");
        finishOk({
          ok: status >= 200 && status < 300,
          status,
          text: async () => rawText
        });
      });
    });
    req.on("socket", (socket) => {
      socket.on("error", finishErr);
    });
    req.on("error", finishErr);
    req.on("timeout", () => {
      const err = new Error(`Connect HTTP timeout after ${timeoutMs}ms`);
      req.destroy(err);
      finishErr(err);
    });
    if (init.body) req.write(init.body);
    req.end();
  });
}
function isPidAlive2(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}
async function probeLoopbackHealthz(url, fetchImpl, timeoutMs = 450) {
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {},
      body: "",
      timeoutMs
    });
    return res.ok;
  } catch {
    return false;
  }
}
async function discoverVerifiedLsDaemon(daemonDir, fetchImpl = defaultConnectFetch) {
  if (!daemonDir || !existsSync4(daemonDir)) return void 0;
  let files;
  try {
    files = readdirSync2(daemonDir).filter((f) => f.endsWith(".json")).map((f) => {
      const full = join4(daemonDir, f);
      try {
        return { path: full, mtimeMs: statSync2(full).mtimeMs };
      } catch {
        return { path: full, mtimeMs: 0 };
      }
    }).sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return void 0;
  }
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync4(file.path, "utf8"));
      const csrfToken = typeof parsed.csrfToken === "string" ? parsed.csrfToken.trim() : "";
      if (!csrfToken) continue;
      const pid = typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : void 0;
      if (pid !== void 0 && !isPidAlive2(pid)) continue;
      const httpPort = typeof parsed.httpPort === "number" && parsed.httpPort >= 1 && parsed.httpPort <= 65535 ? parsed.httpPort : void 0;
      const httpsPort = typeof parsed.httpsPort === "number" && parsed.httpsPort >= 1 && parsed.httpsPort <= 65535 ? parsed.httpsPort : void 0;
      if (!httpPort && !httpsPort) continue;
      const httpAddress = httpPort ? `127.0.0.1:${httpPort}` : void 0;
      const httpsAddress = httpsPort ? `127.0.0.1:${httpsPort}` : void 0;
      let verifiedHttp = false;
      let verifiedHttps = false;
      if (httpAddress) {
        verifiedHttp = await probeLoopbackHealthz(`http://${httpAddress}/healthz`, fetchImpl);
      }
      if (!verifiedHttp && httpsAddress) {
        verifiedHttps = await probeLoopbackHealthz(`https://${httpsAddress}/healthz`, fetchImpl);
      }
      if (!verifiedHttp && !verifiedHttps) continue;
      return {
        address: verifiedHttp && httpAddress ? `http://${httpAddress}` : `https://${httpsAddress}`,
        ...httpsAddress ? { httpsAddress: `https://${httpsAddress}` } : {},
        csrfToken,
        pid,
        lsVersion: typeof parsed.lsVersion === "string" ? parsed.lsVersion : void 0,
        source: "daemon"
      };
    } catch {
    }
  }
  return void 0;
}
function resolveAgentApiExecutable(env = process.env) {
  if (env.ANTIGRAVITY_AGENTAPI_EXE && existsSync4(env.ANTIGRAVITY_AGENTAPI_EXE)) {
    return { file: env.ANTIGRAVITY_AGENTAPI_EXE, prefixArgs: ["agentapi"] };
  }
  const candidates = [];
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA || join4(homedir2(), "AppData", "Local");
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    candidates.push(
      join4(localAppData, "Programs", "antigravity", "resources", "bin", "language_server.exe"),
      join4(localAppData, "Programs", "Antigravity", "resources", "bin", "language_server.exe"),
      join4(
        localAppData,
        "Programs",
        "antigravity",
        "resources",
        "app",
        "extensions",
        "antigravity",
        "bin",
        "language_server_windows_x64.exe"
      ),
      join4(
        localAppData,
        "Programs",
        "Antigravity",
        "resources",
        "app",
        "extensions",
        "antigravity",
        "bin",
        "language_server_windows_x64.exe"
      ),
      join4(programFiles, "Antigravity", "resources", "bin", "language_server.exe"),
      join4(
        programFiles,
        "Antigravity",
        "resources",
        "app",
        "extensions",
        "antigravity",
        "bin",
        "language_server_windows_x64.exe"
      )
    );
  } else if (process.platform === "darwin") {
    const home = homedir2();
    candidates.push(
      "/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm",
      "/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_x64",
      "/Applications/Antigravity.app/Contents/Resources/bin/language_server",
      join4(
        home,
        "Applications",
        "Antigravity.app",
        "Contents",
        "Resources",
        "app",
        "extensions",
        "antigravity",
        "bin",
        "language_server_macos_arm"
      ),
      join4(
        home,
        "Applications",
        "Antigravity.app",
        "Contents",
        "Resources",
        "app",
        "extensions",
        "antigravity",
        "bin",
        "language_server_macos_x64"
      ),
      join4(home, "Applications", "Antigravity.app", "Contents", "Resources", "bin", "language_server")
    );
  } else {
    const home = homedir2();
    candidates.push(
      "/usr/share/antigravity/resources/app/extensions/antigravity/bin/language_server_linux_x64",
      "/usr/share/antigravity/resources/app/extensions/antigravity/bin/language_server_linux_arm64",
      "/opt/antigravity/resources/app/extensions/antigravity/bin/language_server_linux_x64",
      "/usr/lib/antigravity/resources/app/extensions/antigravity/bin/language_server_linux_x64",
      "/usr/share/antigravity/resources/bin/language_server",
      join4(home, ".local", "share", "antigravity", "resources", "bin", "language_server"),
      join4(
        home,
        ".local",
        "share",
        "antigravity",
        "resources",
        "app",
        "extensions",
        "antigravity",
        "bin",
        "language_server_linux_x64"
      )
    );
  }
  for (const cand of candidates) {
    if (existsSync4(cand)) return { file: cand, prefixArgs: ["agentapi"] };
  }
  return { file: "agentapi", prefixArgs: [] };
}
function asObj(val) {
  return val && typeof val === "object" && !Array.isArray(val) ? val : void 0;
}
function readConvIdFromObj(obj) {
  if (!obj) return void 0;
  const direct = obj.conversationId ?? obj.conversation_id ?? obj.id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  return void 0;
}
function extractConversationId(payload) {
  const candidates = [
    payload,
    asObj(payload.newConversation),
    asObj(payload.new_conversation),
    asObj(payload.conversation),
    asObj(payload.response),
    asObj(asObj(payload.response)?.newConversation),
    asObj(asObj(payload.response)?.new_conversation),
    asObj(asObj(payload.response)?.conversation),
    asObj(asObj(payload.response)?.conversationMetadata),
    asObj(asObj(payload.response)?.conversation_metadata),
    asObj(payload.payload),
    asObj(asObj(payload.payload)?.newConversation),
    asObj(asObj(payload.payload)?.new_conversation)
  ];
  for (const cand of candidates) {
    const id = readConvIdFromObj(cand);
    if (id) return id;
  }
  if (typeof payload.rawOutput === "string") {
    const m = payload.rawOutput.match(/Conversation ID:\s*([A-Za-z0-9_-]{4,120})/i);
    if (m?.[1]) return m[1].trim();
  }
  return void 0;
}
function readDevToolsPort(portFile) {
  const envPort = process.env.AGY_BOARD_CDP_PORT;
  if (envPort) {
    const p = Number(envPort.trim());
    if (Number.isInteger(p) && p >= 1 && p <= 65535) return p;
    return void 0;
  }
  const candidates = existsSync4(portFile) ? [portFile] : resolveDevToolsPortFileCandidates();
  for (const candidate of candidates) {
    if (!existsSync4(candidate)) continue;
    try {
      const firstLine = readFileSync4(candidate, "utf8").split(/\r?\n/)[0]?.trim();
      const port = Number(firstLine);
      if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
    } catch {
    }
  }
  return void 0;
}
function isExcludedTargetOrigin(targetUrl, excludeOrigin) {
  if (!excludeOrigin) return false;
  try {
    const ex = new URL(excludeOrigin);
    const isLoopback = (h) => h === "127.0.0.1" || h === "localhost";
    if (isLoopback(targetUrl.hostname) && isLoopback(ex.hostname)) {
      const effPort = (u) => u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
      return targetUrl.protocol === ex.protocol && effPort(targetUrl) === effPort(ex);
    }
    return targetUrl.origin.toLowerCase() === ex.origin.toLowerCase();
  } catch {
    return false;
  }
}
function selectHubTarget(targets, options) {
  const localPages = [];
  const fallbackPages = [];
  for (const t of targets) {
    if (!t || t.type !== "page" || !t.webSocketDebuggerUrl) continue;
    if (String(t.title ?? "").trim().toLowerCase() === "agy board") continue;
    const url = String(t.url ?? "");
    const lower = url.toLowerCase();
    if (lower.startsWith("devtools://") || lower.startsWith("data:") || lower.startsWith("about:") || lower.startsWith("chrome-extension://")) {
      continue;
    }
    try {
      const parsed = new URL(url);
      if (isExcludedTargetOrigin(parsed, options?.excludeOrigin)) continue;
      if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
        localPages.push(t);
      } else {
        fallbackPages.push(t);
      }
    } catch {
      fallbackPages.push(t);
    }
  }
  if (localPages.length > 0) {
    const convHub = localPages.find((t) => {
      try {
        return new URL(String(t.url ?? "")).pathname.startsWith("/c/");
      } catch {
        return false;
      }
    });
    if (convHub) return convHub;
    const rootHub = localPages.find((t) => {
      try {
        return new URL(String(t.url ?? "")).pathname === "/";
      } catch {
        return false;
      }
    });
    return rootHub ?? localPages[0];
  }
  return fallbackPages[0];
}
function fetchCdpTargets(port, timeoutMs = 1500) {
  return new Promise((resolve7, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/json/list",
        method: "GET",
        agent: false,
        headers: { Connection: "close" },
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve7(Array.isArray(parsed) ? parsed : []);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("CDP /json/list timeout")));
    req.end();
  });
}
async function cdpEvaluateNavigate(wsUrl, conversationId, timeoutMs = 2e3) {
  const parsed = new URL(wsUrl);
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error(`Refusing non-loopback CDP WebSocket host: ${parsed.hostname}`);
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0) throw new Error("Invalid CDP WebSocket port");
  const path = `${parsed.pathname || "/"}${parsed.search || ""}`;
  const wsKey = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1").update(`${wsKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  return new Promise((resolve7, reject) => {
    const socket = netConnect({ host: parsed.hostname, port });
    socket.setTimeout(timeoutMs);
    let buf = Buffer.alloc(0);
    let handshakeDone = false;
    let settled = false;
    let navResult;
    const finish = (err, navPath) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
      }
      if (err) reject(err);
      else resolve7(navPath);
    };
    const sendText = (text) => {
      const payload = Buffer.from(text, "utf8");
      const mask = randomBytes(4);
      const header = [129];
      if (payload.length < 126) {
        header.push(128 | payload.length);
      } else if (payload.length < 65536) {
        header.push(128 | 126, payload.length >> 8 & 255, payload.length & 255);
      } else {
        throw new Error("CDP frame too large");
      }
      const masked = Buffer.allocUnsafe(payload.length);
      for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i & 3];
      socket.write(Buffer.concat([Buffer.from(header), mask, masked]));
    };
    const parseFrames = () => {
      while (buf.length >= 2) {
        const b1 = buf[0];
        const b2 = buf[1];
        const opcode = b1 & 15;
        const isMasked = Boolean(b2 & 128);
        let len = b2 & 127;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        const totalLen = offset + (isMasked ? 4 : 0) + len;
        if (buf.length < totalLen) return;
        let payload = buf.subarray(offset + (isMasked ? 4 : 0), totalLen);
        if (isMasked) {
          const mask = buf.subarray(offset, offset + 4);
          const copy = Buffer.allocUnsafe(len);
          for (let i = 0; i < len; i += 1) copy[i] = payload[i] ^ mask[i & 3];
          payload = copy;
        }
        buf = buf.subarray(totalLen);
        if (opcode === 8) {
          finish(new Error("CDP WebSocket closed"));
          return;
        }
        if (opcode === 1) {
          try {
            const msg = JSON.parse(payload.toString("utf8"));
            if (msg.id === 1) {
              const nav = msg.result?.result?.value;
              navResult = typeof nav === "string" ? nav : `/c/${conversationId}`;
              sendText(JSON.stringify({ id: 2, method: "Page.bringToFront" }));
            } else if (msg.id === 2) {
              finish(void 0, navResult ?? `/c/${conversationId}`);
              return;
            }
          } catch {
          }
        }
      }
    };
    socket.on("connect", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r
Host: ${parsed.hostname}:${port}\r
Upgrade: websocket\r
Connection: Upgrade\r
Sec-WebSocket-Key: ${wsKey}\r
Sec-WebSocket-Version: 13\r
\r
`
      );
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshakeDone) {
        const marker = buf.indexOf("\r\n\r\n");
        if (marker === -1) return;
        const head = buf.subarray(0, marker).toString("latin1");
        buf = buf.subarray(marker + 4);
        if (!head.includes(" 101 ") || !head.includes(expectedAccept)) {
          finish(new Error("CDP WebSocket handshake rejected"));
          return;
        }
        handshakeDone = true;
        const expr = `(() => { const target = '/c/' + encodeURIComponent(${JSON.stringify(conversationId)}); if (window.location.pathname !== target) { window.history.pushState(null, '', target); window.dispatchEvent(new PopStateEvent('popstate')); } try { window.focus(); } catch (_) {} return window.location.pathname; })()`;
        sendText(
          JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: { expression: expr, returnByValue: true }
          })
        );
      }
      if (handshakeDone) parseFrames();
    });
    socket.on("timeout", () => finish(new Error("CDP WebSocket timeout")));
    socket.on("error", (err) => finish(err));
  });
}
var DefaultAgentBridge = class {
  exec;
  fetchFn;
  paths;
  envOverride;
  preferConnect;
  useDaemonDiscovery;
  constructor(paths, execImplOrOptions, options) {
    this.paths = paths;
    const opts = typeof execImplOrOptions === "function" ? { ...options, execImpl: execImplOrOptions } : { ...execImplOrOptions, ...options };
    const hasCustomExec = opts.execImpl !== void 0 && opts.execImpl !== defaultExecFile;
    const hasExplicitFetch = opts.fetchImpl !== void 0;
    this.exec = opts.execImpl ?? defaultExecFile;
    this.fetchFn = opts.fetchImpl ?? defaultConnectFetch;
    this.envOverride = opts.env;
    this.preferConnect = hasExplicitFetch || !hasCustomExec;
    this.useDaemonDiscovery = opts.useDaemonDiscovery ?? true;
  }
  getEnv() {
    return this.envOverride ?? process.env;
  }
  async resolveLsConnection() {
    const env = this.getEnv();
    const rawAddr = env.ANTIGRAVITY_LS_ADDRESS?.trim();
    const csrfToken = env.ANTIGRAVITY_CSRF_TOKEN?.trim();
    if (rawAddr && csrfToken) {
      return {
        address: /^https?:\/\//i.test(rawAddr) ? rawAddr : `http://${rawAddr}`,
        csrfToken,
        source: "env"
      };
    }
    if (!this.useDaemonDiscovery) return void 0;
    return discoverVerifiedLsDaemon(this.paths.daemonDir, this.fetchFn);
  }
  async callConversationService(method, body, timeoutMs = 15e3) {
    const conn = await this.resolveLsConnection();
    if (!conn) {
      throw new Error("Antigravity Language Server address/CSRF token unavailable.");
    }
    const headers = {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "x-codeium-csrf-token": conn.csrfToken,
      "x-antigravity-csrf-token": conn.csrfToken
    };
    const payloadText = JSON.stringify(body);
    const urls = [conn.address];
    if (conn.httpsAddress && conn.httpsAddress !== conn.address) {
      urls.push(conn.httpsAddress);
    } else if (!conn.httpsAddress && conn.address.startsWith("http://")) {
      urls.push(conn.address.replace(/^http:\/\//i, "https://"));
    }
    let lastErr;
    for (let i = 0; i < urls.length; i += 1) {
      const base = urls[i].replace(/\/+$/, "");
      try {
        const res = await this.fetchFn(`${base}/product.v1.ConversationService/${method}`, {
          method: "POST",
          headers,
          body: payloadText,
          timeoutMs
        });
        const rawText = await res.text();
        let parsed = {};
        if (rawText.trim()) {
          try {
            const val = JSON.parse(rawText);
            if (val && typeof val === "object" && !Array.isArray(val)) {
              parsed = val;
            }
          } catch {
            if (res.ok) {
              throw new Error(`ConversationService/${method} returned invalid JSON`);
            }
          }
        }
        if (!res.ok) {
          const errMsg = typeof parsed.message === "string" ? parsed.message : typeof parsed.error === "string" ? parsed.error : rawText || `HTTP ${res.status}`;
          const tlsSchemeMismatch = base.startsWith("http://") && (res.status === 400 || res.status === 426) && /\bhttps\b|\btls\b/i.test(rawText);
          const err = new Error(`ConversationService/${method} failed (${res.status}): ${errMsg}`);
          if (tlsSchemeMismatch && i + 1 < urls.length) {
            lastErr = err;
            continue;
          }
          throw err;
        }
        return parsed;
      } catch (err) {
        lastErr = err;
        if (err instanceof Error && err.message.startsWith(`ConversationService/${method} failed (`)) {
          throw err;
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
  async createConversation(req) {
    const body = {
      prompt: [{ text: req.prompt }]
    };
    if (req.projectId) body.projectId = req.projectId;
    if (req.model) body.model = req.model;
    if (req.title) body.title = req.title;
    if (req.tags && req.tags.length > 0) body.tags = req.tags;
    const raw = await this.callConversationService("CreateConversation", body, 2e4);
    const conversationId = extractConversationId(raw);
    if (!conversationId) {
      throw new Error("ConversationService/CreateConversation did not return a conversationId");
    }
    return { conversationId, raw };
  }
  async getConversation(conversationId) {
    if (!SAFE_CONVERSATION_ID_RE.test(conversationId)) {
      throw new Error(`Invalid conversationId: ${conversationId}`);
    }
    return this.callConversationService("GetConversation", { conversationId }, 5e3);
  }
  async listConversations(req = {}) {
    const body = {};
    if (req.pageSize !== void 0) body.pageSize = req.pageSize;
    if (req.pageToken !== void 0) body.pageToken = req.pageToken;
    if (req.projectId !== void 0) body.projectId = req.projectId;
    if (req.parentConversationId !== void 0) body.parentConversationId = req.parentConversationId;
    if (req.tags !== void 0) body.tags = req.tags;
    if (req.includeArchived !== void 0) body.includeArchived = req.includeArchived;
    return this.callConversationService("ListConversations", body, 5e3);
  }
  async updateConversation(conversationId, annotations) {
    if (!SAFE_CONVERSATION_ID_RE.test(conversationId)) {
      throw new Error(`Invalid conversationId: ${conversationId}`);
    }
    return this.callConversationService("UpdateConversation", { conversationId, annotations }, 5e3);
  }
  async runAgentApi(args, projectId) {
    const baseEnv = this.getEnv();
    const { file, prefixArgs } = resolveAgentApiExecutable(baseEnv);
    const env = { ...baseEnv };
    if (projectId) {
      env.ANTIGRAVITY_PROJECT_ID = projectId;
    } else {
      delete env.ANTIGRAVITY_PROJECT_ID;
    }
    delete env.ANTIGRAVITY_CONVERSATION_ID;
    if ((!env.ANTIGRAVITY_LS_ADDRESS || !env.ANTIGRAVITY_CSRF_TOKEN) && this.useDaemonDiscovery) {
      const discovered = await discoverVerifiedLsDaemon(this.paths.daemonDir, this.fetchFn);
      if (discovered) {
        env.ANTIGRAVITY_LS_ADDRESS = discovered.address.replace(/^https?:\/\//i, "");
        env.ANTIGRAVITY_CSRF_TOKEN = discovered.csrfToken;
      }
    }
    const { stdout } = await this.exec(file, [...prefixArgs, ...args], {
      encoding: "utf8",
      env,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 3e4
    });
    const trimmed = stdout.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && parsed.error) {
        const errText = typeof parsed.error === "string" ? parsed.error : typeof parsed.error?.message === "string" ? String(parsed.error.message) : JSON.stringify(parsed.error);
        if (errText.trim()) throw new Error(`agentapi error: ${errText}`);
      }
      return parsed;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("agentapi error:")) throw err;
      return { rawOutput: trimmed };
    }
  }
  async startConversation(req) {
    const startViaCli = async () => {
      const args = ["new-conversation"];
      if (req.model) args.push("--model", req.model);
      if (req.title) args.push("--title", req.title);
      if (req.profile) args.push("--profile", req.profile);
      if (req.prompt.startsWith("-")) args.push("--");
      args.push(req.prompt);
      const raw = await this.runAgentApi(args, req.projectId);
      const conversationId = extractConversationId(raw);
      if (!conversationId) {
        throw new Error("agentapi new-conversation did not return a conversationId");
      }
      return { conversationId, raw };
    };
    if (this.preferConnect && !req.profile) {
      try {
        return await this.createConversation(req);
      } catch (connectErr) {
        try {
          return await startViaCli();
        } catch {
          throw connectErr;
        }
      }
    }
    if (this.preferConnect && req.profile) {
      try {
        return await startViaCli();
      } catch (cliErr) {
        try {
          return await this.createConversation(req);
        } catch {
          throw cliErr;
        }
      }
    }
    return startViaCli();
  }
  async sendMessage(req) {
    if (!SAFE_CONVERSATION_ID_RE.test(req.conversationId)) {
      throw new Error(`Invalid conversationId: ${req.conversationId}`);
    }
    const args = ["send-message"];
    if (req.title) args.push("--title", req.title);
    if (req.conversationId.startsWith("-") || req.message.startsWith("-")) args.push("--");
    args.push(req.conversationId, req.message);
    const raw = await this.runAgentApi(args, req.projectId);
    return { conversationId: extractConversationId(raw) ?? req.conversationId, raw };
  }
  async getConversationMetadata(conversationId) {
    if (!SAFE_CONVERSATION_ID_RE.test(conversationId)) {
      throw new Error(`Invalid conversationId: ${conversationId}`);
    }
    if (this.preferConnect) {
      try {
        const res = await this.getConversation(conversationId);
        const conv = asObj(res.conversation) ?? res;
        const meta = asObj(conv.metadata) ?? {};
        return {
          ...res,
          conversation: conv,
          metadata: meta,
          response: asObj(res.response) ?? {
            conversationMetadata: {
              conversationId: conv.id ?? conversationId,
              metadata: meta
            }
          }
        };
      } catch {
      }
    }
    return this.runAgentApi(["get-conversation-metadata", conversationId]);
  }
  async jumpToConversation(conversationId, options) {
    if (!SAFE_CONVERSATION_ID_RE.test(conversationId)) {
      return { ok: false, method: "none", conversationId, reason: "Invalid conversationId format." };
    }
    const port = readDevToolsPort(this.paths.devToolsActivePortFile);
    if (port === void 0) {
      return {
        ok: false,
        method: "none",
        conversationId,
        reason: "Antigravity DevToolsActivePort not found (start via CDP launcher or open inside Sidecar Aux Pane)."
      };
    }
    try {
      const targets = await fetchCdpTargets(port);
      const hub = selectHubTarget(targets, options);
      if (!hub?.webSocketDebuggerUrl) {
        return { ok: false, method: "none", conversationId, port, reason: "No Antigravity Hub page target found." };
      }
      const navigatedPath = await cdpEvaluateNavigate(hub.webSocketDebuggerUrl, conversationId);
      return { ok: true, method: "cdp", conversationId, port, navigatedPath };
    } catch (err) {
      return {
        ok: false,
        method: "none",
        conversationId,
        port,
        reason: err instanceof Error ? err.message : String(err)
      };
    }
  }
};

// src/host/refs-guard.ts
import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync as statSync3 } from "node:fs";
import { extname, isAbsolute, resolve as resolve2 } from "node:path";
import { pathToFileURL } from "node:url";
var MAX_PREVIEW_BYTES = 256 * 1024;
var LANGUAGE_BY_EXT = /* @__PURE__ */ new Map([
  [".ts", "typescript"],
  [".tsx", "tsx"],
  [".js", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".jsx", "jsx"],
  [".json", "json"],
  [".md", "markdown"],
  [".mdx", "markdown"],
  [".py", "python"],
  [".sql", "sql"],
  [".css", "css"],
  [".html", "html"],
  [".yml", "yaml"],
  [".yaml", "yaml"],
  [".sh", "bash"],
  [".ps1", "powershell"],
  [".txt", "text"],
  [".log", "text"]
]);
var WINDOWS_DEVICE_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
function isHttpUrl(value) {
  return /^https?:\/\//i.test(value.trim());
}
function resolveAllowedRefPath(target, workspacePath) {
  let trimmed = target.trim();
  if (trimmed.toLowerCase().startsWith("file://")) {
    trimmed = fileUriToPath(trimmed);
  }
  if (!trimmed || trimmed.includes("\0")) {
    return { ok: false, message: "Empty or invalid path containing NUL byte." };
  }
  if (trimmed.startsWith("\\\\?\\") || trimmed.startsWith("\\\\.\\")) {
    return { ok: false, message: "Device paths are not permitted." };
  }
  const baseSegment = trimmed.split(/[\\/]/).pop() ?? "";
  if (WINDOWS_DEVICE_RE.test(baseSegment)) {
    return { ok: false, message: "Reserved device names are not permitted." };
  }
  if (isAbsolute(trimmed)) {
    return { ok: true, path: resolve2(trimmed) };
  }
  if (!workspacePath) {
    return { ok: false, message: "Relative ref path requires a task workspacePath." };
  }
  const resolvedRoot = resolve2(workspacePath.toLowerCase().startsWith("file://") ? fileUriToPath(workspacePath) : workspacePath);
  const resolvedTarget = resolve2(resolvedRoot, trimmed);
  if (!isPathEqualOrInside(resolvedTarget, resolvedRoot)) {
    return { ok: false, message: "Relative ref escapes task workspace root." };
  }
  return { ok: true, path: resolvedTarget };
}
function previewTaskRef(task, refIdOrTarget) {
  const registeredRef = task.refs.find(
    (r) => r.id === refIdOrTarget || r.target === refIdOrTarget
  );
  const registeredHandover = task.handover?.references.find((r) => r === refIdOrTarget);
  if (!registeredRef && !registeredHandover) {
    return {
      ok: false,
      code: "not-registered",
      message: "Target is not registered in this task TaskSpace references."
    };
  }
  const kind = registeredRef?.kind ?? "doc";
  const target = registeredRef?.target ?? registeredHandover;
  const refId = registeredRef?.id ?? `handover:${target}`;
  if (kind === "url" || isHttpUrl(target)) {
    return {
      ok: true,
      refId,
      kind: "url",
      target,
      isUrl: true,
      language: "text",
      sizeBytes: Buffer.byteLength(target, "utf8"),
      truncated: false,
      content: target
    };
  }
  if (kind === "command") {
    return {
      ok: true,
      refId,
      kind: "command",
      target,
      language: "bash",
      sizeBytes: Buffer.byteLength(target, "utf8"),
      truncated: false,
      content: target
    };
  }
  const normalizedTarget = target.trim().toLowerCase().startsWith("file://") ? fileUriToPath(target) : target.trim();
  const pathCheck = resolveAllowedRefPath(normalizedTarget, task.workspacePath);
  if (!pathCheck.ok) {
    return { ok: false, code: "invalid-path", message: pathCheck.message };
  }
  const resolvedPath = pathCheck.path;
  try {
    lstatSync(resolvedPath);
    const realTarget = realpathSync(resolvedPath);
    if (task.workspacePath && (!isAbsolute(normalizedTarget) || isPathEqualOrInside(resolvedPath, resolve2(task.workspacePath)))) {
      const realRoot = realpathSync(resolve2(task.workspacePath));
      if (!isPathEqualOrInside(realTarget, realRoot)) {
        return { ok: false, code: "symlink-escape", message: "Symlink escapes workspace boundary." };
      }
    }
    const st = statSync3(realTarget);
    if (!st.isFile()) {
      return { ok: false, code: "not-a-file", message: "Registered reference does not point to a regular file." };
    }
    const totalBytes = st.size;
    const truncated = totalBytes > MAX_PREVIEW_BYTES;
    const toRead = Math.min(totalBytes, MAX_PREVIEW_BYTES);
    const slice = Buffer.allocUnsafe(toRead);
    if (toRead > 0) {
      const fd = openSync(realTarget, "r");
      try {
        let offset = 0;
        while (offset < toRead) {
          const n = readSync(fd, slice, offset, toRead - offset, offset);
          if (n <= 0) break;
          offset += n;
        }
      } finally {
        closeSync(fd);
      }
    }
    const isBinary = slice.subarray(0, Math.min(slice.length, 4096)).includes(0);
    const ext = extname(realTarget).toLowerCase();
    const language = LANGUAGE_BY_EXT.get(ext) ?? "text";
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
        content: `[Binary file: ${ext || "unknown"}, ${totalBytes} bytes]`
      };
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
      content: slice.toString("utf8")
    };
  } catch (err) {
    const code = err?.code;
    if (code === "ENOENT") {
      return { ok: false, code: "not-found", message: `Referenced file not found: ${resolvedPath}` };
    }
    return {
      ok: false,
      code: "unreadable",
      message: err instanceof Error ? err.message : String(err)
    };
  }
}

// src/host/worktree.ts
import { execFile as execFile2 } from "node:child_process";
import { existsSync as existsSync5, mkdirSync as mkdirSync2, statSync as statSync4 } from "node:fs";
import { basename as basename3, join as join5, resolve as resolve3 } from "node:path";
function defaultGitExec(file, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile2(file, [...args], options, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        rejectPromise(new Error(msg));
        return;
      }
      resolvePromise({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}
var MAX_DIFF_CHARS = 256 * 1024;
function sanitizeTaskSegment(taskId) {
  return taskId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64) || "task";
}
async function runGit(args, execImpl) {
  const { stdout } = await execImpl("git", args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 15e3
  });
  return stdout;
}
async function ensureTaskWorktree(workspacePath, taskId, execImpl = defaultGitExec) {
  const trimmed = workspacePath?.trim();
  if (!trimmed) {
    return { ok: false, reason: "invalid-path", message: "Workspace path is required for git worktree isolation." };
  }
  const absWorkspace = resolve3(trimmed);
  try {
    if (!existsSync5(absWorkspace) || !statSync4(absWorkspace).isDirectory()) {
      return { ok: false, reason: "invalid-path", message: `Workspace directory does not exist: ${absWorkspace}` };
    }
  } catch {
    return { ok: false, reason: "invalid-path", message: `Workspace directory is inaccessible: ${absWorkspace}` };
  }
  let repoRoot;
  try {
    repoRoot = normalizeFsPath((await runGit(["-C", absWorkspace, "rev-parse", "--show-toplevel"], execImpl)).trim());
  } catch (err) {
    return {
      ok: false,
      reason: "not-git-repo",
      message: err instanceof Error ? err.message : "Not a git repository."
    };
  }
  if (!repoRoot) {
    return { ok: false, reason: "not-git-repo", message: "Could not resolve git repository root." };
  }
  const safeId = sanitizeTaskSegment(taskId);
  const worktreesRoot = join5(repoRoot, ".worktrees");
  const worktreeDir = normalizeFsPath(join5(worktreesRoot, `agy-board-${safeId}`));
  const branchName = `agy-board/${safeId}`;
  if (existsSync5(worktreeDir)) {
    try {
      const inside = (await runGit(["-C", worktreeDir, "rev-parse", "--is-inside-work-tree"], execImpl)).trim();
      if (inside === "true") {
        const currentBranch = (await runGit(["-C", worktreeDir, "rev-parse", "--abbrev-ref", "HEAD"], execImpl).catch(() => branchName)).trim();
        return {
          ok: true,
          repoRoot,
          worktreePath: worktreeDir,
          worktreeBranch: currentBranch || branchName,
          reused: true
        };
      }
    } catch {
      return {
        ok: false,
        reason: "git-failed",
        message: `Existing path at ${worktreeDir} is not a valid git worktree.`
      };
    }
  }
  mkdirSync2(worktreesRoot, { recursive: true });
  let branchExists = false;
  try {
    await runGit(["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], execImpl);
    branchExists = true;
  } catch {
    branchExists = false;
  }
  try {
    if (branchExists) {
      await runGit(["-C", repoRoot, "worktree", "add", worktreeDir, branchName], execImpl);
    } else {
      await runGit(["-C", repoRoot, "worktree", "add", "-b", branchName, worktreeDir], execImpl);
    }
    return {
      ok: true,
      repoRoot,
      worktreePath: worktreeDir,
      worktreeBranch: branchName,
      reused: false
    };
  } catch (err) {
    return {
      ok: false,
      reason: "git-failed",
      message: err instanceof Error ? err.message : String(err)
    };
  }
}
async function getTaskWorktreeDiff(worktreePath, execImpl = defaultGitExec) {
  const absWorktree = resolve3(worktreePath);
  if (!existsSync5(absWorktree)) {
    return { ok: false, reason: "invalid-path", message: `Worktree does not exist: ${absWorktree}` };
  }
  try {
    const inside = (await runGit(["-C", absWorktree, "rev-parse", "--is-inside-work-tree"], execImpl)).trim();
    if (inside !== "true") {
      return { ok: false, reason: "not-git-repo", message: `Not a git worktree: ${absWorktree}` };
    }
    const branch = (await runGit(["-C", absWorktree, "rev-parse", "--abbrev-ref", "HEAD"], execImpl).catch(() => "")).trim();
    const status = (await runGit(["-C", absWorktree, "status", "--porcelain=v1"], execImpl)).trimEnd();
    const unstaged = await runGit(["-C", absWorktree, "diff"], execImpl);
    const staged = await runGit(["-C", absWorktree, "diff", "--cached"], execImpl);
    let combined = [staged ? `# Staged
${staged}` : "", unstaged ? `# Unstaged
${unstaged}` : ""].filter(Boolean).join("\n");
    const truncated = combined.length > MAX_DIFF_CHARS;
    if (truncated) combined = combined.slice(0, MAX_DIFF_CHARS);
    return {
      ok: true,
      worktreePath: normalizeFsPath(absWorktree),
      branch,
      status,
      diff: combined,
      hasChanges: Boolean(status.trim() || combined.trim()),
      truncated
    };
  } catch (err) {
    return {
      ok: false,
      reason: "git-failed",
      message: err instanceof Error ? err.message : String(err)
    };
  }
}
async function cleanupTaskWorktree(workspacePath, worktreePath, branch, force = false, execImpl = defaultGitExec) {
  const absWorktree = resolve3(worktreePath);
  const dirName = basename3(absWorktree);
  if (!dirName.startsWith("agy-board-")) {
    return { ok: false, reason: "unsafe-path", message: `Refusing to remove non-agy-board path: ${absWorktree}` };
  }
  const parentRepo = workspacePath?.trim() ? resolve3(workspacePath.trim()) : resolve3(absWorktree, "..", "..");
  let repoRoot;
  try {
    repoRoot = normalizeFsPath((await runGit(["-C", parentRepo, "rev-parse", "--show-toplevel"], execImpl)).trim());
  } catch (err) {
    return {
      ok: false,
      reason: "not-git-repo",
      message: err instanceof Error ? err.message : "Not a git repository."
    };
  }
  const allowedRoot = join5(repoRoot, ".worktrees");
  if (!isPathEqualOrInside(absWorktree, allowedRoot) || absWorktree === resolve3(allowedRoot)) {
    return { ok: false, reason: "unsafe-path", message: `Worktree path escapes .worktrees root: ${absWorktree}` };
  }
  try {
    if (existsSync5(absWorktree)) {
      const removeArgs = ["-C", repoRoot, "worktree", "remove"];
      if (force) removeArgs.push("--force");
      removeArgs.push(absWorktree);
      await runGit(removeArgs, execImpl);
    }
    await runGit(["-C", repoRoot, "worktree", "prune"], execImpl).catch(() => "");
  } catch (err) {
    return {
      ok: false,
      reason: "git-failed",
      message: err instanceof Error ? err.message : String(err)
    };
  }
  let branchDeleted = false;
  if (branch && branch.startsWith("agy-board/")) {
    try {
      await runGit(["-C", repoRoot, "branch", force ? "-D" : "-d", branch], execImpl);
      branchDeleted = true;
    } catch {
      branchDeleted = false;
    }
  }
  return {
    ok: true,
    removedPath: normalizeFsPath(absWorktree),
    branchDeleted
  };
}

// src/host/board-service.ts
import { randomUUID } from "node:crypto";
import { closeSync as closeSync2, existsSync as existsSync6, mkdirSync as mkdirSync3, openSync as openSync2, readSync as readSync2, realpathSync as realpathSync2, rmSync, statSync as statSync5, unlinkSync as unlinkSync2, writeFileSync } from "node:fs";
import { dirname as dirname3, isAbsolute as isAbsolute2, join as join6, resolve as resolve4 } from "node:path";
var DomainError = class extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "DomainError";
  }
};
function parseFreezeInput(value, frozenBy, now = Date.now()) {
  if (typeof value === "string") {
    const parsed = parseFreezeRequest(value);
    if (!parsed.ok) throw new DomainError(parsed.error.code, parsed.error.message);
    return {
      ...parsed.snapshot,
      frozenAt: now,
      ...parsed.warnings.includes("redacted") ? { redacted: true } : {},
      ...frozenBy ? { frozenBy } : {}
    };
  }
  const sanitized = sanitizeFreezeSnapshot(value);
  if (!sanitized.ok) throw new DomainError(sanitized.error.code, sanitized.error.message);
  return {
    ...sanitized.snapshot,
    frozenAt: now,
    ...sanitized.redacted ? { redacted: true } : {},
    ...frozenBy ? { frozenBy } : {}
  };
}
var BoardService = class {
  db;
  paths;
  agentBridge;
  admissionQueue;
  sessionDefaultPermission;
  maxConcurrentLaunches;
  nowFn;
  onChanged;
  constructor(db, paths, options = {}) {
    this.db = db;
    this.paths = paths;
    this.sessionDefaultPermission = options.sessionDefaultPermission ?? DEFAULT_SESSION_PERMISSION;
    this.maxConcurrentLaunches = Math.min(Math.max(options.maxConcurrentLaunches ?? 3, 1), 8);
    this.agentBridge = options.agentBridge ?? new DefaultAgentBridge(paths);
    this.nowFn = options.now ?? (() => Date.now());
    this.onChanged = options.onChanged;
    this.admissionQueue = new LaunchAdmissionQueue(() => this.maxConcurrentLaunches);
  }
  now() {
    return this.nowFn();
  }
  notifyRevision() {
    const rev = this.db.bumpRevision();
    this.onChanged?.(rev);
    return rev;
  }
  taskSpaceDir() {
    const dbPath = this.db.dbPath;
    if (!dbPath || dbPath === ":memory:") return void 0;
    return join6(dirname3(dbPath), "taskspace");
  }
  taskSpaceFilePath(taskId) {
    const dir = this.taskSpaceDir();
    if (!dir || !/^[A-Za-z0-9._-]+$/.test(taskId)) return void 0;
    return join6(dir, `${taskId}.md`);
  }
  syncTaskSpaceProjection(taskId) {
    const filePath = this.taskSpaceFilePath(taskId);
    if (!filePath) return;
    try {
      const task = this.db.getTask(taskId);
      if (!task || task.archivedAt !== void 0 || task.phase !== "active" && task.phase !== "needs_you") {
        if (existsSync6(filePath)) rmSync(filePath, { force: true });
        return;
      }
      mkdirSync3(dirname3(filePath), { recursive: true });
      const lines = [
        "<!-- READ-ONLY TASKSPACE PROJECTION \u2014 Managed by agy-board; direct edits are blocked by Write Gate. -->",
        `# ${task.title}`,
        "",
        `- **Task ID**: \`${task.id}\``,
        `- **Phase**: \`${task.phase}\` / \`${task.subPhase}\` (status: \`${task.status}\`)`,
        `- **Priority**: \`${task.priority}\``,
        `- **Write Gate**: \`${task.writeGate}\``
      ];
      if (task.workspaceLabel || task.workspacePath) {
        lines.push(`- **Workspace**: ${task.workspaceLabel ?? ""} ${task.workspacePath ? `(\`${task.workspacePath}\`)` : ""}`.trim());
      }
      if (task.worktreePath) {
        lines.push(`- **Worktree**: \`${task.worktreePath}\`${task.worktreeBranch ? ` (branch \`${task.worktreeBranch}\`)` : ""}`);
      }
      if (task.dueAt !== void 0) {
        lines.push(`- **Due**: ${new Date(task.dueAt).toISOString()}`);
      }
      if (task.blockedReason) {
        lines.push(`- **Blocked / Status Note**: ${task.blockedReason}`);
      }
      if (task.nextAction) {
        lines.push(`- **Next Action**: ${task.nextAction}`);
      }
      if (task.description.trim()) {
        lines.push("", "## Description", "", task.description.trim());
      }
      if (task.prompt.trim()) {
        lines.push("", "## Prompt", "", task.prompt.trim());
      }
      if (task.freeze) {
        lines.push(
          "",
          "## Freeze Snapshot",
          "",
          `- **Goal**: ${task.freeze.goal}`,
          `- **Progress**: ${task.freeze.progress}`,
          `- **Next**: ${task.freeze.next}`
        );
      }
      if (task.subgoals.length > 0) {
        lines.push("", "## Subgoals", "");
        for (const sg of task.subgoals) {
          const mark = sg.status === "done" ? "x" : sg.status === "in_progress" ? "~" : sg.status === "skipped" ? "-" : " ";
          lines.push(`- [${mark}] \`${sg.id}\` ${sg.title}${sg.required ? " *(required)*" : ""}`);
        }
      }
      if (task.refs.length > 0 || (task.handover?.references?.length ?? 0) > 0) {
        lines.push("", "## TaskSpace References (Read-Only)", "");
        for (const ref of task.refs) {
          lines.push(`- [${ref.kind}] \`${ref.target}\`${ref.label ? ` \u2014 ${ref.label}` : ""}`);
        }
        for (const href of task.handover?.references ?? []) {
          if (!task.refs.some((r) => r.target === href)) {
            lines.push(`- [handover] \`${href}\``);
          }
        }
      }
      if (task.comments && task.comments.length > 0) {
        lines.push("", "## Comments", "");
        for (const c of task.comments.slice(-20)) {
          lines.push(`- **${c.author}** (${new Date(c.createdAt).toISOString()}): ${c.bodyMd}`);
        }
      }
      if (task.executions.length > 0) {
        lines.push("", "## Executions", "");
        for (const ex of task.executions.slice(-5)) {
          const statusLabel = ex.endedAt ? ex.result ?? "settled" : "running";
          const detail = ex.summary || ex.error || "";
          lines.push(
            `- \`${ex.id.slice(0, 8)}\` [${statusLabel}]${ex.conversationId ? ` conv=\`${ex.conversationId}\`` : ""}${detail ? ` \u2014 ${detail}` : ""}`
          );
        }
      }
      lines.push("");
      writeFileSync(filePath, lines.join("\n"), "utf8");
    } catch {
    }
  }
  appendEvent(taskId, kind, source, payload = {}, opts = {}) {
    this.db.db.prepare(
      `INSERT INTO task_events (id, task_id, subgoal_id, conversation_id, kind, source, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      taskId,
      opts.subgoalId ?? null,
      opts.conversationId ?? null,
      kind,
      source,
      JSON.stringify(payload),
      opts.createdAt ?? this.now()
    );
  }
  listWorkspaces() {
    return listMergedWorkspaces(this.db, this.paths);
  }
  registerCustomWorkspace(input) {
    const normalized = normalizeFsPath(input.rootPath);
    if (!normalized) throw new DomainError("invalid-workspace", "Workspace rootPath must not be empty.");
    const workspaces = this.listWorkspaces();
    const matchedProject = matchProjectIdForWorkspace(void 0, normalized, workspaces);
    const now = this.now();
    const existing = workspaces.find((w) => normalizeFsPath(w.rootPath).toLowerCase() === normalized.toLowerCase());
    const record = existing ? {
      ...existing,
      name: input.name?.trim() || existing.name,
      pinned: input.pinned ?? existing.pinned,
      lastUsedAt: now,
      antigravityProjectId: existing.antigravityProjectId ?? matchedProject
    } : {
      id: `ws-${randomUUID().slice(0, 8)}`,
      name: input.name?.trim() || normalized.split(/[\\/]/).filter(Boolean).pop() || normalized,
      rootPath: normalized,
      folderPaths: [normalized],
      antigravityProjectId: matchedProject,
      source: "custom",
      pinned: Boolean(input.pinned),
      lastUsedAt: now,
      createdAt: now
    };
    this.db.inTransaction(() => {
      this.db.upsertWorkspace(record);
      this.notifyRevision();
    });
    return record;
  }
  updateCustomWorkspace(workspaceId, patch) {
    let result;
    this.db.inTransaction(() => {
      const updated = updateCustomWorkspace(this.db, this.paths, workspaceId, patch, this.now());
      if ("errorCode" in updated) {
        throw new DomainError(updated.errorCode, updated.message);
      }
      result = updated;
      this.notifyRevision();
    });
    return result;
  }
  deleteCustomWorkspace(workspaceId) {
    this.db.inTransaction(() => {
      const res = deleteCustomWorkspace(this.db, this.paths, workspaceId);
      if (!res.ok) {
        throw new DomainError(res.errorCode, res.message);
      }
      this.notifyRevision();
    });
  }
  listRecentConversations(options = {}) {
    return readRecentConversations(this.paths, options);
  }
  getSnapshot(options = {}) {
    const now = this.now();
    const workspaces = this.listWorkspaces();
    const activeWorkspacePaths = (options.activeWorkspacePaths ?? []).map(normalizeFsPath).filter(Boolean);
    let activeMatch = void 0;
    for (const ap of activeWorkspacePaths) {
      activeMatch = matchWorkspaceForPath(ap, workspaces);
      if (activeMatch) break;
    }
    const convDiscovery = readRecentConversations(this.paths, { limit: 150 });
    const convById = new Map(convDiscovery.conversations.map((c) => [c.conversationId, c]));
    const rawTasks = this.db.listTasks({ includeArchived: options.includeArchived ?? true });
    const missingConvIds = /* @__PURE__ */ new Set();
    for (const t of rawTasks) {
      for (const link of t.conversations) {
        if (!convById.has(link.conversationId)) missingConvIds.add(link.conversationId);
      }
    }
    if (missingConvIds.size > 0) {
      const direct = findConversationsByIds(this.paths, [...missingConvIds]);
      for (const [id, conv] of direct.map) convById.set(id, conv);
    }
    const tasks = rawTasks.map((task) => ({
      ...task,
      conversations: task.conversations.map((link) => {
        const live = convById.get(link.conversationId);
        return live ? {
          ...link,
          title: live.title,
          liveStatus: live.status,
          isIdle: live.isIdle
        } : link;
      })
    }));
    const counts = {
      needs_you: 0,
      active: 0,
      on_hold: 0,
      todo: 0,
      closed: 0,
      archived: 0,
      dueReminders: 0
    };
    for (const task of tasks) {
      if (task.archivedAt !== void 0) {
        counts.archived += 1;
        continue;
      }
      counts[task.phase] += 1;
      if (task.phase !== "closed" && task.userMarks?.ignoredAt === void 0 && task.reminderAt !== void 0 && task.reminderAt <= now && (task.remindedAt === void 0 || task.remindedAt < task.reminderAt)) {
        counts.dueReminders += 1;
      }
    }
    return {
      revision: this.db.getRevision(),
      serverTime: now,
      timeZone: resolveHostTimeZone(),
      hostTheme: readHostThemeMode(this.paths.geminiConfigDir),
      sessionDefaultPermission: this.sessionDefaultPermission,
      maxConcurrentLaunches: this.maxConcurrentLaunches,
      workspaces,
      activeWorkspacePaths,
      activeProjectId: activeMatch?.antigravityProjectId ?? activeMatch?.id,
      tasks,
      recentConversations: convDiscovery.conversations,
      counts
    };
  }
  getTask(taskId) {
    const task = this.db.getTask(taskId);
    if (!task) return void 0;
    const linkedIds = task.conversations.map((c) => c.conversationId);
    const direct = findConversationsByIds(this.paths, linkedIds);
    return {
      ...task,
      conversations: task.conversations.map((link) => {
        const live = direct.map.get(link.conversationId);
        return live ? { ...link, title: live.title, liveStatus: live.status, isIdle: live.isIdle } : link;
      })
    };
  }
  listTaskEvents(taskId, limit = 100) {
    return this.db.listTaskEvents(taskId, limit);
  }
  resolveWorkspaceBinding(input, workspaces) {
    let workspaceId = input.workspaceId?.trim() || void 0;
    let workspacePath = input.workspacePath ? normalizeFsPath(input.workspacePath) : void 0;
    let workspaceLabel = input.workspaceLabel?.trim() || void 0;
    const deriveLabelForWorkspace = (ws, chosenPath) => {
      if (!chosenPath) return ws.name;
      if (ws.rootPath && pathComparisonKey(chosenPath) === pathComparisonKey(ws.rootPath)) {
        return ws.name;
      }
      const leaf = chosenPath.split(/[\\/]/).filter(Boolean).pop();
      return leaf || ws.name;
    };
    if (workspaceId) {
      const ws = workspaces.find((w) => w.id === workspaceId || w.antigravityProjectId === workspaceId);
      if (ws) {
        workspaceId = ws.id;
        workspacePath = workspacePath ?? (ws.rootPath || void 0);
        workspaceLabel = workspaceLabel ?? deriveLabelForWorkspace(ws, workspacePath);
      }
    } else if (workspacePath) {
      const matched = matchWorkspaceForPath(workspacePath, workspaces);
      if (matched) {
        workspaceId = matched.id;
        workspaceLabel = workspaceLabel ?? deriveLabelForWorkspace(matched, workspacePath);
      } else {
        workspaceLabel = workspaceLabel ?? (workspacePath.split(/[\\/]/).filter(Boolean).pop() || workspacePath);
      }
    }
    return { workspaceId, workspacePath, workspaceLabel };
  }
  buildScheduleRule(spec, now, taskPhase = "todo", current) {
    const mode = spec.mode ?? current?.mode ?? "cron";
    const enabled = spec.enabled ?? current?.enabled ?? false;
    const zone = spec.timeZone === null ? resolveHostTimeZone() : spec.timeZone?.trim() || current?.timeZone || resolveHostTimeZone();
    if (!isValidTimeZone(zone)) {
      throw new DomainError("invalid-timezone", `Unsupported IANA time zone: ${zone}`);
    }
    const action = spec.action ?? current?.action ?? "dispatch";
    const sessionMode = spec.sessionMode ?? current?.sessionMode ?? (mode === "once" ? "auto" : "new");
    const misfirePolicy = spec.misfirePolicy ?? current?.misfirePolicy ?? "prompt";
    const overlapPolicy = spec.overlapPolicy ?? current?.overlapPolicy ?? "wait_review";
    const maxRuns = spec.maxRuns === null ? void 0 : spec.maxRuns !== void 0 ? spec.maxRuns > 0 ? Math.trunc(spec.maxRuns) : void 0 : current?.maxRuns;
    const modeChanged = current !== void 0 && current.mode !== mode;
    const rearmingEndedOnce = mode === "once" && enabled && current !== void 0 && current.endedAt !== void 0;
    const runCount = modeChanged || rearmingEndedOnce ? 0 : current?.runCount ?? 0;
    const isEditingDefinition = spec.mode !== void 0 || spec.cron !== void 0 || spec.at !== void 0 || spec.intervalDays !== void 0 || spec.atHour !== void 0 || spec.atMinute !== void 0;
    const keepTransientState = !enabled && !isEditingDefinition;
    const baseFields = {
      action,
      sessionMode,
      misfirePolicy,
      overlapPolicy,
      ...current?.lastTriggeredAt !== void 0 ? { lastTriggeredAt: current.lastTriggeredAt } : {},
      ...keepTransientState && current?.endedAt !== void 0 ? { endedAt: current.endedAt } : {},
      ...keepTransientState && current?.endedReason !== void 0 ? { endedReason: current.endedReason } : {},
      ...keepTransientState && current?.skippedAt !== void 0 ? { skippedAt: current.skippedAt } : {},
      ...keepTransientState && current?.skippedReason !== void 0 ? { skippedReason: current.skippedReason } : {},
      ...keepTransientState && current?.missedSlotAt !== void 0 ? { missedSlotAt: current.missedSlotAt } : {}
    };
    if (mode === "once") {
      const at = spec.at ?? current?.at;
      if (typeof at !== "number" || !Number.isFinite(at)) {
        throw new DomainError("invalid-schedule", "One-shot schedule requires numeric `at` epoch milliseconds.");
      }
      if (enabled && at <= now) {
        throw new DomainError("invalid-schedule", "One-shot schedule `at` must be in the future.");
      }
      return {
        ...baseFields,
        enabled,
        mode: "once",
        at: Math.trunc(at),
        timeZone: zone,
        nextRunAt: enabled ? Math.trunc(at) : void 0,
        runCount
      };
    }
    if (mode === "after_completion") {
      const rawDays = spec.intervalDays ?? current?.intervalDays;
      if (typeof rawDays !== "number" || !Number.isFinite(rawDays) || Math.trunc(rawDays) < 1) {
        throw new DomainError("invalid-schedule", "After-completion schedule requires `intervalDays` >= 1.");
      }
      const intervalDays = Math.trunc(rawDays);
      const atHour = spec.atHour === null ? void 0 : spec.atHour !== void 0 ? Math.trunc(spec.atHour) : current?.atHour;
      const atMinute = spec.atMinute === null ? void 0 : spec.atMinute !== void 0 ? Math.trunc(spec.atMinute) : current?.atMinute;
      if (atHour !== void 0 && (!Number.isInteger(atHour) || atHour < 0 || atHour > 23)) {
        throw new DomainError("invalid-schedule", "Schedule `atHour` must be an integer between 0 and 23.");
      }
      if (atMinute !== void 0 && (!Number.isInteger(atMinute) || atMinute < 0 || atMinute > 59)) {
        throw new DomainError("invalid-schedule", "Schedule `atMinute` must be an integer between 0 and 59.");
      }
      const waitingForCurrentRound = taskPhase === "needs_you" || taskPhase === "active";
      const nextRunAt = enabled && !waitingForCurrentRound ? nextAfterCompletionAtMs(now, intervalDays, zone, atHour, atMinute) : void 0;
      return {
        ...baseFields,
        enabled,
        mode: "after_completion",
        intervalDays,
        ...atHour !== void 0 ? { atHour } : {},
        ...atMinute !== void 0 ? { atMinute } : {},
        timeZone: zone,
        nextRunAt,
        runCount,
        ...maxRuns !== void 0 ? { maxRuns } : {}
      };
    }
    const cron = (spec.cron ?? current?.cron ?? "").trim();
    if (!isValidCron(cron)) {
      throw new DomainError("invalid-cron", `Invalid 5-field cron expression: ${cron}`);
    }
    const nextRun = enabled ? nextRunAtMs(cron, now, zone) : void 0;
    if (enabled && nextRun === void 0) {
      throw new DomainError("unreachable-cron", `Cron expression '${cron}' has no reachable run instant.`);
    }
    return {
      ...baseFields,
      enabled,
      mode: "cron",
      cron,
      timeZone: zone,
      nextRunAt: nextRun,
      runCount,
      ...maxRuns !== void 0 ? { maxRuns } : {}
    };
  }
  /**
   * Resolve where an agent-staged card came from. Antigravity's untransferred
   * `/btw` side chats never reach `conversation_summaries.db`, so binding their
   * transient id would produce a dead jump link. Persist the provenance id but
   * only create a navigable `origin` link when the id (or its mainline parent)
   * is actually known.
   */
  resolveOriginConversation(input, source) {
    const explicit = input.originConversationId?.trim() ?? "";
    const fromEnv = source === "mcp" ? (process.env.ANTIGRAVITY_CONVERSATION_ID ?? "").trim() : "";
    const candidate = explicit || fromEnv;
    const parentHint = input.parentConversationId?.trim() ?? "";
    if (!candidate && !parentHint) return {};
    const lookup = findConversationsByIds(this.paths, [candidate, parentHint].filter(Boolean));
    const known = (id) => Boolean(id) && lookup.map.has(id);
    if (candidate && known(candidate)) return { persistedId: candidate, bindableId: candidate };
    if (parentHint && known(parentHint)) return { persistedId: candidate || parentHint, bindableId: parentHint };
    if (candidate) {
      const parent = resolveConversationLineage(this.paths, candidate).parentConversationId;
      if (parent && known(parent)) return { persistedId: candidate, bindableId: parent };
    }
    if (parentHint) {
      const parent = resolveConversationLineage(this.paths, parentHint).parentConversationId;
      if (parent && known(parent)) return { persistedId: candidate || parentHint, bindableId: parent };
    }
    if (!lookup.available) {
      const bind = candidate || parentHint;
      return { persistedId: bind, bindableId: bind };
    }
    return { persistedId: candidate || parentHint };
  }
  createTask(input, source = "ui") {
    const title = input.title?.trim() ?? "";
    if (!title) throw new DomainError("title-required", "Task title must not be blank.");
    const now = this.now();
    const id = randomUUID();
    const workspaces = this.listWorkspaces();
    const ws = this.resolveWorkspaceBinding(input, workspaces);
    const priority = isTaskPriority(input.priority) ? input.priority : "normal";
    const initialPhase = isTaskPhase(input.phase) ? input.phase : "todo";
    const defaultSubPhase = initialPhase === "todo" && input.subPhase === void 0 && source === "mcp" ? "draft" : "ready";
    const reconciled = reconcilePhaseStatus(initialPhase, input.subPhase ?? defaultSubPhase);
    const tags = normalizeTags(input.tags ?? []);
    const writeGate = input.writeGate === "locked" ? "locked" : "unlocked";
    const createdBy = input.createdBy === "ai" || input.createdBy === "user" ? input.createdBy : source === "mcp" || source === "hook" ? "ai" : "user";
    if (input.discoveredFromTaskId?.trim()) {
      const parentTask = this.db.getTask(input.discoveredFromTaskId.trim());
      if (!parentTask) {
        throw new DomainError(
          "discovered-from-not-found",
          `discoveredFromTaskId '${input.discoveredFromTaskId}' does not match an existing task.`
        );
      }
    }
    const origin = this.resolveOriginConversation(input, source);
    let freeze;
    if (input.freeze !== void 0) {
      freeze = parseFreezeInput(input.freeze, source, now);
    }
    let handover = void 0;
    if (input.handover !== void 0) {
      const sanitized = sanitizeHandover(input.handover);
      if (!sanitized) throw new DomainError("invalid-handover", "Handover bundle failed validation.");
      handover = handoverOf(sanitized, now);
    }
    const permission = input.permission !== void 0 ? isTaskPermission(input.permission) ? input.permission : void 0 : void 0;
    if (input.permission !== void 0 && permission === void 0) {
      throw new DomainError("invalid-permission", `Unsupported permission '${String(input.permission)}'.`);
    }
    const schedule = input.schedule && !input.schedule.clear ? this.buildScheduleRule(input.schedule, now, reconciled.phase) : void 0;
    const preparedSubgoals = (input.subgoals ?? []).map((sg, idx) => {
      const sgTitle = sg.title?.trim() ?? "";
      if (!sgTitle) throw new DomainError("invalid-subgoal", "Subgoal title must not be blank.");
      return {
        id: sg.id?.trim() || randomUUID(),
        title: sgTitle,
        detail: sg.detail?.trim() ?? "",
        kind: sg.kind ?? "custom",
        required: sg.required !== false,
        sortOrder: idx,
        dependencies: sg.dependencies ?? []
      };
    });
    if (preparedSubgoals.length > 0) {
      const depCheck = checkSubgoalDependencies(preparedSubgoals);
      if (!depCheck.ok) throw new DomainError("invalid-subgoal-deps", depCheck.error);
    }
    this.db.inTransaction(() => {
      this.db.db.prepare(
        `INSERT INTO tasks (
            id, title, description, prompt, phase, sub_phase, status, priority,
            workspace_id, workspace_path, workspace_label, blocked_reason, next_action,
            due_at, reminder_at, sort_order, write_gate, mode, model, reasoning_effort,
            permission, permission_confirmed_at, reuse_session, use_worktree, freeze_json, handover_json,
            tags_json, schedule_json, plan_revision, created_at, updated_at, completed_at,
            created_by, origin_conversation_id, origin_summary, discovered_from_task_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        title,
        input.description?.trim() ?? "",
        input.prompt?.trim() ?? "",
        reconciled.phase,
        reconciled.subPhase,
        reconciled.status,
        priority,
        ws.workspaceId ?? null,
        ws.workspacePath ?? null,
        ws.workspaceLabel ?? null,
        null,
        input.nextAction?.trim() || null,
        typeof input.dueAt === "number" ? input.dueAt : null,
        typeof input.reminderAt === "number" ? input.reminderAt : null,
        0,
        writeGate,
        input.mode?.trim() || null,
        input.model?.trim() || null,
        input.reasoningEffort?.trim() || null,
        permission ?? null,
        null,
        input.reuseSession === true ? 1 : 0,
        input.useWorktree === true ? 1 : 0,
        freeze ? JSON.stringify(freeze) : null,
        handover ? JSON.stringify(handover) : null,
        JSON.stringify(tags),
        schedule ? JSON.stringify(schedule) : null,
        preparedSubgoals.length > 0 ? 1 : 0,
        now,
        now,
        reconciled.phase === "closed" ? now : null,
        createdBy,
        origin.persistedId ?? null,
        input.originSummary?.trim() || null,
        input.discoveredFromTaskId?.trim() || null
      );
      for (const sg of preparedSubgoals) {
        this.db.db.prepare(
          `INSERT INTO task_subgoals (id, task_id, title, detail, kind, required, status, sort_order, dependencies_json, added_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
        ).run(sg.id, id, sg.title, sg.detail, sg.kind, sg.required ? 1 : 0, sg.sortOrder, JSON.stringify(sg.dependencies), source, now);
      }
      for (const ref of input.refs ?? []) {
        const target = ref.target?.trim();
        if (!target) continue;
        this.db.db.prepare(
          `INSERT OR IGNORE INTO task_refs (id, task_id, kind, target, label, added_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(randomUUID(), id, ref.kind, target, ref.label?.trim() || null, source, now);
      }
      if (origin.bindableId) {
        this.db.db.prepare(
          `INSERT INTO task_conversations (task_id, subgoal_id, conversation_id, role, workspace_id, linked_at, summary, include_in_handoff)
             VALUES (?, '', ?, 'origin', ?, ?, ?, 1)
             ON CONFLICT(task_id, subgoal_id, conversation_id) DO UPDATE SET
               role = 'origin',
               linked_at = excluded.linked_at`
        ).run(id, origin.bindableId, ws.workspaceId ?? null, now, input.originSummary?.trim() || null);
      }
      if (input.pin) {
        this.db.db.prepare(
          `INSERT INTO task_user_marks (task_id, pinned_at, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(task_id) DO UPDATE SET pinned_at = excluded.pinned_at, updated_at = excluded.updated_at`
        ).run(id, now, now);
      }
      this.appendEvent(
        id,
        "task_created",
        source,
        {
          title,
          phase: reconciled.phase,
          subPhase: reconciled.subPhase,
          pin: Boolean(input.pin),
          workspacePath: ws.workspacePath,
          createdBy,
          ...input.discoveredFromTaskId?.trim() ? { discoveredFromTaskId: input.discoveredFromTaskId.trim() } : {},
          ...origin.persistedId ? { originConversationId: origin.persistedId, originBindable: Boolean(origin.bindableId) } : {}
        },
        { createdAt: now }
      );
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(id);
    return this.getTask(id);
  }
  updateTask(taskId, patch, source = "ui") {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    const now = this.now();
    if (isTaskContentFrozen(task) && (patch.title !== void 0 || patch.description !== void 0 || patch.prompt !== void 0)) {
      throw new DomainError(
        "frozen-content",
        "Title, description, and prompt freeze after execution begins; update freeze snapshot, nextAction, or send rework instructions instead."
      );
    }
    const nextTitle = patch.title !== void 0 ? patch.title.trim() : task.title;
    if (!nextTitle) throw new DomainError("title-required", "Task title must not be blank.");
    const nextDescription = patch.description !== void 0 ? patch.description.trim() : task.description;
    const nextPrompt = patch.prompt !== void 0 ? patch.prompt.trim() : task.prompt;
    const nextPriority = patch.priority !== void 0 ? isTaskPriority(patch.priority) ? patch.priority : task.priority : task.priority;
    const workspaces = this.listWorkspaces();
    let wsId = task.workspaceId;
    let wsPath = task.workspacePath;
    let wsLabel = task.workspaceLabel;
    if (patch.workspaceId !== void 0 || patch.workspacePath !== void 0 || patch.workspaceLabel !== void 0) {
      if (patch.workspaceId === null && patch.workspacePath === null) {
        wsId = void 0;
        wsPath = void 0;
        wsLabel = void 0;
      } else {
        const resolved = this.resolveWorkspaceBinding(
          {
            workspaceId: patch.workspaceId === null ? void 0 : patch.workspaceId ?? task.workspaceId,
            workspacePath: patch.workspacePath === null ? void 0 : patch.workspacePath ?? task.workspacePath,
            workspaceLabel: patch.workspaceLabel === null ? void 0 : patch.workspaceLabel
          },
          workspaces
        );
        wsId = resolved.workspaceId;
        wsPath = resolved.workspacePath;
        wsLabel = resolved.workspaceLabel;
      }
    }
    const nextBlockedReason = patch.blockedReason === null ? void 0 : patch.blockedReason ?? task.blockedReason;
    const nextAction = patch.nextAction === null ? void 0 : patch.nextAction !== void 0 ? patch.nextAction.trim() || void 0 : task.nextAction;
    const nextDueAt = patch.dueAt === null ? void 0 : patch.dueAt ?? task.dueAt;
    const nextReminderAt = patch.reminderAt === null ? void 0 : patch.reminderAt ?? task.reminderAt;
    const resetRemindedAt = patch.reminderAt !== void 0 ? void 0 : task.remindedAt;
    const nextWriteGate = patch.writeGate ?? task.writeGate;
    const nextMode = patch.mode === null ? void 0 : patch.mode !== void 0 ? patch.mode.trim() || void 0 : task.mode;
    const nextModel = patch.model === null ? void 0 : patch.model !== void 0 ? patch.model.trim() || void 0 : task.model;
    const nextEffort = patch.reasoningEffort === null ? void 0 : patch.reasoningEffort !== void 0 ? patch.reasoningEffort.trim() || void 0 : task.reasoningEffort;
    const nextReuse = patch.reuseSession ?? task.reuseSession;
    const nextUseWorktree = patch.useWorktree ?? Boolean(task.useWorktree);
    let nextPermission = task.permission;
    let permissionChanged = false;
    if (patch.permission === null) {
      permissionChanged = task.permission !== void 0;
      nextPermission = void 0;
    } else if (patch.permission !== void 0) {
      if (!isTaskPermission(patch.permission)) {
        throw new DomainError("invalid-permission", `Unsupported permission '${String(patch.permission)}'.`);
      }
      permissionChanged = patch.permission !== task.permission;
      nextPermission = patch.permission;
    }
    let nextHandover = task.handover;
    let handoverChanged = false;
    if (patch.handover === null) {
      handoverChanged = task.handover !== void 0;
      nextHandover = void 0;
    } else if (patch.handover !== void 0) {
      const sanitized = sanitizeHandover(patch.handover);
      if (!sanitized) throw new DomainError("invalid-handover", "Handover bundle failed validation.");
      nextHandover = handoverOf(sanitized, now);
      handoverChanged = true;
    }
    const nextConfirmedAt = permissionChanged || handoverChanged ? void 0 : task.permissionConfirmedAt;
    let nextFreeze = task.freeze;
    if (patch.freeze === null) {
      nextFreeze = void 0;
    } else if (patch.freeze !== void 0) {
      nextFreeze = parseFreezeInput(patch.freeze, source, now);
    }
    const nextTags = patch.tags === null ? [] : patch.tags !== void 0 ? normalizeTags(patch.tags) : task.tags;
    this.db.inTransaction(() => {
      this.db.db.prepare(
        `UPDATE tasks SET
            title = ?, description = ?, prompt = ?, priority = ?,
            workspace_id = ?, workspace_path = ?, workspace_label = ?,
            blocked_reason = ?, next_action = ?, due_at = ?, reminder_at = ?, reminded_at = ?,
            write_gate = ?, mode = ?, model = ?, reasoning_effort = ?,
            permission = ?, permission_confirmed_at = ?, reuse_session = ?, use_worktree = ?,
            freeze_json = ?, handover_json = ?, tags_json = ?, updated_at = ?
           WHERE id = ?`
      ).run(
        nextTitle,
        nextDescription,
        nextPrompt,
        nextPriority,
        wsId ?? null,
        wsPath ?? null,
        wsLabel ?? null,
        nextBlockedReason ?? null,
        nextAction ?? null,
        nextDueAt ?? null,
        nextReminderAt ?? null,
        resetRemindedAt ?? null,
        nextWriteGate,
        nextMode ?? null,
        nextModel ?? null,
        nextEffort ?? null,
        nextPermission ?? null,
        nextConfirmedAt ?? null,
        nextReuse ? 1 : 0,
        nextUseWorktree ? 1 : 0,
        nextFreeze ? JSON.stringify(nextFreeze) : null,
        nextHandover ? JSON.stringify(nextHandover) : null,
        JSON.stringify(nextTags),
        now,
        taskId
      );
      this.appendEvent(taskId, "task_updated", source, { fields: Object.keys(patch) }, { createdAt: now });
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
    return this.getTask(taskId);
  }
  /** Human-only action via UI HTTP API; intentionally NOT exposed as an MCP tool. */
  confirmPermission(taskId) {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    const now = this.now();
    this.db.inTransaction(() => {
      const nextSubPhase = task.phase === "needs_you" && task.subPhase === "permission_pending" ? "ready" : task.subPhase;
      const nextPhase = task.phase === "needs_you" && task.subPhase === "permission_pending" ? "todo" : task.phase;
      const reconciled = reconcilePhaseStatus(nextPhase, nextSubPhase);
      this.db.db.prepare(
        `UPDATE tasks SET permission_confirmed_at = ?, phase = ?, sub_phase = ?, status = ?, blocked_reason = CASE WHEN sub_phase = 'permission_pending' THEN NULL ELSE blocked_reason END, updated_at = ? WHERE id = ?`
      ).run(now, reconciled.phase, reconciled.subPhase, reconciled.status, now, taskId);
      this.appendEvent(taskId, "permission_confirmed", "ui", { permission: task.handover?.permission ?? task.permission }, { createdAt: now });
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
    return this.getTask(taskId);
  }
  clearSnoozeForTask(taskId, now) {
    this.db.db.prepare("UPDATE task_user_marks SET snoozed_until = NULL, updated_at = ? WHERE task_id = ? AND snoozed_until IS NOT NULL").run(now, taskId);
  }
  transitionPhase(taskId, targetPhase, options = {}) {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    if (task.archivedAt !== void 0) throw new DomainError("task-archived", "Restore archived task before changing phase.");
    const source = options.source ?? "ui";
    const now = this.now();
    const reconciled = reconcilePhaseStatus(targetPhase, options.subPhase);
    if (reconciled.phase === "closed" && reconciled.subPhase !== "cancelled") {
      const gate = canCloseTaskWithSubgoals(task.subgoals, Boolean(options.force));
      if (!gate.allowed) {
        throw new DomainError("required-subgoals-open", gate.reason);
      }
    }
    if (hasOpenExecution(task) && source !== "hook" && !options.force && reconciled.phase !== "active") {
      throw new DomainError("execution-open", "Cannot move task away from active while an execution is still running (settle or force first).");
    }
    const blockedReason = options.blockedReason !== void 0 ? options.blockedReason : reconciled.phase === "needs_you" || reconciled.phase === "on_hold" ? task.blockedReason ?? null : null;
    const completedAt = reconciled.phase === "closed" ? task.completedAt ?? now : null;
    this.db.inTransaction(() => {
      this.db.db.prepare(
        `UPDATE tasks SET
            phase = ?, sub_phase = ?, status = ?,
            blocked_reason = ?,
            next_action = COALESCE(?, next_action),
            sort_order = COALESCE(?, sort_order),
            completed_at = ?,
            updated_at = ?
           WHERE id = ?`
      ).run(
        reconciled.phase,
        reconciled.subPhase,
        reconciled.status,
        blockedReason,
        options.nextAction === void 0 ? null : options.nextAction,
        options.sortOrder ?? null,
        completedAt,
        now,
        taskId
      );
      if (reconciled.phase === "needs_you") {
        this.clearSnoozeForTask(taskId, now);
      }
      if (reconciled.phase === "closed") {
        this.stopScheduleOnClose(taskId, task.schedule, now);
      }
      this.appendEvent(
        taskId,
        "phase_changed",
        source,
        { from: task.phase, to: reconciled.phase, subPhase: reconciled.subPhase, reason: blockedReason },
        { createdAt: now }
      );
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
    return this.getTask(taskId);
  }
  reorderPhaseTasks(phase, orderedTaskIds) {
    const now = this.now();
    this.db.inTransaction(() => {
      const stmt = this.db.db.prepare("UPDATE tasks SET sort_order = ?, updated_at = ? WHERE id = ? AND phase = ?");
      orderedTaskIds.forEach((id, index) => {
        stmt.run(index, now, id, phase);
      });
      this.notifyRevision();
    });
  }
  archiveTask(taskId, source = "ui") {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    if (hasOpenExecution(task)) throw new DomainError("execution-open", "Cannot archive task with an active running execution.");
    const now = this.now();
    this.db.inTransaction(() => {
      this.db.db.prepare("UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, taskId);
      this.appendEvent(taskId, "task_archived", source, {}, { createdAt: now });
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
    return this.getTask(taskId);
  }
  restoreTask(taskId, source = "ui") {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    const now = this.now();
    this.db.inTransaction(() => {
      this.db.db.prepare("UPDATE tasks SET archived_at = NULL, updated_at = ? WHERE id = ?").run(now, taskId);
      this.appendEvent(taskId, "task_restored", source, {}, { createdAt: now });
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
    return this.getTask(taskId);
  }
  deleteTask(taskId) {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    if (hasOpenExecution(task)) throw new DomainError("execution-open", "Cannot delete task while an execution is running.");
    this.db.inTransaction(() => {
      this.db.db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
  }
  setUserMarks(taskId, marks, source = "ui") {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    const now = this.now();
    const ackedAt = marks.ack === void 0 ? task.userMarks?.ackedAt ?? null : marks.ack ? now : null;
    const ignoredAt = marks.ignore === void 0 ? task.userMarks?.ignoredAt ?? null : marks.ignore ? now : null;
    const pinnedAt = marks.pin === void 0 ? task.userMarks?.pinnedAt ?? null : marks.pin ? now : null;
    let snoozedUntil;
    if (marks.snoozeUntil === void 0) {
      snoozedUntil = task.userMarks?.snoozedUntil ?? null;
    } else if (marks.snoozeUntil === null) {
      snoozedUntil = null;
    } else if (typeof marks.snoozeUntil === "number" && Number.isFinite(marks.snoozeUntil)) {
      snoozedUntil = Math.trunc(marks.snoozeUntil);
    } else {
      throw new DomainError("invalid-snooze", "snoozeUntil must be a finite epoch millisecond timestamp or null.");
    }
    this.db.inTransaction(() => {
      this.db.db.prepare(
        `INSERT INTO task_user_marks (task_id, ignored_at, acked_at, pinned_at, snoozed_until, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             ignored_at = excluded.ignored_at,
             acked_at = excluded.acked_at,
             pinned_at = excluded.pinned_at,
             snoozed_until = excluded.snoozed_until,
             updated_at = excluded.updated_at`
      ).run(taskId, ignoredAt, ackedAt, pinnedAt, snoozedUntil, now);
      this.appendEvent(
        taskId,
        "task_marks_updated",
        source,
        {
          ...marks.ack !== void 0 ? { ack: marks.ack } : {},
          ...marks.ignore !== void 0 ? { ignore: marks.ignore } : {},
          ...marks.pin !== void 0 ? { pin: marks.pin } : {},
          ...marks.snoozeUntil !== void 0 ? { snoozeUntil: snoozedUntil } : {}
        },
        { createdAt: now }
      );
      this.notifyRevision();
    });
    return this.getTask(taskId);
  }
  batchTasks(input, source = "ui") {
    const validActions = /* @__PURE__ */ new Set([
      "pin",
      "unpin",
      "set_sub_phase",
      "set_priority",
      "set_workspace",
      "archive",
      "unarchive",
      "close",
      "delete"
    ]);
    if (!validActions.has(input.action)) {
      throw new DomainError("invalid-batch-action", `Unsupported batch action '${String(input.action)}'.`);
    }
    const uniqueIds = [...new Set((input.taskIds ?? []).map((id) => String(id).trim()).filter(Boolean))];
    if (uniqueIds.length === 0) {
      return { action: input.action, affectedIds: [], skippedIds: [], tasks: [] };
    }
    if (input.action === "set_sub_phase" && input.subPhase !== "ready" && input.subPhase !== "backlog") {
      throw new DomainError("invalid-sub-phase", "Batch set_sub_phase requires subPhase 'ready' or 'backlog'.");
    }
    if (input.action === "set_priority" && !isTaskPriority(input.priority)) {
      throw new DomainError("invalid-priority", `Unsupported priority '${String(input.priority)}'.`);
    }
    let resolvedWs;
    if (input.action === "set_workspace") {
      if (input.workspaceId === null && input.workspacePath === null) {
        resolvedWs = {};
      } else {
        const workspaces = this.listWorkspaces();
        resolvedWs = this.resolveWorkspaceBinding(
          {
            workspaceId: input.workspaceId ?? void 0,
            workspacePath: input.workspacePath ?? void 0
          },
          workspaces
        );
      }
    }
    const now = this.now();
    const affectedIds = [];
    const skippedIds = [];
    this.db.inTransaction(() => {
      const loaded = [];
      for (const taskId of uniqueIds) {
        const task = this.db.getTask(taskId);
        if (!task) {
          throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
        }
        loaded.push(task);
      }
      if (input.action === "archive" || input.action === "delete" || input.action === "close") {
        for (const task of loaded) {
          if (hasOpenExecution(task)) {
            throw new DomainError(
              "execution-open",
              `Cannot ${input.action} task '${task.title}' while an execution is still running.`
            );
          }
          if (input.action === "close") {
            const gate = canCloseTaskWithSubgoals(task.subgoals, Boolean(input.force));
            if (!gate.allowed) {
              throw new DomainError("required-subgoals-open", gate.reason);
            }
          }
        }
      }
      for (const task of loaded) {
        switch (input.action) {
          case "pin": {
            this.db.db.prepare(
              `INSERT INTO task_user_marks (task_id, pinned_at, updated_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(task_id) DO UPDATE SET pinned_at = excluded.pinned_at, updated_at = excluded.updated_at`
            ).run(task.id, now, now);
            this.appendEvent(task.id, "task_marks_updated", source, { pin: true, batch: true }, { createdAt: now });
            affectedIds.push(task.id);
            break;
          }
          case "unpin": {
            this.db.db.prepare(
              `INSERT INTO task_user_marks (task_id, pinned_at, updated_at)
                 VALUES (?, NULL, ?)
                 ON CONFLICT(task_id) DO UPDATE SET pinned_at = NULL, updated_at = excluded.updated_at`
            ).run(task.id, now);
            this.appendEvent(task.id, "task_marks_updated", source, { pin: false, batch: true }, { createdAt: now });
            affectedIds.push(task.id);
            break;
          }
          case "set_sub_phase": {
            if (task.archivedAt !== void 0 || task.phase !== "todo") {
              skippedIds.push(task.id);
              break;
            }
            const rec = reconcilePhaseStatus("todo", input.subPhase);
            this.db.db.prepare("UPDATE tasks SET sub_phase = ?, status = ?, updated_at = ? WHERE id = ?").run(rec.subPhase, rec.status, now, task.id);
            this.appendEvent(task.id, "phase_changed", source, { from: task.phase, to: "todo", subPhase: rec.subPhase, batch: true }, { createdAt: now });
            affectedIds.push(task.id);
            break;
          }
          case "set_priority": {
            this.db.db.prepare("UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?").run(input.priority, now, task.id);
            this.appendEvent(task.id, "task_updated", source, { fields: ["priority"], priority: input.priority, batch: true }, { createdAt: now });
            affectedIds.push(task.id);
            break;
          }
          case "set_workspace": {
            this.db.db.prepare("UPDATE tasks SET workspace_id = ?, workspace_path = ?, workspace_label = ?, updated_at = ? WHERE id = ?").run(resolvedWs?.workspaceId ?? null, resolvedWs?.workspacePath ?? null, resolvedWs?.workspaceLabel ?? null, now, task.id);
            this.appendEvent(task.id, "task_updated", source, { fields: ["workspaceId", "workspacePath"], batch: true }, { createdAt: now });
            affectedIds.push(task.id);
            break;
          }
          case "archive": {
            if (task.archivedAt !== void 0) {
              skippedIds.push(task.id);
              break;
            }
            this.db.db.prepare("UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, task.id);
            this.appendEvent(task.id, "task_archived", source, { batch: true }, { createdAt: now });
            affectedIds.push(task.id);
            break;
          }
          case "unarchive": {
            if (task.archivedAt === void 0) {
              skippedIds.push(task.id);
              break;
            }
            this.db.db.prepare("UPDATE tasks SET archived_at = NULL, updated_at = ? WHERE id = ?").run(now, task.id);
            this.appendEvent(task.id, "task_restored", source, { batch: true }, { createdAt: now });
            affectedIds.push(task.id);
            break;
          }
          case "close": {
            if (task.archivedAt !== void 0 || task.phase === "closed") {
              skippedIds.push(task.id);
              break;
            }
            const rec = reconcilePhaseStatus("closed", "done");
            const completedAt = task.completedAt ?? now;
            this.db.db.prepare(
              "UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = NULL, completed_at = ?, updated_at = ? WHERE id = ?"
            ).run(rec.phase, rec.subPhase, rec.status, completedAt, now, task.id);
            this.stopScheduleOnClose(task.id, task.schedule, now);
            this.appendEvent(task.id, "phase_changed", source, { from: task.phase, to: "closed", subPhase: "done", batch: true }, { createdAt: now });
            affectedIds.push(task.id);
            break;
          }
          case "delete": {
            this.db.db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
            affectedIds.push(task.id);
            break;
          }
        }
      }
      if (affectedIds.length > 0) {
        this.notifyRevision();
      }
    });
    for (const id of affectedIds) {
      this.syncTaskSpaceProjection(id);
    }
    const tasks = input.action === "delete" ? [] : affectedIds.map((id) => this.getTask(id)).filter((t) => Boolean(t));
    return { action: input.action, affectedIds, skippedIds, tasks };
  }
  // --- Subgoals & Plan Breakdown ---
  planBreakdown(input, source = "mcp") {
    let task;
    if (input.taskId) {
      const existing = this.getTask(input.taskId);
      if (!existing) throw new DomainError("task-not-found", `No task with id '${input.taskId}'.`);
      task = existing;
    } else {
      if (!input.title?.trim()) throw new DomainError("title-required", "Provide either taskId or title for plan breakdown.");
      task = this.createTask(
        {
          title: input.title.trim(),
          description: input.description,
          workspaceId: input.workspaceId,
          workspacePath: input.workspacePath
        },
        source
      );
    }
    const now = this.now();
    const baseOrder = input.replace ? 0 : task.subgoals.length;
    const incoming = input.subgoals.map((sg, idx) => {
      const title = sg.title?.trim() ?? "";
      if (!title) throw new DomainError("invalid-subgoal", "Subgoal title must not be blank.");
      return {
        id: sg.id?.trim() || randomUUID(),
        title,
        detail: sg.detail?.trim() ?? "",
        kind: sg.kind ?? "custom",
        required: sg.required !== false,
        sortOrder: baseOrder + idx,
        dependencies: sg.dependencies ?? []
      };
    });
    const combinedForDeps = input.replace ? incoming : [...task.subgoals.map((s) => ({ id: s.id, dependencies: s.dependencies })), ...incoming];
    const seenIds = /* @__PURE__ */ new Set();
    for (const item of combinedForDeps) {
      if (seenIds.has(item.id)) {
        throw new DomainError("duplicate-subgoal-id", `Duplicate subgoal id '${item.id}'.`);
      }
      seenIds.add(item.id);
    }
    const depCheck = checkSubgoalDependencies(combinedForDeps);
    if (!depCheck.ok) throw new DomainError("invalid-subgoal-deps", depCheck.error);
    this.db.inTransaction(() => {
      if (input.replace) {
        this.db.db.prepare("DELETE FROM task_subgoals WHERE task_id = ?").run(task.id);
      }
      const stmt = this.db.db.prepare(
        `INSERT INTO task_subgoals (id, task_id, title, detail, kind, required, status, sort_order, dependencies_json, added_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
      );
      for (const sg of incoming) {
        stmt.run(
          sg.id,
          task.id,
          sg.title,
          sg.detail,
          sg.kind,
          sg.required ? 1 : 0,
          sg.sortOrder,
          JSON.stringify(sg.dependencies),
          source,
          now
        );
      }
      this.db.db.prepare("UPDATE tasks SET plan_revision = plan_revision + 1, updated_at = ? WHERE id = ?").run(now, task.id);
      this.appendEvent(
        task.id,
        "plan_breakdown",
        source,
        { replace: Boolean(input.replace), count: incoming.length, planRevision: task.planRevision + 1 },
        { createdAt: now }
      );
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(task.id);
    return this.getTask(task.id);
  }
  addSubgoal(taskId, input, source = "ui") {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    const title = input.title?.trim() ?? "";
    if (!title) throw new DomainError("invalid-subgoal", "Subgoal title must not be blank.");
    const id = randomUUID();
    const deps = input.dependencies ?? [];
    const depCheck = checkSubgoalDependencies([
      ...task.subgoals.map((s) => ({ id: s.id, dependencies: s.dependencies })),
      { id, dependencies: deps }
    ]);
    if (!depCheck.ok) throw new DomainError("invalid-subgoal-deps", depCheck.error);
    const now = this.now();
    this.db.inTransaction(() => {
      this.db.db.prepare(
        `INSERT INTO task_subgoals (id, task_id, title, detail, kind, required, status, sort_order, dependencies_json, added_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
      ).run(id, taskId, title, input.detail?.trim() ?? "", input.kind ?? "custom", input.required !== false ? 1 : 0, task.subgoals.length, JSON.stringify(deps), source, now);
      this.db.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, taskId);
      this.appendEvent(taskId, "subgoal_added", source, { subgoalId: id, title, required: input.required !== false }, { subgoalId: id, createdAt: now });
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
    return this.getTask(taskId);
  }
  updateSubgoal(taskId, subgoalId, patch, source = "ui") {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    const sg = task.subgoals.find((item) => item.id === subgoalId);
    if (!sg) throw new DomainError("subgoal-not-found", `No subgoal '${subgoalId}' on task '${taskId}'.`);
    const nextTitle = patch.title !== void 0 ? patch.title.trim() : sg.title;
    if (!nextTitle) throw new DomainError("invalid-subgoal", "Subgoal title must not be blank.");
    const nextDetail = patch.detail !== void 0 ? patch.detail.trim() : sg.detail;
    const nextKind = patch.kind ?? sg.kind;
    const nextRequired = patch.required ?? sg.required;
    const nextStatus = patch.status ?? sg.status;
    const nextOrder = patch.sortOrder ?? sg.sortOrder;
    const nextDeps = patch.dependencies ?? sg.dependencies;
    const depCheck = checkSubgoalDependencies(
      task.subgoals.map((item) => item.id === subgoalId ? { id: item.id, dependencies: nextDeps } : { id: item.id, dependencies: item.dependencies })
    );
    if (!depCheck.ok) throw new DomainError("invalid-subgoal-deps", depCheck.error);
    const now = this.now();
    const closedAt = nextStatus === "done" || nextStatus === "skipped" ? sg.closedAt ?? now : null;
    const simulated = task.subgoals.map(
      (item) => item.id === subgoalId ? { ...item, title: nextTitle, detail: nextDetail, kind: nextKind, required: nextRequired, status: nextStatus, sortOrder: nextOrder, dependencies: nextDeps } : item
    );
    const rollup = computeSubgoalRollup(simulated);
    const shouldRollToReview = rollup.readyForReview && task.phase === "active";
    this.db.inTransaction(() => {
      this.db.db.prepare(
        `UPDATE task_subgoals SET title = ?, detail = ?, kind = ?, required = ?, status = ?, sort_order = ?, dependencies_json = ?, closed_at = ?
           WHERE id = ? AND task_id = ?`
      ).run(nextTitle, nextDetail, nextKind, nextRequired ? 1 : 0, nextStatus, nextOrder, JSON.stringify(nextDeps), closedAt, subgoalId, taskId);
      if (shouldRollToReview) {
        this.db.db.prepare(
          "UPDATE task_executions SET ended_at = ?, result = 'succeeded', summary = COALESCE(summary, ?) WHERE task_id = ? AND ended_at IS NULL"
        ).run(now, "All required subgoals completed", taskId);
        const rec = reconcilePhaseStatus("needs_you", "review");
        this.db.db.prepare("UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?").run(rec.phase, rec.subPhase, rec.status, "All required subgoals complete \u2014 ready for review", now, taskId);
        this.clearSnoozeForTask(taskId, now);
        this.appendEvent(taskId, "subgoals_ready_for_review", source, { requiredDone: rollup.requiredDone, requiredTotal: rollup.requiredTotal }, { subgoalId, createdAt: now });
      } else {
        this.db.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, taskId);
      }
      this.appendEvent(
        taskId,
        "subgoal_updated",
        source,
        { subgoalId, status: nextStatus, required: nextRequired },
        { subgoalId, createdAt: now }
      );
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
    return this.getTask(taskId);
  }
  deleteSubgoal(taskId, subgoalId, source = "ui") {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    const remaining = task.subgoals.filter((sg) => sg.id !== subgoalId);
    const rollup = computeSubgoalRollup(remaining);
    const shouldRollToReview = rollup.readyForReview && task.phase === "active";
    const now = this.now();
    this.db.inTransaction(() => {
      this.db.db.prepare("DELETE FROM task_subgoals WHERE id = ? AND task_id = ?").run(subgoalId, taskId);
      for (const sg of remaining) {
        if (sg.dependencies.includes(subgoalId)) {
          const nextDeps = sg.dependencies.filter((d) => d !== subgoalId);
          this.db.db.prepare("UPDATE task_subgoals SET dependencies_json = ? WHERE id = ? AND task_id = ?").run(JSON.stringify(nextDeps), sg.id, taskId);
        }
      }
      if (shouldRollToReview) {
        this.db.db.prepare(
          "UPDATE task_executions SET ended_at = ?, result = 'succeeded', summary = COALESCE(summary, ?) WHERE task_id = ? AND ended_at IS NULL"
        ).run(now, "All required subgoals completed", taskId);
        const rec = reconcilePhaseStatus("needs_you", "review");
        this.db.db.prepare("UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?").run(rec.phase, rec.subPhase, rec.status, "All required subgoals complete \u2014 ready for review", now, taskId);
        this.clearSnoozeForTask(taskId, now);
        this.appendEvent(taskId, "subgoals_ready_for_review", source, { requiredDone: rollup.requiredDone, requiredTotal: rollup.requiredTotal }, { createdAt: now });
      } else {
        this.db.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, taskId);
      }
      this.appendEvent(taskId, "subgoal_deleted", source, { subgoalId }, { subgoalId, createdAt: now });
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
    return this.getTask(taskId);
  }
  reorderSubgoals(taskId, orderedSubgoalIds, source = "ui") {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    const existingIds = new Set(task.subgoals.map((s) => s.id));
    const seen = /* @__PURE__ */ new Set();
    const finalOrder = [];
    for (const id of orderedSubgoalIds) {
      if (existingIds.has(id) && !seen.has(id)) {
        seen.add(id);
        finalOrder.push(id);
      }
    }
    for (const sg of task.subgoals) {
      if (!seen.has(sg.id)) {
        seen.add(sg.id);
        finalOrder.push(sg.id);
      }
    }
    const now = this.now();
    this.db.inTransaction(() => {
      const stmt = this.db.db.prepare("UPDATE task_subgoals SET sort_order = ? WHERE id = ? AND task_id = ?");
      finalOrder.forEach((sgId, index) => {
        stmt.run(index, sgId, taskId);
      });
      this.db.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, taskId);
      this.appendEvent(taskId, "subgoals_reordered", source, { orderedIds: finalOrder }, { createdAt: now });
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
    return this.getTask(taskId);
  }
  addTaskComment(taskId, input, source = "ui") {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    const bodyMd = input.bodyMd?.trim() ?? "";
    if (!bodyMd) throw new DomainError("invalid-comment", "Comment bodyMd must not be blank.");
    const author = input.author?.trim() || source;
    const id = randomUUID();
    const now = this.now();
    this.db.inTransaction(() => {
      this.db.db.prepare("INSERT INTO task_comments (id, task_id, author, body_md, created_at) VALUES (?, ?, ?, ?, ?)").run(id, taskId, author, bodyMd, now);
      this.db.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, taskId);
      this.appendEvent(taskId, "comment_added", source, { commentId: id, author }, { createdAt: now });
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
    const updated = this.getTask(taskId);
    const comment = updated.comments?.find((c) => c.id === id) ?? { id, taskId, author, bodyMd, createdAt: now };
    return { task: updated, comment };
  }
  // --- TaskSpace Refs ---
  addTaskRef(taskId, input, source = "ui") {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    const target = input.target?.trim();
    if (!target) throw new DomainError("invalid-ref", "Reference target must not be blank.");
    const existing = task.refs.find((r) => r.kind === input.kind && r.target === target);
    if (existing) return { task, ref: existing };
    const id = randomUUID();
    const now = this.now();
    this.db.inTransaction(() => {
      this.db.db.prepare(
        `INSERT INTO task_refs (id, task_id, subgoal_id, kind, target, label, round, added_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, taskId, input.subgoalId ?? null, input.kind, target, input.label?.trim() || null, input.round ?? null, source, now);
      this.db.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, taskId);
      this.appendEvent(taskId, "ref_added", source, { refId: id, kind: input.kind, target }, { subgoalId: input.subgoalId, createdAt: now });
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
    const updated = this.getTask(taskId);
    return { task: updated, ref: updated.refs.find((r) => r.id === id) };
  }
  removeTaskRef(taskId, refId, source = "ui") {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    const now = this.now();
    this.db.inTransaction(() => {
      this.db.db.prepare("DELETE FROM task_refs WHERE id = ? AND task_id = ?").run(refId, taskId);
      this.db.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, taskId);
      this.appendEvent(taskId, "ref_removed", source, { refId }, { createdAt: now });
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
    return this.getTask(taskId);
  }
  previewRef(taskId, refIdOrTarget) {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, code: "not-found", message: `No task with id '${taskId}'.` };
    return previewTaskRef(task, refIdOrTarget);
  }
  // --- Conversation Links ---
  linkConversation(taskId, input, source = "ui") {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    const convId = input.conversationId?.trim();
    if (!convId) throw new DomainError("invalid-conversation", "conversationId must not be empty.");
    const now = this.now();
    this.db.inTransaction(() => {
      this.db.db.prepare(
        `INSERT INTO task_conversations (task_id, subgoal_id, conversation_id, role, workspace_id, linked_at, summary, include_in_handoff)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id, subgoal_id, conversation_id) DO UPDATE SET
             role = excluded.role,
             workspace_id = COALESCE(excluded.workspace_id, task_conversations.workspace_id),
             linked_at = excluded.linked_at,
             summary = COALESCE(excluded.summary, task_conversations.summary),
             include_in_handoff = CASE WHEN excluded.include_in_handoff = 1 THEN 1 ELSE task_conversations.include_in_handoff END`
      ).run(
        taskId,
        input.subgoalId ?? "",
        convId,
        input.role ?? "primary",
        input.workspaceId ?? task.workspaceId ?? null,
        now,
        input.summary?.trim() || null,
        input.includeInHandoff ? 1 : 0
      );
      this.db.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, taskId);
      this.appendEvent(taskId, "conversation_linked", source, { conversationId: convId, role: input.role ?? "primary" }, { subgoalId: input.subgoalId, conversationId: convId, createdAt: now });
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
    return this.getTask(taskId);
  }
  unlinkConversation(taskId, conversationId, subgoalId = "") {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    const now = this.now();
    this.db.inTransaction(() => {
      this.db.db.prepare("DELETE FROM task_conversations WHERE task_id = ? AND subgoal_id = ? AND conversation_id = ?").run(taskId, subgoalId, conversationId);
      this.db.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, taskId);
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
    return this.getTask(taskId);
  }
  updateConversationMeta(taskId, input, source = "ui") {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    const convId = input.conversationId?.trim();
    if (!convId) throw new DomainError("invalid-conversation", "conversationId must not be empty.");
    const now = this.now();
    this.db.inTransaction(() => {
      this.db.updateConversationLinkMeta(taskId, convId, input.subgoalId ?? "", {
        ...input.summary !== void 0 ? { summary: input.summary === null ? null : input.summary.trim() } : {},
        ...input.includeInHandoff !== void 0 ? { includeInHandoff: input.includeInHandoff } : {},
        ...input.role !== void 0 ? { role: input.role } : {}
      });
      this.db.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, taskId);
      this.appendEvent(
        taskId,
        "conversation_meta_updated",
        source,
        {
          conversationId: convId,
          ...input.includeInHandoff !== void 0 ? { includeInHandoff: input.includeInHandoff } : {},
          ...input.summary !== void 0 ? { hasSummary: Boolean(input.summary?.trim()) } : {}
        },
        { subgoalId: input.subgoalId, conversationId: convId, createdAt: now }
      );
      this.notifyRevision();
    });
    return this.getTask(taskId);
  }
  // --- Dispatch / Resume / Rework ---
  async dispatchTask(taskId, options = {}) {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    if (task.archivedAt !== void 0) throw new DomainError("task-archived", "Cannot dispatch an archived task.");
    if (task.phase === "todo" && task.subPhase === "draft") {
      throw new DomainError(
        "draft-not-approved",
        "This todo is an AI draft. Review it and approve it to Ready before dispatching."
      );
    }
    if (requiresPermissionConfirmation(task, this.sessionDefaultPermission)) {
      const now = this.now();
      this.db.inTransaction(() => {
        const rec = reconcilePhaseStatus("needs_you", "permission_pending");
        this.db.db.prepare("UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?").run(rec.phase, rec.subPhase, rec.status, "Elevated permission requires human confirmation in the board UI.", now, taskId);
        this.clearSnoozeForTask(taskId, now);
        this.notifyRevision();
      });
      throw new DomainError(
        "confirmation-required",
        "Elevated permission requires human confirmation in the board UI before dispatch."
      );
    }
    const mode = options.mode ?? "auto";
    const subgoal = options.subgoalId ? task.subgoals.find((s) => s.id === options.subgoalId) : void 0;
    if (options.subgoalId && !subgoal) {
      throw new DomainError("subgoal-not-found", `No subgoal '${options.subgoalId}' on task '${taskId}'.`);
    }
    if (mode === "rework" && !options.reworkInstructions?.trim()) {
      throw new DomainError("rework-instructions-required", "Rework requires non-empty reworkInstructions.");
    }
    if (hasOpenExecution(task)) {
      throw new DomainError("execution-open", "Task already has an open running execution.");
    }
    const workspaces = this.listWorkspaces();
    if (task.handover?.workspaceId) {
      const explicitWs = workspaces.find(
        (w) => w.id === task.handover.workspaceId || w.antigravityProjectId === task.handover.workspaceId
      );
      if (!explicitWs) {
        throw new DomainError(
          "unknown-handover-workspace",
          `Handover workspace '${task.handover.workspaceId}' is not registered or discovered.`
        );
      }
    }
    const projectId = task.handover?.workspaceId ? matchProjectIdForWorkspace(task.handover.workspaceId, void 0, workspaces) : matchProjectIdForWorkspace(task.workspaceId, task.workspacePath, workspaces);
    const convDiscovery = readRecentConversations(this.paths, { limit: 300 });
    const convById = new Map(convDiscovery.conversations.map((c) => [c.conversationId, c]));
    const linkedConvIds = [
      ...task.conversations.map((c) => c.conversationId),
      ...options.conversationId?.trim() ? [options.conversationId.trim()] : []
    ];
    const directLookup = findConversationsByIds(this.paths, linkedConvIds);
    for (const [id, conv] of directLookup.map) {
      convById.set(id, conv);
    }
    const discoveryAvailable = convDiscovery.available || directLookup.available;
    const idleSessionIds = discoveryAvailable ? new Set([...convById.values()].filter((c) => c.isIdle).map((c) => c.conversationId)) : void 0;
    let targetConvId;
    let action = "new";
    if (mode === "rework") {
      action = "rework";
      const candidate = options.conversationId?.trim() || reusableSessionId(task, idleSessionIds, { force: true, subgoalId: options.subgoalId }) || task.conversations.find((c) => options.subgoalId ? c.subgoalId === options.subgoalId : c.role === "primary")?.conversationId || task.conversations.find((c) => options.subgoalId ? c.subgoalId === options.subgoalId : true)?.conversationId;
      if (!candidate) {
        throw new DomainError("no-conversation-to-rework", "No existing conversation linked to rework; dispatch a new conversation instead.");
      }
      const liveConv = convById.get(candidate);
      if (liveConv && !liveConv.isIdle) {
        throw new DomainError("session-busy", `Conversation '${candidate}' is currently running (${liveConv.status}); wait for it to finish before sending rework.`);
      }
      targetConvId = candidate;
    } else if (mode === "resume") {
      action = "resume";
      const candidate = options.conversationId?.trim() || reusableSessionId(task, idleSessionIds, { force: true, subgoalId: options.subgoalId }) || task.conversations.find((c) => options.subgoalId ? c.subgoalId === options.subgoalId : c.role === "primary")?.conversationId || task.conversations.find((c) => options.subgoalId ? c.subgoalId === options.subgoalId : true)?.conversationId;
      if (!candidate) {
        throw new DomainError("no-conversation-to-resume", "No existing conversation linked to resume.");
      }
      const liveConv = convById.get(candidate);
      if (liveConv && !liveConv.isIdle) {
        throw new DomainError("session-busy", `Conversation '${candidate}' is currently running (${liveConv.status}); wait for it to settle before resuming.`);
      }
      targetConvId = candidate;
    } else if (mode === "auto") {
      const reused = options.conversationId?.trim() || reusableSessionId(task, idleSessionIds, { subgoalId: options.subgoalId });
      if (reused) {
        action = "resume";
        targetConvId = reused;
      }
    }
    const shouldUseWorktree = options.useWorktree ?? Boolean(task.useWorktree);
    let activeWorktreePath = task.worktreePath;
    let activeWorktreeBranch = task.worktreeBranch;
    const source = options.source ?? "ui";
    if (shouldUseWorktree && task.workspacePath) {
      const wt = await ensureTaskWorktree(task.workspacePath, taskId);
      if (wt.ok) {
        activeWorktreePath = wt.worktreePath;
        activeWorktreeBranch = wt.worktreeBranch;
        const wtNow = this.now();
        this.db.inTransaction(() => {
          this.db.db.prepare("UPDATE tasks SET use_worktree = 1, worktree_path = ?, worktree_branch = ?, updated_at = ? WHERE id = ?").run(wt.worktreePath, wt.worktreeBranch, wtNow, taskId);
          this.appendEvent(
            taskId,
            "worktree_ready",
            source,
            { worktreePath: wt.worktreePath, worktreeBranch: wt.worktreeBranch, reused: wt.reused },
            { createdAt: wtNow }
          );
          this.notifyRevision();
        });
      } else if (wt.reason === "not-git-repo") {
        this.db.inTransaction(() => {
          this.appendEvent(taskId, "worktree_skipped", source, { reason: wt.reason, message: wt.message });
          this.notifyRevision();
        });
      } else {
        throw new DomainError("worktree-failed", wt.message);
      }
    }
    const worktreeDirective = activeWorktreePath ? `Work strictly inside the isolated git worktree directory: ${activeWorktreePath}${activeWorktreeBranch ? ` (branch: ${activeWorktreeBranch})` : ""}.` : void 0;
    const combinedExtraInstruction = [worktreeDirective, options.extraInstruction?.trim()].filter(Boolean).join("\n\n") || void 0;
    const latestTaskForPrompt = activeWorktreePath !== task.worktreePath ? this.getTask(taskId) ?? task : task;
    const promptText = action === "rework" ? buildReworkPrompt(latestTaskForPrompt, options.reworkInstructions, subgoal) : buildDispatchPrompt(latestTaskForPrompt, { subgoal, extraInstruction: combinedExtraInstruction });
    const executionId = randomUUID();
    const startedAt = this.now();
    const runGroupId = options.runGroupId ?? taskId;
    const dispatchLockPath = this.db.dbPath && this.db.dbPath !== ":memory:" ? join6(dirname3(this.db.dbPath), `dispatch.lock.${executionId}`) : void 0;
    const releaseDispatchLock = () => {
      if (!dispatchLockPath) return;
      try {
        if (existsSync6(dispatchLockPath)) unlinkSync2(dispatchLockPath);
      } catch {
      }
    };
    this.db.inTransaction(() => {
      const concurrentOpen = this.db.db.prepare("SELECT 1 FROM task_executions WHERE task_id = ? AND ended_at IS NULL LIMIT 1").get(taskId);
      if (concurrentOpen) {
        throw new DomainError("execution-open", "Task already has an open running execution.");
      }
      if (dispatchLockPath) {
        try {
          writeFileSync(dispatchLockPath, String(process.pid), "utf8");
        } catch {
        }
      }
      const rec = reconcilePhaseStatus("active", "running");
      this.db.db.prepare(
        `INSERT INTO task_executions (id, task_id, subgoal_id, conversation_id, workspace_id, started_at, initiated_by, rework_instructions, frozen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        executionId,
        taskId,
        subgoal?.id ?? null,
        targetConvId ?? null,
        projectId ?? task.workspaceId ?? null,
        startedAt,
        options.initiatedBy ?? source,
        action === "rework" ? options.reworkInstructions.trim() : null,
        task.freeze?.frozenAt ?? null
      );
      if (targetConvId) {
        this.db.db.prepare(
          `INSERT INTO task_conversations (task_id, subgoal_id, conversation_id, role, workspace_id, linked_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(task_id, subgoal_id, conversation_id) DO UPDATE SET linked_at = excluded.linked_at`
        ).run(taskId, subgoal?.id ?? "", targetConvId, subgoal ? "worker" : "primary", projectId ?? task.workspaceId ?? null, startedAt);
      }
      this.db.db.prepare(
        "UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = NULL, reasoning_effort = COALESCE(?, reasoning_effort), updated_at = ? WHERE id = ?"
      ).run(rec.phase, rec.subPhase, rec.status, options.reasoningEffort?.trim() || null, startedAt, taskId);
      if (subgoal && subgoal.status === "open") {
        this.db.db.prepare("UPDATE task_subgoals SET status = 'in_progress' WHERE id = ? AND task_id = ?").run(subgoal.id, taskId);
      }
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
    return new Promise((resolve7, reject) => {
      this.admissionQueue.enqueue({
        groupId: runGroupId,
        start: async () => {
          try {
            const launchResult = action === "new" ? await this.agentBridge.startConversation({
              prompt: promptText,
              title: subgoal ? `${task.title} \xB7 ${subgoal.title}` : task.title,
              model: options.model ?? task.model,
              profile: options.profile ?? task.handover?.mode ?? task.mode,
              projectId,
              tags: task.tags.length > 0 ? task.tags.map((t) => t.name) : void 0
            }) : await this.agentBridge.sendMessage({
              conversationId: targetConvId,
              message: promptText,
              title: subgoal ? `${task.title} \xB7 ${subgoal.title}` : task.title,
              projectId
            });
            const convId = launchResult.conversationId;
            const now = this.now();
            this.db.inTransaction(() => {
              this.db.db.prepare("UPDATE task_executions SET conversation_id = ? WHERE id = ?").run(convId, executionId);
              this.db.db.prepare(
                `INSERT INTO task_conversations (task_id, subgoal_id, conversation_id, role, workspace_id, linked_at)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(task_id, subgoal_id, conversation_id) DO UPDATE SET linked_at = excluded.linked_at`
              ).run(taskId, subgoal?.id ?? "", convId, subgoal ? "worker" : "primary", projectId ?? task.workspaceId ?? null, now);
              this.appendEvent(
                taskId,
                action === "new" ? "task_dispatched" : action === "rework" ? "task_reworked" : "task_resumed",
                source,
                { executionId, conversationId: convId, projectId, subgoalId: subgoal?.id, worktreePath: activeWorktreePath },
                { subgoalId: subgoal?.id, conversationId: convId, createdAt: now }
              );
              this.notifyRevision();
            });
            this.syncTaskSpaceProjection(taskId);
            resolve7({ task: this.getTask(taskId), executionId, conversationId: convId, action });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const now = this.now();
            this.db.inTransaction(() => {
              this.db.db.prepare("UPDATE task_executions SET ended_at = ?, result = 'failed', error = ? WHERE id = ?").run(now, msg, executionId);
              const rec = reconcilePhaseStatus("needs_you", "blocked");
              this.db.db.prepare("UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?").run(rec.phase, rec.subPhase, rec.status, msg, now, taskId);
              this.clearSnoozeForTask(taskId, now);
              this.appendEvent(taskId, "dispatch_failed", source, { executionId, error: msg }, { subgoalId: subgoal?.id, createdAt: now });
              this.notifyRevision();
            });
            this.syncTaskSpaceProjection(taskId);
            reject(err);
          } finally {
            releaseDispatchLock();
          }
        },
        abandon: () => {
          try {
            const now = this.now();
            this.db.inTransaction(() => {
              this.db.db.prepare("UPDATE task_executions SET ended_at = ?, result = 'cancelled', error = 'Queue drained before launch' WHERE id = ?").run(now, executionId);
              const rec = reconcilePhaseStatus("on_hold", "paused");
              this.db.db.prepare("UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?").run(rec.phase, rec.subPhase, rec.status, "Launch abandoned on shutdown", now, taskId);
              this.notifyRevision();
            });
            this.syncTaskSpaceProjection(taskId);
          } finally {
            releaseDispatchLock();
          }
          reject(new DomainError("launch-abandoned", "Launch abandoned because queue drained."));
        }
      });
    });
  }
  async getTaskWorktreeDiff(taskId) {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    if (!task.worktreePath) {
      throw new DomainError("no-worktree", `Task '${taskId}' does not have an attached git worktree.`);
    }
    return getTaskWorktreeDiff(task.worktreePath);
  }
  async cleanupTaskWorktree(taskId, force = false, source = "ui") {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    if (!task.worktreePath) return task;
    const res = await cleanupTaskWorktree(task.workspacePath, task.worktreePath, task.worktreeBranch, force);
    if (!res.ok) {
      throw new DomainError("worktree-cleanup-failed", res.message);
    }
    const now = this.now();
    this.db.inTransaction(() => {
      this.db.db.prepare("UPDATE tasks SET worktree_path = NULL, worktree_branch = NULL, updated_at = ? WHERE id = ?").run(now, taskId);
      this.appendEvent(
        taskId,
        "worktree_cleaned",
        source,
        { removedPath: res.removedPath, branchDeleted: res.branchDeleted },
        { createdAt: now }
      );
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
    return this.getTask(taskId);
  }
  settleExecution(taskId, outcome, options = {}) {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    const now = this.now();
    const targetExec = (options.executionId ? task.executions.find((e) => e.id === options.executionId) : void 0) ?? [...task.executions].reverse().find((e) => e.endedAt === void 0);
    const nextPhase = options.targetPhase ?? (outcome === "cancelled" ? "on_hold" : "needs_you");
    const nextSubPhase = nextPhase === "closed" ? outcome === "cancelled" ? "cancelled" : "done" : outcome === "cancelled" ? "paused" : outcome === "failed" ? "blocked" : task.subgoalRollup.readyForReview ? "review" : "needs_input";
    const rec = reconcilePhaseStatus(nextPhase, nextSubPhase);
    if (rec.phase === "closed" && rec.subPhase !== "cancelled") {
      const gate = canCloseTaskWithSubgoals(task.subgoals, Boolean(options.force));
      if (!gate.allowed) {
        throw new DomainError("required-subgoals-open", gate.reason);
      }
    }
    const completedAt = rec.phase === "closed" ? task.completedAt ?? now : null;
    const blockedReason = options.error ?? (rec.phase === "closed" ? null : rec.subPhase === "review" ? "Execution settled \u2014 ready for review" : rec.subPhase === "needs_input" ? "Execution settled \u2014 awaiting next instruction" : null);
    this.db.inTransaction(() => {
      if (targetExec && targetExec.endedAt === void 0) {
        this.db.db.prepare("UPDATE task_executions SET ended_at = ?, result = ?, error = ?, summary = ? WHERE id = ?").run(now, outcome, options.error ?? null, options.summary ?? null, targetExec.id);
      }
      if (targetExec?.conversationId && options.summary?.trim()) {
        this.db.updateConversationLinkMeta(taskId, targetExec.conversationId, targetExec.subgoalId ?? "", {
          summary: options.summary.trim(),
          ...outcome === "succeeded" ? { includeInHandoff: true } : {}
        });
      }
      this.db.db.prepare("UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, completed_at = ?, updated_at = ? WHERE id = ?").run(rec.phase, rec.subPhase, rec.status, blockedReason, completedAt, now, taskId);
      if (rec.phase === "needs_you") {
        this.clearSnoozeForTask(taskId, now);
      }
      if (rec.phase === "closed") {
        this.stopScheduleOnClose(taskId, task.schedule, now);
      }
      this.appendEvent(
        taskId,
        "execution_settled",
        options.source ?? "ui",
        { executionId: targetExec?.id, outcome, error: options.error, summary: options.summary },
        { createdAt: now }
      );
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
    return this.getTask(taskId);
  }
  // --- Schedule & Reminders ---
  cleanScheduleTransient(rule) {
    const cleaned = { ...rule };
    delete cleaned.missedSlotAt;
    delete cleaned.skippedAt;
    delete cleaned.skippedReason;
    delete cleaned.endedAt;
    delete cleaned.endedReason;
    return cleaned;
  }
  /** Closing a task is the explicit "finish and stop repeating" action. */
  stopScheduleOnClose(taskId, schedule, now) {
    if (!schedule?.enabled) return;
    const stopped = {
      ...this.cleanScheduleTransient(schedule),
      enabled: false,
      nextRunAt: void 0,
      endedAt: now,
      endedReason: "closed"
    };
    this.db.db.prepare("UPDATE tasks SET schedule_json = ? WHERE id = ?").run(JSON.stringify(stopped), taskId);
  }
  advanceScheduleNextRun(sched, fromMs, zone) {
    if (sched.mode === "cron" && sched.cron) {
      return nextRunAtMs(sched.cron, fromMs, zone);
    }
    if (sched.mode === "after_completion") {
      return void 0;
    }
    return void 0;
  }
  triggerScheduledReminder(taskId, now, source) {
    const current = this.getTask(taskId);
    if (!current) return;
    this.db.inTransaction(() => {
      if (current.phase === "todo" || current.phase === "on_hold" || current.phase === "needs_you") {
        const rec = reconcilePhaseStatus("needs_you", "reminder_due");
        this.db.db.prepare(
          `UPDATE tasks
             SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ?
             WHERE id = ?`
        ).run(rec.phase, rec.subPhase, rec.status, "Scheduled reminder due", now, taskId);
        this.clearSnoozeForTask(taskId, now);
      } else {
        this.db.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, taskId);
      }
      this.appendEvent(taskId, "schedule_reminder_due", source, {}, { createdAt: now });
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
  }
  setTaskSchedule(taskId, patch, source = "ui") {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    const now = this.now();
    if (patch === null || patch.clear === true) {
      this.db.inTransaction(() => {
        this.db.db.prepare("UPDATE tasks SET schedule_json = NULL, updated_at = ? WHERE id = ?").run(now, taskId);
        this.appendEvent(taskId, "schedule_cleared", source, {}, { createdAt: now });
        this.notifyRevision();
      });
      this.syncTaskSpaceProjection(taskId);
      return this.getTask(taskId);
    }
    const rule = this.buildScheduleRule(patch, now, task.phase, task.schedule);
    this.db.inTransaction(() => {
      this.db.db.prepare("UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(rule), now, taskId);
      this.appendEvent(taskId, "schedule_updated", source, { schedule: rule }, { createdAt: now });
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
    return this.getTask(taskId);
  }
  completeScheduleCycle(taskId, options = {}, source = "ui") {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    if (task.archivedAt !== void 0) throw new DomainError("task-archived", "Restore archived task before completing a cycle.");
    if (!task.schedule) throw new DomainError("invalid-schedule", "Task does not have an active schedule.");
    if (hasOpenExecution(task) && !options.force) {
      throw new DomainError("execution-open", "Cannot complete cycle while an execution is still running (settle or force first).");
    }
    const gate = canCloseTaskWithSubgoals(task.subgoals, Boolean(options.force));
    if (!gate.allowed) {
      throw new DomainError("required-subgoals-open", gate.reason);
    }
    const now = this.now();
    const sched = task.schedule;
    const zone = sched.timeZone ?? resolveHostTimeZone();
    let nextRule = { ...this.cleanScheduleTransient(sched), consecutiveFailures: 0 };
    if (nextRule.enabled && !scheduleExhausted(nextRule)) {
      if (nextRule.mode === "after_completion") {
        nextRule.nextRunAt = nextAfterCompletionAtMs(
          now,
          nextRule.intervalDays ?? 1,
          zone,
          nextRule.atHour,
          nextRule.atMinute
        );
      } else if (nextRule.mode === "cron" && nextRule.cron) {
        const nextTick = nextRunAtMs(nextRule.cron, now, zone);
        if (nextTick !== void 0) {
          nextRule.nextRunAt = nextTick;
        } else {
          nextRule = { ...nextRule, enabled: false, nextRunAt: void 0, endedAt: now, endedReason: "no-target" };
        }
      }
    } else if (scheduleExhausted(nextRule)) {
      nextRule = { ...nextRule, enabled: false, nextRunAt: void 0, endedAt: now, endedReason: "limit" };
    }
    const reconciled = reconcilePhaseStatus("todo", "ready");
    const clearStaleDue = task.dueAt !== void 0 && task.dueAt <= now;
    this.db.inTransaction(() => {
      this.db.db.prepare("UPDATE task_subgoals SET status = 'open', closed_at = NULL WHERE task_id = ?").run(taskId);
      this.db.db.prepare(
        `UPDATE tasks
           SET phase = ?, sub_phase = ?, status = ?,
               blocked_reason = NULL,
               completed_at = NULL,
               due_at = CASE WHEN ? THEN NULL ELSE due_at END,
               schedule_json = ?,
               updated_at = ?
           WHERE id = ?`
      ).run(
        reconciled.phase,
        reconciled.subPhase,
        reconciled.status,
        clearStaleDue ? 1 : 0,
        JSON.stringify(nextRule),
        now,
        taskId
      );
      this.appendEvent(
        taskId,
        "cycle_accepted",
        source,
        {
          round: sched.runCount,
          nextRunAt: nextRule.nextRunAt,
          ...options.note?.trim() ? { note: options.note.trim() } : {}
        },
        { createdAt: now }
      );
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
    return this.getTask(taskId);
  }
  async handleMissedSchedule(taskId, action, source = "ui") {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    if (task.archivedAt !== void 0) throw new DomainError("task-archived", "Restore archived task first.");
    const sched = task.schedule;
    if (!sched) throw new DomainError("invalid-schedule", "Task does not have a schedule.");
    const now = this.now();
    const zone = sched.timeZone ?? resolveHostTimeZone();
    if (action === "skip") {
      const updated = this.cleanScheduleTransient(sched);
      if (sched.endedReason === "missed") {
        updated.endedAt = sched.endedAt ?? now;
        updated.endedReason = "skipped";
      }
      this.db.inTransaction(() => {
        this.db.db.prepare("UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(updated), now, taskId);
        this.appendEvent(taskId, "schedule_missed_dismissed", source, { missedSlotAt: sched.missedSlotAt }, { createdAt: now });
        this.notifyRevision();
      });
      this.syncTaskSpaceProjection(taskId);
      return this.getTask(taskId);
    }
    if (hasOpenExecution(task)) {
      throw new DomainError("execution-open", "Task already has an open running execution.");
    }
    const schedAction = sched.action ?? "dispatch";
    if (schedAction === "dispatch" && requiresPermissionConfirmation(task, this.sessionDefaultPermission)) {
      throw new DomainError(
        "confirmation-required",
        "Elevated permission requires human confirmation in the board UI before dispatch."
      );
    }
    const nextCount = sched.runCount + 1;
    let nextRule = {
      ...this.cleanScheduleTransient(sched),
      lastTriggeredAt: now,
      runCount: nextCount,
      consecutiveFailures: 0
    };
    if (sched.mode === "once" || scheduleExhausted(nextRule)) {
      nextRule = {
        ...nextRule,
        enabled: false,
        nextRunAt: void 0,
        endedAt: now,
        endedReason: sched.mode === "once" ? "fired" : "limit"
      };
    } else if (sched.mode === "after_completion") {
      nextRule.nextRunAt = void 0;
    } else if (sched.cron) {
      const future = nextRule.nextRunAt !== void 0 && nextRule.nextRunAt > now ? nextRule.nextRunAt : nextRunAtMs(sched.cron, now, zone);
      if (future !== void 0) {
        nextRule.nextRunAt = future;
      } else {
        nextRule = { ...nextRule, enabled: false, nextRunAt: void 0, endedAt: now, endedReason: "no-target" };
      }
    }
    this.db.inTransaction(() => {
      this.db.db.prepare("UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(nextRule), now, taskId);
      this.appendEvent(
        taskId,
        "schedule_caught_up",
        source,
        { scheduledFor: sched.missedSlotAt ?? sched.skippedAt ?? now },
        { createdAt: now }
      );
      this.notifyRevision();
    });
    if (schedAction === "remind") {
      this.triggerScheduledReminder(taskId, now, source);
    } else {
      const dispatchMode = sched.sessionMode ?? (sched.mode === "once" ? "auto" : "new");
      await this.dispatchTask(taskId, { mode: dispatchMode, source, initiatedBy: source });
    }
    return this.getTask(taskId);
  }
  skipScheduleCycle(taskId, source = "ui") {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    const sched = task.schedule;
    if (!sched) throw new DomainError("invalid-schedule", "Task does not have a schedule.");
    const now = this.now();
    const zone = sched.timeZone ?? resolveHostTimeZone();
    const baseCursor = Math.max(now, sched.nextRunAt ?? now);
    let updated = {
      ...this.cleanScheduleTransient(sched),
      skippedAt: now,
      skippedReason: "skipped"
    };
    if (sched.mode === "cron" && sched.cron) {
      const nextTick = nextRunAtMs(sched.cron, baseCursor, zone);
      updated = nextTick !== void 0 ? { ...updated, nextRunAt: nextTick } : { ...updated, enabled: false, nextRunAt: void 0, endedAt: now, endedReason: "no-target" };
    } else if (sched.mode === "after_completion") {
      updated.nextRunAt = nextAfterCompletionAtMs(baseCursor, sched.intervalDays ?? 1, zone, sched.atHour, sched.atMinute);
    } else {
      updated = { ...updated, enabled: false, nextRunAt: void 0, endedAt: now, endedReason: "skipped" };
    }
    this.db.inTransaction(() => {
      this.db.db.prepare("UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(updated), now, taskId);
      this.appendEvent(taskId, "schedule_cycle_skipped", source, { skippedFor: sched.nextRunAt, nextRunAt: updated.nextRunAt }, { createdAt: now });
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
    return this.getTask(taskId);
  }
  async runScheduleNow(taskId, source = "ui") {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    if (task.archivedAt !== void 0) throw new DomainError("task-archived", "Restore archived task first.");
    const sched = task.schedule;
    if (!sched) throw new DomainError("invalid-schedule", "Task does not have a schedule.");
    if (hasOpenExecution(task)) {
      throw new DomainError("execution-open", "Task already has an open running execution.");
    }
    const schedAction = sched.action ?? "dispatch";
    if (schedAction === "dispatch" && requiresPermissionConfirmation(task, this.sessionDefaultPermission)) {
      throw new DomainError(
        "confirmation-required",
        "Elevated permission requires human confirmation in the board UI before dispatch."
      );
    }
    const now = this.now();
    const nextCount = sched.runCount + 1;
    let nextRule = {
      ...this.cleanScheduleTransient(sched),
      lastTriggeredAt: now,
      runCount: nextCount,
      consecutiveFailures: 0
    };
    if (sched.mode === "once") {
      const futureAt = sched.at !== void 0 && sched.at > now ? sched.at : void 0;
      if (sched.enabled && futureAt !== void 0) {
        nextRule.enabled = true;
        nextRule.nextRunAt = futureAt;
      } else {
        nextRule.enabled = false;
        nextRule.nextRunAt = void 0;
      }
    } else if (sched.maxRuns !== void 0 && nextCount >= sched.maxRuns) {
      nextRule = {
        ...nextRule,
        enabled: false,
        nextRunAt: void 0,
        endedAt: now,
        endedReason: "limit"
      };
    }
    this.db.inTransaction(() => {
      this.db.db.prepare("UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(nextRule), now, taskId);
      this.appendEvent(taskId, "schedule_run_now", source, { runCount: nextCount }, { createdAt: now });
      this.notifyRevision();
    });
    if (schedAction === "remind") {
      this.triggerScheduledReminder(taskId, now, source);
    } else {
      const dispatchMode = sched.sessionMode ?? "new";
      await this.dispatchTask(taskId, { mode: dispatchMode, source, initiatedBy: source });
    }
    return this.getTask(taskId);
  }
  setTaskReminder(taskId, reminderAt, source = "ui") {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError("task-not-found", `No task with id '${taskId}'.`);
    const now = this.now();
    const clearReminderReason = (reminderAt === null || reminderAt > now) && task.subPhase === "reminder_due" && task.blockedReason === "Reminder due";
    this.db.inTransaction(() => {
      this.db.db.prepare(
        `UPDATE tasks
           SET reminder_at = ?, reminded_at = NULL,
               blocked_reason = CASE WHEN ? THEN NULL ELSE blocked_reason END,
               updated_at = ?
           WHERE id = ?`
      ).run(reminderAt === null ? null : Math.trunc(reminderAt), clearReminderReason ? 1 : 0, now, taskId);
      this.appendEvent(taskId, "reminder_updated", source, { reminderAt }, { createdAt: now });
      this.notifyRevision();
    });
    this.syncTaskSpaceProjection(taskId);
    return this.getTask(taskId);
  }
  async runSchedulerTick(now = this.now()) {
    const tasks = this.db.listTasks({ includeArchived: false });
    const firedReminders = [];
    const firedSchedules = [];
    const missedWindowMs = 5 * 60 * 1e3;
    const catchUpMaxAgeMs = 7 * 864e5;
    const dueTriggers = [];
    for (const task of tasks) {
      if (task.reminderAt !== void 0 && task.reminderAt <= now && (task.remindedAt === void 0 || task.remindedAt < task.reminderAt) && task.phase !== "closed") {
        let reminderClaimed = false;
        this.db.inTransaction(() => {
          const shouldSurface = task.phase === "todo" || task.phase === "on_hold";
          const rec = shouldSurface ? reconcilePhaseStatus("needs_you", "reminder_due") : null;
          const res = rec ? this.db.db.prepare(
            `UPDATE tasks
                   SET reminded_at = ?, phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ?
                   WHERE id = ? AND reminder_at IS NOT NULL AND reminder_at <= ? AND (reminded_at IS NULL OR reminded_at < reminder_at)`
          ).run(now, rec.phase, rec.subPhase, rec.status, "Reminder due", now, task.id, now) : this.db.db.prepare(
            `UPDATE tasks
                   SET reminded_at = ?, updated_at = ?
                   WHERE id = ? AND reminder_at IS NOT NULL AND reminder_at <= ? AND (reminded_at IS NULL OR reminded_at < reminder_at)`
          ).run(now, now, task.id, now);
          if (res.changes > 0) {
            reminderClaimed = true;
            if (rec) {
              this.clearSnoozeForTask(task.id, now);
            }
            this.appendEvent(task.id, "reminder_due", "scheduler", { reminderAt: task.reminderAt }, { createdAt: now });
            this.notifyRevision();
          }
        });
        if (reminderClaimed) {
          this.syncTaskSpaceProjection(task.id);
          firedReminders.push(task.id);
        }
      }
      const sched = task.schedule;
      if (!sched || !sched.enabled || sched.nextRunAt === void 0 || sched.nextRunAt > now) continue;
      if (task.phase === "closed" && !isRecurringSchedule(sched)) continue;
      const zone = sched.timeZone ?? resolveHostTimeZone();
      const schedAction = sched.action ?? "dispatch";
      let caughtUpFrom;
      if (now - sched.nextRunAt > missedWindowMs) {
        const misfirePolicy = sched.misfirePolicy ?? "prompt";
        if (misfirePolicy === "catch_up_once" && now - sched.nextRunAt <= catchUpMaxAgeMs) {
          caughtUpFrom = sched.nextRunAt;
        } else if (misfirePolicy === "skip") {
          const updatedRule = sched.mode === "once" ? { ...this.cleanScheduleTransient(sched), enabled: false, nextRunAt: void 0, endedAt: now, endedReason: "skipped", skippedAt: now, skippedReason: "skipped" } : {
            ...this.cleanScheduleTransient(sched),
            skippedAt: now,
            skippedReason: "skipped",
            nextRunAt: this.advanceScheduleNextRun(sched, now, zone)
          };
          this.db.inTransaction(() => {
            this.db.db.prepare("UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(updatedRule), now, task.id);
            this.appendEvent(task.id, "schedule_missed", "scheduler", { scheduledFor: sched.nextRunAt, policy: "skip" }, { createdAt: now });
            this.notifyRevision();
          });
          continue;
        } else {
          if (sched.skippedReason === "missed" && sched.missedSlotAt === sched.nextRunAt) continue;
          const updatedRule = sched.mode === "once" ? {
            ...this.cleanScheduleTransient(sched),
            // Keep enabled and keep the missed slot so /schedule/catch-up
            // can still run it; do not mark endedAt.
            missedSlotAt: sched.nextRunAt,
            skippedAt: now,
            skippedReason: "missed"
          } : {
            ...this.cleanScheduleTransient(sched),
            missedSlotAt: sched.nextRunAt,
            skippedAt: now,
            skippedReason: "missed",
            nextRunAt: this.advanceScheduleNextRun(sched, now, zone)
          };
          this.db.inTransaction(() => {
            this.db.db.prepare("UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(updatedRule), now, task.id);
            this.appendEvent(
              task.id,
              "schedule_missed",
              "scheduler",
              { scheduledFor: sched.nextRunAt, policy: "prompt", surfaced: true },
              { createdAt: now }
            );
            this.notifyRevision();
          });
          continue;
        }
      }
      if (hasOpenExecution(task)) {
        const updatedRule = {
          ...sched,
          skippedAt: now,
          skippedReason: "busy",
          nextRunAt: this.advanceScheduleNextRun(sched, now, zone),
          ...sched.mode === "once" ? { enabled: false, endedAt: now, endedReason: "busy" } : {}
        };
        this.db.inTransaction(() => {
          this.db.db.prepare("UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(updatedRule), now, task.id);
          this.notifyRevision();
        });
        continue;
      }
      if (task.phase === "needs_you" && sched.overlapPolicy !== "allow_replace" && sched.skippedReason !== "launch-failed") {
        const updatedRule = {
          ...sched,
          skippedAt: now,
          skippedReason: "awaiting-review",
          nextRunAt: this.advanceScheduleNextRun(sched, now, zone),
          ...sched.mode === "once" ? { enabled: false, endedAt: now, endedReason: "awaiting-review" } : {}
        };
        this.db.inTransaction(() => {
          this.db.db.prepare("UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(updatedRule), now, task.id);
          this.appendEvent(task.id, "schedule_held_for_review", "scheduler", { scheduledFor: sched.nextRunAt }, { createdAt: now });
          this.notifyRevision();
        });
        continue;
      }
      if (schedAction === "dispatch" && requiresPermissionConfirmation(task, this.sessionDefaultPermission)) {
        const updatedRule = {
          ...sched,
          skippedAt: now,
          skippedReason: "permission",
          nextRunAt: this.advanceScheduleNextRun(sched, now, zone),
          ...sched.mode === "once" ? { enabled: false, endedAt: now, endedReason: "permission" } : {}
        };
        this.db.inTransaction(() => {
          this.db.db.prepare("UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(updatedRule), now, task.id);
          this.notifyRevision();
        });
        continue;
      }
      const nextCount = sched.runCount + 1;
      let nextRule = {
        ...this.cleanScheduleTransient(sched),
        lastTriggeredAt: now,
        runCount: nextCount,
        consecutiveFailures: 0
      };
      if (sched.mode === "once" || scheduleExhausted(nextRule)) {
        nextRule = {
          ...nextRule,
          enabled: false,
          nextRunAt: void 0,
          endedAt: now,
          endedReason: sched.mode === "once" ? "fired" : "limit"
        };
      } else if (sched.mode === "after_completion") {
        nextRule = {
          ...nextRule,
          nextRunAt: void 0
        };
      } else {
        const nextTick = sched.cron ? nextRunAtMs(sched.cron, now, zone) : void 0;
        nextRule = nextTick ? { ...nextRule, nextRunAt: nextTick } : { ...nextRule, enabled: false, nextRunAt: void 0, endedAt: now, endedReason: "no-target" };
      }
      let claimed = false;
      this.db.inTransaction(() => {
        const res = this.db.db.prepare("UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ? AND schedule_json = ?").run(JSON.stringify(nextRule), now, task.id, JSON.stringify(sched));
        if (res.changes > 0) {
          claimed = true;
          if (caughtUpFrom !== void 0) {
            this.appendEvent(task.id, "schedule_caught_up", "scheduler", { scheduledFor: caughtUpFrom }, { createdAt: now });
          }
          this.notifyRevision();
        }
      });
      if (claimed) {
        dueTriggers.push({ taskId: task.id, sched, zone, caughtUpFrom });
      }
    }
    if (dueTriggers.length > 0) {
      const concurrency = Math.max(1, Math.min(this.maxConcurrentLaunches, 4));
      let cursor = 0;
      const runWorker = async () => {
        while (cursor < dueTriggers.length) {
          const item = dueTriggers[cursor++];
          const { taskId, sched, zone } = item;
          const schedAction = sched.action ?? "dispatch";
          if (schedAction === "remind") {
            this.triggerScheduledReminder(taskId, now, "scheduler");
            firedSchedules.push(taskId);
            continue;
          }
          try {
            const dispatchMode = sched.sessionMode ?? (sched.mode === "once" ? "auto" : "new");
            await this.dispatchTask(taskId, { mode: dispatchMode, source: "scheduler", initiatedBy: "scheduler" });
            firedSchedules.push(taskId);
          } catch (err) {
            const refundedNextRun = sched.mode === "cron" && sched.cron ? nextRunAtMs(sched.cron, now, zone) : sched.mode === "after_completion" && sched.nextRunAt !== void 0 ? sched.nextRunAt : sched.mode === "once" ? sched.at ?? sched.nextRunAt : void 0;
            const failures = (sched.consecutiveFailures ?? 0) + 1;
            const tripped = failures >= 3;
            this.db.inTransaction(() => {
              const refunded = {
                ...sched,
                enabled: tripped ? false : refundedNextRun !== void 0 ? sched.enabled : false,
                nextRunAt: tripped ? void 0 : refundedNextRun,
                runCount: sched.runCount,
                endedAt: tripped ? now : refundedNextRun !== void 0 ? void 0 : now,
                endedReason: tripped ? "launch-failed" : refundedNextRun !== void 0 ? void 0 : "launch-failed",
                skippedAt: now,
                skippedReason: "launch-failed",
                consecutiveFailures: failures
              };
              this.db.db.prepare("UPDATE tasks SET schedule_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(refunded), now, taskId);
              this.appendEvent(
                taskId,
                tripped ? "schedule_circuit_open" : "schedule_launch_failed",
                "scheduler",
                { failures, error: err instanceof Error ? err.message : String(err) },
                { createdAt: now }
              );
              if (tripped) {
                const rec = reconcilePhaseStatus("needs_you", "blocked");
                this.db.db.prepare("UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?").run(
                  rec.phase,
                  rec.subPhase,
                  rec.status,
                  `Scheduled launch failed ${failures} times; automatic scheduling paused.`,
                  now,
                  taskId
                );
                this.clearSnoozeForTask(taskId, now);
              }
              this.notifyRevision();
            });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, dueTriggers.length) }, () => runWorker()));
    }
    return { firedReminders, firedSchedules };
  }
  realPathOrSelf(rawPath) {
    const resolved = resolve4(rawPath);
    try {
      if (existsSync6(resolved)) return normalizeFsPath(realpathSync2(resolved));
      const parent = dirname3(resolved);
      if (existsSync6(parent)) {
        return normalizeFsPath(join6(realpathSync2(parent), resolved.slice(parent.length).replace(/^[\\/]+/, "")));
      }
    } catch {
    }
    return normalizeFsPath(resolved);
  }
  resolveTargetPath(rawTarget, cwdStr, fallbackWorkspace) {
    let cleaned = rawTarget.trim();
    if (cleaned.toLowerCase().startsWith("file://")) {
      cleaned = fileUriToPath(cleaned);
    }
    const baseDir = cwdStr?.trim() || fallbackWorkspace?.trim();
    const resolved = !isAbsolute2(cleaned) && baseDir ? resolve4(baseDir, cleaned) : resolve4(cleaned);
    return this.realPathOrSelf(resolved);
  }
  findProtectedTargetHit(toolName, args, cwdStr, linkedTasks) {
    const realDbPath = this.paths.dbPath && this.paths.dbPath !== ":memory:" ? this.realPathOrSelf(this.paths.dbPath) : "";
    const dbKey = realDbPath ? pathComparisonKey(realDbPath) : "";
    const rawTaskspaceDir = this.taskSpaceDir();
    const taskspaceDir = rawTaskspaceDir ? this.realPathOrSelf(rawTaskspaceDir) : void 0;
    const taskspaceKey = taskspaceDir ? pathComparisonKey(taskspaceDir) : "";
    const realBoardDir = this.paths.boardDir ? this.realPathOrSelf(this.paths.boardDir) : void 0;
    const handoverTargets = [];
    for (const t of linkedTasks) {
      const wsReal = t.workspacePath ? this.realPathOrSelf(t.workspacePath) : "";
      const workspaceKey = wsReal ? pathComparisonKey(wsReal) : "";
      for (const href of t.handover?.references ?? []) {
        if (/^https?:\/\//i.test(href.trim())) continue;
        const refCheck = resolveAllowedRefPath(href, t.workspacePath ?? cwdStr);
        if (!refCheck.ok) continue;
        const refReal = this.resolveTargetPath(refCheck.path, cwdStr, t.workspacePath);
        const key = pathComparisonKey(refReal);
        if (key) handoverTargets.push({ href, realPath: refReal, key, workspaceKey });
      }
    }
    const checkCandidatePath = (rawPath) => {
      const resolved = this.resolveTargetPath(rawPath, cwdStr, linkedTasks[0]?.workspacePath);
      const candKey = pathComparisonKey(resolved);
      if (!candKey) return void 0;
      if (dbKey && (candKey === dbKey || candKey === `${dbKey}-wal` || candKey === `${dbKey}-shm` || candKey === `${dbKey}-journal`)) {
        return "board.db SQLite storage is protected from direct tool writes.";
      }
      if (taskspaceKey && taskspaceDir && isPathEqualOrInside(resolved, taskspaceDir)) {
        return "TaskSpace projection files under taskspace/ are read-only.";
      }
      for (const ref of handoverTargets) {
        if (candKey === ref.key || isPathEqualOrInside(resolved, ref.realPath)) {
          return `Handover reference '${ref.href}' is read-only and cannot be modified.`;
        }
      }
      return void 0;
    };
    const fileKeys = ["TargetFile", "AbsolutePath", "Path", "path", "file_path", "target_file", "TargetDirectory"];
    for (const key of fileKeys) {
      const val = args[key];
      if (typeof val === "string" && val.trim()) {
        const hit = checkCandidatePath(val);
        if (hit) return hit;
      }
    }
    if (toolName === "run_command" || toolName === "send_command_input") {
      const cmd = String(args.CommandLine ?? args.Input ?? "");
      if (cmd.trim()) {
        const lowerCmd = cmd.replace(/\\/g, "/").toLowerCase();
        const mutatingShell = /(>>|>|\brm\b|\brmdir\b|\brd\b|\bdel\b|\berase\b|\bmv\b|\bmove\b|\bren\b|\bcp\b|\bcopy\b|\bsed\s+-i|\btee\b|\bsqlite3\b|\bpython|\bnode\b|\bpowershell|\bpwsh\b|\bunlink\b|\btruncate\b|set-content|add-content|out-file|remove-item|rename-item)/i.test(
          cmd
        );
        if (mutatingShell) {
          if (dbKey && (lowerCmd.includes(dbKey) || /\bboard\.db\b/.test(lowerCmd))) {
            return "Shell mutation targeting board.db is blocked by Write Gate.";
          }
          const resolvedCwd = cwdStr ? this.realPathOrSelf(cwdStr) : "";
          const cwdKey = resolvedCwd ? pathComparisonKey(resolvedCwd) : "";
          const boardKey = realBoardDir ? pathComparisonKey(realBoardDir) : "";
          const inBoardDir = Boolean(
            cwdKey && boardKey && realBoardDir && (cwdKey === boardKey || isPathEqualOrInside(resolvedCwd, realBoardDir))
          );
          if (taskspaceKey && (lowerCmd.includes(taskspaceKey) || inBoardDir && /(?:^|[\s"'\\/])taskspace(?:$|[\s"'\\/])/i.test(lowerCmd))) {
            return "Shell mutation targeting read-only taskspace/ projection is blocked by Write Gate.";
          }
          for (const ref of handoverTargets) {
            const relUnix = ref.href.trim().replace(/\\/g, "/").toLowerCase();
            const cwdInsideRefWs = Boolean(cwdKey && ref.workspaceKey && (cwdKey === ref.workspaceKey || cwdKey.startsWith(`${ref.workspaceKey}/`)));
            if (lowerCmd.includes(ref.key) || cwdInsideRefWs && relUnix && lowerCmd.includes(relUnix)) {
              return `Shell mutation targeting read-only handover reference '${ref.href}' is blocked by Write Gate.`;
            }
          }
        }
      }
    }
    return void 0;
  }
  // --- Antigravity Hook Integration ---
  handleHookEvent(payload) {
    const hookEventName = String(payload.hookEventName ?? "");
    const directConv = typeof payload.conversationId === "string" ? payload.conversationId.trim() : "";
    let parentConv = typeof payload.parentConversationId === "string" ? payload.parentConversationId.trim() : "";
    let rootConv = typeof payload.rootConversationId === "string" ? payload.rootConversationId.trim() : "";
    let nestingDepth = 0;
    let ancestorChain = [];
    if (directConv && (!parentConv || !rootConv)) {
      const lineage = resolveConversationLineage(this.paths, directConv);
      if (!parentConv && lineage.parentConversationId) parentConv = lineage.parentConversationId;
      if (!rootConv && lineage.rootConversationId) rootConv = lineage.rootConversationId;
      nestingDepth = lineage.nestingDepth;
      ancestorChain = lineage.ancestors;
    }
    const lookupActiveTasks = (convId) => convId ? this.db.findTasksByConversationId(convId).filter((t) => t.archivedAt === void 0) : [];
    let linkedTasks = lookupActiveTasks(directConv);
    const isSubagentInvocation = Boolean(
      parentConv || nestingDepth > 0 || rootConv && directConv && rootConv !== directConv
    );
    if (linkedTasks.length === 0 && hookEventName !== "Stop") {
      const fallbacks = [parentConv, ...ancestorChain, rootConv].filter(Boolean);
      for (const candidate of fallbacks) {
        linkedTasks = lookupActiveTasks(candidate);
        if (linkedTasks.length > 0) break;
      }
    }
    if (hookEventName === "PreToolUse") {
      const toolCall = payload.toolCall ?? {};
      const toolName = String(toolCall.name ?? "").toLowerCase();
      const args = toolCall.args ?? {};
      const cwdStr = typeof payload.cwd === "string" ? payload.cwd : void 0;
      const writeTools = /* @__PURE__ */ new Set([
        "write_to_file",
        "replace_file_content",
        "multi_replace_file_content",
        "run_command",
        "edit_file",
        "write_file",
        "delete_file",
        "send_command_input"
      ]);
      if (writeTools.has(toolName)) {
        const protectedReason = this.findProtectedTargetHit(toolName, args, cwdStr, linkedTasks);
        if (protectedReason) {
          return { decision: "deny", reason: protectedReason };
        }
      }
    }
    if (linkedTasks.length === 0) {
      if (hookEventName === "PreToolUse" || hookEventName === "Stop") {
        return { decision: "allow" };
      }
      return {};
    }
    const conversationId = directConv || parentConv || rootConv;
    const primaryTask = linkedTasks[0];
    if (hookEventName === "SessionStart") {
      const lines = [
        `[agy-board linked task] ${primaryTask.title} (id: ${primaryTask.id}, phase: ${primaryTask.phase})`,
        ...primaryTask.workspacePath ? [`Workspace: ${primaryTask.workspacePath}`] : [],
        ...primaryTask.worktreePath ? [`Worktree: ${primaryTask.worktreePath}`] : [],
        ...primaryTask.freeze ? [`Goal: ${primaryTask.freeze.goal}`, `Progress: ${primaryTask.freeze.progress}`, `Next: ${primaryTask.freeze.next}`] : [],
        ...primaryTask.subgoals.length > 0 ? [
          `Subgoals: ${primaryTask.subgoals.map((s) => `${s.status === "done" ? "[x]" : s.status === "skipped" ? "[-]" : "[ ]"} ${s.title}${s.required ? " (required)" : ""}`).join(" | ")}`
        ] : []
      ];
      return {
        injectSteps: [{ systemMessage: { systemMessage: lines.join("\n") } }]
      };
    }
    if (hookEventName === "PreToolUse") {
      const toolCall = payload.toolCall ?? {};
      const toolName = String(toolCall.name ?? "").toLowerCase();
      const args = toolCall.args ?? {};
      if (toolName === "ask_question") {
        const now = this.now();
        const rec = reconcilePhaseStatus("needs_you", "needs_input");
        const updatedTaskIds = [];
        this.db.inTransaction(() => {
          let changed = false;
          for (const task of linkedTasks) {
            if (task.phase === "closed") continue;
            this.db.db.prepare("UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?").run(rec.phase, rec.subPhase, rec.status, "Waiting for user answer (ask_question)", now, task.id);
            this.clearSnoozeForTask(task.id, now);
            this.appendEvent(
              task.id,
              "hook_ask_question",
              "hook",
              { previousPhase: task.phase, previousSubPhase: task.subPhase },
              { conversationId, createdAt: now }
            );
            updatedTaskIds.push(task.id);
            changed = true;
          }
          if (changed) this.notifyRevision();
        });
        for (const id of updatedTaskIds) this.syncTaskSpaceProjection(id);
        return { decision: "allow" };
      }
      const normalizedTool = toolName.includes("/") ? toolName.split("/").pop() : toolName;
      const isBoardMutation = normalizedTool === "board_transition" || normalizedTool.endsWith("_board_transition") || normalizedTool === "board_update" || normalizedTool.endsWith("_board_update") || normalizedTool === "board_archive" || normalizedTool.endsWith("_board_archive") || normalizedTool === "board_delete" || normalizedTool.endsWith("_board_delete");
      if (isBoardMutation) {
        const targetTaskId = typeof args.taskId === "string" ? args.taskId.trim() : void 0;
        const lockedTask = linkedTasks.find(
          (t) => t.writeGate === "locked" && (!targetTaskId || t.id === targetTaskId)
        );
        const targetTask = targetTaskId ? this.db.getTask(targetTaskId) : void 0;
        const effectiveLocked = lockedTask ?? (linkedTasks.some((t) => t.writeGate === "locked") && targetTask?.writeGate === "locked" ? targetTask : void 0);
        if (effectiveLocked) {
          const patchArgs = args.patch && typeof args.patch === "object" ? args.patch : args;
          const isDelete = normalizedTool === "board_delete" || normalizedTool.endsWith("_board_delete");
          const isArchive = normalizedTool === "board_archive" || normalizedTool.endsWith("_board_archive") || (normalizedTool === "board_transition" || normalizedTool.endsWith("_board_transition")) && args.action === "archive";
          const isClosing = (normalizedTool === "board_transition" || normalizedTool.endsWith("_board_transition")) && args.phase === "closed";
          const isUnlocking = (normalizedTool === "board_update" || normalizedTool.endsWith("_board_update")) && patchArgs.writeGate === "unlocked";
          if (isDelete || isArchive || isClosing || isUnlocking) {
            return {
              decision: "deny",
              reason: `agy-board Write Gate is LOCKED on task "${effectiveLocked.title}" (${effectiveLocked.id}). Closing, archiving, deleting, or unlocking writeGate from a locked conversation is denied.`
            };
          }
        }
        return { decision: "allow" };
      }
      const writeTools = /* @__PURE__ */ new Set([
        "write_to_file",
        "replace_file_content",
        "multi_replace_file_content",
        "run_command",
        "edit_file",
        "write_file",
        "delete_file",
        "send_command_input"
      ]);
      if (writeTools.has(toolName)) {
        const lockedTask = linkedTasks.find(
          (t) => t.writeGate === "locked" && (t.phase === "active" || t.phase === "needs_you")
        );
        if (lockedTask) {
          return {
            decision: "deny",
            reason: `agy-board Write Gate is LOCKED on task "${lockedTask.title}" (${lockedTask.id}). Unlock it in Agy Board before modifying files or running mutating commands.`
          };
        }
        const hasActiveOrNeedsYou = linkedTasks.some((t) => t.phase === "active" || t.phase === "needs_you");
        if (!hasActiveOrNeedsYou) {
          const pausedOrClosed = linkedTasks.find((t) => t.phase === "on_hold" || t.phase === "closed");
          if (pausedOrClosed) {
            return {
              decision: "ask",
              reason: `Linked agy-board task "${pausedOrClosed.title}" is currently ${pausedOrClosed.phase}. Confirm before modifying workspace files.`
            };
          }
        }
      }
      return { decision: "allow" };
    }
    if (hookEventName === "PostToolUse") {
      const toolCall = payload.toolCall ?? {};
      const toolName = String(toolCall.name ?? "");
      const lowerName = toolName.toLowerCase();
      const args = toolCall.args ?? {};
      const now = this.now();
      if (lowerName === "ask_question") {
        if (payload.error) {
          this.db.inTransaction(() => {
            this.appendEvent(
              primaryTask.id,
              "hook_tool_error",
              "hook",
              { tool: toolName, error: String(payload.error).slice(0, 400) },
              { conversationId, createdAt: now }
            );
            this.notifyRevision();
          });
          return {};
        }
        const rec = reconcilePhaseStatus("active", "running");
        const updatedTaskIds = [];
        this.db.inTransaction(() => {
          let changed2 = false;
          for (const task of linkedTasks) {
            if (task.phase === "needs_you" && task.subPhase === "needs_input") {
              this.db.db.prepare("UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = NULL, updated_at = ? WHERE id = ?").run(rec.phase, rec.subPhase, rec.status, now, task.id);
              this.appendEvent(task.id, "hook_ask_question_answered", "hook", {}, { conversationId, createdAt: now });
              updatedTaskIds.push(task.id);
              changed2 = true;
            }
          }
          if (changed2) this.notifyRevision();
        });
        for (const id of updatedTaskIds) this.syncTaskSpaceProjection(id);
        return {};
      }
      const fileCandidate = args.TargetFile ?? args.AbsolutePath ?? args.Path ?? args.path ?? args.file_path ?? args.target_file;
      const writeRefTools = /* @__PURE__ */ new Set([
        "write_to_file",
        "replace_file_content",
        "multi_replace_file_content",
        "edit_file",
        "write_file"
      ]);
      let changed = false;
      this.db.inTransaction(() => {
        if (payload.error) {
          this.appendEvent(
            primaryTask.id,
            "hook_tool_error",
            "hook",
            { tool: toolName, error: String(payload.error).slice(0, 400) },
            { conversationId, createdAt: now }
          );
          changed = true;
        } else if (typeof fileCandidate === "string" && fileCandidate.trim() && writeRefTools.has(lowerName)) {
          const rawFile = fileCandidate.trim();
          const cwdStr = typeof payload.cwd === "string" && payload.cwd.trim() ? payload.cwd.trim() : void 0;
          const resolvedFile = !isAbsolute2(rawFile) && cwdStr ? resolve4(cwdStr, rawFile) : rawFile;
          const target = normalizeFsPath(resolvedFile);
          this.db.db.prepare(
            `INSERT OR IGNORE INTO task_refs (id, task_id, kind, target, label, added_by, created_at)
               VALUES (?, ?, 'file', ?, ?, 'hook', ?)`
          ).run(randomUUID(), primaryTask.id, target, `${toolName}`, now);
          this.appendEvent(
            primaryTask.id,
            "hook_deliverable_captured",
            "hook",
            { tool: toolName, target },
            { conversationId, createdAt: now }
          );
          changed = true;
        }
        if (changed) this.notifyRevision();
      });
      if (changed) this.syncTaskSpaceProjection(primaryTask.id);
      return {};
    }
    if (hookEventName === "Stop") {
      if (payload.fullyIdle === false) return { decision: "allow" };
      if (isSubagentInvocation && linkedTasks.every((t) => !t.conversations.some((c) => c.conversationId === directConv))) {
        return { decision: "allow" };
      }
      const reason = String(payload.terminationReason ?? "NO_TOOL_CALL");
      const isLimitStop = reason === "MAX_INVOCATIONS" || reason === "MAX_FORCED_INVOCATIONS" || reason === "MAX_TOKEN_BUDGET_EXCEEDED";
      const now = this.now();
      const transcriptSummary = extractLastPlannerSummary(
        typeof payload.transcriptPath === "string" ? payload.transcriptPath : void 0
      );
      for (const task of linkedTasks) {
        if (task.phase !== "active" && !hasOpenExecution(task)) continue;
        const openExec = [...task.executions].reverse().find((e) => e.endedAt === void 0 && e.conversationId === directConv);
        const hasOtherOpenExec = task.executions.some(
          (e) => e.endedAt === void 0 && e.conversationId !== directConv
        );
        const outcome = reason === "USER_CANCELED" ? "cancelled" : reason === "ERROR" ? "failed" : "succeeded";
        const targetPhase = outcome === "cancelled" ? "on_hold" : "needs_you";
        const targetSubPhase = outcome === "cancelled" ? "paused" : outcome === "failed" ? "blocked" : isLimitStop ? "needs_input" : task.subgoalRollup.readyForReview ? "review" : "needs_input";
        const rec = reconcilePhaseStatus(targetPhase, targetSubPhase);
        const errText = payload.error ? String(payload.error) : outcome === "failed" ? reason : null;
        const blockedText = errText ?? (outcome === "cancelled" ? "Paused after user cancellation" : isLimitStop ? `Turn stopped at limit (${reason}) \u2014 awaiting instruction` : task.subgoalRollup.readyForReview ? "All required subgoals complete \u2014 ready for review" : "Turn completed \u2014 awaiting review or next instruction");
        this.db.inTransaction(() => {
          if (openExec) {
            this.db.db.prepare("UPDATE task_executions SET ended_at = ?, result = ?, error = ?, summary = COALESCE(?, summary) WHERE id = ?").run(now, outcome, errText, transcriptSummary ?? null, openExec.id);
          } else {
            this.db.db.prepare(
              `INSERT INTO task_executions (id, task_id, conversation_id, workspace_id, started_at, ended_at, result, error, summary, initiated_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'hook')`
            ).run(
              randomUUID(),
              task.id,
              directConv || conversationId,
              task.workspaceId ?? null,
              now,
              now,
              outcome,
              errText,
              transcriptSummary ?? null
            );
          }
          if (!hasOtherOpenExec) {
            this.db.db.prepare("UPDATE tasks SET phase = ?, sub_phase = ?, status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?").run(rec.phase, rec.subPhase, rec.status, blockedText, now, task.id);
            if (rec.phase === "needs_you") {
              this.clearSnoozeForTask(task.id, now);
            }
          }
          this.appendEvent(
            task.id,
            "hook_stop",
            "hook",
            {
              terminationReason: reason,
              outcome,
              targetPhase: hasOtherOpenExec ? task.phase : rec.phase,
              targetSubPhase: hasOtherOpenExec ? task.subPhase : rec.subPhase,
              ...transcriptSummary ? { summary: transcriptSummary } : {}
            },
            { conversationId, createdAt: now }
          );
          this.notifyRevision();
        });
        this.syncTaskSpaceProjection(task.id);
      }
      return { decision: "allow" };
    }
    return {};
  }
};
function extractTextFromPlannerContent(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : void 0;
  }
  if (Array.isArray(value)) {
    const joined = value.map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object" && typeof item.text === "string") {
        return String(item.text).trim();
      }
      return "";
    }).filter(Boolean).join("\n");
    return joined || void 0;
  }
  if (value && typeof value === "object") {
    const obj = value;
    if (Array.isArray(obj.parts)) {
      return extractTextFromPlannerContent(obj.parts);
    }
    if (typeof obj.text === "string" && obj.text.trim()) {
      return obj.text.trim();
    }
    if (typeof obj.response === "string" && obj.response.trim()) {
      return obj.response.trim();
    }
  }
  return void 0;
}
function extractLastPlannerSummary(transcriptPath) {
  if (!transcriptPath) return void 0;
  try {
    const stat = statSync5(transcriptPath);
    if (!stat.isFile() || stat.size <= 0) return void 0;
    const maxTail = 524288;
    const offset = Math.max(0, stat.size - maxTail);
    const length = stat.size - offset;
    const fd = openSync2(transcriptPath, "r");
    try {
      const buf = Buffer.allocUnsafe(length);
      readSync2(fd, buf, 0, length, offset);
      const text = buf.toString("utf8");
      const lines = text.split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "PLANNER_RESPONSE" || parsed.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
            const summary = extractTextFromPlannerContent(parsed.content) ?? extractTextFromPlannerContent(parsed.plannerResponse?.modifiedResponse) ?? extractTextFromPlannerContent(parsed.plannerResponse?.response) ?? extractTextFromPlannerContent(parsed.step?.plannerResponse?.modifiedResponse) ?? extractTextFromPlannerContent(parsed.step?.plannerResponse?.response) ?? extractTextFromPlannerContent(parsed.response);
            if (summary) return summary.slice(0, 2e3);
          }
        } catch {
        }
      }
    } finally {
      closeSync2(fd);
    }
  } catch {
    return void 0;
  }
  return void 0;
}

// src/host/scheduler.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import {
  closeSync as closeSync3,
  existsSync as existsSync7,
  mkdirSync as mkdirSync4,
  openSync as openSync3,
  readFileSync as readFileSync5,
  renameSync,
  unlinkSync as unlinkSync3,
  writeFileSync as writeFileSync2,
  writeSync
} from "node:fs";
import { dirname as dirname4, join as join7 } from "node:path";

// src/entry/server-core.ts
import { existsSync as existsSync8, readdirSync as readdirSync3, readFileSync as readFileSync6, statSync as statSync6 } from "node:fs";
import { createServer } from "node:http";
import { dirname as dirname5, extname as extname2, join as join8, resolve as resolve5 } from "node:path";
import { fileURLToPath } from "node:url";
var HERE = dirname5(fileURLToPath(import.meta.url));
var EPIPE_GUARD_SYM = Symbol.for("agy-board.epipe-guard");
function installEpipeGuard(proc = process) {
  const flagged = proc;
  if (flagged[EPIPE_GUARD_SYM]) return;
  flagged[EPIPE_GUARD_SYM] = true;
  const isEpipe = (err) => err?.code === "EPIPE";
  for (const stream of [proc.stdout, proc.stderr]) {
    stream?.on?.("error", (err) => {
      if (!isEpipe(err)) throw err;
    });
  }
  const onFatal = (err) => {
    if (isEpipe(err)) return;
    try {
      console.error("[agy-board] fatal:", err);
    } catch {
    }
    proc.exit(1);
  };
  proc.on("uncaughtException", onFatal);
  proc.on("unhandledRejection", onFatal);
}

// src/entry/hook.ts
function processHookInput(rawInput, pathOverrides) {
  const trimmed = rawInput.trim();
  if (!trimmed) return { decision: "allow" };
  let payload;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { decision: "allow" };
    payload = parsed;
  } catch {
    return { decision: "allow" };
  }
  let db;
  try {
    const paths = resolveHostPaths(pathOverrides);
    if (paths.dbPath !== ":memory:" && !existsSync9(paths.dbPath)) {
      return { decision: "allow" };
    }
    db = new BoardDatabase(paths.dbPath, { recoverOrphans: false });
    const service = new BoardService(db, paths);
    return service.handleHookEvent(payload);
  } catch {
    return { decision: "allow" };
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}
async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function main() {
  installEpipeGuard();
  const input = await readAllStdin();
  const output = processHookInput(input);
  process.stdout.write(`${JSON.stringify(output)}
`);
}
function isMainHook() {
  if (!process.argv[1]) return false;
  try {
    return pathComparisonKey(realpathSync3(resolve6(process.argv[1]))) === pathComparisonKey(realpathSync3(fileURLToPath2(import.meta.url)));
  } catch {
    return process.argv[1].endsWith("hook.mjs") || process.argv[1].endsWith("hook.ts");
  }
}
if (isMainHook()) {
  void main();
}
export {
  processHookInput
};
