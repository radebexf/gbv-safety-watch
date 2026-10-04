/**
 * Unit tests for EmergencyContactRepository.
 *
 * Covers:
 *   - add: happy path, validation failures, duplicate phone, max-contacts limit
 *   - update: happy path, validation failures, duplicate phone, not-found
 *   - remove: happy path, last-contact rejection, not-found
 *   - persistence: contacts survive across repo instances (storage round-trip)
 *   - test SMS: fire-and-forget on add (regardless of SMS failure)
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.7, 4.8
 */

// ── Mock react-native-mmkv so EncryptedStorage can be imported in Jest ────────

const mockStore: Map<string, string> = new Map();

const mockMMKVInstance = {
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

jest.mock('react-native-mmkv', () => ({
  MMKV: jest.fn(() => mockMMKVInstance),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  createEmergencyContactRepository,
  EmergencyContactRepository,
  SendSmsFn,
} from '../EmergencyContactRepository';
import {_resetInstanceForTesting} from '../../storage/EncryptedStorage';
import EncryptedStorage from '../../storage/EncryptedStorage';
import type {EmergencyContact} from '../../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetStorage(): void {
  mockStore.clear();
  jest.clearAllMocks();
  // Re-bind the mock fns to the fresh store
  mockMMKVInstance.set.mockImplementation((k: string, v: string) =>
    mockStore.set(k, v),
  );
  mockMMKVInstance.getString.mockImplementation(
    (k: string): string | undefined => mockStore.get(k),
  );
  mockMMKVInstance.delete.mockImplementation((k: string) =>
    mockStore.delete(k),
  );
  mockMMKVInstance.getAllKeys.mockImplementation(() =>
    Array.from(mockStore.keys()),
  );
  _resetInstanceForTesting();
}

/** Adds N contacts and returns the resulting EmergencyContact records. */
async function seedContacts(
  repo: EmergencyContactRepository,
  count: number,
): Promise<EmergencyContact[]> {
  const contacts: EmergencyContact[] = [];
  for (let i = 0; i < count; i++) {
    const result = await repo.add({
      name: `Contact ${i + 1}`,
      phoneNumber: `+2782100000${i}`,
    });
    if (!result.ok) {
      throw new Error(`Seed failed for contact ${i + 1}: ${result.error}`);
    }
    contacts.push(result.value);
  }
  return contacts;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EmergencyContactRepository', () => {
  let repo: EmergencyContactRepository;
  let smsMock: jest.MockedFunction<SendSmsFn>;

  beforeEach(() => {
    resetStorage();
    smsMock = jest.fn().mockResolvedValue(undefined);
    repo = createEmergencyContactRepository(EncryptedStorage, smsMock);
  });

  // ── getAll ──────────────────────────────────────────────────────────────────

  describe('getAll', () => {
    it('returns an empty array when no contacts have been saved', async () => {
      const contacts = await repo.getAll();
      expect(contacts).toEqual([]);
    });

    it('returns all previously saved contacts', async () => {
      await repo.add({name: 'Alice', phoneNumber: '+27821000001'});
      await repo.add({name: 'Bob', phoneNumber: '+27821000002'});
      const contacts = await repo.getAll();
      expect(contacts).toHaveLength(2);
      expect(contacts.map(c => c.name)).toEqual(
        expect.arrayContaining(['Alice', 'Bob']),
      );
    });
  });

  // ── add ─────────────────────────────────────────────────────────────────────

  describe('add', () => {
    it('adds a valid contact and returns it with an id', async () => {
      const result = await repo.add({
        name: 'Jane Doe',
        phoneNumber: '+27821234567',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.name).toBe('Jane Doe');
      expect(result.value.phoneNumber).toBe('+27821234567');
      expect(typeof result.value.id).toBe('string');
      expect(result.value.id.length).toBeGreaterThan(0);
    });

    it('persists the contact so getAll returns it', async () => {
      await repo.add({name: 'Jane', phoneNumber: '+27821234567'});
      const all = await repo.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe('Jane');
    });

    it('trims whitespace from the name', async () => {
      const result = await repo.add({
        name: '  Alice  ',
        phoneNumber: '+27821234567',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('Alice');
      }
    });

    it('fires a test SMS after adding a contact', async () => {
      await repo.add({name: 'Jane', phoneNumber: '+27821234567'});
      // Wait for the fire-and-forget SMS promise to settle
      await Promise.resolve();
      expect(smsMock).toHaveBeenCalledTimes(1);
      expect(smsMock).toHaveBeenCalledWith(
        '+27821234567',
        expect.stringContaining('Jane'),
      );
    });

    it('still saves the contact even when the SMS function throws', async () => {
      smsMock.mockRejectedValue(new Error('SMS network error'));
      const result = await repo.add({
        name: 'Jane',
        phoneNumber: '+27821234567',
      });
      expect(result.ok).toBe(true);
      await Promise.resolve(); // allow rejection to be handled
      const all = await repo.getAll();
      expect(all).toHaveLength(1);
    });

    // ── Validation failures ───────────────────────────────────────────────────

    it('returns VALIDATION_FAILED when name is empty', async () => {
      const result = await repo.add({name: '', phoneNumber: '+27821234567'});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('VALIDATION_FAILED');
      }
    });

    it('returns VALIDATION_FAILED when name is only whitespace', async () => {
      const result = await repo.add({name: '   ', phoneNumber: '+27821234567'});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('VALIDATION_FAILED');
      }
    });

    it('returns VALIDATION_FAILED when name exceeds 100 characters', async () => {
      const result = await repo.add({
        name: 'A'.repeat(101),
        phoneNumber: '+27821234567',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('VALIDATION_FAILED');
      }
    });

    it('accepts a name of exactly 100 characters', async () => {
      const result = await repo.add({
        name: 'A'.repeat(100),
        phoneNumber: '+27821234567',
      });
      expect(result.ok).toBe(true);
    });

    it('returns VALIDATION_FAILED for a phone number with too few digits', async () => {
      const result = await repo.add({name: 'Alice', phoneNumber: '12345'});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('VALIDATION_FAILED');
      }
    });

    it('returns VALIDATION_FAILED for a phone number with too many digits', async () => {
      const result = await repo.add({
        name: 'Alice',
        phoneNumber: '1234567890123456',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('VALIDATION_FAILED');
      }
    });

    it('returns VALIDATION_FAILED for a phone number containing letters', async () => {
      const result = await repo.add({
        name: 'Alice',
        phoneNumber: '+2782ABC4567',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('VALIDATION_FAILED');
      }
    });

    it('accepts a phone number without the leading +', async () => {
      const result = await repo.add({
        name: 'Alice',
        phoneNumber: '0821234567',
      });
      expect(result.ok).toBe(true);
    });

    it('accepts a phone number with 7 digits (minimum)', async () => {
      const result = await repo.add({
        name: 'Alice',
        phoneNumber: '1234567',
      });
      expect(result.ok).toBe(true);
    });

    it('accepts a phone number with 15 digits (maximum)', async () => {
      const result = await repo.add({
        name: 'Alice',
        phoneNumber: '123456789012345',
      });
      expect(result.ok).toBe(true);
    });

    // ── Max contacts ──────────────────────────────────────────────────────────

    it('returns VALIDATION_FAILED when attempting to add a 6th contact', async () => {
      await seedContacts(repo, 5);
      const result = await repo.add({
        name: 'Sixth',
        phoneNumber: '+27821000099',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('VALIDATION_FAILED');
      }
    });

    it('allows exactly 5 contacts to be added', async () => {
      const contacts = await seedContacts(repo, 5);
      expect(contacts).toHaveLength(5);
      const all = await repo.getAll();
      expect(all).toHaveLength(5);
    });

    // ── Duplicate phone ───────────────────────────────────────────────────────

    it('returns DUPLICATE_PHONE when adding a contact with an existing phone number', async () => {
      await repo.add({name: 'Alice', phoneNumber: '+27821234567'});
      const result = await repo.add({
        name: 'Different Name',
        phoneNumber: '+27821234567',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('DUPLICATE_PHONE');
      }
    });
  });

  // ── update ──────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates the name of an existing contact', async () => {
      const added = (
        await repo.add({name: 'Old Name', phoneNumber: '+27821234567'})
      ) as {ok: true; value: EmergencyContact};
      const result = await repo.update(added.value.id, {name: 'New Name'});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('New Name');
        expect(result.value.phoneNumber).toBe('+27821234567');
      }
    });

    it('updates the phone number of an existing contact', async () => {
      const added = (
        await repo.add({name: 'Alice', phoneNumber: '+27821234567'})
      ) as {ok: true; value: EmergencyContact};
      const result = await repo.update(added.value.id, {
        phoneNumber: '+27829999999',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.phoneNumber).toBe('+27829999999');
      }
    });

    it('persists the update so getAll reflects the change', async () => {
      const added = (
        await repo.add({name: 'Alice', phoneNumber: '+27821234567'})
      ) as {ok: true; value: EmergencyContact};
      await repo.update(added.value.id, {name: 'Alice Updated'});
      const all = await repo.getAll();
      expect(all[0].name).toBe('Alice Updated');
    });

    it('returns VALIDATION_FAILED when updating name to empty string', async () => {
      const added = (
        await repo.add({name: 'Alice', phoneNumber: '+27821234567'})
      ) as {ok: true; value: EmergencyContact};
      const result = await repo.update(added.value.id, {name: ''});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('VALIDATION_FAILED');
      }
    });

    it('returns VALIDATION_FAILED when updating phone to an invalid format', async () => {
      const added = (
        await repo.add({name: 'Alice', phoneNumber: '+27821234567'})
      ) as {ok: true; value: EmergencyContact};
      const result = await repo.update(added.value.id, {phoneNumber: 'abc'});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('VALIDATION_FAILED');
      }
    });

    it('returns DUPLICATE_PHONE when updating to a phone already used by another contact', async () => {
      const a1 = (
        await repo.add({name: 'Alice', phoneNumber: '+27821111111'})
      ) as {ok: true; value: EmergencyContact};
      await repo.add({name: 'Bob', phoneNumber: '+27822222222'});
      const result = await repo.update(a1.value.id, {
        phoneNumber: '+27822222222',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('DUPLICATE_PHONE');
      }
    });

    it('allows updating a contact with its own existing phone number', async () => {
      const added = (
        await repo.add({name: 'Alice', phoneNumber: '+27821234567'})
      ) as {ok: true; value: EmergencyContact};
      const result = await repo.update(added.value.id, {
        name: 'Alice Updated',
        phoneNumber: '+27821234567',
      });
      expect(result.ok).toBe(true);
    });

    it('returns VALIDATION_FAILED when the id does not exist', async () => {
      const result = await repo.update('non-existent-id', {name: 'Ghost'});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('VALIDATION_FAILED');
      }
    });
  });

  // ── remove ──────────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('removes a contact when more than one exists', async () => {
      const contacts = await seedContacts(repo, 2);
      const result = await repo.remove(contacts[0].id);
      expect(result.ok).toBe(true);
      const all = await repo.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(contacts[1].id);
    });

    it('persists the removal so getAll no longer returns the contact', async () => {
      const contacts = await seedContacts(repo, 3);
      await repo.remove(contacts[1].id);
      const all = await repo.getAll();
      expect(all.map(c => c.id)).not.toContain(contacts[1].id);
    });

    it('returns LAST_CONTACT_REMOVAL when trying to remove the only contact', async () => {
      await seedContacts(repo, 1);
      const all = await repo.getAll();
      const result = await repo.remove(all[0].id);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('LAST_CONTACT_REMOVAL');
      }
    });

    it('does not remove anything when LAST_CONTACT_REMOVAL is rejected', async () => {
      await seedContacts(repo, 1);
      const before = await repo.getAll();
      await repo.remove(before[0].id);
      const after = await repo.getAll();
      expect(after).toHaveLength(1);
    });

    it('returns VALIDATION_FAILED when the id does not exist', async () => {
      await seedContacts(repo, 2);
      const result = await repo.remove('non-existent-id');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('VALIDATION_FAILED');
      }
    });
  });

  // ── Persistence across instances ─────────────────────────────────────────────

  describe('persistence across repo instances', () => {
    it('contacts added via one instance are visible via a second instance (storage round-trip)', async () => {
      // Add a contact with repo instance 1
      await repo.add({name: 'Persistent Alice', phoneNumber: '+27821234567'});

      // Create a second repo instance backed by the same storage
      const repo2 = createEmergencyContactRepository(
        EncryptedStorage,
        smsMock,
      );
      const contacts = await repo2.getAll();
      expect(contacts).toHaveLength(1);
      expect(contacts[0].name).toBe('Persistent Alice');
    });

    it('removal via one instance is reflected in a second instance', async () => {
      const seeded = await seedContacts(repo, 2);

      const repo2 = createEmergencyContactRepository(
        EncryptedStorage,
        smsMock,
      );
      await repo2.remove(seeded[0].id);

      const repo3 = createEmergencyContactRepository(
        EncryptedStorage,
        smsMock,
      );
      const contacts = await repo3.getAll();
      expect(contacts).toHaveLength(1);
      expect(contacts[0].id).toBe(seeded[1].id);
    });
  });
});
