import { CapacitorNfc, CapacitorNfcPlugin, NfcEvent, NfcSessionEndEvent } from '@capgo/capacitor-nfc';
import { COMMAND_TIMEOUT_MS, errorMessage, nativeAvailability, requireNfc } from './native-common';
import { NfcAvailability, NfcBackend, NfcError, TagInfo, WriteRequest } from './nfc-types';
import { pendingScan, ScanQueue } from './scan';
import { LinkError, readTag, TagLink, writeTag } from './tag-ops';
import { tagInfoFrom, TNF_MIME_MEDIA } from './tag-info';

type IosNfc = Pick<
  CapacitorNfcPlugin,
  'isSupported' | 'getStatus' | 'showSettings' | 'startScanning' | 'stopScanning' | 'transceive' | 'write' | 'addListener'
>;

/**
 * iOS, through @capgo/capacitor-nfc's tag reader session (the only kind that reports UIDs). Its
 * listeners are added once and never removed: the plugin keeps events that arrive with no listener
 * and replays them to the next one, which would hand a scan an old tag or an old session end.
 */
export class IosNfcBackend implements NfcBackend {
  readonly kind = 'native';
  private readonly queue = new ScanQueue();
  private handlers: { tag(event: NfcEvent): void; end(event: NfcSessionEndEvent): void } | null = null;
  private listening: Promise<unknown> | null = null;

  constructor(private readonly nfc: IosNfc = CapacitorNfc) {}

  availability(): Promise<NfcAvailability> {
    return nativeAvailability(this.nfc);
  }

  // A new iOS session finds a tag that's already on the phone, so there's nothing to reuse.
  read(signal: AbortSignal): Promise<TagInfo> {
    return this.queue.run(() => this.scan(signal, (tag, link) => readTag(link, tag)));
  }

  write(request: WriteRequest, signal: AbortSignal): Promise<TagInfo> {
    return this.queue.run(() => this.scan(signal, (tag, link) => writeTag(link, tag, request)));
  }

  async openSettings(): Promise<void> {
    await this.nfc.showSettings();
  }

  private async scan<T>(signal: AbortSignal, work: (tag: TagInfo, link: TagLink) => Promise<T>): Promise<T> {
    await requireNfc(this.nfc);
    signal.throwIfAborted();
    this.listening ??= Promise.all([
      this.nfc.addListener('nfcEvent', (event) => this.handlers?.tag(event)),
      this.nfc.addListener('nfcSessionEnd', (event) => this.handlers?.end(event)),
    ]);
    await this.listening;

    const scan = pendingScan<T>(signal);
    let started = false;
    let earlyEnd: NfcSessionEndEvent['reason'] | null = null;
    this.handlers = {
      tag: (event) => scan.take(() => work(tagInfoFrom(event.tag), iosLink(this.nfc))),
      // Before the sheet is up, startScanning rejects with the real cause; that takes precedence.
      end: (event) => (started ? scan.fail(sessionEndError(event.reason)) : (earlyEnd = event.reason)),
    };
    this.nfc
      .startScanning({
        // Keep the session open after the read so we can write to the same tag.
        invalidateAfterFirstRead: false,
        iosSessionType: 'tag',
        alertMessage: 'Hold the top of your iPhone against the tag.',
      })
      .then(() => {
        started = true;
        if (earlyEnd) scan.fail(sessionEndError(earlyEnd));
      })
      .catch((error) => scan.fail(mapNativeError(error)));
    try {
      return await scan.result;
    } finally {
      this.handlers = null;
      await this.nfc.stopScanning().catch(() => undefined);
    }
  }
}

function iosLink(nfc: IosNfc): TagLink {
  let answered = false;
  return {
    recoversFromRefusal: false,
    async command(data) {
      try {
        const { response } = await nfc.transceive({ data, tech: 'nfcA', timeout: COMMAND_TIMEOUT_MS });
        answered = true;
        return response;
      } catch (error) {
        const message = errorMessage(error);
        const reason = /transceive failed/i.test(message)
          ? 'refused'
          : /connect|no longer available|no nfc tag|no active nfc session|lost/i.test(message)
            ? 'lost'
            : 'failed';
        throw new LinkError(reason, message, { cause: error });
      }
    },
    async writeNdef(request) {
      try {
        await nfc.write({
          // iOS can't format tags; blank NTAGs are set up page by page instead.
          allowFormat: false,
          records: [
            {
              tnf: TNF_MIME_MEDIA,
              type: Array.from(new TextEncoder().encode(request.mediaType)),
              id: [],
              payload: Array.from(request.data),
            },
          ],
        });
      } catch (error) {
        // Failing to query a tag that just answered our commands means it left the field.
        if (/query tag status/i.test(errorMessage(error))) {
          throw answered
            ? new NfcError('tag-lost', 'The tag moved away before the write finished.', undefined, { cause: error })
            : new NfcError('write-failed', 'The phone found the tag but couldn’t write to it.', undefined, { cause: error });
        }
        throw mapNativeError(error);
      }
    },
  };
}

function sessionEndError(reason: NfcSessionEndEvent['reason']): NfcError {
  if (reason === 'userCancelled') return new NfcError('cancelled', 'Scan cancelled.');
  if (reason === 'sessionTimeout') return new NfcError('timeout', 'No tag was found before the scan timed out.');
  return new NfcError('unknown', 'The iPhone stopped the NFC scan. Hold just one tag still against the top of the phone and try again.');
}

/** @capgo/capacitor-nfc on iOS only gives us messages, so classify by their wording. */
export function mapNativeError(error: unknown, tag?: TagInfo): NfcError {
  const message = errorMessage(error);
  const rules: [RegExp, NfcError['code'], string][] = [
    [/read only/i, 'read-only', 'This tag is locked (read-only) and can’t be rewritten.'],
    [/capacity/i, 'too-small', 'The tag doesn’t have enough space for the spool data.'],
    [/not support NDEF/i, 'not-ndef', 'This tag doesn’t support NDEF, the format the U1 reads.'],
    [/connection lost|failed to connect|tag was lost|no longer available/i, 'tag-lost', 'The tag moved away before the write finished.'],
    [/failed to write/i, 'write-failed', 'The phone found the tag but couldn’t write to it.'],
    [/disabled/i, 'disabled', 'NFC is turned off.'],
    [/not available|hardware|simulator/i, 'unsupported', 'This device has no NFC reader.'],
    [/superseded|cancel/i, 'cancelled', 'Scan cancelled.'],
  ];
  for (const [pattern, code, friendly] of rules) {
    if (pattern.test(message)) return new NfcError(code, friendly, tag, { cause: error });
  }
  return new NfcError('unknown', message || 'Something went wrong talking to the tag.', tag, { cause: error });
}
