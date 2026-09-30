/**
 * `@minecraft/server-ui`: the forms, answered by a SCRIPTED CHOOSER instead of
 * a thumb. Every form shown is a `form` line on the timeline (its title, body
 * and buttons as the form renderer draws them - quirk
 * `form-deletes-percent`); the scenario's chooser picks a button by label,
 * fills a modal, or cancels.
 */

import type { Timeline } from '../core/timeline.js';
import { SERVER_UI_EXPORTS } from './api-catalog.js';
import { guard, unmodelledExport } from './unmodelled.js';
import { formRendered, messageText, plainText } from './text.js';

/** A form as the player sees it. */
export interface ShownForm {
  kind: 'action' | 'modal' | 'message';
  title: string;
  body: string;
  /** Action/message buttons; for a modal, its controls' labels. */
  buttons: string[];
  /** Action-form button icons (texture paths), by button; undefined where a button has none. */
  icons?: Array<string | undefined>;
  /** The player it was shown to (engine id). */
  player: string;
  tick: number;
}

/** A chooser's answer: a button by index or label prefix, modal values, or cancel. */
export type FormAnswer = { cancel: true; reason?: 'UserBusy' | 'UserClosed' } | { button: number | string } | { values: unknown[] };

/** Decides every form: return an answer (or a promise of one, to answer later). */
export type FormChooser = (form: ShownForm) => FormAnswer | Promise<FormAnswer>;

/** Build the `@minecraft/server-ui` module object for a host. */
export function createUiModule(timeline: Timeline, choose: () => FormChooser, playerId: (p: unknown) => string, tick: () => number): Record<string, unknown> {
  const record = (f: ShownForm): void => {
    const drawn = (s: string): string => formRendered(plainText(s));
    const lost = [f.title, f.body, ...f.buttons].some(s => s.includes('%'));
    const src = timeline.callerSource();
    timeline.add('form', `${drawn(f.title)} | ${f.buttons.map(drawn).join(' / ')}${lost ? '  [a bare % was deleted by the form renderer]' : ''}`, { ...(src ? { source: src } : {}), target: f.player });
  };
  const answer = async (form: ShownForm, kind: ShownForm['kind']): Promise<Record<string, unknown>> => {
    record(form);
    const a = await choose()(form);
    if ('cancel' in a) return { canceled: true, cancelationReason: a.reason ?? 'UserClosed' };
    if ('values' in a) return { canceled: false, formValues: a.values };
    let i = typeof a.button === 'number' ? a.button : form.buttons.findIndex(b => plainText(b).startsWith(String(a.button)));
    if (i < 0) { timeline.add('note', `form chooser: no button "${String(a.button)}" in [${form.buttons.join(' | ')}]; cancelled`); return { canceled: true, cancelationReason: 'UserClosed' }; }
    if (kind === 'message') i = Math.min(1, i);
    return { canceled: false, selection: i };
  };
  class ActionFormData {
    private t = ''; private b = ''; private readonly buttons: string[] = []; private readonly icons: Array<string | undefined> = [];
    constructor() { return guard(this, 'ActionFormData', timeline); }
    title(s: unknown) { this.t = messageText(s); return this; }
    body(s: unknown) { this.b = messageText(s); return this; }
    button(s: unknown, icon?: string) { this.buttons.push(messageText(s)); this.icons.push(icon); return this; }
    divider() { return this; }
    header(s: unknown) { this.b += `\n${messageText(s)}`; return this; }
    label(s: unknown) { this.b += `\n${messageText(s)}`; return this; }
    show(p: unknown) { return answer({ kind: 'action', title: this.t, body: this.b, buttons: [...this.buttons], icons: [...this.icons], player: playerId(p), tick: tick() }, 'action'); }
  }
  class ModalFormData {
    private t = ''; private readonly controls: string[] = [];
    constructor() { return guard(this, 'ModalFormData', timeline); }
    title(s: unknown) { this.t = messageText(s); return this; }
    textField(label: unknown) { this.controls.push(messageText(label)); return this; }
    slider(label: unknown) { this.controls.push(messageText(label)); return this; }
    dropdown(label: unknown) { this.controls.push(messageText(label)); return this; }
    toggle(label: unknown) { this.controls.push(messageText(label)); return this; }
    submitButton() { return this; }
    divider() { return this; }
    header() { return this; }
    label() { return this; }
    show(p: unknown) { return answer({ kind: 'modal', title: this.t, body: '', buttons: [...this.controls], player: playerId(p), tick: tick() }, 'modal'); }
  }
  class MessageFormData {
    private t = ''; private b = ''; private b1 = ''; private b2 = '';
    constructor() { return guard(this, 'MessageFormData', timeline); }
    title(s: unknown) { this.t = messageText(s); return this; }
    body(s: unknown) { this.b = messageText(s); return this; }
    button1(s: unknown) { this.b1 = messageText(s); return this; }
    button2(s: unknown) { this.b2 = messageText(s); return this; }
    show(p: unknown) { return answer({ kind: 'message', title: this.t, body: this.b, buttons: [this.b1, this.b2], player: playerId(p), tick: tick() }, 'message'); }
  }
  const implemented: Record<string, unknown> = {
    ActionFormData, ModalFormData, MessageFormData,
    FormCancelationReason: { UserBusy: 'UserBusy', UserClosed: 'UserClosed' },
    FormResponse: class FormResponse {},
  };
  return new Proxy(implemented, {
    get(t, prop) {
      if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop);
      if (SERVER_UI_EXPORTS.includes(prop)) return unmodelledExport(`@minecraft/server-ui.${prop}`, timeline);
      return undefined;
    },
  });
}
