/**
 * Service-wide concurrency admission queue for conversation launches.
 * Caps peak concurrent `agentapi new-conversation` / `send-message` spawns
 * while guaranteeing round-robin fairness across run groups and FIFO within a group.
 */

export interface QueuedLaunch {
  readonly groupId: string
  start(): Promise<void>
  abandon(): void
}

export class LaunchAdmissionQueue {
  private readonly waiting = new Map<string, QueuedLaunch[]>()
  private rotation: string[] = []
  private readonly inFlight = new Set<() => void>()
  peakInFlight = 0

  constructor(private readonly width: () => number) {}

  get pendingCount(): number {
    let total = 0
    for (const queue of this.waiting.values()) total += queue.length
    return total
  }

  get inFlightCount(): number {
    return this.inFlight.size
  }

  enqueue(launch: QueuedLaunch): void {
    const queue = this.waiting.get(launch.groupId)
    if (queue === undefined) {
      this.waiting.set(launch.groupId, [launch])
      this.rotation.push(launch.groupId)
    } else {
      queue.push(launch)
    }
    this.pump()
  }

  drain(): QueuedLaunch[] {
    const abandoned: QueuedLaunch[] = []
    for (const groupId of this.rotation) {
      for (const launch of this.waiting.get(groupId) ?? []) abandoned.push(launch)
    }
    this.rotation = []
    this.waiting.clear()
    for (const launch of abandoned) launch.abandon()
    return abandoned
  }

  private pump(): void {
    const cap = Math.max(1, Math.trunc(this.width()))
    while (this.inFlight.size < cap) {
      const launch = this.takeNext()
      if (launch === undefined) return
      this.admit(launch)
    }
  }

  private takeNext(): QueuedLaunch | undefined {
    while (this.rotation.length > 0) {
      const groupId = this.rotation.shift()
      if (groupId === undefined) return undefined
      const queue = this.waiting.get(groupId)
      if (queue === undefined || queue.length === 0) {
        this.waiting.delete(groupId)
        continue
      }
      const launch = queue.shift()
      if (launch === undefined) continue
      if (queue.length === 0) this.waiting.delete(groupId)
      else this.rotation.push(groupId)
      return launch
    }
    return undefined
  }

  private admit(launch: QueuedLaunch): void {
    const release = (): void => {
      this.inFlight.delete(release)
      this.pump()
    }
    this.inFlight.add(release)
    if (this.inFlight.size > this.peakInFlight) this.peakInFlight = this.inFlight.size
    void Promise.resolve()
      .then(() => launch.start())
      .catch(() => {
        // Callers own reporting; never wedge the slot.
      })
      .then(release)
  }
}
