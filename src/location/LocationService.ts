/**
 * LocationService
 *
 * Maintains a cached GPS fix by polling every ≤30 s while monitoring is active.
 * Prefers watch GPS (via BLE command); falls back to phone GPS when the watch
 * GPS is unavailable.  Exposes `cachedCoordinates` and `getCurrentCoordinates()`
 * for use by the AlertPipeline and MonitoringStateMachine.
 *
 * Dependencies are fully injected so the service is testable without any
 * native modules.  Do NOT import react-native-geolocation-service here.
 *
 * Requirements covered: 3.2, 3.3, 3.5
 */

import type { GpsCoordinates, GpsCoordinatesWithMeta } from '../types';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Coordinates are considered "fresh" if acquired within the last 5 minutes. */
const FRESHNESS_WINDOW_MS = 300_000; // 5 min × 60 s × 1000 ms

/** Default polling interval: 30 seconds (Requirement 3.5). */
const DEFAULT_POLL_INTERVAL_MS = 30_000;

// ── Options ───────────────────────────────────────────────────────────────────

export interface LocationServiceOptions {
  /**
   * Request a GPS fix from the watch over BLE.
   * Returns null when the watch GPS is unavailable or the BLE command fails.
   * (Requirement 3.2)
   */
  requestWatchGps: () => Promise<GpsCoordinates | null>;

  /**
   * Request a GPS fix from the phone's native location provider.
   * Returns null when location permission is denied or no fix is available.
   * (Requirement 3.3)
   */
  requestPhoneGps: () => Promise<GpsCoordinates | null>;

  /**
   * Polling interval in milliseconds.  Must be ≤ 30 000.
   * Defaults to 30 000 (30 s).
   */
  pollIntervalMs?: number;

  /**
   * Clock override (injected for deterministic testing).
   * Defaults to `Date.now`.
   */
  now?: () => number;

  /**
   * Timer override for `setInterval` (injected for deterministic testing).
   * Defaults to the global `setInterval`.
   */
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;

  /**
   * Timer override for `clearInterval` (injected for deterministic testing).
   * Defaults to the global `clearInterval`.
   */
  clearInterval?: (id: ReturnType<typeof setInterval>) => void;
}

// ── Interface (matches design.md §4) ─────────────────────────────────────────

export interface ILocationService {
  /** Begin polling for GPS fixes at the configured interval. */
  start(): void;

  /** Stop polling and clear the active interval. */
  stop(): void;

  /**
   * Trigger an immediate single poll (same watch-first, phone-fallback logic).
   * Returns the freshly acquired coordinates, or—if both sources fail—the
   * existing `cachedCoordinates` with `isFresh` recomputed against the current
   * clock.  Returns `null` only when no coordinates have ever been acquired.
   */
  getCurrentCoordinates(): Promise<GpsCoordinatesWithMeta | null>;

  /** Most recently cached coordinates, or null if none have been acquired yet. */
  cachedCoordinates: GpsCoordinatesWithMeta | null;
}

// ── Implementation ────────────────────────────────────────────────────────────

export class LocationService implements ILocationService {
  // ── Public state ───────────────────────────────────────────────────────────
  cachedCoordinates: GpsCoordinatesWithMeta | null = null;

  // ── Injected dependencies ──────────────────────────────────────────────────
  private readonly requestWatchGps: () => Promise<GpsCoordinates | null>;
  private readonly requestPhoneGps: () => Promise<GpsCoordinates | null>;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly _setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly _clearInterval: (id: ReturnType<typeof setInterval>) => void;

  // ── Internal state ─────────────────────────────────────────────────────────
  private timerId: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(options: LocationServiceOptions) {
    this.requestWatchGps = options.requestWatchGps;
    this.requestPhoneGps = options.requestPhoneGps;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
    this._setInterval = options.setInterval ?? setInterval.bind(globalThis);
    this._clearInterval = options.clearInterval ?? clearInterval.bind(globalThis);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Start polling every `pollIntervalMs`.
   * Calling `start()` while already started is a no-op.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    // Run an immediate poll so `cachedCoordinates` is populated without waiting
    // for the first interval to elapse.
    void this._poll();

    this.timerId = this._setInterval(() => {
      void this._poll();
    }, this.pollIntervalMs);
  }

  /**
   * Stop polling.
   * Calling `stop()` while not started is a no-op.
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.timerId !== null) {
      this._clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /**
   * Perform a single on-demand poll (watch GPS → phone fallback).
   *
   * - If a new fix is acquired, `cachedCoordinates` is updated and the fresh
   *   coordinates are returned.
   * - If both sources fail and we have an existing cache, `isFresh` is
   *   recomputed against the current clock and the updated cache is returned.
   * - If both sources fail and there is no cache, returns `null`.
   */
  async getCurrentCoordinates(): Promise<GpsCoordinatesWithMeta | null> {
    return this._poll();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Core poll logic:
   *  1. Try watch GPS (Requirement 3.2)
   *  2. Fall back to phone GPS if watch unavailable (Requirement 3.3)
   *  3. Update `cachedCoordinates` with `acquiredAt` and `isFresh`
   *  4. If both fail, recompute `isFresh` on existing cache (don't overwrite)
   */
  private async _poll(): Promise<GpsCoordinatesWithMeta | null> {
    // Step 1 – Try watch GPS
    let coords: GpsCoordinates | null = null;
    let source: 'watch' | 'phone' = 'watch';

    try {
      coords = await this.requestWatchGps();
    } catch {
      coords = null;
    }

    // Step 2 – Fall back to phone GPS if watch returned nothing
    if (coords === null) {
      source = 'phone';
      try {
        coords = await this.requestPhoneGps();
      } catch {
        coords = null;
      }
    }

    const acquiredAt = this.now();

    // Step 3 – Got a fix: update cache and return
    if (coords !== null) {
      const updated: GpsCoordinatesWithMeta = {
        latitude: coords.latitude,
        longitude: coords.longitude,
        source,
        acquiredAt,
        isFresh: this._computeIsFresh(acquiredAt),
      };
      this.cachedCoordinates = updated;
      return updated;
    }

    // Step 4 – Both sources failed: recompute freshness on existing cache
    if (this.cachedCoordinates !== null) {
      const recomputed: GpsCoordinatesWithMeta = {
        ...this.cachedCoordinates,
        isFresh: this._computeIsFresh(this.cachedCoordinates.acquiredAt),
      };
      this.cachedCoordinates = recomputed;
      return recomputed;
    }

    // No coordinates ever acquired
    return null;
  }

  /**
   * Returns true when `acquiredAt` is within the 5-minute freshness window.
   * Implements: `isFresh = acquiredAt > now() − 300_000`
   */
  private _computeIsFresh(acquiredAt: number): boolean {
    return acquiredAt > this.now() - FRESHNESS_WINDOW_MS;
  }
}

// ── Factory function ──────────────────────────────────────────────────────────

/**
 * Convenience factory that constructs a `LocationService` with the given
 * options.  Prefer this over `new LocationService(...)` in application code.
 */
export function createLocationService(
  options: LocationServiceOptions,
): LocationService {
  return new LocationService(options);
}
