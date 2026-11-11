import { Component, computed, DOCUMENT, inject, signal } from '@angular/core';
import { form, FormField, submit, validate } from '@angular/forms/signals';
import { Capacitor } from '@capacitor/core';
import { NfcService } from '../../core/nfc/nfc.service';
import { SettingsService } from '../../core/settings.service';
import { normalizeSpoolmanUrl, SpoolmanService } from '../../core/spoolman/spoolman.service';

type TestState = { status: 'idle' } | { status: 'testing' } | { status: 'ok'; version: string } | { status: 'error'; message: string };

const NFC_LABELS: Record<string, string> = {
  checking: 'Checking…',
  ready: 'Ready',
  disabled: 'Turned off',
  unsupported: 'Not available on this device',
  'web-unsupported': 'Not available in this browser',
  'permission-denied': 'Blocked for this site',
};

@Component({
  selector: 'app-settings-page',
  imports: [FormField],
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.css',
})
export class SettingsPage {
  private readonly settings = inject(SettingsService);
  protected readonly spoolman = inject(SpoolmanService);
  protected readonly nfc = inject(NfcService);

  protected readonly model = signal({
    spoolmanUrl: this.settings.spoolmanUrl(),
    spoolmanSync: this.settings.spoolmanSync(),
    defaultLocation: this.settings.defaultLocation(),
  });
  protected readonly f = form(this.model, (path) => {
    validate(path.spoolmanUrl, ({ value }) => {
      if (!value().trim()) return null;
      try {
        new URL(normalizeSpoolmanUrl(value()));
        return null;
      } catch {
        return { kind: 'url', message: 'That doesn’t look like an address. Try something like 192.168.1.20:7912.' };
      }
    });
  });

  protected readonly test = signal<TestState>({ status: 'idle' });
  protected readonly normalizedUrl = computed(() => normalizeSpoolmanUrl(this.model().spoolmanUrl));
  protected readonly mixedContent = computed(
    () => this.normalizedUrl() !== '' && this.spoolman.isMixedContentBlocked(this.normalizedUrl()),
  );
  protected readonly isWeb = !Capacitor.isNativePlatform();
  protected readonly origin = inject(DOCUMENT).location.origin;
  protected readonly nfcLabel = computed(() => NFC_LABELS[this.nfc.availability()] ?? this.nfc.availability());
  protected readonly nfcBackend = {
    native: `Native (${Capacitor.getPlatform()})`,
    web: 'Web NFC',
    mock: 'Simulated (dev mode)',
  }[this.nfc.kind];

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.f, {
      action: async () => {
        const value = this.model();
        this.settings.update({
          spoolmanUrl: this.normalizedUrl(),
          spoolmanSync: value.spoolmanSync,
          defaultLocation: value.defaultLocation.trim(),
        });
        this.model.update((m) => ({ ...m, spoolmanUrl: this.normalizedUrl() }));
        this.spoolman.vendors.reload();
        if (this.normalizedUrl()) await this.testConnection();
        else this.test.set({ status: 'idle' });
        return undefined;
      },
    });
  }

  protected async testConnection(): Promise<void> {
    this.test.set({ status: 'testing' });
    try {
      const info = await this.spoolman.info(this.normalizedUrl());
      this.test.set({ status: 'ok', version: info.version });
    } catch (error) {
      this.test.set({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }
}
