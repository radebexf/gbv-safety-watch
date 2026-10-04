/**
 * WatchRemovalWiring
 *
 * Wires the watch Wrist_Sensor stream (`BluetoothManager.subscribeWristStatus`)
 * into the `MonitoringStateMachine`, implementing watch-removal detection and
 * wrist-restored cancellation.
 *
 * Behaviour (Requirements 7.1, 7.2, 7.3, 7.4):
 *   • When the wrist sensor reports `'off-wrist'`, a `WATCH_REMOVED` event is
 *     sent to the state machine. The machine transitions `active → alert_pending`
 *     and starts the False-Positive-Window countdown shown on both the watch and
 *     phone (handled inside the machine). The alert — if the FPW expires — is
 *     labelled "watch removal" because `WATCH_REMOVED` maps to the
 *     `watch_removal` trigger type (7.1, 7.2, 7.4).
 *   • When the wrist sensor reports `'on-wrist'` while the machine is in
 *     `alert_pending`, a `FPW_CANCEL` event is sent to cancel the countdown and
 *     resume standard monitoring without dispatching an alert (7.3).
 *
 * Design decisions:
 *   • Dependencies are injected via an options bag so the wiring is fully
 *     unit-testable without a real BLE stack or a running XState actor. The
 *     actor is accepted as a minimal {@link MonitoringActorLike} interface
 *     (just `send` + `getSnapshot`) rather than the concrete `MonitoringActorRef`.
 *   • `FPW_CANCEL` is reused (rather than introducing a new `WRIST_RESTORED`
 *     event) for wrist-restored cancellation: the state machine already treats
 *     `FPW_CANCEL` as "cancel the pending alert and resume monitoring" in
 *     `alert_pending`, which is exactly the required 7.3 behaviour. Reusing it
 *     keeps the machine unchanged.
 *   • De-duplication: consecutive identical wrist statuses are ignored so a
 *     chatty sensor cannot send repeated `WATCH_REMOVED` events (the first
 *     `off-wrist` already moved the machine out of `active`).
 *
 * Requirements covered: 7.1, 7.2, 7.3, 7.4
 */

import type {WristStatus} from '../bluetooth/BluetoothManager';

// ── Minimal collaborator interfaces ─────────────────────────────────────────

/**
 * The subset of {@link import('../bluetooth/BluetoothManager').BluetoothManager}
 * used by this wiring: just the wrist-status subscription. Accepting the
 * narrow interface keeps the wiring decoupled from the full BLE stack and
 * trivially mockable in tests.
 */
export interface WristStatusSource {
  /**
   * Subscribe to wrist-presence status notifications.
   * `fn` is invoked for every status update; the returned function
   * unsubscribes.
   */
  subscribeWristStatus(): {subscribe(fn: (value: WristStatus) => void): () => void};
}

/** Events this wiring sends to the monitoring state machine. */
export type WristWiringEvent = {type: 'WATCH_REMOVED'} | {type: 'FPW_CANCEL'};

/**
 * The subset of the XState `MonitoringActorRef` used by this wiring. Only
 * `send` and `getSnapshot().matches(...)` are needed, so we accept a minimal
 * structural interface that both the real actor and a test double satisfy.
 */
export interface MonitoringActorLike {
  /** Send an event to the running monitoring actor. */
  send(event: WristWiringEvent): void;
  /** Read the current actor snapshot (used to check the active state value). */
  getSnapshot(): {matches(stateValue: string): boolean};
}

// ── Options bag ──────────────────────────────────────────────────────────────

/** Dependency-injection bag for {@link createWatchRemovalWiring}. */
export interface WatchRemovalWiringOptions {
  /** Source of wrist-presence status updates (the BluetoothManager). */
  bluetooth: WristStatusSource;
  /** The running monitoring state-machine actor to drive. */
  actor: MonitoringActorLike;
}

/** Handle returned by {@link createWatchRemovalWiring}. */
export interface WatchRemovalWiring {
  /**
   * Begin forwarding wrist-status updates to the state machine.
   * Idempotent: calling `start` while already started is a no-op.
   */
  start(): void;
  /**
   * Stop forwarding and release the underlying BLE subscription.
   * Idempotent: safe to call when not started.
   */
  stop(): void;
}

// ── State value referenced by the wiring ─────────────────────────────────────

/**
 * The machine state during which a wrist-restored event cancels the pending
 * alert (Requirement 7.3). Kept as a constant to avoid stringly-typed drift.
 */
const ALERT_PENDING_STATE = 'alert_pending';

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create the watch-removal wiring that connects a wrist-status source to the
 * monitoring state machine.
 *
 * @param options - Injected {@link WatchRemovalWiringOptions}.
 * @returns A {@link WatchRemovalWiring} handle with `start` / `stop`.
 *
 * @example
 * ```ts
 * const wiring = createWatchRemovalWiring({bluetooth: btManager, actor});
 * wiring.start();
 * // ...later, when monitoring deactivates:
 * wiring.stop();
 * ```
 */
export function createWatchRemovalWiring(
  options: WatchRemovalWiringOptions,
): WatchRemovalWiring {
  const {bluetooth, actor} = options;

  /** Active BLE unsubscribe handle, or null when stopped. */
  let unsubscribe: (() => void) | null = null;

  /**
   * Last wrist status we acted on. Used to de-duplicate repeated identical
   * notifications so a single removal does not fan out into multiple
   * `WATCH_REMOVED` events.
   */
  let lastStatus: WristStatus | null = null;

  /**
   * Handle a single wrist-status update.
   *
   *   • `off-wrist` → `WATCH_REMOVED` (starts the FPW countdown; the machine
   *     ignores it unless currently in `active`). (7.1, 7.2, 7.4)
   *   • `on-wrist` while in `alert_pending` → `FPW_CANCEL` to cancel the
   *     countdown and resume monitoring without an alert. (7.3)
   */
  const handleStatus = (status: WristStatus): void => {
    // Ignore repeats of the status we already handled.
    if (status === lastStatus) return;
    lastStatus = status;

    if (status === 'off-wrist') {
      actor.send({type: 'WATCH_REMOVED'});
      return;
    }

    // status === 'on-wrist': only meaningful while an alert is pending.
    if (actor.getSnapshot().matches(ALERT_PENDING_STATE)) {
      actor.send({type: 'FPW_CANCEL'});
    }
  };

  return {
    start(): void {
      if (unsubscribe !== null) return; // already started
      lastStatus = null;
      unsubscribe = bluetooth.subscribeWristStatus().subscribe(handleStatus);
    },

    stop(): void {
      if (unsubscribe === null) return; // already stopped
      unsubscribe();
      unsubscribe = null;
      lastStatus = null;
    },
  };
}
