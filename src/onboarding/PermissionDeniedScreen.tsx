/**
 * PermissionDeniedScreen
 *
 * Shown when a required permission is denied during onboarding (Requirement
 * 10.4). It displays:
 *
 *   • the denied permission's name,
 *   • which features will be unavailable without it, and
 *   • a button that deep-links to the relevant section of the device's system
 *     settings so the user can grant the permission.
 *
 * The denial copy (name + affected features) is sourced from
 * {@link PERMISSION_DENIAL} so it stays in sync with {@link PermissionManager}
 * and is independently assertable in tests. The settings deep-link is performed
 * by {@link PermissionManager.openSettings} (react-native `Linking.openSettings`
 * under the hood), injected via the `onOpenSettings` prop.
 *
 * Style mirrors {@link ManualTriggerButton} / {@link PermissionRationaleScreen}.
 *
 * Requirements: 10.4
 */

import React from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {
  PERMISSION_DENIAL,
  type AppPermission,
} from './PermissionManager';

/** Props for {@link PermissionDeniedScreen}. */
export interface PermissionDeniedScreenProps {
  /** The permission that was denied. */
  permission: AppPermission;
  /**
   * Opens the relevant section of the device system settings. Wire this to
   * {@link PermissionManager.openSettings}.
   */
  onOpenSettings: () => void;
  /** Invoked when the user retries the in-app request. Optional. */
  onRetry?: () => void;
  /** Accessibility / test label root. */
  testID?: string;
}

/**
 * Render the denial screen for a single permission (Requirement 10.4): the
 * denied permission name, the affected features, and a system-settings
 * deep-link button.
 */
export function PermissionDeniedScreen(
  props: PermissionDeniedScreenProps,
): React.JSX.Element {
  const info = PERMISSION_DENIAL[props.permission];
  const rootTestID = props.testID ?? `permission-denied-${props.permission}`;

  return (
    <ScrollView
      testID={rootTestID}
      contentContainerStyle={styles.container}
      accessibilityLabel={`${info.title} permission denied`}>
      <Text style={styles.heading} accessibilityRole="header">
        {info.title} permission is required
      </Text>

      <Text style={styles.subheading} testID={`${rootTestID}-name`}>
        You denied the {info.title} permission. The following features will be
        unavailable until it is granted:
      </Text>

      <View style={styles.featureList} testID={`${rootTestID}-features`}>
        {info.affectedFeatures.map((feature, index) => (
          <View key={feature} style={styles.featureRow}>
            <Text style={styles.bullet}>•</Text>
            <Text
              style={styles.featureText}
              testID={`${rootTestID}-feature-${index}`}>
              {feature}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.actions}>
        <View
          testID={`${rootTestID}-open-settings`}
          accessibilityRole="button"
          accessibilityLabel={`Open system settings to grant ${info.title}`}
          onTouchEnd={props.onOpenSettings}
          style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>Open settings</Text>
        </View>

        {props.onRetry ? (
          <View
            testID={`${rootTestID}-retry`}
            accessibilityRole="button"
            accessibilityLabel={`Try allowing ${info.title} again`}
            onTouchEnd={props.onRetry}
            style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Try again</Text>
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
    color: '#B71C1C',
    marginBottom: 16,
  },
  subheading: {
    fontSize: 16,
    lineHeight: 24,
    color: '#333333',
    marginBottom: 16,
  },
  featureList: {
    marginBottom: 32,
    gap: 8,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  bullet: {
    fontSize: 16,
    lineHeight: 24,
    color: '#333333',
    marginRight: 8,
  },
  featureText: {
    flex: 1,
    fontSize: 16,
    lineHeight: 24,
    color: '#333333',
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

export default PermissionDeniedScreen;
