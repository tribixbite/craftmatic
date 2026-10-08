/**
 * A ready-to-run world: the engine with its motion systems, the controls, the
 * script host, and add-ons loaded exactly as shipped. The one entry point a
 * scenario, a test or the CLI needs.
 */

import { SimEngine, type EngineOptions } from './engine.js';
import { ControlState } from '../input/controls.js';
import { installPhysics } from '../physics/systems.js';
import { installBodySystems } from '../physics/body-systems.js';
import { ScriptHost, type ScriptHostOptions } from '../script-host/host.js';
import { readAddon, type Addon } from '../pack/pack.js';
import { FLAT_GROUND_Y } from '../world/voxel-world.js';
import type { SimEntity } from '../entity/entity.js';
import type { Vec3 } from './vec.js';

export interface SimulationOptions extends EngineOptions, ScriptHostOptions {}

export class Simulation {
  readonly engine: SimEngine;
  readonly controls = new ControlState();
  readonly host: ScriptHost;
  readonly addons: Addon[] = [];

  constructor(readonly options: SimulationOptions = {}) {
    this.engine = new SimEngine(options);
    installPhysics(this.engine, this.controls);
    installBodySystems(this.engine);
    this.host = new ScriptHost(this.engine, this.controls, options);
  }

  /** Load an add-on (its definitions, structures and scripts). Scripts start at once, as when a world opens. */
  loadAddon(addon: Addon): void {
    this.addons.push(addon);
    this.engine.loadAddon(addon);
    this.host.loadScripts(addon);
  }

  /** Read and load an add-on archive. */
  async loadAddonBytes(bytes: ArrayBuffer | Uint8Array, source = 'addon'): Promise<Addon> {
    const addon = await readAddon(bytes, source);
    this.loadAddon(addon);
    return addon;
  }

  /** A player standing on the flat world (or at `at`), with items in its hotbar. */
  addPlayer(name = 'Child', at: Vec3 = { x: 0.5, y: FLAT_GROUND_Y, z: 0.5 }, items: string[] = []): SimEntity {
    const p = this.engine.addPlayer(name, 'overworld', at);
    const st = this.host.playerState(p);
    items.forEach((id, i) => { st.items[i] = id; });
    this.engine.emit('entitySpawn', { entity: p });
    return p;
  }

  /** Advance `n` ticks. */
  run(n: number): Promise<void> { return this.engine.run(n); }

  /** Advance `n` ticks without awaiting script promises (`SimEngine.stepSync`: synchronous runtimes only). */
  runSync(n: number): void { this.engine.runSync(n); }

  /**
   * Reopen the world: every script is loaded again from its first line into a
   * fresh context (no subscriptions, no timers, no module state) over the SAME
   * world - blocks, entities, dynamic properties - as a world reload or a
   * `/reload` leaves it (`ScriptHost.reloadScripts`).
   */
  reloadScripts(): void { this.host.reloadScripts(this.addons); }

  /** The item ids of every wand-like item the loaded packs define (`items/*.json`). */
  itemIds(): string[] {
    const out: string[] = [];
    for (const a of this.addons) for (const p of a.packs) for (const [path, data] of p.files) {
      if (!/^items\/.*\.json$/.test(path)) continue;
      try { const id = (JSON.parse(new TextDecoder().decode(data)) as { 'minecraft:item'?: { description?: { identifier?: string } } })['minecraft:item']?.description?.identifier; if (id) out.push(id); } catch { /* not an item file */ }
    }
    return out;
  }
}
