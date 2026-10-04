/**
 * BluetoothTestScreen
 *
 * A manual BLE smoke-test screen for pairing with the MOYOUNG / Da Fit
 * smartwatch (e.g. firmware MOY-LXC3-2.0.3, advertised as "Fit Fuel"/"GPS").
 *
 * Flow:
 *   1. Request runtime Bluetooth (+ location on Android <12) permissions.
 *   2. Scan for nearby BLE peripherals; list them by name + RSSI.
 *   3. Tap a device to connect via BluetoothManager.connect().
 *   4. On connect, subscribe to the SIG Heart Rate characteristic and show
 *      live BPM samples streaming from the watch.
 *
 * This screen is intentionally self-contained and dependency-light so it can
 * be dropped into App.tsx for a first real-device connection test. It drives
 * the already-implemented BluetoothManager (MOYOUNG V2 protocol) directly.
 *
 * NOTE: react-native-ble-plx is a native module. It only works in a native
 * build on a physical device (iOS requires a Mac/Xcode build; Android builds
 * on any OS). BleManager is lazy-loaded so the rest of the app still renders
 * if the native module is unavailable (e.g. in a JS-only context).
 */

import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  PermissionsAndroid,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import {
  BluetoothManager,
  createBluetoothManager,
  type BleManagerInterface,
  type DiscoveredDevice,
} from '../bluetooth/BluetoothManager';
import type {ConnectionState, HeartRateSample} from '../types';

// ── Native module lazy loader ────────────────────────────────────────────────

/**
 * Lazily require react-native-ble-plx's BleManager. Returns null if the native
 * module cannot be loaded (keeps the screen from crashing in a JS-only env).
 */
function tryCreateBleManager(): BleManagerInterface | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {BleManager} = require('react-native-ble-plx');
    return new BleManager() as BleManagerInterface;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[BluetoothTestScreen] BleManager unavailable:', err);
    return null;
  }
}

// ── Android runtime permission request ───────────────────────────────────────

/**
 * Request the runtime permissions needed to scan + connect over BLE on Android.
 * On iOS, Bluetooth permission is requested automatically by the OS on first
 * use (prompt text comes from Info.plist), so this resolves true immediately.
 */
async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }

  // Android 12+ (API 31+) uses the new BLUETOOTH_SCAN / BLUETOOTH_CONNECT model.
  // Older versions require ACCESS_FINE_LOCATION to perform a BLE scan.
  const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10);

  const perms: string[] =
    apiLevel >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

  try {
    const granted = await PermissionsAndroid.requestMultiple(perms as any);
    return perms.every(
      p => (granted as Record<string, string>)[p] === PermissionsAndroid.RESULTS.GRANTED,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[BluetoothTestScreen] permission request failed:', err);
    return false;
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

type Phase = 'idle' | 'scanning' | 'connecting' | 'connected' | 'error';

export default function BluetoothTestScreen(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState<string>('Ready to scan.');
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState | null>(null);
  const [latestBpm, setLatestBpm] = useState<number | null>(null);
  const [sampleCount, setSampleCount] = useState<number>(0);
  const [log, setLog] = useState<string[]>([]);

  const managerRef = useRef<BluetoothManager | null>(null);
  const scanUnsubRef = useRef<(() => void) | null>(null);
  const hrUnsubRef = useRef<(() => void) | null>(null);
  const connStateUnsubRef = useRef<(() => void) | null>(null);

  const addLog = useCallback((line: string) => {
    const stamp = new Date().toLocaleTimeString();
    setLog(prev => [`[${stamp}] ${line}`, ...prev].slice(0, 50));
  }, []);

  /** Lazily build (once) the BluetoothManager backed by the native BleManager. */
  const getManager = useCallback((): BluetoothManager | null => {
    if (managerRef.current) {
      return managerRef.current;
    }
    const ble = tryCreateBleManager();
    if (!ble) {
      return null;
    }
    const mgr = createBluetoothManager(ble);
    managerRef.current = mgr;

    // Observe connection state transitions for the whole lifetime of the manager.
    connStateUnsubRef.current = mgr.connectionState$.subscribe(state => {
      setConnectionState(state);
      addLog(`connection state → ${state}`);
      if (state === 'unexpected_disconnection') {
        setPhase('error');
        setStatus('Watch disconnected unexpectedly.');
      }
    });

    return mgr;
  }, [addLog]);

  // ── Scan ───────────────────────────────────────────────────────────────────

  const handleScan = useCallback(async () => {
    setDevices([]);
    setStatus('Requesting permissions…');

    const ok = await requestBlePermissions();
    if (!ok) {
      setPhase('error');
      setStatus('Bluetooth permission denied. Enable it in Settings to scan.');
      return;
    }

    const mgr = getManager();
    if (!mgr) {
      setPhase('error');
      setStatus(
        'BLE native module not available. This requires a native build on a physical device (iOS: Mac + Xcode; Android: npm run android).',
      );
      return;
    }

    setPhase('scanning');
    setStatus('Scanning for nearby devices… look for "Fit Fuel" / "GPS".');
    addLog('scan started');

    // Stop any prior scan subscription.
    scanUnsubRef.current?.();

    const seen = new Map<string, DiscoveredDevice>();
    scanUnsubRef.current = mgr.startScan().subscribe(device => {
      // De-dupe by id, keep the most recent RSSI.
      seen.set(device.id, device);
      setDevices(Array.from(seen.values()).sort((a, b) => b.rssi - a.rssi));
    });
  }, [addLog, getManager]);

  const stopScan = useCallback(() => {
    scanUnsubRef.current?.();
    scanUnsubRef.current = null;
  }, []);

  // ── Connect ──────────────────────────────────────────────────────────────────

  const handleConnect = useCallback(
    async (device: DiscoveredDevice) => {
      const mgr = getManager();
      if (!mgr) {
        return;
      }

      stopScan();
      setPhase('connecting');
      setStatus(`Connecting to ${device.name ?? device.id}…`);
      addLog(`connecting to ${device.name ?? '(unnamed)'} [${device.id}]`);

      try {
        await mgr.connect(device.id);
        setPhase('connected');
        setStatus(`Connected to ${device.name ?? device.id}. Subscribing to heart rate…`);
        addLog('connected; subscribing to heart rate');

        // Subscribe to live heart-rate samples from the watch.
        hrUnsubRef.current?.();
        hrUnsubRef.current = mgr
          .subscribeHeartRate()
          .subscribe((s: HeartRateSample) => {
            setLatestBpm(s.bpm);
            setSampleCount(c => c + 1);
          });
      } catch (err) {
        setPhase('error');
        const msg = err instanceof Error ? err.message : String(err);
        setStatus(`Connection failed: ${msg}`);
        addLog(`connect error: ${msg}`);
      }
    },
    [addLog, getManager, stopScan],
  );

  // ── Disconnect ───────────────────────────────────────────────────────────────

  const handleDisconnect = useCallback(async () => {
    const mgr = managerRef.current;
    hrUnsubRef.current?.();
    hrUnsubRef.current = null;
    if (mgr) {
      try {
        await mgr.disconnect(true /* intentional */);
      } catch {
        // ignore — already disconnected
      }
    }
    setPhase('idle');
    setStatus('Disconnected. Ready to scan.');
    setLatestBpm(null);
    setSampleCount(0);
    addLog('user disconnected');
  }, [addLog]);

  // Clean up every subscription on unmount.
  useEffect(() => {
    return () => {
      scanUnsubRef.current?.();
      hrUnsubRef.current?.();
      connStateUnsubRef.current?.();
    };
  }, []);

  // ── Render helpers ─────────────────────────────────────────────────────────

  const isBusy = phase === 'scanning' || phase === 'connecting';
  const isConnected = phase === 'connected';

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Bluetooth Watch Test</Text>
        <Text style={styles.subtitle}>MOYOUNG / Da Fit · live heart rate</Text>

        {/* Status banner */}
        <View style={styles.statusBox}>
          <Text style={styles.statusText}>{status}</Text>
          {connectionState ? (
            <Text style={styles.connState}>BLE state: {connectionState}</Text>
          ) : null}
        </View>

        {/* Primary actions */}
        <View style={styles.actions}>
          {!isConnected ? (
            <TouchableOpacity
              style={[styles.button, isBusy && styles.buttonDisabled]}
              onPress={handleScan}
              disabled={isBusy}>
              <Text style={styles.buttonText}>
                {phase === 'scanning' ? 'Scanning…' : 'Scan for watch'}
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.button, styles.buttonDanger]}
              onPress={handleDisconnect}>
              <Text style={styles.buttonText}>Disconnect</Text>
            </TouchableOpacity>
          )}
          {phase === 'scanning' ? (
            <TouchableOpacity style={styles.buttonGhost} onPress={() => {
              stopScan();
              setPhase('idle');
              setStatus('Scan stopped.');
            }}>
              <Text style={styles.buttonGhostText}>Stop</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {isBusy ? <ActivityIndicator style={styles.spinner} /> : null}

        {/* Live heart rate (when connected) */}
        {isConnected ? (
          <View style={styles.hrBox}>
            <Text style={styles.hrLabel}>Live Heart Rate</Text>
            <Text style={styles.hrValue}>
              {latestBpm !== null ? `${latestBpm}` : '—'}
              <Text style={styles.hrUnit}> bpm</Text>
            </Text>
            <Text style={styles.hrMeta}>{sampleCount} samples received</Text>
            {latestBpm === null ? (
              <Text style={styles.hrHint}>
                Waiting for the watch to stream HR data. Make sure the watch is on
                your wrist and HR monitoring is enabled.
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* Discovered device list */}
        {!isConnected && devices.length > 0 ? (
          <View style={styles.listBox}>
            <Text style={styles.listHeader}>
              Discovered devices ({devices.length}) — tap to connect
            </Text>
            <FlatList
              scrollEnabled={false}
              data={devices}
              keyExtractor={item => item.id}
              renderItem={({item}) => (
                <TouchableOpacity
                  style={styles.deviceRow}
                  onPress={() => handleConnect(item)}>
                  <View style={styles.deviceInfo}>
                    <Text style={styles.deviceName}>
                      {item.name ?? '(unnamed device)'}
                    </Text>
                    <Text style={styles.deviceId}>{item.id}</Text>
                  </View>
                  <Text style={styles.deviceRssi}>{item.rssi} dBm</Text>
                </TouchableOpacity>
              )}
            />
          </View>
        ) : null}

        {/* Event log */}
        <View style={styles.logBox}>
          <Text style={styles.logHeader}>Event log</Text>
          {log.length === 0 ? (
            <Text style={styles.logEmpty}>No events yet.</Text>
          ) : (
            log.map((line, i) => (
              <Text key={i} style={styles.logLine}>
                {line}
              </Text>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: '#0f1115'},
  container: {padding: 20, paddingBottom: 48},
  title: {fontSize: 24, fontWeight: '700', color: '#fff', textAlign: 'center'},
  subtitle: {
    fontSize: 13,
    color: '#8a93a2',
    textAlign: 'center',
    marginTop: 2,
    marginBottom: 18,
  },
  statusBox: {
    backgroundColor: '#1a1e27',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },
  statusText: {color: '#e6e9ef', fontSize: 14, lineHeight: 20},
  connState: {color: '#6ea8fe', fontSize: 12, marginTop: 6},
  actions: {flexDirection: 'row', gap: 12, marginBottom: 12},
  button: {
    flex: 1,
    backgroundColor: '#2f6fed',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonDanger: {backgroundColor: '#d64545'},
  buttonDisabled: {opacity: 0.5},
  buttonText: {color: '#fff', fontSize: 16, fontWeight: '600'},
  buttonGhost: {
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#3a4150',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonGhostText: {color: '#c3cad6', fontSize: 15, fontWeight: '600'},
  spinner: {marginVertical: 8},
  hrBox: {
    backgroundColor: '#161b22',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#243040',
  },
  hrLabel: {color: '#8a93a2', fontSize: 13, textTransform: 'uppercase', letterSpacing: 1},
  hrValue: {color: '#ff5a7a', fontSize: 56, fontWeight: '800', marginTop: 4},
  hrUnit: {fontSize: 20, fontWeight: '600', color: '#8a93a2'},
  hrMeta: {color: '#6ea8fe', fontSize: 12, marginTop: 2},
  hrHint: {color: '#8a93a2', fontSize: 12, textAlign: 'center', marginTop: 10, lineHeight: 18},
  listBox: {marginBottom: 16},
  listHeader: {color: '#c3cad6', fontSize: 13, marginBottom: 8},
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1a1e27',
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  deviceInfo: {flex: 1, paddingRight: 10},
  deviceName: {color: '#fff', fontSize: 15, fontWeight: '600'},
  deviceId: {color: '#6b7280', fontSize: 11, marginTop: 2},
  deviceRssi: {color: '#6ea8fe', fontSize: 13, fontWeight: '600'},
  logBox: {
    backgroundColor: '#12151c',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#1f2630',
  },
  logHeader: {color: '#c3cad6', fontSize: 13, marginBottom: 8},
  logEmpty: {color: '#6b7280', fontSize: 12},
  logLine: {color: '#8a93a2', fontSize: 11, lineHeight: 17, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace'},
});
