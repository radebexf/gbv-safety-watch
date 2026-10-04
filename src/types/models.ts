/**
 * Core data model definitions for GBV Safety Watch.
 * Populated in task 1.2; stub file created here for scaffolding.
 */

// ── Result type ───────────────────────────────────────────────────────────────

/**
 * Discriminated union representing a success or failure outcome.
 * Used by repository methods to return typed errors without throwing.
 */
export type Result<T, E> =
  | {ok: true; value: T}
  | {ok: false; error: E};

// ── Heart Rate ────────────────────────────────────────────────────────────────

export interface HeartRateSample {
  bpm: number; // validated: 20–300
  timestamp: number; // Unix ms
  source: 'watch' | 'phone_fallback';
}

export interface Baseline {
  medianBpm: number;
  sampleCount: number;
  computedAt: number; // Unix ms
}

export interface HrGapEvent {
  startedAt: number; // Unix ms
  retryCount: number; // 0–3
}

// ── GPS / Location ────────────────────────────────────────────────────────────

export interface GpsCoordinates {
  latitude: number;
  longitude: number;
}

export interface GpsCoordinatesWithMeta extends GpsCoordinates {
  source: 'watch' | 'phone';
  acquiredAt: number; // Unix ms
  isFresh: boolean; // true if acquiredAt > now - 5 min
}

// ── Emergency Contacts ────────────────────────────────────────────────────────

export interface EmergencyContact {
  id: string; // UUID v4
  name: string; // 1–100 chars
  phoneNumber: string; // E.164-ish: optional '+', 7–15 digits
}

export interface NewContact {
  name: string;
  phoneNumber: string;
}

export type ContactError =
  | 'DUPLICATE_PHONE'
  | 'LAST_CONTACT_REMOVAL'
  | 'VALIDATION_FAILED'
  | 'STORAGE_ERROR';

// ── User Profile & Settings ───────────────────────────────────────────────────

export interface UserSettings {
  distressThresholdPct: number; // 0.10 – 1.00, default 0.40
  falsePosWindowSeconds: number; // 5 – 60, default 15
}

export interface UserProfile {
  id: string;
  name: string;
  phoneNumber: string;
  onboardingCompleted: boolean;
  onboardingStep: 0 | 1 | 2 | 3 | 4; // 0 = not started
  settings: UserSettings;
}

// ── Alerts ────────────────────────────────────────────────────────────────────

export type TriggerType =
  | 'heart_rate_anomaly'
  | 'watch_removal'
  | 'bluetooth_disconnection'
  | 'manual';

export interface AlertEvent {
  triggerType: TriggerType;
  triggeredAt: number; // Unix ms
  coordinates: GpsCoordinatesWithMeta | null;
  contacts: EmergencyContact[];
  userProfile: UserProfile;
}

export interface ContactDeliveryResult {
  contact: EmergencyContact;
  status: 'delivered' | 'unreachable';
  attempts: number;
}

export interface AlertDispatchResult {
  dispatchedAt: number; // Unix ms
  contactResults: ContactDeliveryResult[];
}

export interface AlertLogEntry {
  id: string;
  dispatchedAt: number; // Unix ms
  triggerType: TriggerType;
  coordinates: GpsCoordinates | null;
  contactResults: ContactDeliveryResult[];
}

// ── Anomaly Detection ─────────────────────────────────────────────────────────

export type AnomalyResult =
  | {type: 'normal'}
  | {type: 'anomaly'; direction: 'high' | 'low'; triggeredAt: number};

// ── BLE / Connectivity ────────────────────────────────────────────────────────

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'unexpected_disconnection';

// ── Monitoring Session ────────────────────────────────────────────────────────

export interface MonitoringSession {
  activatedAt: number; // Unix ms
  state: 'active' | 'idle';
  watchConnected: boolean;
  phoneOnlyMode: boolean;
}
