/**
 * Low-level helpers for NFC Forum Type 2 tags (the NTAG21x family the U1 reads), used to tell
 * what a tag really is and to write it page by page when the platform's NDEF writer fails.
 * Command codes and memory layout are from the NXP NTAG213/215/216 datasheet.
 */

export const CMD_GET_VERSION = 0x60;
export const CMD_READ = 0x30;
export const CMD_WRITE = 0xa2;

/** First page of user memory on every Type 2 tag; pages 0–3 hold the UID, locks and capability container. */
const FIRST_USER_PAGE = 4;
/** The U1's built-in reader reads pages 0–134 (the NTAG215 range) and nothing past them. */
export const U1_LAST_PAGE = 0x86;
/** Bytes of user memory inside that range (pages 4–134), the most NDEF TLV data the U1 can see. */
export const U1_USER_BYTES = (U1_LAST_PAGE - FIRST_USER_PAGE + 1) * 4;
/** Capability container size bytes the U1's readers accept: NTAG213, NTAG215, NTAG216. */
const U1_CC_SIZES = [0x12, 0x3e, 0x6d];

export interface ChipModel {
  name: string;
  /** Last page of user memory. */
  lastUserPage: number;
  /** Page holding the dynamic lock bytes; CFG0 and CFG1 follow it. */
  dynamicLockPage: number;
  /** Capability container size byte (NDEF bytes / 8) NXP ships on formatted tags. */
  ccSize: number;
}

export const NTAG213: ChipModel = { name: 'NTAG213', lastUserPage: 0x27, dynamicLockPage: 0x28, ccSize: 0x12 };
export const NTAG215: ChipModel = { name: 'NTAG215', lastUserPage: 0x81, dynamicLockPage: 0x82, ccSize: 0x3e };
export const NTAG216: ChipModel = { name: 'NTAG216', lastUserPage: 0xe1, dynamicLockPage: 0xe2, ccSize: 0x6d };

/** Plain-language result of inspecting a tag at the chip level. */
export interface ChipReport {
  /** Chip named by its GET_VERSION answer, e.g. "NTAG215", or a description when it isn't a known NTAG. */
  chip: string;
  /** True when the chip answered GET_VERSION like a genuine NXP NTAG21x. */
  knownNtag: boolean;
  /** Raw GET_VERSION answer as hex, for comparing clones. */
  version: string | null;
  /** Capability container (page 3) as hex. */
  capabilityContainer: string | null;
  /** True when page 3 starts with the NDEF magic number. */
  ndefFormatted: boolean | null;
  /** True when page 3 is a valid NDEF header, or can still be made one (it is one-time programmable). */
  ccUsable: boolean | null;
  /** True when page 3 must be written before the tag can hold NDEF data. */
  needsFormat: boolean;
  /** NDEF bytes: what page 3 declares, or the chip's standard size when it's still blank. */
  ndefCapacity: number | null;
  /** True when lock bits are set, so some pages can never be rewritten. */
  locked: boolean | null;
  /** True when a password protects memory the U1 or the app needs. */
  passwordProtected: boolean | null;
  /** True when the tag overlays its UID or scan counter onto user memory when read. */
  mirrored: boolean | null;
  /** What the findings mean for the U1, most important first. */
  findings: string[];
}

export interface ChipReadings {
  /** GET_VERSION answer, or null when the chip didn't answer it. */
  version: number[] | null;
  /** READ of page 0: 16 bytes covering pages 0–3. */
  header: number[] | null;
  /** READ of the dynamic lock page: dynamic lock, CFG0, CFG1, PWD. */
  config: number[] | null;
  /** True when the chip refused to read its configuration pages, which only a read password does. */
  configUnreadable?: boolean;
  /** True when the configuration read failed in a way that can't be told apart from the tag leaving (iOS). */
  configUnconfirmed?: boolean;
}

/**
 * True when pages 2–3 alone show nothing in the way of an NDEF write: a capability container the
 * U1 accepts, write access, and no static lock bits on pages 4–15.
 */
export function headerReadyForNdef(header: number[]): boolean {
  if (header.length < 16) return false;
  const [magic, version, size, access] = header.slice(12, 16);
  return (
    magic === 0xe1 &&
    version >> 4 === 1 &&
    U1_CC_SIZES.includes(size) &&
    (access & 0x0f) === 0 &&
    (header[10] & 0xf0) === 0 &&
    header[11] === 0
  );
}

/** Names the chip from its GET_VERSION answer (vendor, product type and storage size bytes). */
export function identifyChip(version: number[] | null): ChipModel | null {
  if (!version || version.length < 8 || version[1] !== 0x04 || version[2] !== 0x04) return null;
  switch (version[6]) {
    case 0x0f:
      return NTAG213;
    case 0x11:
      return NTAG215;
    case 0x13:
      return NTAG216;
    default:
      return null;
  }
}

function describeVersion(version: number[] | null): string {
  if (!version || version.length < 8) return 'Unknown chip (no version answer)';
  if (version[1] !== 0x04) return 'Unknown chip (not from NXP)';
  if (version[2] === 0x03) return 'MIFARE Ultralight EV1';
  if (version[2] === 0x04) return 'NTAG (unrecognized size)';
  return 'Unknown NXP chip';
}

export function toHex(bytes: ArrayLike<number> | null): string | null {
  return bytes ? Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ').toUpperCase() : null;
}

/** Turns raw chip answers into a report a person can act on. */
export function analyzeChip(readings: ChipReadings): ChipReport {
  const model = identifyChip(readings.version);
  const header = readings.header && readings.header.length >= 16 ? readings.header : null;
  const cc = header ? header.slice(12, 16) : null;
  const config = model && readings.config && readings.config.length >= 12 ? readings.config : null;

  // Page 3 (capability container) is one-time programmable: bits can be set but never cleared.
  const ccTarget = model ? [0xe1, 0x10, model.ccSize, 0x00] : null;
  const ndefFormatted = cc ? cc[0] === 0xe1 : null;
  const ccValid = cc
    ? cc[0] === 0xe1 && cc[1] >> 4 === 1 && U1_CC_SIZES.includes(cc[2]) && (!model || cc[2] <= model.ccSize)
    : null;
  // Page 2 byte 2 is L7–L4, L-CC, then three block-locking bits; byte 3 is L15–L8.
  const ccLocked = header ? (header[10] & 0x08) !== 0 : null;
  const ccFixable = cc && ccTarget ? !ccLocked && cc.every((b, i) => (b & ~ccTarget[i]) === 0) : null;
  const needsFormat = ccValid === false && ccFixable === true;
  const ccUsable = ccValid === null ? null : ccValid || needsFormat ? true : ccFixable === null ? null : false;
  const ccReadOnly = ccValid === true && (cc![3] & 0x0f) !== 0;

  const pagesLocked = header ? (header[10] & 0xf0) !== 0 || header[11] !== 0 : null;
  // The third dynamic lock byte only holds block-locking bits.
  const dynamicLocked = config ? config[0] !== 0 || config[1] !== 0 : null;
  const locked = pagesLocked === null ? null : pagesLocked || dynamicLocked === true || ccReadOnly;

  // CFG0 = MIRROR, RFUI, MIRROR_PAGE, AUTH0; CFG1 = ACCESS (bit 7 PROT: the password also blocks reads).
  const auth0 = config ? config[7] : null;
  const readProtected = config ? (config[8] & 0x80) !== 0 : null;
  const passwordProtected =
    model && readings.configUnreadable
      ? true
      : !model || auth0 === null
        ? null
        : auth0 <= model.lastUserPage || (readProtected === true && auth0 <= U1_LAST_PAGE);
  const mirrorPage = config ? config[6] : 0;
  const mirrored = config && model ? config[4] >> 6 !== 0 && mirrorPage >= FIRST_USER_PAGE && mirrorPage <= model.lastUserPage : null;

  const findings: string[] = [];
  if (model?.name === 'NTAG213') {
    findings.push('NTAG213 is too small for the U1, which reads the NTAG215 page range.');
  } else if (readings.version && !model) {
    findings.push('This isn’t an NTAG213/215/216. The U1 expects an NTAG215 or NTAG216.');
  } else if (!readings.version) {
    findings.push('The chip didn’t say what it is. It may be a clone that doesn’t fully behave like an NTAG215.');
  }
  if (readings.configUnconfirmed) {
    findings.push('The tag left before its settings could be checked, so a password can’t be ruled out. Scan it again.');
  }
  if (passwordProtected) {
    findings.push(
      readings.configUnreadable
        ? 'A password blocks reading part of this tag, so the U1 couldn’t read it. Use a different tag.'
        : 'A password protects this tag’s memory, so it can’t be written without it. Use a different tag.',
    );
  }
  if (locked) {
    findings.push('Lock bits are set, so some of this tag can never be rewritten. Use a different tag.');
  }
  if (mirrored) {
    findings.push('This tag inserts its serial number or scan count into its memory when read, which would corrupt the spool data. Use a different tag.');
  }
  if (ccUsable === false) {
    findings.push('Page 3 holds an NDEF header the U1 can’t use, and it can never be changed. Use a different tag.');
  } else if (needsFormat) {
    findings.push(
      cc!.every((b) => b === 0)
        ? 'The tag is blank and not NDEF formatted yet. That’s normal for new tags; the app formats it while writing.'
        : 'Page 3 is only partly set up as an NDEF header; the app completes it while writing.',
    );
  }
  if (!findings.length && model) findings.push(`This looks like a genuine, writable ${model.name}.`);

  return {
    chip: model?.name ?? describeVersion(readings.version),
    knownNtag: model !== null,
    version: toHex(readings.version),
    capabilityContainer: toHex(cc),
    ndefFormatted,
    ccUsable,
    needsFormat,
    ndefCapacity: ccValid ? cc![2] * 8 : model ? model.ccSize * 8 : null,
    locked,
    passwordProtected,
    mirrored,
    findings,
  };
}

/** One NDEF message holding a single MIME record. */
export function encodeNdefMessage(mediaType: string, payload: Uint8Array): Uint8Array {
  const type = new TextEncoder().encode(mediaType);
  const short = payload.length < 256;
  const header = 0x80 | 0x40 | (short ? 0x10 : 0) | 0x02; // MB, ME, SR, TNF = MIME media
  const length = short
    ? [payload.length]
    : [(payload.length >>> 24) & 0xff, (payload.length >>> 16) & 0xff, (payload.length >>> 8) & 0xff, payload.length & 0xff];
  return Uint8Array.from([header, type.length, ...length, ...type, ...payload]);
}

export interface PageWrite {
  page: number;
  data: number[];
}

export interface PagePlan {
  /** The writes to send, in order. */
  sequence: PageWrite[];
  /** Each page's final contents, for reading back. */
  expected: PageWrite[];
}

/**
 * The page writes that put an NDEF message on a Type 2 tag, ordered so an interrupted write never
 * leaves a half-written message that looks valid:
 * - on a formatted tag, page 4 first becomes an empty NDEF message, the body follows, and the real
 *   page 4 (which holds the length) goes last;
 * - on a blank tag, the body and page 4 go first and the capability container last, so the tag
 *   stays blank until everything else is in place.
 */
export function type2PageWrites(model: ChipModel, message: Uint8Array, formatCc: boolean): PagePlan {
  const tlvLength = message.length < 0xff ? [message.length] : [0xff, (message.length >> 8) & 0xff, message.length & 0xff];
  const bytes = [0x03, ...tlvLength, ...message, 0xfe];
  while (bytes.length % 4) bytes.push(0x00);

  const pages = bytes.length / 4;
  if (FIRST_USER_PAGE + pages - 1 > model.lastUserPage) {
    throw new RangeError(`The message needs ${bytes.length} bytes; an ${model.name} has room for less.`);
  }

  const first: PageWrite = { page: FIRST_USER_PAGE, data: bytes.slice(0, 4) };
  const body: PageWrite[] = [];
  for (let i = 1; i < pages; i++) body.push({ page: FIRST_USER_PAGE + i, data: bytes.slice(i * 4, i * 4 + 4) });
  if (formatCc) {
    const cc: PageWrite = { page: 3, data: [0xe1, 0x10, model.ccSize, 0x00] };
    return { sequence: [...body, first, cc], expected: [cc, first, ...body] };
  }
  const empty: PageWrite = { page: FIRST_USER_PAGE, data: [0x03, 0x00, 0xfe, 0x00] };
  return { sequence: [empty, ...body, first], expected: [first, ...body] };
}

/** The memory layout for a report's chip, when it's a known NTAG. */
export function chipModel(report: ChipReport | null): ChipModel | null {
  return report?.knownNtag ? ([NTAG213, NTAG215, NTAG216].find((m) => m.name === report.chip) ?? null) : null;
}

/** True when a raw page write is safe to try: a known NTAG with nothing in the way. */
export function canWriteRaw(report: ChipReport | null): boolean {
  return (
    !!report &&
    report.knownNtag &&
    report.passwordProtected === false &&
    report.locked === false &&
    report.mirrored === false &&
    report.ccUsable === true
  );
}
