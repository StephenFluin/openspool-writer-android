import { Component, computed, effect, ElementRef, inject, viewChild } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { DraftService } from '../../core/draft.service';
import { displayName } from '../../core/filament';
import { NfcService } from '../../core/nfc/nfc.service';
import { describeSpool, SpoolmanService } from '../../core/spoolman/spoolman.service';
import { SpoolmanSpool } from '../../core/spoolman/spoolman-types';
import { TagSummary } from '../../shared/tag-summary';
import { WriteFlow } from './write-flow';

@Component({
  selector: 'app-write-dialog',
  imports: [TagSummary],
  templateUrl: './write-dialog.html',
  styleUrl: './write-dialog.css',
})
export class WriteDialog {
  protected readonly flow = inject(WriteFlow);
  protected readonly nfc = inject(NfcService);
  protected readonly spoolman = inject(SpoolmanService);
  private readonly draft = inject(DraftService);

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  protected readonly state = this.flow.state;
  protected readonly isIos = Capacitor.getPlatform() === 'ios';
  protected readonly spec = this.draft.spec;
  protected readonly title = computed(() => displayName(this.spec()));
  protected readonly describeSpool = describeSpool;

  /** Spoken to screen readers as the flow moves along. */
  protected readonly announcement = computed(() => {
    const state = this.state();
    switch (state.step) {
      case 'scanning':
        return 'Waiting for a tag.';
      case 'error':
        return state.help.title;
      case 'syncing':
        return 'Tag written. Updating Spoolman.';
      case 'conflict':
        return 'Tag written. It is already linked to another spool in Spoolman.';
      case 'done':
        return 'Tag written.';
      default:
        return '';
    }
  });

  constructor() {
    effect(() => {
      const dialog = this.dialog().nativeElement;
      const open = this.state().step !== 'idle';
      if (open && !dialog.open) dialog.showModal();
      if (!open && dialog.open) dialog.close();
    });
  }

  protected spoolLink(spool: SpoolmanSpool): string {
    return this.spoolman.spoolPageUrl(spool.id);
  }

  protected openSettings(): void {
    void this.nfc.openSettings();
  }

  /** Escape key or the close button. */
  protected onCancel(event: Event): void {
    event.preventDefault();
    this.flow.cancel();
  }
}
