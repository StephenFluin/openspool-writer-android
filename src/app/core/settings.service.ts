import { computed, Service, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

export interface Settings {
  /** Base URL of the Spoolman server, e.g. http://192.168.1.20:7912. Empty disables the integration. */
  spoolmanUrl: string;
  /** Create or link a Spoolman spool every time a tag is written. */
  spoolmanSync: boolean;
  /** Pre-filled "location" for new Spoolman spools. */
  defaultLocation: string;
  /** Most recently used brands, newest first. */
  recentBrands: string[];
}

const KEY = 'settings';
const DEFAULTS: Settings = { spoolmanUrl: '', spoolmanSync: true, defaultLocation: '', recentBrands: [] };

/** Persisted with Capacitor Preferences, which the OS won't evict like it can localStorage. */
@Service()
export class SettingsService {
  private readonly state = signal<Settings>(DEFAULTS);

  readonly spoolmanUrl = computed(() => this.state().spoolmanUrl);
  readonly spoolmanSync = computed(() => this.state().spoolmanSync);
  readonly defaultLocation = computed(() => this.state().defaultLocation);
  readonly recentBrands = computed(() => this.state().recentBrands);

  async load(): Promise<void> {
    try {
      const { value } = await Preferences.get({ key: KEY });
      if (value) this.state.set({ ...DEFAULTS, ...(JSON.parse(value) as Partial<Settings>) });
    } catch {
      // Corrupt or unavailable storage: keep defaults.
    }
  }

  update(patch: Partial<Settings>): void {
    this.state.update((current) => ({ ...current, ...patch }));
    void Preferences.set({ key: KEY, value: JSON.stringify(this.state()) });
  }

  rememberBrand(brand: string): void {
    const trimmed = brand.trim();
    if (!trimmed) return;
    const rest = this.recentBrands().filter((b) => b.toLowerCase() !== trimmed.toLowerCase());
    this.update({ recentBrands: [trimmed, ...rest].slice(0, 8) });
  }
}
