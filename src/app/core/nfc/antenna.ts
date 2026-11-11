import { Capacitor, registerPlugin } from '@capacitor/core';

/** What Android 14+ reports through NfcAntennaInfo, in millimeters, seen from the screen side. */
export interface NfcAntennaInfo {
  deviceWidth?: number;
  deviceHeight?: number;
  foldable?: boolean;
  antennas?: { x: number; y: number }[];
}

interface NfcAntennaPlugin {
  getInfo(): Promise<NfcAntennaInfo>;
}

const NfcAntenna = registerPlugin<NfcAntennaPlugin>('NfcAntenna');

/** Where to hold a tag, drawn on the back of the phone. Units are millimeters. */
export interface AntennaSpot {
  width: number;
  height: number;
  /** Position on the back of the phone (mirrored from the screen-side coordinates Android reports). */
  x: number;
  y: number;
  /** 'device' when this phone reported it, otherwise a typical position for the platform. */
  source: 'device' | 'typical';
  platform: 'android' | 'ios' | 'web';
}

const TYPICAL_ANDROID: AntennaSpot = { width: 75, height: 160, x: 37.5, y: 50, source: 'typical', platform: 'android' };
const IPHONE: AntennaSpot = { width: 72, height: 147, x: 36, y: 4, source: 'typical', platform: 'ios' };

/** Picks the spot to show from what the phone reported, falling back to the usual place. */
export function antennaSpot(platform: string, info: NfcAntennaInfo | null): AntennaSpot {
  if (platform === 'ios') return IPHONE;
  const antenna = info?.antennas?.[0];
  const width = info?.deviceWidth ?? 0;
  const height = info?.deviceHeight ?? 0;
  if (antenna && width > 0 && height > 0) {
    return { width, height, x: width - antenna.x, y: antenna.y, source: 'device', platform: 'android' };
  }
  return { ...TYPICAL_ANDROID, platform: platform === 'android' ? 'android' : 'web' };
}

let cached: Promise<AntennaSpot> | null = null;

/** The antenna spot for this phone; asks Android once per app run. */
export function loadAntennaSpot(): Promise<AntennaSpot> {
  cached ??= (async () => {
    const platform = Capacitor.getPlatform();
    if (platform !== 'android') return antennaSpot(platform, null);
    try {
      return antennaSpot(platform, await NfcAntenna.getInfo());
    } catch {
      return antennaSpot(platform, null);
    }
  })();
  return cached;
}
