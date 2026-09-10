import { describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { Aes256Cfb8 } from '../worker/aes-cfb8.js';
import {
  fnv1a32,
  COMMAND_WINDOW,
  HS1_CHUNK_SIZE,
  MAX_HS1_BYTES,
  LiveDeliverySession,
  validateHs1,
} from '../worker/live-delivery.js';
import { checksum, makeParts } from '../web/src/engine/hotschem/live-import.js';

describe('live delivery protocol boundary', () => {
  it('keeps a browser-first import pending until Minecraft pairing resolves', async () => {
    const relay = new LiveDeliverySession({ storage: {} });
    const sent: Array<{ type: string; phase?: string }> = [];
    relay.browser = { readyState: 1, bufferedAmount: 0, send: (raw: string) => sent.push(JSON.parse(raw)) };
    relay.browserAuthed = true;
    relay.deliveryRunning = true;
    relay.deliveryGeneration = 1;
    relay.checkedCommand = async () => ({ statusCode: 0 });
    relay.waitForTag = async () => {};
    relay.waitForCompletion = async () => {};
    let settled = false;
    const pending = relay.deliver('AAA', fnv1a32('AAA'), 1, 1).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(sent.at(-1)).toMatchObject({ type: 'progress', phase: 'pairing' });
    relay.player = 'BrowserFirst';
    relay.pairingResolve('BrowserFirst');
    await pending;
    expect(settled).toBe(true);
    expect(sent.at(-1)).toMatchObject({ type: 'complete', player: 'BrowserFirst' });
  });

  it('matches Node crypto AES-256-CFB8 across stateful updates', () => {
    const key = Uint8Array.from({ length: 32 }, (_, i) => i * 7 & 255);
    const iv = key.slice(0, 16);
    const plain = new TextEncoder().encode('Minecraft CFB8 state persists across every WebSocket frame.');
    const oracle = createCipheriv('aes-256-cfb8', key, iv);
    const expected = Buffer.concat([oracle.update(plain.slice(0, 9)), oracle.update(plain.slice(9))]);
    const cipher = new Aes256Cfb8(key, iv);
    const actual = Buffer.concat([Buffer.from(cipher.update(plain.slice(0, 9))), Buffer.from(cipher.update(plain.slice(9)))]);
    expect(actual).toEqual(expected);
    const decipher = new Aes256Cfb8(key, iv, true);
    const decoded = Buffer.concat([Buffer.from(decipher.update(actual.slice(0, 13))), Buffer.from(decipher.update(actual.slice(13)))]);
    expect(decoded).toEqual(Buffer.from(plain));
    expect(createDecipheriv('aes-256-cfb8', key, iv).update(expected)).toEqual(Buffer.from(plain));
  });
  it('matches the HS1 FNV-1a checksum and 300-character chunking', () => {
    const encoded = 'Ab_-09'.repeat(101);
    expect(fnv1a32(encoded)).toBe('d1217851');
    expect(fnv1a32(encoded)).toBe(checksum(encoded));
    expect(validateHs1(encoded, fnv1a32(encoded))).toBe(Math.ceil(encoded.length / HS1_CHUNK_SIZE));
    expect(makeParts(encoded, HS1_CHUNK_SIZE)[0]?.startsWith(`HS1:${checksum(encoded)}:1:`)).toBe(true);
    expect(COMMAND_WINDOW).toBe(8);
  });

  it('rejects arbitrary command text, bad checksums, and oversized payloads', () => {
    expect(() => validateHs1('abc say @a hacked', fnv1a32('abc say @a hacked'))).toThrow(/invalid characters/);
    expect(() => validateHs1('abc', '00000000')).toThrow(/does not match/);
    expect(() => validateHs1('A'.repeat(MAX_HS1_BYTES + 1), fnv1a32('A'))).toThrow(/must contain/);
  });

  it('accepts the receiver maximum while keeping every data command bounded', () => {
    const encoded = 'A'.repeat(MAX_HS1_BYTES);
    const count = validateHs1(encoded, fnv1a32(encoded));
    expect(count).toBeLessThanOrEqual(16_384);
    const longest = `execute as @a[name="1234567890123456",c=1] at @s run scriptevent hotschem:stream HS1:ffffffff:${count - 1}:${count}:${'A'.repeat(HS1_CHUNK_SIZE)}`;
    expect(longest.length).toBeLessThanOrEqual(461);
  });
});
