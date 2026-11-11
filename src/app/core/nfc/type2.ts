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
  /** True when page 3 marks the tag as NDEF formatted. */
  ndefFormatted: boolean | null;
  /** NDEF bytes: what page 3 declares, or the chip's standard size when it's still blank. */
  ndefCapacity: number | null;
  /** True when lock bits are set, so some pages can never be rewritten. */
  locked: boolean | null;
  /** True when a password protects (part of) the user memory. */
  passwordProtected: boolean | null;
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

  const ndefFormatted = cc ? cc[0] === 0xe1 : null;
  const ndefCapacity = cc && ndefFormatted ? cc[2] * 8 : model ? model.ccSize * 8 : null;
  const staticLocked = header ? header[10] !== 0 || header[11] !== 0 : null;
  const dynamicLocked = config ? config[0] !== 0 || config[1] !== 0 || config[2] !== 0 : null;
  const ccReadOnly = cc && ndefFormatted ? (cc[3] & 0x0f) !== 0 : false;
  const locked = staticLocked === null ? null : staticLocked || dynamicLocked === true || ccReadOnly;
  const auth0 = config ? config[7] : null;
  const passwordProtected = auth0 === null || !model ? null : auth0 <= model.lastUserPage;

  const findings: string[] = [];
  if (model?.name === 'NTAG213') {
    findings.push('NTAG213 is too small for the U1, which reads the NTAG215 page range.');
  } else if (readings.version && !model) {
    findings.push('This isn’t an NTAG213/215/216. The U1 expects an NTAG215 or NTAG216.');
  } else if (!readings.version) {
    findings.push('The chip didn’t say what it is. It may be a clone that doesn’t fully behave like an NTAG215.');
  }
  if (passwordProtected) {
    findings.push('A password protects this tag’s memory, so it can’t be written without it. Use a different tag.');
  }
  if (locked) {
    findings.push('Lock bits are set, so some of this tag can never be rewritten. Use a different tag.');
  }
  if (ndefFormatted === false) {
    findings.push(
      cc && cc.every((b) => b === 0)
        ? 'The tag is blank and not NDEF formatted yet. That’s normal for new tags; the app formats it while writing.'
        : 'Page 3 doesn’t hold a valid NDEF header, and it can’t be erased. The U1 won’t read this tag.',
    );
  }
  if (!findings.length && model) findings.push(`This looks like a genuine, writable ${model.name}.`);

  return {
    chip: model?.name ?? describeVersion(readings.version),
    knownNtag: model !== null,
    version: toHex(readings.version),
    capabilityContainer: toHex(cc),
    ndefFormatted,
    ndefCapacity,
    locked,
    passwordProtected,
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

/**
 * The page writes that put an NDEF message on a Type 2 tag: the NDEF TLV and terminator, padded to
 * whole pages, then the capability container when the tag is blank. Writing the container last
 * means an interrupted write leaves a blank tag rather than a half-written one.
 */
export function type2PageWrites(model: ChipModel, message: Uint8Array, formatCc: boolean): PageWrite[] {
  const tlvLength = message.length < 0xff ? [message.length] : [0xff, (message.length >> 8) & 0xff, message.length & 0xff];
  const bytes = [0x03, ...tlvLength, ...message, 0xfe];
  while (bytes.length % 4) bytes.push(0x00);

  const pages = bytes.length / 4;
  if (FIRST_USER_PAGE + pages - 1 > model.lastUserPage) {
    throw new RangeError(`The message needs ${bytes.length} bytes; an ${model.name} has room for less.`);
  }

  const writes: PageWrite[] = [];
  for (let i = 0; i < pages; i++) {
    writes.push({ page: FIRST_USER_PAGE + i, data: bytes.slice(i * 4, i * 4 + 4) });
  }
  if (formatCc) writes.push({ page: 3, data: [0xe1, 0x10, model.ccSize, 0x00] });
  return writes;
}

/** The memory layout for a report's chip, when it's a known NTAG. */
export function chipModel(report: ChipReport | null): ChipModel | null {
  return report?.knownNtag ? ([NTAG213, NTAG215, NTAG216].find((m) => m.name === report.chip) ?? null) : null;
}

/** True when a raw page write is safe to try: a known NTAG with no password or locks in the way. */
export function canWriteRaw(report: ChipReport | null): boolean {
  return !!report && report.knownNtag && report.passwordProtected === false && report.locked === false;
}
