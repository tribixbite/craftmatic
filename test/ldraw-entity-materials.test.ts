import { describe, expect, it } from 'vitest';
import { LDRAW_COLOR_RGB } from '../web/src/engine/ldraw-colors.js';
import { MATERIAL_PBR, resolveLdrawEntityMaterial } from '../web/src/engine/ldraw-entity-materials.js';
import classes from '../web/src/engine/ldraw-color-classes.json' with { type: 'json' };

const hex = (rgb: [number, number, number]): string => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();

describe('resolveLdrawEntityMaterial', () => {
  it('uses the viewer RGB for known ids, exactly', () => {
    for (const id of [0, 1, 4, 14, 15, 19, 71, 72]) {
      const m = resolveLdrawEntityMaterial(id);
      expect(hex(m.rgb)).toBe(LDRAW_COLOR_RGB[id]!.toUpperCase());
      expect(m.known).toBe(true);
    }
    expect(resolveLdrawEntityMaterial(4)).toMatchObject({ materialClass: 'abs', alpha: 1, ...MATERIAL_PBR.abs });
  });

  it('classifies finishes from LDConfig: transparent, rubber, chrome, metallic, pearl, glow', () => {
    expect(resolveLdrawEntityMaterial(47)).toMatchObject({ materialClass: 'transparent', alpha: 128 / 255 });
    expect(resolveLdrawEntityMaterial(41)).toMatchObject({ materialClass: 'transparent' });
    expect(resolveLdrawEntityMaterial(256)).toMatchObject({ materialClass: 'rubber', alpha: 1 });
    expect(resolveLdrawEntityMaterial(383)).toMatchObject({ materialClass: 'chrome', metalness: 1 });
    expect(resolveLdrawEntityMaterial(80)).toMatchObject({ materialClass: 'metallic' });
    expect(resolveLdrawEntityMaterial(297)).toMatchObject({ materialClass: 'pearl' });
    expect(resolveLdrawEntityMaterial(21)).toMatchObject({ materialClass: 'glow', emissive: MATERIAL_PBR.glow.emissive });
    // A transparent glow colour keeps its alpha even though its class is glow.
    expect(resolveLdrawEntityMaterial(294).alpha).toBeLessThan(1);
  });

  it('decodes direct colours exactly', () => {
    expect(resolveLdrawEntityMaterial(0x2ff8800)).toMatchObject({ rgb: [255, 136, 0], materialClass: 'abs', alpha: 1, known: true });
    expect(resolveLdrawEntityMaterial(0x3ff8800)).toMatchObject({ rgb: [255, 136, 0], materialClass: 'transparent' });
    expect(resolveLdrawEntityMaterial(0x3ff8800).alpha).toBeLessThan(1);
  });

  it('falls back to the generated table for ids the viewer table lacks, and to grey for unknown ids', () => {
    // Since 2026-09-24 the viewer table is filled from LDConfig
    // (ldconfig-colors.generated.ts), so every class-table id is usually
    // covered; the fallback is checked on whichever id still is not.
    const onlyInTable = Object.keys((classes as { colours: Record<string, { rgb: string }> }).colours)
      .map(Number).find(id => LDRAW_COLOR_RGB[id] === undefined);
    if (onlyInTable !== undefined) {
      const m = resolveLdrawEntityMaterial(onlyInTable);
      expect(m.known).toBe(true);
      expect(hex(m.rgb)).toBe((classes as { colours: Record<string, { rgb: string }> }).colours[String(onlyInTable)]!.rgb);
    }
    // The 2026 colours that came out grey on 42703 are known now.
    for (const id of [362, 364, 368, 371, 422, 430, 431]) expect(resolveLdrawEntityMaterial(id).known).toBe(true);
    const unknown = resolveLdrawEntityMaterial(9_999_999);
    expect(unknown).toMatchObject({ known: false, rgb: [127, 127, 127], materialClass: 'abs' });
  });

  it('treats Studio extended ids by LDConfig where it has them, else by the viewer rules', () => {
    // 10036 is in the current LDConfig as a RUBBER colour with ALPHA: the class
    // says rubber, the alpha still routes it to the translucent mesh.
    const m = resolveLdrawEntityMaterial(10036);
    expect(m.materialClass).toBe('rubber');
    expect(m.alpha).toBeLessThan(1);
    // A rubber-band id the tables lack falls to the viewer's 10000–10999 rule.
    const rubberOnlyByRule = 10999;
    expect(LDRAW_COLOR_RGB[rubberOnlyByRule]).toBeUndefined();
    expect(resolveLdrawEntityMaterial(rubberOnlyByRule).known).toBe(false);
  });

  it('is memoised: the same id returns the same object', () => {
    expect(resolveLdrawEntityMaterial(15)).toBe(resolveLdrawEntityMaterial(15));
  });
});
