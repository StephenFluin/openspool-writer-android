import { PluginListenerHandle, registerPlugin } from '@capacitor/core';
import { CapacitorNfc } from '@capgo/capacitor-nfc';
import { COMMAND_TIMEOUT_MS, errorCode, errorMessage, nativeAvailability, requireNfc, SystemNfc } from './native-common';
import { NfcAvailability, NfcBackend, NfcError, ScanOptions, TagInfo, WriteRequest } from './nfc-types';
import { pendingScan, ScanQueue } from './scan';
import { LinkError, readTag, TagLink, writeTag } from './tag-ops';
import { RawTag, tagInfoFrom } from './tag-info';
import { encodeNdefMessage } from './type2';

interface TagEvent {
  session: number;
  tag: RawTag & { tagId: number };
}

/** The app's own Android plugin (android/app/src/main/java/io/fluin/u1tags/TagReaderPlugin.java). */
export interface TagReaderPlugin {
  /** reuseTagId: a tag from an earlier scan to report again if it's still on the phone (-1 for none). */
  start(options: { session: number; reuseTagId: number }): Promise<void>;
  stop(): Promise<void>;
  transceive(options: { tagId: number; data: number[]; timeout?: number }): Promise<{ response: number[] }>;
  writeNdef(options: { tagId: number; message: number[]; format: boolean }): Promise<void>;
  addListener(eventName: 'tag', listener: (event: TagEvent) => void): Promise<PluginListenerHandle>;
  /** NFC was turned off during a scan. */
  addListener(eventName: 'disabled', listener: (event: { session: number }) => void): Promise<PluginListenerHandle>;
}

const TagReader = registerPlugin<TagReaderPlugin>('TagReader');

/**
 * Android, through the app's TagReader plugin rather than @capgo/capacitor-nfc's scanning (which
 * replays stale tag events, sends commands to whichever tag came last, and stops reporting tags
 * after a stale connection). @capgo/capacitor-nfc still provides NFC status and settings.
 */
export class AndroidNfcBackend implements NfcBackend {
  readonly kind = 'native';
  private readonly queue = new ScanQueue();
  private session = 0;
  private handlers: { tag(event: TagEvent): void; disabled(event: { session: number }): void } | null = null;
  private listening: Promise<unknown> | null = null;
  /** The tag the last scan failed on, which a retry may reuse while it's still on the phone. */
  private failedTagId = -1;

  constructor(
    private readonly reader: TagReaderPlugin = TagReader,
    private readonly system: SystemNfc = CapacitorNfc,
  ) {}

  availability(): Promise<NfcAvailability> {
    return nativeAvailability(this.system);
  }

  read(signal: AbortSignal, options?: ScanOptions): Promise<TagInfo> {
    return this.queue.run(signal, () => this.scan(signal, options, (tag, link) => readTag(link, tag)));
  }

  write(request: WriteRequest, signal: AbortSignal, options?: ScanOptions): Promise<TagInfo> {
    return this.queue.run(signal, () => this.scan(signal, options, (tag, link) => writeTag(link, tag, request)));
  }

  async openSettings(): Promise<void> {
    await this.system.showSettings();
  }

  private async scan<T>(
    signal: AbortSignal,
    options: ScanOptions | undefined,
    work: (tag: TagInfo, link: TagLink) => Promise<T>,
  ): Promise<T> {
    await requireNfc(this.system);
    signal.throwIfAborted();
    this.listening ??= Promise.all([
      this.reader.addListener('tag', (event) => this.handlers?.tag(event)),
      this.reader.addListener('disabled', (event) => this.handlers?.disabled(event)),
    ]);
    await this.listening;

    const session = ++this.session;
    const reuseTagId = options?.reuse ? this.failedTagId : -1;
    this.failedTagId = -1;
    const scan = pendingScan<T>(signal);
    let tagId = -1;
    this.handlers = {
      tag: (event) => {
        if (event.session !== session || tagId >= 0) return;
        tagId = event.tag.tagId;
        scan.take(() => work(tagInfoFrom(event.tag), androidLink(this.reader, event.tag.tagId)));
      },
      disabled: (event) => {
        if (event.session === session) scan.fail(new NfcError('disabled', 'NFC is turned off.'));
      },
    };
    this.reader.start({ session, reuseTagId }).catch((error) => scan.fail(startError(error)));
    try {
      return await scan.result;
    } catch (error) {
      // Only a tag that was actually being handled is worth reusing.
      if (tagId >= 0 && !(error instanceof NfcError && error.code === 'cancelled')) this.failedTagId = tagId;
      throw error;
    } finally {
      this.handlers = null;
      await this.reader.stop().catch(() => undefined);
    }
  }
}

function androidLink(reader: TagReaderPlugin, tagId: number): TagLink {
  return {
    recoversFromRefusal: true,
    async command(data) {
      try {
        return (await reader.transceive({ tagId, data, timeout: COMMAND_TIMEOUT_MS })).response;
      } catch (error) {
        const code = errorCode(error);
        const reason = code === 'TAG_LOST' ? 'lost' : code === 'IO' ? 'refused' : 'failed';
        throw new LinkError(reason, errorMessage(error), { cause: error });
      }
    },
    async writeNdef(request) {
      try {
        const message = Array.from(encodeNdefMessage(request.mediaType, request.data));
        await reader.writeNdef({ tagId, message, format: true });
      } catch (error) {
        throw writeError(error);
      }
    },
  };
}

function writeError(error: unknown): NfcError {
  const options = { cause: error };
  switch (errorCode(error)) {
    case 'READ_ONLY':
      return new NfcError('read-only', 'This tag is locked (read-only) and can’t be rewritten.', undefined, options);
    case 'TOO_SMALL':
      return new NfcError('too-small', 'The tag doesn’t have enough space for the spool data.', undefined, options);
    case 'NOT_NDEF':
    case 'UNSUPPORTED_TAG':
      return new NfcError('not-ndef', 'This tag doesn’t support NDEF, the format the U1 reads.', undefined, options);
    case 'TAG_LOST':
      return new NfcError('tag-lost', 'The tag moved away before the write finished.', undefined, options);
    case 'IO':
    case 'FORMAT':
      return new NfcError('write-failed', 'The phone found the tag but couldn’t write to it.', undefined, options);
    default:
      return new NfcError('unknown', errorMessage(error) || 'Something went wrong talking to the tag.', undefined, options);
  }
}

function startError(error: unknown): NfcError {
  const options = { cause: error };
  switch (errorCode(error)) {
    case 'DISABLED':
      return new NfcError('disabled', 'NFC is turned off.', undefined, options);
    case 'UNSUPPORTED':
      return new NfcError('unsupported', 'This device has no NFC reader.', undefined, options);
    default:
      return new NfcError('unknown', errorMessage(error), undefined, options);
  }
}
