/**
 * EmergencyContactRepository
 *
 * Encrypted CRUD store for emergency contacts.  All contact records are
 * persisted under the `gbv.contacts` key via EncryptedStorage.
 *
 * Validation rules (Requirements 4.1, 4.2):
 *   • name   : 1–100 characters (non-empty after trim)
 *   • phone  : matches /^\+?[0-9]{7,15}$/
 *
 * Business rules:
 *   • Max 5 contacts (Requirement 4.1)
 *   • Duplicate phone numbers are rejected (Requirement 4.5)
 *   • Removing the last contact is rejected (Requirement 4.3)
 *   • A test SMS is sent (fire-and-forget) when a contact is added (Requirement 4.7)
 *   • Records survive app restarts via encrypted persistent storage (Requirement 4.8)
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.7, 4.8
 */

import type {
  EmergencyContact,
  NewContact,
  ContactError,
  Result,
} from '../types';
import EncryptedStorage, {
  EncryptedStorageInterface,
} from '../storage/EncryptedStorage';

// ── Constants ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'contacts'; // becomes 'gbv.contacts' after prefix
const MAX_CONTACTS = 5;

/** Matches an optional '+' followed by 7–15 digits (E.164-ish). */
const PHONE_REGEX = /^\+?[0-9]{7,15}$/;

// ── UUID generator ────────────────────────────────────────────────────────────

/**
 * Generates a UUID v4.  Uses `crypto.randomUUID()` when available (Node ≥ 14.17,
 * React Native with Hermes ≥ 0.70), otherwise falls back to a manual implementation.
 */
function generateUUID(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }

  // Manual UUID v4 fallback using Math.random()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── SMS send stub (fire-and-forget) ───────────────────────────────────────────

/**
 * Type for the injected SMS function.  The default implementation is a no-op
 * that logs to the console.  In production this would be replaced by a call to
 * the native SmsManager / MFMessageComposeViewController module.
 */
export type SendSmsFn = (phoneNumber: string, message: string) => Promise<void>;

export const defaultSendSms: SendSmsFn = async (
  phoneNumber: string,
  _message: string,
): Promise<void> => {
  console.log(
    `[GBV Safety Watch] Test SMS sent to ${phoneNumber} (fire-and-forget)`,
  );
};

// ── Validation helpers ────────────────────────────────────────────────────────

function validateName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= 100;
}

function validatePhone(phone: string): boolean {
  return PHONE_REGEX.test(phone);
}

// ── Result constructors ───────────────────────────────────────────────────────

function ok<T>(value: T): Result<T, ContactError> {
  return {ok: true, value};
}

function fail<T>(error: ContactError): Result<T, ContactError> {
  return {ok: false, error};
}

// ── Repository interface ──────────────────────────────────────────────────────

export interface EmergencyContactRepository {
  getAll(): Promise<EmergencyContact[]>;
  add(
    contact: NewContact,
  ): Promise<Result<EmergencyContact, ContactError>>;
  update(
    id: string,
    patch: Partial<NewContact>,
  ): Promise<Result<EmergencyContact, ContactError>>;
  remove(id: string): Promise<Result<void, ContactError>>;
}

// ── Factory function ──────────────────────────────────────────────────────────

/**
 * Creates an `EmergencyContactRepository` instance.
 *
 * @param storage  - Encrypted storage backend (injectable for testing).
 * @param sendSms  - SMS dispatch function (injectable for testing).
 */
export function createEmergencyContactRepository(
  storage: EncryptedStorageInterface = EncryptedStorage,
  sendSms: SendSmsFn = defaultSendSms,
): EmergencyContactRepository {
  // ── Private helpers ──────────────────────────────────────────────────────

  async function load(): Promise<EmergencyContact[]> {
    try {
      const raw = await storage.get(STORAGE_KEY);
      if (raw === null) {
        return [];
      }
      return JSON.parse(raw) as EmergencyContact[];
    } catch {
      return [];
    }
  }

  async function save(contacts: EmergencyContact[]): Promise<void> {
    try {
      await storage.set(STORAGE_KEY, JSON.stringify(contacts));
    } catch {
      throw new Error('STORAGE_ERROR');
    }
  }

  // ── Public interface ─────────────────────────────────────────────────────

  /**
   * Returns all stored emergency contacts.
   * Requirements: 4.8
   */
  async function getAll(): Promise<EmergencyContact[]> {
    return load();
  }

  /**
   * Adds a new emergency contact.
   *
   * Validations applied (in order):
   *   1. name and phoneNumber pass format rules → VALIDATION_FAILED
   *   2. Current count < 5 → MAX_CONTACTS_REACHED (mapped to VALIDATION_FAILED)
   *   3. Phone number is not already registered → DUPLICATE_PHONE
   *
   * After saving, a test SMS is dispatched fire-and-forget (the contact is
   * saved regardless of SMS success).
   *
   * Requirements: 4.1, 4.2, 4.5, 4.7, 4.8
   */
  async function add(
    contact: NewContact,
  ): Promise<Result<EmergencyContact, ContactError>> {
    // 1. Validate input fields
    if (!validateName(contact.name) || !validatePhone(contact.phoneNumber)) {
      return fail('VALIDATION_FAILED');
    }

    let contacts: EmergencyContact[];
    try {
      contacts = await load();
    } catch {
      return fail('STORAGE_ERROR');
    }

    // 2. Enforce max-contacts limit
    if (contacts.length >= MAX_CONTACTS) {
      return fail('VALIDATION_FAILED');
    }

    // 3. Reject duplicate phone numbers
    const duplicatePhone = contacts.some(
      c => c.phoneNumber === contact.phoneNumber,
    );
    if (duplicatePhone) {
      return fail('DUPLICATE_PHONE');
    }

    // 4. Persist the new contact
    const newContact: EmergencyContact = {
      id: generateUUID(),
      name: contact.name.trim(),
      phoneNumber: contact.phoneNumber,
    };

    contacts.push(newContact);

    try {
      await save(contacts);
    } catch {
      return fail('STORAGE_ERROR');
    }

    // 5. Fire-and-forget test SMS (Requirement 4.7)
    sendSms(
      newContact.phoneNumber,
      `Hi ${newContact.name}, you have been added as an emergency contact on GBV Safety Watch. No action needed.`,
    ).catch(() => {
      // Intentionally ignored — contact was already saved
    });

    return ok(newContact);
  }

  /**
   * Updates an existing contact by id.
   *
   * Validations applied:
   *   • If name is provided: must be 1–100 chars → VALIDATION_FAILED
   *   • If phoneNumber is provided: must match phone regex → VALIDATION_FAILED
   *   • Updated phone must not duplicate another contact's phone → DUPLICATE_PHONE
   *
   * Requirements: 4.2
   */
  async function update(
    id: string,
    patch: Partial<NewContact>,
  ): Promise<Result<EmergencyContact, ContactError>> {
    // Validate provided fields
    if (patch.name !== undefined && !validateName(patch.name)) {
      return fail('VALIDATION_FAILED');
    }
    if (patch.phoneNumber !== undefined && !validatePhone(patch.phoneNumber)) {
      return fail('VALIDATION_FAILED');
    }

    let contacts: EmergencyContact[];
    try {
      contacts = await load();
    } catch {
      return fail('STORAGE_ERROR');
    }

    const index = contacts.findIndex(c => c.id === id);
    if (index === -1) {
      return fail('VALIDATION_FAILED');
    }

    // Check for duplicate phone — excluding the contact being updated
    if (patch.phoneNumber !== undefined) {
      const duplicatePhone = contacts.some(
        c => c.id !== id && c.phoneNumber === patch.phoneNumber,
      );
      if (duplicatePhone) {
        return fail('DUPLICATE_PHONE');
      }
    }

    const updated: EmergencyContact = {
      ...contacts[index],
      ...(patch.name !== undefined ? {name: patch.name.trim()} : {}),
      ...(patch.phoneNumber !== undefined
        ? {phoneNumber: patch.phoneNumber}
        : {}),
    };

    contacts[index] = updated;

    try {
      await save(contacts);
    } catch {
      return fail('STORAGE_ERROR');
    }

    return ok(updated);
  }

  /**
   * Removes a contact by id.
   *
   * Rejects removal if it would leave the list empty (Requirement 4.3).
   *
   * Requirements: 4.3, 4.4
   */
  async function remove(
    id: string,
  ): Promise<Result<void, ContactError>> {
    let contacts: EmergencyContact[];
    try {
      contacts = await load();
    } catch {
      return fail('STORAGE_ERROR');
    }

    // Ensure the id actually exists before checking the "last contact" rule
    const exists = contacts.some(c => c.id === id);
    if (!exists) {
      return fail('VALIDATION_FAILED');
    }

    // Reject removal of the last contact (Requirement 4.3)
    if (contacts.length === 1) {
      return fail('LAST_CONTACT_REMOVAL');
    }

    const filtered = contacts.filter(c => c.id !== id);

    try {
      await save(filtered);
    } catch {
      return fail('STORAGE_ERROR');
    }

    return ok(undefined);
  }

  return {getAll, add, update, remove};
}

// ── Default singleton instance ────────────────────────────────────────────────

/**
 * Pre-built instance using the real EncryptedStorage.
 * Import this in production code.
 */
export const emergencyContactRepository: EmergencyContactRepository =
  createEmergencyContactRepository();
