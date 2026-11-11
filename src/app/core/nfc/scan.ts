import { NfcError } from './nfc-types';

/** Runs scans one at a time: each starts only after the previous one, including tag work, is over. */
export class ScanQueue {
  private previous: Promise<unknown> = Promise.resolve();

  run<T>(scan: () => Promise<T>): Promise<T> {
    const next = this.previous.then(scan);
    this.previous = next.catch(() => undefined);
    return next;
  }
}

/** One scan's outcome, fed by whatever delivers tags and errors on a platform. */
export interface PendingScan<T> {
  readonly result: Promise<T>;
  /** Starts work on a delivered tag. Ignored once a tag is taken or the scan is over. */
  take(work: () => Promise<T>): void;
  /** Ends the scan with an error, unless a tag is already being worked on. */
  fail(error: NfcError): void;
}

/**
 * Cancelling while waiting for a tag ends the scan at once. Once a tag is taken, cancelling waits
 * for its work (a write takes about a second), so its commands never overlap the next scan and the
 * outcome reflects what actually happened to the tag.
 */
export function pendingScan<T>(signal: AbortSignal): PendingScan<T> {
  let busy = false;
  let settled = false;
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const settle = (finish: () => void) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener('abort', onAbort);
    finish();
  };
  const onAbort = () => {
    if (!busy) settle(() => reject(new NfcError('cancelled', 'Scan cancelled.')));
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });

  return {
    result,
    take(work) {
      if (busy || settled) return;
      busy = true;
      work().then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error instanceof NfcError ? error : new NfcError('unknown', String(error), undefined, { cause: error }))),
      );
    },
    fail(error) {
      if (!busy) settle(() => reject(error));
    },
  };
}
