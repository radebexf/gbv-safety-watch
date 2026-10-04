/**
 * OnboardingManager
 *
 * Governs the guided first-run setup flow of the GBV Safety Watch and persists
 * its progress so an interrupted onboarding can be resumed at the correct step.
 *
 * Onboarding state is persisted under the `gbv.onboarding` key via
 * EncryptedStorage using the schema defined in the design document:
 *
 *   { completed: boolean; step: number }
 *
 * ── Sequential steps (Requirement 10.1) ─────────────────────────────────────
 * The flow enforces the following four steps, in strict order. The user may
 * not advance past a step until that step's required actions are completed:
 *
 *   step 0 → not started
 *   step 1 → (a) create a user profile (name + phone number)
 *   step 2 → (b) pair the Smartwatch via Bluetooth
 *   step 3 → (c) add at least one Emergency_Contact
 *   step 4 → (d) review default alert settings
 *
 * The persisted `step` value records the number of COMPLETED steps (0–4), so
 * the "current" step the user should be shown is `step + 1` (capped at 4) while
 * onboarding is incomplete. When all four steps are complete, `completed`
 * becomes true (Requirement 10.5 writes this record once permissions are also
 * granted; this manager owns the step-completion half of that record).
 *
 * ── Mid-flow resume (Requirement 10.2) ──────────────────────────────────────
 * On relaunch, {@link OnboardingManager.resume} reads the persisted record and
 * returns the last incomplete step rather than restarting from step 0.
 *
 * Design notes:
 *   • Follows the DI / options-bag + factory-function convention used by
 *     EmergencyContactRepository and MonitoringStateMachine so the manager is
 *     pure and fully unit-testable with an injected storage backend.
 *   • The manager never mutates in-memory state that is not also persisted; the
 *     encrypted record is the single source of truth.
 *
 * Requirements: 10.1, 10.2
 */

import EncryptedStorage, {
  EncryptedStorageInterface,
} from '../storage/EncryptedStorage';

// ── Constants ──────────────────────────────────────────────────────────────

/** Encrypted-storage sub-key (becomes `gbv.onboarding` after prefix). */
export const ONBOARDING_STORAGE_KEY = 'onboarding';

/** The ordered onboarding steps. Index 0 is the "not started" sentinel. */
export type OnboardingStep = 0 | 1 | 2 | 3 | 4;

/** Total number of required onboarding steps (Requirement 10.1). */
export const TOTAL_ONBOARDING_STEPS = 4;

/**
 * Human-readable labels for each step, keyed by the step number the user is
 * being asked to complete (1–4). Exported so UI and tests can assert copy.
 */
export const ONBOARDING_STEP_LABELS: Record<1 | 2 | 3 | 4, string> = {
  1: 'Create your profile',
  2: 'Pair your smartwatch',
  3: 'Add an emergency contact',
  4: 'Review alert settings',
};

// ── Persisted record shape ───────────────────────────────────────────────────

/**
 * The persisted onboarding record, exactly matching the design storage schema
 * for the `gbv.onboarding` key.
 *
 * @property completed - True once all four steps have been completed.
 * @property step       - Number of COMPLETED steps (0–4).
 */
export interface OnboardingState {
  completed: boolean;
  step: number;
}

/** The default (uninitialised) onboarding record. */
const INITIAL_STATE: OnboardingState = {completed: false, step: 0};

// ── Normalisation ─────────────────────────────────────────────────────────────

/**
 * Clamp and coerce a raw persisted record into a valid {@link OnboardingState}.
 * Guards against corrupt storage (Design — "Onboarding state corrupt → reset to
 * step 0") by falling back to the initial state when the value is unusable.
 */
function normalize(raw: unknown): OnboardingState {
  if (raw === null || typeof raw !== 'object') {
    return {...INITIAL_STATE};
  }
  const candidate = raw as Partial<OnboardingState>;
  const rawStep =
    typeof candidate.step === 'number' && Number.isFinite(candidate.step)
      ? Math.floor(candidate.step)
      : 0;
  const step = Math.min(TOTAL_ONBOARDING_STEPS, Math.max(0, rawStep));
  // `completed` is only trustworthy when all steps are actually done.
  const completed =
    candidate.completed === true && step >= TOTAL_ONBOARDING_STEPS;
  return {completed, step};
}

// ── Manager interface ──────────────────────────────────────────────────────

export interface OnboardingManager {
  /**
   * Load the current persisted onboarding state (normalised). Returns the
   * initial state when nothing has been persisted yet.
   */
  getState(): Promise<OnboardingState>;

  /**
   * Whether onboarding has been fully completed (all four steps done).
   * Requirement 10.1 — when false, the app must present the onboarding flow.
   */
  isComplete(): Promise<boolean>;

  /**
   * Resolve the step the user should be shown on launch (Requirement 10.2).
   * Returns the last incomplete step (`completedSteps + 1`, capped at
   * {@link TOTAL_ONBOARDING_STEPS}) rather than restarting at 0. Returns 0 only
   * when onboarding is already complete (no step to show).
   */
  resume(): Promise<OnboardingStep>;

  /**
   * Mark the given step as completed, advancing the persisted progress.
   *
   * Enforces sequential completion (Requirement 10.1): a step may only be
   * completed when all steps before it are already complete — i.e. the step
   * being completed must equal `completedSteps + 1`. Completing an already
   * completed step is idempotent; attempting to skip ahead is rejected.
   *
   * @param step - The step (1–4) the user just finished.
   * @returns The updated, persisted state.
   * @throws RangeError if `step` is outside 1–{@link TOTAL_ONBOARDING_STEPS}.
   * @throws Error if the step is attempted out of sequence (skipping ahead).
   */
  completeStep(step: OnboardingStep): Promise<OnboardingState>;

  /**
   * Determine whether a given step may currently be entered/advanced to. A step
   * is reachable only when every prior step is complete (Requirement 10.1).
   *
   * @param step - The step (1–4) to test.
   */
  canAdvanceTo(step: OnboardingStep): Promise<boolean>;

  /**
   * Reset onboarding progress back to the uninitialised state (step 0). Used
   * when the persisted record is detected as corrupt, or after a
   * "Delete All Personal Data" action.
   */
  reset(): Promise<void>;
}

// ── Options bag ───────────────────────────────────────────────────────────────

/** Injectable dependencies for {@link createOnboardingManager}. */
export interface OnboardingManagerOptions {
  /** Encrypted storage backend. Defaults to the real EncryptedStorage. */
  storage?: EncryptedStorageInterface;
}

// ── Factory function ──────────────────────────────────────────────────────────

/**
 * Create an {@link OnboardingManager} with injected dependencies.
 *
 * @param options - Options bag; `storage` is injectable for testing.
 */
export function createOnboardingManager(
  options: OnboardingManagerOptions = {},
): OnboardingManager {
  const storage: EncryptedStorageInterface = options.storage ?? EncryptedStorage;

  // ── Private persistence helpers ──────────────────────────────────────────

  async function load(): Promise<OnboardingState> {
    try {
      const raw = await storage.get(ONBOARDING_STORAGE_KEY);
      if (raw === null) {
        return {...INITIAL_STATE};
      }
      return normalize(JSON.parse(raw));
    } catch {
      // Corrupt / unreadable record → reset to step 0 (Design error handling).
      return {...INITIAL_STATE};
    }
  }

  async function persist(state: OnboardingState): Promise<OnboardingState> {
    await storage.set(ONBOARDING_STORAGE_KEY, JSON.stringify(state));
    return state;
  }

  // ── Public interface ─────────────────────────────────────────────────────

  async function getState(): Promise<OnboardingState> {
    return load();
  }

  async function isComplete(): Promise<boolean> {
    const state = await load();
    return state.completed;
  }

  async function resume(): Promise<OnboardingStep> {
    const state = await load();
    if (state.completed) {
      // Nothing to show — onboarding is finished.
      return 0;
    }
    // Last incomplete step = next step after the completed ones (10.2).
    const next = Math.min(TOTAL_ONBOARDING_STEPS, state.step + 1);
    return next as OnboardingStep;
  }

  async function canAdvanceTo(step: OnboardingStep): Promise<boolean> {
    if (step < 1 || step > TOTAL_ONBOARDING_STEPS) {
      return false;
    }
    const state = await load();
    // Reachable only when every step before `step` is complete (10.1).
    return state.step >= step - 1;
  }

  async function completeStep(
    step: OnboardingStep,
  ): Promise<OnboardingState> {
    if (step < 1 || step > TOTAL_ONBOARDING_STEPS) {
      throw new RangeError(
        `Invalid onboarding step: ${step}. Expected 1–${TOTAL_ONBOARDING_STEPS}.`,
      );
    }

    const state = await load();

    // Idempotent: completing an already-completed step is a no-op.
    if (step <= state.step) {
      return state;
    }

    // Sequential enforcement (10.1): may only complete the immediate next step.
    if (step !== state.step + 1) {
      throw new Error(
        `Cannot complete step ${step} out of sequence: ${state.step} of ` +
          `${TOTAL_ONBOARDING_STEPS} steps completed. Complete step ` +
          `${state.step + 1} first.`,
      );
    }

    const nextStep = step;
    const completed = nextStep >= TOTAL_ONBOARDING_STEPS;
    return persist({completed, step: nextStep});
  }

  async function reset(): Promise<void> {
    await persist({...INITIAL_STATE});
  }

  return {
    getState,
    isComplete,
    resume,
    completeStep,
    canAdvanceTo,
    reset,
  };
}

// ── Default singleton instance ────────────────────────────────────────────────

/**
 * Pre-built instance using the real EncryptedStorage. Import this in
 * production code; inject a mock via {@link createOnboardingManager} in tests.
 */
export const onboardingManager: OnboardingManager = createOnboardingManager();
