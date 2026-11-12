import { PluginListenerHandle } from '@capacitor/core';
import { AndroidNfcBackend, TagReaderPlugin } from './android-nfc';
import { SystemNfc } from './native-common';
import { WriteRequest } from './nfc-types';

type Listener = (event: never) => void;

class FakeReader implements TagReaderPlugin {
  readonly calls: string[] = [];
  readonly tagIds: number[] = [];
  readonly listeners = new Map<string, Listener[]>();
  session = 0;
  startError: unknown = null;
  writeError: unknown = null;
  /** Raw commands hang until released, to stand in for a write in progress. */
  hold: Promise<void> | null = null;

  async start(options: { session: number; reuseTagId: number }): Promise<void> {
    this.calls.push(`start reuse=${options.reuseTagId}`);
    this.session = options.session;
    if (this.startError) throw this.startError;
  }
  async stop(): Promise<void> {
    this.calls.push('stop');
  }
  async transceive(options: { tagId: number }): Promise<{ response: number[] }> {
    this.calls.push('transceive');
    this.tagIds.push(options.tagId);
    await this.hold;
    throw Object.assign(new Error('Transceive failed.'), { code: 'IO' });
  }
  async writeNdef(options: { tagId: number }): Promise<void> {
    this.calls.push('writeNdef');
    this.tagIds.push(options.tagId);
    if (this.writeError) throw this.writeError;
  }
  async addListener(event: string, listener: Listener): Promise<PluginListenerHandle> {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return { remove: async () => undefined };
  }
  private emit(event: string, payload: object): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload as never);
  }
  tap(session = this.session, tagId = 7, id = [4, 1, 2, 3, 4, 5, 6]): void {
    this.emit('tag', { session, tag: { tagId, id, techTypes: ['android.nfc.tech.NfcA'] } });
  }
  turnOff(): void {
    this.emit('disabled', { session: this.session });
  }
}

const system: SystemNfc = {
  isSupported: async () => ({ supported: true }),
  getStatus: async () => ({ status: 'NFC_OK' }),
  showSettings: async () => undefined,
};
const request: WriteRequest = { mediaType: 'application/json', data: new Uint8Array([1]), bytesNeeded: 20, allowIncompatible: false };

describe('AndroidNfcBackend', () => {
  let reader: FakeReader;
  let backend: AndroidNfcBackend;

  beforeEach(() => {
    reader = new FakeReader();
    backend = new AndroidNfcBackend(reader, system);
  });

  it('only handles tags reported for its own scan, and sends commands to that tag', async () => {
    const read = backend.read(new AbortController().signal);
    await vi.waitFor(() => expect(reader.calls).toContain('start reuse=-1'));
    reader.tap(reader.session - 1, 6, [4, 9, 9, 9, 9, 9, 9]);
    reader.tap();
    await expect(read).resolves.toMatchObject({ uid: '04010203040506' });
    expect(new Set(reader.tagIds)).toEqual(new Set([7]));
    expect(reader.calls.at(-1)).toBe('stop');
  });

  it('stops the reader when a scan is cancelled while waiting', async () => {
    const abort = new AbortController();
    const read = backend.read(abort.signal);
    await vi.waitFor(() => expect(reader.calls).toContain('start reuse=-1'));
    abort.abort();
    await expect(read).rejects.toMatchObject({ code: 'cancelled' });
    expect(reader.calls.at(-1)).toBe('stop');
  });

  it('lets tag work finish when cancelled mid-way, so it never overlaps the next scan', async () => {
    let release!: () => void;
    reader.hold = new Promise((resolve) => (release = resolve));
    const abort = new AbortController();
    const first = backend.read(abort.signal);
    await vi.waitFor(() => expect(reader.calls).toContain('start reuse=-1'));
    reader.tap();
    await vi.waitFor(() => expect(reader.calls).toContain('transceive'));

    abort.abort();
    const second = backend.read(new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reader.calls.filter((c) => c.startsWith('start'))).toHaveLength(1);

    release();
    await expect(first).resolves.toMatchObject({ uid: '04010203040506' });
    await vi.waitFor(() => expect(reader.calls.filter((c) => c.startsWith('start'))).toHaveLength(2));
    expect(reader.calls.indexOf('stop')).toBeLessThan(reader.calls.lastIndexOf('start reuse=-1'));
    reader.tap();
    await second;
    expect(reader.listeners.get('tag')).toHaveLength(1);
  });

  it('ends a queued scan at once when it is cancelled before its turn', async () => {
    const first = backend.read(new AbortController().signal);
    const abort = new AbortController();
    const queued = backend.read(abort.signal);
    abort.abort();
    await expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(reader.calls).toContain('start reuse=-1'));
    reader.tap();
    await first;
    expect(reader.calls.filter((c) => c.startsWith('start'))).toHaveLength(1);
  });

  it('on retry, reuses only the tag the last scan failed on', async () => {
    reader.writeError = Object.assign(new Error('Write failed.'), { code: 'IO' });
    const failed = backend.write(request, new AbortController().signal);
    await vi.waitFor(() => expect(reader.calls).toContain('start reuse=-1'));
    reader.tap();
    await expect(failed).rejects.toMatchObject({ code: 'write-failed' });

    reader.writeError = null;
    const retried = backend.write(request, new AbortController().signal, { reuse: true });
    await vi.waitFor(() => expect(reader.calls).toContain('start reuse=7'));
    reader.tap();
    await retried;

    const next = backend.write(request, new AbortController().signal, { reuse: true });
    await vi.waitFor(() => expect(reader.calls.filter((c) => c === 'start reuse=-1')).toHaveLength(2));
    reader.tap();
    await next;
  });

  it('ends the scan when NFC is turned off', async () => {
    const read = backend.read(new AbortController().signal);
    await vi.waitFor(() => expect(reader.calls).toContain('start reuse=-1'));
    reader.turnOff();
    await expect(read).rejects.toMatchObject({ code: 'disabled' });
  });

  it('reports NFC turned off when the reader refuses to start', async () => {
    reader.startError = Object.assign(new Error('NFC is turned off.'), { code: 'DISABLED' });
    await expect(backend.read(new AbortController().signal)).rejects.toMatchObject({ code: 'disabled' });
    expect(reader.calls.at(-1)).toBe('stop');
  });
});
