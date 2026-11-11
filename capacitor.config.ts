import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.fluin.u1tags',
  appName: 'U1 Spool Tags',
  webDir: 'dist/u1-nfc-tags/browser',
  plugins: {
    // Route fetch/XHR through native HTTP so a plain-http Spoolman on the LAN works
    // without CORS headers or mixed-content blocking.
    CapacitorHttp: { enabled: true },
  },
};

export default config;
