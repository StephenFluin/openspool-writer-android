# U1 Spool Tags

Write NFC filament tags for the Snapmaker U1, with optional [Spoolman](https://github.com/Donkie/Spoolman) sync.

An Angular app wrapped with Capacitor for Android and iOS. It also runs as a web page in Chrome on Android, via Web NFC.

## How it works

The stock U1 firmware only reads Snapmaker's own spools. The community [Snapmaker U1 Extended Firmware](https://github.com/paxx12-snapmaker-u1/SnapmakerU1-Extended-Firmware) adds support for **OpenSpool** tags: an NTAG215/216 holding one NDEF record of type `application/json`. This app writes that record.

```json
{
  "protocol": "openspool",
  "version": "1.0",
  "type": "PETG",
  "color_hex": "C12E1F",
  "brand": "Polymaker",
  "subtype": "Matte",
  "min_temp": "235",
  "max_temp": "260",
  "bed_min_temp": "70",
  "bed_max_temp": "70",
  "diameter": "1.75",
  "weight": "1000"
}
```

The payload follows what the firmware's two readers actually parse:

- The built-in reader is `filament_protocol_ndef.py`; OpenRFID is the other.
- `alpha` is never written. The built-in reader parses it as a decimal integer, while OpenRFID parses it as a hex string and drops the whole tag if that fails.
- Temperatures are numeric strings, as in the OpenSpool spec. Both readers run them through `int()`.
- The U1's reader reads exactly the NTAG215 page range, so the app blocks NTAG213 and other tags under ~400 bytes. You can override this with "Write anyway".

In the native apps, each scan also asks the chip what it is (`src/app/core/nfc/type2.ts`):

- `GET_VERSION` gives the model.
- Page 3 holds the NDEF header. It is one-time programmable, so the app only sets it up when its bits still allow it.
- The lock bytes, `AUTH0`/`PROT` (passwords) and `MIRROR` (UID mirroring) show whether the tag can be written.

Check and the write error dialog show these findings. Blank NTAGs, and NTAGs where Android's NDEF writer fails, are written page by page and read back to verify. The write order means an interrupted write never leaves a half-written message that looks valid.

### NFC plugins

- **Android** uses the app's own `TagReader` plugin (`android/app/src/main/java/io/fluin/u1tags/TagReaderPlugin.java`) for scanning and tag I/O. `@capgo/capacitor-nfc` has several problems there:
  - It retains tag events and replays them to the next listener.
  - It sends commands to whichever tag came last.
  - After a raw command, it stops reporting tags until the app restarts.

  `TagReader` addresses each tag by ID and settles every call. It also keeps reader mode on for a short grace period between scans, so a lifted tag isn't handed to the system. "Try again" reuses a tag that is still on the phone.
- **iOS** uses `@capgo/capacitor-nfc`'s tag reader session. Its listeners are registered once, because the plugin replays events to new listeners. Before a write, only page 0 is read, because on iOS a refused command halts the tag for the rest of the session.
- Both platforms share the read and write logic in `src/app/core/nfc/tag-ops.ts`. Its tests run against a simulated NTAG215 (`src/app/core/nfc/testing/fake-ntag.ts`).

### Spoolman

When a Spoolman address is set, writing a tag also does the following:

1. Creates the `card_uids` (spool) and `variant` (filament) custom fields if they're missing. These are the same definitions the U1 firmware uses.
2. Finds or creates the vendor and the filament, matching on material, name, color and diameter.
3. Creates a spool with `extra.card_uids = "\"<UID>\""`. On Spoolman 0.27+ it also links the UID as a native tag. The U1 firmware can read either store (`tag_store = card_uids | native`).
4. If the UID already belongs to another spool, asks before moving it. The printer would otherwise keep loading the old spool.

You can also link a tag to an existing spool, which fills the form from Spoolman.

The location pickers (Settings and the Write page) list Spoolman's locations: the Locations page's order first, then any other location a spool uses. Typing a new name adds it.

## Development

```bash
npm install
npm start
```

Open `http://localhost:4200/?nfc=mock` to use a simulated tag in a desktop browser (dev builds only). Scenarios: `?nfc=mock-existing`, `-readonly`, `-ntag213`, `-unformatted`, `-password`, `-clone`, `-classic`, `-iso15693`, `-lost`, `-absent`, `-disabled`, `-unsupported`. Use `?nfc=off` to go back to real NFC.

```bash
npm test          # unit tests (Vitest)
npm run catalog   # refresh public/catalog.json from SpoolmanDB
```

### Native apps

```bash
npm run android   # build, sync, open Android Studio
npm run ios       # build, sync, open Xcode
npm run apk       # build a debug APK without Android Studio
```

`npm run apk` writes `android/app/build/outputs/apk/debug/app-debug.apk`. It needs JDK 21 (`JAVA_HOME`) and the Android SDK (`ANDROID_HOME`) with platform 36.

- **Android:** the app declares NFC and allows cleartext HTTP, so a plain `http://` Spoolman on the LAN works.
- **iOS:** writing needs the *NFC Tag Reading* capability (`App/App.entitlements`, formats `NDEF` and `TAG`). The `TAG` session is the only way to get the tag UID that Spoolman links on. Your signing team must have that capability. Hold the tag to the top edge of the iPhone.
- Network requests go through `CapacitorHttp`, which bypasses CORS and mixed-content rules.

### Web version

Web NFC works only in Chrome on Android, over HTTPS. Use `npm run start:phone` and open `https://<your-computer>:4200` on the phone. Two browser limits apply to Spoolman:

- **Mixed content:** an `https` page can't call an `http` Spoolman.
- **CORS:** start Spoolman with `SPOOLMAN_CORS_ORIGIN=<app origin>`.

The native app avoids both.

## Layout

```
src/app/core/          filament model, OpenSpool encoding, catalog, settings
src/app/core/nfc/      NfcService; Android, iOS, Web NFC and mock backends; NTAG protocol; troubleshooting copy
src/app/core/spoolman/ Spoolman REST client
src/app/features/      write (form + write dialog/flow), check, settings, help
src/app/shared/        accessible combobox, tag summary, NFC status banner
scripts/               SpoolmanDB → public/catalog.json
```

Manufacturer and color suggestions come from [SpoolmanDB](https://github.com/Donkie/SpoolmanDB) (MIT).
