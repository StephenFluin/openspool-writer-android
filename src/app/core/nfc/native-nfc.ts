import { CapacitorNfc, NfcTag, PluginListenerHandle } from '@capgo/capacitor-nfc';
import { uidToHex } from '../openspool';
import { checkTagForWrite, NfcAvailability, NfcBackend, NfcError, TagInfo, WriteRequest } from './nfc-types';
import { findOpenSpool, guessChip } from './tag-info';

const TNF_MIME_MEDIA = 0x02;

/** Android and iOS via @capgo/capacitor-nfc. */
export class NativeNfcBackend implements NfcBackend {
  readonly kind = 'native';

  async availability(): Promise<NfcAvailability> {
    const { supported } = await CapacitorNfc.isSupported();
    if (!supported) return 'unsupported';
    const { status } = await CapacitorNfc.getStatus();
    if (status === 'NO_NFC') return 'unsupported';
    if (status === 'NFC_DISABLED') return 'disabled';
    return 'ready';
  }

  read(signal: AbortSignal): Promise<TagInfo> {
    return this.session(signal, async (tag) => tag);
  }

  write(request: WriteRequest, signal: AbortSignal): Promise<TagInfo> {
    return this.session(signal, async (tag) => {
      const problem = checkTagForWrite(tag, request);
      if (problem) throw problem;
      try {
        await CapacitorNfc.write({
          allowFormat: true,
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
        throw mapNativeError(error, tag);
      }
      return tag;
    });
  }

  async openSettings(): Promise<void> {
    await CapacitorNfc.showSettings();
  }

  private async session<T>(signal: AbortSignal, onTag: (tag: TagInfo) => Promise<T>): Promise<T> {
    const availability = await this.availability();
    if (availability === 'unsupported') {
      throw new NfcError('unsupported', 'This device has no NFC reader.');
    }
    if (availability === 'disabled') {
      throw new NfcError('disabled', 'NFC is turned off.');
    }
    signal.throwIfAborted();

    return new Promise<T>((resolve, reject) => {
      const handles: Promise<PluginListenerHandle>[] = [];
      let busy = false;
      let done = false;

      const finish = (settle: () => void) => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', onAbort);
        for (const handle of handles) handle.then((h) => h.remove()).catch(() => undefined);
        CapacitorNfc.stopScanning().catch(() => undefined);
        settle();
      };
      const onAbort = () => finish(() => reject(new NfcError('cancelled', 'Scan cancelled.')));
      signal.addEventListener('abort', onAbort);

      handles.push(
        CapacitorNfc.addListener('nfcEvent', async (event) => {
          if (busy || done) return;
          busy = true;
          try {
            const result = await onTag(toTagInfo(event.tag));
            finish(() => resolve(result));
          } catch (error) {
            finish(() => reject(error instanceof NfcError ? error : mapNativeError(error)));
          }
        }),
      );
      // iOS only: the system sheet was dismissed or its 60 second limit ran out.
      handles.push(
        CapacitorNfc.addListener('nfcSessionEnd', (event) => {
          if (busy) return;
          finish(() =>
            reject(
              event.reason === 'userCancelled'
                ? new NfcError('cancelled', 'Scan cancelled.')
                : new NfcError('timeout', 'No tag was found before the scan timed out.'),
            ),
          );
        }),
      );

      Promise.all(handles)
        .then(() =>
          CapacitorNfc.startScanning({
            // Keep the session open after the read so we can write to the same tag.
            invalidateAfterFirstRead: false,
            // A tag session (not an NDEF session) is the only way to get the UID on iOS.
            iosSessionType: 'tag',
            alertMessage: 'Hold the top of your iPhone against the tag.',
          }),
        )
        .catch((error) => finish(() => reject(mapNativeError(error))));
    });
  }
}

function toTagInfo(raw: NfcTag): TagInfo {
  const records = (raw.ndefMessage ?? []).map((record) => ({
    mediaType: record.tnf === TNF_MIME_MEDIA ? new TextDecoder().decode(Uint8Array.from(record.type)) : null,
    data: Uint8Array.from(record.payload),
  }));
  const capacity = raw.maxSize ?? null;
  return {
    uid: uidToHex(raw.id ?? []),
    kind: guessChip(capacity, raw.type ?? null),
    capacity,
    writable: raw.isWritable ?? null,
    techTypes: raw.techTypes ?? [],
    records,
    openSpool: findOpenSpool(records),
  };
}

/** The plugin only gives us messages, so classify by their wording. */
export function mapNativeError(error: unknown, tag?: TagInfo): NfcError {
  const message = error instanceof Error ? error.message : String(error);
  const rules: [RegExp, NfcError['code'], string][] = [
    [/read only/i, 'read-only', 'This tag is locked (read-only) and can’t be rewritten.'],
    [/capacity/i, 'too-small', 'The tag doesn’t have enough space for the spool data.'],
    [/not support NDEF/i, 'not-ndef', 'This tag doesn’t support NDEF, the format the U1 reads.'],
    [/connection lost|failed to connect|tag was lost/i, 'tag-lost', 'The tag moved away before the write finished.'],
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
