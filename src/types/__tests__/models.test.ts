/**
 * Smoke tests for the scaffolded type definitions.
 *
 * These tests verify that the type models can be imported and instantiated
 * with valid values — confirming the TypeScript scaffold compiles correctly.
 */

import type {
  HeartRateSample,
  Baseline,
  GpsCoordinates,
  GpsCoordinatesWithMeta,
  EmergencyContact,
  NewContact,
  ContactError,
  UserProfile,
  UserSettings,
  AlertEvent,
  AlertLogEntry,
  TriggerType,
  AnomalyResult,
  ConnectionState,
  MonitoringSession,
  HrGapEvent,
  AlertDispatchResult,
  ContactDeliveryResult,
} from '../index';

describe('Type model scaffold smoke tests', () => {
  it('HeartRateSample shape is correct', () => {
    const sample: HeartRateSample = {
      bpm: 72,
      timestamp: Date.now(),
      source: 'watch',
    };
    expect(sample.bpm).toBe(72);
    expect(sample.source).toBe('watch');
  });

  it('Baseline shape is correct', () => {
    const baseline: Baseline = {
      medianBpm: 70,
      sampleCount: 100,
      computedAt: Date.now(),
    };
    expect(baseline.medianBpm).toBe(70);
  });

  it('GpsCoordinates shape is correct', () => {
    const coords: GpsCoordinates = {latitude: -26.2041, longitude: 28.0473};
    expect(coords.latitude).toBe(-26.2041);
  });

  it('GpsCoordinatesWithMeta shape is correct', () => {
    const meta: GpsCoordinatesWithMeta = {
      latitude: -26.2041,
      longitude: 28.0473,
      source: 'watch',
      acquiredAt: Date.now(),
      isFresh: true,
    };
    expect(meta.source).toBe('watch');
    expect(meta.isFresh).toBe(true);
  });

  it('EmergencyContact shape is correct', () => {
    const contact: EmergencyContact = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Jane Doe',
      phoneNumber: '+27821234567',
    };
    expect(contact.name).toBe('Jane Doe');
  });

  it('NewContact shape is correct', () => {
    const nc: NewContact = {name: 'Test', phoneNumber: '0821234567'};
    expect(nc.phoneNumber).toBe('0821234567');
  });

  it('ContactError union covers all variants', () => {
    const errors: ContactError[] = [
      'DUPLICATE_PHONE',
      'LAST_CONTACT_REMOVAL',
      'VALIDATION_FAILED',
      'STORAGE_ERROR',
    ];
    expect(errors).toHaveLength(4);
  });

  it('UserSettings shape is correct', () => {
    const settings: UserSettings = {
      distressThresholdPct: 0.40,
      falsePosWindowSeconds: 15,
    };
    expect(settings.distressThresholdPct).toBe(0.40);
    expect(settings.falsePosWindowSeconds).toBe(15);
  });

  it('UserProfile shape is correct', () => {
    const profile: UserProfile = {
      id: 'user-001',
      name: 'Alice',
      phoneNumber: '+27821234567',
      onboardingCompleted: false,
      onboardingStep: 0,
      settings: {distressThresholdPct: 0.40, falsePosWindowSeconds: 15},
    };
    expect(profile.onboardingStep).toBe(0);
  });

  it('TriggerType union covers all four trigger types', () => {
    const triggers: TriggerType[] = [
      'heart_rate_anomaly',
      'watch_removal',
      'bluetooth_disconnection',
      'manual',
    ];
    expect(triggers).toHaveLength(4);
  });

  it('AnomalyResult normal variant is correct', () => {
    const normal: AnomalyResult = {type: 'normal'};
    expect(normal.type).toBe('normal');
  });

  it('AnomalyResult anomaly variant is correct', () => {
    const anomaly: AnomalyResult = {
      type: 'anomaly',
      direction: 'high',
      triggeredAt: Date.now(),
    };
    expect(anomaly.type).toBe('anomaly');
    if (anomaly.type === 'anomaly') {
      expect(anomaly.direction).toBe('high');
    }
  });

  it('ConnectionState union covers all states', () => {
    const states: ConnectionState[] = [
      'disconnected',
      'connecting',
      'connected',
      'unexpected_disconnection',
    ];
    expect(states).toHaveLength(4);
  });

  it('MonitoringSession shape is correct', () => {
    const session: MonitoringSession = {
      activatedAt: Date.now(),
      state: 'active',
      watchConnected: true,
      phoneOnlyMode: false,
    };
    expect(session.state).toBe('active');
  });

  it('HrGapEvent shape is correct', () => {
    const gap: HrGapEvent = {startedAt: Date.now(), retryCount: 0};
    expect(gap.retryCount).toBe(0);
  });

  it('AlertLogEntry shape is correct', () => {
    const entry: AlertLogEntry = {
      id: 'log-001',
      dispatchedAt: Date.now(),
      triggerType: 'manual',
      coordinates: {latitude: -26.2041, longitude: 28.0473},
      contactResults: [],
    };
    expect(entry.triggerType).toBe('manual');
  });

  it('ContactDeliveryResult shape is correct', () => {
    const result: ContactDeliveryResult = {
      contact: {id: 'c1', name: 'Bob', phoneNumber: '+27829998888'},
      status: 'delivered',
      attempts: 1,
    };
    expect(result.status).toBe('delivered');
  });

  it('AlertDispatchResult shape is correct', () => {
    const dispatchResult: AlertDispatchResult = {
      dispatchedAt: Date.now(),
      contactResults: [],
    };
    expect(Array.isArray(dispatchResult.contactResults)).toBe(true);
  });

  it('AlertEvent shape is correct', () => {
    const profile: UserProfile = {
      id: 'u1',
      name: 'Alice',
      phoneNumber: '+27821111111',
      onboardingCompleted: true,
      onboardingStep: 4,
      settings: {distressThresholdPct: 0.40, falsePosWindowSeconds: 15},
    };
    const event: AlertEvent = {
      triggerType: 'heart_rate_anomaly',
      triggeredAt: Date.now(),
      coordinates: null,
      contacts: [],
      userProfile: profile,
    };
    expect(event.triggerType).toBe('heart_rate_anomaly');
    expect(event.coordinates).toBeNull();
  });
});
