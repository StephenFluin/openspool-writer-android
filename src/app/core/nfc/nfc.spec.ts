import { mapNativeError } from './native-nfc';
import { helpFor } from './nfc-help';
import { checkTagForWrite, NfcError, TagInfo, WriteRequest } from './nfc-types';
import { guessChip } from './tag-info';
import { mapWebError } from './web-nfc';

const request: WriteRequest = { mediaType: 'application/json', data: new Uint8Array(), bytesNeeded: 250, allowIncompatible: false };

function tag(overrides: Partial<TagInfo>): TagInfo {
  return {
    uid: '04A1B2C3D4E5F6',
    kind: 'NTAG215',
    capacity: 496,
    writable: true,
    techTypes: ['android.nfc.tech.NfcA', 'android.nfc.tech.MifareUltralight', 'android.nfc.tech.Ndef'],
    records: [],
    openSpool: null,
    chip: null,
    ...overrides,
  };
}

describe('checkTagForWrite', () => {
  it('accepts NTAG215 and NTAG216', () => {
    expect(checkTagForWrite(tag({}), request)).toBeNull();
    expect(checkTagForWrite(tag({ capacity: 868 }), request)).toBeNull();
  });

  it('accepts tags whose details the platform does not report (Web NFC)', () => {
    expect(checkTagForWrite(tag({ capacity: null, writable: null, techTypes: [] }), request)).toBeNull();
  });

  it('rejects locked tags', () => {
    expect(checkTagForWrite(tag({ writable: false }), request)?.code).toBe('read-only');
  });

  it('rejects tags that are too small (NTAG213)', () => {
    expect(checkTagForWrite(tag({ capacity: 137 }), request)?.code).toBe('too-small');
  });

  it('flags small tags the U1 cannot read, unless overridden', () => {
    const small = tag({ capacity: 300 });
    expect(checkTagForWrite(small, request)?.code).toBe('incompatible');
    expect(checkTagForWrite(small, { ...request, allowIncompatible: true })).toBeNull();
  });

  it('rejects ISO 15693 and MIFARE Classic tags', () => {
    expect(checkTagForWrite(tag({ techTypes: ['android.nfc.tech.NfcV', 'android.nfc.tech.Ndef'], capacity: 2000 }), request)?.code).toBe('incompatible');
    expect(checkTagForWrite(tag({ techTypes: ['NFCISO15693Tag'] }), request)?.code).toBe('incompatible');
    expect(checkTagForWrite(tag({ techTypes: ['android.nfc.tech.MifareClassic', 'android.nfc.tech.Ndef'], capacity: 716 }), request)?.code).toBe('incompatible');
  });
});

describe('helpFor', () => {
  it('offers "Write anyway" only for size-based incompatibility', () => {
    const small = checkTagForWrite(tag({ capacity: 300 }), request)!;
    const iso = checkTagForWrite(tag({ techTypes: ['NFCISO15693Tag'] }), request)!;
    expect(helpFor(small, 'native', false).offerOverride).toBe(true);
    expect(helpFor(iso, 'native', false).offerOverride).toBe(false);
  });

  it('asks for a different tag when the tag is the problem', () => {
    expect(helpFor(new NfcError('read-only', ''), 'native', false).retryLabel).toBe('Try another tag');
    expect(helpFor(new NfcError('tag-lost', ''), 'native', false).retryLabel).toBe('Try again');
  });

  it('offers NFC settings only where the app can open them', () => {
    expect(helpFor(new NfcError('disabled', ''), 'native', false).offerSettings).toBe(true);
    expect(helpFor(new NfcError('disabled', ''), 'native', true).offerSettings).toBe(false);
    expect(helpFor(new NfcError('disabled', ''), 'web', false).offerSettings).toBe(false);
  });

  it('points iPhone users at the top edge', () => {
    expect(helpFor(new NfcError('timeout', ''), 'native', true).tips[0]).toContain('top edge');
  });
});

describe('error mapping', () => {
  it('classifies native plugin errors', () => {
    expect(mapNativeError(new Error('Tag is read only.')).code).toBe('read-only');
    expect(mapNativeError(new Error('Tag capacity is insufficient for the provided message.')).code).toBe('too-small');
    expect(mapNativeError(new Error('Tag does not support NDEF.')).code).toBe('not-ndef');
    expect(mapNativeError(new Error('Failed to connect to tag.')).code).toBe('tag-lost');
    expect(mapNativeError(new Error('Failed to write NDEF message.')).code).toBe('write-failed');
    expect(mapNativeError(new Error('NFC is currently disabled.')).code).toBe('disabled');
    expect(mapNativeError(new Error('weird')).code).toBe('unknown');
  });

  it('classifies Web NFC DOMExceptions', () => {
    expect(mapWebError(new DOMException('', 'AbortError')).code).toBe('cancelled');
    expect(mapWebError(new DOMException('', 'NotAllowedError')).code).toBe('permission');
    expect(mapWebError(new DOMException('', 'NetworkError')).code).toBe('write-failed');
    expect(mapWebError(new DOMException('', 'NotSupportedError')).code).toBe('not-ndef');
  });

  it('names chips from their capacity', () => {
    expect(guessChip(137, null)).toBe('NTAG213');
    expect(guessChip(496, null)).toBe('NTAG215');
    expect(guessChip(868, null)).toBe('NTAG216');
    expect(guessChip(null, 'NFC Forum Type 2')).toBe('NFC Forum Type 2');
  });
});
