import { inject, Injectable, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { FilamentSpec } from '../../core/filament';
import { helpFor, ProblemHelp } from '../../core/nfc/nfc-help';
import { NfcError, TagInfo } from '../../core/nfc/nfc-types';
import { NfcService } from '../../core/nfc/nfc.service';
import { buildOpenSpoolPayload, encodePayload, OPENSPOOL_MIME, tagBytesNeeded } from '../../core/openspool';
import { SettingsService } from '../../core/settings.service';
import { SpoolmanService } from '../../core/spoolman/spoolman.service';
import { SpoolmanSpool, SyncResult } from '../../core/spoolman/spoolman-types';

/** Where the written tag should end up in Spoolman. */
export type SpoolTarget = { kind: 'none' } | { kind: 'new'; location: string } | { kind: 'existing'; spool: SpoolmanSpool };

export type FlowState =
  | { step: 'idle' }
  | { step: 'scanning'; slow: boolean }
  | { step: 'error'; error: NfcError; help: ProblemHelp }
  | { step: 'syncing'; tag: TagInfo }
  | { step: 'conflict'; tag: TagInfo; owner: SpoolmanSpool }
  | { step: 'done'; tag: TagInfo; sync: SyncResult | null; syncNote: string | null; syncFailed: boolean };

const SLOW_HINT_MS = 8000;

/** Drives one "write a tag" session: scan → check → write → Spoolman. */
@Injectable()
export class WriteFlow {
  private readonly nfc = inject(NfcService);
  private readonly spoolman = inject(SpoolmanService);
  private readonly settings = inject(SettingsService);

  readonly state = signal<FlowState>({ step: 'idle' });
  /** How many tags were written for the current spool (the U1 may need one on each side). */
  readonly writtenCount = signal(0);

  private spec: FilamentSpec | null = null;
  private target: SpoolTarget = { kind: 'none' };
  private allowIncompatible = false;
  private abort: AbortController | null = null;

  start(spec: FilamentSpec, target: SpoolTarget): void {
    this.spec = spec;
    this.target = target;
    this.allowIncompatible = false;
    this.writtenCount.set(0);
    void this.scan();
  }

  retry(): void {
    void this.scan();
  }

  writeAnyway(): void {
    this.allowIncompatible = true;
    void this.scan();
  }

  /** Write the same data to another tag, linked to the same spool. */
  writeAnother(): void {
    this.allowIncompatible = false;
    void this.scan();
  }

  cancel(): void {
    this.abort?.abort();
    this.abort = null;
    this.state.set({ step: 'idle' });
  }

  resolveConflict(moveTag: boolean): void {
    const state = this.state();
    if (state.step !== 'conflict') return;
    if (moveTag) void this.sync(state.tag, state.owner);
    else this.finish(state.tag, null, 'Not added to Spoolman. The tag is still linked to the other spool.');
  }

  retrySync(): void {
    const state = this.state();
    if (state.step === 'done' && state.syncFailed) void this.sync(state.tag);
  }

  private async scan(): Promise<void> {
    const spec = this.spec;
    if (!spec) return;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.state.set({ step: 'scanning', slow: false });
    const slowTimer = setTimeout(() => {
      if (this.abort === abort && this.state().step === 'scanning') this.state.set({ step: 'scanning', slow: true });
    }, SLOW_HINT_MS);

    const data = encodePayload(buildOpenSpoolPayload(spec));
    try {
      const tag = await this.nfc.write(
        {
          mediaType: OPENSPOOL_MIME,
          data,
          bytesNeeded: tagBytesNeeded(data.length),
          allowIncompatible: this.allowIncompatible,
        },
        abort.signal,
      );
      if (this.abort !== abort) return;
      void this.nfc.haptic('success');
      this.writtenCount.update((n) => n + 1);
      this.settings.rememberBrand(spec.brand);
      await this.sync(tag);
    } catch (caught) {
      if (this.abort !== abort) return;
      const error = caught instanceof NfcError ? caught : new NfcError('unknown', String(caught));
      if (error.code === 'cancelled') {
        this.state.set({ step: 'idle' });
        return;
      }
      void this.nfc.haptic('error');
      this.state.set({ step: 'error', error, help: helpFor(error, this.nfc.kind, Capacitor.getPlatform() === 'ios') });
    } finally {
      clearTimeout(slowTimer);
    }
  }

  private async sync(tag: TagInfo, takeTagFrom?: SpoolmanSpool): Promise<void> {
    const target = this.target;
    if (target.kind === 'none' || !this.spoolman.configured()) {
      this.finish(tag, null, null);
      return;
    }
    if (!tag.uid) {
      this.finish(tag, null, 'This phone didn’t report the tag’s ID, so it couldn’t be linked in Spoolman.');
      return;
    }

    this.state.set({ step: 'syncing', tag });
    try {
      if (!takeTagFrom) {
        const owner = await this.spoolman.findTagOwner(tag.uid);
        const alreadyOurs = target.kind === 'existing' && owner?.id === target.spool.id;
        if (owner && !alreadyOurs) {
          this.state.set({ step: 'conflict', tag, owner });
          return;
        }
      }
      const result =
        target.kind === 'new'
          ? await this.spoolman.createSpoolForTag(this.spec!, tag.uid, { location: target.location, takeTagFrom })
          : await this.spoolman.linkTagToSpool(target.spool, tag.uid, takeTagFrom);
      // Any further tags for this spool get linked to it rather than creating another spool.
      this.target = { kind: 'existing', spool: result.spool };
      this.spoolman.locations.reload();
      this.finish(tag, result, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.set({ step: 'done', tag, sync: null, syncNote: message, syncFailed: true });
    }
  }

  private finish(tag: TagInfo, sync: SyncResult | null, note: string | null): void {
    this.state.set({ step: 'done', tag, sync, syncNote: note, syncFailed: false });
  }
}
