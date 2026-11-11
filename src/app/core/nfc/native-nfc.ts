import { Capacitor } from '@capacitor/core';
import { CapacitorNfc, NfcTag, PluginListenerHandle } from '@capgo/capacitor-nfc';
import { uidToHex } from '../openspool';
import { checkTagForWrite, NfcAvailability, NfcBackend, NfcError, TagInfo, WriteRequest } from './nfc-types';
import { findOpenSpool, guessChip, withChip } from './tag-info';
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
  type2PageWrites,
} from './type2';

const TNF_MIME_MEDIA = 0x02;
/** Per-command timeout for raw NTAG commands; each one takes a few milliseconds on a healthy tag. */
const COMMAND_TIMEOUT_MS = 500;
/**
 * How long Android keeps the reader on after a scan ends. Stopping and immediately restarting it
 * ("Try another tag") can leave it off, and while it's off Android hands nearby tags to the system,
 * which pauses the app. iOS stops right away so its system sheet closes.
 */
const ANDROID_STOP_DELAY_MS = 15_000;

/** Android and iOS via @capgo/capacitor-nfc. */
export class NativeNfcBackend implements NfcBackend {
  readonly kind = 'native';
  /** Settles once the previous session's listeners are gone. */
  private teardown: Promise<unknown> = Promise.resolve();
  private stopTimer: ReturnType<typeof setTimeout> | undefined;

  async availability(): Promise<NfcAvailability> {
    const { supported } = await CapacitorNfc.isSupported();
    if (!supported) return 'unsupported';
    const { status } = await CapacitorNfc.getStatus();
    if (status === 'NO_NFC') return 'unsupported';
    if (status === 'NFC_DISABLED') return 'disabled';
    return 'ready';
  }

  read(signal: AbortSignal): Promise<TagInfo> {
    return this.session(signal, async (tag) => withChip(tag, await inspectChip(tag)));
  }

  write(request: WriteRequest, signal: AbortSignal): Promise<TagInfo> {
    return this.session(signal, async (scanned) => {
      const tag = withChip(scanned, await inspectChip(scanned));
      const problem = checkTagForWrite(tag, request);
      if (problem) throw problem;

      // Android's formatter often fails on blank NTAGs, so a blank tag is written page by page.
      if (tag.chip?.ndefFormatted === false && canWriteRaw(tag.chip)) {
        await writePages(tag, request, true);
        return tag;
      }
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
        const mapped = mapNativeError(error, tag);
        // The platform's NDEF writer gave up on a tag that looks healthy: write the pages directly.
        if (mapped.code === 'write-failed' && canWriteRaw(tag.chip)) {
          await writePages(tag, request, false);
          return tag;
        }
        throw mapped;
      }
      return tag;
    });
  }

  async openSettings(): Promise<void> {
    await CapacitorNfc.showSettings();
  }

  private stopSoon(): void {
    clearTimeout(this.stopTimer);
    const stop = () => void CapacitorNfc.stopScanning().catch(() => undefined);
    if (Capacitor.getPlatform() === 'ios') stop();
    else this.stopTimer = setTimeout(stop, ANDROID_STOP_DELAY_MS);
  }

  private async session<T>(signal: AbortSignal, onTag: (tag: TagInfo) => Promise<T>): Promise<T> {
    clearTimeout(this.stopTimer);
    await this.teardown;
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
        this.teardown = Promise.allSettled(handles.map((handle) => handle.then((h) => h.remove())));
        this.stopSoon();
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

/** Sends one raw NFC-A command to the tag in the field. */
async function command(data: number[]): Promise<number[]> {
  const { response } = await CapacitorNfc.transceive({ data, tech: 'nfcA', timeout: COMMAND_TIMEOUT_MS });
  return response;
}

/**
 * Asks a Type 2 tag what it is: its header (UID, locks, NDEF header), its GET_VERSION answer and its
 * configuration pages. Returns null for tags that don't speak these commands (or platforms that
 * don't allow raw commands), so callers carry on with what the platform reported.
 */
async function inspectChip(tag: TagInfo): Promise<ChipReport | null> {
  if (/NfcV|ISO15693|MifareClassic/i.test(tag.techTypes.join(' '))) return null;
  let header: number[];
  try {
    header = await command([CMD_READ, 0]);
  } catch {
    return null;
  }
  let version: number[] | null = null;
  try {
    version = await command([CMD_GET_VERSION]);
  } catch {
    // Older chips and some clones don't answer GET_VERSION, and the refusal resets them; stop here.
    return analyzeChip({ version: null, header, config: null });
  }
  const model = identifyChip(version);
  let config: number[] | null = null;
  if (model) {
    try {
      config = await command([CMD_READ, model.dynamicLockPage]);
    } catch {
      // Unreadable config usually means a password protects it; the report says it's unknown.
    }
  }
  return analyzeChip({ version, header, config });
}

/** Writes the record page by page, then reads it back to make sure it landed. */
async function writePages(tag: TagInfo, request: WriteRequest, formatCc: boolean): Promise<void> {
  const model = chipModel(tag.chip);
  if (!model) throw new NfcError('write-failed', 'The phone found the tag but couldn’t write to it.', tag);
  const writes = type2PageWrites(model, encodeNdefMessage(request.mediaType, request.data), formatCc);
  try {
    for (const { page, data } of writes) await command([CMD_WRITE, page, ...data]);
    for (const { page, data } of writes) {
      const readBack = (await command([CMD_READ, page])).slice(0, 4);
      if (readBack.some((byte, i) => byte !== data[i])) {
        throw new Error(`Page ${page} reads back differently after writing.`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/lost|connect/i.test(message)) {
      throw new NfcError('tag-lost', 'The tag moved away before the write finished.', tag, { cause: error });
    }
    throw new NfcError('write-failed', 'The phone found the tag but couldn’t write to it.', tag, { cause: error });
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
    chip: null,
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
