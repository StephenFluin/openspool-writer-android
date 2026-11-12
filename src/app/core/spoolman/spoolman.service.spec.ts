import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { defaultSpec, FilamentSpec } from '../filament';
import { SettingsService } from '../settings.service';
import {
  decodeCardUids,
  encodeCardUids,
  filamentName,
  mergeLocations,
  normalizeSpoolmanUrl,
  SpoolmanService,
  spoolTagUids,
} from './spoolman.service';
import { SpoolmanSpool } from './spoolman-types';

const BASE = 'http://spoolman.local:7912/api/v1';
const UID = '04A1B2C3D4E5F6';
const spec: FilamentSpec = {
  ...defaultSpec(),
  material: 'PETG',
  subtype: 'Matte',
  brand: 'Polymaker',
  colorName: 'Red',
  colorHex: 'C12E1F',
  nozzleMin: 235,
  nozzleMax: 260,
  bedTemp: 70,
};

function spool(id: number, extra: Record<string, string> = {}, tags?: { uid: string }[]): SpoolmanSpool {
  return {
    id,
    archived: false,
    extra,
    tags,
    filament: { id: 1, diameter: 1.75, density: 1.27, extra: {}, material: 'PETG', name: 'Red', vendor: { id: 1, name: 'Polymaker' } },
  };
}

describe('Spoolman helpers', () => {
  it('reads card_uids the way the U1 firmware writes them', () => {
    expect(decodeCardUids('"AABBCCDD,04a1b2c3d4e5f6"')).toEqual(['AABBCCDD', '04A1B2C3D4E5F6']);
    expect(decodeCardUids('AABBCCDD')).toEqual(['AABBCCDD']);
    expect(decodeCardUids('""')).toEqual([]);
    expect(decodeCardUids(undefined)).toEqual([]);
  });

  it('writes card_uids as a JSON-encoded comma list', () => {
    expect(encodeCardUids(['AABBCCDD', UID, 'AABBCCDD'])).toBe(`"AABBCCDD,${UID}"`);
  });

  it('finds UIDs in both the extra field and native tags', () => {
    expect(spoolTagUids(spool(1, { card_uids: '"AABB"' }, [{ uid: 'ccdd' }]))).toEqual(['AABB', 'CCDD']);
  });

  it('normalizes the server address', () => {
    expect(normalizeSpoolmanUrl('192.168.1.20:7912')).toBe('http://192.168.1.20:7912');
    expect(normalizeSpoolmanUrl('https://spool.example.com/api/v1/')).toBe('https://spool.example.com');
    expect(normalizeSpoolmanUrl('  ')).toBe('');
  });

  it('merges locations without blanks or duplicates, keeping the first order', () => {
    expect(mergeLocations(['Dry box', 'Shelf A'], ['Shelf A', ' ', 'Printer slot 2'])).toEqual([
      'Dry box',
      'Shelf A',
      'Printer slot 2',
    ]);
  });

  it('names filaments by subtype and color', () => {
    expect(filamentName(spec)).toBe('Matte Red');
    expect(filamentName({ ...spec, subtype: 'Basic', colorName: '' })).toBe('#C12E1F');
  });
});

describe('SpoolmanService', () => {
  let service: SpoolmanService;
  let http: HttpTestingController;

  /** Waits for the next request matching method + path, then answers it. */
  async function answer(method: string, path: string, body: object | null): Promise<TestRequest> {
    let request: TestRequest | undefined;
    await vi.waitFor(() => {
      request = http.expectOne((r) => r.method === method && r.urlWithParams === `${BASE}${path}`);
    });
    request!.flush(body);
    return request!;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    TestBed.inject(SettingsService).update({ spoolmanUrl: 'http://spoolman.local:7912' });
    service = TestBed.inject(SpoolmanService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    // The vendor and location lists behind the pickers load on their own.
    for (const request of http.match(`${BASE}/vendor`)) request.flush([]);
    for (const request of http.match(`${BASE}/setting/locations`)) request.flush({ value: '[]' });
    for (const request of http.match(`${BASE}/location`)) request.flush([]);
    http.verify();
  });

  it('creates vendor, filament and spool, and links the tag both ways', async () => {
    const result = service.createSpoolForTag(spec, UID, { location: 'Shelf A' });

    await answer('GET', '/field/spool', []);
    const cardField = await answer('POST', '/field/spool/card_uids', []);
    expect(cardField.request.body).toEqual({ name: 'Card UIDs', field_type: 'text', order: 1, default_value: '""' });
    await answer('GET', '/field/filament', [{ key: 'variant', name: 'Variant', field_type: 'text' }]);

    await answer('GET', '/vendor?name=Polymaker', [{ id: 9, name: 'Polymaker Japan' }]);
    const vendor = await answer('POST', '/vendor', { id: 3, name: 'Polymaker' });
    expect(vendor.request.body).toEqual({ name: 'Polymaker' });

    await answer('GET', '/filament?vendor.id=3&material=PETG', []);
    const filament = await answer('POST', '/filament', { id: 5, diameter: 1.75, density: 1.27, extra: {} });
    expect(filament.request.body).toMatchObject({
      name: 'Matte Red',
      vendor_id: 3,
      material: 'PETG',
      density: 1.27,
      diameter: 1.75,
      color_hex: 'C12E1F',
      settings_extruder_temp: 235,
      settings_bed_temp: 70,
      extra: { variant: '"Matte"' },
    });

    const created = await answer('POST', '/spool', { ...spool(12, { card_uids: `"${UID}"` }), tags: [] });
    expect(created.request.body).toEqual({
      filament_id: 5,
      initial_weight: 1000,
      location: 'Shelf A',
      extra: { card_uids: `"${UID}"` },
    });

    const tag = await answer('POST', '/spool/12/tag', { uid: UID });
    expect(tag.request.body).toEqual({ uid: UID, format: 'ntag' });

    await expect(result).resolves.toMatchObject({ createdSpool: true, createdVendor: true, createdFilament: true });
  });

  it('reuses an existing filament and skips native tags on older Spoolman', async () => {
    const result = service.createSpoolForTag(spec, UID, { location: '' });
    await answer('GET', '/field/spool', [{ key: 'card_uids' }]);
    await answer('GET', '/field/filament', []);
    await answer('POST', '/field/filament/variant', []);
    await answer('GET', '/vendor?name=Polymaker', [{ id: 3, name: 'polymaker' }]);
    await answer('GET', '/filament?vendor.id=3&material=PETG', [
      { id: 7, name: 'Matte Red', material: 'PETG', color_hex: 'c12e1fff', diameter: 1.75, density: 1.27, extra: {} },
    ]);
    const created = await answer('POST', '/spool', spool(13, { card_uids: `"${UID}"` }));
    expect(created.request.body).toMatchObject({ filament_id: 7 });
    await expect(result).resolves.toMatchObject({ createdFilament: false, createdVendor: false });
  });

  it('moves a tag from its old spool before linking it to another', async () => {
    const oldSpool = spool(4, { card_uids: `"AABB,${UID}"`, other: '"keep"' }, [{ uid: UID }]);
    const target = spool(8, { card_uids: '""' }, []);
    const result = service.linkTagToSpool(target, UID, oldSpool);

    await answer('GET', '/field/spool', [{ key: 'card_uids' }]);
    await answer('GET', '/field/filament', [{ key: 'variant' }]);
    await answer('GET', '/spool/4', oldSpool);
    const unlink = await answer('PATCH', '/spool/4', oldSpool);
    expect(unlink.request.body).toEqual({ extra: { card_uids: '"AABB"', other: '"keep"' } });
    await answer('DELETE', `/spool/4/tag/${UID}`, null);
    await answer('GET', '/spool/8', target);
    const link = await answer('PATCH', '/spool/8', { ...target, extra: { card_uids: `"${UID}"` } });
    expect(link.request.body).toEqual({ extra: { card_uids: `"${UID}"` } });
    await answer('POST', '/spool/8/tag', { uid: UID });

    await expect(result).resolves.toMatchObject({ createdSpool: false, movedFrom: oldSpool });
  });

  it('lists the Locations page order first, then other locations spools use', async () => {
    await answer('GET', '/setting/locations', { value: '["Dry box","Shelf A"]', is_set: true, type: 'array' });
    await answer('GET', '/location', ['Shelf A', 'Printer slot 2']);
    await vi.waitFor(() => expect(service.locations.value()).toEqual(['Dry box', 'Shelf A', 'Printer slot 2']));
  });

  it('still lists spool locations on Spoolman versions without the Locations setting', async () => {
    const setting = await vi.waitFor(() => http.expectOne(`${BASE}/setting/locations`));
    setting.flush({ detail: 'Not found' }, { status: 404, statusText: 'Not Found' });
    await answer('GET', '/location', ['Shelf A']);
    await vi.waitFor(() => expect(service.locations.value()).toEqual(['Shelf A']));
  });

  it('keeps tags linked since the spool was loaded', async () => {
    const snapshot = spool(8, { card_uids: '""' }, []);
    const result = service.linkTagToSpool(snapshot, UID);
    await answer('GET', '/field/spool', [{ key: 'card_uids' }]);
    await answer('GET', '/field/filament', [{ key: 'variant' }]);
    await answer('GET', '/spool/8', spool(8, { card_uids: '"AABBCCDD"' }, [{ uid: 'AABBCCDD' }]));
    const link = await answer('PATCH', '/spool/8', spool(8, { card_uids: `"AABBCCDD,${UID}"` }, [{ uid: 'AABBCCDD' }]));
    expect(link.request.body).toEqual({ extra: { card_uids: `"AABBCCDD,${UID}"` } });
    await answer('POST', '/spool/8/tag', { uid: UID });
    await result;
  });

  it('turns network failures into a readable message', async () => {
    const result = service.info();
    let request: TestRequest | undefined;
    await vi.waitFor(() => (request = http.expectOne(`${BASE}/info`)));
    request!.error(new ProgressEvent('error'), { status: 0 });
    await expect(result).rejects.toThrow(/Couldn’t reach Spoolman at http:\/\/spoolman.local:7912/);
  });
});
