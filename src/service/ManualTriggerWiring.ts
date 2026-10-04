/**
 * ManualTriggerWiring
 *
 * Wires a watch-side manual distress trigger (a dedicated physical button /
 * gesture that must be held for ≥ 2 seconds) to the {@link MonitoringStateMachine}
 * as a `MANUAL_TRIGGER` event.
 *
 * Design decisions:
 *   • This module deliberately does NOT touch the `off-wrist` / `on-wrist` wiring
 *     (that is owned by the watch-removal wiring, task 11.2).  It only consumes a
 *     stream of raw button press/release edges and measures the hold duration.
 *   • The long-press threshold (≥ 2 s) is enforced here so that incidental
 *     contact cannot activate the alert (Requirement 6.1).
 *   • All collaborators are injected via an options bag so the wiring is fully
 *     unit-testable without a real BLE stack, timers, or state-machine actor:
 *       - `pressEvents$` — Observable of {@link ButtonEdge} press/release edges.
 *       - `isAppReachable` — predicate reporting watch⇄phone connectivity.
 *       - `send` — dispatch function into the monitoring state machine.
 *       - `sendDisplayMessage` — pushes an error to the watch display when the
 *         phone is unreachable (Requirement 6.5).
 *       - `now` — injectable clock for deterministic hold-duration measurement.
 *   • When the watch button is held ≥ 2 s AND the Safety_App is reachable, a
 *     `MANUAL_TRIGGER` event is dispatched to the state machine (Requirements
 *     6.1, 6.2).  The False-Positive-Window / cancellation behaviour that applies
 *     to manual alerts (Requirement 6.3) is already handled by the state machine's
 *     `alert_pending` state, so no extra work is needed here.
 *   • If the trigger fires while the Safety_App is unreachable, the trigger is NOT
 *     silently discarded: an error message is shown on the watch display instead
 *     (Requirement 6.5).
 *
 * Requirements covered: 6.1, 6.2, 6.3 (via state machine), 6.5
 */

import type {Observable} from '../heartrate/HeartRateMonitor';
import type {MonitoringEvent} from '../state/MonitoringStateMachine';

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Minimum hold duration (ms) required to treat a watch button hold as a manual
 * trigger.  Requirement 6.1 specifies at least 2 seconds to prevent accidental
 * activation from incidental contact.
 */
export const MANUAL_TRIGGER_HOLD_MS = 2_000;

/**
 * Error text shown on the watch display when the manual trigger fires but the
 * Safety_App (phone) is not reachable (Requirement 6.5).  Exported so UI/tests
 * can assert the exact copy.
 */
export const PHONE_UNREACHABLE_MESSAGE = 'Phone not connected — alert not sent';

// ── Supporting types ───────────────────────────────────────────────────────

/**
 * A raw press/release edge from the watch's dedicated manual-trigger button.
 *
 * `kind: 'down'` marks the instant the button was pressed; `kind: 'up'` marks
 * the instant it was released.  `timestamp` is a Unix-ms time captured by the
 * BLE layer when the edge was observed; when omitted, the wiring falls back to
 * its injected `now()` clock.
 */
export interface ButtonEdge {
  kind: 'down' | 'up';
  timestamp?: number;
}

/**
 * Dependency-injection bag for {@link createManualTriggerWiring}.
 */
export interface ManualTriggerWiringOptions {
  /**
   * Observable stream of raw button press/release edges originating from the
   * watch's dedicated manual-trigger button.  In production this is produced by
   * the BLE layer; in tests it is a plain {@link Observable} the test drives.
   */
  pressEvents$: Observable<ButtonEdge>;

  /**
   * Dispatch function into the monitoring state machine.  Wired to
   * `monitoringActor.send` in production.
   */
  send: (event: MonitoringEvent) => void;

  /**
   * Predicate reporting whether the Safety_App (phone) is currently reachable
   * from the watch — i.e. the BLE link is up.  Evaluated at the moment the hold
   * completes so the trigger reflects live connectivity (Requirement 6.5).
   */
  isAppReachable: () => boolean;

  /**
   * Pushes an error message to the watch display.  Wired to
   * `BluetoothManager.sendDisplayMessage` in production.  Invoked only when the
   * trigger fires while the phone is unreachable (Requirement 6.5).
   */
  sendDisplayMessage: (text: string) => void;

  /**
   * Injectable clock used to measure hold duration.  Defaults to `Date.now`.
   * Edge timestamps, when present, take precedence over this clock.
   */
  now?: () => number;
}

/** Handle returned by {@link createManualTriggerWiring}. */
export interface ManualTriggerWiring {
  /** Tear down the press-event subscription. */
  dispose(): void;
}

// ── Pure helper ──────────────────────────────────────────────────────────────

/**
 * Decide whether a hold duration qualifies as a manual trigger.
 *
 * A hold qualifies when it lasted at least {@link MANUAL_TRIGGER_HOLD_MS}
 * (Requirement 6.1).  Exported as a pure function so the long-press rule can be
 * unit-tested in isolation and reused by the phone-side button.
 *
 * @param holdDurationMs - Milliseconds the button/control was held.
 * @returns `true` when the hold is long enough to trigger a manual alert.
 */
export function isManualTriggerHold(holdDurationMs: number): boolean {
  return holdDurationMs >= MANUAL_TRIGGER_HOLD_MS;
}

// ── Wiring factory ───────────────────────────────────────────────────────────

/**
 * Create and activate the watch-side manual-trigger wiring.
 *
 * Subscribes to the injected `pressEvents$` stream, measures the hold duration
 * between each `down` edge and the following `up` edge, and — when the hold is
 * at least {@link MANUAL_TRIGGER_HOLD_MS} — either dispatches `MANUAL_TRIGGER`
 * (phone reachable) or shows an error on the watch display (phone unreachable).
 *
 * @param options - Injected collaborators (see {@link ManualTriggerWiringOptions}).
 * @returns A {@link ManualTriggerWiring} handle; call `dispose()` to unsubscribe.
 *
 * @example
 * ```ts
 * const wiring = createManualTriggerWiring({
 *   pressEvents$: bluetoothManager.subscribeManualButton(),
 *   send: monitoringActor.send,
 *   isAppReachable: () => connectionState === 'connected',
 *   sendDisplayMessage: text => bluetoothManager.sendDisplayMessage(text),
 * });
 * // later: wiring.dispose();
 * ```
 */
export function createManualTriggerWiring(
  options: ManualTriggerWiringOptions,
): ManualTriggerWiring {
  const now = options.now ?? (() => Date.now());

  /**
   * Timestamp of the most recent unmatched `down` edge, or null when the button
   * is not currently held.  Measuring from this to the matching `up` edge gives
   * the hold duration.
   */
  let pressStartedAt: number | null = null;

  /** Resolve the effective time for an edge: explicit timestamp else clock. */
  const edgeTime = (edge: ButtonEdge): number =>
    typeof edge.timestamp === 'number' ? edge.timestamp : now();

  /**
   * Fire the manual trigger: dispatch to the state machine when the phone is
   * reachable (6.2), otherwise surface an error on the watch display (6.5).
   *
   * @param triggeredAt - Unix-ms time the hold completed.
   */
  const fireTrigger = (triggeredAt: number): void => {
    if (options.isAppReachable()) {
      // Requirement 6.2 — initiate the distress alert workflow. The state
      // machine applies the configured False-Positive-Window to manual alerts
      // (Requirement 6.3) via its `alert_pending` state.
      options.send({type: 'MANUAL_TRIGGER', triggeredAt});
    } else {
      // Requirement 6.5 — do NOT silently discard; show an error on the watch.
      options.sendDisplayMessage(PHONE_UNREACHABLE_MESSAGE);
    }
  };

  const unsubscribe = options.pressEvents$.subscribe((edge: ButtonEdge) => {
    const t = edgeTime(edge);

    if (edge.kind === 'down') {
      // Begin (or restart) measuring a hold.
      pressStartedAt = t;
      return;
    }

    // edge.kind === 'up'
    if (pressStartedAt === null) {
      // Release without a matching press — ignore (defensive).
      return;
    }

    const holdDurationMs = t - pressStartedAt;
    pressStartedAt = null;

    if (isManualTriggerHold(holdDurationMs)) {
      fireTrigger(t);
    }
    // Holds shorter than the threshold are ignored (Requirement 6.1).
  });

  return {
    dispose: () => {
      unsubscribe();
    },
  };
}
