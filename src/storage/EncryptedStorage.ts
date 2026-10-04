/**
 * EncryptedStorage — AES-encrypted key-value store backed by react-native-mmkv.
 *
 * All keys are automatically prefixed with `gbv.` so callers pass only the
 * sub-key (e.g. `'profile'`).
 *
 * ── Encryption key note ─────────────────────────────────────────────────────
 * In production this encryption key MUST be fetched from / stored in the
 * platform's secure enclave:
 *   • Android: Android Keystore (AES-256-GCM, non-exportable, device-bound)
 *   • iOS: Keychain Services with kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
 *
 * The static constant below is a placeholder for the pure-TypeScript layer.
 * Replace it with a native module call (e.g. `react-native-keychain` or a
 * custom Turbo Module) before shipping to users.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Requirements: 11.1
 */

import {MMKV} from 'react-native-mmkv';

// ── Encryption key placeholder ────────────────────────────────────────────────
// TODO: Replace with a call to Android Keystore / iOS Keychain native module
//       so the key never lives in JS memory in production.
const ENCRYPTION_KEY_PLACEHOLDER =
  'gbv-safety-watch-aes256-placeholder-key-replace-in-prod';

// ── Key prefix ────────────────────────────────────────────────────────────────
const KEY_PREFIX = 'gbv.';

// ── MMKV instance (module-level singleton) ────────────────────────────────────
// Lazily initialised so the module can be imported in unit tests before
// react-native-mmkv is available (the Jest mock replaces the constructor).
let _mmkv: MMKV | null = null;

function getMMKV(): MMKV {
  if (!_mmkv) {
    _mmkv = new MMKV({
      id: 'gbv-storage',
      encryptionKey: ENCRYPTION_KEY_PLACEHOLDER,
    });
  }
  return _mmkv;
}

// ── Exported interface ────────────────────────────────────────────────────────

export interface EncryptedStorageInterface {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Prepend the `gbv.` namespace prefix to the caller-supplied sub-key.
 */
function prefixed(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

/**
 * Store a string value under the given sub-key (prefixed with `gbv.`).
 */
export async function set(key: string, value: string): Promise<void> {
  getMMKV().set(prefixed(key), value);
}

/**
 * Retrieve the string value stored under the given sub-key, or `null` if
 * it does not exist.
 */
export async function get(key: string): Promise<string | null> {
  const value = getMMKV().getString(prefixed(key));
  return value !== undefined ? value : null;
}

/**
 * Delete the entry for the given sub-key. No-op if the key does not exist.
 */
export async function remove(key: string): Promise<void> {
  getMMKV().delete(prefixed(key));
}

/**
 * Delete **only** the keys that belong to this app's namespace (`gbv.*`).
 * This does NOT wipe unrelated data that may share the same MMKV instance.
 * Used by the "Delete All Personal Data" feature (Requirement 11.4).
 */
export async function clear(): Promise<void> {
  const mmkv = getMMKV();
  const allKeys = mmkv.getAllKeys();
  for (const k of allKeys) {
    if (k.startsWith(KEY_PREFIX)) {
      mmkv.delete(k);
    }
  }
}

// ── Default export: object implementing EncryptedStorageInterface ─────────────

const EncryptedStorage: EncryptedStorageInterface = {set, get, remove, clear};
export default EncryptedStorage;

// ── Internal test helper (used by unit tests only) ────────────────────────────
// Resets the singleton so tests can inject a fresh mock between test cases.
export function _resetInstanceForTesting(): void {
  _mmkv = null;
}
