import { encodePayload, OPENSPOOL_MIME } from '../openspool';
import { checkTagForWrite, NfcAvailability, NfcBackend, NfcError, TagInfo, WriteRequest } from './nfc-types';
import { findOpenSpool, guessChip } from './tag-info';

export const MOCK_SCENARIOS = [
  'blank',
  'existing',
  'readonly',
  'ntag213',
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
    await delay(400, signal);
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
    return {
      uid: '04A1B2C3D4E5F6',
      kind: guessChip(capacity, 'NFC Forum Type 2'),
      capacity,
      writable: this.scenario !== 'readonly',
      techTypes,
      records,
      openSpool: findOpenSpool(records),
    };
  }
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
