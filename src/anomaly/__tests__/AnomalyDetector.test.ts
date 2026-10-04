/**
 * Unit tests for AnomalyDetector
 *
 * Requirements covered: 2.1, 2.2, 2.6, 2.9
 */

import {
  detectAnomaly,
  AnomalyDetector,
  createAnomalyDetector,
} from '../AnomalyDetector';
import type { HeartRateSample, Baseline, AnomalyResult } from '../../types';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeSample(bpm: number, timestamp = 1_000_000): HeartRateSample {
  return { bpm, timestamp, source: 'watch' };
}

function makeBaseline(medianBpm: number): Baseline {
  return { medianBpm, sampleCount: 10, computedAt: 0 };
}

// ── detectAnomaly pure function ───────────────────────────────────────────────

describe('detectAnomaly – pure function', () => {
  // Requirement 2.1 – high anomaly
  describe('Requirement 2.1 – high anomaly', () => {
    test('returns anomaly/high when both samples exceed upper bound', () => {
      // baseline=100, threshold=0.40 → highBound=140
      const baseline = makeBaseline(100);
      const prev = makeSample(145, 1000);
      const curr = makeSample(150, 2000);

      const result = detectAnomaly(prev, curr, baseline, 0.40);

      expect(result).toEqual({ type: 'anomaly', direction: 'high', triggeredAt: 2000 });
    });

    test('returns normal when only curr exceeds upper bound (not prev)', () => {
      const baseline = makeBaseline(100);
      const prev = makeSample(100, 1000); // within band
      const curr = makeSample(150, 2000); // above highBound

      expect(detectAnomaly(prev, curr, baseline, 0.40)).toEqual({ type: 'normal' });
    });

    test('returns normal when only prev exceeds upper bound (not curr)', () => {
      const baseline = makeBaseline(100);
      const prev = makeSample(150, 1000); // above highBound
      const curr = makeSample(100, 2000); // within band

      expect(detectAnomaly(prev, curr, baseline, 0.40)).toEqual({ type: 'normal' });
    });

    test('triggeredAt is set to curr.timestamp, not prev.timestamp', () => {
      const baseline = makeBaseline(100);
      const prev = makeSample(145, 1000);
      const curr = makeSample(150, 9999);

      const result = detectAnomaly(prev, curr, baseline, 0.40) as Extract<AnomalyResult, { type: 'anomaly' }>;
      expect(result.triggeredAt).toBe(9999);
    });
  });

  // Requirement 2.2 – low anomaly
  describe('Requirement 2.2 – low anomaly', () => {
    test('returns anomaly/low when both samples fall below lower bound', () => {
      // baseline=100, threshold=0.40 → lowBound=60
      const baseline = makeBaseline(100);
      const prev = makeSample(55, 1000);
      const curr = makeSample(50, 2000);

      const result = detectAnomaly(prev, curr, baseline, 0.40);

      expect(result).toEqual({ type: 'anomaly', direction: 'low', triggeredAt: 2000 });
    });

    test('returns normal when only curr falls below lower bound', () => {
      const baseline = makeBaseline(100);
      const prev = makeSample(100, 1000); // within band
      const curr = makeSample(50, 2000);  // below lowBound

      expect(detectAnomaly(prev, curr, baseline, 0.40)).toEqual({ type: 'normal' });
    });

    test('returns normal when only prev falls below lower bound', () => {
      const baseline = makeBaseline(100);
      const prev = makeSample(50, 1000);  // below lowBound
      const curr = makeSample(100, 2000); // within band

      expect(detectAnomaly(prev, curr, baseline, 0.40)).toEqual({ type: 'normal' });
    });
  });

  // Boundary / edge cases
  describe('boundary conditions', () => {
    test('samples exactly at highBound are NOT anomalous (strict >)', () => {
      // baseline=100, threshold=0.40 → highBound=140
      const baseline = makeBaseline(100);
      const prev = makeSample(140, 1000); // exactly at bound
      const curr = makeSample(140, 2000);

      expect(detectAnomaly(prev, curr, baseline, 0.40)).toEqual({ type: 'normal' });
    });

    test('samples exactly at lowBound are NOT anomalous (strict <)', () => {
      // baseline=100, threshold=0.40 → lowBound=60
      const baseline = makeBaseline(100);
      const prev = makeSample(60, 1000); // exactly at bound
      const curr = makeSample(60, 2000);

      expect(detectAnomaly(prev, curr, baseline, 0.40)).toEqual({ type: 'normal' });
    });

    test('returns normal when both samples are within band', () => {
      const baseline = makeBaseline(100);
      const prev = makeSample(100, 1000);
      const curr = makeSample(100, 2000);

      expect(detectAnomaly(prev, curr, baseline, 0.40)).toEqual({ type: 'normal' });
    });

    test('handles 10% threshold correctly', () => {
      // baseline=100, threshold=0.10 → highBound=110, lowBound=90
      const baseline = makeBaseline(100);
      expect(detectAnomaly(makeSample(111), makeSample(112), baseline, 0.10))
        .toEqual({ type: 'anomaly', direction: 'high', triggeredAt: 1_000_000 });
      expect(detectAnomaly(makeSample(89), makeSample(88), baseline, 0.10))
        .toEqual({ type: 'anomaly', direction: 'low', triggeredAt: 1_000_000 });
    });

    test('handles 100% threshold correctly', () => {
      // baseline=100, threshold=1.00 → highBound=200, lowBound=0
      const baseline = makeBaseline(100);
      expect(detectAnomaly(makeSample(201), makeSample(202), baseline, 1.00))
        .toEqual({ type: 'anomaly', direction: 'high', triggeredAt: 1_000_000 });
      // both samples are above lowBound (0) so not a low anomaly
      expect(detectAnomaly(makeSample(50), makeSample(60), baseline, 1.00))
        .toEqual({ type: 'normal' });
    });
  });
});

// ── AnomalyDetector stateful class ───────────────────────────────────────────

describe('AnomalyDetector – stateful wrapper', () => {
  // Requirement 2.9 – no baseline
  describe('Requirement 2.9 – no baseline guard', () => {
    test('returns normal and logs when baseline is null', () => {
      const detector = new AnomalyDetector();
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const result = detector.evaluate(makeSample(200), null, 0.40);

      expect(result).toEqual({ type: 'normal' });
      expect(logSpy).toHaveBeenCalledWith(
        'Anomaly detection suspended: no baseline available',
      );

      logSpy.mockRestore();
    });

    test('returns normal and logs when baseline is undefined', () => {
      const detector = new AnomalyDetector();
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const result = detector.evaluate(makeSample(200), undefined, 0.40);

      expect(result).toEqual({ type: 'normal' });
      expect(logSpy).toHaveBeenCalledWith(
        'Anomaly detection suspended: no baseline available',
      );

      logSpy.mockRestore();
    });

    test('does not store the sample when baseline is absent', () => {
      const detector = new AnomalyDetector();
      jest.spyOn(console, 'log').mockImplementation(() => {});

      // Evaluate with no baseline – should not store as prevSample
      detector.evaluate(makeSample(200), null, 0.40);

      // Now provide a baseline; since no prevSample was stored the first
      // real evaluate call should still return normal (first-call guard).
      const baseline = makeBaseline(100);
      const result = detector.evaluate(makeSample(200), baseline, 0.40);

      expect(result).toEqual({ type: 'normal' });

      jest.restoreAllMocks();
    });
  });

  // First-call behaviour
  describe('first-call behaviour', () => {
    test('returns normal on the very first evaluate (no prev sample)', () => {
      const detector = new AnomalyDetector();
      const baseline = makeBaseline(100);

      const result = detector.evaluate(makeSample(200), baseline, 0.40);

      expect(result).toEqual({ type: 'normal' });
    });
  });

  // Normal detection flow
  describe('detection flow', () => {
    test('detects high anomaly on second call when both samples exceed bound', () => {
      const detector = new AnomalyDetector();
      const baseline = makeBaseline(100); // highBound = 140

      detector.evaluate(makeSample(145, 1000), baseline, 0.40); // stores prev
      const result = detector.evaluate(makeSample(150, 2000), baseline, 0.40);

      expect(result).toEqual({ type: 'anomaly', direction: 'high', triggeredAt: 2000 });
    });

    test('detects low anomaly on second call when both samples breach lower bound', () => {
      const detector = new AnomalyDetector();
      const baseline = makeBaseline(100); // lowBound = 60

      detector.evaluate(makeSample(55, 1000), baseline, 0.40);
      const result = detector.evaluate(makeSample(50, 2000), baseline, 0.40);

      expect(result).toEqual({ type: 'anomaly', direction: 'low', triggeredAt: 2000 });
    });

    test('returns normal when only one of the two samples breaches the bound', () => {
      const detector = new AnomalyDetector();
      const baseline = makeBaseline(100); // highBound = 140

      detector.evaluate(makeSample(100, 1000), baseline, 0.40); // normal
      const result = detector.evaluate(makeSample(150, 2000), baseline, 0.40); // only curr high

      expect(result).toEqual({ type: 'normal' });
    });

    test('each call advances the window (curr becomes next prev)', () => {
      const detector = new AnomalyDetector();
      const baseline = makeBaseline(100); // highBound = 140

      detector.evaluate(makeSample(100, 1000), baseline, 0.40); // prev=100
      detector.evaluate(makeSample(145, 2000), baseline, 0.40); // prev=100, curr=145 → normal
      const result = detector.evaluate(makeSample(150, 3000), baseline, 0.40); // prev=145, curr=150 → high anomaly

      expect(result).toEqual({ type: 'anomaly', direction: 'high', triggeredAt: 3000 });
    });
  });

  // Requirement 2.6 – reset
  describe('Requirement 2.6 – reset()', () => {
    test('reset clears prevSample so next evaluate is treated as first call', () => {
      const detector = new AnomalyDetector();
      const baseline = makeBaseline(100); // highBound = 140

      // Load a high sample as prev
      detector.evaluate(makeSample(145, 1000), baseline, 0.40);
      // Without reset this would trigger a high anomaly:
      detector.reset();
      // After reset, next call is first call again → normal
      const result = detector.evaluate(makeSample(150, 2000), baseline, 0.40);

      expect(result).toEqual({ type: 'normal' });
    });

    test('reset is idempotent (calling it multiple times is safe)', () => {
      const detector = new AnomalyDetector();
      expect(() => {
        detector.reset();
        detector.reset();
        detector.reset();
      }).not.toThrow();
    });

    test('detection resumes normally after reset', () => {
      const detector = new AnomalyDetector();
      const baseline = makeBaseline(100); // highBound = 140

      detector.evaluate(makeSample(145, 1000), baseline, 0.40); // prev stored
      detector.reset();
      detector.evaluate(makeSample(145, 2000), baseline, 0.40); // first call after reset
      const result = detector.evaluate(makeSample(150, 3000), baseline, 0.40); // prev=145, curr=150

      expect(result).toEqual({ type: 'anomaly', direction: 'high', triggeredAt: 3000 });
    });
  });
});

// ── createAnomalyDetector factory ─────────────────────────────────────────────

describe('createAnomalyDetector factory', () => {
  test('returns an AnomalyDetector instance', () => {
    expect(createAnomalyDetector()).toBeInstanceOf(AnomalyDetector);
  });

  test('factory-created detector behaves correctly end-to-end', () => {
    const detector = createAnomalyDetector();
    const baseline = makeBaseline(100); // highBound = 140

    detector.evaluate(makeSample(145, 1000), baseline, 0.40);
    const result = detector.evaluate(makeSample(150, 2000), baseline, 0.40);

    expect(result).toEqual({ type: 'anomaly', direction: 'high', triggeredAt: 2000 });
  });
});
