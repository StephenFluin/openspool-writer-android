import { OPENSPOOL_MIME, parseOpenSpool, uidToHex } from '../openspool';
import { TagInfo, TagRecord } from './nfc-types';
import { ChipReport } from './type2';

/** Best guess at the NXP chip from the NDEF capacity the platform reports. */
export function guessChip(capacity: number | null, fallback: string | null): string | null {
  if (capacity === null || capacity <= 0) return fallback;
  if (capacity <= 48) return 'MIFARE Ultralight';
  if (capacity <= 150) return 'NTAG213';
  if (capacity >= 480 && capacity <= 540) return 'NTAG215';
  if (capacity >= 850 && capacity <= 900) return 'NTAG216';
  return fallback;
}

export function findOpenSpool(records: TagRecord[]) {
  for (const record of records) {
    if (record.mediaType === OPENSPOOL_MIME) {
      const spec = parseOpenSpool(record.data);
      if (spec) return spec;
    }
  }
  return null;
}

/** Adds a chip report to a tag, letting the chip's own answers override the platform's guesses. */
export function withChip(tag: TagInfo, chip: ChipReport | null): TagInfo {
  if (!chip) return tag;
  return {
    ...tag,
    chip,
    kind: chip.knownNtag ? chip.chip : tag.kind,
    capacity: tag.capacity ?? chip.ndefCapacity,
  };
}

export const TNF_MIME_MEDIA = 0x02;

/** A tag as both native plugins report it (Android's TagReader and @capgo/capacitor-nfc). */
export interface RawTag {
  id?: number[];
  techTypes?: string[];
  type?: string | null;
  maxSize?: number | null;
  isWritable?: boolean | null;
  ndefMessage?: { tnf: number; type: number[]; payload: number[] }[] | null;
}

export function tagInfoFrom(raw: RawTag): TagInfo {
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
