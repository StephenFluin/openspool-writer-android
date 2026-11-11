/** Everything the app knows about one spool, as entered by the user. */
export interface FilamentSpec {
  material: string;
  subtype: string;
  brand: string;
  colorName: string;
  colorHex: string;
  nozzleMin: number;
  nozzleMax: number;
  bedTemp: number;
  diameter: number;
  weight: number;
}

export interface MaterialDefaults {
  type: string;
  label: string;
  nozzle: [min: number, max: number];
  bed: number;
  /** g/cm³, required by Spoolman when creating a filament. */
  density: number;
}

/**
 * Materials offered in the picker. The U1 maps PLA, PETG, ABS, TPU and PVA natively;
 * the others are passed through as-is. The minimum nozzle temperature is what the U1
 * reports as the print temperature, so it is a realistic printing value, not the floor.
 */
export const MATERIALS: readonly MaterialDefaults[] = [
  { type: 'PLA', label: 'PLA', nozzle: [205, 230], bed: 60, density: 1.24 },
  { type: 'PETG', label: 'PETG', nozzle: [235, 260], bed: 70, density: 1.27 },
  { type: 'ABS', label: 'ABS', nozzle: [250, 280], bed: 90, density: 1.04 },
  { type: 'ASA', label: 'ASA', nozzle: [250, 280], bed: 90, density: 1.07 },
  { type: 'TPU', label: 'TPU', nozzle: [215, 240], bed: 40, density: 1.21 },
  { type: 'PVA', label: 'PVA (support)', nozzle: [200, 220], bed: 60, density: 1.23 },
  { type: 'PLA-CF', label: 'PLA-CF', nozzle: [215, 240], bed: 60, density: 1.3 },
  { type: 'PETG-CF', label: 'PETG-CF', nozzle: [240, 270], bed: 70, density: 1.3 },
  { type: 'PCTG', label: 'PCTG', nozzle: [240, 270], bed: 70, density: 1.23 },
  { type: 'HIPS', label: 'HIPS', nozzle: [230, 260], bed: 90, density: 1.03 },
  { type: 'PC', label: 'PC', nozzle: [260, 290], bed: 100, density: 1.2 },
  { type: 'PA', label: 'PA (Nylon)', nozzle: [260, 290], bed: 80, density: 1.14 },
  { type: 'PA-CF', label: 'PA-CF', nozzle: [270, 300], bed: 80, density: 1.2 },
];

/** Subtypes the U1 / Snapmaker Orca understand ("<brand> <type> <subtype>"). */
export const SUBTYPES: readonly string[] = [
  'Basic',
  'Matte',
  'Silk',
  'HF',
  'SnapSpeed',
  'Rapid',
  'Support',
  'Translucent',
  'Glow',
  'Marble',
  'Wood',
  '95A',
  '95A HF',
];

export interface NamedColor {
  name: string;
  hex: string;
}

/** A generic palette for when the manufacturer has no catalog colors. */
export const COMMON_COLORS: readonly NamedColor[] = [
  { name: 'Black', hex: '000000' },
  { name: 'White', hex: 'FFFFFF' },
  { name: 'Grey', hex: '8E9089' },
  { name: 'Silver', hex: 'A6A9AA' },
  { name: 'Red', hex: 'C12E1F' },
  { name: 'Orange', hex: 'FF6A13' },
  { name: 'Yellow', hex: 'F4EE2A' },
  { name: 'Gold', hex: 'E4BD68' },
  { name: 'Green', hex: '00AE42' },
  { name: 'Dark Green', hex: '164B35' },
  { name: 'Cyan', hex: '0086D6' },
  { name: 'Blue', hex: '0A2989' },
  { name: 'Purple', hex: '5E43B7' },
  { name: 'Pink', hex: 'F55A74' },
  { name: 'Magenta', hex: 'EC008C' },
  { name: 'Brown', hex: '9D432C' },
  { name: 'Beige', hex: 'F7E6DE' },
  { name: 'Transparent', hex: 'F0F0F0' },
];

export function materialDefaults(type: string): MaterialDefaults | undefined {
  const normalized = type.trim().toUpperCase();
  return MATERIALS.find((m) => m.type === normalized);
}

/** Normalizes user color input ("#ff0000", "f00") to six uppercase hex digits, or null. */
export function normalizeHex(input: string): string | null {
  let hex = input.trim().replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{3}$/.test(hex)) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  return /^[0-9A-F]{6}$/.test(hex) ? hex : null;
}

/** The name the U1 and Snapmaker Orca show for a spool: "<brand> <type> <subtype>". */
export function displayName(spec: Pick<FilamentSpec, 'brand' | 'material' | 'subtype'>): string {
  return [spec.brand || 'Generic', spec.material.toUpperCase(), spec.subtype].filter(Boolean).join(' ');
}

export function defaultSpec(): FilamentSpec {
  const pla = MATERIALS[0];
  return {
    material: pla.type,
    subtype: 'Basic',
    brand: '',
    colorName: '',
    colorHex: '',
    nozzleMin: pla.nozzle[0],
    nozzleMax: pla.nozzle[1],
    bedTemp: pla.bed,
    diameter: 1.75,
    weight: 1000,
  };
}
