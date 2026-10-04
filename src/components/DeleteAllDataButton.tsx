/**
 * DeleteAllDataButton
 *
 * App-settings control for the "Delete All Personal Data" feature
 * (Requirements 11.3, 11.4).
 *
 * This control is intentionally free of any onboarding / monitoring gating: it
 * renders and functions identically regardless of whether onboarding has been
 * completed or monitoring is currently active (Requirement 11.3). Parent
 * screens must therefore place it where it is always reachable (e.g. a settings
 * screen accessible from both the onboarding and main app shells).
 *
 * Deletion is irreversible, so the button never deletes on a single tap.
 * Instead it presents an explicit confirmation dialog (`Alert.alert`) with a
 * clearly destructive confirm action; data is erased only when the user
 * explicitly confirms. On confirmation it delegates to the framework-agnostic
 * {@link DataDeletionController}, which clears all `gbv.*` storage keys and
 * resets the in-memory monitoring state machine to `idle`
 * (Requirement 11.4).
 *
 * Design decisions (mirroring {@link ManualTriggerButton}):
 *   • All deletion logic lives in the injectable {@link DataDeletionController}
 *     so it is unit-testable without rendering.
 *   • The controller, confirm dialog function, and completion callback are
 *     injected via props, keeping the component decoupled from any concrete
 *     storage or actor instance.
 *
 * Requirements covered: 11.3, 11.4
 */

import React from 'react';
import {Alert, StyleSheet, Text, View} from 'react-native';
import {
  dataDeletionController as defaultController,
  DataDeletionController,
} from '../privacy/DataDeletionController';

// ── Confirmation prompt (injectable for testing) ─────────────────────────────

/** Arguments passed to a {@link ConfirmPromptFn}. */
export interface ConfirmPromptArgs {
  /** Invoked when the user confirms the destructive action. */
  onConfirm: () => void;
  /** Invoked when the user cancels. Optional. */
  onCancel?: () => void;
}

/**
 * Presents a confirmation dialog. Defaults to React Native's `Alert.alert`
 * with a destructive confirm button; inject a fake in tests.
 */
export type ConfirmPromptFn = (args: ConfirmPromptArgs) => void;

const defaultConfirmPrompt: ConfirmPromptFn = ({onConfirm, onCancel}) => {
  Alert.alert(
    'Delete all personal data?',
    'This permanently erases your profile, emergency contacts, alert history, ' +
      'heart rate data, and setup progress on this device. Monitoring will stop ' +
      'and the app will restart setup. This cannot be undone.',
    [
      {text: 'Cancel', style: 'cancel', onPress: onCancel},
      {text: 'Delete everything', style: 'destructive', onPress: onConfirm},
    ],
  );
};

// ── Component ────────────────────────────────────────────────────────────────

/** Props for {@link DeleteAllDataButton}. */
export interface DeleteAllDataButtonProps {
  /**
   * Controller that performs the deletion. Defaults to the shared singleton.
   * Supply a controller built with a `resetStateMachine` callback wired to a
   * live monitoring actor so deletion also stops active monitoring.
   */
  controller?: DataDeletionController;
  /**
   * Presents the confirmation dialog. Defaults to `Alert.alert`. Injectable so
   * tests can simulate confirm / cancel deterministically.
   */
  confirmPrompt?: ConfirmPromptFn;
  /**
   * Invoked after deletion completes successfully. A parent typically uses this
   * to navigate to the onboarding flow (Requirement 11.4). Optional.
   */
  onDeleted?: () => void;
  /** Invoked if the deletion throws. Optional. */
  onError?: (error: unknown) => void;
  /** Accessibility / test label. */
  testID?: string;
}

/**
 * Render the "Delete All Personal Data" settings control.
 *
 * Tapping the control opens a confirmation dialog; the controller is invoked
 * only on explicit confirmation. The control is always enabled and does not
 * depend on onboarding or monitoring state (Requirement 11.3).
 */
export function DeleteAllDataButton(
  props: DeleteAllDataButtonProps,
): React.JSX.Element {
  const controller = props.controller ?? defaultController;
  const confirmPrompt = props.confirmPrompt ?? defaultConfirmPrompt;

  const runDeletion = React.useCallback(async () => {
    try {
      await controller.deleteAllPersonalData();
      props.onDeleted?.();
    } catch (error) {
      props.onError?.(error);
    }
  }, [controller, props]);

  const handlePress = React.useCallback(() => {
    confirmPrompt({
      onConfirm: () => {
        void runDeletion();
      },
    });
  }, [confirmPrompt, runDeletion]);

  return (
    <View
      testID={props.testID ?? 'delete-all-data-button'}
      accessibilityRole="button"
      accessibilityLabel="Delete all personal data"
      onTouchEnd={handlePress}
      style={styles.button}>
      <Text style={styles.buttonText}>Delete All Personal Data</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: '#B71C1C',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
});

export default DeleteAllDataButton;
