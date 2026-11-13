import { encodePayload, OPENSPOOL_MIME } from '../openspool';
import { checkTagForWrite, NfcAvailability, NfcBackend, NfcError, TagInfo, WriteRequest } from './nfc-types';
import { findOpenSpool, guessChip, withChip } from './tag-info';
import { analyzeChip, ChipReadings } from './type2';

export const MOCK_SCENARIOS = [
  'blank',
  'existing',
  'readonly',
  'ntag213',
  'unformatted',
  'password',
  'clone',
  'classic',
  'iso15693',
  'lost',
  'absent',
  'disabled',
  'unsupported',
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

/**
 * Dev-only stand-in for NFC hardware so the UI can be exercised in a desktop browser.
 * Enable with `?nfc=mock` (or `?nfc=mock-readonly`, etc.) while running `ng serve`.
 */
export class MockNfcBackend implements NfcBackend {
  readonly kind = 'mock';
  /** The last message "written", so a later read returns it. */
  private written: Uint8Array | null = null;

  constructor(private readonly scenario: MockScenario) {}

  async availability(): Promise<NfcAvailability> {
    if (this.scenario === 'disabled') return 'disabled';
    if (this.scenario === 'unsupported') return 'unsupported';
    return 'ready';
  }

  async openSettings(): Promise<void> {
    console.info('[mock nfc] would open NFC settings');
  }

  async read(signal: AbortSignal): Promise<TagInfo> {
    const tag = await this.waitForTag(signal);
    return tag;
  }

  async write(request: WriteRequest, signal: AbortSignal): Promise<TagInfo> {
    const tag = await this.waitForTag(signal);
    const problem = checkTagForWrite(tag, request);
    if (problem) throw problem;
    if (this.scenario === 'lost') {
      throw new NfcError('tag-lost', 'The tag moved away before the write finished.', tag);
    }
    // Like the real backends, a write that has started finishes even if the scan is cancelled.
    await delay(400, new AbortController().signal);
    this.written = request.data;
    return tag;
  }

  private async waitForTag(signal: AbortSignal): Promise<TagInfo> {
    const availability = await this.availability();
    if (availability === 'disabled') throw new NfcError('disabled', 'NFC is turned off.');
    if (availability === 'unsupported') throw new NfcError('unsupported', 'This device has no NFC reader.');
    await delay(this.scenario === 'absent' ? Number.POSITIVE_INFINITY : 1500, signal);
    return this.tag();
  }

  private tag(): TagInfo {
    const existing =
      this.written ??
      (this.scenario === 'existing'
        ? encodePayload({
            protocol: 'openspool',
            version: '1.0',
            type: 'PETG',
            color_hex: '1F6FEB',
            brand: 'Polymaker',
            subtype: 'Basic',
            min_temp: '235',
            max_temp: '260',
          })
        : null);
    const records = existing ? [{ mediaType: OPENSPOOL_MIME, data: existing }] : [];
    const capacity = { ntag213: 137, classic: 716, iso15693: 2000 }[this.scenario as string] ?? 496;
    const techTypes = {
      classic: ['android.nfc.tech.MifareClassic', 'android.nfc.tech.NfcA'],
      iso15693: ['android.nfc.tech.NfcV', 'android.nfc.tech.Ndef'],
    }[this.scenario as string] ?? ['android.nfc.tech.NfcA', 'android.nfc.tech.MifareUltralight', 'android.nfc.tech.Ndef'];
    const blank = this.scenario === 'unformatted' && !this.written;
    const tag: TagInfo = {
      uid: '04A1B2C3D4E5F6',
      kind: blank ? 'NFC Forum Type 2' : guessChip(capacity, 'NFC Forum Type 2'),
      capacity: blank ? null : capacity,
      writable: blank ? null : this.scenario !== 'readonly',
      techTypes: blank ? ['android.nfc.tech.NfcA', 'android.nfc.tech.MifareUltralight', 'android.nfc.tech.NdefFormatable'] : techTypes,
      records,
      openSpool: findOpenSpool(records),
      chip: null,
    };
    const readings = mockReadings(this.scenario, blank);
    return readings ? withChip(tag, analyzeChip(readings)) : tag;
  }
}

/** What a real chip would answer to the raw commands NativeNfcBackend sends, per scenario. */
function mockReadings(scenario: MockScenario, blank: boolean): ChipReadings | null {
  if (scenario === 'classic' || scenario === 'iso15693') return null;
  const size = scenario === 'ntag213' ? 0x0f : 0x11;
  const cc = blank ? [0, 0, 0, 0] : [0xe1, 0x10, scenario === 'ntag213' ? 0x12 : 0x3e, 0x00];
  const locks = scenario === 'readonly' ? [0x0f, 0xe0] : [0x00, 0x00];
  const auth0 = scenario === 'password' ? 0x04 : 0xff;
  return {
    version: scenario === 'clone' ? null : [0x00, 0x04, 0x04, 0x02, 0x01, 0x00, size, 0x03],
    header: [0x04, 0xa1, 0xb2, 0x1f, 0xc3, 0xd4, 0xe5, 0xf6, 0x00, 0x48, ...locks, ...cc],
    config: scenario === 'clone' ? null : [0, 0, 0, 0xbd, 0x04, 0, 0, auth0, 0, 0, 0, 0, 0, 0, 0, 0],
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new NfcError('cancelled', 'Scan cancelled.'));
    };
    const timer = Number.isFinite(ms)
      ? setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms)
      : undefined;
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}
