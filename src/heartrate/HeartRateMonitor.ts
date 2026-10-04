/**
 * HeartRateMonitor
 *
 * Reads validated heart-rate samples from an injected Observable source,
 * maintains a 60-entry rolling buffer and a 300-entry baseline ring buffer,
 * detects >15 s sample gaps, and exposes typed observables for downstream consumers.
 *
 * Requirements covered: 1.1, 1.2, 1.3, 1.4
 */

import type { HeartRateSample, Baseline, HrGapEvent } from '../types';

// ── Minimal Observable / Subject ─────────────────────────────────────────────

/**
 * A lightweight observable that supports subscribe / next / complete.
 * Replaces rxjs to keep the bundle free of heavy dependencies.
 */
export class Subject<T> {
  private observers: Array<(value: T) => void> = [];
  private _completed = false;

  /** Register a listener.  Returns an unsubscribe function. */
  subscribe(fn: (value: T) => void): () => void {
    if (this._completed) {
      return () => {};
    }
    this.observers.push(fn);
    return () => {
      this.observers = this.observers.filter(o => o !== fn);
    };
  }

  /** Emit a value to all current subscribers. */
  next(value: T): void {
    if (this._completed) return;
    // snapshot the list so late unsubscribes inside a handler don't corrupt iteration
    const snapshot = this.observers.slice();
    for (const fn of snapshot) {
      fn(value);
    }
  }

  /** Close the subject – no further values will be emitted. */
  complete(): void {
    this._completed = true;
    this.observers = [];
  }

  get isCompleted(): boolean {
    return this._completed;
  }
}

/** Minimal read-only observable handle exposed to external consumers. */
export interface Observable<T> {
  subscribe(fn: (value: T) => void): () => void;
}

// ── Ring-buffer helpers ───────────────────────────────────────────────────────

/** Generic fixed-capacity circular ring buffer (FIFO, overwrites oldest). */
class RingBuffer<T> {
  private buf: Array<T | undefined>;
  private head = 0; // index of the next write slot
  private _size = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    if (capacity < 1) throw new RangeError('capacity must be ≥ 1');
    this.capacity = capacity;
    this.buf = new Array<T | undefined>(capacity).fill(undefined);
  }

  push(item: T): void {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this._size < this.capacity) this._size++;
  }

  /** Returns items in insertion order (oldest → newest). */
  toArray(): T[] {
    if (this._size === 0) return [];
    const result: T[] = [];
    const start = this._size < this.capacity ? 0 : this.head;
    for (let i = 0; i < this._size; i++) {
      result.push(this.buf[(start + i) % this.capacity] as T);
    }
    return result;
  }

  get size(): number {
    return this._size;
  }

  clear(): void {
    this.buf = new Array<T | undefined>(this.capacity).fill(undefined);
    this.head = 0;
    this._size = 0;
  }
}

// ── Median computation ────────────────────────────────────────────────────────

/**
 * Computes the statistical median of a non-empty numeric array.
 * Does not mutate the input array.
 */
function computeMedian(values: number[]): number {
  if (values.length === 0) throw new RangeError('Cannot compute median of empty array');
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const BPM_MIN = 20;
const BPM_MAX = 300;
const ROLLING_BUFFER_CAPACITY = 60;
const BASELINE_BUFFER_CAPACITY = 300;
const GAP_THRESHOLD_MS = 15_000; // 15 s
const GAP_CHECK_INTERVAL_MS = 1_000; // poll every 1 s
const RETRY_INTERVAL_MS = 5_000; // 5 s between retries
const MAX_RETRIES = 3;

// ── HeartRateMonitor ──────────────────────────────────────────────────────────

/** Raw sample shape emitted by the BLE source. */
export interface RawHeartRateSample {
  bpm: number;
  timestamp: number; // Unix ms
}

export interface HeartRateMonitorOptions {
  /**
   * Observable that emits raw (unvalidated) BPM readings from the BLE layer.
   * The monitor subscribes on `start()` and unsubscribes on `stop()`.
   */
  subscribeToRawSamples: Observable<RawHeartRateSample>;

  /**
   * Identifies the source of the BLE samples so validated samples carry
   * the correct provenance.  Defaults to `'watch'`.
   */
  source?: HeartRateSample['source'];

  /**
   * Override the clock (useful in tests to control time).
   * Defaults to `() => Date.now()`.
   */
  now?: () => number;

  /**
   * Override `setInterval` / `clearInterval` (useful in tests).
   */
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

export class HeartRateMonitor {
  // ── Observables ────────────────────────────────────────────────────────────
  readonly sample$: Subject<HeartRateSample>;
  readonly gap$: Subject<HrGapEvent>;

  // ── Internal state ─────────────────────────────────────────────────────────
  private readonly rollingBuffer: RingBuffer<HeartRateSample>;
  private readonly baselineBuffer: RingBuffer<number>; // stores only bpm values
  private baseline: Baseline | null = null;

  private inDistressMode = false;
  private started = false;

  private lastSampleTimestamp: number | null = null;
  private gapRetryCount = 0;
  private lastGapEmitTimestamp: number | null = null; // when we first noticed the gap

  private gapTimerId: ReturnType<typeof setInterval> | null = null;
  private rawUnsub: (() => void) | null = null;

  // ── Injected dependencies ──────────────────────────────────────────────────
  private readonly rawSource: Observable<RawHeartRateSample>;
  private readonly sampleSource: HeartRateSample['source'];
  private readonly now: () => number;
  private readonly _setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly _clearInterval: (h: ReturnType<typeof setInterval>) => void;

  constructor(options: HeartRateMonitorOptions) {
    this.rawSource = options.subscribeToRawSamples;
    this.sampleSource = options.source ?? 'watch';
    this.now = options.now ?? (() => Date.now());
    this._setInterval = options.setInterval ?? setInterval.bind(globalThis);
    this._clearInterval = options.clearInterval ?? clearInterval.bind(globalThis);

    this.rollingBuffer = new RingBuffer<HeartRateSample>(ROLLING_BUFFER_CAPACITY);
    this.baselineBuffer = new RingBuffer<number>(BASELINE_BUFFER_CAPACITY);
    this.sample$ = new Subject<HeartRateSample>();
    this.gap$ = new Subject<HrGapEvent>();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Begin listening for raw samples and gap detection. */
  start(): void {
    if (this.started) return;
    this.started = true;

    // Subscribe to raw BLE samples
    this.rawUnsub = this.rawSource.subscribe(raw => this._handleRawSample(raw));

    // Start gap-detection polling loop
    this.gapTimerId = this._setInterval(() => this._checkGap(), GAP_CHECK_INTERVAL_MS);
  }

  /** Stop listening and cancel the gap-detection loop. */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.rawUnsub) {
      this.rawUnsub();
      this.rawUnsub = null;
    }

    if (this.gapTimerId !== null) {
      this._clearInterval(this.gapTimerId);
      this.gapTimerId = null;
    }

    // Reset gap tracking (retries cleared on stop)
    this.gapRetryCount = 0;
    this.lastGapEmitTimestamp = null;
  }

  /**
   * Snapshot of the current rolling buffer in insertion order (oldest → newest).
   * The buffer contents survive a BLE disconnect (Requirement 1.2).
   */
  getBuffer(): readonly HeartRateSample[] {
    return this.rollingBuffer.toArray();
  }

  /** Returns the most recently computed Baseline, or null if insufficient data. */
  getBaseline(): Baseline | null {
    return this.baseline;
  }

  /**
   * Set distress-mode flag.  While true, incoming valid samples are still
   * pushed to the rolling buffer and `sample$`, but NOT appended to the
   * baseline buffer (Requirement 1.4).
   */
  setDistressMode(active: boolean): void {
    this.inDistressMode = active;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Process one raw sample from the BLE source. */
  private _handleRawSample(raw: RawHeartRateSample): void {
    // Requirement 1.1 – discard anything outside [20, 300]
    if (!this._isValidBpm(raw.bpm)) {
      return; // silently discard
    }

    const sample: HeartRateSample = {
      bpm: raw.bpm,
      timestamp: raw.timestamp,
      source: this.sampleSource,
    };

    // Requirement 1.2 – store in rolling buffer (buffer is NOT cleared on disconnect)
    this.rollingBuffer.push(sample);

    // Update gap-tracking state
    this.lastSampleTimestamp = raw.timestamp;
    this.gapRetryCount = 0;      // reset retry counter on valid sample
    this.lastGapEmitTimestamp = null; // gap resolved

    // Requirement 1.4 – baseline update only outside distress events
    if (!this.inDistressMode) {
      this.baselineBuffer.push(raw.bpm);
      this._recomputeBaseline();
    }

    // Emit validated sample
    this.sample$.next(sample);
  }

  /** Validate BPM range per Requirement 1.1. */
  private _isValidBpm(bpm: number): boolean {
    return Number.isFinite(bpm) && bpm >= BPM_MIN && bpm <= BPM_MAX;
  }

  /**
   * Recompute Baseline as the median of the baseline buffer.
   * Called after every append to the baseline buffer.
   */
  private _recomputeBaseline(): void {
    const values = this.baselineBuffer.toArray();
    if (values.length === 0) return;

    this.baseline = {
      medianBpm: computeMedian(values),
      sampleCount: values.length,
      computedAt: this.now(),
    };
  }

  /**
   * Gap detection tick (runs every GAP_CHECK_INTERVAL_MS while started).
   *
   * Requirement 1.3:
   *   - If >15 s without a valid sample → emit on gap$, retry up to 3×
   *   - Each retry fires 5 s after the previous gap emit
   *   - Does NOT trigger an alert; merely logs (via gap$ emission)
   */
  private _checkGap(): void {
    if (!this.started) return;

    const now = this.now();

    // No samples ever received — nothing to detect yet
    if (this.lastSampleTimestamp === null) return;

    const elapsed = now - this.lastSampleTimestamp;

    if (elapsed <= GAP_THRESHOLD_MS) {
      // Still within the acceptable window — nothing to do
      return;
    }

    // We are in a gap situation
    if (this.lastGapEmitTimestamp === null) {
      // First time we detect the gap — emit immediately
      this.lastGapEmitTimestamp = now;
      this._emitGap(now);
      return;
    }

    // Already emitted at least once — check if it's time for a retry
    if (this.gapRetryCount > MAX_RETRIES) {
      // Exhausted retries, stop emitting gap events
      return;
    }

    const timeSinceLastGapEmit = now - this.lastGapEmitTimestamp;
    if (timeSinceLastGapEmit >= RETRY_INTERVAL_MS) {
      this.lastGapEmitTimestamp = now;
      this._emitGap(now);
    }
  }

  /** Emit a HrGapEvent and increment the retry counter. */
  private _emitGap(timestamp: number): void {
    this.gap$.next({
      startedAt: timestamp,
      retryCount: this.gapRetryCount,
    });
    this.gapRetryCount++;
  }
}

// ── Factory function ──────────────────────────────────────────────────────────

/**
 * Convenience factory that constructs a `HeartRateMonitor` with the given
 * options.  Prefer this over `new HeartRateMonitor(...)` in application code
 * so callers don't need to import the class directly.
 */
export function createHeartRateMonitor(
  options: HeartRateMonitorOptions,
): HeartRateMonitor {
  return new HeartRateMonitor(options);
}
