import { uidToHex } from '../openspool';
import { checkTagForWrite, NfcAvailability, NfcBackend, NfcError, TagInfo, WriteRequest } from './nfc-types';
import { findOpenSpool } from './tag-info';

// Web NFC is Chrome-on-Android only and not in TypeScript's DOM lib yet.
interface NDEFRecordInit {
  recordType: string;
  mediaType?: string;
  data?: BufferSource | string;
}
interface NDEFRecordLike {
  recordType: string;
  mediaType?: string;
  data?: DataView;
}
interface NDEFReadingEventLike extends Event {
  serialNumber: string;
  message: { records: NDEFRecordLike[] };
}
interface NDEFReaderLike {
  onreading: ((event: NDEFReadingEventLike) => void) | null;
  onreadingerror: ((event: Event) => void) | null;
  scan(options?: { signal?: AbortSignal }): Promise<void>;
  write(message: { records: NDEFRecordInit[] }, options?: { signal?: AbortSignal; overwrite?: boolean }): Promise<void>;
}
type NDEFReaderConstructor = new () => NDEFReaderLike;

function readerConstructor(): NDEFReaderConstructor | undefined {
  return (globalThis as unknown as { NDEFReader?: NDEFReaderConstructor }).NDEFReader;
}

/** Chrome on Android via the Web NFC API. It can't report capacity or lock state up front. */
export class WebNfcBackend implements NfcBackend {
  readonly kind = 'web';

  async availability(): Promise<NfcAvailability> {
    if (!readerConstructor()) return 'web-unsupported';
    try {
      const status = await navigator.permissions.query({ name: 'nfc' as PermissionName });
      if (status.state === 'denied') return 'permission-denied';
    } catch {
      // Older Chrome builds don't know the "nfc" permission name; scanning will ask instead.
    }
    return 'ready';
  }

  read(signal: AbortSignal): Promise<TagInfo> {
    return this.session(signal, async (tag) => tag);
  }

  write(request: WriteRequest, signal: AbortSignal): Promise<TagInfo> {
    return this.session(signal, async (tag, reader) => {
      const problem = checkTagForWrite(tag, request);
      if (problem) throw problem;
      try {
        await reader.write(
          { records: [{ recordType: 'mime', mediaType: request.mediaType, data: request.data as BufferSource }] },
          { signal, overwrite: true },
        );
      } catch (error) {
        throw mapWebError(error, tag);
      }
      return tag;
    });
  }

  private async session<T>(signal: AbortSignal, onTag: (tag: TagInfo, reader: NDEFReaderLike) => Promise<T>): Promise<T> {
    const Reader = readerConstructor();
    if (!Reader) throw new NfcError('unsupported', 'This browser can’t use NFC.');
    signal.throwIfAborted();

    const reader = new Reader();
    const scanAbort = new AbortController();
    return new Promise<T>((resolve, reject) => {
      let busy = false;
      let done = false;
      const finish = (settle: () => void) => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', onAbort);
        reader.onreading = null;
        reader.onreadingerror = null;
        scanAbort.abort();
        settle();
      };
      const onAbort = () => finish(() => reject(new NfcError('cancelled', 'Scan cancelled.')));
      signal.addEventListener('abort', onAbort);

      reader.onreading = async (event) => {
        if (busy || done) return;
        busy = true;
        try {
          const result = await onTag(toTagInfo(event), reader);
          finish(() => resolve(result));
        } catch (error) {
          finish(() => reject(error instanceof NfcError ? error : mapWebError(error)));
        }
      };
      reader.onreadingerror = () => {
        if (busy) return;
        finish(() =>
          reject(new NfcError('not-ndef', 'A tag was detected but its contents couldn’t be read.')),
        );
      };
      reader.scan({ signal: scanAbort.signal }).catch((error) => finish(() => reject(mapWebError(error))));
    });
  }
}

function toTagInfo(event: NDEFReadingEventLike): TagInfo {
  const records = event.message.records.map((record) => ({
    mediaType: record.recordType === 'mime' ? (record.mediaType ?? null) : null,
    data: record.data
      ? new Uint8Array(record.data.buffer, record.data.byteOffset, record.data.byteLength)
      : new Uint8Array(),
  }));
  return {
    uid: uidToHex(event.serialNumber ?? ''),
    kind: null,
    capacity: null,
    writable: null,
    techTypes: [],
    records,
    openSpool: findOpenSpool(records),
    chip: null,
  };
}

export function mapWebError(error: unknown, tag?: TagInfo): NfcError {
  const name = error instanceof DOMException ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  switch (name) {
    case 'AbortError':
      return new NfcError('cancelled', 'Scan cancelled.', tag, { cause: error });
    case 'NotAllowedError':
      return new NfcError(
        'permission',
        'Chrome refused to use NFC. NFC permission may be blocked for this site, or the tag is locked.',
        tag,
        { cause: error },
      );
    case 'NotSupportedError':
      return new NfcError('not-ndef', 'This tag doesn’t support NDEF or is too small for the spool data.', tag, {
        cause: error,
      });
    case 'NotReadableError':
      return new NfcError('disabled', 'NFC is turned off or busy in another app.', tag, { cause: error });
    case 'NetworkError':
      return new NfcError('write-failed', 'The write was interrupted. The tag may have moved, be locked, or be too small.', tag, {
        cause: error,
      });
    default:
      return new NfcError('unknown', message || 'Something went wrong talking to the tag.', tag, { cause: error });
  }
}
