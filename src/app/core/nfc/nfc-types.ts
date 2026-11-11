import { FilamentSpec } from '../filament';
import { ChipReport, U1_USER_BYTES } from './type2';

export type NfcAvailability = 'ready' | 'disabled' | 'unsupported' | 'web-unsupported' | 'permission-denied';

export type NfcErrorCode =
  | 'unsupported'
  | 'disabled'
  | 'permission'
  | 'timeout'
  | 'cancelled'
  | 'read-only'
  | 'password'
  | 'too-small'
  | 'incompatible'
  | 'not-ndef'
  | 'tag-lost'
  | 'write-failed'
  | 'unknown';

export interface TagRecord {
  mediaType: string | null;
  data: Uint8Array;
}

export interface TagInfo {
  /** Uppercase hex, no separators. Empty when the platform does not expose it. */
  uid: string;
  /** Human readable chip family, e.g. "NFC Forum Type 2" or "MIFARE Ultralight". */
  kind: string | null;
  /** Usable NDEF bytes, when the platform reports it. */
  capacity: number | null;
  writable: boolean | null;
  techTypes: string[];
  records: TagRecord[];
  /** Decoded OpenSpool contents, if the tag already holds a filament record. */
  openSpool: Partial<FilamentSpec> | null;
  /** What the chip itself reported, when the platform allows raw commands (native apps only). */
  chip: ChipReport | null;
}

export interface WriteRequest {
  mediaType: string;
  data: Uint8Array;
  /** Total bytes the message needs on the tag, for the capacity check. */
  bytesNeeded: number;
  /** Write even to tags the U1 is known not to read (e.g. NTAG213). */
  allowIncompatible: boolean;
}

export class NfcError extends Error {
  constructor(
    readonly code: NfcErrorCode,
    message: string,
    readonly tag?: TagInfo,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'NfcError';
  }
}

export interface ScanOptions {
  /**
   * Use a tag that's still on the phone from the previous scan, as "Try again" expects. Android's
   * reader doesn't report a tag again until it leaves and comes back.
   */
  reuse?: boolean;
}

export interface NfcBackend {
  readonly kind: 'native' | 'web' | 'mock';
  availability(): Promise<NfcAvailability>;
  /** Waits for a tag and returns what is on it. */
  read(signal: AbortSignal, options?: ScanOptions): Promise<TagInfo>;
  /** Waits for a tag, checks it, writes the record and returns the tag as it was before writing. */
  write(request: WriteRequest, signal: AbortSignal, options?: ScanOptions): Promise<TagInfo>;
  /** Opens the system NFC settings, where the platform allows it. */
  openSettings?(): Promise<void>;
}

/** Below this the chip is smaller than an NTAG215, which is the page range the U1 reads. */
const MIN_U1_CAPACITY = 400;

/** Returns the reason this tag cannot (or should not) take the write, or null when it is fine. */
export function checkTagForWrite(tag: TagInfo, request: WriteRequest): NfcError | null {
  const tech = tag.techTypes.join(' ');
  if (/NfcV|ISO15693/i.test(tech)) {
    return new NfcError(
      'incompatible',
      'This is an ISO 15693 tag (the kind OpenPrintTag uses). The U1 reader cannot see these tags.',
      tag,
    );
  }
  if (/MifareClassic/i.test(tech)) {
    return new NfcError(
      'incompatible',
      'This is a MIFARE Classic tag. The U1 only reads Snapmaker’s own encrypted Classic tags.',
      tag,
    );
  }
  if (/IsoDep|ISO7816|NfcB|NfcF|FeliCa/i.test(tech)) {
    return new NfcError(
      'incompatible',
      /Ndef/.test(tech)
        ? 'This is an NFC Type 4 tag (like an NTAG 424). The U1 reads NTAG215 and NTAG216 stickers.'
        : 'This looks like a bank card, transit card or phone, not an NFC sticker. Move it away, and check your phone case for cards.',
      tag,
    );
  }
  if (tag.chip?.passwordProtected) {
    return new NfcError('password', 'This tag is password protected, so it can’t be written.', tag);
  }
  if (tag.writable === false || tag.chip?.locked) {
    return new NfcError('read-only', 'This tag is locked (read-only) and can’t be rewritten.', tag);
  }
  if (tag.chip?.mirrored) {
    return new NfcError(
      'incompatible',
      'This tag inserts its serial number or scan count into its memory, which would corrupt the spool data.',
      tag,
    );
  }
  if (tag.chip?.ccUsable === false) {
    return new NfcError('incompatible', 'This tag’s NDEF header (page 3) is set up in a way the U1 can’t read, and it can’t be changed.', tag);
  }
  if (tag.capacity !== null && tag.capacity > 0 && tag.capacity < request.bytesNeeded) {
    return new NfcError(
      'too-small',
      `This tag holds ${tag.capacity} bytes but the spool data needs ${request.bytesNeeded}.`,
      tag,
    );
  }
  if (!request.allowIncompatible && request.bytesNeeded > U1_USER_BYTES) {
    return new NfcError('incompatible', `The spool data needs ${request.bytesNeeded} bytes, more than the ${U1_USER_BYTES} the U1 reads.`, tag);
  }
  if (!request.allowIncompatible && tag.capacity !== null && tag.capacity > 0 && tag.capacity < MIN_U1_CAPACITY) {
    return new NfcError(
      'incompatible',
      `This tag only holds ${tag.capacity} bytes, so it is probably an NTAG213. The U1 reads NTAG215 and NTAG216 tags.`,
      tag,
    );
  }
  return null;
}
