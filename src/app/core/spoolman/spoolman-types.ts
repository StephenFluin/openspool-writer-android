export interface SpoolmanInfo {
  version: string;
}

export interface SpoolmanVendor {
  id: number;
  name: string;
}

export interface SpoolmanTag {
  uid: string;
  format?: string | null;
}

export interface SpoolmanFilament {
  id: number;
  name?: string | null;
  vendor?: SpoolmanVendor | null;
  material?: string | null;
  color_hex?: string | null;
  multi_color_hexes?: string | null;
  settings_extruder_temp?: number | null;
  settings_bed_temp?: number | null;
  weight?: number | null;
  diameter: number;
  density: number;
  /** Every value is a JSON-encoded string. */
  extra: Record<string, string>;
}

export interface SpoolmanSpool {
  id: number;
  filament: SpoolmanFilament;
  initial_weight?: number | null;
  remaining_weight?: number | null;
  location?: string | null;
  archived: boolean;
  /** Every value is a JSON-encoded string. */
  extra: Record<string, string>;
  /** Native tag links, Spoolman 0.27+. Absent on older servers. */
  tags?: SpoolmanTag[];
}

export interface SpoolmanField {
  key: string;
  name: string;
  field_type: string;
}

export interface NewSpoolOptions {
  location: string;
  /** A spool that currently holds this tag and should give it up. */
  takeTagFrom?: SpoolmanSpool;
  /** Called as soon as the spool exists, before the tag link that may still fail. */
  onCreated?: (result: SyncResult) => void;
}

export interface SyncResult {
  spool: SpoolmanSpool;
  createdSpool: boolean;
  createdFilament: boolean;
  createdVendor: boolean;
  /** The spool the tag was moved away from, if any. */
  movedFrom?: SpoolmanSpool;
}

export class SpoolmanError extends Error {
  constructor(
    message: string,
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SpoolmanError';
  }
}
