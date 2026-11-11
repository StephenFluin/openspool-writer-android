import { OPENSPOOL_MIME, parseOpenSpool } from '../openspool';
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
