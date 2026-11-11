import type { CapacitorNfcPlugin } from '@capgo/capacitor-nfc';
import { NfcAvailability, NfcError } from './nfc-types';

/** The parts of @capgo/capacitor-nfc both native backends use for NFC status and settings. */
export type SystemNfc = Pick<CapacitorNfcPlugin, 'isSupported' | 'getStatus' | 'showSettings'>;

/** Per-command timeout for raw NTAG commands; each one takes a few milliseconds on a healthy tag. */
export const COMMAND_TIMEOUT_MS = 500;

export async function nativeAvailability(nfc: SystemNfc): Promise<NfcAvailability> {
  const { supported } = await nfc.isSupported();
  if (!supported) return 'unsupported';
  const { status } = await nfc.getStatus();
  if (status === 'NO_NFC') return 'unsupported';
  if (status === 'NFC_DISABLED') return 'disabled';
  return 'ready';
}

/** Throws when a scan can't start: no NFC hardware, or NFC turned off. */
export async function requireNfc(nfc: SystemNfc): Promise<void> {
  const availability = await nativeAvailability(nfc);
  if (availability === 'unsupported') throw new NfcError('unsupported', 'This device has no NFC reader.');
  if (availability === 'disabled') throw new NfcError('disabled', 'NFC is turned off.');
}

/** The code a Capacitor plugin rejected with, if any. */
export function errorCode(error: unknown): string | undefined {
  return (error as { code?: unknown } | null)?.code?.toString();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
