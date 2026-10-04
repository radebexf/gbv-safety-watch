/**
 * AlertDeliverySummary
 *
 * Post-alert delivery summary screen shown on the phone once an alert dispatch
 * has completed (Requirement 5.4):
 *
 *   "WHEN all retry attempts for all Emergency_Contacts are exhausted, THE
 *    Safety_App SHALL display a confirmation to the user on the phone screen
 *    listing each Emergency_Contact and their delivery status (delivered or
 *    unreachable); IF all contacts are registered but zero were reachable, THE
 *    Safety_App SHALL additionally display an inline error message indicating
 *    that no contacts could be reached."
 *
 * The component renders one row per {@link ContactDeliveryResult} showing the
 * contact's name and whether the message was delivered or the contact was
 * unreachable.  When every contact was unreachable it also shows an inline
 * all-unreachable error banner.
 *
 * The "all unreachable" decision is a pure, framework-agnostic function
 * ({@link summarizeDelivery}) so the rule can be unit-tested without rendering.
 * The component follows the {@link ManualTriggerButton} style: plain
 * `View` / `Text` / `StyleSheet`, explicit accessibility labels, and an
 * injectable `onDismiss` callback.
 *
 * Requirements covered: 5.4
 */

import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import type {AlertDispatchResult, ContactDeliveryResult} from '../types';

// ── Copy ─────────────────────────────────────────────────────────────────────

/** Inline error shown when zero of the registered contacts were reachable. */
export const ALL_UNREACHABLE_ERROR_MESSAGE =
  'No emergency contacts could be reached. Please try again or contact help directly.';

/** Per-status row label. */
export const DELIVERED_LABEL = 'Delivered';
export const UNREACHABLE_LABEL = 'Unreachable';

// ── Pure summary resolver (framework-agnostic, unit-testable) ────────────────

/** Aggregate view of a dispatch result. */
export interface DeliverySummary {
  /** Count of contacts marked delivered. */
  deliveredCount: number;
  /** Count of contacts marked unreachable. */
  unreachableCount: number;
  /** Total number of contacts the alert was attempted against. */
  totalCount: number;
  /**
   * True when at least one contact was attempted and none were reachable
   * (Requirement 5.4 — the all-unreachable error condition).
   */
  allUnreachable: boolean;
}

/**
 * Compute the aggregate delivery summary from per-contact results.
 *
 * `allUnreachable` is only true when there is at least one contact result and
 * every one of them is `unreachable` (Requirement 5.4). An empty result list
 * yields `allUnreachable: false` (there were no contacts to fail).
 */
export function summarizeDelivery(
  results: readonly ContactDeliveryResult[],
): DeliverySummary {
  let deliveredCount = 0;
  let unreachableCount = 0;
  for (const r of results) {
    if (r.status === 'delivered') {
      deliveredCount += 1;
    } else {
      unreachableCount += 1;
    }
  }
  const totalCount = results.length;
  return {
    deliveredCount,
    unreachableCount,
    totalCount,
    allUnreachable: totalCount > 0 && deliveredCount === 0,
  };
}

// ── Component ────────────────────────────────────────────────────────────────

/** Props for {@link AlertDeliverySummary}. */
export interface AlertDeliverySummaryProps {
  /**
   * The completed dispatch result to summarise. When `null`, nothing is
   * rendered (no alert has been dispatched this session).
   */
  result: AlertDispatchResult | null;
  /**
   * Invoked when the user dismisses the summary (e.g. taps "Done"). Wired by
   * the parent to send `RESUME` into the state machine. Optional.
   */
  onDismiss?: () => void;
  /** Accessibility / test label prefix. */
  testID?: string;
}

/**
 * Render the per-contact delivery summary with an optional all-unreachable
 * error banner (Requirement 5.4).
 */
export function AlertDeliverySummary(
  props: AlertDeliverySummaryProps,
): React.JSX.Element | null {
  const testID = props.testID ?? 'alert-delivery-summary';

  const summary = React.useMemo(
    () =>
      props.result
        ? summarizeDelivery(props.result.contactResults)
        : null,
    [props.result],
  );

  if (!props.result || !summary) {
    return null;
  }

  return (
    <View testID={testID} style={styles.container}>
      <Text
        testID={`${testID}-title`}
        accessibilityRole="header"
        style={styles.title}>
        Alert delivery summary
      </Text>

      <Text style={styles.subtitle}>
        {summary.deliveredCount} of {summary.totalCount} contacts reached
      </Text>

      {summary.allUnreachable ? (
        <Text
          testID={`${testID}-all-unreachable-error`}
          accessibilityRole="alert"
          accessibilityLabel={ALL_UNREACHABLE_ERROR_MESSAGE}
          style={styles.error}>
          {ALL_UNREACHABLE_ERROR_MESSAGE}
        </Text>
      ) : null}

      <View testID={`${testID}-list`} style={styles.list}>
        {props.result.contactResults.map(item => {
          const delivered = item.status === 'delivered';
          const statusLabel = delivered ? DELIVERED_LABEL : UNREACHABLE_LABEL;
          const rowLabel = `${item.contact.name}: ${statusLabel}`;
          return (
            <View
              key={item.contact.id}
              testID={`${testID}-row-${item.contact.id}`}
              accessibilityLabel={rowLabel}
              style={styles.row}>
              <Text style={styles.contactName}>{item.contact.name}</Text>
              <Text
                style={[
                  styles.status,
                  delivered ? styles.statusDelivered : styles.statusUnreachable,
                ]}>
                {statusLabel}
              </Text>
            </View>
          );
        })}
      </View>

      <View
        testID={`${testID}-dismiss`}
        accessibilityRole="button"
        accessibilityLabel="Dismiss delivery summary"
        onTouchEnd={props.onDismiss}
        style={styles.dismiss}>
        <Text style={styles.dismissText}>Done</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#212121',
  },
  subtitle: {
    marginTop: 4,
    fontSize: 14,
    color: '#616161',
  },
  error: {
    marginTop: 12,
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#FFEBEE',
    color: '#C62828',
    fontSize: 14,
    fontWeight: '600',
  },
  list: {
    marginTop: 16,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E0E0E0',
  },
  contactName: {
    fontSize: 16,
    color: '#212121',
    flexShrink: 1,
  },
  status: {
    fontSize: 14,
    fontWeight: '700',
    marginLeft: 12,
  },
  statusDelivered: {
    color: '#2E7D32',
  },
  statusUnreachable: {
    color: '#C62828',
  },
  dismiss: {
    marginTop: 24,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1565C0',
  },
  dismissText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
});

export default AlertDeliverySummary;
