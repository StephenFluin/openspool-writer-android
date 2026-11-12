import { NfcError } from './nfc-types';

/** Longest a tag's work may take before the scan gives up on it; a write takes about a second. */
const WORK_TIMEOUT_MS = 20_000;

/** Runs scans one at a time: each starts only after the previous one, including tag work, is over. */
export class ScanQueue {
  private previous: Promise<unknown> = Promise.resolve();

  /** A scan cancelled while still waiting its turn ends at once and never starts. */
  run<T>(signal: AbortSignal, scan: () => Promise<T>): Promise<T> {
    let started = false;
    const turn = this.previous.then(() => {
      started = true;
      signal.throwIfAborted();
      return scan();
    });
    this.previous = turn.catch(() => undefined);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (!started) reject(new NfcError('cancelled', 'Scan cancelled.'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      turn.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
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
      // Run in a microtask so a synchronous throw becomes a rejection, and bound it, so a native call
      // that never settles can't hold up every later scan.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new NfcError('unknown', 'The phone stopped responding while handling the tag. Try again.')),
          WORK_TIMEOUT_MS,
        );
      });
      Promise.race([Promise.resolve().then(work), timedOut])
        .finally(() => clearTimeout(timer))
        .then(
          (value) => settle(() => resolve(value)),
          (error) => settle(() => reject(error instanceof NfcError ? error : new NfcError('unknown', String(error), undefined, { cause: error }))),
        );
    },
    fail(error) {
      if (!busy) settle(() => reject(error));
    },
  };
}
