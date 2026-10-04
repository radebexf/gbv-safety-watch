/**
 * AlertPipeline
 *
 * Assembles SMS alert messages from AlertEvent data and dispatches them to all
 * registered emergency contacts with retry logic and persistent logging.
 *
 * Requirements covered: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 2.10, 7.4
 */

import type {
  AlertEvent,
  AlertDispatchResult,
  AlertLogEntry,
  ContactDeliveryResult,
  TriggerType,
} from '../types';
import type { EncryptedStorageInterface } from '../storage/EncryptedStorage';

// ── Trigger label map ─────────────────────────────────────────────────────────

/**
 * Human-readable labels for each trigger type, used in the SMS message body.
 *
 * Validates: Requirements 5.2, 7.4
 */
export const TRIGGER_LABELS: Record<TriggerType, string> = {
  heart_rate_anomaly: 'heart rate anomaly',
  watch_removal: 'watch removal',
  bluetooth_disconnection: 'bluetooth disconnection',
  manual: 'manual trigger',
};

// ── Pure message-assembly function ───────────────────────────────────────────

/**
 * Renders the SMS message body for a safety alert.
 *
 * GPS coordinate handling:
 * - Fresh coordinates (`isFresh === true`): includes Location + Map link.
 * - Stale coordinates (`isFresh === false`): includes Location + Map link +
 *   a note with the UTC timestamp at which those coordinates were recorded.
 * - No coordinates (`null`): includes a note stating no location data is
 *   available.
 *
 * @param event - The alert event containing all fields needed to compose the message.
 * @returns     - The fully rendered SMS body string.
 *
 * Validates: Requirements 5.2
 */
export function assembleAlertMessage(event: AlertEvent): string {
  const { triggerType, triggeredAt, coordinates, userProfile } = event;

  const triggerLabel = TRIGGER_LABELS[triggerType];
  const timeUtc = new Date(triggeredAt).toISOString();
  const userName = userProfile.name;

  // Build the location block depending on GPS state.
  let locationBlock: string;

  if (coordinates === null) {
    // No coordinates ever acquired (Requirement 3.6).
    locationBlock = 'Note: No location data available';
  } else {
    const { latitude, longitude, isFresh, acquiredAt } = coordinates;
    const lat = latitude;
    const lng = longitude;

    const locationLine = `Location: ${lat}, ${lng}`;
    const mapLine = `Map: https://maps.google.com/?q=${lat},${lng}`;

    if (isFresh) {
      // Fresh coordinates – no stale note required.
      locationBlock = `${locationLine}\n${mapLine}`;
    } else {
      // Stale coordinates – include the UTC timestamp of acquisition (Requirement 3.4).
      const acquiredAtUtc = new Date(acquiredAt).toISOString();
      locationBlock =
        `${locationLine}\n${mapLine}\nNote: Location last recorded at ${acquiredAtUtc}`;
    }
  }

  return (
    `🚨 SAFETY ALERT – ${userName}\n` +
    `\n` +
    `Trigger: ${triggerLabel}\n` +
    `Time (UTC): ${timeUtc}\n` +
    `${locationBlock}\n` +
    `\n` +
    `This message was sent automatically by GBV Safety Watch.`
  );
}

// ── Dependency-injection options ──────────────────────────────────────────────

/** Maximum number of send attempts per contact (1 initial + 2 retries). */
const MAX_ATTEMPTS = 3;

/** Delay between retry attempts in milliseconds. */
const RETRY_DELAY_MS = 10_000;

/** Storage key (sub-key — the `gbv.` prefix is added by EncryptedStorage). */
const ALERT_LOG_KEY = 'alert_log';

/**
 * Options injected into AlertPipeline, enabling testability without
 * native-module dependencies.
 */
export interface AlertPipelineOptions {
  /** Send an SMS to the given phone number. Rejects on failure. */
  sendSms: (phoneNumber: string, message: string) => Promise<void>;
  /** Encrypted storage implementation for persisting alert logs. */
  storage: EncryptedStorageInterface;
  /** Override for ID generation (defaults to a simple timestamp-based id). */
  generateId?: () => string;
  /** Override for the current time in Unix ms (defaults to `Date.now`). */
  now?: () => number;
  /** Override for async delay — used between retry attempts. */
  delay?: (ms: number) => Promise<void>;
}

// ── AlertPipeline class ───────────────────────────────────────────────────────

/**
 * AlertPipeline orchestrates the full alert dispatch flow:
 *  1. Guards against empty contact lists (Req 5.6, 2.10).
 *  2. Sends SMS to every contact via the injected `sendSms` adapter.
 *  3. Retries up to 3 attempts (10 s apart) on failure (Req 5.3).
 *  4. Persists an `AlertLogEntry` to encrypted storage after dispatch (Req 5.5).
 *  5. Returns an `AlertDispatchResult` with per-contact delivery status (Req 5.4).
 *
 * Validates: Requirements 5.1, 5.3, 5.4, 5.5, 5.6, 2.10
 */
export class AlertPipeline {
  private readonly sendSms: AlertPipelineOptions['sendSms'];
  private readonly storage: EncryptedStorageInterface;
  private readonly generateId: () => string;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;

  constructor(options: AlertPipelineOptions) {
    this.sendSms = options.sendSms;
    this.storage = options.storage;
    this.generateId = options.generateId ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    this.now = options.now ?? (() => Date.now());
    this.delay = options.delay ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  }

  /**
   * Dispatch an alert to all contacts in the event.
   *
   * @param event - The alert event to dispatch.
   * @returns     - Per-contact delivery results and dispatch timestamp.
   * @throws      - `Error('NO_CONTACTS')` if `event.contacts` is empty.
   *
   * Validates: Requirements 5.1, 5.3, 5.4, 5.5, 5.6, 2.10
   */
  async dispatch(event: AlertEvent): Promise<AlertDispatchResult> {
    // ── Guard: no contacts registered (Req 5.6, 2.10) ──────────────────────
    if (event.contacts.length === 0) {
      throw new Error('NO_CONTACTS');
    }

    const message = assembleAlertMessage(event);
    const dispatchedAt = this.now();

    // ── Send to each contact with retry logic (Req 5.1, 5.3) ───────────────
    const contactResults: ContactDeliveryResult[] = [];

    for (const contact of event.contacts) {
      let attempts = 0;
      let delivered = false;

      while (attempts < MAX_ATTEMPTS && !delivered) {
        attempts += 1;
        try {
          await this.sendSms(contact.phoneNumber, message);
          delivered = true;
        } catch {
          // On failure, wait before retrying (unless this was the last attempt).
          if (attempts < MAX_ATTEMPTS) {
            await this.delay(RETRY_DELAY_MS);
          }
        }
      }

      contactResults.push({
        contact,
        status: delivered ? 'delivered' : 'unreachable',
        attempts,
      });
    }

    const result: AlertDispatchResult = { dispatchedAt, contactResults };

    // ── Persist alert log entry (Req 5.5) ───────────────────────────────────
    // Storage failures must NOT block the dispatch result from being returned.
    try {
      await this.persistLog(event, result);
    } catch (err) {
      console.error('[AlertPipeline] Failed to persist alert log:', err);
    }

    return result;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Append an `AlertLogEntry` to the `gbv.alert_log` array in encrypted storage.
   */
  private async persistLog(
    event: AlertEvent,
    result: AlertDispatchResult,
  ): Promise<void> {
    // Load the existing log (may be null if this is the first entry).
    const raw = await this.storage.get(ALERT_LOG_KEY);
    const existing: AlertLogEntry[] = raw ? (JSON.parse(raw) as AlertLogEntry[]) : [];

    const entry: AlertLogEntry = {
      id: this.generateId(),
      dispatchedAt: result.dispatchedAt,
      triggerType: event.triggerType,
      coordinates: event.coordinates
        ? { latitude: event.coordinates.latitude, longitude: event.coordinates.longitude }
        : null,
      contactResults: result.contactResults,
    };

    existing.push(entry);
    await this.storage.set(ALERT_LOG_KEY, JSON.stringify(existing));
  }
}
