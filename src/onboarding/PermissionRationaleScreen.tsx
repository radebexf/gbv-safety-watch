/**
 * PermissionRationaleScreen
 *
 * The plain-language rationale screen shown BEFORE each system permission
 * dialog during onboarding (Requirement 10.3). It explains the specific purpose
 * of a single permission (Bluetooth, Location, SMS, or Notifications) and lets
 * the user acknowledge the rationale ("Continue") — which then triggers the OS
 * permission dialog — or defer it ("Not now").
 *
 * The screen is a pure presentational component: it renders the copy supplied
 * via {@link PERMISSION_RATIONALE} and reports the user's acknowledgement
 * through callbacks. The ordering guarantee (rationale always precedes the OS
 * dialog) is enforced by {@link PermissionManager.requestWithRationale}; this
 * component simply resolves that flow's `onShowRationale` promise when the user
 * taps "Continue".
 *
 * Style mirrors {@link ManualTriggerButton} (plain View + Text + StyleSheet,
 * accessibility labels, injectable callbacks).
 *
 * Requirements: 10.3
 */

import React from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {
  PERMISSION_RATIONALE,
  type AppPermission,
} from './PermissionManager';

/** Props for {@link PermissionRationaleScreen}. */
export interface PermissionRationaleScreenProps {
  /** The permission whose rationale is being presented. */
  permission: AppPermission;
  /**
   * Invoked when the user acknowledges the rationale ("Continue"). The caller
   * should then trigger the OS permission dialog.
   */
  onContinue: () => void;
  /** Invoked when the user defers the request ("Not now"). Optional. */
  onDefer?: () => void;
  /** Accessibility / test label root. */
  testID?: string;
}

/**
 * Render the plain-language rationale for a single permission (Requirement
 * 10.3). The copy is sourced from {@link PERMISSION_RATIONALE} so it stays in
 * sync with the permission manager and is independently assertable in tests.
 */
export function PermissionRationaleScreen(
  props: PermissionRationaleScreenProps,
): React.JSX.Element {
  const rationale = PERMISSION_RATIONALE[props.permission];
  const rootTestID = props.testID ?? `permission-rationale-${props.permission}`;

  return (
    <ScrollView
      testID={rootTestID}
      contentContainerStyle={styles.container}
      accessibilityLabel={`${rationale.title} permission rationale`}>
      <Text style={styles.heading} accessibilityRole="header">
        Allow {rationale.title}
      </Text>

      <Text style={styles.body} testID={`${rootTestID}-body`}>
        {rationale.body}
      </Text>

      <View style={styles.actions}>
        <View
          testID={`${rootTestID}-continue`}
          accessibilityRole="button"
          accessibilityLabel={`Continue to allow ${rationale.title}`}
          onTouchEnd={props.onContinue}
          style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>Continue</Text>
        </View>

        {props.onDefer ? (
          <View
            testID={`${rootTestID}-defer`}
            accessibilityRole="button"
            accessibilityLabel={`Not now for ${rationale.title}`}
            onTouchEnd={props.onDefer}
            style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Not now</Text>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 24,
    flexGrow: 1,
    justifyContent: 'center',
  },
  heading: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1A1A1A',
    marginBottom: 16,
  },
  body: {
    fontSize: 16,
    lineHeight: 24,
    color: '#333333',
    marginBottom: 32,
  },
  actions: {
    gap: 12,
  },
  primaryButton: {
    backgroundColor: '#1565C0',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryButton: {
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#1565C0',
    fontSize: 16,
    fontWeight: '600',
  },
});

export default PermissionRationaleScreen;
