/**
 * OnboardingCompletion
 *
 * Finalisation logic for the onboarding flow (Requirement 10.5):
 *
 *   "WHEN the user completes all four onboarding steps and all required
 *    permissions are granted, THE Safety_App SHALL write a completed onboarding
 *    record to local storage and unlock the 'Activate Monitoring' control."
 *
 * The {@link OnboardingManager} owns the step-completion half of the persisted
 * `gbv.onboarding` record (writing `completed: true` once step 4 is done). This
 * module adds the *permission* half of the gate: the completed record is only
 * written — and "Activate Monitoring" only unlocked — when BOTH conditions hold:
 *
 *   1. All four onboarding steps are complete (OnboardingManager), and
 *   2. All four required permissions are granted (PermissionManager).
 *
 * Design notes:
 *   • Framework-agnostic; follows the DI / options-bag + factory convention.
 *   • Composes the existing {@link OnboardingManager} and {@link PermissionManager}
 *     without modifying either, so parallel work on persistence is unaffected.
 *   • "Writing the completed record" is expressed as completing step 4 via the
 *     OnboardingManager (which sets `completed: true` and `step: 4`), per the
 *     context contract that the completed record == step 4 complete + all
 *     required permissions granted.
 *
 * Requirements: 10.5
 */

import {
  TOTAL_ONBOARDING_STEPS,
  type OnboardingManager,
  type OnboardingState,
} from './OnboardingManager';
import type {PermissionManager} from './PermissionManager';

// ── Result shape ─────────────────────────────────────────────────────────────

/** Outcome of a {@link OnboardingCompletionController.finalize} attempt. */
export interface OnboardingCompletionResult {
  /**
   * True when the completed onboarding record has been written and
   * "Activate Monitoring" is unlocked (all steps done AND all permissions
   * granted).
   */
  completed: boolean;
  /** True when all four onboarding steps are complete. */
  allStepsComplete: boolean;
  /** True when all four required permissions are granted. */
  allPermissionsGranted: boolean;
}

// ── Controller interface ─────────────────────────────────────────────────────

export interface OnboardingCompletionController {
  /**
   * Evaluate the completion gate and, when satisfied, write the completed
   * onboarding record (Requirement 10.5).
   *
   * Writing is idempotent: if the record is already completed, no further write
   * is attempted. If either the steps or the permissions are incomplete, the
   * record is left untouched and `completed` is reported as `false`.
   */
  finalize(): Promise<OnboardingCompletionResult>;

  /**
   * Whether the "Activate Monitoring" control should be unlocked. This is true
   * only when onboarding is recorded as complete (Requirements 10.5, 9.1).
   */
  isActivateMonitoringUnlocked(): Promise<boolean>;
}

// ── Options bag ──────────────────────────────────────────────────────────────

/** Injectable dependencies for {@link createOnboardingCompletionController}. */
export interface OnboardingCompletionOptions {
  onboardingManager: OnboardingManager;
  permissionManager: PermissionManager;
}

// ── Factory function ─────────────────────────────────────────────────────────

/**
 * Create an {@link OnboardingCompletionController} composing the onboarding and
 * permission managers.
 */
export function createOnboardingCompletionController(
  options: OnboardingCompletionOptions,
): OnboardingCompletionController {
  const {onboardingManager, permissionManager} = options;

  /** Advance the persisted record to `completed: true` if not already there. */
  async function writeCompletedRecord(
    state: OnboardingState,
  ): Promise<void> {
    // Complete any remaining steps in sequence up to step 4. In practice all
    // four steps are already done when this is reached, but completing step 4
    // (idempotently) is what flips `completed` to true in the persisted record.
    let current = state.step;
    while (current < TOTAL_ONBOARDING_STEPS) {
      current += 1;
      // completeStep enforces sequential ordering; we only ever advance by one.
      // Cast is safe: current ∈ [1, TOTAL_ONBOARDING_STEPS].
      // eslint-disable-next-line no-await-in-loop
      await onboardingManager.completeStep(
        current as 1 | 2 | 3 | 4,
      );
    }
  }

  async function finalize(): Promise<OnboardingCompletionResult> {
    const state = await onboardingManager.getState();
    const allStepsComplete = state.step >= TOTAL_ONBOARDING_STEPS;
    const allPermissionsGranted = permissionManager.allRequiredGranted();

    // Requirement 10.5: write the completed record ONLY when BOTH halves hold.
    if (allStepsComplete && allPermissionsGranted) {
      if (!state.completed) {
        await writeCompletedRecord(state);
      }
      return {
        completed: true,
        allStepsComplete: true,
        allPermissionsGranted: true,
      };
    }

    return {
      completed: false,
      allStepsComplete,
      allPermissionsGranted,
    };
  }

  async function isActivateMonitoringUnlocked(): Promise<boolean> {
    // The control is unlocked only when the completed record is present AND the
    // required permissions are still granted (Requirements 10.5, 9.1).
    const complete = await onboardingManager.isComplete();
    return complete && permissionManager.allRequiredGranted();
  }

  return {
    finalize,
    isActivateMonitoringUnlocked,
  };
}
