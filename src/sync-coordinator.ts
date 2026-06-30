export type SyncReason = 'scheduled' | 'morning_catch_up' | 'manual' | 'biometric_trigger';

export interface SyncCoordinatorState {
  running: boolean;
  pending: boolean;
  activeReason: SyncReason | null;
  pendingReason: SyncReason | null;
}

const REASON_PRIORITY: Record<SyncReason, number> = {
  scheduled: 0,
  biometric_trigger: 1,
  manual: 2,
  morning_catch_up: 3,
};

function higherPriority(current: SyncReason | null, requested: SyncReason): SyncReason {
  if (current === null || REASON_PRIORITY[requested] > REASON_PRIORITY[current]) return requested;
  return current;
}

/** Serializes sync work and coalesces concurrent requests into one follow-up cycle. */
export class SingleFlightSyncCoordinator {
  private activeReason: SyncReason | null = null;
  private pendingReason: SyncReason | null = null;
  private drainPromise: Promise<void> | null = null;

  constructor(
    private readonly execute: (reason: SyncReason) => Promise<void>,
    private readonly onStateChange: (state: SyncCoordinatorState) => void = () => undefined,
  ) {}

  get state(): SyncCoordinatorState {
    return {
      running: this.activeReason !== null,
      pending: this.pendingReason !== null,
      activeReason: this.activeReason,
      pendingReason: this.pendingReason,
    };
  }

  request(reason: SyncReason): Promise<void> {
    if (this.drainPromise) {
      this.pendingReason = higherPriority(this.pendingReason, reason);
      this.emitState();
      return this.drainPromise;
    }

    this.drainPromise = this.drain(reason);
    return this.drainPromise;
  }

  private async drain(initialReason: SyncReason): Promise<void> {
    let reason: SyncReason | null = initialReason;
    try {
      while (reason !== null) {
        this.activeReason = reason;
        this.pendingReason = null;
        this.emitState();
        await this.execute(reason);
        reason = this.pendingReason;
      }
    } finally {
      this.activeReason = null;
      this.pendingReason = null;
      this.drainPromise = null;
      this.emitState();
    }
  }

  private emitState(): void {
    this.onStateChange(this.state);
  }
}
