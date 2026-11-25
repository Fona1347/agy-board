/**
 * Periodic background scheduler for due reminders and cron/once rules,
 * protected by a single-leader SidecarOwner lockfile (`<boardDir>/scheduler.owner.json`)
 * so multiple Antigravity windows never run duplicate cron/reminder triggers.
 */
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { BoardService } from './board-service.ts'

export interface SchedulerOwnerRecord {
  ownerId: string
  pid: number
  acquiredAt: number
  heartbeatAt: number
  ttlMs: number
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH'
  }
}

export class SidecarOwner {
  readonly ownerId: string
  readonly lockFile: string | undefined
  readonly ttlMs: number
  private readonly nowFn: () => number

  constructor(
    dbPath: string,
    options: { ttlMs?: number; now?: () => number; ownerId?: string } = {},
  ) {
    this.ownerId = options.ownerId ?? randomUUID()
    this.ttlMs = Math.max(options.ttlMs ?? 45_000, 5_000)
    this.nowFn = options.now ?? (() => Date.now())
    this.lockFile = dbPath && dbPath !== ':memory:' ? join(dirname(dbPath), 'scheduler.owner.json') : undefined
  }

  readCurrent(): SchedulerOwnerRecord | undefined {
    if (!this.lockFile || !existsSync(this.lockFile)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(this.lockFile, 'utf8')) as Partial<SchedulerOwnerRecord>
      if (
        typeof parsed.ownerId === 'string' &&
        parsed.ownerId &&
        typeof parsed.pid === 'number' &&
        typeof parsed.heartbeatAt === 'number'
      ) {
        return {
          ownerId: parsed.ownerId,
          pid: parsed.pid,
          acquiredAt: typeof parsed.acquiredAt === 'number' ? parsed.acquiredAt : parsed.heartbeatAt,
          heartbeatAt: parsed.heartbeatAt,
          ttlMs: typeof parsed.ttlMs === 'number' && parsed.ttlMs > 0 ? parsed.ttlMs : this.ttlMs,
        }
      }
    } catch {
      // treat corrupt file as stale
    }
    return undefined
  }

  private isStale(record: SchedulerOwnerRecord | undefined, now: number): boolean {
    if (!record) return true
    if (!isProcessAlive(record.pid)) return true
    return now - record.heartbeatAt >= record.ttlMs
  }

  private writeRecord(record: SchedulerOwnerRecord): void {
    if (!this.lockFile) return
    mkdirSync(dirname(this.lockFile), { recursive: true })
    const payload = JSON.stringify(record)
    const tmp = `${this.lockFile}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`
    try {
      writeFileSync(tmp, payload, 'utf8')
      renameSync(tmp, this.lockFile)
    } catch {
      try {
        writeFileSync(this.lockFile, payload, 'utf8')
      } finally {
        try {
          if (existsSync(tmp)) unlinkSync(tmp)
        } catch {
          // ignore cleanup failure
        }
      }
    }
  }

  tryAcquireOrRenew(now = this.nowFn()): boolean {
    if (!this.lockFile) return true
    mkdirSync(dirname(this.lockFile), { recursive: true })

    if (!existsSync(this.lockFile)) {
      try {
        const fd = openSync(this.lockFile, 'wx')
        const rec: SchedulerOwnerRecord = {
          ownerId: this.ownerId,
          pid: process.pid,
          acquiredAt: now,
          heartbeatAt: now,
          ttlMs: this.ttlMs,
        }
        try {
          writeSync(fd, JSON.stringify(rec), 0, 'utf8')
        } finally {
          closeSync(fd)
        }
        return true
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
          return false
        }
      }
    }

    const current = this.readCurrent()
    if (current && current.ownerId === this.ownerId) {
      this.writeRecord({
        ...current,
        pid: process.pid,
        heartbeatAt: now,
        ttlMs: this.ttlMs,
      })
      return true
    }

    if (current && !this.isStale(current, now)) {
      return false
    }

    this.writeRecord({
      ownerId: this.ownerId,
      pid: process.pid,
      acquiredAt: now,
      heartbeatAt: now,
      ttlMs: this.ttlMs,
    })
    const verified = this.readCurrent()
    return verified?.ownerId === this.ownerId
  }

  isOwner(now = this.nowFn()): boolean {
    if (!this.lockFile) return true
    const current = this.readCurrent()
    return Boolean(current && current.ownerId === this.ownerId && !this.isStale(current, now))
  }

  release(): void {
    if (!this.lockFile || !existsSync(this.lockFile)) return
    try {
      const current = this.readCurrent()
      if (current?.ownerId === this.ownerId) {
        unlinkSync(this.lockFile)
      }
    } catch {
      // ignore release failure
    }
  }
}

export class BoardScheduler {
  readonly owner: SidecarOwner
  private timer: NodeJS.Timeout | undefined
  private ticking = false

  constructor(
    private readonly service: BoardService,
    private readonly intervalMs = 15_000,
    options: { ttlMs?: number; now?: () => number; ownerId?: string } = {},
  ) {
    this.owner = new SidecarOwner(service.db.dbPath, {
      ttlMs: options.ttlMs ?? Math.max(intervalMs * 3, 45_000),
      now: options.now,
      ownerId: options.ownerId,
    })
  }

  start(): void {
    if (this.timer) return
    this.owner.tryAcquireOrRenew()
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.owner.release()
  }

  async tick(): Promise<{ firedReminders: string[]; firedSchedules: string[] }> {
    if (this.ticking) return { firedReminders: [], firedSchedules: [] }
    if (!this.owner.tryAcquireOrRenew()) {
      return { firedReminders: [], firedSchedules: [] }
    }
    this.ticking = true
    try {
      return await this.service.runSchedulerTick()
    } finally {
      this.ticking = false
    }
  }
}
