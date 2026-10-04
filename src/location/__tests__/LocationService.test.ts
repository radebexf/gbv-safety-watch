/**
 * LocationService – unit tests
 *
 * All tests use injected fakes for GPS sources, clock, and timers so no
 * native modules are required.
 *
 * Requirements covered: 3.2, 3.3, 3.5
 */

import { LocationService, createLocationService } from '../LocationService';
import type { GpsCoordinates } from '../../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const WATCH_COORDS: GpsCoordinates = { latitude: -26.2041, longitude: 28.0473 };
const PHONE_COORDS: GpsCoordinates = { latitude: -33.9249, longitude: 18.4241 };

/** Build a LocationService with controllable fakes. */
function makeService(opts: {
  watchResult?: GpsCoordinates | null;
  phoneResult?: GpsCoordinates | null;
  nowMs?: number;
}) {
  let nowMs = opts.nowMs ?? 1_000_000;
  const intervals: Map<number, () => void> = new Map();
  let nextId = 1;

  const requestWatchGps = jest.fn<Promise<GpsCoordinates | null>, []>(
    async () => (opts.watchResult !== undefined ? opts.watchResult : null),
  );
  const requestPhoneGps = jest.fn<Promise<GpsCoordinates | null>, []>(
    async () => (opts.phoneResult !== undefined ? opts.phoneResult : null),
  );

  const fakeClearInterval = jest.fn((id: ReturnType<typeof setInterval>) => {
    intervals.delete(id as unknown as number);
  });

  const fakeSetInterval = jest.fn(
    (fn: () => void, _ms: number): ReturnType<typeof setInterval> => {
      const id = nextId++ as unknown as ReturnType<typeof setInterval>;
      intervals.set(id as unknown as number, fn);
      return id;
    },
  );

  const service = new LocationService({
    requestWatchGps,
    requestPhoneGps,
    now: () => nowMs,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
  });

  /** Advance the fake clock and fire all pending interval callbacks once. */
  function tick(deltaMs = 30_000) {
    nowMs += deltaMs;
    intervals.forEach(fn => fn());
  }

  return { service, requestWatchGps, requestPhoneGps, fakeSetInterval, fakeClearInterval, tick, getNow: () => nowMs, setNow: (t: number) => { nowMs = t; } };
}

// ── Initial state ─────────────────────────────────────────────────────────────

describe('initial state', () => {
  it('cachedCoordinates is null before any poll', () => {
    const { service } = makeService({});
    expect(service.cachedCoordinates).toBeNull();
  });
});

// ── start() / stop() ──────────────────────────────────────────────────────────

describe('start()', () => {
  it('registers a polling interval', () => {
    const { service, fakeSetInterval } = makeService({ watchResult: WATCH_COORDS });
    service.start();
    expect(fakeSetInterval).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('is idempotent – calling start() twice registers only one interval', async () => {
    const { service, fakeSetInterval } = makeService({ watchResult: WATCH_COORDS });
    service.start();
    service.start();
    expect(fakeSetInterval).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('runs an immediate poll on start so cache is populated without waiting', async () => {
    const { service } = makeService({ watchResult: WATCH_COORDS });
    service.start();
    // Allow the micro-task queue to flush
    await Promise.resolve();
    expect(service.cachedCoordinates).not.toBeNull();
    service.stop();
  });
});

describe('stop()', () => {
  it('clears the registered interval', () => {
    const { service, fakeClearInterval } = makeService({ watchResult: WATCH_COORDS });
    service.start();
    service.stop();
    expect(fakeClearInterval).toHaveBeenCalledTimes(1);
  });

  it('is idempotent – calling stop() when not started does nothing', () => {
    const { service, fakeClearInterval } = makeService({});
    service.stop();
    expect(fakeClearInterval).not.toHaveBeenCalled();
  });
});

// ── Source priority (Requirements 3.2 & 3.3) ─────────────────────────────────

describe('source priority', () => {
  it('uses watch GPS when available (Req 3.2)', async () => {
    const { service } = makeService({
      watchResult: WATCH_COORDS,
      phoneResult: PHONE_COORDS,
    });
    const coords = await service.getCurrentCoordinates();
    expect(coords).not.toBeNull();
    expect(coords!.source).toBe('watch');
    expect(coords!.latitude).toBe(WATCH_COORDS.latitude);
    expect(coords!.longitude).toBe(WATCH_COORDS.longitude);
  });

  it('does NOT call phone GPS when watch GPS is available (Req 3.2)', async () => {
    const { service, requestPhoneGps } = makeService({
      watchResult: WATCH_COORDS,
      phoneResult: PHONE_COORDS,
    });
    await service.getCurrentCoordinates();
    expect(requestPhoneGps).not.toHaveBeenCalled();
  });

  it('falls back to phone GPS when watch GPS returns null (Req 3.3)', async () => {
    const { service } = makeService({
      watchResult: null,
      phoneResult: PHONE_COORDS,
    });
    const coords = await service.getCurrentCoordinates();
    expect(coords).not.toBeNull();
    expect(coords!.source).toBe('phone');
    expect(coords!.latitude).toBe(PHONE_COORDS.latitude);
  });

  it('calls phone GPS only when watch GPS is unavailable (Req 3.3)', async () => {
    const { service, requestWatchGps, requestPhoneGps } = makeService({
      watchResult: null,
      phoneResult: PHONE_COORDS,
    });
    await service.getCurrentCoordinates();
    expect(requestWatchGps).toHaveBeenCalledTimes(1);
    expect(requestPhoneGps).toHaveBeenCalledTimes(1);
  });
});

// ── isFresh computation ───────────────────────────────────────────────────────

describe('isFresh', () => {
  const FRESHNESS_WINDOW_MS = 300_000;

  it('marks coordinates as fresh when acquired within 5 minutes', async () => {
    const nowMs = 1_000_000;
    const { service } = makeService({ watchResult: WATCH_COORDS, nowMs });
    const coords = await service.getCurrentCoordinates();
    expect(coords!.isFresh).toBe(true);
  });

  it('marks coordinates as not fresh when acquired more than 5 minutes ago', async () => {
    const nowAtAcquire = 1_000_000;
    const { service, setNow } = makeService({ watchResult: WATCH_COORDS, nowMs: nowAtAcquire });

    // Acquire coordinates
    await service.getCurrentCoordinates();

    // Advance clock past freshness window and re-fetch
    setNow(nowAtAcquire + FRESHNESS_WINDOW_MS + 1);
    const watchFail = makeService({
      watchResult: null,
      phoneResult: null,
      nowMs: nowAtAcquire + FRESHNESS_WINDOW_MS + 1,
    });
    // Manually set cache on the stale service and recompute
    watchFail.service.cachedCoordinates = {
      latitude: WATCH_COORDS.latitude,
      longitude: WATCH_COORDS.longitude,
      source: 'watch',
      acquiredAt: nowAtAcquire,
      isFresh: true, // will be recomputed
    };
    const staleCoords = await watchFail.service.getCurrentCoordinates();
    expect(staleCoords!.isFresh).toBe(false);
  });

  it('boundary: coordinate acquired exactly at freshness edge is NOT fresh', async () => {
    // isFresh = acquiredAt > now - 300_000  (strict greater-than)
    const base = 2_000_000;
    const acquiredAt = base - FRESHNESS_WINDOW_MS; // exactly 5 min ago → not fresh
    const { service } = makeService({ watchResult: null, phoneResult: null, nowMs: base });
    service.cachedCoordinates = {
      latitude: 0,
      longitude: 0,
      source: 'watch',
      acquiredAt,
      isFresh: true, // stale value, will be recomputed
    };
    const coords = await service.getCurrentCoordinates();
    expect(coords!.isFresh).toBe(false);
  });

  it('boundary: coordinate acquired 1 ms inside freshness window is fresh', async () => {
    const base = 2_000_000;
    const acquiredAt = base - FRESHNESS_WINDOW_MS + 1; // 1 ms inside window
    const { service } = makeService({ watchResult: null, phoneResult: null, nowMs: base });
    service.cachedCoordinates = {
      latitude: 0,
      longitude: 0,
      source: 'watch',
      acquiredAt,
      isFresh: false, // stale value, will be recomputed
    };
    const coords = await service.getCurrentCoordinates();
    expect(coords!.isFresh).toBe(true);
  });
});

// ── getCurrentCoordinates() edge cases ────────────────────────────────────────

describe('getCurrentCoordinates()', () => {
  it('returns null when both sources fail and no cache exists', async () => {
    const { service } = makeService({ watchResult: null, phoneResult: null });
    const coords = await service.getCurrentCoordinates();
    expect(coords).toBeNull();
  });

  it('returns recomputed cached coordinates when both sources fail', async () => {
    const base = 3_000_000;
    const { service } = makeService({ watchResult: null, phoneResult: null, nowMs: base });

    // Seed the cache manually
    service.cachedCoordinates = {
      latitude: 10,
      longitude: 20,
      source: 'phone',
      acquiredAt: base - 60_000, // 1 min ago — still fresh
      isFresh: false, // incorrect — should be recalculated
    };

    const coords = await service.getCurrentCoordinates();
    expect(coords).not.toBeNull();
    expect(coords!.latitude).toBe(10);
    expect(coords!.isFresh).toBe(true); // recomputed correctly
  });

  it('updates cachedCoordinates after a successful poll', async () => {
    const { service } = makeService({ watchResult: WATCH_COORDS });
    expect(service.cachedCoordinates).toBeNull();
    await service.getCurrentCoordinates();
    expect(service.cachedCoordinates).not.toBeNull();
    expect(service.cachedCoordinates!.source).toBe('watch');
  });

  it('records acquiredAt as the current clock value at poll time', async () => {
    const nowMs = 9_999_000;
    const { service } = makeService({ watchResult: WATCH_COORDS, nowMs });
    const coords = await service.getCurrentCoordinates();
    expect(coords!.acquiredAt).toBe(nowMs);
  });
});

// ── Polling interval (Requirement 3.5) ───────────────────────────────────────

describe('polling interval', () => {
  it('defaults to 30 000 ms', () => {
    const { service, fakeSetInterval } = makeService({ watchResult: WATCH_COORDS });
    service.start();
    expect(fakeSetInterval).toHaveBeenCalledWith(expect.any(Function), 30_000);
    service.stop();
  });

  it('honours a custom pollIntervalMs', () => {
    let nowMs = 0;
    const fakeSetInterval = jest.fn(
      (_fn: () => void, _ms: number): ReturnType<typeof setInterval> =>
        1 as unknown as ReturnType<typeof setInterval>,
    );
    const fakeClearInterval = jest.fn();
    const svc = new LocationService({
      requestWatchGps: async () => WATCH_COORDS,
      requestPhoneGps: async () => null,
      pollIntervalMs: 10_000,
      now: () => nowMs,
      setInterval: fakeSetInterval,
      clearInterval: fakeClearInterval,
    });
    svc.start();
    expect(fakeSetInterval).toHaveBeenCalledWith(expect.any(Function), 10_000);
    svc.stop();
  });

  it('updates cachedCoordinates on each interval tick', async () => {
    const watchCoords1: GpsCoordinates = { latitude: 1, longitude: 1 };
    const watchCoords2: GpsCoordinates = { latitude: 2, longitude: 2 };
    let callCount = 0;

    const intervals: Map<number, () => void> = new Map();
    let nextId = 1;
    let nowMs = 1_000_000;

    const requestWatchGps = jest.fn<Promise<GpsCoordinates | null>, []>(async () => {
      callCount++;
      return callCount === 1 ? watchCoords1 : watchCoords2;
    });

    const fakeSetInterval = jest.fn((fn: () => void, _ms: number): ReturnType<typeof setInterval> => {
      const id = nextId++ as unknown as ReturnType<typeof setInterval>;
      intervals.set(id as unknown as number, fn);
      return id;
    });

    const svc = new LocationService({
      requestWatchGps,
      requestPhoneGps: async () => null,
      now: () => nowMs,
      setInterval: fakeSetInterval,
      clearInterval: jest.fn(),
    });

    svc.start();
    await Promise.resolve(); // flush immediate poll (tick 1 → watchCoords1)

    expect(svc.cachedCoordinates?.latitude).toBe(1);

    // Simulate one interval tick
    nowMs += 30_000;
    intervals.forEach(fn => fn());
    await Promise.resolve(); // flush async poll

    expect(svc.cachedCoordinates?.latitude).toBe(2);
    svc.stop();
  });
});

// ── Error resilience ──────────────────────────────────────────────────────────

describe('error resilience', () => {
  it('treats a throwing requestWatchGps as unavailable and falls back to phone', async () => {
    const svc = new LocationService({
      requestWatchGps: async () => { throw new Error('BLE error'); },
      requestPhoneGps: async () => PHONE_COORDS,
      now: () => 0,
      setInterval: jest.fn() as unknown as LocationService['_setInterval' & string],
      clearInterval: jest.fn(),
    });
    const coords = await svc.getCurrentCoordinates();
    expect(coords).not.toBeNull();
    expect(coords!.source).toBe('phone');
  });

  it('treats a throwing requestPhoneGps as unavailable (returns null / cached)', async () => {
    const svc = new LocationService({
      requestWatchGps: async () => null,
      requestPhoneGps: async () => { throw new Error('location error'); },
      now: () => 0,
      setInterval: jest.fn() as unknown as LocationService['_setInterval' & string],
      clearInterval: jest.fn(),
    });
    const coords = await svc.getCurrentCoordinates();
    expect(coords).toBeNull();
  });
});

// ── Factory function ──────────────────────────────────────────────────────────

describe('createLocationService()', () => {
  it('returns a LocationService instance', () => {
    const svc = createLocationService({
      requestWatchGps: async () => null,
      requestPhoneGps: async () => null,
    });
    expect(svc).toBeInstanceOf(LocationService);
    expect(svc.cachedCoordinates).toBeNull();
  });
});
