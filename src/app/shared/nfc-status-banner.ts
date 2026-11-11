import { Component, computed, inject } from '@angular/core';
import { NfcService } from '../core/nfc/nfc.service';

/** Explains up front when this device can't write tags, instead of failing at the end. */
@Component({
  selector: 'app-nfc-status-banner',
  template: `
    @if (message(); as m) {
      <div class="banner" role="status">
        <p>
          <strong>{{ m.title }}</strong>
          {{ m.body }}
        </p>
        @if (m.settings) {
          <button type="button" class="button" (click)="nfc.openSettings()">Open NFC settings</button>
        }
      </div>
    }
    @if (nfc.kind === 'mock') {
      <p class="mock">Simulated NFC (dev mode). Add <code>?nfc=mock-readonly</code>, <code>-ntag213</code>, <code>-absent</code>… to the URL to try other tags, or <code>?nfc=off</code> to turn it off.</p>
    }
  `,
  styles: `
    .banner {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1rem;
      padding: 0.75rem 1rem;
      border-radius: var(--radius);
      background: var(--warning-soft);
      border: 1px solid var(--warning);
    }
    p {
      flex: 1 1 16rem;
      margin: 0;
    }
    .mock {
      margin-bottom: 1rem;
      font-size: 0.8125rem;
      color: var(--text-muted);
    }
  `,
})
export class NfcStatusBanner {
  protected readonly nfc = inject(NfcService);

  protected readonly message = computed(() => {
    switch (this.nfc.availability()) {
      case 'disabled':
        return {
          title: 'NFC is off.',
          body: 'Turn it on to write tags.',
          settings: this.nfc.canOpenSettings,
        };
      case 'unsupported':
        return { title: 'No NFC on this device.', body: 'You can fill in the form, but you’ll need an NFC phone to write the tag.', settings: false };
      case 'web-unsupported':
        return {
          title: 'This browser can’t write NFC tags.',
          body: 'Open this page in Chrome on an Android phone, or use the Android/iOS app.',
          settings: false,
        };
      case 'permission-denied':
        return {
          title: 'NFC is blocked for this site.',
          body: 'Allow NFC in Chrome’s site settings (tap the icon left of the address).',
          settings: false,
        };
      default:
        return null;
    }
  });
}
