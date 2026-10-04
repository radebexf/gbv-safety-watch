/**
 * MonitoringStateMachine
 *
 * XState v5 state chart that governs the entire monitoring lifecycle of the
 * GBV Safety Watch.
 *
 * States:
 *   • idle          — No monitoring; all detection suspended.
 *   • active        — Full monitoring: HR anomaly, wrist sensor, BLE watchdog.
 *   • alert_pending — False-Positive-Window countdown running; user can cancel.
 *   • dispatching   — Alert assembled; SMS sends in progress.
 *   • post_alert    — Delivery results displayed; transitions back to active.
 *
 * Design notes:
 *   • Built with the XState v5 `setup({...}).createMachine({...})` API.
 *   • All side effects (storage persistence, FPW timer, display messages) are
 *     injected via machine `input` so the machine is fully unit-testable
 *     without the real EncryptedStorage, timers, or BLE stack.
 *   • On entry to `active`, the current monitoring session is persisted to the
 *     `gbv.monitoring_session` key so the app can auto-resume after an OS kill.
 *   • A static helper (`resolveResumeTarget`) reads the persisted session on
 *     launch and decides whether to resume monitoring (and whether to enter
 *     phone-only mode when the watch is unavailable).
 *
 * Requirements covered: 9.1, 9.2, 9.3, 9.4, 9.5, 9.7
 */

import {setup, assign, type ActorRefFrom} from 'xstate';
import type {
  EmergencyContact,
  TriggerType,
  MonitoringSession,
  AlertDispatchResult,
} from '../types';
import type {EncryptedStorageInterface} from '../storage/EncryptedStorage';

// ── Constants ──────────────────────────────────────────────────────────────

/** Encrypted-storage sub-key under which the monitoring session is persisted. */
export const MONITORING_SESSION_KEY = 'monitoring_session';

/**
 * Maximum time (ms) allowed for reconciling a phone/watch indicator mismatch
 * before monitoring is forcibly deactivated (Requirements 9.3, 9.7).
 */
export const INDICATOR_RECONCILE_TIMEOUT_MS = 5_000;

/**
 * Default False-Positive-Window duration (seconds) used when the caller does
 * not supply user settings.  Mirrors UserSettings default (Requirement 2.8).
 */
export const DEFAULT_FPW_SECONDS = 15;

// ── Timer abstraction ────────────────────────────────────────────────────────

/**
 * Minimal timer interface so the FPW countdown and indicator-reconcile timers
 * can be driven by a test-controlled clock instead of the global timers.
 */
export interface MonitoringTimers {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
}

/** Default timers that delegate to the host environment's global functions. */
export const defaultMonitoringTimers: MonitoringTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id),
};

/**
 * Minimal interval-timer interface used to drive the live, per-second
 * False-Positive-Window countdown that is pushed to the watch display
 * (Requirements 2.4, 7.1).  Kept separate from {@link MonitoringTimers} and
 * injectable so the ticking countdown can be exercised deterministically in
 * unit tests with a fake clock instead of the real `setInterval`.
 */
export interface CountdownTicker {
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (id: ReturnType<typeof setInterval>) => void;
}

/** Default ticker that delegates to the host environment's global functions. */
export const defaultCountdownTicker: CountdownTicker = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: id => clearInterval(id),
};

/** Interval (ms) between live countdown display updates on the watch. */
export const COUNTDOWN_TICK_MS = 1_000;

/**
 * Adapt a {@link MonitoringTimers} bag into the clock shape expected by
 * XState v5's `createActor(machine, { clock })`.  This is what makes the
 * `after` / `delays` timing (FPW countdown, indicator reconcile) controllable
 * from unit tests — inject a fake-timer-backed `MonitoringTimers` and the
 * machine's scheduled transitions will fire deterministically.
 *
 * @example
 * ```ts
 * import {createActor} from 'xstate';
 * const machine = createMonitoringMachine({falsePosWindowSeconds: 15});
 * const actor = createActor(machine, {clock: toXStateClock(fakeTimers)});
 * actor.start();
 * ```
 */
export function toXStateClock(timers: MonitoringTimers): {
  setTimeout: (fn: (...args: unknown[]) => void, timeout: number) => unknown;
  clearTimeout: (id: unknown) => void;
} {
  return {
    setTimeout: (fn, timeout) =>
      timers.setTimeout(fn as () => void, timeout),
    clearTimeout: id =>
      timers.clearTimeout(id as ReturnType<typeof setTimeout>),
  };
}

// ── Machine context ────────────────────────────────────────────────────────

/**
 * The reason the machine entered `alert_pending`, carried through to the
 * dispatched alert so the SMS can label the trigger type.
 */
export interface MonitoringContext {
  /** The trigger that initiated the current (or most recent) alert workflow. */
  triggerType: TriggerType | null;
  /** Unix-ms timestamp at which the current alert workflow was initiated. */
  triggeredAt: number | null;
  /** True once monitoring has been activated at least once this session. */
  phoneOnlyMode: boolean;
  /** Whether the watch is currently connected. */
  watchConnected: boolean;
  /** Result of the most recent dispatch, surfaced to the post_alert screen. */
  lastDispatchResult: AlertDispatchResult | null;
  /**
   * Seconds remaining in the active False-Positive-Window countdown while in
   * `alert_pending`.  Updated once per second by the countdown ticker and
   * mirrored to the watch display (Requirements 2.4, 7.1).  Null when no FPW
   * countdown is active.
   */
  fpwRemainingSeconds: number | null;
}

// ── Machine events ───────────────────────────────────────────────────────────

/** Guard payload used to validate activation preconditions (9.1, 9.4). */
export interface ActivationPreconditions {
  /** The user's registered emergency contacts. */
  contacts: EmergencyContact[];
  /** Whether onboarding has been completed. */
  onboardingCompleted: boolean;
  /** Whether the watch is currently connected (false → phone-only resume). */
  watchConnected: boolean;
}

export type MonitoringEvent =
  // User explicitly activates monitoring (Requirement 9.1).
  | ({type: 'ACTIVATE'} & ActivationPreconditions)
  // User explicitly deactivates monitoring (Requirement 9.2).
  | {type: 'DEACTIVATE'}
  // Automatic triggers that initiate the alert workflow.
  | {type: 'ANOMALY_DETECTED'; triggeredAt?: number}
  | {type: 'MANUAL_TRIGGER'; triggeredAt?: number}
  | {type: 'WATCH_REMOVED'; triggeredAt?: number}
  | {type: 'BT_DISCONNECTED'; triggeredAt?: number}
  // A new anomalous sample arrived during the FPW countdown (Requirement 2.3).
  | {type: 'ANOMALY_RESTART'; triggeredAt?: number}
  // Internal 1 Hz tick that advances the live FPW countdown (2.4, 7.1).
  | {type: 'FPW_TICK'}
  // User cancels the pending alert within the FPW (Requirements 2.6, 7.3).
  | {type: 'FPW_CANCEL'}
  // The FPW countdown expired without cancellation (Requirements 2.5, 7.2).
  | {type: 'FPW_EXPIRED'}
  // The alert dispatch finished (Requirement — dispatch complete transition).
  | {type: 'DISPATCH_COMPLETE'; result?: AlertDispatchResult}
  // Phone/watch indicator mismatch detected (Requirement 9.3).
  | {type: 'INDICATOR_MISMATCH'}
  // Indicators successfully reconciled within the window (Requirement 9.3).
  | {type: 'INDICATOR_RECONCILED'}
  // Reconciliation window exceeded 5 s → forced deactivation (Requirement 9.7).
  | {type: 'RECONCILE_TIMEOUT'}
  // Watch connection state changes while monitoring.
  | {type: 'WATCH_CONNECTED'}
  | {type: 'WATCH_DISCONNECTED'}
  // Auto-resume after OS kill (Requirement 9.5).
  | {type: 'RESUME'; watchConnected: boolean};

// ── Dependency-injection input ─────────────────────────────────────────────

/**
 * Side-effect dependencies injected into the machine via `input`.
 * All are optional so tests can supply only what they need.
 */
export interface MonitoringInput {
  /** Encrypted storage used to persist / clear the monitoring session. */
  storage?: EncryptedStorageInterface;
  /** Timer functions for the FPW and indicator-reconcile delays. */
  timers?: MonitoringTimers;
  /**
   * Interval ticker that drives the live per-second FPW countdown shown on the
   * watch display (Requirements 2.4, 7.1).  Defaults to
   * {@link defaultCountdownTicker}; inject a fake-clock-backed ticker in tests.
   */
  countdownTicker?: CountdownTicker;
  /** FPW duration in seconds (defaults to {@link DEFAULT_FPW_SECONDS}). */
  falsePosWindowSeconds?: number;
  /**
   * Optional callback invoked whenever a display message should be shown on
   * the watch (e.g. the FPW countdown).  Wired to
   * `BluetoothManager.sendDisplayMessage` in production.
   */
  sendDisplayMessage?: (text: string) => void;
  /** Clock used for timestamps.  Defaults to `Date.now`. */
  now?: () => number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Validate that monitoring may be activated: at least one contact must exist
 * AND onboarding must be complete (Requirements 9.1, 9.4).
 */
export function canActivate(pre: ActivationPreconditions): boolean {
  return pre.onboardingCompleted && pre.contacts.length >= 1;
}

/**
 * Persist a monitoring session to encrypted storage (fire-and-forget).
 * Used on entry to `active` so the app can auto-resume after an OS kill
 * (Requirement 9.5).
 */
function persistSession(
  storage: EncryptedStorageInterface | undefined,
  session: MonitoringSession,
): void {
  if (!storage) return;
  void storage
    .set(MONITORING_SESSION_KEY, JSON.stringify(session))
    .catch(err =>
      console.warn('[MonitoringStateMachine] session persist failed:', err),
    );
}

/** Clear the persisted monitoring session (on deactivation / idle entry). */
function clearSession(storage: EncryptedStorageInterface | undefined): void {
  if (!storage) return;
  void storage
    .set(
      MONITORING_SESSION_KEY,
      JSON.stringify({
        activatedAt: 0,
        state: 'idle',
        watchConnected: false,
        phoneOnlyMode: false,
      } satisfies MonitoringSession),
    )
    .catch(err =>
      console.warn('[MonitoringStateMachine] session clear failed:', err),
    );
}

/**
 * Build the countdown text shown on the watch during the False-Positive-Window
 * (Requirements 2.4, 7.1).  Exported so UI/tests can assert the exact copy.
 *
 * @param secondsRemaining - Whole seconds left before the alert dispatches.
 */
export function formatCountdownMessage(secondsRemaining: number): string {
  const safe = Math.max(0, Math.floor(secondsRemaining));
  return `Safety alert in ${safe}s — hold to cancel`;
}

/**
 * Decide, on app launch, whether to resume monitoring based on the persisted
 * `gbv.monitoring_session` record (Requirement 9.5).
 *
 * @param storage        - Encrypted storage to read the session from.
 * @param watchConnected - Whether the watch is reachable at resume time.
 * @returns An object describing whether to resume and whether to enter
 *          phone-only mode (true when resuming without the watch).
 */
export async function resolveResumeTarget(
  storage: EncryptedStorageInterface,
  watchConnected: boolean,
): Promise<{shouldResume: boolean; phoneOnlyMode: boolean}> {
  try {
    const raw = await storage.get(MONITORING_SESSION_KEY);
    if (!raw) return {shouldResume: false, phoneOnlyMode: false};

    const session = JSON.parse(raw) as MonitoringSession;
    if (session.state !== 'active') {
      return {shouldResume: false, phoneOnlyMode: false};
    }

    // Resume; if the watch is unavailable, resume in phone-only mode (9.5).
    return {shouldResume: true, phoneOnlyMode: !watchConnected};
  } catch (err) {
    console.warn('[MonitoringStateMachine] resume resolution failed:', err);
    return {shouldResume: false, phoneOnlyMode: false};
  }
}

// ── Machine definition ───────────────────────────────────────────────────────

/**
 * Factory that builds the monitoring state machine with injected side effects.
 *
 * Keeping this as a factory (rather than a module-level singleton) lets each
 * actor own its own injected `storage` / `timers`, which is essential for
 * deterministic unit testing.
 */
export function createMonitoringMachine(input: MonitoringInput = {}) {
  const fpwSeconds = input.falsePosWindowSeconds ?? DEFAULT_FPW_SECONDS;
  const now = input.now ?? (() => Date.now());
  const ticker = input.countdownTicker ?? defaultCountdownTicker;

  /**
   * Handle for the live per-second countdown interval.  Owned by the factory
   * closure (not machine context) because it is a non-serialisable side-effect
   * resource.  Started on entry to `alert_pending` and cleared on exit — which
   * includes re-entry via `ANOMALY_RESTART` (Requirements 2.3, 2.4, 7.1).
   */
  let countdownHandle: ReturnType<typeof setInterval> | null = null;

  /** Push the current countdown text to the watch display, if wired. */
  const pushCountdown = (secondsRemaining: number): void => {
    input.sendDisplayMessage?.(formatCountdownMessage(secondsRemaining));
  };

  /** Stop the live countdown interval if one is running. */
  const stopCountdown = (): void => {
    if (countdownHandle !== null) {
      ticker.clearInterval(countdownHandle);
      countdownHandle = null;
    }
  };

  return setup({
    types: {
      context: {} as MonitoringContext,
      events: {} as MonitoringEvent,
      input: {} as MonitoringInput,
    },
    guards: {
      /** Activation requires ≥1 contact AND completed onboarding (9.1, 9.4). */
      canActivate: ({event}) => {
        if (event.type !== 'ACTIVATE') return false;
        return canActivate(event);
      },
    },
    actions: {
      /** Record the trigger that started the alert workflow. */
      recordTrigger: assign(({event}) => {
        const triggerMap: Partial<Record<MonitoringEvent['type'], TriggerType>> =
          {
            ANOMALY_DETECTED: 'heart_rate_anomaly',
            ANOMALY_RESTART: 'heart_rate_anomaly',
            MANUAL_TRIGGER: 'manual',
            WATCH_REMOVED: 'watch_removal',
            BT_DISCONNECTED: 'bluetooth_disconnection',
          };
        const triggerType = triggerMap[event.type] ?? null;
        const triggeredAt =
          'triggeredAt' in event && typeof event.triggeredAt === 'number'
            ? event.triggeredAt
            : now();
        return {triggerType, triggeredAt};
      }),

      /** Store the dispatch result for the post_alert screen. */
      recordDispatchResult: assign(({event}) => {
        if (event.type === 'DISPATCH_COMPLETE' && event.result) {
          return {lastDispatchResult: event.result};
        }
        return {};
      }),

      /** Capture activation flags (phone-only mode when watch is absent). */
      applyActivation: assign(({event}) => {
        if (event.type === 'ACTIVATE') {
          return {
            watchConnected: event.watchConnected,
            phoneOnlyMode: !event.watchConnected,
          };
        }
        if (event.type === 'RESUME') {
          return {
            watchConnected: event.watchConnected,
            phoneOnlyMode: !event.watchConnected,
          };
        }
        return {};
      }),

      /** Mark the watch as connected and leave phone-only mode. */
      markWatchConnected: assign({
        watchConnected: true,
        phoneOnlyMode: false,
      }),

      /** Mark the watch as disconnected (phone-only mode). */
      markWatchDisconnected: assign({
        watchConnected: false,
        phoneOnlyMode: true,
      }),

      /** Reset the alert-workflow context fields. */
      resetTrigger: assign({
        triggerType: null,
        triggeredAt: null,
      }),

      /** Persist the active monitoring session (Requirement 9.5). */
      persistActiveSession: ({context}) => {
        persistSession(input.storage, {
          activatedAt: context.triggeredAt ?? now(),
          state: 'active',
          watchConnected: context.watchConnected,
          phoneOnlyMode: context.phoneOnlyMode,
        });
      },

      /** Clear the persisted session when returning to idle. */
      clearPersistedSession: () => {
        clearSession(input.storage);
      },

      /**
       * Reset the remaining-seconds context to the full configured FPW
       * duration.  Pure context update half of the countdown-start sequence.
       * Because `alert_pending` is re-entered on `ANOMALY_RESTART`
       * (reenter: true), this runs again from the full duration — implementing
       * the restart behaviour of Requirement 2.3.
       */
      resetCountdownContext: assign({fpwRemainingSeconds: fpwSeconds}),

      /**
       * Side-effect half of countdown start (Requirements 2.4, 7.1):
       * immediately push the opening full-duration frame to the watch display
       * and start a 1 Hz ticker that sends `FPW_TICK` events so the countdown
       * advances once per second.  Any ticker from a prior (restarted)
       * countdown is cleared first.
       */
      startCountdownTicker: ({self}) => {
        stopCountdown();
        pushCountdown(fpwSeconds);
        countdownHandle = ticker.setInterval(() => {
          self.send({type: 'FPW_TICK'});
        }, COUNTDOWN_TICK_MS);
      },

      /**
       * Advance the live countdown by one second (context update), guarding
       * against underflow at zero.  The actual dispatch transition is driven
       * independently by the `fpwDelay` timer.
       */
      decrementCountdown: assign(({context}) => {
        const current = context.fpwRemainingSeconds ?? fpwSeconds;
        return {fpwRemainingSeconds: Math.max(0, current - 1)};
      }),

      /**
       * Mirror the current remaining seconds to the watch display
       * (Requirements 2.4, 7.1).  Pure side effect; reads the value already
       * written by {@link decrementCountdown}.
       */
      pushCountdownToWatch: ({context}) => {
        pushCountdown(context.fpwRemainingSeconds ?? 0);
      },

      /** Stop the live countdown ticker (side effect). */
      stopCountdownTicker: () => {
        stopCountdown();
      },

      /** Clear the remaining-seconds view after the countdown ends. */
      clearCountdownContext: assign({fpwRemainingSeconds: null}),
    },
    delays: {
      /** FPW countdown duration in ms. */
      fpwDelay: fpwSeconds * 1000,
      /** Indicator reconciliation window (Requirements 9.3, 9.7). */
      reconcileDelay: INDICATOR_RECONCILE_TIMEOUT_MS,
    },
  }).createMachine({
    id: 'monitoring',
    initial: 'idle',
    context: {
      triggerType: null,
      triggeredAt: null,
      phoneOnlyMode: false,
      watchConnected: false,
      lastDispatchResult: null,
      fpwRemainingSeconds: null,
    },
    states: {
      // ── IDLE ───────────────────────────────────────────────────────────────
      idle: {
        entry: ['clearPersistedSession', 'resetTrigger'],
        on: {
          // Requirement 9.1 / 9.4 — activation only when guard passes.
          ACTIVATE: {
            target: 'active',
            guard: 'canActivate',
            actions: 'applyActivation',
          },
          // Requirement 9.5 — auto-resume after an OS kill.
          RESUME: {
            target: 'active',
            actions: 'applyActivation',
          },
        },
      },

      // ── ACTIVE ───────────────────────────────────────────────────────────────
      active: {
        // Requirement 9.5 — persist the session for auto-resume on entry.
        entry: 'persistActiveSession',
        on: {
          // Requirement 9.2 — explicit deactivation returns to idle.
          DEACTIVATE: {target: 'idle'},
          // Automatic + manual triggers initiate the alert workflow.
          ANOMALY_DETECTED: {
            target: 'alert_pending',
            actions: 'recordTrigger',
          },
          MANUAL_TRIGGER: {
            target: 'alert_pending',
            actions: 'recordTrigger',
          },
          WATCH_REMOVED: {
            target: 'alert_pending',
            actions: 'recordTrigger',
          },
          BT_DISCONNECTED: {
            target: 'alert_pending',
            actions: 'recordTrigger',
          },
          // Requirement 9.3 — begin reconciling an indicator mismatch.
          INDICATOR_MISMATCH: {target: 'reconciling'},
          // Watch connectivity transitions while active.
          WATCH_CONNECTED: {
            actions: ['markWatchConnected', 'persistActiveSession'],
          },
          WATCH_DISCONNECTED: {
            actions: ['markWatchDisconnected', 'persistActiveSession'],
          },
        },
      },

      // ── RECONCILING (indicator-mismatch sub-state of active) ─────────────────
      // Requirements 9.3 and 9.7: restore both indicators within 5 s or
      // deactivate due to a synchronization failure.
      reconciling: {
        after: {
          reconcileDelay: {target: 'idle'}, // 9.7 — timeout → deactivate
        },
        on: {
          INDICATOR_RECONCILED: {target: 'active'}, // 9.3 — restored in time
          RECONCILE_TIMEOUT: {target: 'idle'}, // explicit timeout signal
          DEACTIVATE: {target: 'idle'},
        },
      },

      // ── ALERT_PENDING (FPW countdown) ────────────────────────────────────────
      // Drives the False-Positive-Window countdown (Requirements 2.4, 7.1):
      //   • `entry` resets the remaining time to the full configured duration,
      //     shows the opening frame on the watch, and starts the 1 Hz ticker.
      //   • `FPW_TICK` advances the on-watch countdown once per second.
      //   • `exit` tears the ticker down so no stray updates leak into other
      //     states (also covers re-entry on ANOMALY_RESTART).
      //   • The `fpwDelay` `after` timer independently fires expiry at exactly
      //     the full duration; re-entry restarts it, giving a true full-length
      //     restart rather than a shorter residual (Requirement 2.3).
      alert_pending: {
        entry: ['resetCountdownContext', 'startCountdownTicker'],
        exit: ['stopCountdownTicker', 'clearCountdownContext'],
        after: {
          // Requirements 2.5 / 7.2 — FPW expiry dispatches the alert.
          fpwDelay: {target: 'dispatching'},
        },
        on: {
          // Requirement 2.3 — a new anomaly restarts the full countdown.
          // Re-entering the state reinitialises the `after` delay AND, via the
          // exit/entry actions, restarts the live countdown from full duration.
          ANOMALY_RESTART: {
            target: 'alert_pending',
            reenter: true,
            actions: 'recordTrigger',
          },
          // Requirements 2.4 / 7.1 — advance the live on-watch countdown.
          FPW_TICK: {actions: ['decrementCountdown', 'pushCountdownToWatch']},
          // Requirements 2.6 / 7.3 — user cancels within the window.
          FPW_CANCEL: {target: 'active', actions: 'resetTrigger'},
          // Alternatively the user placed the watch back on the wrist.
          FPW_EXPIRED: {target: 'dispatching'},
          DEACTIVATE: {target: 'idle'},
        },
      },

      // ── DISPATCHING ──────────────────────────────────────────────────────────
      dispatching: {
        on: {
          DISPATCH_COMPLETE: {
            target: 'post_alert',
            actions: 'recordDispatchResult',
          },
        },
      },

      // ── POST_ALERT ───────────────────────────────────────────────────────────
      // Delivery results are displayed here; the service sends RESUME once the
      // user has seen the summary, folding back into active monitoring.
      post_alert: {
        on: {
          // Resume monitoring after showing delivery results.
          RESUME: {target: 'active', actions: 'resetTrigger'},
          DEACTIVATE: {target: 'idle'},
        },
      },
    },
  });
}

/** The concrete machine type produced by {@link createMonitoringMachine}. */
export type MonitoringMachine = ReturnType<typeof createMonitoringMachine>;

/** Convenience actor-ref type for consumers wiring the machine into a service. */
export type MonitoringActorRef = ActorRefFrom<MonitoringMachine>;
