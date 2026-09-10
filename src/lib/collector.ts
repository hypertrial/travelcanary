export const collectorOperations = ["fast", "slow", "conditions", "satellite", "daily", "maintenance"] as const;
export type CollectorOperation = typeof collectorOperations[number];

export const collectorCadenceMs: Record<CollectorOperation, number> = {
  fast: 10 * 60_000,
  slow: 60 * 60_000,
  conditions: 60 * 60_000,
  satellite: 2 * 60 * 60_000,
  daily: 24 * 60 * 60_000,
  maintenance: 24 * 60 * 60_000,
};

export class SerialCollector {
  private queue = Promise.resolve();
  private stopped = false;
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(private readonly run: (operation: CollectorOperation) => Promise<void>) {}

  enqueue(operation: CollectorOperation) {
    if (this.stopped) return this.queue;
    this.queue = this.queue.then(() => this.stopped ? undefined : this.run(operation));
    return this.queue;
  }

  start() {
    for (const operation of collectorOperations) void this.enqueue(operation);
    this.timers = collectorOperations.map((operation) => setInterval(() => void this.enqueue(operation), collectorCadenceMs[operation]));
    return this.queue;
  }

  async stop() {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    await this.queue;
  }
}
