import { PluginListenerHandle } from '@capacitor/core';
import { NfcEvent, NfcSessionEndEvent } from '@capgo/capacitor-nfc';
import { IosNfcBackend } from './ios-nfc';

type Listener = (event: NfcEvent & NfcSessionEndEvent) => void;

/** Just enough of @capgo/capacitor-nfc's iOS behaviour for the session logic. */
class FakeCapgo {
  readonly calls: string[] = [];
  readonly listeners = new Map<string, Listener[]>();
  removed = 0;
  startScanning = vi.fn(async () => {
    this.calls.push('startScanning');
  });

  isSupported = async () => ({ supported: true });
  getStatus = async () => ({ status: 'NFC_OK' as const });
  showSettings = async () => undefined;
  stopScanning = async () => {
    this.calls.push('stopScanning');
  };
  transceive = async () => ({ response: [] as number[] });
  write = async () => undefined;
  addListener = async (name: string, listener: Listener): Promise<PluginListenerHandle> => {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    return { remove: async () => void this.removed++ };
  };

  emit(name: string, event: object): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event as NfcEvent & NfcSessionEndEvent);
  }
}

describe('IosNfcBackend', () => {
  let nfc: FakeCapgo;
  let backend: IosNfcBackend;

  beforeEach(() => {
    nfc = new FakeCapgo();
    backend = new IosNfcBackend(nfc as never);
  });

  it('keeps one set of listeners for every scan, so the plugin never replays old events', async () => {
    for (let i = 0; i < 2; i++) {
      const read = backend.read(new AbortController().signal);
      await vi.waitFor(() => expect(nfc.startScanning).toHaveBeenCalledTimes(i + 1));
      nfc.emit('nfcEvent', { type: 'tag', tag: { id: [4, 1, 2, 3], techTypes: ['NFCMiFareTag'] } });
      await expect(read).resolves.toMatchObject({ uid: '04010203' });
    }
    expect(nfc.listeners.get('nfcEvent')).toHaveLength(1);
    expect(nfc.removed).toBe(0);
    expect(nfc.calls.filter((c) => c === 'stopScanning')).toHaveLength(2);
  });

  it('reports the real reason when the sheet never comes up', async () => {
    nfc.startScanning.mockImplementationOnce(async () => {
      nfc.emit('nfcSessionEnd', { reason: 'invalidated' });
      throw new Error('NFC is not available on this device.');
    });
    await expect(backend.read(new AbortController().signal)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('reports a session that ends while a tag is being handled as the tag moving, not a refusal', async () => {
    nfc.transceive = async () => {
      nfc.emit('nfcSessionEnd', { reason: 'invalidated' });
      throw new Error('Transceive failed.');
    };
    const read = backend.read(new AbortController().signal);
    await vi.waitFor(() => expect(nfc.startScanning).toHaveBeenCalledTimes(1));
    nfc.emit('nfcEvent', { type: 'tag', tag: { id: [4, 1, 2, 3], techTypes: ['NFCMiFareTag'] } });
    await expect(read).rejects.toMatchObject({ code: 'tag-lost' });
  });

  it('tells a timeout apart from the iPhone ending the session', async () => {
    const timedOut = backend.read(new AbortController().signal);
    await vi.waitFor(() => expect(nfc.startScanning).toHaveBeenCalledTimes(1));
    nfc.emit('nfcSessionEnd', { reason: 'sessionTimeout' });
    await expect(timedOut).rejects.toMatchObject({ code: 'timeout' });

    const ended = backend.read(new AbortController().signal);
    await vi.waitFor(() => expect(nfc.startScanning).toHaveBeenCalledTimes(2));
    nfc.emit('nfcSessionEnd', { reason: 'invalidated' });
    await expect(ended).rejects.toMatchObject({ code: 'unknown', message: expect.stringMatching(/one tag/) });
  });
});
