import { describe, expect, it } from 'vitest';
import { bedrockFloat, bedrockJsonText, floatActorProperty } from '../web/src/engine/bedrock-json.js';

describe('bedrockJsonText float literals', () => {
  it('writes a whole number as a float literal that still parses as that number', () => {
    const text = bedrockJsonText({ default: bedrockFloat(0), range: [bedrockFloat(-90), bedrockFloat(90)] }, 2);
    expect(text).toContain('"default": 0.0');
    expect(text).toContain('-90.0');
    expect(JSON.parse(text)).toEqual({ default: 0, range: [-90, 90] });
  });
  it('keeps the spelling of values that already carry a decimal point or exponent', () => {
    for (const [value, expected] of [[0.5, '0.5'], [1e-7, '1e-7'], [1e21, '1e+21'], [-0, '0.0']] as const) {
      const text = bedrockJsonText({ v: bedrockFloat(value) });
      expect(text).toBe(`{"v":${expected}}`);
      expect(JSON.parse(text).v).toBe(Number(expected));
    }
  });
  it('rejects a value that cannot be written as a finite literal', () => {
    for (const value of [NaN, Infinity, -Infinity]) expect(() => bedrockFloat(value)).toThrow(/finite/);
  });
  it('refuses to serialize a float literal through plain JSON.stringify', () => {
    // Silently emitting the tagged string would ship a string where Bedrock
    // requires a number — the fault this module exists to prevent.
    expect(() => JSON.stringify({ v: bedrockFloat(1) })).toThrow(/bedrockJsonText/);
  });
  it('cannot be forged by data: a string that mimics the tag survives untouched', () => {
    // The tag is generated per call, so no label, set name or key can predict it.
    const forged = '__craftmatic_float_0_abc__(42)';
    const text = bedrockJsonText({ label: forged, [forged]: forged, v: bedrockFloat(2) });
    const parsed = JSON.parse(text);
    expect(parsed.label).toBe(forged);
    expect(parsed[forged]).toBe(forged);
    expect(parsed.v).toBe(2);
  });
  it('leaves ordinary values byte-identical to JSON.stringify', () => {
    const value = { bones: [{ origin: [-11, 0, -10], size: [22, 2, 20], uv: [0, 0] }], name: 'cart' };
    expect(bedrockJsonText(value)).toBe(JSON.stringify(value));
    expect(bedrockJsonText(value, 2)).toBe(JSON.stringify(value, null, 2));
  });
});

describe('floatActorProperty', () => {
  it('marks every number in the property, not only the default', () => {
    const text = bedrockJsonText({ p: floatActorProperty([-180, 180], 0) }, 2);
    expect(text).not.toMatch(/: -?\d+(?![.\d])/);
    expect(JSON.parse(text).p).toEqual({ type: 'float', range: [-180, 180], default: 0, client_sync: true });
  });
  it('rejects a default outside its range and a reversed range, with distinct messages', () => {
    expect(() => floatActorProperty([-90, 90], 91)).toThrow(/outside its range/);
    expect(() => floatActorProperty([90, -90], 0)).toThrow(/reversed/);
    expect(() => floatActorProperty([-90, 90], NaN)).toThrow(/outside its range/);
  });
});
