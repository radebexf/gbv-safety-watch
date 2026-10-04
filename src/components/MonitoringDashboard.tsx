/**
 * MonitoringDashboard
 *
 * Phone-side control surface for activating and deactivating safety monitoring
 * (Requirements 9.1, 9.6, 4.6).
 *
 * Responsibilities:
 *   • Render a single control labeled "Activate Monitoring" when monitoring is
 *     idle and "Deactivate Monitoring" when it is active (Requirement 9.1).
 *   • Keep the activate control DISABLED until onboarding is complete AND at
 *     least one emergency contact is registered (Requirements 9.1, 4.6, 10.5).
 *   • Dispatch `ACTIVATE` / `DEACTIVATE` events into the
 *     {@link MonitoringStateMachine} via an injected `send` prop, carrying the
 *     activation preconditions the machine's `canActivate` guard expects.
 *   • Surface an inline error when the user attempts to activate without a
 *     registered contact (Requirement 4.6).
 *
 * The gating decision is a pure, framework-agnostic function
 * ({@link computeActivationGate}) computed from injected props so it can be unit
 * tested without rendering.  The component itself follows the style of
 * {@link ManualTriggerButton}: plain `View` / `Text` / `StyleSheet`, explicit
 * accessibility labels, and injected callbacks/props (never importing the
 * BluetoothManager or concrete actor directly).
 *
 * Requirements covered: 9.1, 9.6, 4.6
 */

import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import type {EmergencyContact} from '../types';
import type {MonitoringEvent} from '../state/MonitoringStateMachine';
import {MonitoringIndicator} from './MonitoringIndicator';

// ── Activation gate (framework-agnostic, unit-testable) ──────────────────────

/** Inline error copy shown when activation is attempted without a contact. */
export const NO_CONTACT_ERROR_MESSAGE =
  'At least one emergency contact is required to activate monitoring.';

/** Inputs to the pure activation-gate computation. */
export interface ActivationGateInput {
  /** Whether onboarding has been completed (Requirements 9.1, 10.5). */
  onboardingComplete: boolean;
  /** Number of registered emergency contacts (Requirements 4.6, 9.4). */
  contactCount: number;
}

/** Result of the pure activation-gate computation. */
export interface ActivationGate {
  /**
   * Whether the "Activate Monitoring" control may be enabled.  True only when
   * onboarding is complete AND at least one contact is registered.
   */
  canActivate: boolean;
  /**
   * Human-readable reason the control is disabled, or `null` when enabled.
   * Suitable for display beneath a disabled control.
   */
  disabledReason: string | null;
}

/**
 * Compute whether the activate control should be enabled, from injected props.
 *
 * Pure and side-effect free so the gating rule can be exercised directly in
 * unit tests without a rendered component (Requirements 9.1, 4.6).
 */
export function computeActivationGate(
  input: ActivationGateInput,
): ActivationGate {
  if (!input.onboardingComplete) {
    return {
      canActivate: false,
      disabledReason: 'Complete onboarding to enable monitoring.',
    };
  }
  if (input.contactCount < 1) {
    return {
      canActivate: false,
      disabledReason: NO_CONTACT_ERROR_MESSAGE,
    };
  }
  return {canActivate: true, disabledReason: null};
}

// ── Component ────────────────────────────────────────────────────────────────

/** Props for {@link MonitoringDashboard}. */
export interface MonitoringDashboardProps {
  /** Whether monitoring is currently active (drives label + indicator). */
  isMonitoringActive: boolean;
  /** Whether onboarding has been completed (gating input). */
  onboardingComplete: boolean;
  /** Number of registered emergency contacts (gating input). */
  contactCount: number;
  /** The registered emergency contacts, forwarded to the ACTIVATE event. */
  contacts: EmergencyContact[];
  /** Whether the watch is currently connected (forwarded to ACTIVATE). */
  watchConnected: boolean;
  /**
   * Dispatch function into the monitoring state machine. Wired to
   * `monitoringActor.send` by the parent screen.
   */
  send: (event: MonitoringEvent) => void;
  /** Accessibility / test label prefix. */
  testID?: string;
}

/**
 * Render the monitoring activation dashboard with its persistent indicator.
 *
 * The single primary control toggles between activate and deactivate depending
 * on {@link MonitoringDashboardProps.isMonitoringActive}.  When monitoring is
 * idle, the control is disabled unless {@link computeActivationGate} permits
 * activation.  Pressing a disabled-for-contacts control surfaces the inline
 * no-contact error (Requirement 4.6).
 */
export function MonitoringDashboard(
  props: MonitoringDashboardProps,
): React.JSX.Element {
  const testID = props.testID ?? 'monitoring-dashboard';

  const gate = React.useMemo(
    () =>
      computeActivationGate({
        onboardingComplete: props.onboardingComplete,
        contactCount: props.contactCount,
      }),
    [props.onboardingComplete, props.contactCount],
  );

  const [inlineError, setInlineError] = React.useState<string | null>(null);

  // Clear a stale inline error once activation becomes possible again.
  React.useEffect(() => {
    if (gate.canActivate) {
      setInlineError(null);
    }
  }, [gate.canActivate]);

  const handleDeactivate = React.useCallback(() => {
    props.send({type: 'DEACTIVATE'});
  }, [props]);

  const handleActivate = React.useCallback(() => {
    // Requirement 4.6 — reject activation with no contact and show the error.
    if (props.contactCount < 1) {
      setInlineError(NO_CONTACT_ERROR_MESSAGE);
      return;
    }
    if (!gate.canActivate) {
      // Onboarding incomplete (or other gate) — do not dispatch.
      return;
    }
    setInlineError(null);
    props.send({
      type: 'ACTIVATE',
      contacts: props.contacts,
      onboardingCompleted: props.onboardingComplete,
      watchConnected: props.watchConnected,
    });
  }, [props, gate.canActivate]);

  const controlLabel = props.isMonitoringActive
    ? 'Deactivate Monitoring'
    : 'Activate Monitoring';

  // The control is only ever disabled in the idle state when the gate fails.
  const isControlDisabled = !props.isMonitoringActive && !gate.canActivate;

  return (
    <View testID={testID} style={styles.container}>
      <MonitoringIndicator
        isMonitoringActive={props.isMonitoringActive}
        watchConnected={props.watchConnected}
        testID={`${testID}-indicator`}
      />

      <View
        testID={`${testID}-control`}
        accessibilityRole="button"
        accessibilityLabel={controlLabel}
        accessibilityState={{disabled: isControlDisabled}}
        onTouchEnd={props.isMonitoringActive ? handleDeactivate : handleActivate}
        style={[
          styles.control,
          props.isMonitoringActive ? styles.controlActive : styles.controlIdle,
          isControlDisabled && styles.controlDisabled,
        ]}>
        <Text style={styles.controlText}>{controlLabel}</Text>
      </View>

      {isControlDisabled && gate.disabledReason ? (
        <Text
          testID={`${testID}-disabled-reason`}
          accessibilityLabel={gate.disabledReason}
          style={styles.disabledReason}>
          {gate.disabledReason}
        </Text>
      ) : null}

      {inlineError ? (
        <Text
          testID={`${testID}-error`}
          accessibilityRole="alert"
          accessibilityLabel={inlineError}
          style={styles.error}>
          {inlineError}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    alignItems: 'stretch',
  },
  control: {
    paddingVertical: 20,
    paddingHorizontal: 32,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
  },
  controlIdle: {
    backgroundColor: '#2E7D32',
  },
  controlActive: {
    backgroundColor: '#C62828',
  },
  controlDisabled: {
    backgroundColor: '#9E9E9E',
    opacity: 0.6,
  },
  controlText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  disabledReason: {
    marginTop: 8,
    color: '#616161',
    fontSize: 14,
    textAlign: 'center',
  },
  error: {
    marginTop: 8,
    color: '#C62828',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
});

export default MonitoringDashboard;
