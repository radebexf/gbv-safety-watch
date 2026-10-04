/**
 * ManualTriggerButton
 *
 * Phone-side manual distress trigger control (Requirement 6.4).
 *
 * The control requires a deliberate action — a long-press held for at least
 * {@link MANUAL_TRIGGER_HOLD_MS} (2 s) — before it dispatches a `MANUAL_TRIGGER`
 * event into the {@link MonitoringStateMachine}.  This prevents accidental
 * activation from an incidental tap.  Optionally, a confirmation dialog can be
 * used instead of (or in addition to) the long-press via the `useConfirmation`
 * prop; both satisfy the "deliberate action" requirement.
 *
 * The False-Positive-Window / cancellation behaviour that applies to manual
 * alerts (Requirement 6.3) is handled by the state machine's `alert_pending`
 * state, so this component's sole responsibility is enforcing the deliberate
 * action and dispatching the event.
 *
 * Design decisions:
 *   • The long-press timing logic lives in the exported, framework-agnostic
 *     {@link createLongPressController} so it is unit-testable without rendering.
 *   • The `send` dispatch function and timing/`now` dependencies are injected via
 *     props, keeping the component decoupled from any concrete actor instance.
 *
 * Requirements covered: 6.3 (via state machine), 6.4
 */

import React from 'react';
import {Alert, StyleSheet, Text, View} from 'react-native';
import type {MonitoringEvent} from '../state/MonitoringStateMachine';
import {MANUAL_TRIGGER_HOLD_MS} from '../service/ManualTriggerWiring';

export {MANUAL_TRIGGER_HOLD_MS};

// ── Long-press controller (framework-agnostic, unit-testable) ────────────────

/** Injected timers/clock for {@link createLongPressController}. */
export interface LongPressTimers {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
}

/** Options bag for {@link createLongPressController}. */
export interface LongPressControllerOptions {
  /** Minimum hold duration (ms) before the long-press fires. */
  holdMs?: number;
  /** Invoked exactly once when the hold reaches `holdMs` without release. */
  onLongPress: () => void;
  /** Timer functions; default to the host globals. Inject fakes in tests. */
  timers?: LongPressTimers;
}

/** Handle returned by {@link createLongPressController}. */
export interface LongPressController {
  /** Call when the press begins (finger down). Starts the hold timer. */
  pressIn(): void;
  /** Call when the press ends (finger up). Cancels a pending hold. */
  pressOut(): void;
  /** Whether a hold is currently being measured. */
  readonly isPressing: boolean;
}

/**
 * Create a long-press controller that fires `onLongPress` only when a press is
 * held continuously for at least `holdMs` (default {@link MANUAL_TRIGGER_HOLD_MS}).
 *
 * A release before the threshold cancels the pending callback, so short taps
 * never trigger (Requirement 6.4).  Framework-agnostic and fully deterministic
 * when supplied with fake timers.
 */
export function createLongPressController(
  options: LongPressControllerOptions,
): LongPressController {
  const holdMs = options.holdMs ?? MANUAL_TRIGGER_HOLD_MS;
  const timers: LongPressTimers = options.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
  };

  let timerId: ReturnType<typeof setTimeout> | null = null;
  let pressing = false;

  const clear = (): void => {
    if (timerId !== null) {
      timers.clearTimeout(timerId);
      timerId = null;
    }
  };

  return {
    pressIn(): void {
      pressing = true;
      clear();
      timerId = timers.setTimeout(() => {
        timerId = null;
        pressing = false;
        options.onLongPress();
      }, holdMs);
    },
    pressOut(): void {
      pressing = false;
      clear();
    },
    get isPressing(): boolean {
      return pressing;
    },
  };
}

// ── Component ────────────────────────────────────────────────────────────────

/** Props for {@link ManualTriggerButton}. */
export interface ManualTriggerButtonProps {
  /**
   * Dispatch function into the monitoring state machine. Wired to
   * `monitoringActor.send` by the parent screen.
   */
  send: (event: MonitoringEvent) => void;
  /**
   * When `true`, present a confirmation dialog on press instead of requiring a
   * long-press hold. Either path satisfies the "deliberate action" rule
   * (Requirement 6.4). Defaults to `false` (long-press).
   */
  useConfirmation?: boolean;
  /** Minimum hold duration (ms) for the long-press. Defaults to 2 s. */
  holdMs?: number;
  /** Clock used to timestamp the trigger. Defaults to `Date.now`. */
  now?: () => number;
  /** Accessibility / test label. */
  testID?: string;
}

/**
 * Render the phone-side manual trigger button.
 *
 * Long-press mode (default): the user must hold the button for `holdMs`
 * before `MANUAL_TRIGGER` is dispatched. Confirmation mode: a single tap opens
 * a confirm dialog; dispatch happens only on explicit confirmation.
 */
export function ManualTriggerButton(
  props: ManualTriggerButtonProps,
): React.JSX.Element {
  const now = props.now ?? (() => Date.now());

  const dispatchTrigger = React.useCallback(() => {
    props.send({type: 'MANUAL_TRIGGER', triggeredAt: now()});
  }, [props, now]);

  const controllerRef = React.useRef<LongPressController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createLongPressController({
      holdMs: props.holdMs,
      onLongPress: dispatchTrigger,
    });
  }

  const [isHolding, setIsHolding] = React.useState(false);

  const handlePressIn = React.useCallback(() => {
    if (props.useConfirmation) {
      return;
    }
    setIsHolding(true);
    controllerRef.current?.pressIn();
  }, [props.useConfirmation]);

  const handlePressOut = React.useCallback(() => {
    setIsHolding(false);
    controllerRef.current?.pressOut();
  }, []);

  const handlePress = React.useCallback(() => {
    if (!props.useConfirmation) {
      return;
    }
    Alert.alert(
      'Send distress alert?',
      'This will start the safety alert workflow and notify your emergency contacts.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Send alert', style: 'destructive', onPress: dispatchTrigger},
      ],
    );
  }, [props.useConfirmation, dispatchTrigger]);

  const label = props.useConfirmation
    ? 'Send Alert'
    : isHolding
    ? 'Keep holding…'
    : 'Hold for 2s to Alert';

  return (
    <View
      // Press handlers are provided via accessibilityActions-friendly props so
      // this renders as a pressable region. We use a plain View with the RN
      // Pressable-style callbacks forwarded through props spread for testability.
      testID={props.testID ?? 'manual-trigger-button'}
      accessibilityRole="button"
      accessibilityLabel="Manual distress trigger"
      onTouchStart={handlePressIn}
      onTouchEnd={props.useConfirmation ? handlePress : handlePressOut}
      style={styles.button}>
      <Text style={styles.buttonText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: '#C62828',
    paddingVertical: 20,
    paddingHorizontal: 32,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
});

export default ManualTriggerButton;
