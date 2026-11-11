import { FilamentSpec } from '../filament';

export type NfcAvailability = 'ready' | 'disabled' | 'unsupported' | 'web-unsupported' | 'permission-denied';

export type NfcErrorCode =
  | 'unsupported'
  | 'disabled'
  | 'permission'
  | 'timeout'
  | 'cancelled'
  | 'read-only'
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

export interface NfcBackend {
  readonly kind: 'native' | 'web' | 'mock';
  availability(): Promise<NfcAvailability>;
  /** Waits for a tag and returns what is on it. */
  read(signal: AbortSignal): Promise<TagInfo>;
  /** Waits for a tag, checks it, writes the record and returns the tag as it was before writing. */
  write(request: WriteRequest, signal: AbortSignal): Promise<TagInfo>;
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
  if (tag.writable === false) {
    return new NfcError('read-only', 'This tag is locked (read-only) and can’t be rewritten.', tag);
  }
  if (tag.capacity !== null && tag.capacity > 0 && tag.capacity < request.bytesNeeded) {
    return new NfcError(
      'too-small',
      `This tag holds ${tag.capacity} bytes but the spool data needs ${request.bytesNeeded}.`,
      tag,
    );
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
