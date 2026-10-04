/**
 * BluetoothManager
 *
 * Manages the BLE lifecycle for the GBV Safety Watch: scanning, connecting,
 * disconnecting, and subscribing to GATT characteristics on MOYOUNG V2 watches.
 *
 * Design decisions:
 * - The underlying BleManager (react-native-ble-plx) is injected via constructor
 *   so this class remains unit-testable without a real BLE stack.
 * - `connectionState$` is a Subject exposed as an Observable to downstream consumers.
 * - `disconnect(intentional)` records intent before calling cancelDeviceConnection;
 *   task 9.2 uses the `_intentionalDisconnect` flag for disconnection classification.
 * - A 30 s watchdog timer is started on any unintentional disconnection; after 30 s
 *   `connectionState$` emits `'unexpected_disconnection'` (Requirements 8.1, 8.2, 8.4).
 *
 * Requirements covered: 8.1, 8.2, 8.4
 */

import { Subject, Observable } from '../heartrate/HeartRateMonitor';
import type { HeartRateSample, GpsCoordinates, ConnectionState } from '../types';

// ── MOYOUNG V2 GATT UUIDs ──────────────────────────────────────────────────────

/** MOYOUNG proprietary main service UUID. */
const MOYOUNG_SERVICE_UUID = '0000fee0-0000-1000-8000-00805f9b34fb';

/** Command write characteristic — write without response. */
const MOYOUNG_CMD_WRITE_UUID = '0000fee1-0000-1000-8000-00805f9b34fb';

/** Notify/response characteristic — subscribe for sensor data and command acks. */
const MOYOUNG_NOTIFY_UUID = '0000fee2-0000-1000-8000-00805f9b34fb';

/** Bluetooth SIG Heart Rate service UUID (0x180D). */
const SIG_HEART_RATE_SERVICE_UUID = '0000180d-0000-1000-8000-00805f9b34fb';

/** Bluetooth SIG Heart Rate Measurement characteristic UUID (0x2A37). */
const SIG_HR_MEASUREMENT_UUID = '00002a37-0000-1000-8000-00805f9b34fb';

/** Bluetooth SIG Battery service UUID (0x180F). */
const SIG_BATTERY_SERVICE_UUID = '0000180f-0000-1000-8000-00805f9b34fb';

/** Bluetooth SIG Location & Navigation service UUID (0x1819). */
const SIG_LOCATION_NAV_SERVICE_UUID = '00001819-0000-1000-8000-00805f9b34fb';

// ── MOYOUNG command bytes ──────────────────────────────────────────────────────

/** Magic start byte for every MOYOUNG command frame. */
const MOYOUNG_MAGIC = 0xab;

/** Command: start real-time heart rate streaming. */
const CMD_HR_START = { cmd: 0x05, subcmd: 0x01 } as const;

/** Command: stop real-time heart rate streaming. */
const CMD_HR_STOP = { cmd: 0x05, subcmd: 0x02 } as const;

/** Command: request current GPS fix. */
const CMD_GPS_REQUEST = { cmd: 0x08, subcmd: 0x01 } as const;

/** Command: request current wrist-presence status. */
const CMD_WRIST_STATUS = { cmd: 0x06, subcmd: 0x01 } as const;

/** Command: set watch display message. */
const CMD_DISPLAY_MSG = { cmd: 0x0f, subcmd: 0x01 } as const;

// ── Disconnection watchdog threshold ──────────────────────────────────────────

/**
 * Duration (ms) after which an unacknowledged disconnection is classified as
 * unexpected.  Requirement 8.1 specifies 30 seconds.
 */
const UNEXPECTED_DISCONNECT_THRESHOLD_MS = 30_000;

// ── Supporting types ───────────────────────────────────────────────────────────

/** A BLE device returned from a scan. */
export interface DiscoveredDevice {
  id: string;
  name: string | null;
  rssi: number;
}

/** Wrist-presence state reported by the watch. */
export type WristStatus = 'on-wrist' | 'off-wrist';

/**
 * Minimal interface that mirrors the react-native-ble-plx `BleManager` API
 * surface used by BluetoothManager.  Accepting this interface instead of the
 * concrete class keeps the implementation decoupled from the native module.
 */
export interface BleManagerInterface {
  /**
   * Start scanning for BLE peripherals.
   * `callback` is called for every advertisement frame received.
   * Pass `null` for `serviceUUIDs` to scan all devices.
   */
  startDeviceScan(
    serviceUUIDs: string[] | null,
    options: { allowDuplicates?: boolean } | null,
    callback: (error: BleError | null, device: BleDevice | null) => void,
  ): void;

  /** Stop an in-progress BLE scan. */
  stopDeviceScan(): void;

  /**
   * Connect to a peripheral by its device ID (platform-assigned UUID / MAC).
   * Resolves with the connected device object (already service-discovered).
   */
  connectToDevice(
    deviceId: string,
    options?: { autoConnect?: boolean; requestMTU?: number },
  ): Promise<BleDevice>;

  /**
   * Look up a previously connected or discovered device by ID.
   * Returns an array — typically length 0 or 1.
   */
  devices(deviceIds: string[]): Promise<BleDevice[]>;

  /**
   * Disconnect from a device.  Resolves when the disconnection is complete.
   * Rejects if the device was never connected.
   */
  cancelDeviceConnection(deviceId: string): Promise<BleDevice>;

  /**
   * Subscribe to GATT notifications on a characteristic.
   * `callback` fires on each notification; returns a subscription object whose
   * `remove()` method stops the subscription.
   */
  monitorCharacteristicForDevice(
    deviceId: string,
    serviceUUID: string,
    characteristicUUID: string,
    callback: (error: BleError | null, characteristic: BleCharacteristic | null) => void,
  ): BleSubscription;

  /**
   * Write data to a characteristic without waiting for a response from the
   * peripheral (Write Without Response / "command" write).
   * `value` is a base-64-encoded string of the raw bytes.
   */
  writeCharacteristicWithoutResponseForDevice(
    deviceId: string,
    serviceUUID: string,
    characteristicUUID: string,
    value: string,
  ): Promise<BleCharacteristic>;

  /**
   * Register a callback that fires whenever the device with `deviceId`
   * disconnects from the host.  Returns a subscription handle whose `remove()`
   * cancels the listener.
   *
   * Used by the disconnection watchdog (task 9.2, Requirement 8.1).
   */
  onDeviceDisconnected(
    deviceId: string,
    callback: (error: BleError | null, device: BleDevice | null) => void,
  ): BleSubscription;
}

/** Minimal BLE service shape from react-native-ble-plx. */
export interface BleService {
  uuid: string;
}

/** Minimal BLE device shape from react-native-ble-plx. */
export interface BleDevice {
  id: string;
  name: string | null;
  rssi: number | null;
  /** Discover all services + characteristics.  Returns the same device. */
  discoverAllServicesAndCharacteristics(): Promise<BleDevice>;
  /**
   * List the GATT services the device exposes after discovery.  Optional on the
   * interface so test doubles need not implement it; when absent, capability
   * detection falls back to "heart-rate only" (the safe minimum).
   */
  services?(): Promise<BleService[]>;
}

/**
 * Capabilities a connected watch actually supports, discovered at connect time
 * by inspecting its GATT services.
 *
 * Not every watch advertised as compatible exposes the full MOYOUNG command
 * channel.  Budget devices (e.g. "GPS Fit Fuel", firmware MOY-LXC3) expose only
 * the standard SIG Heart Rate + Battery services and NOT the proprietary
 * `0xfee0` command service — so GPS requests, wrist-removal detection, and
 * watch-screen display messages are unavailable on that hardware.
 *
 * The MonitoringService consults these flags and gracefully skips wiring the
 * features a given watch cannot support, falling back to phone-side equivalents
 * (phone GPS, phone manual trigger) where the design allows.
 */
export interface WatchCapabilities {
  /** SIG Heart Rate service (0x180D) present → HR streaming works. */
  heartRate: boolean;
  /** SIG Battery service (0x180F) present. */
  battery: boolean;
  /**
   * MOYOUNG proprietary command service (0xfee0) present → the watch supports
   * GPS requests, wrist-status notifications, and display messages over BLE.
   */
  moyoungCommands: boolean;
  /** SIG Location & Navigation service (0x1819) present → onboard GPS chip. */
  onboardGps: boolean;
  /** Raw list of discovered service UUIDs (lower-case), for diagnostics. */
  serviceUuids: string[];
}

/** Minimal BLE characteristic shape from react-native-ble-plx. */
export interface BleCharacteristic {
  /** Base-64-encoded raw bytes of the notification value. */
  value: string | null;
}

/** Minimal BLE subscription handle from react-native-ble-plx. */
export interface BleSubscription {
  remove(): void;
}

/** Minimal BLE error shape from react-native-ble-plx. */
export interface BleError {
  message: string;
  errorCode?: number;
}

// ── Encoding helpers ───────────────────────────────────────────────────────────

/**
 * Encode a Uint8Array to a base-64 string suitable for react-native-ble-plx
 * `writeCharacteristicWithoutResponseForDevice`.
 *
 * Uses the global `btoa` that is available in React Native's Hermes engine.
 * Falls back to Node's `Buffer` in test environments.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    // React Native / browser environment
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  // Node / Jest test environment
  return Buffer.from(bytes).toString('base64');
}

/**
 * Decode a base-64 string received from react-native-ble-plx into a Uint8Array.
 */
function base64ToUint8Array(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/**
 * Build a MOYOUNG V2 command frame:
 * `[0xAB][length:1][cmd:1][subcmd:1][payload:N]`
 *
 * `length` encodes the byte count of `[cmd, subcmd, ...payload]`.
 */
function buildMoyoungFrame(
  cmd: number,
  subcmd: number,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const frameLength = 1 + 1 + 1 + payload.length; // magic + length + cmd + subcmd + payload
  const frame = new Uint8Array(frameLength);
  frame[0] = MOYOUNG_MAGIC;
  frame[1] = 2 + payload.length; // cmd(1) + subcmd(1) + payload
  frame[2] = cmd;
  frame[3] = subcmd;
  frame.set(payload, 4);
  return frame;
}

/**
 * Encode a UTF-8 string to a Uint8Array.
 * Uses TextEncoder where available (Hermes), otherwise encodes ASCII bytes.
 */
function encodeUtf8(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text);
  }
  // Fallback: encode as latin-1 / ASCII for Node environments
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
}

// ── GPS response parser ────────────────────────────────────────────────────────

/**
 * Attempt to parse a GPS fix from a MOYOUNG notify response.
 *
 * The exact binary layout of the GPS response has not been fully reverse-engineered.
 * This is a best-effort parse based on common MOYOUNG V2 GPS response patterns:
 *
 * Typical layout observed in firmware dumps:
 * `[0xAB][length][0x08][0x01][lat_i32_le:4][lng_i32_le:4][accuracy:2][...]`
 * Latitude and longitude are stored as integer micro-degrees (×10^-6).
 *
 * Returns `null` if the bytes do not match the expected layout.
 */
function parseMoyoungGpsResponse(bytes: Uint8Array): GpsCoordinates | null {
  // Minimum: magic(1) + length(1) + cmd(1) + subcmd(1) + lat(4) + lng(4) = 12 bytes
  if (bytes.length < 12) return null;
  if (bytes[0] !== MOYOUNG_MAGIC) return null;
  if (bytes[2] !== CMD_GPS_REQUEST.cmd || bytes[3] !== CMD_GPS_REQUEST.subcmd) return null;

  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const latRaw = view.getInt32(4, true /* little-endian */);
    const lngRaw = view.getInt32(8, true /* little-endian */);

    const latitude = latRaw / 1_000_000;
    const longitude = lngRaw / 1_000_000;

    // Basic sanity check on coordinate ranges
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return null;
    }

    return { latitude, longitude };
  } catch {
    return null;
  }
}

/**
 * Parse wrist status from a MOYOUNG notify response byte array.
 *
 * Expected layout for wrist-status response:
 * `[0xAB][length][0x06][0x01][status:1][...]`
 * `status = 0x01` → on wrist, `status = 0x00` → off wrist.
 */
function parseMoyoungWristStatus(bytes: Uint8Array): WristStatus | null {
  if (bytes.length < 5) return null;
  if (bytes[0] !== MOYOUNG_MAGIC) return null;
  if (bytes[2] !== CMD_WRIST_STATUS.cmd || bytes[3] !== CMD_WRIST_STATUS.subcmd) return null;

  return bytes[4] === 0x01 ? 'on-wrist' : 'off-wrist';
}

// ── BluetoothManagerOptions ────────────────────────────────────────────────────

/**
 * Dependency-injection bag for `BluetoothManager`.
 *
 * Providing custom `setTimeout` / `clearTimeout` implementations makes the
 * watchdog timer fully controllable in unit tests (e.g. via Jest fake timers
 * or a manually advanced virtual clock).
 */
export interface BluetoothManagerOptions {
  /** The BLE manager implementation to delegate all BLE operations to. */
  ble: BleManagerInterface;
  /**
   * Optional `setTimeout` replacement.  Defaults to the global `setTimeout`.
   * Inject a test-controlled timer to verify watchdog behaviour deterministically.
   */
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /**
   * Optional `clearTimeout` replacement.  Defaults to the global `clearTimeout`.
   */
  clearTimeout?: (id: ReturnType<typeof setTimeout>) => void;
}

// ── BluetoothManager ───────────────────────────────────────────────────────────

/**
 * BluetoothManager manages the full BLE lifecycle for the GBV Safety Watch.
 *
 * Constructor accepts a `BleManagerInterface` instance so the class can be
 * unit-tested without a physical BLE adapter.
 *
 * @example
 * ```ts
 * import { BleManager } from 'react-native-ble-plx';
 * const manager = new BluetoothManager(new BleManager());
 * manager.startScan().subscribe(device => console.log(device));
 * await manager.connect(device.id);
 * ```
 */
export class BluetoothManager {
  // ── Internal state ───────────────────────────────────────────────────────────

  /** ID of the device we are currently connected to, or null. */
  private connectedDeviceId: string | null = null;

  /**
   * Capabilities discovered for the currently connected watch, or null while
   * disconnected.  Populated during `connect()` from the device's GATT services.
   */
  private capabilities: WatchCapabilities | null = null;

  /**
   * True when the caller invoked `disconnect(true)` — used by the disconnection
   * classifier in task 9.2 to distinguish intentional from unexpected drops.
   */
  // eslint-disable-next-line @typescript-eslint/naming-convention
  private _intentionalDisconnect: boolean = false;

  /** Subject that backs the public `connectionState$` observable. */
  private readonly _connectionState$: Subject<ConnectionState>;

  /**
   * Handle for the 30-second watchdog timer started on an unintentional
   * disconnection.  Cleared immediately when a deliberate `disconnect(true)`
   * is called (Requirement 8.4).
   */
  private _watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  /** Injectable `setTimeout` — defaults to the global implementation. */
  private readonly _setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;

  /** Injectable `clearTimeout` — defaults to the global implementation. */
  private readonly _clearTimeout: (id: ReturnType<typeof setTimeout>) => void;

  /** The injected BLE manager. */
  private readonly ble: BleManagerInterface;

  // ── Constructor ──────────────────────────────────────────────────────────────

  /**
   * Accepts either a plain `BleManagerInterface` (backward-compatible) or a
   * `BluetoothManagerOptions` bag that additionally allows injecting timer
   * functions for deterministic testing of the disconnection watchdog.
   *
   * @param options - A `BleManagerInterface` or a `BluetoothManagerOptions` object.
   */
  constructor(options: BleManagerInterface | BluetoothManagerOptions) {
    // Support both the legacy `new BluetoothManager(ble)` call signature and the
    // new options-bag form.
    if ('ble' in options && typeof (options as BluetoothManagerOptions).ble === 'object') {
      const opts = options as BluetoothManagerOptions;
      this.ble = opts.ble;
      this._setTimeout = opts.setTimeout ?? ((...args) => setTimeout(...args));
      this._clearTimeout = opts.clearTimeout ?? ((...args) => clearTimeout(...args));
    } else {
      this.ble = options as BleManagerInterface;
      this._setTimeout = (...args) => setTimeout(...args);
      this._clearTimeout = (...args) => clearTimeout(...args);
    }

    this._connectionState$ = new Subject<ConnectionState>();
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Public read-only view of the connection state stream.
   * Emits: `'disconnected' | 'connecting' | 'connected' | 'unexpected_disconnection'`
   *
   * Requirement 8.1 — the `'unexpected_disconnection'` state is emitted when
   * the disconnection classifier (task 9.2) determines the drop was unintentional.
   */
  readonly connectionState$: Observable<ConnectionState> = {
    subscribe: (fn: (value: ConnectionState) => void) =>
      this._connectionState$.subscribe(fn),
  };

  /**
   * Start a BLE scan and emit each discovered device as it is found.
   *
   * The caller is responsible for calling the returned unsubscribe function
   * (or letting the Subject complete) to stop the scan.
   *
   * @returns An Observable that emits `DiscoveredDevice` objects.
   */
  startScan(): Observable<DiscoveredDevice> {
    const discovered$ = new Subject<DiscoveredDevice>();

    this.ble.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
      if (error) {
        // Propagate scan errors by completing the subject; callers can retry.
        console.warn('[BluetoothManager] Scan error:', error.message);
        discovered$.complete();
        return;
      }
      if (device) {
        discovered$.next({
          id: device.id,
          name: device.name,
          rssi: device.rssi ?? -999,
        });
      }
    });

    // When the caller unsubscribes (zero observers), stop the HW scan.
    // We wrap the Subject so we can intercept the last-unsubscribe.
    const wrapped: Observable<DiscoveredDevice> = {
      subscribe: (fn: (value: DiscoveredDevice) => void) => {
        const unsub = discovered$.subscribe(fn);
        return () => {
          unsub();
          // If no more observers, stop the scan.
          this.ble.stopDeviceScan();
          discovered$.complete();
        };
      },
    };

    return wrapped;
  }

  /**
   * Connect to a BLE device by its platform-assigned ID, discover services,
   * and set up connection-loss monitoring.
   *
   * Emits `'connecting'` → `'connected'` on `connectionState$`.
   * If the connection drops without `disconnect(true)` being called first,
   * a 30-second watchdog timer starts.  When the timer fires without an
   * intentional-disconnect flag being set, `'unexpected_disconnection'` is
   * emitted (Requirement 8.1).
   *
   * @param deviceId - Platform BLE device identifier.
   */
  async connect(deviceId: string): Promise<void> {
    this._intentionalDisconnect = false;

    // Cancel any stale watchdog from a previous session.
    if (this._watchdogTimer !== null) {
      this._clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }

    this._connectionState$.next('connecting');

    try {
      const device = await this.ble.connectToDevice(deviceId, {
        autoConnect: false,
        requestMTU: 512,
      });

      // Discover all GATT services + characteristics before we start using them.
      await device.discoverAllServicesAndCharacteristics();

      // Detect what this specific watch can actually do (not every "compatible"
      // watch exposes the MOYOUNG command channel or a GPS service).
      this.capabilities = await this._detectCapabilities(device);

      this.connectedDeviceId = deviceId;
      this._connectionState$.next('connected');

      // Subscribe to hardware-level disconnection events for this device.
      // The callback fires whenever the OS reports the link has dropped —
      // regardless of whether `disconnect()` was called by the caller.
      this.ble.onDeviceDisconnected(deviceId, (_error, _device) => {
        // Clear the connected device reference and discovered capabilities.
        this.connectedDeviceId = null;
        this.capabilities = null;

        // Always emit 'disconnected' first so observers see the raw state change.
        this._connectionState$.next('disconnected');

        // Only start the watchdog for *unintentional* drops (Requirement 8.4).
        if (!this._intentionalDisconnect) {
          this._watchdogTimer = this._setTimeout(() => {
            this._watchdogTimer = null;
            this._connectionState$.next('unexpected_disconnection');
          }, UNEXPECTED_DISCONNECT_THRESHOLD_MS);
        }
      });
    } catch (err) {
      this._connectionState$.next('disconnected');
      throw err;
    }
  }

  /**
   * Disconnect from the currently connected device.
   *
   * @param intentional - Pass `true` when the user explicitly disconnects
   *   (e.g. via app settings).  Pass `false` or let the default apply when
   *   disconnecting as part of error recovery.  Task 9.2 reads
   *   `_intentionalDisconnect` to classify the resulting disconnection.
   *
   * Requirement 8.4 — intentional disconnects must NOT be classified as
   * unexpected; setting this flag before cancelling ensures that.  Any
   * pending watchdog timer is also cleared immediately.
   */
  async disconnect(intentional: boolean): Promise<void> {
    this._intentionalDisconnect = intentional;

    // If the caller signals an intentional disconnect, cancel any watchdog
    // that may have been started by a preceding disconnection event
    // (e.g. the OS fired first, then the caller calls disconnect(true)).
    if (intentional && this._watchdogTimer !== null) {
      this._clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }

    if (this.connectedDeviceId === null) {
      return; // already disconnected — nothing to do
    }

    const id = this.connectedDeviceId;
    this.connectedDeviceId = null;

    try {
      await this.ble.cancelDeviceConnection(id);
    } finally {
      this._connectionState$.next('disconnected');
    }
  }

  /**
   * Subscribe to validated heart rate samples from the watch.
   *
   * Subscribes to the Bluetooth SIG Heart Rate Measurement characteristic
   * (service `0x180D`, char `0x2A37`) and also sends the MOYOUNG proprietary
   * HR-start command so the watch activates its sensor.
   *
   * HR frame layout (SIG spec):
   *   Byte 0 — flags; bit 0 = 0 means HR value is uint8
   *   Byte 1 — heart rate value (BPM) as uint8
   *   Bytes 2–3 — optional RR-interval (ignored here)
   *
   * @returns Observable of `HeartRateSample`.  Completes when unsubscribed.
   */
  subscribeHeartRate(): Observable<HeartRateSample> {
    const hr$ = new Subject<HeartRateSample>();

    const deviceId = this.connectedDeviceId;
    if (!deviceId) {
      // Emit nothing and complete immediately — caller should check connection first.
      hr$.complete();
      return hr$;
    }

    // Send MOYOUNG HR start command (fire-and-forget; errors are non-fatal here).
    this._sendMoyoungCommand(CMD_HR_START.cmd, CMD_HR_START.subcmd).catch(err =>
      console.warn('[BluetoothManager] HR start command failed:', err),
    );

    // Subscribe to SIG Heart Rate Measurement notifications.
    const subscription = this.ble.monitorCharacteristicForDevice(
      deviceId,
      SIG_HEART_RATE_SERVICE_UUID,
      SIG_HR_MEASUREMENT_UUID,
      (error, characteristic) => {
        if (error) {
          console.warn('[BluetoothManager] HR notification error:', error.message);
          hr$.complete();
          return;
        }
        if (!characteristic?.value) return;

        const bytes = base64ToUint8Array(characteristic.value);
        if (bytes.length < 2) return;

        // Byte 1 is the BPM uint8 (valid for flags bit-0 = 0).
        const bpm = bytes[1];
        hr$.next({
          bpm,
          timestamp: Date.now(),
          source: 'watch',
        });
      },
    );

    // Wrap so unsubscribe tears down the GATT subscription and sends HR stop.
    return {
      subscribe: (fn: (value: HeartRateSample) => void) => {
        const unsub = hr$.subscribe(fn);
        return () => {
          unsub();
          subscription.remove();
          // Best-effort stop command.
          this._sendMoyoungCommand(CMD_HR_STOP.cmd, CMD_HR_STOP.subcmd).catch(() => {});
        };
      },
    };
  }

  /**
   * Subscribe to wrist-presence status notifications from the watch.
   *
   * Sends the MOYOUNG wrist-status request command and subscribes to the
   * proprietary Notify characteristic (`0000fee2…`) to receive responses.
   * Only response frames that match the wrist-status command code are forwarded.
   *
   * @returns Observable of `WristStatus` (`'on-wrist' | 'off-wrist'`).
   */
  subscribeWristStatus(): Observable<WristStatus> {
    const wrist$ = new Subject<WristStatus>();

    const deviceId = this.connectedDeviceId;
    if (!deviceId) {
      wrist$.complete();
      return wrist$;
    }

    // Request the current wrist status.
    this._sendMoyoungCommand(CMD_WRIST_STATUS.cmd, CMD_WRIST_STATUS.subcmd).catch(err =>
      console.warn('[BluetoothManager] Wrist status command failed:', err),
    );

    // Subscribe to the MOYOUNG Notify characteristic for the response.
    const subscription = this.ble.monitorCharacteristicForDevice(
      deviceId,
      MOYOUNG_SERVICE_UUID,
      MOYOUNG_NOTIFY_UUID,
      (error, characteristic) => {
        if (error) {
          console.warn('[BluetoothManager] Wrist notify error:', error.message);
          wrist$.complete();
          return;
        }
        if (!characteristic?.value) return;

        const bytes = base64ToUint8Array(characteristic.value);
        const status = parseMoyoungWristStatus(bytes);
        if (status !== null) {
          wrist$.next(status);
        }
      },
    );

    return {
      subscribe: (fn: (value: WristStatus) => void) => {
        const unsub = wrist$.subscribe(fn);
        return () => {
          unsub();
          subscription.remove();
        };
      },
    };
  }

  /**
   * Request the current GPS fix from the watch.
   *
   * Sends the MOYOUNG GPS request command and waits for a single matching
   * response on the Notify characteristic.  Times out after 10 seconds and
   * resolves to `null` if no valid GPS response is received.
   *
   * @returns Promise resolving to `GpsCoordinates` or `null` if unavailable.
   */
  requestGpsCoordinates(): Promise<GpsCoordinates | null> {
    const deviceId = this.connectedDeviceId;
    if (!deviceId) return Promise.resolve(null);

    return new Promise<GpsCoordinates | null>(resolve => {
      let settled = false;
      let subscription: BleSubscription | null = null;

      const timeoutHandle = setTimeout(() => {
        if (!settled) {
          settled = true;
          subscription?.remove();
          resolve(null);
        }
      }, 10_000);

      subscription = this.ble.monitorCharacteristicForDevice(
        deviceId,
        MOYOUNG_SERVICE_UUID,
        MOYOUNG_NOTIFY_UUID,
        (error, characteristic) => {
          if (settled) return;
          if (error || !characteristic?.value) return;

          const bytes = base64ToUint8Array(characteristic.value);
          const coords = parseMoyoungGpsResponse(bytes);
          if (coords !== null) {
            settled = true;
            clearTimeout(timeoutHandle);
            subscription?.remove();
            resolve(coords);
          }
        },
      );

      // Send the GPS request command after setting up the listener.
      this._sendMoyoungCommand(CMD_GPS_REQUEST.cmd, CMD_GPS_REQUEST.subcmd).catch(err => {
        console.warn('[BluetoothManager] GPS command failed:', err);
        if (!settled) {
          settled = true;
          clearTimeout(timeoutHandle);
          subscription?.remove();
          resolve(null);
        }
      });
    });
  }

  /**
   * Send a text message to the watch's display.
   *
   * Encodes `text` as UTF-8 bytes, wraps them in a MOYOUNG display-message
   * command frame (`0x0F / 0x01`), and writes the frame to the Command Write
   * characteristic without response.
   *
   * Long messages are truncated to fit within a 512-byte MTU minus the 4-byte
   * MOYOUNG header.
   *
   * @param text - The message string to display on the watch face.
   */
  async sendDisplayMessage(text: string): Promise<void> {
    const deviceId = this.connectedDeviceId;
    if (!deviceId) {
      throw new Error('[BluetoothManager] sendDisplayMessage: not connected');
    }

    const MAX_PAYLOAD = 508; // 512 MTU - 4 header bytes
    let payload = encodeUtf8(text);
    if (payload.length > MAX_PAYLOAD) {
      payload = payload.slice(0, MAX_PAYLOAD);
    }

    const frame = buildMoyoungFrame(CMD_DISPLAY_MSG.cmd, CMD_DISPLAY_MSG.subcmd, payload);
    const b64 = uint8ArrayToBase64(frame);

    await this.ble.writeCharacteristicWithoutResponseForDevice(
      deviceId,
      MOYOUNG_SERVICE_UUID,
      MOYOUNG_CMD_WRITE_UUID,
      b64,
    );
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Build and write a MOYOUNG command (no payload) to the Command Write
   * characteristic.
   */
  private async _sendMoyoungCommand(cmd: number, subcmd: number): Promise<void> {
    const deviceId = this.connectedDeviceId;
    if (!deviceId) return;

    const frame = buildMoyoungFrame(cmd, subcmd);
    const b64 = uint8ArrayToBase64(frame);

    await this.ble.writeCharacteristicWithoutResponseForDevice(
      deviceId,
      MOYOUNG_SERVICE_UUID,
      MOYOUNG_CMD_WRITE_UUID,
      b64,
    );
  }

  /**
   * Inspect a connected device's GATT services to determine which features it
   * actually supports.  Falls back to "heart-rate only" if service enumeration
   * is unavailable (e.g. a BLE library/device without a `services()` method),
   * which is the safe minimum assumption.
   */
  private async _detectCapabilities(device: BleDevice): Promise<WatchCapabilities> {
    let uuids: string[] = [];
    try {
      if (typeof device.services === 'function') {
        const services = await device.services();
        uuids = services.map(s => s.uuid.toLowerCase());
      }
    } catch (err) {
      console.warn('[BluetoothManager] service enumeration failed:', err);
    }

    const has = (uuid: string) => uuids.includes(uuid.toLowerCase());

    const caps: WatchCapabilities = {
      // If we could not enumerate at all, assume HR is present (we connected to
      // a watch and the HR subscription will no-op gracefully if it is not).
      heartRate: uuids.length === 0 ? true : has(SIG_HEART_RATE_SERVICE_UUID),
      battery: has(SIG_BATTERY_SERVICE_UUID),
      moyoungCommands: has(MOYOUNG_SERVICE_UUID),
      onboardGps: has(SIG_LOCATION_NAV_SERVICE_UUID),
      serviceUuids: uuids,
    };

    if (!caps.moyoungCommands) {
      console.info(
        '[BluetoothManager] Watch does not expose the MOYOUNG command service; ' +
          'GPS requests, wrist-removal detection, and watch display messages are ' +
          'unavailable on this device. Falling back to phone-side features.',
      );
    }

    return caps;
  }

  /**
   * Capabilities of the currently connected watch, or null while disconnected.
   * Consumers (e.g. MonitoringService) use this to decide which features to wire.
   */
  getCapabilities(): WatchCapabilities | null {
    return this.capabilities;
  }

  /** True while a watch is connected. */
  isConnected(): boolean {
    return this.connectedDeviceId !== null;
  }
}

// ── Factory function ───────────────────────────────────────────────────────────

/**
 * Convenience factory.  In application code import this rather than
 * `new BluetoothManager(...)` directly.
 *
 * Accepts either a plain `BleManagerInterface` (backward-compatible) or a
 * full `BluetoothManagerOptions` bag (e.g. with injected timers for testing).
 *
 * @example
 * ```ts
 * import { BleManager } from 'react-native-ble-plx';
 * import { createBluetoothManager } from './bluetooth/BluetoothManager';
 *
 * // Plain BLE manager (production use):
 * const btManager = createBluetoothManager(new BleManager());
 *
 * // Options bag (test use — inject fake timers):
 * const btManager = createBluetoothManager({ ble: mockBle, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout });
 * ```
 */
export function createBluetoothManager(
  options: BleManagerInterface | BluetoothManagerOptions,
): BluetoothManager {
  return new BluetoothManager(options);
}
