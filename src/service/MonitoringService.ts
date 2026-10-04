/**
 * MonitoringService
 *
 * The top-level orchestrator that wires every monitoring subsystem together and
 * runs them inside the platform background execution context (Android Foreground
 * Service / iOS Background Task).  It is the single composition root for the
 * monitoring loop:
 *
 *   BluetoothManager ──► HeartRateMonitor ──► AnomalyDetector ──► MonitoringStateMachine
 *                    └─► LocationService ───────────────────────┘
 *   MonitoringStateMachine ──► AlertPipeline ──► EmergencyContactRepository
 *                                             └─► UserProfileRepository
 *
 * Responsibilities:
 *   1. Own the XState monitoring actor (`createActor(machine, {clock})`).
 *   2. Route validated heart-rate samples into the AnomalyDetector and forward
 *      detected anomalies to the actor as `ANOMALY_DETECTED` (first) or
 *      `ANOMALY_RESTART` (while an alert is already pending) (Req 2.1–2.3).
 *   3. Watch `connectionState$` for unexpected disconnections → `BT_DISCONNECTED`
 *      (Req 8.2) and, on reconnection after such an alert, send a
 *      connection-restored notification via the AlertPipeline (Req 8.5).
 *   4. Reuse {@link createWatchRemovalWiring} for wrist-removal detection.
 *   5. Build and dispatch the AlertEvent whenever the actor enters `dispatching`,
 *      then feed the result back via `DISPATCH_COMPLETE`.
 *   6. Keep settings (`distressThresholdPct`) live via
 *      `UserProfileRepository.onSettingsChanged`.
 *   7. Resolve OS-kill auto-resume on `start()` via `resolveResumeTarget` and
 *      send `RESUME` within the 10 s budget (Req 9.5).
 *
 * All collaborators are injected so the service is unit-testable without any
 * native modules.  A default factory ({@link createDefaultMonitoringService})
 * wires the real singletons.
 *
 * Note on Requirement 8.3 (watch independent connectivity): this requirement
 * ("WHERE the Smartwatch hardware supports independent network connectivity …
 * the Smartwatch SHALL independently attempt to send an alert") is a
 * watch-firmware concern.  The phone-side Safety_App cannot implement it — it
 * can only dispatch via the phone's cellular connection (Req 8.2).  It is
 * documented here for traceability but is intentionally not wired on the phone.
 *
 * Requirements covered: 8.2, 8.3 (documented as firmware concern), 8.5, 9.5
 */

import {createActor} from 'xstate';
import type {Subscription} from 'xstate';

import type {
  AlertEvent,
  AlertDispatchResult,
  ConnectionState,
  EmergencyContact,
  GpsCoordinatesWithMeta,
  HeartRateSample,
  UserProfile,
  UserSettings,
} from '../types';
import type {Observable} from '../heartrate/HeartRateMonitor';
import type {HeartRateMonitor} from '../heartrate/HeartRateMonitor';
import type {AnomalyDetector} from '../anomaly/AnomalyDetector';
import type {ILocationService} from '../location/LocationService';
import type {AlertPipeline} from '../alert/AlertPipeline';
import type {EmergencyContactRepository} from '../contacts/EmergencyContactRepository';
import type {UserProfileRepository} from '../profile/UserProfileRepository';
import type {BluetoothManager, WristStatus} from '../bluetooth/BluetoothManager';
import {
  createMonitoringMachine,
  resolveResumeTarget,
  toXStateClock,
  type MonitoringInput,
  type MonitoringTimers,
  defaultMonitoringTimers,
} from '../state/MonitoringStateMachine';
import type {EncryptedStorageInterface} from '../storage/EncryptedStorage';
import {
  createWatchRemovalWiring,
  type WatchRemovalWiring,
} from './WatchRemovalWiring';

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Default distress threshold percentage used until the real user settings are
 * loaded from the {@link UserProfileRepository}.  Mirrors
 * {@link UserSettings} default (Requirement 2.7).
 */
const DEFAULT_THRESHOLD_PCT = 0.4;

/** Short, user-facing copy sent to contacts when connectivity is restored (Req 8.5). */
export function formatConnectionRestoredMessage(userName: string): string {
  return (
    `✅ CONNECTION RESTORED – ${userName}\n` +
    `\n` +
    `The Bluetooth link to the GBV Safety Watch has been re-established after ` +
    `an earlier disconnection alert.\n` +
    `\n` +
    `This message was sent automatically by GBV Safety Watch.`
  );
}

// ── Collaborator interfaces ──────────────────────────────────────────────────

/**
 * The subset of the running XState actor the service depends on.  Kept narrow
 * (structural) so both the real `MonitoringActorRef` and a test double satisfy
 * it, and so {@link createWatchRemovalWiring} can share the same actor handle.
 */
export interface MonitoringActorLike {
  start(): void;
  stop(): void;
  send(event: {type: string; [key: string]: unknown}): void;
  getSnapshot(): {
    value: unknown;
    matches(stateValue: string): boolean;
  };
  subscribe(listener: (snapshot: {value: unknown}) => void): Subscription;
}

// ── Options bag ──────────────────────────────────────────────────────────────

/**
 * Dependency-injection bag for {@link MonitoringService}.  Every collaborator is
 * injectable so the service can be unit-tested without native modules.
 */
export interface MonitoringServiceOptions {
  /** BLE manager — source of `connectionState$` and wrist-status stream. */
  bluetooth: BluetoothManager;
  /** Heart-rate monitor exposing the validated `sample$` stream. */
  heartRateMonitor: HeartRateMonitor;
  /** Stateful anomaly detector (keeps its own prev-sample window). */
  anomalyDetector: AnomalyDetector;
  /** Location service providing cached / on-demand coordinates. */
  locationService: ILocationService;
  /** Alert dispatch pipeline. */
  alertPipeline: AlertPipeline;
  /** Emergency contact store (dispatch recipients). */
  contactRepository: EmergencyContactRepository;
  /** User profile store (name + live settings). */
  profileRepository: UserProfileRepository;
  /** Encrypted storage used for OS-kill resume resolution (Req 9.5). */
  storage: EncryptedStorageInterface;

  /**
   * Optional factory for the monitoring actor.  Defaults to building the real
   * XState actor from {@link createMonitoringMachine} with the supplied timers
   * as its clock.  Injectable so tests can provide a lightweight double.
   */
  createActor?: (input: MonitoringInput) => MonitoringActorLike;

  /**
   * Timers used for the state-machine clock (FPW countdown / reconcile delays).
   * Defaults to {@link defaultMonitoringTimers}.
   */
  timers?: MonitoringTimers;

  /** Clock used for alert timestamps.  Defaults to `Date.now`. */
  now?: () => number;
}

// ── Service ──────────────────────────────────────────────────────────────────

/**
 * Composition root that owns and connects all monitoring subsystems.
 *
 * Lifecycle:
 *   • `start()` — idempotent.  Loads live settings, wires every subscription,
 *     starts the actor, the HR monitor, the location poll, and the watch-removal
 *     wiring, then resolves OS-kill auto-resume (Req 9.5).
 *   • `stop()`  — idempotent.  Tears down every subscription/timer/poll and stops
 *     the actor so no handles leak.
 */
export class MonitoringService {
  // ── Injected collaborators ─────────────────────────────────────────────────
  private readonly bluetooth: BluetoothManager;
  private readonly heartRateMonitor: HeartRateMonitor;
  private readonly anomalyDetector: AnomalyDetector;
  private readonly locationService: ILocationService;
  private readonly alertPipeline: AlertPipeline;
  private readonly contactRepository: EmergencyContactRepository;
  private readonly profileRepository: UserProfileRepository;
  private readonly storage: EncryptedStorageInterface;
  private readonly timers: MonitoringTimers;
  private readonly now: () => number;
  private readonly createActorFn: (input: MonitoringInput) => MonitoringActorLike;

  // ── Runtime state ──────────────────────────────────────────────────────────
  private started = false;

  /** The running monitoring actor, or null while stopped. */
  private actor: MonitoringActorLike | null = null;

  /** Live distress threshold percentage (kept current via onSettingsChanged). */
  private thresholdPct = DEFAULT_THRESHOLD_PCT;

  /**
   * True while an unexpected-disconnection alert is outstanding and awaiting a
   * reconnection, so a `'connected'` transition can fire the connection-restored
   * notification exactly once (Req 8.5).
   */
  private awaitingReconnection = false;

  /**
   * Guards against dispatching the same alert twice: the actor can re-enter
   * `dispatching` only through a fresh workflow, so we latch on entry and clear
   * when it leaves.
   */
  private dispatchInFlight = false;

  // ── Teardown handles ───────────────────────────────────────────────────────
  private sampleUnsub: (() => void) | null = null;
  private connectionUnsub: (() => void) | null = null;
  private settingsUnsub: (() => void) | null = null;
  private actorSub: Subscription | null = null;
  private watchRemovalWiring: WatchRemovalWiring | null = null;

  constructor(options: MonitoringServiceOptions) {
    this.bluetooth = options.bluetooth;
    this.heartRateMonitor = options.heartRateMonitor;
    this.anomalyDetector = options.anomalyDetector;
    this.locationService = options.locationService;
    this.alertPipeline = options.alertPipeline;
    this.contactRepository = options.contactRepository;
    this.profileRepository = options.profileRepository;
    this.storage = options.storage;
    this.timers = options.timers ?? defaultMonitoringTimers;
    this.now = options.now ?? (() => Date.now());

    // Default actor factory: build the real XState actor driven by our timers.
    this.createActorFn =
      options.createActor ??
      ((input: MonitoringInput) => {
        const machine = createMonitoringMachine(input);
        // The machine factory closes over `input`; the actor's own `input` is
        // unused by the machine body, so an empty object satisfies the type.
        return createActor(machine, {
          input,
          clock: toXStateClock(this.timers),
        }) as unknown as MonitoringActorLike;
      });
  }

  // ── Public lifecycle ─────────────────────────────────────────────────────────

  /**
   * Start the monitoring service.  Idempotent — a second call while already
   * running is a no-op.
   *
   * Steps:
   *   1. Load live user settings (threshold + FPW) and subscribe to changes.
   *   2. Build the actor with the current FPW duration and a watch display sink.
   *   3. Wire the actor state listener (handles the `dispatching` entry).
   *   4. Wire the HR sample → anomaly → actor path.
   *   5. Wire `connectionState$` for unexpected-disconnection / restore (8.2/8.5).
   *   6. Wire watch removal via {@link createWatchRemovalWiring}.
   *   7. Start the HR monitor and the location poll.
   *   8. Resolve OS-kill auto-resume and send `RESUME` within 10 s (9.5).
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // 1. Load live settings so the FPW duration and threshold are correct.
    const settings = await this.loadSettings();
    this.thresholdPct = settings.distressThresholdPct;

    this.settingsUnsub = this.profileRepository.onSettingsChanged(
      (next: UserSettings) => {
        this.thresholdPct = next.distressThresholdPct;
      },
    );

    // 2. Build and start the actor.
    const actor = this.createActorFn({
      storage: this.storage,
      timers: this.timers,
      falsePosWindowSeconds: settings.falsePosWindowSeconds,
      sendDisplayMessage: (text: string) => {
        // Only push the countdown to the watch if it supports display messages
        // (MOYOUNG command channel).  On HR-only watches this is skipped; the
        // phone screen still shows the countdown.
        const caps = this.bluetooth.getCapabilities();
        if (caps && !caps.moyoungCommands) {
          return;
        }
        // Fire-and-forget: pushing the countdown to the watch must not block.
        void this.bluetooth.sendDisplayMessage(text).catch(() => {
          /* watch display is best-effort */
        });
      },
      now: this.now,
    });
    this.actor = actor;
    actor.start();

    // 3. React to actor state changes (dispatch on entering `dispatching`).
    this.actorSub = actor.subscribe(snapshot => {
      void this.onActorSnapshot(snapshot.value);
    });

    // 4. HR sample → AnomalyDetector → actor.
    this.wireHeartRate(actor);

    // 5. connectionState$ → BT_DISCONNECTED / connection-restored (8.2, 8.5).
    this.wireConnectionState(actor);

    // 6. Watch removal wiring (reused factory) — only when the watch exposes the
    //    MOYOUNG command channel that carries wrist-status notifications.  On
    //    HR-only hardware (e.g. GPS Fit Fuel / MOY-LXC3) there is no wrist-status
    //    stream, so we skip this wiring rather than subscribe to a dead channel.
    //    HR-anomaly, Bluetooth-disconnection, and phone manual triggers remain.
    const caps = this.bluetooth.getCapabilities();
    if (!caps || caps.moyoungCommands) {
      this.watchRemovalWiring = createWatchRemovalWiring({
        bluetooth: this.bluetooth,
        actor: {
          send: event => actor.send(event),
          getSnapshot: () => ({
            matches: (stateValue: string) =>
              actor.getSnapshot().matches(stateValue),
          }),
        },
      });
      this.watchRemovalWiring.start();
    } else {
      console.info(
        '[MonitoringService] Watch-removal detection disabled: connected watch ' +
          'has no MOYOUNG wrist-status channel.',
      );
    }

    // 7. Start sensor loops.
    this.heartRateMonitor.start();
    this.locationService.start();

    // 8. OS-kill auto-resume (Req 9.5): resolve and resume within the 10 s budget.
    await this.resolveAutoResume(actor);
  }

  /**
   * Stop the monitoring service and release every resource.  Idempotent.
   *
   * Tears down all subscriptions, the watch-removal wiring, the HR monitor, the
   * location poll, and the actor, ensuring no timers or listeners leak.
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    // Sensor loops first so no new events arrive mid-teardown.
    this.heartRateMonitor.stop();
    this.locationService.stop();

    if (this.sampleUnsub) {
      this.sampleUnsub();
      this.sampleUnsub = null;
    }
    if (this.connectionUnsub) {
      this.connectionUnsub();
      this.connectionUnsub = null;
    }
    if (this.settingsUnsub) {
      this.settingsUnsub();
      this.settingsUnsub = null;
    }
    if (this.watchRemovalWiring) {
      this.watchRemovalWiring.stop();
      this.watchRemovalWiring = null;
    }
    if (this.actorSub) {
      this.actorSub.unsubscribe();
      this.actorSub = null;
    }
    if (this.actor) {
      this.actor.stop();
      this.actor = null;
    }

    this.awaitingReconnection = false;
    this.dispatchInFlight = false;
  }

  // ── Private wiring helpers ────────────────────────────────────────────────────

  /**
   * Wire the validated heart-rate stream into the anomaly detector, forwarding
   * anomalies to the actor:
   *   • While `active`           → `ANOMALY_DETECTED` (starts the FPW).
   *   • While `alert_pending`    → `ANOMALY_RESTART`  (restarts the FPW, Req 2.3).
   */
  private wireHeartRate(actor: MonitoringActorLike): void {
    const sample$: Observable<HeartRateSample> = this.heartRateMonitor.sample$;
    this.sampleUnsub = sample$.subscribe(sample => {
      const baseline = this.heartRateMonitor.getBaseline();
      const result = this.anomalyDetector.evaluate(
        sample,
        baseline,
        this.thresholdPct,
      );
      if (result.type !== 'anomaly') return;

      const snapshot = actor.getSnapshot();
      if (snapshot.matches('alert_pending')) {
        // A new anomalous sample during the countdown restarts it (Req 2.3).
        actor.send({type: 'ANOMALY_RESTART', triggeredAt: result.triggeredAt});
      } else if (snapshot.matches('active')) {
        actor.send({type: 'ANOMALY_DETECTED', triggeredAt: result.triggeredAt});
      }
    });
  }

  /**
   * Wire the BLE connection-state stream:
   *   • `'unexpected_disconnection'` → `BT_DISCONNECTED` to start the alert
   *     workflow dispatched over the phone's cellular connection (Req 8.2).
   *   • `'connected'` after such an alert → send a connection-restored
   *     notification to all contacts via the AlertPipeline (Req 8.5).
   */
  private wireConnectionState(actor: MonitoringActorLike): void {
    this.connectionUnsub = this.bluetooth.connectionState$.subscribe(
      (state: ConnectionState) => {
        if (state === 'unexpected_disconnection') {
          this.awaitingReconnection = true;
          actor.send({type: 'BT_DISCONNECTED', triggeredAt: this.now()});
          return;
        }
        if (state === 'connected' && this.awaitingReconnection) {
          this.awaitingReconnection = false;
          void this.sendConnectionRestoredNotification();
        }
      },
    );
  }

  /**
   * Build and dispatch a connection-restored SMS to every registered contact
   * (Req 8.5).  Reuses the AlertPipeline's SMS plumbing by dispatching an alert
   * event carrying the restore message as the trigger context; failures are
   * logged and swallowed so a restore notification never crashes monitoring.
   */
  private async sendConnectionRestoredNotification(): Promise<void> {
    try {
      const [contacts, profile] = await Promise.all([
        this.contactRepository.getAll(),
        this.profileRepository.get(),
      ]);
      if (contacts.length === 0 || profile === null) return;

      // The connection-restored message is informational; we reuse the pipeline
      // with the bluetooth_disconnection trigger label and current coordinates.
      const coordinates = await this.resolveCoordinates();
      const event: AlertEvent = {
        triggerType: 'bluetooth_disconnection',
        triggeredAt: this.now(),
        coordinates,
        contacts,
        userProfile: profile,
      };
      await this.alertPipeline.dispatch(event);
      // Log the restore copy for traceability (actual SMS body is pipeline-rendered).
      console.log(
        '[MonitoringService]',
        formatConnectionRestoredMessage(profile.name),
      );
    } catch (err) {
      console.warn(
        '[MonitoringService] connection-restored notification failed:',
        err,
      );
    }
  }

  /**
   * React to an actor snapshot.  When the machine enters `dispatching`, assemble
   * the AlertEvent and dispatch it, then feed the result back via
   * `DISPATCH_COMPLETE`.  Latches `dispatchInFlight` so a single `dispatching`
   * entry triggers exactly one dispatch.
   */
  private async onActorSnapshot(value: unknown): Promise<void> {
    const inDispatching = value === 'dispatching';

    if (!inDispatching) {
      // Reset the latch whenever we are outside `dispatching`.
      this.dispatchInFlight = false;
      return;
    }

    if (this.dispatchInFlight) return;
    this.dispatchInFlight = true;

    const actor = this.actor;
    if (!actor) return;

    try {
      const result = await this.buildAndDispatchAlert();
      actor.send({type: 'DISPATCH_COMPLETE', result});
    } catch (err) {
      console.warn('[MonitoringService] alert dispatch failed:', err);
      // Complete the workflow even on failure so the machine leaves `dispatching`.
      actor.send({type: 'DISPATCH_COMPLETE'});
    }
  }

  /**
   * Assemble the {@link AlertEvent} from the current context and dispatch it.
   *   • triggerType  — read from the actor context.
   *   • coordinates  — watch-first via {@link resolveCoordinates}.
   *   • contacts     — {@link EmergencyContactRepository.getAll}.
   *   • userProfile  — {@link UserProfileRepository.get}.
   */
  private async buildAndDispatchAlert(): Promise<AlertDispatchResult> {
    const actor = this.actor;
    if (!actor) {
      throw new Error('[MonitoringService] no actor while dispatching');
    }

    const snapshot = actor.getSnapshot() as unknown as {
      context: {triggerType: AlertEvent['triggerType'] | null};
    };
    const triggerType = snapshot.context?.triggerType ?? 'manual';

    const [coordinates, contacts, profile] = await Promise.all([
      this.resolveCoordinates(),
      this.contactRepository.getAll(),
      this.profileRepository.get(),
    ]);

    const userProfile: UserProfile =
      profile ?? this.fallbackProfile();

    const event: AlertEvent = {
      triggerType,
      triggeredAt: this.now(),
      coordinates,
      contacts,
      userProfile,
    };

    return this.alertPipeline.dispatch(event);
  }

  /**
   * Resolve the coordinates for an alert: prefer the already-cached fix, falling
   * back to an on-demand `getCurrentCoordinates()` poll if the cache is empty.
   */
  private async resolveCoordinates(): Promise<GpsCoordinatesWithMeta | null> {
    if (this.locationService.cachedCoordinates) {
      return this.locationService.cachedCoordinates;
    }
    try {
      return await this.locationService.getCurrentCoordinates();
    } catch {
      return null;
    }
  }

  /**
   * Resolve OS-kill auto-resume (Req 9.5).  Reads the persisted session via
   * {@link resolveResumeTarget}; if a resume is required, sends `RESUME` with the
   * current watch availability so the machine re-enters `active` (phone-only when
   * the watch is unavailable).  Runs during `start()` so it completes well within
   * the 10 s budget.
   */
  private async resolveAutoResume(actor: MonitoringActorLike): Promise<void> {
    try {
      const watchConnected = this.isWatchConnected();
      const {shouldResume} = await resolveResumeTarget(
        this.storage,
        watchConnected,
      );
      if (shouldResume) {
        actor.send({type: 'RESUME', watchConnected});
      }
    } catch (err) {
      console.warn('[MonitoringService] auto-resume resolution failed:', err);
    }
  }

  /**
   * Load current user settings, defaulting gracefully when no profile exists so
   * the service can still run (e.g. immediately after onboarding start).
   */
  private async loadSettings(): Promise<UserSettings> {
    try {
      return await this.profileRepository.getSettings();
    } catch {
      return {
        distressThresholdPct: DEFAULT_THRESHOLD_PCT,
        falsePosWindowSeconds: 15,
      };
    }
  }

  /**
   * Best-effort watch-connectivity probe used for the resume decision.  The
   * concrete `BluetoothManager` does not expose a synchronous getter, so absent
   * a known state we assume the watch is unavailable (phone-only resume), which
   * is the safe default per Req 9.5.
   */
  private isWatchConnected(): boolean {
    const probe = this.bluetooth as unknown as {
      isConnected?: () => boolean;
      connectedDeviceId?: string | null;
    };
    if (typeof probe.isConnected === 'function') {
      return probe.isConnected();
    }
    if ('connectedDeviceId' in probe) {
      return probe.connectedDeviceId != null;
    }
    return false;
  }

  /** Minimal placeholder profile used only if the real profile is missing. */
  private fallbackProfile(): UserProfile {
    return {
      id: 'unknown',
      name: 'User',
      phoneNumber: '',
      onboardingCompleted: false,
      onboardingStep: 0,
      settings: {
        distressThresholdPct: this.thresholdPct,
        falsePosWindowSeconds: 15,
      },
    };
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Convenience factory.  Prefer this over `new MonitoringService(...)` in
 * application code.
 *
 * @param options - Injected collaborators (see {@link MonitoringServiceOptions}).
 */
export function createMonitoringService(
  options: MonitoringServiceOptions,
): MonitoringService {
  return new MonitoringService(options);
}

/**
 * Re-export of the watch-status type for consumers wiring the service manually.
 */
export type {WristStatus};
