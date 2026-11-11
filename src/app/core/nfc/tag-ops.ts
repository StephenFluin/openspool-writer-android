import { checkTagForWrite, NfcError, TagInfo, WriteRequest } from './nfc-types';
import { withChip } from './tag-info';
import {
  analyzeChip,
  canWriteRaw,
  chipModel,
  ChipReport,
  CMD_GET_VERSION,
  CMD_READ,
  CMD_WRITE,
  encodeNdefMessage,
  identifyChip,
  PageWrite,
  type2PageWrites,
} from './type2';

/** Why a raw command failed: the tag left, it refused the command (NAK), or something else. */
export class LinkError extends Error {
  constructor(
    readonly reason: 'lost' | 'refused' | 'failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LinkError';
  }
}

/** Operations on the one tag a scan delivered; each platform implements it. */
export interface TagLink {
  /** Sends a raw NFC-A frame (without CRC). Rejects with a LinkError. */
  command(data: number[]): Promise<number[]>;
  /** Writes the request as one NDEF MIME record through the platform's NDEF support. Rejects with an NfcError. */
  writeNdef(request: WriteRequest): Promise<void>;
  /**
   * Whether the tag stays usable after it refuses a command. Android re-selects it on the next
   * command; on iOS it stays halted for the rest of the session.
   */
  readonly recoversFromRefusal: boolean;
}

const LOST = 'The tag moved away before the phone finished with it.';
const WRITE_FAILED = 'The phone found the tag but couldn’t write to it.';

/** Reads a tag, including what the chip itself reports. */
export async function readTag(link: TagLink, tag: TagInfo): Promise<TagInfo> {
  return withChip(tag, await inspectChip(link, tag, 'full'));
}

/** Checks the tag, writes the record and returns the tag as it was before writing. */
export async function writeTag(link: TagLink, tag: TagInfo, request: WriteRequest): Promise<TagInfo> {
  const checked = withChip(tag, await inspectChip(link, tag, link.recoversFromRefusal ? 'full' : 'light'));
  const problem = checkTagForWrite(checked, request);
  if (problem) throw problem;
  const chip = checked.chip;

  // Neither platform's NDEF formatter handles a blank NTAG reliably, so it's set up page by page.
  if (chip?.needsFormat && canWriteRaw(chip)) {
    await writePages(link, checked, request, true);
    return checked;
  }
  try {
    await link.writeNdef(request);
  } catch (error) {
    const mapped = withTag(error, checked);
    // The NDEF writer gave up on a tag that looks healthy: write its pages directly.
    if (mapped.code === 'write-failed' && link.recoversFromRefusal && canWriteRaw(chip)) {
      await writePages(link, checked, request, false);
      return checked;
    }
    throw mapped;
  }
  return checked;
}

/**
 * Asks a Type 2 tag what it is: its header (UID, locks, NDEF header), its GET_VERSION answer and its
 * configuration pages. Returns null for tags that don't speak these commands. A "light" inspection
 * stops after the header when the tag already holds a valid NDEF header, so on iOS no command the
 * tag might refuse runs before the NDEF write.
 */
export async function inspectChip(link: TagLink, tag: TagInfo, depth: 'full' | 'light'): Promise<ChipReport | null> {
  if (/NfcV|ISO15693|MifareClassic|IsoDep|ISO7816|NfcB|NfcF|FeliCa/i.test(tag.techTypes.join(' '))) return null;
  let header: number[];
  try {
    header = await read(link, 0);
  } catch (error) {
    if (isLost(error)) throw new NfcError('tag-lost', LOST, tag, { cause: error });
    return null;
  }
  if (depth === 'light' && header[12] === 0xe1) return null;

  let version: number[];
  try {
    version = await exactly(link, [CMD_GET_VERSION], 8);
  } catch (error) {
    if (isLost(error)) throw new NfcError('tag-lost', LOST, tag, { cause: error });
    // Older chips and some clones don't answer GET_VERSION.
    return analyzeChip({ version: null, header, config: null });
  }
  const model = identifyChip(version);
  let config: number[] | null = null;
  let configUnreadable = false;
  if (model) {
    try {
      config = await read(link, model.dynamicLockPage);
    } catch (error) {
      if (isLost(error)) throw new NfcError('tag-lost', LOST, tag, { cause: error });
      // A genuine NTAG only refuses to read its configuration when a read password covers it.
      configUnreadable = true;
    }
  }
  return analyzeChip({ version, header, config, configUnreadable });
}

/** Writes the record page by page, then reads it back to make sure it landed. */
async function writePages(link: TagLink, tag: TagInfo, request: WriteRequest, formatCc: boolean): Promise<void> {
  const model = chipModel(tag.chip);
  if (!model) throw new NfcError('write-failed', WRITE_FAILED, tag);
  const plan = type2PageWrites(model, encodeNdefMessage(request.mediaType, request.data), formatCc);
  let answered = 0;
  try {
    for (const { page, data } of plan.sequence) {
      await link.command([CMD_WRITE, page, ...data]);
      answered++;
    }
    await verify(link, plan.expected, () => answered++);
  } catch (error) {
    if (error instanceof ReadBackError) throw new NfcError('write-failed', WRITE_FAILED, tag, { cause: error });
    // The inspection just showed the tag answers and nothing protects it, so a failure partway through
    // means it left the field.
    if (isLost(error) || answered > 0) throw new NfcError('tag-lost', LOST, tag, { cause: error });
    throw new NfcError('write-failed', WRITE_FAILED, tag, { cause: error });
  }
}

class ReadBackError extends Error {
  constructor(page: number) {
    super(`Page ${page} reads back differently after writing.`);
  }
}

/** Reads the written pages back, four per READ. */
async function verify(link: TagLink, expected: PageWrite[], onRead: () => void): Promise<void> {
  const wanted = new Map(expected.map((write) => [write.page, write.data]));
  const pages = [...wanted.keys()].sort((a, b) => a - b);
  for (let i = 0; i < pages.length; ) {
    const start = pages[i];
    const bytes = await read(link, start);
    onRead();
    for (let offset = 0; offset < 4; offset++) {
      const data = wanted.get(start + offset);
      if (data && data.some((byte, j) => byte !== bytes[offset * 4 + j])) throw new ReadBackError(start + offset);
    }
    while (i < pages.length && pages[i] < start + 4) i++;
  }
}

/** READ returns four pages; anything shorter is a refusal reported as data. */
function read(link: TagLink, page: number): Promise<number[]> {
  return exactly(link, [CMD_READ, page], 16);
}

async function exactly(link: TagLink, frame: number[], length: number): Promise<number[]> {
  const response = await link.command(frame);
  if (response.length < length) {
    throw new LinkError('refused', `Expected ${length} bytes, got ${response.length}.`);
  }
  return response.slice(0, length);
}

function isLost(error: unknown): boolean {
  return error instanceof LinkError && error.reason === 'lost';
}

function withTag(error: unknown, tag: TagInfo): NfcError {
  if (error instanceof NfcError) return new NfcError(error.code, error.message, tag, { cause: error.cause ?? error });
  return new NfcError('unknown', error instanceof Error ? error.message : String(error), tag, { cause: error });
}
