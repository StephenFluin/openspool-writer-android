import { defaultSpec, FilamentSpec, normalizeHex } from './filament';
import {
  buildOpenSpoolPayload,
  encodePayload,
  ndefMessageSize,
  NTAG215_NDEF_BYTES,
  OPENSPOOL_MIME,
  parseOpenSpool,
  tagBytesNeeded,
  uidToHex,
} from './openspool';

const spec: FilamentSpec = {
  ...defaultSpec(),
  material: 'petg',
  subtype: 'Matte',
  brand: ' Polymaker ',
  colorName: 'Red',
  colorHex: '#c12e1f',
  nozzleMin: 235,
  nozzleMax: 260,
  bedTemp: 70,
};

/** Mirrors the U1 extended firmware's openspool_parse_payload (filament_protocol_ndef.py). */
function parseLikeBuiltInReader(json: Record<string, unknown>) {
  const int = (v: unknown) => {
    if (typeof v === 'number') return Math.trunc(v);
    if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) return parseInt(v, 10);
    throw new TypeError(`int() can't parse ${String(v)}`);
  };
  let alpha: number;
  try {
    alpha = int(json['alpha']);
  } catch {
    alpha = 0xff;
  }
  return {
    vendor: json['brand'] ?? 'Generic',
    mainType: String(json['type'] ?? 'PLA').toUpperCase(),
    rgb: parseInt(String(json['color_hex']).replace(/^#/, ''), 16),
    alpha,
    hotendMin: int(json['min_temp'] ?? 0),
    hotendMax: int(json['max_temp'] ?? 0),
    bed: int(json['bed_min_temp'] ?? 0),
    weight: int(json['weight'] ?? 0),
  };
}

/** Mirrors OpenRFID's OpenSpool processor, which parses alpha as hex and rejects the tag on failure. */
function parseLikeOpenRfid(json: Record<string, unknown>) {
  const alphaRaw = json['alpha'] ?? 'FF';
  if (typeof alphaRaw !== 'string') throw new TypeError("int() can't convert non-string with explicit base");
  const min = Number.parseInt(String(json['min_temp'] ?? 0), 10);
  const max = Number.parseInt(String(json['max_temp'] ?? 0), 10);
  if (max < min) throw new Error('Invalid temperature values');
  return { alpha: parseInt(alphaRaw, 16), min, max };
}

describe('buildOpenSpoolPayload', () => {
  it('writes the OpenSpool fields the U1 reads', () => {
    expect(buildOpenSpoolPayload(spec)).toEqual({
      protocol: 'openspool',
      version: '1.0',
      type: 'PETG',
      color_hex: 'C12E1F',
      brand: 'Polymaker',
      subtype: 'Matte',
      min_temp: '235',
      max_temp: '260',
      bed_min_temp: '70',
      bed_max_temp: '70',
      diameter: '1.75',
      weight: '1000',
    });
  });

  it('never writes alpha, which the two U1 readers parse incompatibly', () => {
    expect('alpha' in buildOpenSpoolPayload(spec)).toBe(false);
  });

  it('is accepted by both U1 reader implementations', () => {
    const json = JSON.parse(new TextDecoder().decode(encodePayload(buildOpenSpoolPayload(spec))));
    expect(parseLikeBuiltInReader(json)).toEqual({
      vendor: 'Polymaker',
      mainType: 'PETG',
      rgb: 0xc12e1f,
      alpha: 0xff,
      hotendMin: 235,
      hotendMax: 260,
      bed: 70,
      weight: 1000,
    });
    expect(parseLikeOpenRfid(json)).toEqual({ alpha: 0xff, min: 235, max: 260 });
  });

  it('falls back to Generic and leaves out empty or inconsistent values', () => {
    const payload = buildOpenSpoolPayload({ ...spec, brand: '', subtype: '', nozzleMin: 260, nozzleMax: 200, bedTemp: 0 });
    expect(payload.brand).toBe('Generic');
    expect(payload.subtype).toBeUndefined();
    expect(payload.min_temp).toBeUndefined();
    expect(payload.bed_min_temp).toBeUndefined();
  });
});

describe('NDEF sizing', () => {
  it('matches a hand-built NDEF record', () => {
    const payload = encodePayload(buildOpenSpoolPayload(spec));
    const type = new TextEncoder().encode(OPENSPOOL_MIME);
    // MB|ME|SR|TNF=MIME, type length, payload length, type, payload
    const record = [0xd2, type.length, payload.length, ...type, ...payload];
    expect(ndefMessageSize(payload.length)).toBe(record.length);
    // Plus the 0x03 TLV header (2 bytes) and the 0xFE terminator.
    expect(tagBytesNeeded(payload.length)).toBe(record.length + 3);
  });

  it('fits a long, fully filled spool on an NTAG215', () => {
    const big = buildOpenSpoolPayload({ ...spec, brand: 'A Rather Long Manufacturer Name Inc.', subtype: 'Translucent' });
    expect(tagBytesNeeded(encodePayload(big).length)).toBeLessThan(NTAG215_NDEF_BYTES);
  });
});

describe('parseOpenSpool', () => {
  it('round-trips a written payload', () => {
    const parsed = parseOpenSpool(encodePayload(buildOpenSpoolPayload(spec)));
    expect(parsed).toMatchObject({ material: 'PETG', brand: 'Polymaker', colorHex: 'C12E1F', nozzleMin: 235, bedTemp: 70 });
  });

  it('accepts numeric temperatures and # colors written by other apps', () => {
    const data = new TextEncoder().encode('{"protocol":"openspool","type":"pla","color_hex":"#ffaabb","min_temp":220}');
    expect(parseOpenSpool(data)).toMatchObject({ material: 'PLA', colorHex: 'FFAABB', nozzleMin: 220 });
  });

  it('ignores JSON that is not OpenSpool', () => {
    expect(parseOpenSpool(new TextEncoder().encode('{"hello":1}'))).toBeNull();
    expect(parseOpenSpool(new TextEncoder().encode('not json'))).toBeNull();
  });
});

describe('helpers', () => {
  it('formats UIDs like the U1 and Spoolman', () => {
    expect(uidToHex([0x04, 0xa1, 0x0b, 0xff])).toBe('04A10BFF');
    expect(uidToHex('04:a1:0b:ff')).toBe('04A10BFF');
  });

  it('normalizes hex colors', () => {
    expect(normalizeHex('#f60')).toBe('FF6600');
    expect(normalizeHex(' ff6a13 ')).toBe('FF6A13');
    expect(normalizeHex('orange')).toBeNull();
  });
});
