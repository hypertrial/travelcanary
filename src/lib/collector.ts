export const collectorOperations = ["fast", "slow", "conditions", "satellite", "daily", "maintenance"] as const;
export type CollectorOperation = typeof collectorOperations[number];
export type CollectorCompletedAt = Partial<Record<CollectorOperation, string>>;

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

  start(completedAt: CollectorCompletedAt = {}, now = Date.now()) {
    for (const operation of collectorOperations) {
      const completed = Date.parse(completedAt[operation] || "");
      const delay = Number.isFinite(completed) ? Math.min(collectorCadenceMs[operation], Math.max(0, completed + collectorCadenceMs[operation] - now)) : 0;
      const repeat = () => {
        if (this.stopped) return;
        void this.enqueue(operation);
      };
      if (delay === 0) {
        repeat();
        this.timers.push(setInterval(repeat, collectorCadenceMs[operation]));
      } else {
        this.timers.push(setTimeout(() => {
          repeat();
          if (!this.stopped) this.timers.push(setInterval(repeat, collectorCadenceMs[operation]));
        }, delay));
      }
    }
    return this.queue;
  }

  async stop() {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    await this.queue;
  }
}
