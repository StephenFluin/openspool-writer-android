import { Service, signal } from '@angular/core';
import { defaultSpec, FilamentSpec, materialDefaults, normalizeHex } from './filament';
import { SpoolmanSpool } from './spoolman/spoolman-types';

export type SpoolmanMode = 'new' | 'existing';

/** The tag being prepared. Lives outside the page so it survives switching tabs. */
@Service()
export class DraftService {
  readonly spec = signal<FilamentSpec>(defaultSpec());
  readonly spoolmanMode = signal<SpoolmanMode>('new');
  readonly existingSpool = signal<SpoolmanSpool | null>(null);

  patch(values: Partial<FilamentSpec>): void {
    this.spec.update((spec) => ({ ...spec, ...values }));
  }

  /** Switches material and resets temperatures to that material's defaults. */
  setMaterial(type: string): void {
    const defaults = materialDefaults(type);
    this.patch({
      material: type,
      ...(defaults && { nozzleMin: defaults.nozzle[0], nozzleMax: defaults.nozzle[1], bedTemp: defaults.bed }),
    });
  }

  /** Fills the form from an existing Spoolman spool. */
  loadSpool(spool: SpoolmanSpool): void {
    const f = spool.filament;
    const material = (f.material ?? 'PLA').toUpperCase();
    const defaults = materialDefaults(material);
    let variant = '';
    try {
      variant = f.extra['variant'] ? String(JSON.parse(f.extra['variant'])) : '';
    } catch {
      variant = f.extra['variant'] ?? '';
    }
    const hex = normalizeHex((f.multi_color_hexes?.split(',')[0] ?? f.color_hex ?? '').slice(0, 6)) ?? '';
    this.spec.set({
      material,
      subtype: variant || 'Basic',
      brand: f.vendor?.name ?? '',
      colorName: f.name ?? '',
      colorHex: hex,
      nozzleMin: f.settings_extruder_temp ?? defaults?.nozzle[0] ?? 0,
      nozzleMax: Math.max(defaults?.nozzle[1] ?? 0, f.settings_extruder_temp ?? 0),
      bedTemp: f.settings_bed_temp ?? defaults?.bed ?? 0,
      diameter: f.diameter || 1.75,
      weight: spool.initial_weight ?? f.weight ?? 1000,
    });
    this.existingSpool.set(spool);
    this.spoolmanMode.set('existing');
  }
}
