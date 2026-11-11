import { httpResource } from '@angular/common/http';
import { computed, Service } from '@angular/core';

/** public/catalog.json, generated from SpoolmanDB by scripts/build-catalog.mjs. */
interface CatalogFile {
  manufacturers: string[];
  /** [manufacturerIndex, material, name, hex, nozzleMin, nozzleMax, bed] */
  filaments: [number, string, string, string, number, number, number][];
}

export interface CatalogColor {
  name: string;
  hex: string;
  material: string;
  nozzleMin: number;
  nozzleMax: number;
  bed: number;
}

@Service()
export class CatalogService {
  private readonly file = httpResource<CatalogFile>(() => 'catalog.json');

  readonly loading = this.file.isLoading;
  /** Undefined until loaded, and if loading failed (reading value() in the error state throws). */
  private readonly data = computed(() => (this.file.hasValue() ? this.file.value() : undefined));
  readonly manufacturers = computed(() => this.data()?.manufacturers ?? []);

  private readonly colorsByBrand = computed(() => {
    const file = this.data();
    const map = new Map<string, CatalogColor[]>();
    if (!file) return map;
    for (const [index, material, name, hex, nozzleMin, nozzleMax, bed] of file.filaments) {
      const key = file.manufacturers[index].toLowerCase();
      const list = map.get(key) ?? [];
      list.push({ name, hex, material, nozzleMin, nozzleMax, bed });
      map.set(key, list);
    }
    return map;
  });

  /**
   * The brand's colors for a material: exact material matches first, then variants of it
   * (PLA+ and PLA-CF for PLA). Falls back to every color the brand makes.
   */
  colorsFor(brand: string, material: string): CatalogColor[] {
    const all = this.colorsByBrand().get(brand.trim().toLowerCase()) ?? [];
    const type = material.trim().toUpperCase();
    const exact = all.filter((c) => c.material === type);
    const family = all.filter((c) => c.material !== type && c.material.startsWith(type));
    const matches = [...exact, ...family];
    return matches.length ? matches : all;
  }
}
