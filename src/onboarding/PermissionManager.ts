/**
 * PermissionManager
 *
 * Framework-agnostic helper that governs the four onboarding permission
 * requests of the GBV Safety Watch and the plain-language rationale that must
 * precede each system permission dialog.
 *
 * ── Rationale-before-dialog (Requirement 10.3) ───────────────────────────────
 * For each permission the app explains, in plain language, the specific purpose
 * of that permission *before* the OS permission dialog is shown. The copy for
 * each permission lives in {@link PERMISSION_RATIONALE} so UI and tests can
 * assert it. {@link PermissionManager.requestWithRationale} enforces the
 * ordering: the injected `onShowRationale` callback is always awaited before the
 * underlying platform request runs.
 *
 * ── Denial handling (Requirement 10.4) ───────────────────────────────────────
 * When a required permission is denied, {@link PERMISSION_DENIAL} supplies the
 * human-readable permission name and the list of features that become
 * unavailable, and {@link PermissionManager.openSettings} deep-links to the
 * relevant section of the device system settings via react-native `Linking`.
 *
 * ── Completion gate (Requirement 10.5) ───────────────────────────────────────
 * {@link PermissionManager.allRequiredGranted} reports whether every required
 * permission has been granted; the onboarding completion logic (see
 * {@link OnboardingCompletion}) uses this together with the four completed steps
 * to decide when to write the completed onboarding record and unlock the
 * "Activate Monitoring" control.
 *
 * Design notes:
 *   • Follows the DI / options-bag + factory-function convention used by
 *     OnboardingManager and EmergencyContactRepository.
 *   • The actual platform permission request is injected behind the
 *     {@link PermissionRequester} interface so this module is fully
 *     unit-testable without native modules.
 *
 * Requirements: 10.3, 10.4, 10.5
 */

import {Linking} from 'react-native';

// ── Permission domain ────────────────────────────────────────────────────────

/**
 * The four permissions requested during onboarding, in the order they are
 * presented. Each must be preceded by its rationale screen (Requirement 10.3).
 */
export type AppPermission =
  | 'bluetooth'
  | 'location'
  | 'sms'
  | 'notifications';

/** The ordered list of permissions requested during onboarding. */
export const REQUIRED_PERMISSIONS: readonly AppPermission[] = [
  'bluetooth',
  'location',
  'sms',
  'notifications',
] as const;

/** Outcome of a single permission request. */
export type PermissionStatus = 'granted' | 'denied';

/** Map of each required permission to its current status. */
export type PermissionStatusMap = Record<AppPermission, PermissionStatus>;

// ── Plain-language rationale copy (Requirement 10.3) ─────────────────────────

/** The rationale shown before a system permission dialog. */
export interface PermissionRationale {
  /** Human-readable permission name, e.g. "Bluetooth". */
  title: string;
  /** Plain-language explanation of why the app needs this permission. */
  body: string;
}

/**
 * Plain-language rationale copy for each permission, shown before the OS dialog.
 * Exported so screens render it and tests assert it (Requirement 10.3).
 */
export const PERMISSION_RATIONALE: Record<AppPermission, PermissionRationale> = {
  bluetooth: {
    title: 'Bluetooth',
    body:
      'GBV Safety Watch uses Bluetooth to pair with and stay connected to your ' +
      'smartwatch. This connection lets the app read your heart rate and wrist ' +
      'status and detect if the watch is removed or disconnected. Without ' +
      'Bluetooth the app cannot monitor your watch.',
  },
  location: {
    title: 'Location',
    body:
      'Location access lets the app attach your current GPS position to a safety ' +
      'alert so your emergency contacts know where to find you. Your location is ' +
      'sent only to your registered contacts, never to any third party.',
  },
  sms: {
    title: 'SMS',
    body:
      'SMS permission lets the app send a text message with your location to your ' +
      'emergency contacts when a distress alert is triggered. Alerts are sent ' +
      'directly from your phone, so they work even without an internet connection.',
  },
  notifications: {
    title: 'Notifications',
    body:
      'Notifications let the app show you the safety-alert countdown, the ' +
      'persistent "monitoring active" indicator, and delivery results for your ' +
      'alerts. This keeps you informed about what the app is doing in the ' +
      'background.',
  },
};

// ── Denial copy (Requirement 10.4) ───────────────────────────────────────────

/** Copy shown when a required permission is denied. */
export interface PermissionDenialInfo {
  /** Human-readable permission name, e.g. "Bluetooth". */
  title: string;
  /** The specific features that become unavailable without this permission. */
  affectedFeatures: readonly string[];
}

/**
 * Denial copy for each permission: the permission name and the features that
 * become unavailable when it is denied. Exported for screens and tests
 * (Requirement 10.4).
 */
export const PERMISSION_DENIAL: Record<AppPermission, PermissionDenialInfo> = {
  bluetooth: {
    title: 'Bluetooth',
    affectedFeatures: [
      'Pairing and connecting to your smartwatch',
      'Heart rate anomaly detection',
      'Watch removal detection',
      'Bluetooth disconnection alerts',
    ],
  },
  location: {
    title: 'Location',
    affectedFeatures: [
      'Attaching your GPS location to safety alerts',
      'Helping emergency contacts find you',
    ],
  },
  sms: {
    title: 'SMS',
    affectedFeatures: [
      'Sending safety alerts to your emergency contacts',
      'Sending test confirmation messages to new contacts',
    ],
  },
  notifications: {
    title: 'Notifications',
    affectedFeatures: [
      'The safety-alert countdown display',
      'The persistent "monitoring active" indicator',
      'Alert delivery result notifications',
    ],
  },
};

// ── Injectable platform boundary ─────────────────────────────────────────────

/**
 * Abstraction over the native permission request + system-settings deep-link.
 * Injected so {@link PermissionManager} is unit-testable without native modules.
 */
export interface PermissionRequester {
  /** Perform the underlying OS permission request and resolve its status. */
  request(permission: AppPermission): Promise<PermissionStatus>;
  /**
   * Deep-link to the relevant section of the device system settings. Defaults
   * to react-native `Linking.openSettings`.
   */
  openSettings?: () => Promise<void>;
}

// ── Manager interface ────────────────────────────────────────────────────────

export interface PermissionManager {
  /**
   * Request a single permission, always showing its plain-language rationale
   * first (Requirement 10.3). The injected `onShowRationale` callback is awaited
   * before the OS dialog is triggered; the resolved status is recorded.
   *
   * @param permission - The permission to request.
   * @param onShowRationale - Presents the rationale screen; resolves when the
   *   user acknowledges it (e.g. taps "Continue"). Receives the rationale copy.
   * @returns The resulting {@link PermissionStatus}.
   */
  requestWithRationale(
    permission: AppPermission,
    onShowRationale: (rationale: PermissionRationale) => Promise<void>,
  ): Promise<PermissionStatus>;

  /** Get the recorded status of a single permission (defaults to `denied`). */
  getStatus(permission: AppPermission): PermissionStatus;

  /** Get a snapshot of the recorded status of every required permission. */
  getStatuses(): PermissionStatusMap;

  /** Whether every required permission has been granted (Requirement 10.5). */
  allRequiredGranted(): boolean;

  /** The denial copy for a permission (Requirement 10.4). */
  getDenialInfo(permission: AppPermission): PermissionDenialInfo;

  /**
   * Open the relevant section of the device system settings so the user can
   * grant a previously denied permission (Requirement 10.4).
   */
  openSettings(): Promise<void>;
}

// ── Options bag ──────────────────────────────────────────────────────────────

/** Injectable dependencies for {@link createPermissionManager}. */
export interface PermissionManagerOptions {
  /** Platform permission requester. Required (no safe default without native). */
  requester: PermissionRequester;
  /**
   * Optional seed of already-known permission statuses (e.g. loaded from a
   * previous session). Any permission not listed defaults to `denied`.
   */
  initialStatuses?: Partial<PermissionStatusMap>;
}

// ── Factory function ─────────────────────────────────────────────────────────

/**
 * Create a {@link PermissionManager} with injected dependencies.
 *
 * @param options - Options bag; `requester` is injectable for testing.
 */
export function createPermissionManager(
  options: PermissionManagerOptions,
): PermissionManager {
  const {requester} = options;

  // Internal status map — every required permission starts `denied` unless an
  // initial status is supplied.
  const statuses: PermissionStatusMap = {
    bluetooth: 'denied',
    location: 'denied',
    sms: 'denied',
    notifications: 'denied',
  };
  if (options.initialStatuses) {
    for (const permission of REQUIRED_PERMISSIONS) {
      const seeded = options.initialStatuses[permission];
      if (seeded) {
        statuses[permission] = seeded;
      }
    }
  }

  const openSettingsImpl: () => Promise<void> =
    requester.openSettings ?? (() => Linking.openSettings());

  async function requestWithRationale(
    permission: AppPermission,
    onShowRationale: (rationale: PermissionRationale) => Promise<void>,
  ): Promise<PermissionStatus> {
    // Requirement 10.3: the rationale is ALWAYS shown and acknowledged before
    // the system permission dialog is triggered.
    await onShowRationale(PERMISSION_RATIONALE[permission]);
    const status = await requester.request(permission);
    statuses[permission] = status;
    return status;
  }

  function getStatus(permission: AppPermission): PermissionStatus {
    return statuses[permission];
  }

  function getStatuses(): PermissionStatusMap {
    return {...statuses};
  }

  function allRequiredGranted(): boolean {
    return REQUIRED_PERMISSIONS.every(p => statuses[p] === 'granted');
  }

  function getDenialInfo(permission: AppPermission): PermissionDenialInfo {
    return PERMISSION_DENIAL[permission];
  }

  async function openSettings(): Promise<void> {
    await openSettingsImpl();
  }

  return {
    requestWithRationale,
    getStatus,
    getStatuses,
    allRequiredGranted,
    getDenialInfo,
    openSettings,
  };
}
