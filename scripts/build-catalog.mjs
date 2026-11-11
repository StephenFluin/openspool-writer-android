// Builds public/catalog.json, a compact snapshot of SpoolmanDB used for the
// manufacturer and color pickers. Run with `npm run catalog` to refresh it.
import { writeFile } from 'node:fs/promises';

const SOURCE = 'https://donkie.github.io/SpoolmanDB/filaments.json';
const OUT = new URL('../public/catalog.json', import.meta.url);

const response = await fetch(SOURCE);
if (!response.ok) {
  throw new Error(`Failed to download ${SOURCE}: ${response.status}`);
}
const filaments = await response.json();

const clean = (text) => text.replace(/\s+/g, ' ').trim();
const manufacturers = [...new Set(filaments.map((f) => clean(f.manufacturer)))].sort((a, b) =>
  a.localeCompare(b, 'en', { sensitivity: 'base' }),
);
const manufacturerIndex = new Map(manufacturers.map((m, i) => [m, i]));

// Each entry: [manufacturerIndex, material, name, hex, nozzleMin, nozzleMax, bed]
const seen = new Set();
const entries = [];
for (const f of filaments) {
  if (f.diameter !== 1.75) continue;
  const hex = (f.color_hex ?? f.color_hexes?.[0] ?? '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(hex)) continue;
  const material = f.material.trim().toUpperCase();
  const name = clean(f.name);
  const key = `${f.manufacturer}|${material}|${name}|${hex}`.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);

  const [nozzleMin, nozzleMax] = f.extruder_temp_range ?? [f.extruder_temp ?? 0, 0];
  const bed = f.bed_temp ?? f.bed_temp_range?.[0] ?? 0;
  entries.push([manufacturerIndex.get(clean(f.manufacturer)), material, name, hex, nozzleMin, nozzleMax, bed]);
}

const catalog = {
  source: 'SpoolmanDB (https://github.com/Donkie/SpoolmanDB), MIT licensed',
  generated: new Date().toISOString().slice(0, 10),
  manufacturers,
  filaments: entries,
};
await writeFile(OUT, JSON.stringify(catalog));
console.log(`Wrote ${manufacturers.length} manufacturers and ${entries.length} filaments to ${OUT.pathname}`);
