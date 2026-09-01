const DEFAULT_REFRESH_MS = 2_500;

type IntervalHandle = ReturnType<typeof setInterval>;

export type TypingLeaseOptions = {
  clearInterval?: (handle: IntervalHandle) => void;
  refreshMs?: number;
  setInterval?: (callback: () => void, delayMs: number) => IntervalHandle;
};

/** Keeps Photon's three-second typing pulse alive until delivery completes. */
export class TypingLease {
  private handle: IntervalHandle | undefined;
  private stopped = false;

  constructor(
    private readonly pulse: () => Promise<void>,
    private readonly options: TypingLeaseOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.stopped || this.handle) return;

    await this.safePulse();
    if (this.stopped) return;

    const schedule = this.options.setInterval ?? setInterval;
    this.handle = schedule(() => {
      void this.safePulse();
    }, this.options.refreshMs ?? DEFAULT_REFRESH_MS);
    this.handle.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (!this.handle) return;
    (this.options.clearInterval ?? clearInterval)(this.handle);
    this.handle = undefined;
  }

  private async safePulse(): Promise<void> {
    try {
      await this.pulse();
    } catch {
      // Typing is best-effort and must never prevent a useful reply.
    }
  }
}
