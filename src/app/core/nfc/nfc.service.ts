import { DOCUMENT, isDevMode, inject, Service, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Haptics, NotificationType } from '@capacitor/haptics';
import { MOCK_SCENARIOS, MockNfcBackend, MockScenario } from './mock-nfc';
import { NativeNfcBackend } from './native-nfc';
import { NfcAvailability, NfcBackend, NfcError, TagInfo, WriteRequest } from './nfc-types';
import { WebNfcBackend } from './web-nfc';

const SCAN_TIMEOUT_MS = 60_000;

@Service()
export class NfcService {
  private readonly document = inject(DOCUMENT);
  private readonly backend = createBackend(this.document);

  readonly kind = this.backend.kind;
  readonly canOpenSettings = this.backend.openSettings !== undefined;
  private readonly availabilityState = signal<NfcAvailability | 'checking'>('checking');
  readonly availability = this.availabilityState.asReadonly();

  constructor() {
    void this.refresh();
    // Users often flip NFC on in system settings and come back.
    this.document.addEventListener('visibilitychange', () => {
      if (this.document.visibilityState === 'visible') void this.refresh();
    });
  }

  async refresh(): Promise<void> {
    try {
      this.availabilityState.set(await this.backend.availability());
    } catch {
      this.availabilityState.set('unsupported');
    }
  }

  read(signal: AbortSignal): Promise<TagInfo> {
    return this.withTimeout((s) => this.backend.read(s), signal);
  }

  write(request: WriteRequest, signal: AbortSignal): Promise<TagInfo> {
    return this.withTimeout((s) => this.backend.write(request, s), signal);
  }

  async openSettings(): Promise<void> {
    await this.backend.openSettings?.();
  }

  /** Buzz so the user knows the write landed without looking at the screen. */
  async haptic(kind: 'success' | 'error'): Promise<void> {
    try {
      if (Capacitor.isNativePlatform()) {
        await Haptics.notification({ type: kind === 'success' ? NotificationType.Success : NotificationType.Error });
      } else {
        navigator.vibrate?.(kind === 'success' ? 80 : [60, 60, 60]);
      }
    } catch {
      // Haptics are a nicety.
    }
  }

  private async withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(SCAN_TIMEOUT_MS);
    try {
      return await operation(AbortSignal.any([signal, timeout]));
    } catch (error) {
      if (timeout.aborted && !signal.aborted) {
        throw new NfcError('timeout', `No tag was found within ${SCAN_TIMEOUT_MS / 1000} seconds.`);
      }
      if (error instanceof NfcError && (error.code === 'disabled' || error.code === 'unsupported')) {
        void this.refresh();
      }
      throw error;
    }
  }
}

function createBackend(document: Document): NfcBackend {
  if (isDevMode()) {
    const scenario = mockScenario(document);
    if (scenario) return new MockNfcBackend(scenario);
  }
  return Capacitor.isNativePlatform() ? new NativeNfcBackend() : new WebNfcBackend();
}

/** `?nfc=mock` or `?nfc=mock-<scenario>` turns on the simulated tag for the rest of the tab session. */
function mockScenario(document: Document): MockScenario | null {
  const storage = document.defaultView?.sessionStorage;
  const param = new URLSearchParams(document.location.search).get('nfc');
  if (param !== null) {
    if (param.startsWith('mock')) storage?.setItem('nfc-mock', param.replace(/^mock-?/, '') || 'blank');
    else storage?.removeItem('nfc-mock');
  }
  const stored = storage?.getItem('nfc-mock');
  return MOCK_SCENARIOS.find((s) => s === stored) ?? null;
}
