/**
 * AnomalyDetector
 *
 * Pure-function core (`detectAnomaly`) wrapped in a stateful class
 * (`AnomalyDetector`) that tracks the previous sample between calls.
 *
 * Requirements covered: 2.1, 2.2, 2.6, 2.9
 */

import type { HeartRateSample, Baseline, AnomalyResult } from '../types';

// ── Pure detection function ───────────────────────────────────────────────────

/**
 * Stateless anomaly detection rule.
 *
 * Triggers when BOTH the previous and the current sample fall on the same
 * side of the threshold band around the baseline median.
 *
 * @param prev         - The sample immediately before the current one.
 * @param curr         - The most recently received sample.
 * @param baseline     - The user's computed resting heart-rate baseline.
 * @param thresholdPct - Fractional deviation from the median (e.g. 0.40 = 40%).
 * @returns `{ type: 'anomaly', ... }` when both samples breach a bound,
 *          `{ type: 'normal' }` otherwise.
 *
 * Validates: Requirements 2.1, 2.2
 */
export function detectAnomaly(
  prev: HeartRateSample,
  curr: HeartRateSample,
  baseline: Baseline,
  thresholdPct: number,
): AnomalyResult {
  const threshold = baseline.medianBpm * thresholdPct;
  const highBound = baseline.medianBpm + threshold;
  const lowBound = baseline.medianBpm - threshold;

  if (prev.bpm > highBound && curr.bpm > highBound) {
    return { type: 'anomaly', direction: 'high', triggeredAt: curr.timestamp };
  }
  if (prev.bpm < lowBound && curr.bpm < lowBound) {
    return { type: 'anomaly', direction: 'low', triggeredAt: curr.timestamp };
  }
  return { type: 'normal' };
}

// ── Stateful wrapper ──────────────────────────────────────────────────────────

/**
 * Stateful monitor that wraps `detectAnomaly` by keeping the previous sample
 * between successive `evaluate` calls.
 *
 * Behaviour:
 * - First call (no previous sample stored): returns `{ type: 'normal' }`.
 * - Subsequent calls: delegates to `detectAnomaly` with the stored previous
 *   sample and the newly supplied sample.
 * - If `baseline` is null / undefined (Requirement 2.9): returns
 *   `{ type: 'normal' }` and logs a suspension message without initiating any
 *   distress workflow.
 * - `reset()`: clears the stored previous sample so the next `evaluate` call
 *   is treated as a fresh start (Requirement 2.6).
 */
export class AnomalyDetector {
  private prevSample: HeartRateSample | null = null;

  /**
   * Evaluate a new heart-rate sample against the given baseline.
   *
   * @param sample    - The latest validated heart-rate sample.
   * @param baseline  - The current baseline, or null/undefined if not yet computed.
   * @param threshold - Fractional threshold percentage (e.g. 0.40 for 40%).
   */
  evaluate(
    sample: HeartRateSample,
    baseline: Baseline | null | undefined,
    threshold: number,
  ): AnomalyResult {
    // Requirement 2.9 – suspend detection when no baseline exists.
    if (baseline == null) {
      console.log('Anomaly detection suspended: no baseline available');
      return { type: 'normal' };
    }

    // First call – no previous sample yet; store and return normal.
    if (this.prevSample === null) {
      this.prevSample = sample;
      return { type: 'normal' };
    }

    const result = detectAnomaly(this.prevSample, sample, baseline, threshold);

    // Advance the window regardless of the result.
    this.prevSample = sample;

    return result;
  }

  /**
   * Clear stored state so the next `evaluate` call starts fresh.
   * Requirement 2.6 – called when the user cancels an alert.
   */
  reset(): void {
    this.prevSample = null;
  }
}

// ── Factory function ──────────────────────────────────────────────────────────

/**
 * Convenience factory that creates a new `AnomalyDetector` instance.
 * Prefer this over `new AnomalyDetector()` in application code.
 */
export function createAnomalyDetector(): AnomalyDetector {
  return new AnomalyDetector();
}
