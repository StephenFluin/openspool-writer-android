import { encodePayload, OPENSPOOL_MIME, tagBytesNeeded } from '../openspool';
import { WriteRequest } from './nfc-types';
import { readTag, writeTag } from './tag-ops';
import { FakeNtag, ndefFails } from './testing/fake-ntag';
import { encodeNdefMessage } from './type2';

const data = encodePayload({ protocol: 'openspool', version: '1.0', type: 'PLA', color_hex: '1F2A44', brand: 'Polymaker' });
const request: WriteRequest = { mediaType: OPENSPOOL_MIME, data, bytesNeeded: tagBytesNeeded(data.length), allowIncompatible: false };
const message = Array.from(encodeNdefMessage(OPENSPOOL_MIME, data));

describe('writeTag', () => {
  it('writes a formatted tag through the platform NDEF writer', async () => {
    const tag = new FakeNtag();
    const result = await writeTag(tag, tag.info(), request);
    expect(tag.ndefWrites).toEqual([request]);
    expect(tag.frames.some((f) => f[0] === 0xa2)).toBe(false);
    expect(result.chip?.chip).toBe('NTAG215');
  });

  it('sets up a blank tag page by page, writing the NDEF header last', async () => {
    const tag = new FakeNtag({ formatted: false });
    await writeTag(tag, tag.info(), request);
    expect(tag.ndefWrites).toEqual([]);
    const writes = tag.frames.filter((f) => f[0] === 0xa2).map((f) => f[1]);
    expect(writes.at(-1)).toBe(3);
    expect(tag.pages[3]).toEqual([0xe1, 0x10, 0x3e, 0x00]);
    expect(tag.ndefMessage()).toEqual(message);
  });

  it('falls back to page writes when the NDEF writer fails on a healthy tag', async () => {
    const tag = new FakeNtag({ ndefWrite: ndefFails('write-failed') });
    await writeTag(tag, tag.info(), request);
    const writes = tag.frames.filter((f) => f[0] === 0xa2);
    // Page 4 is emptied first and given its real length last.
    expect(writes[0]).toEqual([0xa2, 4, 0x03, 0x00, 0xfe, 0x00]);
    expect(writes.at(-1)?.[1]).toBe(4);
    expect(tag.ndefMessage()).toEqual(message);
  });

  it('does not fall back on iOS, where a failed write leaves the tag unreachable', async () => {
    const tag = new FakeNtag({ ndefWrite: ndefFails('write-failed'), haltsOnRefusal: true });
    await expect(writeTag(tag, tag.info(), request)).rejects.toMatchObject({ code: 'write-failed' });
    expect(tag.frames.some((f) => f[0] === 0xa2)).toBe(false);
  });

  it('on iOS, reads only the header of a formatted tag before writing', async () => {
    const tag = new FakeNtag({ haltsOnRefusal: true });
    await writeTag(tag, tag.info(), request);
    expect(tag.frames).toEqual([[0x30, 0]]);
    expect(tag.ndefWrites).toHaveLength(1);
  });

  it('refuses password-protected tags before writing anything', async () => {
    const tag = new FakeNtag({ auth0: 0x04 });
    await expect(writeTag(tag, tag.info(), request)).rejects.toMatchObject({ code: 'password' });
    expect(tag.ndefWrites).toEqual([]);
  });

  it('treats a configuration it may not read as read-protected', async () => {
    const tag = new FakeNtag({ auth0: 0x10, readProtected: true });
    await expect(writeTag(tag, tag.info(), request)).rejects.toMatchObject({ code: 'password' });
  });

  it('refuses tags that mirror their UID into memory', async () => {
    const tag = new FakeNtag({ mirror: true });
    await expect(writeTag(tag, tag.info(), request)).rejects.toMatchObject({ code: 'incompatible' });
  });

  it('reports a tag that leaves partway through as moved, not broken', async () => {
    const tag = new FakeNtag({ formatted: false, leavesAfter: 10 });
    await expect(writeTag(tag, tag.info(), request)).rejects.toMatchObject({ code: 'tag-lost' });
    expect(tag.pages[3]).toEqual([0, 0, 0, 0]);
  });

  it('notices a page that did not keep its data', async () => {
    const tag = new FakeNtag({ formatted: false, flakyPages: [6] });
    await expect(writeTag(tag, tag.info(), request)).rejects.toMatchObject({ code: 'write-failed' });
  });

  it('treats a chip that ignores GET_VERSION as a clone, not a lost tag, when it still answers (Android)', async () => {
    const tag = new FakeNtag({ silentVersion: true });
    const result = await writeTag(tag, tag.info(), request);
    expect(result.chip).toMatchObject({ knownNtag: false });
    expect(tag.ndefWrites).toHaveLength(1);
  });

  it('reports a tag that leaves during the configuration read as moved, not password protected (Android)', async () => {
    const tag = new FakeNtag({ leavesAfter: 2 });
    await expect(writeTag(tag, tag.info(), request)).rejects.toMatchObject({ code: 'tag-lost' });
  });

  it('identifies a tag whose whole memory is read protected (Android)', async () => {
    const tag = new FakeNtag({ auth0: 0x00, readProtected: true });
    await expect(writeTag(tag, tag.info(), request)).rejects.toMatchObject({ code: 'password' });
  });

  it('stops at a write refused with a NAK handed back as data', async () => {
    const tag = new FakeNtag({ formatted: false, nakAsData: [6] });
    await expect(writeTag(tag, tag.info(), request)).rejects.toMatchObject({ code: 'write-failed' });
    expect(tag.pages[3]).toEqual([0, 0, 0, 0]);
  });

  it('on iOS, inspects a tag whose header shows locks before writing, and refuses it', async () => {
    const tag = new FakeNtag({ haltsOnRefusal: true, locks: [0x00, 0xff] });
    await expect(writeTag(tag, tag.info(), request)).rejects.toMatchObject({ code: 'read-only' });
    expect(tag.ndefWrites).toEqual([]);
  });

  it('refuses a tag this flow already wrote', async () => {
    const tag = new FakeNtag();
    await expect(writeTag(tag, tag.info(), { ...request, skipUids: ['048AA0F2D04F81'] })).rejects.toMatchObject({ code: 'same-tag' });
  });

  it('still writes clones that will not say what they are, through the NDEF writer', async () => {
    const tag = new FakeNtag({ answersVersion: false });
    const result = await writeTag(tag, tag.info(), request);
    expect(result.chip?.knownNtag).toBe(false);
    expect(tag.ndefWrites).toHaveLength(1);
  });
});

describe('readTag', () => {
  it('reports what the chip says about itself', async () => {
    const tag = new FakeNtag({ locks: [0x0f, 0xe0] });
    const result = await readTag(tag, tag.info());
    expect(result.chip).toMatchObject({ chip: 'NTAG215', locked: true, passwordProtected: false, mirrored: false });
  });

  it('on iOS, says a refused configuration read could not be checked rather than calling it a password', async () => {
    const tag = new FakeNtag({ haltsOnRefusal: true, auth0: 0x10, readProtected: true });
    const result = await readTag(tag, tag.info());
    expect(result.chip?.passwordProtected).toBeNull();
    expect(result.chip?.findings.join(' ')).toMatch(/can’t be ruled out/);
  });

  it('reports a tag that leaves during the read as moved', async () => {
    const tag = new FakeNtag({ leavesAfter: 1 });
    await expect(readTag(tag, tag.info())).rejects.toMatchObject({ code: 'tag-lost' });
  });
});
