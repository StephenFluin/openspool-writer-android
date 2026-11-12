import { FilamentSpec, normalizeHex } from './filament';

export const OPENSPOOL_MIME = 'application/json';

/**
 * Byte budget for the NDEF message. NTAG215 exposes 496 bytes of NDEF space and the U1's
 * built-in reader reads exactly the NTAG215 page range, so anything bigger is never seen.
 */
export const NTAG215_NDEF_BYTES = 496;
/** NTAG213 exposes 137 bytes of NDEF space; the U1 reader cannot read it. */
export const NTAG213_NDEF_BYTES = 137;

/**
 * OpenSpool payload as read by the Snapmaker U1 extended firmware and OpenRFID.
 *
 * `alpha` is deliberately never written: the built-in reader parses it as a decimal
 * integer while OpenRFID parses it as a hex string, and a value either one rejects makes
 * OpenRFID drop the whole tag. Leaving it out means "opaque" to both.
 *
 * Temperatures are strings, as in the OpenSpool spec; both readers run them through int().
 */
export interface OpenSpoolPayload {
  protocol: 'openspool';
  version: '1.0';
  type: string;
  color_hex: string;
  brand: string;
  subtype?: string;
  min_temp?: string;
  max_temp?: string;
  bed_min_temp?: string;
  bed_max_temp?: string;
  diameter?: string;
  weight?: string;
}

export function buildOpenSpoolPayload(spec: FilamentSpec): OpenSpoolPayload {
  const payload: OpenSpoolPayload = {
    protocol: 'openspool',
    version: '1.0',
    type: spec.material.trim().toUpperCase(),
    color_hex: normalizeHex(spec.colorHex) ?? 'FFFFFF',
    brand: spec.brand.trim() || 'Generic',
  };
  if (spec.subtype.trim()) payload.subtype = spec.subtype.trim();
  if (spec.nozzleMin > 0 && spec.nozzleMax >= spec.nozzleMin) {
    payload.min_temp = String(Math.round(spec.nozzleMin));
    payload.max_temp = String(Math.round(spec.nozzleMax));
  }
  if (spec.bedTemp > 0) {
    payload.bed_min_temp = String(Math.round(spec.bedTemp));
    payload.bed_max_temp = String(Math.round(spec.bedTemp));
  }
  if (spec.diameter > 0) payload.diameter = String(spec.diameter);
  if (spec.weight > 0) payload.weight = String(Math.round(spec.weight));
  return payload;
}

export function encodePayload(payload: OpenSpoolPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

/** Size of a single-record NDEF message carrying this MIME payload (header + type + payload). */
export function ndefMessageSize(payloadBytes: number, mimeType = OPENSPOOL_MIME): number {
  const shortRecord = payloadBytes < 256;
  return 1 + 1 + (shortRecord ? 1 : 4) + mimeType.length + payloadBytes;
}

/** Bytes needed on the tag: the NDEF message plus its TLV wrapper and terminator. */
export function tagBytesNeeded(payloadBytes: number): number {
  const message = ndefMessageSize(payloadBytes);
  return message + (message < 255 ? 2 : 4) + 1;
}

/** Parses a tag payload; returns null when it is not an OpenSpool record. */
export function parseOpenSpool(data: Uint8Array): Partial<FilamentSpec> | null {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;
  const raw = json as Record<string, unknown>;
  if (raw['protocol'] !== 'openspool') return null;

  // Only plain values: converting an object such as {"toString": 1} would throw.
  const primitive = (key: string) => {
    const value = raw[key];
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null;
  };
  const text = (key: string) => String(primitive(key) ?? '');
  const num = (key: string) => {
    const value = Number(primitive(key) ?? NaN);
    return Number.isFinite(value) ? value : 0;
  };
  return {
    material: text('type').toUpperCase(),
    subtype: text('subtype'),
    brand: text('brand'),
    colorHex: normalizeHex(text('color_hex')) ?? '',
    nozzleMin: num('min_temp'),
    nozzleMax: num('max_temp'),
    bedTemp: num('bed_min_temp') || num('bed_max_temp'),
    diameter: num('diameter'),
    weight: num('weight'),
  };
}

/** Formats raw UID bytes the way the U1 and Spoolman store them: uppercase hex, no separators. */
export function uidToHex(uid: ArrayLike<number> | string): string {
  if (typeof uid === 'string') return uid.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return Array.from(uid, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}
