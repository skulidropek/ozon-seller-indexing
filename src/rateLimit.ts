import type { IndexerConfig } from "./types.js"
import { randomInt, sleep } from "./utils.js"

export class DelayGate {
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly config: Pick<IndexerConfig, "minActionDelayMs" | "maxActionDelayMs">) {}

  wait(_label: string): Promise<void> {
    const delayMs = randomInt(this.config.minActionDelayMs, this.config.maxActionDelayMs)
    const next = this.tail.then(() => sleep(delayMs))
    this.tail = next.catch(() => undefined)
    return next
  }
}

export const hasTimeForMoreWork = (startedAtMs: number, durationMinutes: number): boolean => {
  const durationMs = durationMinutes * 60_000
  const safetyWindowMs = 20_000
  return Date.now() - startedAtMs < durationMs - safetyWindowMs
}
