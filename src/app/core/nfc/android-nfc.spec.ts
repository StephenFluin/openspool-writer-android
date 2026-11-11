import { PluginListenerHandle } from '@capacitor/core';
import { AndroidNfcBackend, TagReaderPlugin } from './android-nfc';
import { SystemNfc } from './native-common';

type TagListener = Parameters<TagReaderPlugin['addListener']>[1];

class FakeReader implements TagReaderPlugin {
  readonly calls: string[] = [];
  listeners = 0;
  session = 0;
  startError: unknown = null;
  /** Raw commands hang until released, to stand in for a write in progress. */
  hold: Promise<void> | null = null;
  private listener: TagListener | null = null;

  async start(options: { session: number; reusePresent: boolean }): Promise<void> {
    this.calls.push(`start reuse=${options.reusePresent}`);
    this.session = options.session;
    if (this.startError) throw this.startError;
  }
  async stop(): Promise<void> {
    this.calls.push('stop');
  }
  async transceive(): Promise<{ response: number[] }> {
    this.calls.push('transceive');
    await this.hold;
    throw Object.assign(new Error('Transceive failed.'), { code: 'IO' });
  }
  async writeNdef(): Promise<void> {
    this.calls.push('writeNdef');
  }
  async addListener(_event: 'tag', listener: TagListener): Promise<PluginListenerHandle> {
    this.listeners++;
    this.listener = listener;
    return { remove: async () => undefined };
  }
  tap(session = this.session): void {
    this.listener?.({ session, tag: { tagId: 7, id: [4, 1, 2, 3, 4, 5, 6], techTypes: ['android.nfc.tech.NfcA'] } });
  }
}

const system: SystemNfc = {
  isSupported: async () => ({ supported: true }),
  getStatus: async () => ({ status: 'NFC_OK' }),
  showSettings: async () => undefined,
};

describe('AndroidNfcBackend', () => {
  let reader: FakeReader;
  let backend: AndroidNfcBackend;

  beforeEach(() => {
    reader = new FakeReader();
    backend = new AndroidNfcBackend(reader, system);
  });

  it('only accepts tags reported for its own scan', async () => {
    const read = backend.read(new AbortController().signal);
    await vi.waitFor(() => expect(reader.calls).toContain('start reuse=false'));
    reader.tap(reader.session - 1);
    reader.tap();
    await expect(read).resolves.toMatchObject({ uid: '04010203040506' });
    expect(reader.calls.at(-1)).toBe('stop');
  });

  it('stops the reader when a scan is cancelled while waiting', async () => {
    const abort = new AbortController();
    const read = backend.read(abort.signal);
    await vi.waitFor(() => expect(reader.calls).toContain('start reuse=false'));
    abort.abort();
    await expect(read).rejects.toMatchObject({ code: 'cancelled' });
    expect(reader.calls.at(-1)).toBe('stop');
  });

  it('lets tag work finish when cancelled mid-way, so it never overlaps the next scan', async () => {
    let release!: () => void;
    reader.hold = new Promise((resolve) => (release = resolve));
    const abort = new AbortController();
    const first = backend.read(abort.signal);
    await vi.waitFor(() => expect(reader.calls).toContain('start reuse=false'));
    reader.tap();
    await vi.waitFor(() => expect(reader.calls).toContain('transceive'));

    abort.abort();
    const second = backend.read(new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reader.calls.filter((c) => c.startsWith('start'))).toHaveLength(1);

    release();
    await expect(first).resolves.toMatchObject({ uid: '04010203040506' });
    await vi.waitFor(() => expect(reader.calls.filter((c) => c.startsWith('start'))).toHaveLength(2));
    expect(reader.calls.indexOf('stop')).toBeLessThan(reader.calls.lastIndexOf('start reuse=false'));
    reader.tap();
    await second;
    expect(reader.listeners).toBe(1);
  });

  it('asks the reader to reuse a tag still on the phone when retrying', async () => {
    const write = backend.write(
      { mediaType: 'application/json', data: new Uint8Array([1]), bytesNeeded: 20, allowIncompatible: false },
      new AbortController().signal,
      { reuse: true },
    );
    await vi.waitFor(() => expect(reader.calls).toContain('start reuse=true'));
    reader.tap();
    await write;
    expect(reader.calls).toContain('writeNdef');
  });

  it('reports NFC turned off when the reader refuses to start', async () => {
    reader.startError = Object.assign(new Error('NFC is turned off.'), { code: 'DISABLED' });
    await expect(backend.read(new AbortController().signal)).rejects.toMatchObject({ code: 'disabled' });
    expect(reader.calls.at(-1)).toBe('stop');
  });
});
