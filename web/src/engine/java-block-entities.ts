import type { BlockEntity } from '@craft/types/index.js';
import { ByteWriter } from './byte-writer.js';

/** Java 1.20.4 block-entity records for Sponge v2 and Litematica. */
export function writeJavaBlockEntity(w: ByteWriter, entity: BlockEntity, sponge: boolean): void {
  const enc = new TextEncoder();
  const tag = (type: number, name: string) => { w.u8(type); w.nbtString(name, enc); };
  const str = (name: string, value: string) => { tag(8, name); w.nbtString(value, enc); };
  const num = (name: string, value: number) => { tag(3, name); w.u32(value); };
  const id = entity.type === 'sign' ? 'minecraft:sign' : entity.type === 'chest' ? 'minecraft:chest' : entity.id;
  str(sponge ? 'Id' : 'id', id);
  if (sponge) { tag(11, 'Pos'); w.u32(3); for (const n of entity.pos) w.u32(n); }
  else { num('x', entity.pos[0]); num('y', entity.pos[1]); num('z', entity.pos[2]); }
  if (entity.items) {
    tag(9, 'Items'); w.u8(10); w.u32(entity.items.length);
    for (const item of entity.items) {
      tag(1, 'Slot'); w.u8(item.slot); str('id', item.id); tag(1, 'Count'); w.u8(item.count); w.u8(0);
    }
  }
  if (entity.text) {
    tag(10, 'front_text'); str('color', 'black'); tag(1, 'has_glowing_text'); w.u8(0);
    tag(9, 'messages'); w.u8(8); w.u32(4);
    for (let i = 0; i < 4; i++) w.nbtString(JSON.stringify({ text: entity.text[i] ?? '' }), enc);
    w.u8(0);
  }
  w.u8(0);
}
