import { DestroyRef, inject, Injectable, signal } from '@angular/core';
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
  /** Bumped by every scan, sync and cancel, so work that finishes late can tell it's been superseded. */
  private run = 0;

  constructor() {
    // Leaving the page mid-scan ends the scan rather than leaving it waiting for a tag.
    inject(DestroyRef).onDestroy(() => this.cancel());
  }

  start(spec: FilamentSpec, target: SpoolTarget): void {
    this.spec = spec;
    this.target = target;
    this.allowIncompatible = false;
    this.writtenCount.set(0);
    void this.scan(false);
  }

  /** After a transient failure the tag may still be on the phone, so it's used again; after a tag problem, a new tag is awaited. */
  retry(): void {
    const state = this.state();
    void this.scan(state.step === 'error' && state.help.reuseTag);
  }

  writeAnyway(): void {
    this.allowIncompatible = true;
    void this.scan(true);
  }

  /** Write the same data to another tag, linked to the same spool. */
  writeAnother(): void {
    this.allowIncompatible = false;
    void this.scan(false);
  }

  cancel(): void {
    this.run++;
    this.abort?.abort();
    this.abort = null;
    this.state.set({ step: 'idle' });
  }

  resolveConflict(moveTag: boolean): void {
    const state = this.state();
    if (state.step !== 'conflict') return;
    if (moveTag) void this.sync(state.tag, ++this.run, state.owner);
    else this.finish(state.tag, null, 'Not added to Spoolman. The tag is still linked to the other spool.');
  }

  retrySync(): void {
    const state = this.state();
    if (state.step === 'done' && state.syncFailed) void this.sync(state.tag, ++this.run);
  }

  private async scan(reuse: boolean): Promise<void> {
    const spec = this.spec;
    if (!spec) return;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    const run = ++this.run;
    this.state.set({ step: 'scanning', slow: false });
    const slowTimer = setTimeout(() => {
      if (run === this.run && this.state().step === 'scanning') this.state.set({ step: 'scanning', slow: true });
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
        { reuse },
      );
      if (run !== this.run) return;
      void this.nfc.haptic('success');
      this.writtenCount.update((n) => n + 1);
      this.settings.rememberBrand(spec.brand);
      await this.sync(tag, run);
    } catch (caught) {
      if (run !== this.run) return;
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

  private async sync(tag: TagInfo, run: number, takeTagFrom?: SpoolmanSpool): Promise<void> {
    const target = this.target;
    const spec = this.spec;
    const stale = () => run !== this.run;
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
      let linkTo = target.kind === 'existing' ? target.spool : null;
      if (!takeTagFrom) {
        const owner = await this.spoolman.findTagOwner(tag.uid);
        if (stale()) return;
        const alreadyOurs = target.kind === 'existing' && owner?.id === target.spool.id;
        if (owner && !alreadyOurs) {
          this.state.set({ step: 'conflict', tag, owner });
          return;
        }
        // Link against Spoolman's current copy, not the one captured when the write started.
        if (alreadyOurs) linkTo = owner;
      }
      const result =
        target.kind === 'new'
          ? await this.spoolman.createSpoolForTag(spec!, tag.uid, {
              location: target.location,
              takeTagFrom,
              // From here on, a retry or another tag links to this spool instead of creating a second one.
              onCreated: (spool) => {
                if (!stale()) this.target = { kind: 'existing', spool };
              },
            })
          : await this.spoolman.linkTagToSpool(linkTo!, tag.uid, takeTagFrom);
      if (stale()) return;
      // Any further tags for this spool get linked to it rather than creating another spool.
      this.target = { kind: 'existing', spool: result.spool };
      this.spoolman.locations.reload();
      this.finish(tag, result, null);
    } catch (error) {
      if (stale()) return;
      const message = error instanceof Error ? error.message : String(error);
      this.state.set({ step: 'done', tag, sync: null, syncNote: message, syncFailed: true });
    }
  }

  private finish(tag: TagInfo, sync: SyncResult | null, note: string | null): void {
    this.state.set({ step: 'done', tag, sync, syncNote: note, syncFailed: false });
  }
}
