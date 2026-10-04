/**
 * UserProfileRepository
 *
 * Encrypted persistence for the user profile and alert settings. The full
 * `UserProfile` record (profile fields + nested `UserSettings`) is persisted
 * under the `gbv.profile` key via EncryptedStorage.
 *
 * Settings validation rules (Requirements 2.7, 2.8):
 *   • distressThresholdPct  : 0.10 – 1.00 (default 0.40)   (Requirement 2.7)
 *   • falsePosWindowSeconds : 5 – 60       (default 15)     (Requirement 2.8)
 *
 * Propagation (decoupled):
 *   `updateSettings` persists the validated settings and then notifies any
 *   registered listeners via `onSettingsChanged`. The service layer (task 16.1)
 *   wires these listeners so the new values reach the `AnomalyDetector`
 *   (threshold passed per-evaluate) and the `MonitoringStateMachine`
 *   (falsePosWindowSeconds supplied via its input) without this repository
 *   hard-coupling to those subsystems.
 *
 * Requirements: 2.7, 2.8
 */

import type {UserProfile, UserSettings, Result} from '../types';
import EncryptedStorage, {
  EncryptedStorageInterface,
} from '../storage/EncryptedStorage';

// ── Constants ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'profile'; // becomes 'gbv.profile' after prefix

/** Distress threshold deviation bounds (Requirement 2.7). */
export const DISTRESS_THRESHOLD_MIN = 0.1;
export const DISTRESS_THRESHOLD_MAX = 1.0;
export const DISTRESS_THRESHOLD_DEFAULT = 0.4;

/** False-positive window bounds, in seconds (Requirement 2.8). */
export const FALSE_POS_WINDOW_MIN = 5;
export const FALSE_POS_WINDOW_MAX = 60;
export const FALSE_POS_WINDOW_DEFAULT = 15;

/** Default settings applied when no profile exists yet. */
export const DEFAULT_SETTINGS: UserSettings = {
  distressThresholdPct: DISTRESS_THRESHOLD_DEFAULT,
  falsePosWindowSeconds: FALSE_POS_WINDOW_DEFAULT,
};

// ── Error type ────────────────────────────────────────────────────────────────

export type ProfileError =
  | 'VALIDATION_FAILED'
  | 'NO_PROFILE'
  | 'STORAGE_ERROR';

// ── Listener type ─────────────────────────────────────────────────────────────

/**
 * Callback invoked with the freshly validated settings whenever
 * `updateSettings` succeeds. Register these via `onSettingsChanged` so the
 * service layer can propagate values to the AnomalyDetector and
 * MonitoringStateMachine. Listener exceptions are swallowed so one bad
 * subscriber cannot break persistence or other subscribers.
 */
export type SettingsChangeListener = (settings: UserSettings) => void;

// ── Result constructors ───────────────────────────────────────────────────────

function ok<T>(value: T): Result<T, ProfileError> {
  return {ok: true, value};
}

function fail<T>(error: ProfileError): Result<T, ProfileError> {
  return {ok: false, error};
}

// ── Validation helpers ────────────────────────────────────────────────────────

/** True when `pct` is a finite number within [0.10, 1.00] (Requirement 2.7). */
function isValidThresholdPct(pct: number): boolean {
  return (
    Number.isFinite(pct) &&
    pct >= DISTRESS_THRESHOLD_MIN &&
    pct <= DISTRESS_THRESHOLD_MAX
  );
}

/**
 * True when `seconds` is a finite number within [5, 60] (Requirement 2.8).
 */
function isValidWindowSeconds(seconds: number): boolean {
  return (
    Number.isFinite(seconds) &&
    seconds >= FALSE_POS_WINDOW_MIN &&
    seconds <= FALSE_POS_WINDOW_MAX
  );
}

// ── Repository interface ──────────────────────────────────────────────────────

export interface UserProfileRepository {
  /** Returns the stored profile, or `null` if none has been persisted yet. */
  get(): Promise<UserProfile | null>;
  /**
   * Persists the given profile wholesale (used by onboarding/profile edit).
   * Settings on the supplied profile are validated before saving.
   */
  save(profile: UserProfile): Promise<Result<UserProfile, ProfileError>>;
  /**
   * Returns the current settings — the persisted ones if a profile exists,
   * otherwise the module defaults.
   */
  getSettings(): Promise<UserSettings>;
  /**
   * Validates and persists a partial settings update, then notifies all
   * registered settings-change listeners with the merged result.
   *
   * Requirements: 2.7, 2.8
   */
  updateSettings(
    patch: Partial<UserSettings>,
  ): Promise<Result<UserSettings, ProfileError>>;
  /**
   * Registers a listener invoked after each successful `updateSettings`.
   * Returns an unsubscribe function.
   */
  onSettingsChanged(listener: SettingsChangeListener): () => void;
}

// ── Options bag ───────────────────────────────────────────────────────────────

export interface UserProfileRepositoryOptions {
  /** Encrypted storage backend (injectable for testing). */
  storage?: EncryptedStorageInterface;
  /** Initial settings-change listeners (optional convenience). */
  listeners?: SettingsChangeListener[];
}

// ── Factory function ──────────────────────────────────────────────────────────

/**
 * Creates a `UserProfileRepository` instance.
 *
 * @param options - DI options bag (storage backend + initial listeners).
 */
export function createUserProfileRepository(
  options: UserProfileRepositoryOptions = {},
): UserProfileRepository {
  const storage: EncryptedStorageInterface = options.storage ?? EncryptedStorage;
  const listeners = new Set<SettingsChangeListener>(options.listeners ?? []);

  // ── Private helpers ──────────────────────────────────────────────────────

  async function load(): Promise<UserProfile | null> {
    try {
      const raw = await storage.get(STORAGE_KEY);
      if (raw === null) {
        return null;
      }
      return JSON.parse(raw) as UserProfile;
    } catch {
      return null;
    }
  }

  async function persist(profile: UserProfile): Promise<void> {
    try {
      await storage.set(STORAGE_KEY, JSON.stringify(profile));
    } catch {
      throw new Error('STORAGE_ERROR');
    }
  }

  function notify(settings: UserSettings): void {
    for (const listener of listeners) {
      try {
        listener(settings);
      } catch {
        // Isolate subscriber failures — one bad listener must not break others.
      }
    }
  }

  function validateSettings(settings: UserSettings): boolean {
    return (
      isValidThresholdPct(settings.distressThresholdPct) &&
      isValidWindowSeconds(settings.falsePosWindowSeconds)
    );
  }

  // ── Public interface ─────────────────────────────────────────────────────

  async function get(): Promise<UserProfile | null> {
    return load();
  }

  async function save(
    profile: UserProfile,
  ): Promise<Result<UserProfile, ProfileError>> {
    if (!validateSettings(profile.settings)) {
      return fail('VALIDATION_FAILED');
    }
    try {
      await persist(profile);
    } catch {
      return fail('STORAGE_ERROR');
    }
    return ok(profile);
  }

  async function getSettings(): Promise<UserSettings> {
    const profile = await load();
    return profile ? profile.settings : {...DEFAULT_SETTINGS};
  }

  /**
   * Validates and persists a partial settings update.
   *
   * Behaviour:
   *   • Rejects out-of-bounds values with VALIDATION_FAILED (nothing persisted).
   *   • Rejects when no profile exists with NO_PROFILE (settings live on the
   *     profile record; onboarding must create the profile first).
   *   • On success, persists the merged profile and notifies listeners.
   *
   * Requirements: 2.7, 2.8
   */
  async function updateSettings(
    patch: Partial<UserSettings>,
  ): Promise<Result<UserSettings, ProfileError>> {
    const profile = await load();
    if (profile === null) {
      return fail('NO_PROFILE');
    }

    const merged: UserSettings = {
      distressThresholdPct:
        patch.distressThresholdPct !== undefined
          ? patch.distressThresholdPct
          : profile.settings.distressThresholdPct,
      falsePosWindowSeconds:
        patch.falsePosWindowSeconds !== undefined
          ? patch.falsePosWindowSeconds
          : profile.settings.falsePosWindowSeconds,
    };

    if (!validateSettings(merged)) {
      return fail('VALIDATION_FAILED');
    }

    const updatedProfile: UserProfile = {...profile, settings: merged};

    try {
      await persist(updatedProfile);
    } catch {
      return fail('STORAGE_ERROR');
    }

    notify(merged);
    return ok(merged);
  }

  function onSettingsChanged(listener: SettingsChangeListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return {get, save, getSettings, updateSettings, onSettingsChanged};
}

// ── Default singleton instance ────────────────────────────────────────────────

/**
 * Pre-built instance using the real EncryptedStorage.
 * Import this in production code.
 */
export const userProfileRepository: UserProfileRepository =
  createUserProfileRepository();
