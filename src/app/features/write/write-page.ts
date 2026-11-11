import { afterNextRender, Component, computed, DOCUMENT, inject, Injector, linkedSignal, resource, signal } from '@angular/core';
import { FieldTree, form, FormField, max, maxLength, min, required, submit, validate } from '@angular/forms/signals';
import { RouterLink } from '@angular/router';
import { CatalogService } from '../../core/catalog.service';
import { DraftService } from '../../core/draft.service';
import { COMMON_COLORS, displayName, MATERIALS, NamedColor, normalizeHex, QUICK_COLORS, SUBTYPES } from '../../core/filament';
import { NfcService } from '../../core/nfc/nfc.service';
import { buildOpenSpoolPayload, encodePayload, NTAG215_NDEF_BYTES, tagBytesNeeded } from '../../core/openspool';
import { SettingsService } from '../../core/settings.service';
import { describeSpool, SpoolmanService } from '../../core/spoolman/spoolman.service';
import { NfcStatusBanner } from '../../shared/nfc-status-banner';
import { Combobox, ComboOption } from '../../shared/combobox';
import { SpoolTarget, WriteFlow } from './write-flow';
import { WriteDialog } from './write-dialog';

const OTHER_MATERIAL = '__other';

@Component({
  selector: 'app-write-page',
  imports: [FormField, Combobox, WriteDialog, NfcStatusBanner, RouterLink],
  providers: [WriteFlow],
  templateUrl: './write-page.html',
  styleUrl: './write-page.css',
})
export class WritePage {
  private readonly draft = inject(DraftService);
  private readonly catalog = inject(CatalogService);
  private readonly settings = inject(SettingsService);
  private readonly flow = inject(WriteFlow);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  protected readonly spoolman = inject(SpoolmanService);
  protected readonly nfc = inject(NfcService);

  protected readonly materials = MATERIALS;
  protected readonly otherMaterial = OTHER_MATERIAL;
  protected readonly spec = this.draft.spec;

  protected readonly f = form(this.spec, (path) => {
    required(path.material, { message: 'Choose a filament type.' });
    maxLength(path.colorHex, 7);
    validate(path.colorHex, ({ value }) =>
      normalizeHex(value()) ? null : { kind: 'color', message: 'Choose a color, or enter a hex code like #FF6A13.' },
    );
    min(path.nozzleMin, 150, { message: 'Nozzle temperatures start at 150 °C.' });
    max(path.nozzleMax, 300, { message: 'The U1 nozzle tops out at 300 °C.' });
    validate(path.nozzleMax, ({ value, valueOf }) =>
      value() < valueOf(path.nozzleMin) ? { kind: 'range', message: 'Max must be at least the min temperature.' } : null,
    );
    min(path.bedTemp, 0);
    max(path.bedTemp, 120, { message: 'Bed temperature must be 120 °C or less.' });
    min(path.weight, 0);
  });

  /** "Other" shows a free-text material field. */
  protected readonly materialChoice = linkedSignal(() => {
    const material = this.spec().material.toUpperCase();
    return MATERIALS.some((m) => m.type === material) ? material : OTHER_MATERIAL;
  });

  protected readonly brandOptions = computed<ComboOption[]>(() => {
    const seen = new Set<string>();
    const options: ComboOption[] = [];
    const add = (name: string, hint?: string) => {
      const key = name.trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      options.push({ value: name.trim(), hint });
    };
    for (const brand of this.settings.recentBrands()) add(brand, 'Recent');
    // An unreachable Spoolman leaves the resource in an error state, where value() throws.
    const vendors = this.spoolman.vendors.hasValue() ? this.spoolman.vendors.value() : [];
    for (const vendor of vendors) add(vendor.name, 'In Spoolman');
    add('Generic');
    for (const brand of this.catalog.manufacturers()) add(brand);
    return options;
  });

  private readonly brandColors = computed(() => this.catalog.colorsFor(this.spec().brand, this.spec().material));
  protected readonly brandColorCount = computed(() => this.brandColors().length);

  protected readonly colorOptions = computed<ComboOption[]>(() => {
    const material = this.spec().material.toUpperCase();
    const options: ComboOption[] = this.brandColors().map((c) => ({
      value: c.name,
      swatch: c.hex,
      hint: c.material === material ? undefined : c.material,
    }));
    const seen = new Set(options.map((o) => o.value.toLowerCase()));
    for (const color of COMMON_COLORS) {
      if (!seen.has(color.name.toLowerCase())) {
        options.push({ value: color.name, swatch: color.hex, hint: 'Generic', rank: 1 });
      }
    }
    return options;
  });

  protected readonly subtypeOptions: ComboOption[] = SUBTYPES.map((value) => ({ value }));

  protected readonly title = computed(() => displayName(this.spec()));
  protected readonly swatch = computed(() => normalizeHex(this.spec().colorHex));
  protected readonly payloadJson = computed(() => JSON.stringify(buildOpenSpoolPayload(this.spec()), null, 2));
  protected readonly bytesNeeded = computed(() =>
    tagBytesNeeded(encodePayload(buildOpenSpoolPayload(this.spec())).length),
  );
  protected readonly tagCapacity = NTAG215_NDEF_BYTES;

  // Spoolman
  protected readonly syncEnabled = linkedSignal(() => this.settings.spoolmanSync());
  protected readonly location = linkedSignal(() => this.settings.defaultLocation());
  protected readonly locationOptions = computed<ComboOption[]>(() =>
    (this.spoolman.locations.hasValue() ? this.spoolman.locations.value() : []).map((value) => ({ value })),
  );
  protected readonly mode = this.draft.spoolmanMode;
  protected readonly existingSpool = this.draft.existingSpool;
  protected readonly spoolSearch = linkedSignal(() => {
    const spool = this.existingSpool();
    return spool ? describeSpool(spool) : '';
  });
  protected readonly spoolMissing = signal(false);
  protected readonly spools = resource({
    params: () => (this.spoolman.configured() && this.syncEnabled() && this.mode() === 'existing' ? this.spoolman.baseUrl() : undefined),
    loader: async () => (await this.spoolman.listSpools()).filter((s) => !s.archived),
  });
  protected readonly spoolOptions = computed<ComboOption[]>(() =>
    (this.spools.hasValue() ? this.spools.value() : []).map((spool) => ({
      value: describeSpool(spool),
      swatch: normalizeHex((spool.filament.color_hex ?? '').slice(0, 6)) ?? undefined,
      hint: spool.remaining_weight != null ? `${Math.round(spool.remaining_weight)} g left` : undefined,
    })),
  );

  /** The first validation message for a field, once the user has interacted with it. */
  protected error(field: FieldTree<unknown>): string | null {
    const state = field();
    return state.touched() && state.invalid() ? (state.errors()[0]?.message ?? 'Check this value.') : null;
  }

  protected onSyncToggle(event: Event): void {
    this.syncEnabled.set((event.target as HTMLInputElement).checked);
  }

  protected onMaterialChange(event: Event): void {
    const choice = (event.target as HTMLSelectElement).value;
    this.materialChoice.set(choice);
    this.draft.setMaterial(choice === OTHER_MATERIAL ? '' : choice);
  }

  protected readonly quickColors = QUICK_COLORS;

  protected pickQuickColor(color: NamedColor): void {
    this.draft.patch({ colorName: color.name, colorHex: color.hex });
  }

  protected pickColor(option: ComboOption): void {
    const match = this.brandColors().find((c) => c.name === option.value && c.hex === option.swatch);
    const spec = this.spec();
    this.draft.patch({
      colorHex: option.swatch ?? spec.colorHex,
      ...(match &&
        match.nozzleMin > 0 && {
          nozzleMin: match.nozzleMin,
          nozzleMax: Math.max(match.nozzleMax, match.nozzleMin, spec.nozzleMax),
        }),
      ...(match && match.bed > 0 && { bedTemp: match.bed }),
    });
  }

  protected onColorInput(event: Event): void {
    const hex = normalizeHex((event.target as HTMLInputElement).value);
    if (hex) this.draft.patch({ colorHex: hex });
  }

  protected pickSpool(option: ComboOption): void {
    const spool = this.spools.hasValue() ? this.spools.value().find((s) => describeSpool(s) === option.value) : undefined;
    if (spool) {
      this.draft.loadSpool(spool);
      this.spoolMissing.set(false);
    }
  }

  protected setMode(mode: 'new' | 'existing'): void {
    this.mode.set(mode);
    if (mode === 'new') this.existingSpool.set(null);
  }

  protected async write(event: Event): Promise<void> {
    event.preventDefault();
    const needsSpool = this.target().kind !== 'none' && this.mode() === 'existing' && !this.existingSpool();
    this.spoolMissing.set(needsSpool);
    if (needsSpool) {
      this.focusFirstInvalid();
      return;
    }
    await submit(this.f, {
      action: async () => {
        this.flow.start(this.spec(), this.target());
        return undefined;
      },
      onInvalid: () => this.focusFirstInvalid(),
    });
  }

  /** Move focus to the first problem so keyboard and screen reader users land on it. */
  private focusFirstInvalid(): void {
    afterNextRender(() => this.document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), {
      injector: this.injector,
    });
  }

  private target(): SpoolTarget {
    if (!this.spoolman.configured() || !this.syncEnabled()) return { kind: 'none' };
    const existing = this.existingSpool();
    if (this.mode() === 'existing' && existing) return { kind: 'existing', spool: existing };
    return { kind: 'new', location: this.location() };
  }
}
