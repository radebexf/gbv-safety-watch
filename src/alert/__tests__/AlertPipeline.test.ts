/**
 * Unit and property-based tests for AlertPipeline
 *
 * Requirements covered: 5.1, 5.2, 7.4
 *
 * Feature: gbv-safety-watch, Property 10: Alert message contains all required
 * fields for every trigger type
 */

import * as fc from 'fast-check';
import { assembleAlertMessage, TRIGGER_LABELS, AlertPipeline } from '../AlertPipeline';
import type {
  AlertEvent,
  GpsCoordinatesWithMeta,
  EmergencyContact,
  UserProfile,
  TriggerType,
} from '../../types';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeUserProfile(name = 'Test User'): UserProfile {
  return {
    id: 'user-1',
    name,
    phoneNumber: '+27821234567',
    onboardingCompleted: true,
    onboardingStep: 4,
    settings: { distressThresholdPct: 0.40, falsePosWindowSeconds: 15 },
  };
}

function makeContact(): EmergencyContact {
  return { id: 'c-1', name: 'Jane Doe', phoneNumber: '+27831112222' };
}

function makeFreshCoords(lat = -26.2041, lng = 28.0473): GpsCoordinatesWithMeta {
  return {
    latitude: lat,
    longitude: lng,
    source: 'watch',
    acquiredAt: Date.now(),
    isFresh: true,
  };
}

function makeStaleCoords(
  lat = -26.2041,
  lng = 28.0473,
  acquiredAt = Date.now() - 10 * 60 * 1000,
): GpsCoordinatesWithMeta {
  return {
    latitude: lat,
    longitude: lng,
    source: 'phone',
    acquiredAt,
    isFresh: false,
  };
}

function makeAlertEvent(
  overrides: Partial<AlertEvent> = {},
): AlertEvent {
  return {
    triggerType: 'manual',
    triggeredAt: 1_700_000_000_000,
    coordinates: makeFreshCoords(),
    contacts: [makeContact()],
    userProfile: makeUserProfile(),
    ...overrides,
  };
}

// ── TRIGGER_LABELS ────────────────────────────────────────────────────────────

describe('TRIGGER_LABELS', () => {
  test('maps all four trigger types to their labels', () => {
    expect(TRIGGER_LABELS.heart_rate_anomaly).toBe('heart rate anomaly');
    expect(TRIGGER_LABELS.watch_removal).toBe('watch removal');
    expect(TRIGGER_LABELS.bluetooth_disconnection).toBe('bluetooth disconnection');
    expect(TRIGGER_LABELS.manual).toBe('manual trigger');
  });

  test('covers every TriggerType with no missing keys', () => {
    const expected: TriggerType[] = [
      'heart_rate_anomaly',
      'watch_removal',
      'bluetooth_disconnection',
      'manual',
    ];
    expected.forEach(t => expect(TRIGGER_LABELS).toHaveProperty(t));
    expect(Object.keys(TRIGGER_LABELS)).toHaveLength(4);
  });
});

// ── assembleAlertMessage – common structure ───────────────────────────────────

describe('assembleAlertMessage – common fields', () => {
  test('includes the user name in the header', () => {
    const event = makeAlertEvent({ userProfile: makeUserProfile('Maria Silva') });
    expect(assembleAlertMessage(event)).toContain('SAFETY ALERT – Maria Silva');
  });

  test('includes the UTC ISO-8601 timestamp', () => {
    const triggeredAt = 1_700_000_000_000;
    const event = makeAlertEvent({ triggeredAt });
    const expectedTs = new Date(triggeredAt).toISOString();
    expect(assembleAlertMessage(event)).toContain(`Time (UTC): ${expectedTs}`);
  });

  test('includes the footer line', () => {
    const event = makeAlertEvent();
    expect(assembleAlertMessage(event)).toContain(
      'This message was sent automatically by GBV Safety Watch.',
    );
  });

  test('starts with the safety alert emoji header', () => {
    const event = makeAlertEvent();
    expect(assembleAlertMessage(event)).toMatch(/^🚨 SAFETY ALERT/);
  });
});

// ── assembleAlertMessage – trigger labels ─────────────────────────────────────

describe('assembleAlertMessage – trigger labels (Requirement 7.4)', () => {
  const cases: Array<[TriggerType, string]> = [
    ['heart_rate_anomaly', 'heart rate anomaly'],
    ['watch_removal', 'watch removal'],
    ['bluetooth_disconnection', 'bluetooth disconnection'],
    ['manual', 'manual trigger'],
  ];

  test.each(cases)('trigger "%s" → label "%s"', (triggerType, label) => {
    const event = makeAlertEvent({ triggerType });
    expect(assembleAlertMessage(event)).toContain(`Trigger: ${label}`);
  });
});

// ── assembleAlertMessage – fresh GPS ─────────────────────────────────────────

describe('assembleAlertMessage – fresh GPS coordinates', () => {
  const lat = -26.2041;
  const lng = 28.0473;

  test('includes latitude and longitude', () => {
    const event = makeAlertEvent({ coordinates: makeFreshCoords(lat, lng) });
    const msg = assembleAlertMessage(event);
    expect(msg).toContain(`Location: ${lat}, ${lng}`);
  });

  test('includes a Google Maps link', () => {
    const event = makeAlertEvent({ coordinates: makeFreshCoords(lat, lng) });
    const msg = assembleAlertMessage(event);
    expect(msg).toContain(`Map: https://maps.google.com/?q=${lat},${lng}`);
  });

  test('does NOT include a stale-coordinates note', () => {
    const event = makeAlertEvent({ coordinates: makeFreshCoords(lat, lng) });
    expect(assembleAlertMessage(event)).not.toContain('Note: Location last recorded at');
  });

  test('does NOT include a no-location note', () => {
    const event = makeAlertEvent({ coordinates: makeFreshCoords(lat, lng) });
    expect(assembleAlertMessage(event)).not.toContain('No location data available');
  });
});

// ── assembleAlertMessage – stale GPS ─────────────────────────────────────────

describe('assembleAlertMessage – stale GPS coordinates', () => {
  const lat = -33.9249;
  const lng = 18.4241;
  const acquiredAt = 1_699_990_000_000;

  test('includes latitude and longitude', () => {
    const event = makeAlertEvent({ coordinates: makeStaleCoords(lat, lng, acquiredAt) });
    const msg = assembleAlertMessage(event);
    expect(msg).toContain(`Location: ${lat}, ${lng}`);
  });

  test('includes a Google Maps link', () => {
    const event = makeAlertEvent({ coordinates: makeStaleCoords(lat, lng, acquiredAt) });
    const msg = assembleAlertMessage(event);
    expect(msg).toContain(`Map: https://maps.google.com/?q=${lat},${lng}`);
  });

  test('includes stale note with UTC acquiredAt timestamp', () => {
    const event = makeAlertEvent({ coordinates: makeStaleCoords(lat, lng, acquiredAt) });
    const msg = assembleAlertMessage(event);
    const expectedNote = `Note: Location last recorded at ${new Date(acquiredAt).toISOString()}`;
    expect(msg).toContain(expectedNote);
  });

  test('does NOT include a no-location note', () => {
    const event = makeAlertEvent({ coordinates: makeStaleCoords(lat, lng, acquiredAt) });
    expect(assembleAlertMessage(event)).not.toContain('No location data available');
  });
});

// ── assembleAlertMessage – no GPS ────────────────────────────────────────────

describe('assembleAlertMessage – no GPS (null coordinates)', () => {
  test('includes the no-location note', () => {
    const event = makeAlertEvent({ coordinates: null });
    expect(assembleAlertMessage(event)).toContain('Note: No location data available');
  });

  test('does NOT include a Location: line', () => {
    const event = makeAlertEvent({ coordinates: null });
    expect(assembleAlertMessage(event)).not.toContain('Location:');
  });

  test('does NOT include a Map: line', () => {
    const event = makeAlertEvent({ coordinates: null });
    expect(assembleAlertMessage(event)).not.toContain('Map:');
  });

  test('does NOT include a stale-coordinates note', () => {
    const event = makeAlertEvent({ coordinates: null });
    expect(assembleAlertMessage(event)).not.toContain('Note: Location last recorded at');
  });
});

// ── Property 10: Alert message contains all required fields ───────────────────

/**
 * Validates: Requirements 5.2
 *
 * Feature: gbv-safety-watch, Property 10: Alert message contains all required
 * fields for every trigger type
 */
describe('Property 10 – alert message contains all required fields', () => {
  // Arbitraries
  const arbTriggerType = fc.constantFrom<TriggerType>(
    'heart_rate_anomaly',
    'watch_removal',
    'bluetooth_disconnection',
    'manual',
  );

  const arbUserName = fc.string({ minLength: 1, maxLength: 50 }).filter(
    s => s.trim().length > 0,
  );

  // Valid GPS lat/lng (floats within range, no NaN/Infinity)
  const arbLat = fc.float({ min: -90, max: 90, noNaN: true });
  const arbLng = fc.float({ min: -180, max: 180, noNaN: true });
  const arbAcquiredAt = fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 });
  const arbTriggeredAt = fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 });

  // GPS state: 0 = fresh, 1 = stale, 2 = null
  const arbGpsState = fc.integer({ min: 0, max: 2 });

  test(
    'user name always appears in the message',
    () => {
      fc.assert(
        fc.property(arbUserName, arbTriggerType, arbTriggeredAt, (name, triggerType, triggeredAt) => {
          const event = makeAlertEvent({
            triggerType,
            triggeredAt,
            userProfile: makeUserProfile(name),
          });
          const msg = assembleAlertMessage(event);
          return msg.includes(name);
        }),
        { numRuns: 200 },
      );
    },
  );

  test(
    'trigger label always appears in the message',
    () => {
      fc.assert(
        fc.property(arbTriggerType, arbTriggeredAt, (triggerType, triggeredAt) => {
          const event = makeAlertEvent({ triggerType, triggeredAt });
          const msg = assembleAlertMessage(event);
          return msg.includes(TRIGGER_LABELS[triggerType]);
        }),
        { numRuns: 200 },
      );
    },
  );

  test(
    'UTC timestamp always appears in the message',
    () => {
      fc.assert(
        fc.property(arbTriggerType, arbTriggeredAt, (triggerType, triggeredAt) => {
          const event = makeAlertEvent({ triggerType, triggeredAt });
          const msg = assembleAlertMessage(event);
          const expectedTs = new Date(triggeredAt).toISOString();
          return msg.includes(expectedTs);
        }),
        { numRuns: 200 },
      );
    },
  );

  test(
    'for fresh coords: Location + Map link present; stale note absent',
    () => {
      fc.assert(
        fc.property(
          arbTriggerType,
          arbTriggeredAt,
          arbLat,
          arbLng,
          (triggerType, triggeredAt, lat, lng) => {
            const event = makeAlertEvent({
              triggerType,
              triggeredAt,
              coordinates: {
                latitude: lat,
                longitude: lng,
                source: 'watch',
                acquiredAt: triggeredAt - 60_000, // 1 min before → fresh
                isFresh: true,
              },
            });
            const msg = assembleAlertMessage(event);
            return (
              msg.includes(`Location: ${lat}, ${lng}`) &&
              msg.includes(`Map: https://maps.google.com/?q=${lat},${lng}`) &&
              !msg.includes('Note: Location last recorded at') &&
              !msg.includes('No location data available')
            );
          },
        ),
        { numRuns: 200 },
      );
    },
  );

  test(
    'for stale coords: Location + Map link + stale note with acquiredAt timestamp',
    () => {
      fc.assert(
        fc.property(
          arbTriggerType,
          arbTriggeredAt,
          arbLat,
          arbLng,
          arbAcquiredAt,
          (triggerType, triggeredAt, lat, lng, acquiredAt) => {
            const event = makeAlertEvent({
              triggerType,
              triggeredAt,
              coordinates: {
                latitude: lat,
                longitude: lng,
                source: 'phone',
                acquiredAt,
                isFresh: false,
              },
            });
            const msg = assembleAlertMessage(event);
            const staleTs = new Date(acquiredAt).toISOString();
            return (
              msg.includes(`Location: ${lat}, ${lng}`) &&
              msg.includes(`Map: https://maps.google.com/?q=${lat},${lng}`) &&
              msg.includes(`Note: Location last recorded at ${staleTs}`) &&
              !msg.includes('No location data available')
            );
          },
        ),
        { numRuns: 200 },
      );
    },
  );

  test(
    'for null coords: no-location note present; Location and Map lines absent',
    () => {
      fc.assert(
        fc.property(arbTriggerType, arbTriggeredAt, (triggerType, triggeredAt) => {
          const event = makeAlertEvent({
            triggerType,
            triggeredAt,
            coordinates: null,
          });
          const msg = assembleAlertMessage(event);
          return (
            msg.includes('Note: No location data available') &&
            !msg.includes('Location:') &&
            !msg.includes('Map:')
          );
        }),
        { numRuns: 200 },
      );
    },
  );

  test(
    'across all GPS states: message always contains trigger label + UTC timestamp + user name',
    () => {
      fc.assert(
        fc.property(
          arbTriggerType,
          arbTriggeredAt,
          arbUserName,
          arbGpsState,
          arbLat,
          arbLng,
          arbAcquiredAt,
          (triggerType, triggeredAt, name, gpsState, lat, lng, acquiredAt) => {
            let coordinates: GpsCoordinatesWithMeta | null = null;
            if (gpsState === 0) {
              coordinates = { latitude: lat, longitude: lng, source: 'watch', acquiredAt, isFresh: true };
            } else if (gpsState === 1) {
              coordinates = { latitude: lat, longitude: lng, source: 'phone', acquiredAt, isFresh: false };
            }
            // gpsState === 2 leaves coordinates as null

            const event = makeAlertEvent({
              triggerType,
              triggeredAt,
              coordinates,
              userProfile: makeUserProfile(name),
            });
            const msg = assembleAlertMessage(event);
            const expectedTs = new Date(triggeredAt).toISOString();

            return (
              msg.includes(name) &&
              msg.includes(TRIGGER_LABELS[triggerType]) &&
              msg.includes(expectedTs)
            );
          },
        ),
        { numRuns: 500 },
      );
    },
  );
});

// ── AlertPipeline dispatch tests ──────────────────────────────────────────────

import type { EncryptedStorageInterface } from '../../storage/EncryptedStorage';

/** Creates a no-op in-memory EncryptedStorageInterface for testing. */
function makeStorage(
  overrides: Partial<EncryptedStorageInterface> = {},
): EncryptedStorageInterface {
  const store: Record<string, string> = {};
  return {
    get: async (key: string) => store[key] ?? null,
    set: async (key: string, value: string) => { store[key] = value; },
    remove: async (key: string) => { delete store[key]; },
    clear: async () => { Object.keys(store).forEach(k => delete store[k]); },
    ...overrides,
  };
}

/** Creates an AlertPipeline with a no-op sendSms and in-memory storage. */
function makePipeline(
  sendSms: (phone: string, msg: string) => Promise<void> = async () => undefined,
  storage = makeStorage(),
) {
  return new AlertPipeline({
    sendSms,
    storage,
    generateId: () => 'test-id',
    now: () => 1_700_000_000_000,
    delay: async () => undefined, // zero-delay for tests
  });
}

describe('AlertPipeline.dispatch – no-contacts guard', () => {
  test('throws NO_CONTACTS when event has zero contacts (Req 5.6, 2.10)', async () => {
    const pipeline = makePipeline();
    const event = makeAlertEvent({ contacts: [] });
    await expect(pipeline.dispatch(event)).rejects.toThrow('NO_CONTACTS');
  });
});

describe('AlertPipeline.dispatch – single contact success', () => {
  test('returns delivered status after one successful send (Req 5.1)', async () => {
    const sendSms = jest.fn().mockResolvedValue(undefined);
    const pipeline = makePipeline(sendSms);
    const contact = makeContact();
    const event = makeAlertEvent({ contacts: [contact] });

    const result = await pipeline.dispatch(event);

    expect(result.contactResults).toHaveLength(1);
    expect(result.contactResults[0].status).toBe('delivered');
    expect(result.contactResults[0].attempts).toBe(1);
    expect(result.contactResults[0].contact).toEqual(contact);
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendSms).toHaveBeenCalledWith(
      contact.phoneNumber,
      expect.stringContaining('SAFETY ALERT'),
    );
  });

  test('dispatch result contains dispatchedAt from injected clock', async () => {
    const pipeline = makePipeline();
    const event = makeAlertEvent({ contacts: [makeContact()] });
    const result = await pipeline.dispatch(event);
    expect(result.dispatchedAt).toBe(1_700_000_000_000);
  });
});

describe('AlertPipeline.dispatch – multiple contacts', () => {
  test('dispatches SMS to every contact (Req 5.1)', async () => {
    const contacts: EmergencyContact[] = [
      { id: 'c-1', name: 'Alice', phoneNumber: '+27811111111' },
      { id: 'c-2', name: 'Bob', phoneNumber: '+27822222222' },
      { id: 'c-3', name: 'Carol', phoneNumber: '+27833333333' },
    ];
    const sendSms = jest.fn().mockResolvedValue(undefined);
    const pipeline = makePipeline(sendSms);
    const event = makeAlertEvent({ contacts });

    const result = await pipeline.dispatch(event);

    expect(result.contactResults).toHaveLength(3);
    result.contactResults.forEach(r => expect(r.status).toBe('delivered'));
    expect(sendSms).toHaveBeenCalledTimes(3);
    contacts.forEach(c =>
      expect(sendSms).toHaveBeenCalledWith(c.phoneNumber, expect.any(String)),
    );
  });

  test('each contact result tracks its own contact reference', async () => {
    const contacts: EmergencyContact[] = [
      { id: 'c-1', name: 'Alice', phoneNumber: '+27811111111' },
      { id: 'c-2', name: 'Bob', phoneNumber: '+27822222222' },
    ];
    const pipeline = makePipeline(async () => undefined);
    const result = await pipeline.dispatch(makeAlertEvent({ contacts }));

    expect(result.contactResults[0].contact).toEqual(contacts[0]);
    expect(result.contactResults[1].contact).toEqual(contacts[1]);
  });
});

describe('AlertPipeline.dispatch – retry on failure', () => {
  test('retries after failure and succeeds on 3rd attempt (Req 5.3)', async () => {
    // Fail twice, succeed on 3rd attempt.
    const sendSms = jest
      .fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(undefined);

    const pipeline = makePipeline(sendSms);
    const event = makeAlertEvent({ contacts: [makeContact()] });

    const result = await pipeline.dispatch(event);

    expect(result.contactResults[0].status).toBe('delivered');
    expect(result.contactResults[0].attempts).toBe(3);
    expect(sendSms).toHaveBeenCalledTimes(3);
  });

  test('retries after single failure and succeeds on 2nd attempt', async () => {
    const sendSms = jest
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(undefined);

    const pipeline = makePipeline(sendSms);
    const result = await pipeline.dispatch(makeAlertEvent({ contacts: [makeContact()] }));

    expect(result.contactResults[0].status).toBe('delivered');
    expect(result.contactResults[0].attempts).toBe(2);
  });
});

describe('AlertPipeline.dispatch – all retries exhausted → unreachable', () => {
  test('marks contact as unreachable after 3 failed attempts (Req 5.3)', async () => {
    const sendSms = jest.fn().mockRejectedValue(new Error('unreachable'));

    const pipeline = makePipeline(sendSms);
    const event = makeAlertEvent({ contacts: [makeContact()] });

    const result = await pipeline.dispatch(event);

    expect(result.contactResults[0].status).toBe('unreachable');
    expect(result.contactResults[0].attempts).toBe(3);
    expect(sendSms).toHaveBeenCalledTimes(3);
  });

  test('one unreachable contact does not prevent delivery to others', async () => {
    const goodContact: EmergencyContact = { id: 'c-good', name: 'Good', phoneNumber: '+27811111111' };
    const badContact: EmergencyContact = { id: 'c-bad', name: 'Bad', phoneNumber: '+27899999999' };

    const sendSms = jest.fn().mockImplementation((phone: string) => {
      if (phone === badContact.phoneNumber) {
        return Promise.reject(new Error('fail'));
      }
      return Promise.resolve();
    });

    const pipeline = makePipeline(sendSms);
    const result = await pipeline.dispatch(
      makeAlertEvent({ contacts: [goodContact, badContact] }),
    );

    const goodResult = result.contactResults.find(r => r.contact.id === 'c-good')!;
    const badResult = result.contactResults.find(r => r.contact.id === 'c-bad')!;

    expect(goodResult.status).toBe('delivered');
    expect(badResult.status).toBe('unreachable');
  });
});

describe('AlertPipeline.dispatch – storage persistence', () => {
  test('persists an AlertLogEntry to storage after dispatch (Req 5.5)', async () => {
    const storage = makeStorage();
    const pipeline = makePipeline(async () => undefined, storage);
    const event = makeAlertEvent();

    await pipeline.dispatch(event);

    const raw = await storage.get('alert_log');
    expect(raw).not.toBeNull();
    const log = JSON.parse(raw!);
    expect(Array.isArray(log)).toBe(true);
    expect(log).toHaveLength(1);
    expect(log[0].triggerType).toBe(event.triggerType);
    expect(log[0].dispatchedAt).toBe(1_700_000_000_000);
  });

  test('appends to an existing log (Req 5.5)', async () => {
    const storage = makeStorage();
    const pipeline = makePipeline(async () => undefined, storage);

    await pipeline.dispatch(makeAlertEvent({ triggerType: 'manual' }));
    await pipeline.dispatch(makeAlertEvent({ triggerType: 'watch_removal' }));

    const raw = await storage.get('alert_log');
    const log = JSON.parse(raw!);
    expect(log).toHaveLength(2);
    expect(log[0].triggerType).toBe('manual');
    expect(log[1].triggerType).toBe('watch_removal');
  });

  test('log entry includes per-contact delivery results', async () => {
    const storage = makeStorage();
    const contact = makeContact();
    const pipeline = makePipeline(async () => undefined, storage);

    await pipeline.dispatch(makeAlertEvent({ contacts: [contact] }));

    const log = JSON.parse((await storage.get('alert_log'))!);
    expect(log[0].contactResults).toHaveLength(1);
    expect(log[0].contactResults[0].status).toBe('delivered');
    expect(log[0].contactResults[0].contact).toMatchObject({ id: contact.id });
  });

  test('storage failure does NOT block dispatch result (Req 5.5 error handling)', async () => {
    const faultyStorage = makeStorage({
      set: async () => { throw new Error('disk full'); },
    });
    const pipeline = makePipeline(async () => undefined, faultyStorage);
    const event = makeAlertEvent();

    // Should resolve successfully despite the storage error.
    const result = await pipeline.dispatch(event);
    expect(result.contactResults[0].status).toBe('delivered');
  });
});
