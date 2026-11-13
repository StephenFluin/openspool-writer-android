import { NfcError, TagInfo, WriteRequest } from '../nfc-types';
import { LinkError, TagLink } from '../tag-ops';

const NTAG215_VERSION = [0x00, 0x04, 0x04, 0x02, 0x01, 0x00, 0x11, 0x03];
const LAST_PAGE = 0x86;
const CFG0 = 0x83;
const CFG1 = 0x84;
const PWD = 0x85;

export interface FakeNtagOptions {
  formatted?: boolean;
  locks?: [number, number];
  /** First page a password protects (0xFF = none). */
  auth0?: number;
  /** The password also blocks reads. */
  readProtected?: boolean;
  /** UID mirroring into user memory. */
  mirror?: boolean;
  /** Clones that don't answer GET_VERSION. */
  answersVersion?: boolean;
  /** Clones that ignore GET_VERSION entirely; Android reports the silence as a lost tag. */
  silentVersion?: boolean;
  /** Pages whose WRITE is refused with a NAK handed back as data, as some Android controllers do. */
  nakAsData?: number[];
  /** The tag leaves the field after this many commands. */
  leavesAfter?: number;
  /** Writes to these pages are acknowledged but don't stick. */
  flakyPages?: number[];
  /** Like iOS: once the tag refuses a command, it answers nothing else. */
  haltsOnRefusal?: boolean;
  /** NFC is switched off: every command fails that way. */
  nfcOff?: boolean;
  /** What the platform NDEF writer does. */
  ndefWrite?: (tag: FakeNtag, request: WriteRequest) => void;
}

/** An NTAG215 that answers READ, GET_VERSION and WRITE the way the NXP datasheet describes. */
export class FakeNtag implements TagLink {
  readonly pages: number[][] = Array.from({ length: LAST_PAGE + 1 }, () => [0, 0, 0, 0]);
  readonly frames: number[][] = [];
  readonly ndefWrites: WriteRequest[] = [];
  readonly recoversFromRefusal: boolean;
  failures = 0;
  private halted = false;

  constructor(private readonly options: FakeNtagOptions = {}) {
    this.recoversFromRefusal = !options.haltsOnRefusal;
    this.pages[0] = [0x04, 0x8a, 0xa0, 0xae];
    this.pages[1] = [0xf2, 0xd0, 0x4f, 0x81];
    this.pages[2] = [0x4c, 0x48, ...(options.locks ?? [0, 0])];
    this.pages[3] = options.formatted === false ? [0, 0, 0, 0] : [0xe1, 0x10, 0x3e, 0x00];
    if (options.formatted !== false) this.pages[4] = [0x03, 0x00, 0xfe, 0x00];
    this.pages[0x82] = [0, 0, 0, 0xbd];
    this.pages[CFG0] = [options.mirror ? 0x44 : 0x04, 0, options.mirror ? 0x10 : 0, options.auth0 ?? 0xff];
    this.pages[CFG1] = [options.readProtected ? 0x80 : 0x00, 0x05, 0, 0];
    this.pages[PWD] = [0x12, 0x34, 0x56, 0x78];
  }

  info(): TagInfo {
    const formatted = this.pages[3][0] === 0xe1;
    return {
      uid: '048AA0F2D04F81',
      kind: formatted ? 'NTAG215' : null,
      capacity: formatted ? 496 : null,
      writable: formatted ? true : null,
      techTypes: ['android.nfc.tech.NfcA', 'android.nfc.tech.MifareUltralight', formatted ? 'android.nfc.tech.Ndef' : 'android.nfc.tech.NdefFormatable'],
      records: [],
      openSpool: null,
      chip: null,
    };
  }

  async command(frame: number[]): Promise<number[]> {
    this.frames.push(frame);
    try {
      return this.answer(frame);
    } catch (error) {
      this.failures++;
      throw error;
    }
  }

  private answer(frame: number[]): number[] {
    if (this.options.nfcOff) throw new LinkError('disabled', 'NFC is turned off.');
    if (this.frames.length > (this.options.leavesAfter ?? Infinity)) throw new LinkError('lost', 'Tag connection lost.');
    if (this.halted) return this.refuse();
    const [command, page] = frame;
    switch (command) {
      case 0x60:
        if (this.options.silentVersion) throw new LinkError('lost', 'Tag was lost.');
        return this.options.answersVersion === false ? this.refuse() : [...NTAG215_VERSION];
      case 0x30: {
        if (page > LAST_PAGE) return this.refuse();
        const out: number[] = [];
        for (let i = 0; i < 4; i++) {
          const p = (page + i) % (LAST_PAGE + 1);
          if (this.options.readProtected && p >= this.auth0) return this.refuse();
          out.push(...(p === PWD || p === PWD + 1 ? [0, 0, 0, 0] : this.pages[p]));
        }
        return out;
      }
      case 0xa2: {
        if (page < 3 || page > LAST_PAGE || page >= this.auth0) return this.refuse();
        if (this.options.nakAsData?.includes(page)) return [0x00];
        const data = frame.slice(2, 6);
        if (page === 3) this.pages[3] = this.pages[3].map((b, i) => b | data[i]); // one-time programmable
        else if (!this.options.flakyPages?.includes(page)) this.pages[page] = data;
        return [0x0a];
      }
      default:
        return this.refuse();
    }
  }

  async writeNdef(request: WriteRequest): Promise<void> {
    this.ndefWrites.push(request);
    this.options.ndefWrite?.(this, request);
  }

  /** The NDEF message bytes in user memory, read the way the U1 does: a TLV starting at page 4. */
  ndefMessage(): number[] | null {
    const bytes = this.pages.slice(4, LAST_PAGE + 1).flat();
    if (bytes[0] !== 0x03) return null;
    const long = bytes[1] === 0xff;
    const length = long ? (bytes[2] << 8) | bytes[3] : bytes[1];
    const start = long ? 4 : 2;
    return bytes[start + length] === 0xfe ? bytes.slice(start, start + length) : null;
  }

  private get auth0(): number {
    return this.pages[CFG0][3];
  }

  private refuse(): never {
    if (this.options.haltsOnRefusal) this.halted = true;
    throw new LinkError('refused', 'Transceive failed.');
  }
}

export function ndefFails(code: NfcError['code']): FakeNtagOptions['ndefWrite'] {
  return () => {
    throw new NfcError(code, 'The phone found the tag but couldn’t write to it.');
  };
}
