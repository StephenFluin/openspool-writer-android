import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { DraftService } from '../../core/draft.service';
import { displayName, FilamentSpec } from '../../core/filament';
import { helpFor, ProblemHelp } from '../../core/nfc/nfc-help';
import { checkTagForWrite, NfcError, TagInfo } from '../../core/nfc/nfc-types';
import { NfcService } from '../../core/nfc/nfc.service';
import { encodePayload, OPENSPOOL_MIME, tagBytesNeeded } from '../../core/openspool';
import { describeSpool, SpoolmanService } from '../../core/spoolman/spoolman.service';
import { SpoolmanSpool } from '../../core/spoolman/spoolman-types';
import { NfcStatusBanner } from '../../shared/nfc-status-banner';
import { TagSummary } from '../../shared/tag-summary';

type CheckState =
  | { step: 'idle' }
  | { step: 'scanning' }
  | { step: 'error'; help: ProblemHelp }
  | { step: 'result'; tag: TagInfo };

type OwnerState = { status: 'none' } | { status: 'loading' } | { status: 'found'; spool: SpoolmanSpool | undefined } | { status: 'error'; message: string };

/** A typical OpenSpool payload, for judging whether a tag has room. */
const TYPICAL_BYTES = tagBytesNeeded(
  encodePayload({
    protocol: 'openspool',
    version: '1.0',
    type: 'PETG-CF',
    color_hex: 'FFFFFF',
    brand: 'Manufacturer Name',
    subtype: 'Translucent',
    min_temp: '240',
    max_temp: '270',
    bed_min_temp: '70',
    bed_max_temp: '70',
    diameter: '1.75',
    weight: '1000',
  }).length,
);

@Component({
  selector: 'app-check-page',
  imports: [TagSummary, NfcStatusBanner],
  templateUrl: './check-page.html',
  styleUrl: './check-page.css',
})
export class CheckPage {
  protected readonly nfc = inject(NfcService);
  protected readonly spoolman = inject(SpoolmanService);
  private readonly draft = inject(DraftService);
  private readonly router = inject(Router);

  protected readonly state = signal<CheckState>({ step: 'idle' });
  protected readonly owner = signal<OwnerState>({ status: 'none' });
  protected readonly describeSpool = describeSpool;
  private abort: AbortController | null = null;

  protected readonly verdict = computed(() => {
    const state = this.state();
    if (state.step !== 'result') return null;
    const tag = state.tag;
    const problem = checkTagForWrite(tag, {
      mediaType: OPENSPOOL_MIME,
      data: new Uint8Array(),
      bytesNeeded: TYPICAL_BYTES,
      allowIncompatible: false,
    });
    if (problem) return { ok: false, text: problem.message };
    if (tag.openSpool) return { ok: true, text: 'Holds OpenSpool data the U1 can read.' };
    if (tag.records.length) return { ok: true, text: 'Holds other data. Writing a spool will replace it.' };
    return { ok: true, text: 'Empty and ready to write.' };
  });

  protected readonly contents = computed(() => {
    const state = this.state();
    return state.step === 'result' ? state.tag.openSpool : null;
  });

  protected title(spec: Partial<FilamentSpec>): string {
    return displayName({ brand: spec.brand ?? '', material: spec.material ?? '', subtype: spec.subtype ?? '' });
  }

  protected async scan(): Promise<void> {
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.state.set({ step: 'scanning' });
    this.owner.set({ status: 'none' });
    try {
      const tag = await this.nfc.read(abort.signal);
      if (this.abort !== abort) return;
      void this.nfc.haptic('success');
      this.state.set({ step: 'result', tag });
      void this.lookUpOwner(tag);
    } catch (caught) {
      if (this.abort !== abort) return;
      const error = caught instanceof NfcError ? caught : new NfcError('unknown', String(caught));
      if (error.code === 'cancelled') {
        this.state.set({ step: 'idle' });
        return;
      }
      this.state.set({ step: 'error', help: helpFor(error, this.nfc.kind, Capacitor.getPlatform() === 'ios') });
    }
  }

  protected cancel(): void {
    this.abort?.abort();
    this.abort = null;
    this.state.set({ step: 'idle' });
  }

  /** Loads the tag's contents into the write form so it can be edited and rewritten. */
  protected edit(spec: Partial<FilamentSpec>): void {
    const values = Object.fromEntries(Object.entries(spec).filter(([, v]) => v !== '' && v !== 0));
    this.draft.patch(values);
    void this.router.navigate(['/']);
  }

  protected useSpool(spool: SpoolmanSpool): void {
    this.draft.loadSpool(spool);
    void this.router.navigate(['/']);
  }

  private async lookUpOwner(tag: TagInfo): Promise<void> {
    if (!this.spoolman.configured() || !tag.uid) return;
    this.owner.set({ status: 'loading' });
    try {
      this.owner.set({ status: 'found', spool: await this.spoolman.findTagOwner(tag.uid) });
    } catch (error) {
      this.owner.set({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }
}
