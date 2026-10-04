/**
 * Smoke tests for EncryptedStorage wrapper.
 *
 * Because react-native-mmkv uses native modules unavailable in Jest, the
 * module is mocked via jest.mock() below. The mock faithfully reproduces the
 * MMKV API surface used by EncryptedStorage (set / getString / delete /
 * getAllKeys) so we can verify the wrapper's own logic without native code.
 *
 * Requirements: 11.1
 */

// ── Mock react-native-mmkv before importing the module under test ─────────────

// In-memory store shared across all MMKV instances created in a test run.
// Prefixed with `mock` so Jest permits referencing it from the hoisted factory.
const mockStore: Map<string, string> = new Map();

// Shared mock instance method spies. Prefixed with `mock` for the same reason.
const mockInstanceMethods = {
  set: jest.fn((key: string, value: string) => {
    mockStore.set(key, value);
  }),
  getString: jest.fn((key: string): string | undefined => {
    return mockStore.get(key);
  }),
  delete: jest.fn((key: string) => {
    mockStore.delete(key);
  }),
  getAllKeys: jest.fn((): string[] => {
    return Array.from(mockStore.keys());
  }),
};

// Records the config object passed to each `new MMKV(config)` invocation, so
// tests can assert the encryptionKey without relying on a jest.fn constructor
// (which does not survive Babel's class/`new` interop reliably).
const mockConstructorCalls: Array<{encryptionKey?: string} | undefined> = [];

jest.mock('react-native-mmkv', () => {
  // Define MMKV as a real constructor so `new MMKV(...)` works under Babel's
  // commonjs/class interop. Each instance exposes the shared method spies.
  class MMKV {
    constructor(config?: {encryptionKey?: string}) {
      mockConstructorCalls.push(config);
    }
    set = mockInstanceMethods.set;
    getString = mockInstanceMethods.getString;
    delete = mockInstanceMethods.delete;
    getAllKeys = mockInstanceMethods.getAllKeys;
  }
  return {MMKV};
});

// Convenience alias for the shared instance-method spies.
const mockMMKVInstance = mockInstanceMethods;

// ── Import module under test after mock is set up ─────────────────────────────

import EncryptedStorage, {
  set,
  get,
  remove,
  clear,
  _resetInstanceForTesting,
} from '../EncryptedStorage';

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetAll() {
  mockStore.clear();
  mockConstructorCalls.length = 0;
  jest.clearAllMocks();
  _resetInstanceForTesting();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EncryptedStorage', () => {
  beforeEach(resetAll);

  // ── 1. Init ──────────────────────────────────────────────────────────────────

  describe('initialisation', () => {
    it('initialises (creates MMKV instance) without throwing', async () => {
      // Triggering any operation causes the lazy singleton to be created.
      await expect(get('probe')).resolves.not.toThrow();
      expect(mockConstructorCalls).toHaveLength(1);
    });

    it('passes encryptionKey to the MMKV constructor', async () => {
      await get('probe');
      const constructorArg = mockConstructorCalls[0] as {
        encryptionKey?: string;
      };
      expect(constructorArg).toHaveProperty('encryptionKey');
      expect(typeof constructorArg.encryptionKey).toBe('string');
      expect(constructorArg.encryptionKey!.length).toBeGreaterThan(0);
    });

    it('reuses the same MMKV instance across multiple calls (singleton)', async () => {
      await get('a');
      await set('b', 'val');
      // Both calls should hit the same constructor invocation — only once.
      expect(mockConstructorCalls).toHaveLength(1);
    });
  });

  // ── 2. set / get round-trip ───────────────────────────────────────────────

  describe('set / get round-trip', () => {
    it('stores and retrieves a string value', async () => {
      await set('profile', '{"name":"Alice"}');
      const result = await get('profile');
      expect(result).toBe('{"name":"Alice"}');
    });

    it('prefixes the key with "gbv." before passing it to MMKV', async () => {
      await set('contacts', '[]');
      expect(mockMMKVInstance.set).toHaveBeenCalledWith('gbv.contacts', '[]');
    });

    it('uses "gbv." prefix when reading via get', async () => {
      await set('alert_log', '[{}]');
      await get('alert_log');
      expect(mockMMKVInstance.getString).toHaveBeenCalledWith('gbv.alert_log');
    });

    it('returns null for a key that has never been set', async () => {
      const result = await get('nonexistent');
      expect(result).toBeNull();
    });

    it('overwrites a value when set is called again with the same key', async () => {
      await set('session', 'first');
      await set('session', 'second');
      const result = await get('session');
      expect(result).toBe('second');
    });

    it('works via the default export object', async () => {
      await EncryptedStorage.set('onboarding', 'true');
      const result = await EncryptedStorage.get('onboarding');
      expect(result).toBe('true');
    });
  });

  // ── 3. remove ────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('makes get return null after the key is removed', async () => {
      await set('profile', 'data');
      await remove('profile');
      const result = await get('profile');
      expect(result).toBeNull();
    });

    it('calls MMKV.delete with the prefixed key', async () => {
      await remove('hr_baseline');
      expect(mockMMKVInstance.delete).toHaveBeenCalledWith('gbv.hr_baseline');
    });

    it('is a no-op when the key does not exist (does not throw)', async () => {
      await expect(remove('does_not_exist')).resolves.toBeUndefined();
    });
  });

  // ── 4. clear ─────────────────────────────────────────────────────────────

  describe('clear', () => {
    it('removes all gbv.* keys', async () => {
      await set('profile', 'p');
      await set('contacts', 'c');
      await set('alert_log', 'a');

      await clear();

      expect(await get('profile')).toBeNull();
      expect(await get('contacts')).toBeNull();
      expect(await get('alert_log')).toBeNull();
    });

    it('does NOT remove keys that do not start with "gbv."', async () => {
      // Manually inject a non-gbv key directly into the mock store.
      mockStore.set('other_app_key', 'should_survive');

      await set('profile', 'p');
      await clear();

      // The non-gbv key must still be present in the underlying store.
      expect(mockStore.has('other_app_key')).toBe(true);
    });

    it('leaves storage empty (no gbv.* keys) after being called on a populated store', async () => {
      await set('profile', 'p');
      await set('contacts', 'c');
      await clear();

      const remaining = mockMMKVInstance
        .getAllKeys()
        .filter((k: string) => k.startsWith('gbv.'));
      expect(remaining).toHaveLength(0);
    });

    it('is idempotent — calling clear twice does not throw', async () => {
      await set('profile', 'p');
      await clear();
      await expect(clear()).resolves.toBeUndefined();
    });
  });
});
