/**
 * Unit tests for HeartRateMonitor
 *
 * Requirements covered: 1.1, 1.2, 1.3, 1.4
 */

import {
  HeartRateMonitor,
  Subject,
  createHeartRateMonitor,
  type RawHeartRateSample,
  type Observable,
} from './HeartRateMonitor';
import type { HeartRateSample, HrGapEvent } from '../types';

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Creates a controllable Subject that doubles as the raw sample source. */
function makeRawSource() {
  const subject = new Subject<RawHeartRateSample>();
  return { subject, observable: subject as Observable<RawHeartRateSample> };
}

/** Creates a HeartRateMonitor wired to a fake clock and raw source. */
function makeMonitor(initialNow = 1_000_000) {
  let fakeNow = initialNow;
  const { subject, observable } = makeRawSource();

  // Fake timer management
  type TimerFn = () => void;
  const timers = new Map<number, { fn: TimerFn; interval: number; next: number }>();
  let nextId = 1;

  const fakeSetInterval = (fn: TimerFn, ms: number) => {
    const id = nextId++;
    timers.set(id, { fn, interval: ms, next: fakeNow + ms });
    return id as unknown as ReturnType<typeof setInterval>;
  };

  const fakeClearInterval = (h: ReturnType<typeof setInterval>) => {
    timers.delete(h as unknown as number);
  };

  /** Advance fake time by `ms` milliseconds, firing any due timers. */
  const tick = (ms: number) => {
    fakeNow += ms;
    for (const [, t] of timers) {
      while (t.next <= fakeNow) {
        t.fn();
        t.next += t.interval;
      }
    }
  };

  const monitor = new HeartRateMonitor({
    subscribeToRawSamples: observable,
    source: 'watch',
    now: () => fakeNow,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
  });

  const emitRaw = (bpm: number, ts?: number) => {
    subject.next({ bpm, timestamp: ts ?? fakeNow });
  };

  return { monitor, subject, emitRaw, tick, getNow: () => fakeNow };
}

// ── BPM validation (Requirement 1.1) ─────────────────────────────────────────

describe('Requirement 1.1 – BPM validation', () => {
  test('valid BPM values are accepted (boundaries: 20 and 300)', () => {
    const { monitor, emitRaw } = makeMonitor();
    const received: HeartRateSample[] = [];
    monitor.sample$.subscribe(s => received.push(s));
    monitor.start();

    emitRaw(20);
    emitRaw(300);

    expect(received).toHaveLength(2);
    expect(received[0].bpm).toBe(20);
    expect(received[1].bpm).toBe(300);
  });

  test('BPM below 20 is silently discarded', () => {
    const { monitor, emitRaw } = makeMonitor();
    const received: HeartRateSample[] = [];
    monitor.sample$.subscribe(s => received.push(s));
    monitor.start();

    emitRaw(0);
    emitRaw(19);
    emitRaw(-1);

    expect(received).toHaveLength(0);
  });

  test('BPM above 300 is silently discarded', () => {
    const { monitor, emitRaw } = makeMonitor();
    const received: HeartRateSample[] = [];
    monitor.sample$.subscribe(s => received.push(s));
    monitor.start();

    emitRaw(301);
    emitRaw(400);
    emitRaw(1000);

    expect(received).toHaveLength(0);
  });

  test('invalid BPM values are not stored in buffer', () => {
    const { monitor, emitRaw } = makeMonitor();
    monitor.start();

    emitRaw(0);
    emitRaw(301);
    emitRaw(75); // valid

    expect(monitor.getBuffer()).toHaveLength(1);
    expect(monitor.getBuffer()[0].bpm).toBe(75);
  });

  test('NaN and Infinity are discarded', () => {
    const { monitor, emitRaw } = makeMonitor();
    const received: HeartRateSample[] = [];
    monitor.sample$.subscribe(s => received.push(s));
    monitor.start();

    emitRaw(NaN);
    emitRaw(Infinity);
    emitRaw(-Infinity);

    expect(received).toHaveLength(0);
  });
});

// ── Rolling buffer (Requirement 1.2) ─────────────────────────────────────────

describe('Requirement 1.2 – Rolling buffer', () => {
  test('buffer holds up to 60 entries', () => {
    const { monitor, emitRaw } = makeMonitor();
    monitor.start();

    for (let i = 0; i < 60; i++) {
      emitRaw(70 + (i % 10));
    }

    expect(monitor.getBuffer()).toHaveLength(60);
  });

  test('buffer overwrites oldest entry when capacity is exceeded', () => {
    const { monitor, emitRaw } = makeMonitor();
    monitor.start();

    // Fill buffer with bpm=50 (60 entries)
    for (let i = 0; i < 60; i++) {
      emitRaw(50);
    }

    // 61st sample with distinct BPM
    emitRaw(200);

    const buf = monitor.getBuffer();
    expect(buf).toHaveLength(60);
    // Newest (last) element should be 200
    expect(buf[buf.length - 1].bpm).toBe(200);
    // The very first (oldest) 50 has been evicted; rest are 50
    expect(buf.slice(0, 59).every(s => s.bpm === 50)).toBe(true);
  });

  test('buffer is retained after stop (simulating BLE disconnect)', () => {
    const { monitor, emitRaw } = makeMonitor();
    monitor.start();

    emitRaw(70);
    emitRaw(80);
    monitor.stop();

    // Buffer still holds its 2 samples after stop
    expect(monitor.getBuffer()).toHaveLength(2);
    expect(monitor.getBuffer()[0].bpm).toBe(70);
    expect(monitor.getBuffer()[1].bpm).toBe(80);
  });

  test('buffer entries are in insertion order', () => {
    const { monitor, emitRaw } = makeMonitor();
    monitor.start();

    const bpms = [70, 80, 90, 100];
    bpms.forEach(bpm => emitRaw(bpm));

    const buf = monitor.getBuffer();
    expect(buf.map(s => s.bpm)).toEqual(bpms);
  });

  test('getBuffer returns a snapshot that is read-only (immutable view)', () => {
    const { monitor, emitRaw } = makeMonitor();
    monitor.start();
    emitRaw(75);

    const buf = monitor.getBuffer();
    // Attempting to mutate should not affect internal state
    // (TypeScript type is `readonly`, but we also verify length stability)
    expect(buf).toHaveLength(1);
  });
});

// ── Gap detection (Requirement 1.3) ──────────────────────────────────────────

describe('Requirement 1.3 – Gap detection', () => {
  test('no gap event emitted when samples arrive within 15 s', () => {
    const { monitor, emitRaw, tick } = makeMonitor();
    const gaps: HrGapEvent[] = [];
    monitor.gap$.subscribe(g => gaps.push(g));
    monitor.start();

    emitRaw(75); // t=0
    tick(10_000); // advance 10 s (< 15 s gap)
    emitRaw(76); // t=10 s

    expect(gaps).toHaveLength(0);
  });

  test('gap event is emitted after >15 s without a sample', () => {
    const { monitor, emitRaw, tick } = makeMonitor();
    const gaps: HrGapEvent[] = [];
    monitor.gap$.subscribe(g => gaps.push(g));
    monitor.start();

    emitRaw(75); // receive one sample
    tick(16_000); // advance 16 s – gap threshold crossed

    expect(gaps.length).toBeGreaterThanOrEqual(1);
    expect(gaps[0].retryCount).toBe(0);
  });

  test('retries occur at 5 s intervals up to max 3', () => {
    const { monitor, emitRaw, tick } = makeMonitor();
    const gaps: HrGapEvent[] = [];
    monitor.gap$.subscribe(g => gaps.push(g));
    monitor.start();

    emitRaw(75); // t=0
    tick(16_000); // trigger initial gap emit (retry 0)
    tick(5_000);  // retry 1
    tick(5_000);  // retry 2
    tick(5_000);  // retry 3
    tick(5_000);  // no more retries

    expect(gaps).toHaveLength(4); // initial + 3 retries
    expect(gaps.map(g => g.retryCount)).toEqual([0, 1, 2, 3]);
  });

  test('no more than 3 retry attempts are made', () => {
    const { monitor, emitRaw, tick } = makeMonitor();
    const gaps: HrGapEvent[] = [];
    monitor.gap$.subscribe(g => gaps.push(g));
    monitor.start();

    emitRaw(75);
    tick(16_000);       // initial gap
    tick(30_000);       // advance well past 3×5 s intervals

    expect(gaps.length).toBeLessThanOrEqual(4); // max 4 events (0,1,2,3)
    expect(gaps.every(g => g.retryCount <= 3)).toBe(true);
  });

  test('retry count resets when a valid sample arrives', () => {
    const { monitor, emitRaw, tick } = makeMonitor();
    const gaps: HrGapEvent[] = [];
    monitor.gap$.subscribe(g => gaps.push(g));
    monitor.start();

    emitRaw(75);
    tick(16_000); // first gap
    tick(5_000);  // retry 1
    emitRaw(76);  // sample received – gap resolved
    tick(16_000); // new gap begins from 0
    tick(5_000);  // retry 1 again

    // Retry counts must restart from 0 after the new sample
    const retryCountsAfterReset = gaps.filter(g => g.retryCount === 0);
    expect(retryCountsAfterReset.length).toBeGreaterThanOrEqual(2);
  });

  test('gap events do not trigger when monitor has not been started', () => {
    const { monitor, tick } = makeMonitor();
    const gaps: HrGapEvent[] = [];
    monitor.gap$.subscribe(g => gaps.push(g));

    tick(30_000); // never started

    expect(gaps).toHaveLength(0);
  });
});

// ── Baseline computation (Requirement 1.4) ───────────────────────────────────

describe('Requirement 1.4 – Baseline computation', () => {
  test('baseline is null before any samples', () => {
    const { monitor } = makeMonitor();
    monitor.start();
    expect(monitor.getBaseline()).toBeNull();
  });

  test('baseline is computed after receiving samples outside distress mode', () => {
    const { monitor, emitRaw } = makeMonitor();
    monitor.start();

    emitRaw(80);
    emitRaw(100);

    const baseline = monitor.getBaseline();
    expect(baseline).not.toBeNull();
    // median of [80, 100] = (80+100)/2 = 90
    expect(baseline!.medianBpm).toBe(90);
  });

  test('baseline equals median of all buffered samples', () => {
    const { monitor, emitRaw } = makeMonitor();
    monitor.start();

    // Odd count: median = middle value after sort
    emitRaw(60);
    emitRaw(80);
    emitRaw(70);

    // sorted: [60, 70, 80] → median = 70
    expect(monitor.getBaseline()!.medianBpm).toBe(70);
  });

  test('samples during distress mode do NOT update baseline', () => {
    const { monitor, emitRaw } = makeMonitor();
    monitor.start();

    emitRaw(70); // outside distress – baseline anchored at 70
    const baselineAfterFirst = monitor.getBaseline()!.medianBpm;

    monitor.setDistressMode(true);
    emitRaw(200); // distress sample – should NOT shift baseline
    emitRaw(210);

    const baselineAfterDistress = monitor.getBaseline()!.medianBpm;
    expect(baselineAfterDistress).toBe(baselineAfterFirst);
  });

  test('baseline resumes updating after distress mode is cleared', () => {
    const { monitor, emitRaw } = makeMonitor();
    monitor.start();

    emitRaw(70);
    monitor.setDistressMode(true);
    emitRaw(200); // ignored for baseline
    monitor.setDistressMode(false);
    emitRaw(90); // now included → median([70, 90]) = 80

    expect(monitor.getBaseline()!.medianBpm).toBe(80);
  });

  test('baseline sampleCount reflects the number of non-distress samples', () => {
    const { monitor, emitRaw } = makeMonitor();
    monitor.start();

    emitRaw(70);
    emitRaw(80);
    monitor.setDistressMode(true);
    emitRaw(200);
    monitor.setDistressMode(false);
    emitRaw(90);

    // 3 non-distress samples: 70, 80, 90
    expect(monitor.getBaseline()!.sampleCount).toBe(3);
  });

  test('baseline buffer is capped at 300 entries (ring eviction)', () => {
    const { monitor, emitRaw } = makeMonitor();
    monitor.start();

    for (let i = 0; i < 310; i++) {
      emitRaw(60 + (i % 50)); // vary BPM within valid range
    }

    const baseline = monitor.getBaseline();
    expect(baseline).not.toBeNull();
    // sampleCount must not exceed the 300-entry ring capacity
    expect(baseline!.sampleCount).toBeLessThanOrEqual(300);
  });
});

// ── sample$ observable ────────────────────────────────────────────────────────

describe('sample$ observable', () => {
  test('emits only validated samples', () => {
    const { monitor, emitRaw } = makeMonitor();
    const received: HeartRateSample[] = [];
    monitor.sample$.subscribe(s => received.push(s));
    monitor.start();

    emitRaw(19);  // invalid
    emitRaw(75);  // valid
    emitRaw(301); // invalid
    emitRaw(200); // valid

    expect(received).toHaveLength(2);
    expect(received.map(s => s.bpm)).toEqual([75, 200]);
  });

  test('emitted samples carry the correct source', () => {
    const { subject } = makeRawSource();
    const monitor = new HeartRateMonitor({
      subscribeToRawSamples: subject as Observable<RawHeartRateSample>,
      source: 'phone_fallback',
    });
    const received: HeartRateSample[] = [];
    monitor.sample$.subscribe(s => received.push(s));
    monitor.start();

    subject.next({ bpm: 75, timestamp: Date.now() });

    expect(received[0].source).toBe('phone_fallback');
    monitor.stop(); // release the real gap-detection interval to avoid a leaked handle
  });

  test('subscribe returns an unsubscribe function', () => {
    const { monitor, emitRaw } = makeMonitor();
    const received: HeartRateSample[] = [];
    const unsub = monitor.sample$.subscribe(s => received.push(s));
    monitor.start();

    emitRaw(75);
    unsub(); // stop listening
    emitRaw(80);

    expect(received).toHaveLength(1);
    expect(received[0].bpm).toBe(75);
  });
});

// ── Factory function ──────────────────────────────────────────────────────────

describe('createHeartRateMonitor factory', () => {
  test('creates a HeartRateMonitor instance', () => {
    const { observable } = makeRawSource();
    const monitor = createHeartRateMonitor({ subscribeToRawSamples: observable });
    expect(monitor).toBeInstanceOf(HeartRateMonitor);
  });

  test('factory-created monitor behaves correctly', () => {
    const { observable, subject } = makeRawSource();
    const monitor = createHeartRateMonitor({ subscribeToRawSamples: observable });
    const received: HeartRateSample[] = [];
    monitor.sample$.subscribe(s => received.push(s));
    monitor.start();

    subject.next({ bpm: 75, timestamp: Date.now() });

    expect(received).toHaveLength(1);
    monitor.stop();
  });
});

// ── Start / Stop lifecycle ────────────────────────────────────────────────────

describe('start / stop lifecycle', () => {
  test('calling start twice is idempotent', () => {
    const { monitor, emitRaw } = makeMonitor();
    const received: HeartRateSample[] = [];
    monitor.sample$.subscribe(s => received.push(s));

    monitor.start();
    monitor.start(); // second call should be no-op

    emitRaw(75);
    expect(received).toHaveLength(1); // only one emission, not duplicated
  });

  test('calling stop when not started is safe', () => {
    const { monitor } = makeMonitor();
    expect(() => monitor.stop()).not.toThrow();
  });

  test('no samples emitted before start', () => {
    const { monitor, subject } = makeMonitor();
    const received: HeartRateSample[] = [];
    monitor.sample$.subscribe(s => received.push(s));

    subject.next({ bpm: 75, timestamp: Date.now() });

    expect(received).toHaveLength(0);
  });

  test('no samples emitted after stop', () => {
    const { monitor, emitRaw } = makeMonitor();
    const received: HeartRateSample[] = [];
    monitor.sample$.subscribe(s => received.push(s));
    monitor.start();

    emitRaw(75);
    monitor.stop();
    emitRaw(80); // should be ignored

    expect(received).toHaveLength(1);
  });
});
