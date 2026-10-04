/**
 * MonitoringIndicator
 *
 * Persistent visual indicator shown on the phone screen while safety monitoring
 * is active, with a matching mirror pushed to the watch display (Requirement
 * 9.6):
 *
 *   "WHILE safety monitoring is active, THE Safety_App SHALL display a
 *    persistent visual indicator on the phone screen; WHEN the Smartwatch is
 *    connected and monitoring is active, THE Safety_App SHALL also display a
 *    persistent visual indicator on the Smartwatch screen."
 *
 * Behaviour:
 *   • Phone indicator — a persistent banner is rendered whenever monitoring is
 *     active.  When idle it collapses to an unobtrusive "monitoring off" state.
 *   • Watch indicator — whenever monitoring is active AND the watch is
 *     connected, the component pushes the indicator text to the watch via the
 *     injected `sendDisplayMessage` callback.  When monitoring stops (or the
 *     watch disconnects) a single clearing message is sent so the watch screen
 *     does not retain a stale indicator.
 *
 * The decision of WHAT to show on each surface is a pure, framework-agnostic
 * function ({@link resolveIndicatorState}) so the sync rule is unit-testable
 * without rendering.  The component only wires that decision to React state and
 * the injected `sendDisplayMessage` side effect (never importing the
 * BluetoothManager directly, per the task conventions).
 *
 * Requirements covered: 9.6
 */

import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

// ── Indicator copy ───────────────────────────────────────────────────────────

/** Phone banner text shown while monitoring is active. */
export const PHONE_INDICATOR_ACTIVE_TEXT = 'Safety monitoring active';

/** Phone banner text shown while monitoring is off. */
export const PHONE_INDICATOR_IDLE_TEXT = 'Safety monitoring off';

/** Message pushed to the watch display while monitoring is active. */
export const WATCH_INDICATOR_ACTIVE_TEXT = '● Monitoring active';

/** Message pushed to the watch display to clear the indicator. */
export const WATCH_INDICATOR_CLEAR_TEXT = '';

// ── Pure sync resolver (framework-agnostic, unit-testable) ───────────────────

/** Inputs to {@link resolveIndicatorState}. */
export interface IndicatorStateInput {
  /** Whether monitoring is currently active. */
  isMonitoringActive: boolean;
  /** Whether the watch is currently connected. */
  watchConnected: boolean;
}

/** Resolved indicator presentation for both surfaces. */
export interface IndicatorState {
  /** Text to render in the phone banner. */
  phoneText: string;
  /** Whether the phone banner should be shown as the "active" style. */
  phoneActive: boolean;
  /**
   * Text to push to the watch display, or `null` when nothing should be sent.
   * `null` is distinct from the empty clear string: `null` means "no change
   * needed", the empty string means "clear the watch indicator".
   */
  watchMessage: string | null;
}

/**
 * Resolve what the phone banner and watch display should show for the given
 * monitoring/connection state (Requirement 9.6).
 *
 * Watch rules:
 *   • active + connected  → push the active indicator text.
 *   • otherwise           → push the clear message (so a previously shown
 *     indicator does not linger on the watch screen).
 *
 * The component is responsible for only actually sending when the resolved
 * watch message differs from what was last sent (de-duplication).
 */
export function resolveIndicatorState(
  input: IndicatorStateInput,
): IndicatorState {
  if (input.isMonitoringActive) {
    return {
      phoneText: PHONE_INDICATOR_ACTIVE_TEXT,
      phoneActive: true,
      watchMessage: input.watchConnected
        ? WATCH_INDICATOR_ACTIVE_TEXT
        : WATCH_INDICATOR_CLEAR_TEXT,
    };
  }
  return {
    phoneText: PHONE_INDICATOR_IDLE_TEXT,
    phoneActive: false,
    watchMessage: WATCH_INDICATOR_CLEAR_TEXT,
  };
}

// ── Component ────────────────────────────────────────────────────────────────

/** Props for {@link MonitoringIndicator}. */
export interface MonitoringIndicatorProps {
  /** Whether monitoring is currently active. */
  isMonitoringActive: boolean;
  /** Whether the watch is currently connected. */
  watchConnected: boolean;
  /**
   * Callback used to mirror the indicator onto the watch display. Wired to
   * `BluetoothManager.sendDisplayMessage` by the parent screen. Optional so the
   * indicator can render phone-only when no watch sink is available.
   */
  sendDisplayMessage?: (text: string) => void | Promise<void>;
  /** Accessibility / test label. */
  testID?: string;
}

/**
 * Render the persistent phone-side monitoring indicator and keep the watch
 * display in sync via {@link MonitoringIndicatorProps.sendDisplayMessage}.
 */
export function MonitoringIndicator(
  props: MonitoringIndicatorProps,
): React.JSX.Element {
  const testID = props.testID ?? 'monitoring-indicator';

  const state = React.useMemo(
    () =>
      resolveIndicatorState({
        isMonitoringActive: props.isMonitoringActive,
        watchConnected: props.watchConnected,
      }),
    [props.isMonitoringActive, props.watchConnected],
  );

  // Track the last message pushed to the watch so we only send on change,
  // avoiding a redundant BLE write on every re-render (Requirement 9.6).
  const lastWatchMessageRef = React.useRef<string | null>(null);
  const {sendDisplayMessage} = props;

  React.useEffect(() => {
    if (!sendDisplayMessage) {
      return;
    }
    const next = state.watchMessage;
    if (next === null || next === lastWatchMessageRef.current) {
      return;
    }
    lastWatchMessageRef.current = next;
    // Fire-and-forget: the indicator must not block rendering on the BLE write.
    void Promise.resolve(sendDisplayMessage(next)).catch(() => {
      // Ignore push failures — the phone indicator remains the source of truth.
    });
  }, [state.watchMessage, sendDisplayMessage]);

  return (
    <View
      testID={testID}
      accessibilityRole="text"
      accessibilityLabel={state.phoneText}
      accessibilityState={{selected: state.phoneActive}}
      style={[
        styles.banner,
        state.phoneActive ? styles.bannerActive : styles.bannerIdle,
      ]}>
      <View
        style={[styles.dot, state.phoneActive ? styles.dotActive : styles.dotIdle]}
      />
      <Text style={styles.bannerText}>{state.phoneText}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  bannerActive: {
    backgroundColor: '#E8F5E9',
  },
  bannerIdle: {
    backgroundColor: '#EEEEEE',
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: 10,
  },
  dotActive: {
    backgroundColor: '#2E7D32',
  },
  dotIdle: {
    backgroundColor: '#9E9E9E',
  },
  bannerText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#212121',
  },
});

export default MonitoringIndicator;
