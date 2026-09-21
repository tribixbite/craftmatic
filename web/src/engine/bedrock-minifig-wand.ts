/** Dependency-free Bedrock creator runtime, serialized into the behavior pack. */
import type { MinifigCreatorConfig } from './minifig-creator-types.js';

/** Keep every runtime dependency explicit: this function is emitted with toString(). */
function minifigWandRuntime(
  C: any,
  world: any,
  system: any,
  ActionFormData: any,
  ModalFormData: any,
  FormCancelationReason: any,
): void {
  const state = new Map<string, { draft?: string; showing?: boolean; editing?: boolean }>();
  const held = new Set<string>();
  const savedKey = `craftmatic:${C.id}:saved`;
  const slots = C.library.minifig;
  const slotNames = ['head', 'hair', 'torso', 'arms', 'hands', 'hips', 'legs', 'held_right', 'held_left', 'back'];
  const slotKeys: Record<string, string> = { head: 'he', hair: 'ha', torso: 'to', arms: 'ar', hands: 'hd', hips: 'hi', legs: 'le', held_right: 'hr', held_left: 'hl', back: 'bk' };
  const keySlots = Object.fromEntries(Object.entries(slotKeys).map(([name, key]) => [key, name]));
  const title = (screen: string) => `${C.label} · Minifig · ${screen}`;
  const playerState = (p: any) => {
    let value = state.get(p.id);
    if (!value) { value = {}; state.set(p.id, value); }
    return value;
  };
  const tell = (p: any, message: unknown) => { try { p.sendMessage(String(message)); } catch {} };
  const entity = (id?: string) => {
    if (!id) return undefined;
    try { return world.getEntity(id); } catch { return undefined; }
  };
  const removeDraft = (playerId: string) => {
    const st = state.get(playerId);
    try { entity(st?.draft)?.remove(); } catch {}
    if (st) { st.draft = undefined; st.editing = false; }
  };
  const finishEditing = (playerId: string) => {
    const st = state.get(playerId);
    if (!st?.editing) return;
    const edited = entity(st.draft);
    try {
      edited?.setProperty('craftmatic:draft', false);
      edited?.setDynamicProperty('craftmatic:editing_placed', undefined);
      edited?.triggerEvent('craftmatic:release');
    } catch {}
    st.draft = undefined;
    st.editing = false;
  };
  const spawnDraft = (p: any) => {
    const st = playerState(p);
    const existing = entity(st.draft);
    if (existing) return existing;
    const draft = p.dimension.spawnEntity(C.figureType, p.location);
    draft.setProperty('craftmatic:draft', true);
    draft.setDynamicProperty('craftmatic:owner', p.id);
    for (const [name, value] of Object.entries(C.defaults.minifig)) draft.setProperty(name, value);
    st.draft = draft.id;
    return draft;
  };
  const snapshot = (e: any) => slotNames.map((name) => [
    name,
    e.getProperty(`craftmatic:${name}`),
    e.getProperty(`craftmatic:c_${name}`),
  ]);
  const figureCode = (e: any, name = e.nameTag || 'Custom Minifig') => {
    const fields = ['mf1', 'm'];
    for (const slot of slotNames) {
      const partIndex = Number(e.getProperty(`craftmatic:${slot}`) || 0);
      const colourIndex = Number(e.getProperty(`craftmatic:c_${slot}`) || 0);
      const part = slots[slot]?.[partIndex]?.[0] || '';
      // Codes are portable LDraw data, never Bedrock property indices.
      const colourId = C.colours[colourIndex]?.[0];
      if (colourId === undefined) throw new Error(`Colour index ${colourIndex} is not in this pack library.`);
      fields.push(`${slotKeys[slot]}=${part}:${colourId}`);
    }
    fields.push(`n=${String(name).slice(0, 24)}`);
    return fields.join('|');
  };
  const decodeCode = (code: string) => {
    const fields = String(code).split('|');
    if (fields[0] !== 'mf1' || fields[1] !== 'm') throw new Error('That is not a minifig figure code.');
    const values: Array<[string, number, number]> = [];
    const seen = new Set<string>();
    let name: string | undefined;
    for (const field of fields.slice(2)) {
      const equals = field.indexOf('=');
      if (equals < 1) throw new Error('That figure code contains a malformed field.');
      const short = field.slice(0, equals);
      const value = field.slice(equals + 1);
      if (short === 'n') {
        if (name !== undefined || !value.trim() || value.length > 24 || /[\r\n|]/.test(value)) throw new Error('Figure name is missing, duplicated, or invalid.');
        name = value;
        continue;
      }
      const slot = keySlots[short];
      if (!slot || seen.has(slot)) throw new Error(`Unknown or duplicate figure field ${short}.`);
      seen.add(slot);
      const colon = value.lastIndexOf(':');
      if (colon < 0) throw new Error(`Missing colour for ${slot}.`);
      const part = value.slice(0, colon);
      const colourId = Number(value.slice(colon + 1));
      if ((part && !/^[A-Za-z0-9_-]+$/.test(part)) || !/^\d+$/.test(value.slice(colon + 1))) throw new Error(`Invalid ${slot} field.`);
      const partIndex = (slots[slot] || []).findIndex((entry: any[]) => entry[0] === part);
      const colourIndex = C.colours.findIndex((entry: any[]) => entry[0] === colourId);
      if (partIndex < 0) throw new Error(`${part || '(none)'} is not in this pack library.`);
      if (colourIndex < 0) throw new Error(`Colour ${colourId} is not in this pack library.`);
      values.push([slot, partIndex, colourIndex]);
    }
    if (name === undefined) throw new Error('Figure code has no name.');
    return { name, values };
  };
  const applyCode = (e: any, code: string) => {
    // Decode the entire input before touching the entity: invalid imports are atomic.
    const decoded = decodeCode(code);
    for (const [slot, partIndex, colourIndex] of decoded.values) {
      e.setProperty(`craftmatic:${slot}`, partIndex);
      e.setProperty(`craftmatic:c_${slot}`, colourIndex);
    }
    e.nameTag = decoded.name;
  };
  const show = async (p: any, form: any) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await form.show(p);
      if (!response.canceled || response.cancelationReason !== FormCancelationReason.UserBusy) return response;
      if (attempt < 3) await new Promise<void>((resolve) => system.runTimeout(resolve, 10));
    }
    tell(p, 'Close the chat/other screen and open the wand again.');
    return { canceled: true };
  };
  const worldCount = () => {
    let count = 0;
    const editingIds = new Set([...state.values()].filter((st) => st.editing && st.draft).map((st) => st.draft));
    for (const id of ['overworld', 'nether', 'the_end']) {
      try { count += [...world.getDimension(id).getEntities({ type: C.figureType })].filter((e: any) => !e.getProperty('craftmatic:draft') || editingIds.has(e.id)).length; } catch {}
    }
    return count;
  };
  const aimTarget = (p: any) => {
    let hit: any;
    try { hit = p.getBlockFromViewDirection?.({ maxDistance: 96, includeLiquidBlocks: false, includePassableBlocks: false }); } catch { return undefined; }
    const b = hit?.block?.location;
    if (!b) return undefined;
    const face = String(hit.face || 'Up');
    const dx = face === 'East' ? 1 : face === 'West' ? -1 : 0;
    const dy = face === 'Up' ? 1 : face === 'Down' ? -1 : 0;
    const dz = face === 'South' ? 1 : face === 'North' ? -1 : 0;
    return { x: b.x + dx + 0.5, y: b.y + dy, z: b.z + dz + 0.5 };
  };
  const place = (p: any, copy: boolean, at?: any) => {
    if (worldCount() >= C.worldCap) { tell(p, `Figure cap reached (${C.worldCap}).`); return false; }
    const draft = spawnDraft(p);
    let placed = draft;
    if (copy) {
      placed = p.dimension.spawnEntity(C.figureType, at || draft.location);
      for (const [slot, partIndex, colourIndex] of snapshot(draft)) {
        placed.setProperty(`craftmatic:${slot}`, partIndex);
        placed.setProperty(`craftmatic:c_${slot}`, colourIndex);
      }
      placed.setProperty('craftmatic:family', draft.getProperty('craftmatic:family') || 0);
      placed.nameTag = draft.nameTag;
    } else {
      if (at) {
        try { placed.teleport(at); } catch { placed = draft; }
      }
      playerState(p).draft = undefined;
    }
    placed.setDynamicProperty('craftmatic:owner', p.id);
    placed.setProperty('craftmatic:draft', false);
    placed.setDynamicProperty('craftmatic:editing_placed', undefined);
    placed.triggerEvent('craftmatic:release');
    tell(p, 'Figure placed.');
    return true;
  };
  async function chooseSlot(p: any, slot: string, page = 0): Promise<void> {
    const draft = spawnDraft(p);
    const list = slots[slot] || [];
    const size = Math.max(1, Number(C.pageSize) || 8);
    const pages = Math.max(1, Math.ceil(list.length / size));
    page = Math.max(0, Math.min(page, pages - 1));
    const start = page * size;
    const shown = list.slice(start, start + size);
    const form = new ActionFormData().title(title(slot)).body(`Choose a compiled part or change its colour. Page ${page + 1}/${pages}.`);
    for (const entry of shown) form.button(entry[1]);
    if (page + 1 < pages) form.button('Next page ›');
    if (page > 0) form.button('‹ Previous page');
    form.button('Change colour').button('Back');
    const response = await show(p, form);
    if (response.canceled || response.selection === undefined) return menuCore(p);
    let cursor = shown.length;
    if (response.selection < cursor) { draft.setProperty(`craftmatic:${slot}`, start + response.selection); return menuCore(p); }
    if (page + 1 < pages && response.selection === cursor++) return chooseSlot(p, slot, page + 1);
    if (page > 0 && response.selection === cursor++) return chooseSlot(p, slot, page - 1);
    if (response.selection === cursor) return chooseColour(p, slot);
    return menuCore(p);
  }
  async function chooseColour(p: any, slot: string, page = 0): Promise<void> {
    const draft = spawnDraft(p);
    const size = 12;
    const pages = Math.max(1, Math.ceil(C.colours.length / size));
    page = Math.max(0, Math.min(page, pages - 1));
    const start = page * size;
    const shown = C.colours.slice(start, start + size);
    const form = new ActionFormData().title(title(`${slot} colour`)).body(`Choose colour. Page ${page + 1}/${pages}.`);
    for (const entry of shown) form.button(entry[1]);
    if (page + 1 < pages) form.button('Next page ›');
    if (page > 0) form.button('‹ Previous page');
    form.button('Back');
    const response = await show(p, form);
    if (response.canceled || response.selection === undefined) return menuCore(p);
    let cursor = shown.length;
    if (response.selection < cursor) { draft.setProperty(`craftmatic:c_${slot}`, start + response.selection); return menuCore(p); }
    if (page + 1 < pages && response.selection === cursor++) return chooseColour(p, slot, page + 1);
    if (page > 0 && response.selection === cursor) return chooseColour(p, slot, page - 1);
    return menuCore(p);
  }
  async function identity(p: any): Promise<void> {
    const draft = spawnDraft(p);
    const response = await show(p, new ModalFormData().title(title('Name and figure code'))
      .textField('Name', 'Shown above the figure', { defaultValue: draft.nameTag || 'Custom Minifig' })
      .textField('Figure code', 'mf1|m|…', { defaultValue: figureCode(draft) }).submitButton('Apply'));
    if (response.canceled) return menuCore(p);
    const name = String(response.formValues?.[0] || '').trim();
    if (!name || name.length > 24 || /[\r\n|]/.test(name)) { tell(p, 'Name must be 1–24 characters without | or line breaks.'); return identity(p); }
    try {
      const decoded = decodeCode(String(response.formValues?.[1] || ''));
      decoded.name = name;
      for (const [slot, partIndex, colourIndex] of decoded.values) {
        draft.setProperty(`craftmatic:${slot}`, partIndex);
        draft.setProperty(`craftmatic:c_${slot}`, colourIndex);
      }
      draft.nameTag = decoded.name;
    } catch (error) { tell(p, error); return identity(p); }
    return menuCore(p);
  }
  const readSaved = (p: any) => {
    try {
      const raw = String(p.getDynamicProperty(savedKey) || '[]');
      const value = JSON.parse(raw);
      if (!Array.isArray(value)) throw new Error('not an array');
      return value.filter((saved: any) => saved && typeof saved.n === 'string' && typeof saved.c === 'string').slice(0, C.savedCap);
    } catch { tell(p, 'Saved figure data was corrupt; it was ignored.'); return []; }
  };
  const writeSaved = (p: any, all: any[]) => {
    const encoded = JSON.stringify(all);
    if (encoded.length > 32767) { tell(p, 'Saved figure storage is full — delete one.'); return false; }
    try { p.setDynamicProperty(savedKey, encoded); return true; }
    catch { tell(p, 'Saved figure storage could not be updated.'); return false; }
  };
  async function savedFigures(p: any): Promise<void> {
    const draft = spawnDraft(p);
    const all = readSaved(p);
    const form = new ActionFormData().title(title('My figures')).body(`Saved figures: ${all.length}/${C.savedCap}`)
      .button('Save draft').button('Load saved figure').button('Show code in chat').button('Delete saved figure').button('Back');
    const response = await show(p, form);
    if (response.canceled || response.selection === 4 || response.selection === undefined) return menuCore(p);
    if (response.selection === 2) { tell(p, figureCode(draft)); return savedFigures(p); }
    if (response.selection === 0) {
      if (all.length >= C.savedCap) { tell(p, 'Library full — delete one.'); return savedFigures(p); }
      const answer = await show(p, new ModalFormData().title(title('Save')).textField('Name', 'Figure name', { defaultValue: draft.nameTag || 'Custom Minifig' }).submitButton('Save'));
      if (!answer.canceled) {
        const name = String(answer.formValues?.[0] || '').trim().slice(0, 24);
        if (!name || /[\r\n|]/.test(name)) tell(p, 'Name must be 1–24 characters without | or line breaks.');
        else {
          draft.nameTag = name;
          all.push({ n: name, c: figureCode(draft, name) });
          if (!writeSaved(p, all)) all.pop();
        }
      }
      return menuCore(p);
    }
    const choosingDelete = response.selection === 3;
    const chooser = new ActionFormData().title(title(choosingDelete ? 'Delete' : 'Load saved figure')).body('Choose a saved figure.');
    for (const saved of all) chooser.button(saved.n);
    chooser.button('Back');
    const choice = await show(p, chooser);
    if (!choice.canceled && choice.selection !== undefined && choice.selection < all.length) {
      if (choosingDelete) { all.splice(choice.selection, 1); writeSaved(p, all); }
      else { try { applyCode(draft, all[choice.selection].c); } catch (error) { tell(p, error); } }
    }
    return savedFigures(p);
  }
  async function placeMenu(p: any): Promise<void> {
    const form = new ActionFormData().title(title('Place')).body(`Figures placed: ${worldCount()} of ${C.worldCap}`)
      .button('Place where the draft stands').button('Place at the block I look at').button('Place and keep this draft').button('Back');
    const response = await show(p, form);
    if (response.canceled || response.selection === 3 || response.selection === undefined) return menuCore(p);
    if (response.selection === 0) { place(p, false); return; }
    if (response.selection === 1) {
      const target = aimTarget(p);
      if (!target) { tell(p, 'Look at a block within 96 blocks.'); return placeMenu(p); }
      place(p, false, target);
      return;
    }
    place(p, true);
    return menuCore(p);
  }
  async function menuCore(p: any): Promise<void> {
    const draft = spawnDraft(p);
    const form = new ActionFormData().title(title('Creator')).body(`${draft.nameTag || 'Custom Minifig'} · draft preview`);
    for (const slot of slotNames) form.button(slot);
    form.button('Name / figure code…').button('Place…').button('My figures…').button('Discard draft').button('Close');
    const response = await show(p, form);
    if (response.canceled || response.selection === undefined || response.selection === 14) return;
    if (response.selection < slotNames.length) return chooseSlot(p, slotNames[response.selection]);
    if (response.selection === 10) return identity(p);
    if (response.selection === 11) return placeMenu(p);
    if (response.selection === 12) return savedFigures(p);
    if (response.selection === 13) { removeDraft(p.id); return; }
  }
  const open = async (p: any) => {
    const st = playerState(p);
    if (st.showing) return;
    st.showing = true;
    try { await menuCore(p); } catch (error) { tell(p, error); }
    finally { finishEditing(p.id); st.showing = false; }
  };
  const quickPlace = (p: any) => {
    const st = playerState(p);
    if (st.showing) return;
    if (!entity(st.draft)) { system.run(() => open(p)); return; }
    const target = aimTarget(p);
    if (!target) { tell(p, 'Look at a block within 96 blocks.'); return; }
    place(p, true, target);
  };

  world.afterEvents.itemUse.subscribe((ev: any) => {
    if (ev.itemStack.typeId !== C.itemId) return;
    if (ev.source.isSneaking) system.run(() => quickPlace(ev.source));
    else system.run(() => open(ev.source));
  });
  world.beforeEvents.playerInteractWithEntity.subscribe((ev: any) => {
    if (ev.itemStack?.typeId !== C.itemId) return;
    ev.cancel = true;
    system.run(() => {
      if (ev.target.typeId !== C.figureType) { open(ev.player); return; }
      const owner = ev.target.getDynamicProperty('craftmatic:owner');
      if (owner && owner !== ev.player.id) { tell(ev.player, 'Only the figure owner can edit this figure.'); return; }
      const st = playerState(ev.player);
      if (st.showing) { tell(ev.player, 'Close the current wand screen before editing another figure.'); return; }
      removeDraft(ev.player.id);
      st.draft = ev.target.id;
      st.editing = true;
      ev.target.setDynamicProperty('craftmatic:owner', ev.player.id);
      // Persist this distinction before setting draft: a script/world reload
      // must restore an existing NPC, not mistake it for a disposable preview.
      ev.target.setDynamicProperty('craftmatic:editing_placed', true);
      ev.target.setProperty('craftmatic:draft', true);
      ev.target.triggerEvent('craftmatic:npc_off');
      open(ev.player);
    });
  });
  world.afterEvents.playerLeave.subscribe((ev: any) => {
    if (state.get(ev.playerId)?.editing) finishEditing(ev.playerId); else removeDraft(ev.playerId);
    state.delete(ev.playerId); held.delete(ev.playerId);
  });
  // Sweep leaked drafts after script reload; placed figures are preserved.
  system.run(() => {
    for (const id of ['overworld', 'nether', 'the_end']) {
      try {
        for (const e of world.getDimension(id).getEntities({ type: C.figureType })) {
          if (!e.getProperty('craftmatic:draft')) continue;
          if (e.getDynamicProperty('craftmatic:editing_placed')) {
            e.setProperty('craftmatic:draft', false);
            e.setDynamicProperty('craftmatic:editing_placed', undefined);
            e.triggerEvent('craftmatic:release');
          } else e.remove();
        }
      } catch {}
    }
  });
  system.runInterval(() => {
    const online = new Set<string>();
    for (const p of world.getAllPlayers()) {
      online.add(p.id);
      let item: any;
      try { item = p.getComponent('minecraft:inventory')?.container?.getItem(p.selectedSlotIndex); } catch {}
      if (item?.typeId === C.itemId) {
        if (!held.has(p.id)) { held.add(p.id); system.run(() => open(p)); }
      } else held.delete(p.id);
    }
    for (const id of held) if (!online.has(id)) held.delete(id);
  }, 5);
}

/** Serialize the creator's interactive draft/place/save/edit runtime. */
export function minifigWandScript(config: MinifigCreatorConfig): string {
  return `import { world, system } from "@minecraft/server";\nimport { ActionFormData, ModalFormData, FormCancelationReason } from "@minecraft/server-ui";\nconst C=${JSON.stringify(config)};\n(${minifigWandRuntime.toString()})(C,world,system,ActionFormData,ModalFormData,FormCancelationReason);`;
}
