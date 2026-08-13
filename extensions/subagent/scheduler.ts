export const MAX_OUTSTANDING_CALLS = 8;
export const MAX_ACTIVE_CHILDREN = 4;

export interface SchedulerLease {
  /** Release the active child slot. Safe to call more than once. */
  release(): void;
}

interface Waiter {
  started: boolean;
  waiting: boolean;
  resolve?: (lease: SchedulerLease | undefined) => void;
}

/**
 * FIFO admission and child-launch scheduler for one subagent extension instance.
 *
 * Admission is deliberately separate from launching: model discovery and other
 * setup may finish while a call is queued, but only a leased child counts
 * against the active-process limit. A waiter enters the launch queue only when
 * setup calls acquire(), so setup still completes before a child slot is used.
 */
export class SubagentScheduler {
  private outstanding = 0;
  private active = 0;
  private readonly waiters: Waiter[] = [];

  admit(signal?: AbortSignal): SchedulerAdmission {
    if (this.outstanding >= MAX_OUTSTANDING_CALLS) {
      throw new Error(`Too many outstanding subagent calls; maximum is ${MAX_OUTSTANDING_CALLS}.`);
    }

    this.outstanding++;
    const waiter: Waiter = {
      started: false,
      waiting: false,
    };
    this.waiters.push(waiter);
    let closed = false;
    let abortListener: (() => void) | undefined;
    let acquisition: Promise<SchedulerLease | undefined> | undefined;

    const removeQueued = () => {
      const index = this.waiters.indexOf(waiter);
      if (index >= 0) this.waiters.splice(index, 1);
    };

    const cancel = () => {
      if (waiter.started || closed) return;
      closed = true;
      if (abortListener) signal?.removeEventListener("abort", abortListener);
      removeQueued();
      // An aborted waiter is no longer outstanding even if its setup promise
      // still needs to unwind in the caller.
      this.outstanding--;
      waiter.resolve?.(undefined);
      this.pump();
    };

    if (signal) {
      abortListener = cancel;
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", abortListener, { once: true });
    }

    const close = () => {
      if (closed) return;
      closed = true;
      if (abortListener) signal?.removeEventListener("abort", abortListener);
      if (!waiter.started) {
        removeQueued();
        waiter.resolve?.(undefined);
      }
      this.outstanding--;
      this.pump();
    };

    const acquire = (): Promise<SchedulerLease | undefined> => {
      if (acquisition) return acquisition;
      if (closed) return (acquisition = Promise.resolve(undefined));
      waiter.waiting = true;
      acquisition = new Promise<SchedulerLease | undefined>((resolve) => {
        waiter.resolve = resolve;
        this.pump();
      });
      return acquisition;
    };

    return { acquire, close };
  }

  private pump(): void {
    while (this.active < MAX_ACTIVE_CHILDREN) {
      const waiter = this.waiters[0];
      if (!waiter) return;
      // Preserve admission order. A later acquire cannot overtake an earlier
      // call that is still resolving/setup.
      if (!waiter.waiting) return;

      this.waiters.shift();
      waiter.started = true;
      this.active++;
      let released = false;
      const lease: SchedulerLease = {
        release: () => {
          if (released) return;
          released = true;
          this.active--;
          this.pump();
        },
      };
      waiter.resolve?.(lease);
    }
  }
}

export interface SchedulerAdmission {
  /** Acquire an active child slot after setup has completed. */
  acquire(): Promise<SchedulerLease | undefined>;
  /** Release the outstanding-call admission. Safe to call more than once. */
  close(): void;
}
