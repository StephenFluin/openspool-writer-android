import { ndefMessageSize, OPENSPOOL_MIME } from '../openspool';
import { analyzeChip, canWriteRaw, ChipReadings, encodeNdefMessage, identifyChip, NTAG213, NTAG215, type2PageWrites } from './type2';

const VERSION_215 = [0x00, 0x04, 0x04, 0x02, 0x01, 0x00, 0x11, 0x03];
const FORMATTED_CC = [0xe1, 0x10, 0x3e, 0x00];

function readings(overrides: { version?: number[] | null; locks?: number[]; cc?: number[]; auth0?: number } = {}): ChipReadings {
  return {
    version: overrides.version === undefined ? VERSION_215 : overrides.version,
    header: [0x04, 0x8a, 0xa0, 0xae, 0xf2, 0xd0, 0x4f, 0x81, 0x00, 0x48, ...(overrides.locks ?? [0, 0]), ...(overrides.cc ?? FORMATTED_CC)],
    config: [0, 0, 0, 0xbd, 0x04, 0, 0, overrides.auth0 ?? 0xff, 0, 0, 0, 0, 0, 0, 0, 0],
  };
}

describe('identifyChip', () => {
  it('names NTAG213, 215 and 216 from GET_VERSION', () => {
    expect(identifyChip([0x00, 0x04, 0x04, 0x02, 0x01, 0x00, 0x0f, 0x03])?.name).toBe('NTAG213');
    expect(identifyChip(VERSION_215)?.name).toBe('NTAG215');
    expect(identifyChip([0x00, 0x04, 0x04, 0x02, 0x01, 0x00, 0x13, 0x03])?.name).toBe('NTAG216');
  });

  it('does not claim other chips are NTAGs', () => {
    expect(identifyChip([0x00, 0x04, 0x03, 0x01, 0x01, 0x00, 0x0b, 0x03])).toBeNull(); // Ultralight EV1
    expect(identifyChip(null)).toBeNull();
  });
});

describe('analyzeChip', () => {
  it('reports a healthy NTAG215', () => {
    const report = analyzeChip(readings());
    expect(report).toMatchObject({
      chip: 'NTAG215',
      knownNtag: true,
      ndefFormatted: true,
      ndefCapacity: 496,
      locked: false,
      passwordProtected: false,
    });
    expect(report.findings).toEqual(['This looks like a genuine, writable NTAG215.']);
    expect(canWriteRaw(report)).toBe(true);
  });

  it('treats a blank tag as writable once formatted', () => {
    const report = analyzeChip(readings({ cc: [0, 0, 0, 0] }));
    expect(report.ndefFormatted).toBe(false);
    expect(report.ndefCapacity).toBe(496);
    expect(report.findings[0]).toMatch(/blank and not NDEF formatted/);
    expect(canWriteRaw(report)).toBe(true);
  });

  it('flags passwords, lock bits and read-only headers', () => {
    expect(analyzeChip(readings({ auth0: 0x04 })).passwordProtected).toBe(true);
    expect(analyzeChip(readings({ locks: [0x0f, 0xe0] })).locked).toBe(true);
    expect(analyzeChip(readings({ cc: [0xe1, 0x10, 0x3e, 0x0f] })).locked).toBe(true);
    expect(canWriteRaw(analyzeChip(readings({ auth0: 0x04 })))).toBe(false);
  });

  it('does not count block-locking bits or a locked valid header as locked pages', () => {
    expect(analyzeChip(readings({ locks: [0x07, 0x00] })).locked).toBe(false);
    expect(analyzeChip(readings({ locks: [0x08, 0x00] })).locked).toBe(false);
  });

  it('treats a configuration the chip refuses to read as read-protected', () => {
    const report = analyzeChip({ ...readings(), config: null, configUnreadable: true });
    expect(report.passwordProtected).toBe(true);
    expect(report.findings[0]).toMatch(/password blocks reading/);
  });

  it('counts a read password over the configuration pages, which the U1 also reads', () => {
    const config = readings({ auth0: 0x83 }).config!;
    config[8] = 0x80; // PROT
    expect(analyzeChip({ ...readings(), config }).passwordProtected).toBe(true);
  });

  it('only formats page 3 when its one-time-programmable bits still allow it', () => {
    expect(analyzeChip(readings({ cc: [0xe1, 0x00, 0x00, 0x00] }))).toMatchObject({ needsFormat: true, ccUsable: true });
    const broken = analyzeChip(readings({ cc: [0xe1, 0x10, 0x7f, 0x00] }));
    expect(broken).toMatchObject({ needsFormat: false, ccUsable: false });
    expect(canWriteRaw(broken)).toBe(false);
    // A locked, blank page 3 can never become an NDEF header.
    expect(analyzeChip(readings({ cc: [0, 0, 0, 0], locks: [0x08, 0x00] })).ccUsable).toBe(false);
  });

  it('detects UID mirroring into user memory', () => {
    const config = readings().config!;
    config[4] = 0x44;
    config[6] = 0x10;
    const report = analyzeChip({ ...readings(), config });
    expect(report.mirrored).toBe(true);
    expect(canWriteRaw(report)).toBe(false);
  });

  it('calls out NTAG213 and chips that will not say what they are', () => {
    expect(analyzeChip(readings({ version: [0x00, 0x04, 0x04, 0x02, 0x01, 0x00, 0x0f, 0x03] })).findings[0]).toMatch(/too small/);
    const clone = analyzeChip({ ...readings({ version: null }), config: null });
    expect(clone.knownNtag).toBe(false);
    expect(clone.findings[0]).toMatch(/clone/);
    expect(canWriteRaw(clone)).toBe(false);
  });
});

describe('type2PageWrites', () => {
  const payload = new TextEncoder().encode(JSON.stringify({ protocol: 'openspool', type: 'PLA', color_hex: 'FFFFFF' }));

  it('encodes a short MIME record the same size the capacity check assumes', () => {
    const message = encodeNdefMessage(OPENSPOOL_MIME, payload);
    expect(message[0]).toBe(0xd2);
    expect(message.length).toBe(ndefMessageSize(payload.length));
  });

  it('lays out a TLV the U1 reader can parse, with the NDEF header written last', () => {
    const message = encodeNdefMessage(OPENSPOOL_MIME, payload);
    const { sequence, expected } = type2PageWrites(NTAG215, message, true);
    expect(sequence.at(-1)).toEqual({ page: 3, data: [0xe1, 0x10, 0x3e, 0x00] });
    expect(sequence.at(-2)?.page).toBe(4);

    const memory = expected
      .filter((w) => w.page >= 4)
      .sort((a, b) => a.page - b.page)
      .flatMap((w) => w.data);
    expect(memory[0]).toBe(0x03);
    expect(memory[1]).toBe(message.length);
    expect(memory.slice(2, 2 + message.length)).toEqual(Array.from(message));
    expect(memory[2 + message.length]).toBe(0xfe);
    // The payload is the record's tail.
    expect(new TextDecoder().decode(Uint8Array.from(memory.slice(2 + message.length - payload.length, 2 + message.length)))).toContain('openspool');
  });

  it('uses the three-byte TLV length for long messages', () => {
    const big = encodeNdefMessage(OPENSPOOL_MIME, new Uint8Array(300));
    const { sequence } = type2PageWrites(NTAG215, big, false);
    // An interrupted rewrite leaves an empty message, not a half-written one.
    expect(sequence[0]).toEqual({ page: 4, data: [0x03, 0x00, 0xfe, 0x00] });
    expect(sequence.at(-1)).toEqual({ page: 4, data: [0x03, 0xff, (big.length >> 8) & 0xff, big.length & 0xff] });
  });

  it('refuses messages that do not fit the chip', () => {
    expect(() => type2PageWrites(NTAG213, encodeNdefMessage(OPENSPOOL_MIME, new Uint8Array(200)), false)).toThrow(RangeError);
  });
});
