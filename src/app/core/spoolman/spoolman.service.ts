import { HttpClient, HttpErrorResponse, httpResource } from '@angular/common/http';
import { computed, DOCUMENT, inject, resource, Service } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { FilamentSpec, materialDefaults } from '../filament';
import { SettingsService } from '../settings.service';
import {
  NewSpoolOptions,
  SpoolmanError,
  SpoolmanField,
  SpoolmanFilament,
  SpoolmanInfo,
  SpoolmanSpool,
  SpoolmanVendor,
  SyncResult,
} from './spoolman-types';

const REQUEST_TIMEOUT_MS = 10_000;
/** Same limit the U1 firmware uses when it searches spools for a card UID. */
const SPOOL_LIMIT = 1000;

/**
 * Talks to Spoolman's REST API (/api/v1). Tag links are written to both places the U1 firmware
 * can read them from: the `card_uids` spool extra field (its default) and, on Spoolman 0.27+,
 * Spoolman's native tag links.
 */
@Service()
export class SpoolmanService {
  private readonly http = inject(HttpClient);
  private readonly settings = inject(SettingsService);
  private readonly document = inject(DOCUMENT);

  readonly baseUrl = computed(() => normalizeSpoolmanUrl(this.settings.spoolmanUrl()));
  readonly configured = computed(() => this.baseUrl() !== '');
  readonly enabled = computed(() => this.configured() && this.settings.spoolmanSync());

  /** Vendors already in Spoolman, offered first in the manufacturer picker. */
  readonly vendors = httpResource<SpoolmanVendor[]>(
    () => (this.configured() ? `${this.baseUrl()}/api/v1/vendor` : undefined),
    { defaultValue: [] },
  );

  /** Locations for new spools: the Locations page's order first, then any other location a spool uses. */
  readonly locations = resource({
    params: () => (this.configured() ? this.baseUrl() : undefined),
    loader: ({ params }) => this.loadLocations(params),
    defaultValue: [],
  });

  /** True when a browser (not the native app) would block this URL as mixed content. */
  isMixedContentBlocked(url = this.baseUrl()): boolean {
    return (
      !Capacitor.isNativePlatform() &&
      this.document.location.protocol === 'https:' &&
      url.startsWith('http:') &&
      !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url)
    );
  }

  info(baseUrl = this.baseUrl()): Promise<SpoolmanInfo> {
    return this.request<SpoolmanInfo>('GET', '/info', undefined, baseUrl);
  }

  private async loadLocations(baseUrl: string): Promise<string[]> {
    const [setting, used] = await Promise.all([
      // Spoolman 0.22+ keeps the Locations page's list (including empty locations) in this setting.
      this.request<{ value: string }>('GET', '/setting/locations', undefined, baseUrl).catch(() => undefined),
      this.request<string[]>('GET', '/location', undefined, baseUrl),
    ]);
    return mergeLocations(decodeSettingList(setting?.value), used);
  }

  listSpools(): Promise<SpoolmanSpool[]> {
    return this.request<SpoolmanSpool[]>('GET', `/spool?allow_archived=true&limit=${SPOOL_LIMIT}`);
  }

  /** The spool a tag UID is linked to, through either the card_uids field or a native tag. */
  async findTagOwner(uid: string, spools?: SpoolmanSpool[]): Promise<SpoolmanSpool | undefined> {
    const all = spools ?? (await this.listSpools());
    return all.find((spool) => spoolTagUids(spool).includes(uid));
  }

  async createSpoolForTag(spec: FilamentSpec, uid: string, options: NewSpoolOptions): Promise<SyncResult> {
    const fields = await this.ensureFields();
    const vendor = await this.findOrCreateVendor(spec.brand.trim() || 'Generic');
    const filament = await this.findOrCreateFilament(vendor.vendor, spec, fields.variant);

    if (options.takeTagFrom) await this.unlinkTag(options.takeTagFrom, uid);

    let spool = await this.request<SpoolmanSpool>('POST', '/spool', {
      filament_id: filament.filament.id,
      initial_weight: spec.weight > 0 ? spec.weight : undefined,
      location: options.location.trim() || undefined,
      extra: fields.cardUids ? { card_uids: encodeCardUids([uid]) } : {},
    });
    options.onCreated?.(spool);
    spool = await this.linkNativeTag(spool, uid);
    return {
      spool,
      createdSpool: true,
      createdFilament: filament.created,
      createdVendor: vendor.created,
      movedFrom: options.takeTagFrom,
    };
  }

  async linkTagToSpool(spool: SpoolmanSpool, uid: string, takeTagFrom?: SpoolmanSpool): Promise<SyncResult> {
    const fields = await this.ensureFields();
    if (takeTagFrom && takeTagFrom.id !== spool.id) await this.unlinkTag(takeTagFrom, uid);

    // card_uids is replaced as a whole, so build it from Spoolman's current copy, not one loaded earlier.
    let updated = await this.request<SpoolmanSpool>('GET', `/spool/${spool.id}`);
    const uids = decodeCardUids(updated.extra?.['card_uids']);
    if (fields.cardUids && !uids.includes(uid)) {
      updated = await this.request<SpoolmanSpool>('PATCH', `/spool/${spool.id}`, {
        extra: { ...updated.extra, card_uids: encodeCardUids([...uids, uid]) },
      });
    }
    updated = await this.linkNativeTag(updated, uid);
    return {
      spool: updated,
      createdSpool: false,
      createdFilament: false,
      createdVendor: false,
      movedFrom: takeTagFrom?.id === spool.id ? undefined : takeTagFrom,
    };
  }

  /** Link URL to the spool's page in Spoolman's web UI. */
  spoolPageUrl(spoolId: number): string {
    return `${this.baseUrl()}/spool/show/${spoolId}`;
  }

  private async unlinkTag(stale: SpoolmanSpool, uid: string): Promise<void> {
    const spool = await this.request<SpoolmanSpool>('GET', `/spool/${stale.id}`);
    const uids = decodeCardUids(spool.extra?.['card_uids']);
    if (uids.includes(uid)) {
      await this.request('PATCH', `/spool/${spool.id}`, {
        extra: { ...spool.extra, card_uids: encodeCardUids(uids.filter((u) => u !== uid)) },
      });
    }
    if (spool.tags?.some((t) => t.uid.toUpperCase() === uid)) {
      await this.request('DELETE', `/spool/${spool.id}/tag/${uid}`);
    }
  }

  /** Spoolman 0.27+ includes a `tags` array on spools; older servers don't have the endpoint. */
  private async linkNativeTag(spool: SpoolmanSpool, uid: string): Promise<SpoolmanSpool> {
    if (!Array.isArray(spool.tags) || spool.tags.some((t) => t.uid.toUpperCase() === uid)) return spool;
    try {
      await this.request('POST', `/spool/${spool.id}/tag`, { uid, format: 'ntag' });
    } catch (error) {
      // 409: the tag is linked to a filament type rather than a spool. Move it to this spool.
      const filamentId = error instanceof SpoolmanError && error.status === 409 ? conflictFilamentId(error) : null;
      if (filamentId === null) throw error;
      await this.request('DELETE', `/filament/${filamentId}/tag/${uid}`);
      await this.request('POST', `/spool/${spool.id}/tag`, { uid, format: 'ntag' });
    }
    return { ...spool, tags: [...spool.tags, { uid, format: 'ntag' }] };
  }

  /** Creates the same custom fields the U1 firmware creates, if they're missing. */
  private async ensureFields(): Promise<{ cardUids: boolean; variant: boolean }> {
    const [cardUids, variant] = await Promise.all([
      this.ensureField('spool', 'card_uids', 'Card UIDs'),
      this.ensureField('filament', 'variant', 'Variant'),
    ]);
    return { cardUids, variant };
  }

  private async ensureField(entity: 'spool' | 'filament', key: string, name: string): Promise<boolean> {
    const fields = await this.request<SpoolmanField[]>('GET', `/field/${entity}`);
    if (fields.some((f) => f.key === key)) return true;
    try {
      await this.request('POST', `/field/${entity}/${key}`, {
        name,
        field_type: 'text',
        order: 1,
        default_value: JSON.stringify(''),
      });
      return true;
    } catch {
      return false;
    }
  }

  private async findOrCreateVendor(name: string): Promise<{ vendor: SpoolmanVendor; created: boolean }> {
    const matches = await this.request<SpoolmanVendor[]>('GET', `/vendor?name=${encodeURIComponent(name)}`);
    const existing = matches.find((v) => v.name.trim().toLowerCase() === name.toLowerCase());
    if (existing) return { vendor: existing, created: false };
    return { vendor: await this.request<SpoolmanVendor>('POST', '/vendor', { name }), created: true };
  }

  private async findOrCreateFilament(
    vendor: SpoolmanVendor,
    spec: FilamentSpec,
    hasVariantField: boolean,
  ): Promise<{ filament: SpoolmanFilament; created: boolean }> {
    const material = spec.material.trim().toUpperCase();
    const name = filamentName(spec);
    const hex = spec.colorHex.toUpperCase();
    const candidates = await this.request<SpoolmanFilament[]>(
      'GET',
      `/filament?vendor.id=${vendor.id}&material=${encodeURIComponent(material)}`,
    );
    const existing = candidates.find(
      (f) =>
        (f.material ?? '').toUpperCase() === material &&
        (f.color_hex ?? '').slice(0, 6).toUpperCase() === hex &&
        (f.name ?? '').trim().toLowerCase() === name.toLowerCase() &&
        Math.abs(f.diameter - spec.diameter) < 0.01,
    );
    if (existing) return { filament: existing, created: false };

    const filament = await this.request<SpoolmanFilament>('POST', '/filament', {
      name,
      vendor_id: vendor.id,
      material,
      density: materialDefaults(material)?.density ?? 1.24,
      diameter: spec.diameter,
      weight: spec.weight > 0 ? spec.weight : undefined,
      color_hex: hex || undefined,
      settings_extruder_temp: spec.nozzleMin > 0 ? spec.nozzleMin : undefined,
      settings_bed_temp: spec.bedTemp > 0 ? spec.bedTemp : undefined,
      extra: hasVariantField && spec.subtype.trim() ? { variant: JSON.stringify(spec.subtype.trim()) } : {},
    });
    return { filament, created: true };
  }

  private async request<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    baseUrl = this.baseUrl(),
  ): Promise<T> {
    if (!baseUrl) throw new SpoolmanError('Spoolman isn’t set up. Add its address in Settings.', 0);
    const url = `${baseUrl}/api/v1${path}`;
    try {
      return await firstValueFrom(
        this.http.request<T>(method, url, { body: body ?? undefined }).pipe(timeout(REQUEST_TIMEOUT_MS)),
      );
    } catch (error) {
      throw this.describe(error, baseUrl, path);
    }
  }

  private describe(error: unknown, baseUrl: string, path: string): SpoolmanError {
    if (error instanceof TimeoutError) {
      return new SpoolmanError(`Spoolman at ${baseUrl} didn’t answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`, 0, {
        cause: error,
      });
    }
    if (!(error instanceof HttpErrorResponse)) {
      return new SpoolmanError(error instanceof Error ? error.message : String(error), 0, { cause: error });
    }
    if (error.status === 0) {
      const reason = this.isMixedContentBlocked(baseUrl)
        ? 'This page is served over https, so the browser blocks requests to an http:// Spoolman. Use the Android/iOS app, or put Spoolman behind https.'
        : 'Check the address, that Spoolman is running, and that this device is on the same network.';
      return new SpoolmanError(`Couldn’t reach Spoolman at ${baseUrl}. ${reason}`, 0, { cause: error });
    }
    if (error.status === 404 && path === '/info') {
      return new SpoolmanError(`${baseUrl} answered, but it doesn’t look like Spoolman.`, 404, { cause: error });
    }
    const detail = errorDetail(error.error);
    return new SpoolmanError(`Spoolman returned ${error.status}${detail ? `: ${detail}` : ''}`, error.status, {
      cause: error,
    });
  }
}

/** Accepts "192.168.1.20:7912", "http://host:7912/", "…/api/v1" and returns "http://host:7912". */
export function normalizeSpoolmanUrl(input: string): string {
  let url = input.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '').replace(/\/api\/v1$/i, '');
}

/** card_uids is a JSON-encoded, comma-separated string: "\"04A1B2,04C3D4\"". */
export function decodeCardUids(raw: string | undefined): string[] {
  if (!raw) return [];
  let value = raw.trim();
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'string') value = parsed;
  } catch {
    value = value.replace(/^"|"$/g, '');
  }
  return value
    .split(',')
    .map((uid) => uid.trim().toUpperCase())
    .filter(Boolean);
}

/** Unique, non-empty locations, keeping the first list's order. */
export function mergeLocations(...lists: string[][]): string[] {
  const seen = new Set<string>();
  for (const location of lists.flat()) {
    const trimmed = location.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/** Spoolman stores list settings as a JSON-encoded string, e.g. '["Shelf A"]'. */
function decodeSettingList(raw: string | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function encodeCardUids(uids: string[]): string {
  return JSON.stringify([...new Set(uids)].join(','));
}

export function spoolTagUids(spool: SpoolmanSpool): string[] {
  return [...decodeCardUids(spool.extra?.['card_uids']), ...(spool.tags ?? []).map((t) => t.uid.toUpperCase())];
}

/** Spoolman filament name: the color, prefixed by the subtype unless it's "Basic". */
export function filamentName(spec: FilamentSpec): string {
  const subtype = spec.subtype.trim();
  const color = spec.colorName.trim() || `#${spec.colorHex.toUpperCase()}`;
  const prefix = subtype && subtype.toLowerCase() !== 'basic' ? `${subtype} ` : '';
  return `${prefix}${color}`.slice(0, 64);
}

/** Describes a spool the way people recognize it: "#12 Polymaker PLA Matte Red". */
export function describeSpool(spool: SpoolmanSpool): string {
  const f = spool.filament;
  return [`#${spool.id}`, f.vendor?.name, f.material, f.name].filter(Boolean).join(' ');
}

function conflictFilamentId(error: SpoolmanError): number | null {
  const cause = error.cause;
  if (cause instanceof HttpErrorResponse && cause.error && typeof cause.error === 'object') {
    const id = (cause.error as { filament_id?: unknown }).filament_id;
    return typeof id === 'number' ? id : null;
  }
  return null;
}

function errorDetail(body: unknown): string {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body.slice(0, 200) : '';
  const { message, detail } = body as { message?: unknown; detail?: unknown };
  if (typeof message === 'string') return message;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d: { msg?: string; loc?: unknown[] }) => [d.loc?.slice(1).join('.'), d.msg].filter(Boolean).join(': '))
      .join('; ');
  }
  return '';
}
