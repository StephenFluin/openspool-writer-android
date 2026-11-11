import { NfcBackend, NfcError } from './nfc-types';

export interface ProblemHelp {
  title: string;
  tips: string[];
  /** Show a button that opens the system NFC settings. */
  offerSettings: boolean;
  /** Show "Write anyway" — only for tags that will take the data but the U1 may not read. */
  offerOverride: boolean;
}

const FINDING_THE_ANTENNA_ANDROID =
  'On most Android phones the NFC antenna is in the middle of the back, near the camera. Slowly slide the tag around there.';
const FINDING_THE_ANTENNA_IOS = 'On iPhone the NFC antenna is along the top edge. Touch the tag to the top of the phone.';
const HOLD_STILL = 'Hold the tag flat against the phone and keep it still for a couple of seconds.';
const USE_NTAG215 = 'Use NTAG215 or NTAG216 stickers (13.56 MHz, “NFC Forum Type 2”). They’re cheap and the U1 reads them reliably.';

export function helpFor(error: NfcError, backend: NfcBackend['kind'], isIos: boolean): ProblemHelp {
  const antenna = isIos ? FINDING_THE_ANTENNA_IOS : FINDING_THE_ANTENNA_ANDROID;
  const help = (title: string, tips: string[], extra: Partial<ProblemHelp> = {}): ProblemHelp => ({
    title,
    tips,
    offerSettings: false,
    offerOverride: false,
    ...extra,
  });

  switch (error.code) {
    case 'timeout':
      return help('No tag found', [
        antenna,
        HOLD_STILL,
        'Take the phone out of thick, metal or magnetic cases (wallet cases and grips block NFC).',
        'If the tag is already on a spool, make sure no metal (foil, a metal hub) is behind it.',
        'Check it really is an NFC tag. 125 kHz RFID key fobs look similar but phones can’t see them.',
      ]);
    case 'disabled':
      return help(
        'NFC is turned off',
        backend === 'web'
          ? ['Turn on NFC in Android’s quick settings or Settings › Connected devices › Connection preferences, then try again.']
          : ['Turn on NFC in your phone’s settings, then come back and try again.'],
        { offerSettings: backend === 'native' && !isIos },
      );
    case 'unsupported':
      return help(
        backend === 'web' ? 'This browser can’t write NFC tags' : 'This device has no NFC',
        backend === 'web'
          ? [
              'Web NFC only works in Chrome on Android. Open this page in Chrome on an Android phone, or install the app.',
              'iPhones can’t write NFC tags from a web page; the iOS app can.',
            ]
          : ['This phone doesn’t have an NFC reader. Use a phone that does (most Android phones and iPhone 7 or newer).'],
      );
    case 'permission':
      return help('NFC permission is blocked', [
        'In Chrome, tap the icon left of the address, open Permissions, and allow NFC for this site.',
        'If permission is already allowed, the tag may be locked. Try a fresh tag.',
      ]);
    case 'read-only':
      return help('This tag is locked', [
        'Locked tags can never be rewritten. Use a new, blank tag.',
        'Tags that came on a vendor spool (Bambu, Snapmaker, Creality…) are locked and encrypted. Stick a fresh NTAG215 on the spool instead.',
        'If the vendor tag sits next to yours, cover it with a piece of foil tape so the U1 reads yours.',
      ]);
    case 'too-small':
      return help('This tag is too small', [
        error.message,
        USE_NTAG215,
        'NTAG213 tags (often sold as “144 byte” tags) don’t have room, and the U1 can’t read them anyway.',
      ]);
    case 'incompatible': {
      const sizeOnly = error.tag?.capacity != null && !/ISO 15693|MIFARE Classic/.test(error.message);
      return help('The U1 can’t read this kind of tag', [error.message, USE_NTAG215], { offerOverride: sizeOnly });
    }
    case 'not-ndef':
      return help('This tag can’t hold spool data', [
        error.message,
        USE_NTAG215,
        'MIFARE Classic tags (common in key cards) and some Chinese “NFC” stickers aren’t NDEF tags.',
        'Some tags ship password-protected. If a brand-new tag fails, try another from the pack.',
      ]);
    case 'tag-lost':
      return help('The tag moved away', [
        'The write started but the tag left the phone’s range.',
        HOLD_STILL + ' Wait for the confirmation before moving it.',
        'If you’re tagging a spool that’s already wound, press the phone firmly against the tag.',
      ]);
    case 'write-failed':
      return help('Writing failed', [
        error.message,
        HOLD_STILL,
        'The tag may be password-protected or damaged. Try another tag.',
      ]);
    case 'cancelled':
      return help('Cancelled', []);
    case 'unknown':
      return help('Something went wrong', [error.message, HOLD_STILL, 'Try again, or try a different tag.']);
  }
}
