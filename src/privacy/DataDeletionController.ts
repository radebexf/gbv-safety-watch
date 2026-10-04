/**
 * DataDeletionController
 *
 * Framework-agnostic controller backing the "Delete All Personal Data" feature
 * (Requirements 11.3, 11.4).
 *
 * Responsibilities:
 *   1. Erase every `gbv.*` key from encrypted storage by delegating to
 *      {@link EncryptedStorageInterface.clear}. The `clear()` implementation
 *      removes all namespaced keys — profile, contacts, alert log, HR baseline,
 *      monitoring session, and the onboarding record — satisfying the deletion
 *      sweep described by Property 12.
 *   2. Reset the in-memory monitoring state machine to `idle` via an injected
 *      callback, so that any active monitoring stops immediately. The controller
 *      never imports or edits the state machine itself; the caller supplies a
 *      `resetStateMachine` callback (typically `() => actor.send({type: 'DEACTIVATE'})`).
 *
 * Onboarding-on-next-launch note:
 *   The onboarding record is persisted under the `gbv.onboarding` key. Because
 *   `storage.clear()` removes all `gbv.*` keys, the onboarding record is erased
 *   as part of step 1. On the next app launch the onboarding flow re-appears
 *   automatically (Requirement 10.1: no completed onboarding record exists →
 *   present onboarding). The controller therefore does NOT need to perform any
 *   extra navigation side effect to satisfy Requirement 11.4 — the cleared
 *   record is sufficient. A caller MAY still navigate immediately for UX, but
 *   that is outside this controller's responsibility.
 *
 * The controller is kept pure of React / React Native so it can be unit tested
 * without rendering, matching the dependency-injection + factory conventions of
 * {@link EmergencyContactRepository}.
 *
 * Requirements: 11.3, 11.4
 */

import EncryptedStorage, {
  EncryptedStorageInterface,
} from '../storage/EncryptedStorage';

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Callback that resets the in-memory monitoring state machine to `idle`.
 *
 * Typically wired as `() => monitoringActor.send({type: 'DEACTIVATE'})`. The
 * controller does not know (or care) how the reset is implemented — it only
 * guarantees the callback is invoked after storage has been cleared.
 */
export type ResetStateMachineFn = () => void;

/** Options bag for {@link createDataDeletionController}. */
export interface DataDeletionControllerOptions {
  /** Encrypted storage backend (injectable for testing). */
  storage?: EncryptedStorageInterface;
  /**
   * Resets the monitoring state machine to `idle`. Defaults to a no-op so the
   * controller is usable before a state machine actor exists (e.g. when the
   * user has never activated monitoring).
   */
  resetStateMachine?: ResetStateMachineFn;
}

/** Public surface of the data deletion controller. */
export interface DataDeletionController {
  /**
   * Permanently erase all locally stored personal data and reset the in-memory
   * monitoring state to `idle`.
   *
   * Ordering guarantee: storage is cleared first, then the state machine reset
   * callback is invoked. This way, even if the reset callback triggers a
   * re-persist of session state, the subsequent app launch still sees no
   * `gbv.*` records (the reset drives the machine to `idle`, which clears the
   * session rather than writing one).
   *
   * Requirements: 11.4
   */
  deleteAllPersonalData(): Promise<void>;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Creates a {@link DataDeletionController}.
 *
 * @param options - Dependency-injection options bag. All fields are optional;
 *   defaults use the real {@link EncryptedStorage} and a no-op reset callback.
 */
export function createDataDeletionController(
  options: DataDeletionControllerOptions = {},
): DataDeletionController {
  const storage: EncryptedStorageInterface = options.storage ?? EncryptedStorage;
  const resetStateMachine: ResetStateMachineFn =
    options.resetStateMachine ?? (() => {});

  async function deleteAllPersonalData(): Promise<void> {
    // 1. Erase every gbv.* key (profile, contacts, alert_log, hr_baseline,
    //    monitoring_session, onboarding). (Requirement 11.4, Property 12)
    await storage.clear();

    // 2. Reset the in-memory monitoring state machine to idle so monitoring
    //    stops immediately regardless of its current state (Requirement 11.4).
    resetStateMachine();

    // 3. Onboarding-on-next-launch is implicit: the gbv.onboarding record was
    //    removed in step 1, so the next launch presents onboarding
    //    (Requirement 11.4). No further action required here.
  }

  return {deleteAllPersonalData};
}

// ── Default singleton instance ────────────────────────────────────────────────

/**
 * Pre-built instance using the real {@link EncryptedStorage} and a no-op state
 * machine reset. Callers that have a live monitoring actor should instead build
 * their own instance via {@link createDataDeletionController} and pass a
 * `resetStateMachine` callback wired to `actor.send({type: 'DEACTIVATE'})`.
 */
export const dataDeletionController: DataDeletionController =
  createDataDeletionController();
