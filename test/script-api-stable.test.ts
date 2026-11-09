/**
 * Stable Script API audit (BIZ-24, M15): every script a pack emits must type-check against the vendored
 * STABLE `@minecraft/server` / `server-ui` typings and use no beta-only or newer-than-declared name.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditScripts, auditPackFiles, readPackFiles } from '../scripts/_script_api_audit.ts';
import { coasterScript } from '../web/src/engine/bedrock-coaster.ts';
import { figureLifeScript } from '../web/src/engine/bedrock-figure-life.ts';
import { flyerScript } from '../web/src/engine/bedrock-flyer.ts';
import { interactivesScript } from '../web/src/engine/bedrock-interactives.ts';
import { minifigWandScript } from '../web/src/engine/bedrock-minifig-wand.ts';
import { pinballScript } from '../web/src/engine/bedrock-pinball.ts';
import { hopScript } from '../web/src/engine/bedrock-ride-hop.ts';
import { ridesScript } from '../web/src/engine/bedrock-rides.ts';
import { scriptedVehicleScript } from '../web/src/engine/bedrock-vehicle.ts';

const NL = String.fromCharCode(10);
const DECLARED ={ 'server': '2.9.0', 'server-ui': '2.1.0' };

describe('script-api-stable', () => {
  it('an emitted script calling a beta-only API fails the audit', () => {
    // `chatSend` is in the 2.12 beta typings only; `world` is a typed import here, so the checker sees it.
    const typed = auditScripts([{ path: 'scripts/typed.js', text: "import { world } from '@minecraft/server';\nworld.afterEvents.chatSend.subscribe(() => {});\n" }], DECLARED);
    expect(typed.ok).toBe(false);
    expect(typed.findings.some(f => f.file === 'scripts/typed.js' && f.line === 2)).toBe(true);
  });

  it('finds a beta-only name on an UNTYPED receiver, the way the packs pass world in', () => {
    const runtime = 'export function runtime(world) {\n  world.afterEvents.chatSend.subscribe(() => {});\n}\n';
    const r = auditScripts([{ path: 'scripts/untyped.js', text: runtime }], DECLARED);
    const hit = r.findings.find(f => f.kind === 'beta-api');
    expect(hit).toMatchObject({ file: 'scripts/untyped.js', line: 2 });
  });

  it('flags an API newer than the declared version but passes it when the manifest declares the newer one', () => {
    const src = [{ path: 'scripts/a.js', text: 'export function r(world) {\n  world.afterEvents.entityStartSneaking.subscribe(() => {});\n}\n' }];
    expect(auditScripts(src, DECLARED).findings.some(f => f.kind === 'newer-than-declared')).toBe(true);
    expect(auditScripts(src, { server: '2.11.0', 'server-ui': '2.3.0' }).ok).toBe(true);
  });

  it('flags a non-stable module import and a beta manifest dependency', () => {
    const r = auditScripts([{ path: 'scripts/g.js', text: "import { Test } from '@minecraft/server-gametest';\nexport const t = Test;\n" }], DECLARED);
    expect(r.findings.some(f => f.kind === 'module')).toBe(true);
    const pack = auditPackFiles(new Map([
      ['BP/manifest.json', JSON.stringify({ dependencies: [{ module_name: '@minecraft/server', version: '2.12.0-beta' }] })],
      ['BP/scripts/main.js', "import { world } from '@minecraft/server';\nexport const w = world;\n"],
    ]));
    expect(pack.findings.some(f => f.kind === 'manifest')).toBe(true);
  });

  it('passes a clean stable script and lists the APIs it uses with their stability', () => {
    const r = auditScripts([{ path: 'scripts/ok.js', text: "import { world, system } from '@minecraft/server';\nsystem.runInterval(() => { world.getAllPlayers(); }, 20);\n" }], DECLARED);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.apis).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'System.runInterval', stability: 'stable' }),
      expect.objectContaining({ name: 'World.getAllPlayers', stability: 'stable' }),
    ]));
  });

  it('every script the nine runtime generators emit passes against the manifest-declared stable versions', () => {
    const c = {} as never; // the config is JSON data embedded in the script; the API surface used does not depend on it
    const gens: Record<string, string> = {
      coaster: coasterScript({ tracks: [] } as never), figures: figureLifeScript(c), flyer: flyerScript(c),
      interactives: interactivesScript(c), 'minifig-wand': minifigWandScript(c), pinball: pinballScript(c),
      hop: hopScript(c), rides: ridesScript(c), vehicles: scriptedVehicleScript(c),
    };
    const files = new Map<string, string>([['BP/manifest.json', JSON.stringify({ dependencies: [{ module_name: '@minecraft/server', version: '2.9.0' }, { module_name: '@minecraft/server-ui', version: '2.1.0' }] })]]);
    for (const [name, text] of Object.entries(gens)) files.set(`BP/scripts/${name}.js`, text);
    const r = auditPackFiles(files);
    expect(r.scriptsChecked).toBe(9);
    expect(r.findings).toEqual([]);
    expect(r.apis.length).toBeGreaterThan(50);
    expect(r.apis.every(a => a.stability === 'stable')).toBe(true);
  });

  it('does not flag a script-own property that shares a beta name, nor a prototype name', () => {
    const src = ['const o = { chatSend: 1 };', 'export function r(x) {', '  return [o.chatSend, x.toString(), x.constructor];', '}', ''].join(NL);
    expect(auditScripts([{ path: 'scripts/own.js', text: src }], DECLARED).findings).toEqual([]);
  });

  it('reads a pack folder and a nested archive, grouping scripts under their own manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm15-pack-'));
    mkdirSync(join(dir, 'BP', 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'BP', 'manifest.json'), JSON.stringify({ dependencies: [{ module_name: '@minecraft/server', version: [2, 9, 0] }] }));
    writeFileSync(join(dir, 'BP', 'scripts', 'main.js'), ["import { world } from '@minecraft/server';", 'world.afterEvents.chatSend.subscribe(() => {});', ''].join(NL));
    const files = readPackFiles(dir);
    expect([...files.keys()].sort()).toEqual(['BP/manifest.json', 'BP/scripts/main.js']);
    const r = auditPackFiles(files);
    expect(r.findings.map(f => `${f.kind} ${f.file}:${f.line}`)).toEqual(['beta-api BP/scripts/main.js:2']);
  });
});
