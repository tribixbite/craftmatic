/**
 * DEVICE-SCRIPT REPLAY: an adb round's own tool scripts, interpreted line by
 * line and played on the simulator through a model of the phone's touch
 * screen, so a round's EXACT finger sequence runs offline first.
 *
 * Two parts:
 *
 *   1. `runDeviceScript` - a small interpreter of the bash the round tools are
 *      written in (`tools/cmd.sh`, `tap.sh`, `walk.sh`, `lane.sh`,
 *      `scripts/_pixel_cmd.sh`): comments, `set`, `export`, `source`,
 *      variables with the expansions those scripts use (`${1:-}`, `${1:?msg}`,
 *      `${2:--150}`, `${v,,}`, `${v// /%s}`, `${v#/}`, `$((...))`), `$(...)`
 *      for the few commands they substitute (`dirname`, `adb shell getprop`,
 *      `remote_quote`, `date`), functions, `if`/`else`/`fi` with `[[ ]]`,
 *      `$flag` and the `dumpsys input_method | grep -q mInputShown` test,
 *      `shift`, `sleep`, `bash <tool> args` (recursion) and `adb shell ...`.
 *      Anything else THROWS (`DeviceScriptError`): a replay that guessed would
 *      be worse than none. Host-only commands (screenshots, recordings,
 *      `magick`, `mkdir`) are recorded as ignored.
 *   2. `PhoneScreen` - what the phone does with each `input` command: the
 *      chat button opens the chat, the chat takes every touch while open,
 *      Enter runs the typed command and closes it (quirk `chat-enter-closes`),
 *      a press inside the joystick holds the move stick, and any other touch
 *      reaches the WORLD: a short press is a screen tap (`screen.ts`
 *      `tapScreen`, quirk `touch-screen-pick`), a press held past the hold
 *      time an interact (quirk `hold-is-interact`), a moved finger a drag
 *      (`drag.ts`, quirk `touch-drag-degrees-per-pixel`).
 *
 * The timing is the scripts' own `sleep`s and swipe durations at 20 ticks a
 * second; adb's own latency between commands is ASSUMED to be zero.
 */

import { quirkValue } from '../quirks/registry.js';

/** A replay that met something it cannot interpret faithfully. */
export class DeviceScriptError extends Error { override name = 'DeviceScriptError'; }

/** What a replayed finger did and what it reached, for the report. */
export interface ReplayEvent {
  tick: number;
  /** The raw device command (`input swipe 45 39 45 39 90`) or a host step. */
  command: string;
  /** Where the touch went: `chat` (the chat screen took it), `chat-button`, `stick`, `world-tap`, `world-hold`, `world-drag`, `key`, `text`, `command` (a chat command ran), `ignored`. */
  route: string;
  /** What it reached: a picked entity, the command run, a block, nothing. */
  detail?: string;
}

/** The phone's touch layout, raw landscape pixels (each from the round tool that taps it). */
export interface PhoneLayout {
  /** The chat button (`_pixel_cmd.sh`: `tap "$chat_x" 39`, 1120 on the Pixel, 1195 on the Saga). */
  chatButton: { x: number; y: number; r: number };
  /** The chat screen's Exit corner (`_pixel_cmd.sh`: `tap 45 39`). */
  chatExit: { x: number; y: number; r: number };
  /** The move stick's centre and its full deflection (`walk.sh`: centre 337,554, full forward at dy -150). */
  stick: { x: number; y: number; full: number; r: number };
  /** The model string `adb shell getprop ro.product.model` answers. */
  model: string;
}

/** The Pixel 8 Pro's layout as the round tools tap it. */
export const PIXEL_LAYOUT: PhoneLayout = { chatButton: { x: 1120, y: 39, r: 60 }, chatExit: { x: 45, y: 39, r: 60 }, stick: { x: 337, y: 554, full: 150, r: 220 }, model: 'Pixel 8 Pro' };

/** What the screen model drives: the simulation, through these hooks (input-probe.ts wires them to a scenario). */
export interface PhoneIO {
  /** Advance the world `n` ticks (the caller runs its invariants and watches for effects). */
  advance(n: number): Promise<void>;
  /** A short press on the world at a raw screen point: a tap. Returns what it picked. */
  worldTap(x: number, y: number): string;
  /** A press held on the world past the hold time: an interact. Returns what it picked. */
  worldHold(x: number, y: number): string;
  /** A finger moved over the world by (dx, dy) raw pixels this tick: a drag. */
  worldDrag(dx: number, dy: number): void;
  /** The move stick deflected (forward, strafe in -1..1; zeros release it). */
  stick(forward: number, strafe: number): void;
  /** Run a chat command as the player (the coordinates already as the device typed them). Returns its result line. */
  chatCommand(line: string): string;
  /** Record a replay event. */
  log(e: Omit<ReplayEvent, 'tick'>): void;
}

const TICKS_PER_SECOND = 20;
const ticksOf = (seconds: number): number => Math.max(0, Math.round(seconds * TICKS_PER_SECOND));
const near = (x: number, y: number, c: { x: number; y: number; r: number }): boolean => Math.hypot(x - c.x, y - c.y) <= c.r;
/** A finger that moved less than this (raw pixels) did not drag (Android's touch slop is ~8 dp; ASSUMED 20 px here). */
const TOUCH_SLOP_PX = 20;

/**
 * The phone's screen: the chat state, the pointer and the keys. Every `input` command of a replay comes here
 * (`input tap|swipe|motionevent|keyevent|keycombination|text`).
 */
export class PhoneScreen {
  chatOpen = false;
  chatText = '';
  private selectAll = false;
  /** The finger that is down: where it went down, where it is, what it is doing, for how many ticks. */
  private pointer: { x0: number; y0: number; x: number; y: number; on: 'chat' | 'chat-button' | 'chat-exit' | 'stick' | 'world'; ticks: number; held: boolean; dragged: boolean } | undefined;

  constructor(readonly layout: PhoneLayout, readonly io: PhoneIO) {}

  /** Advance time with the finger (if any) held where it is. */
  async hold(ticks: number): Promise<void> {
    const holdTicks = quirkValue('hold-is-interact', 'holdTicks');
    for (let t = 0; t < ticks; t++) {
      await this.io.advance(1);
      const p = this.pointer;
      if (!p) continue;
      p.ticks++;
      if (p.on === 'world' && !p.dragged && !p.held && p.ticks >= holdTicks) {
        p.held = true;
        this.io.log({ command: `hold ${Math.round(p.x)},${Math.round(p.y)}`, route: 'world-hold', detail: this.io.worldHold(p.x, p.y) });
      }
    }
  }

  private down(x: number, y: number): void {
    const L = this.layout;
    const on = this.chatOpen ? (near(x, y, L.chatExit) ? 'chat-exit' : 'chat') : near(x, y, L.chatButton) ? 'chat-button' : near(x, y, L.stick) ? 'stick' : 'world';
    this.pointer = { x0: x, y0: y, x, y, on, ticks: 0, held: false, dragged: false };
    if (on === 'stick') this.moveStick(x, y);
  }

  private moveStick(x: number, y: number): void {
    const L = this.layout.stick, clamp = (v: number): number => Math.max(-1, Math.min(1, v));
    // Screen up is forward; screen left is +strafe (controls.ts: +strafe is to the player's left).
    this.io.stick(clamp(-(y - L.y) / L.full), clamp(-(x - L.x) / L.full));
  }

  private move(x: number, y: number): void {
    const p = this.pointer;
    if (!p) throw new DeviceScriptError('motionevent MOVE with no finger down');
    if (p.on === 'stick') this.moveStick(x, y);
    else if (p.on === 'world') {
      if (!p.dragged && Math.hypot(x - p.x0, y - p.y0) > TOUCH_SLOP_PX) p.dragged = true;
      if (p.dragged) this.io.worldDrag(x - p.x, y - p.y);
    }
    p.x = x; p.y = y;
  }

  private up(command: string): void {
    const p = this.pointer;
    if (!p) throw new DeviceScriptError('motionevent UP with no finger down');
    this.pointer = undefined;
    if (p.on === 'stick') { this.io.stick(0, 0); this.io.log({ command, route: 'stick' }); return; }
    if (p.on === 'chat-button') { this.chatOpen = true; this.io.log({ command, route: 'chat-button', detail: 'chat opened' }); return; }
    if (p.on === 'chat-exit') { this.chatOpen = false; this.io.log({ command, route: 'chat', detail: 'Exit: chat closed' }); return; }
    if (p.on === 'chat') { this.io.log({ command, route: 'chat', detail: 'taken by the chat screen' }); return; }
    if (p.dragged) { this.io.log({ command, route: 'world-drag', detail: `${Math.round(p.x - p.x0)},${Math.round(p.y - p.y0)} px` }); return; }
    if (p.held) return;
    this.io.log({ command, route: 'world-tap', detail: this.io.worldTap(p.x, p.y) });
  }

  /** One on-device `input ...` command (inside `adb shell`). */
  async input(args: string[], command: string): Promise<void> {
    const [verb, ...rest] = args;
    const n = rest.map(Number);
    switch (verb) {
      case 'tap': this.down(n[0]!, n[1]!); await this.hold(1); this.up(command); return;
      case 'swipe': {
        const [x0, y0, x1, y1] = n as [number, number, number, number];
        const ticks = Math.max(1, Math.ceil((n[4] ?? 300) / 50));
        this.down(x0, y0);
        for (let t = 1; t <= ticks; t++) {
          if (x1 !== x0 || y1 !== y0) this.move(x0 + (x1 - x0) * t / ticks, y0 + (y1 - y0) * t / ticks);
          await this.hold(1);
        }
        this.up(command);
        return;
      }
      case 'motionevent': {
        const kind = rest[0], x = Number(rest[1]), y = Number(rest[2]);
        if (kind === 'DOWN') this.down(x, y); else if (kind === 'MOVE') this.move(x, y); else if (kind === 'UP') { this.move(x, y); this.up(command); }
        else throw new DeviceScriptError(`input motionevent ${kind}`);
        return;
      }
      case 'keyevent': {
        for (const code of n) {
          if (code === 66) {
            // Enter: the chat runs the typed line and closes (quirk `chat-enter-closes`).
            if (this.chatOpen && this.chatText) this.io.log({ command: `keyevent 66 "${this.chatText}"`, route: 'command', detail: this.io.chatCommand(this.chatText) });
            else this.io.log({ command: 'keyevent 66', route: 'key', detail: this.chatOpen ? 'Enter on an empty chat' : 'Enter with the chat closed: nothing' });
            this.chatText = ''; this.chatOpen = false;
          } else if (code === 67) { this.chatText = this.selectAll ? '' : this.chatText.slice(0, -1); this.selectAll = false; }
          else if (code === 123) this.selectAll = false;
          else if (code === 76) this.chatText += '/';
          else throw new DeviceScriptError(`input keyevent ${code}`);
        }
        return;
      }
      case 'keycombination':
        // 113 29 = Ctrl+A: select the field's text (the next backspace clears it).
        if (n[0] === 113 && n[1] === 29) { this.selectAll = true; return; }
        throw new DeviceScriptError(`input keycombination ${rest.join(' ')}`);
      case 'text': {
        const t = rest.join(' ').replace(/%s/g, ' ');
        if (!this.chatOpen) { this.io.log({ command, route: 'ignored', detail: 'text with no field focused' }); return; }
        this.chatText = (this.selectAll ? '' : this.chatText) + t; this.selectAll = false;
        return;
      }
      default: throw new DeviceScriptError(`input ${verb}`);
    }
  }
}

// ─── The bash subset ─────────────────────────────────────────────────────────

/** What the interpreter needs from its host: tool files, and the phone. */
export interface ScriptHostIO {
  /** A tool's text by the path the script names (`$T/cmd.sh`, `/c/git/craftmatic/scripts/_pixel_cmd.sh`), or undefined. */
  readTool(path: string): string | undefined;
  screen: PhoneScreen;
}

/** One logical statement: its words (quotes kept) and the line it came from. */
interface Stmt { text: string; line: number; file: string }

/** Split a script into statements: lines, then `;` outside quotes and outside `{ }` / `(( ))`; comments dropped. */
function statements(text: string, file: string): Stmt[] {
  const out: Stmt[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    let cur = '', q: string | undefined, depth = 0, paren = 0;
    const push = (): void => { const t = cur.trim(); if (t) out.push({ text: t, line: i + 1, file }); cur = ''; };
    for (let k = 0; k < raw.length; k++) {
      const ch = raw[k]!;
      if (q) { cur += ch; if (ch === '\\' && q === '"') { cur += raw[++k] ?? ''; continue; } if (ch === q) q = undefined; continue; }
      if (ch === '#' && (k === 0 || /\s/.test(raw[k - 1]!))) break;
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (ch === '(') paren++;
      if (ch === ')') paren--;
      if (ch === ';' && depth <= 0 && paren <= 0) { push(); continue; }
      cur += ch;
    }
    push();
  });
  return out;
}

/** Words of a statement, quotes kept (expansion strips them). */
function words(s: string): string[] {
  const out: string[] = [];
  let cur = '', q: string | undefined, paren = 0, any = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k]!;
    if (q) { cur += ch; if (ch === '\\' && q === '"') { cur += s[++k] ?? ''; continue; } if (ch === q) q = undefined; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; any = true; continue; }
    if (ch === '(') paren++;
    if (ch === ')') paren--;
    if (/\s/.test(ch) && paren <= 0) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += ch; any = true;
  }
  if (cur || any) out.push(cur);
  return out;
}

/** One bash execution context (a script and its positional arguments). */
interface Frame { args: string[]; vars: Map<string, string>; funcs: Map<string, Stmt[]>; file: string; dir: string }

/**
 * Run a device script: `text` is the script, `args` its positional arguments, `file` its path (for `$0` and
 * `dirname`), `env` the inherited exported variables. Every `input` reaches `io.screen`; `sleep` advances the world.
 */
export async function runDeviceScript(text: string, args: string[], file: string, io: ScriptHostIO, env: Map<string, string> = new Map()): Promise<void> {
  const frame: Frame = { args: [file, ...args], vars: env, funcs: new Map(), file, dir: file.replace(/[\\/][^\\/]*$/, '') };
  await runBlock(statements(text, file), frame, io);
}

/** Expand one word: quotes, `$` expansions, `$(...)`, `$((...))`; returns the word's value. */
function expand(word: string, f: Frame, io: ScriptHostIO): string {
  let out = '', k = 0;
  const param = (name: string): string => (/^\d+$/.test(name) ? f.args[Number(name)] ?? '' : name === '#' ? String(f.args.length - 1) : f.vars.get(name) ?? '');
  const dollar = (s: string, i: number): [string, number] => {
    if (s.startsWith('$((', i)) {
      const end = s.indexOf('))', i);
      // Variables (`dx`, `$dx`) and positional parameters (`$1`) are read; bare numbers stay numbers.
      const expr = s.slice(i + 3, end).replace(/\$(\d+)|\$?([A-Za-z_]\w*)/g, (_m, pos: string | undefined, v: string | undefined) => param(pos ?? v ?? '') || '0');
      if (!/^[\d\s+\-*/()%]+$/.test(expr)) throw new DeviceScriptError(`arithmetic ${expr}`);
      return [String(Math.trunc(Function(`"use strict";return (${expr});`)() as number)), end + 2];
    }
    if (s.startsWith('$(', i)) {
      let depth = 0, j = i + 1;
      for (; j < s.length; j++) { if (s[j] === '(') depth++; if (s[j] === ')' && --depth === 0) break; }
      return [substitute(s.slice(i + 2, j).trim(), f, io), j + 1];
    }
    if (s[i + 1] === '{') {
      const end = s.indexOf('}', i);
      return [braced(s.slice(i + 2, end), f, io, param), end + 1];
    }
    const m = /^(\d|[A-Za-z_]\w*|#)/.exec(s.slice(i + 1));
    if (!m) return ['$', i + 1];
    return [param(m[1]!), i + 1 + m[1]!.length];
  };
  while (k < word.length) {
    const ch = word[k]!;
    if (ch === "'") { const e = word.indexOf("'", k + 1); out += word.slice(k + 1, e); k = e + 1; continue; }
    if (ch === '"') {
      k++;
      while (k < word.length && word[k] !== '"') {
        if (word[k] === '\\') { out += word[k + 1]; k += 2; continue; }
        if (word[k] === '$') { const [v, n] = dollar(word, k); out += v; k = n; continue; }
        out += word[k++];
      }
      k++;
      continue;
    }
    if (ch === '$') { const [v, n] = dollar(word, k); out += v; k = n; continue; }
    if (ch === '\\') { out += word[k + 1] ?? ''; k += 2; continue; }
    out += ch; k++;
  }
  return out;
}

/** `${...}` forms the round tools use. */
function braced(inner: string, f: Frame, io: ScriptHostIO, param: (n: string) => string): string {
  let m: RegExpExecArray | null;
  if ((m = /^(\w+):-(.*)$/s.exec(inner))) return param(m[1]!) || expand(m[2]!, f, io);
  if ((m = /^(\w+):\?(.*)$/s.exec(inner))) { const v = param(m[1]!); if (!v) throw new DeviceScriptError(`${f.file}: ${expand(m[2]!, f, io)}`); return v; }
  if ((m = /^(\w+),,$/.exec(inner))) return param(m[1]!).toLowerCase();
  if ((m = /^(\w+)\/\/(.*?)\/(.*)$/s.exec(inner))) { const pat = m[2]!.replace(/\\(.)/g, '$1'); return param(m[1]!).split(pat).join(m[3]!); }
  if ((m = /^(\w+)#(.*)$/s.exec(inner))) { const v = param(m[1]!); return v.startsWith(m[2]!) ? v.slice(m[2]!.length) : v; }
  if ((m = /^(\w+)$/.exec(inner))) return param(m[1]!);
  throw new DeviceScriptError(`\${${inner}}`);
}

/** The `$(...)` substitutions the round tools use. */
function substitute(cmd: string, f: Frame, io: ScriptHostIO): string {
  const w = words(cmd);
  if (w[0] === 'dirname') return expand(w[1] ?? '', f, io).replace(/[\\/][^\\/]*$/, '') || '.';
  if (w[0] === 'adb' && w[1] === 'shell' && w[2] === 'getprop' && w[3] === 'ro.product.model') return io.screen.layout.model;
  if (w[0] === 'remote_quote') return `'${expand(w[1] ?? '', f, io).replace(/'/g, "'\\''")}'`;
  if (w[0] === 'date') return '00:00:00';
  throw new DeviceScriptError(`$(${cmd})`);
}

/** Evaluate an `if` condition. */
function condition(c: string, f: Frame, io: ScriptHostIO): boolean {
  const t = c.trim();
  if (t.startsWith('! ')) return !condition(t.slice(2), f, io);
  let m: RegExpExecArray | null;
  if ((m = /^\[\[\s+(.+?)\s+(==|!=)\s+(.+?)\s+\]\]$/.exec(t))) {
    const lhs = expand(m[1]!, f, io), raw = m[3]!;
    const quoted = /^['"]/.test(raw);
    const rhs = expand(raw, f, io);
    const eq = quoted ? lhs === rhs : new RegExp(`^${rhs.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(lhs);
    return m[2] === '==' ? eq : !eq;
  }
  // The chat test `_pixel_cmd.sh` makes before its Exit tap: is the soft keyboard (the chat) up?
  if (/^adb shell dumpsys input_method \| grep -q '?mInputShown=true'?$/.test(t)) return io.screen.chatOpen;
  if (/^\$\w+$/.test(t)) { const v = expand(t, f, io); if (v === 'true') return true; if (v === 'false') return false; }
  throw new DeviceScriptError(`if ${t}`);
}

/** Run a list of statements (with if/else/fi and function definitions). */
async function runBlock(list: Stmt[], f: Frame, io: ScriptHostIO): Promise<void> {
  for (let i = 0; i < list.length; i++) {
    const s = list[i]!;
    // Function definitions: `name() { body; }` on one line, or `name() {` ... `}`.
    let m = /^(\w+)\(\)\s*\{\s*(.*?)\s*\}?$/.exec(s.text);
    if (m) {
      if (/\}$/.test(s.text)) { f.funcs.set(m[1]!, m[2] ? statements(m[2], s.file) : []); continue; }
      const body: Stmt[] = [];
      for (i++; i < list.length && list[i]!.text !== '}'; i++) body.push(list[i]!);
      f.funcs.set(m[1]!, body);
      continue;
    }
    if ((m = /^if\s+(.*)$/.exec(s.text))) {
      // Collect the then / else branches up to the matching fi (nested ifs counted).
      const cond = m[1]!;
      const thenB: Stmt[] = [], elseB: Stmt[] = [];
      let depth = 0, inElse = false;
      // `then` alone, or `then <statement>` on the same line (`if $x; then sleep 2; else sleep 0.6; fi`).
      const next = list[i + 1]?.text ?? '';
      if (next === 'then') i++;
      else if (/^then\s+/.test(next)) { i++; thenB.push({ ...list[i]!, text: next.slice(5).trim() }); }
      else throw new DeviceScriptError(`${s.file}:${s.line}: if without then`);
      for (i++; i < list.length; i++) {
        const t = list[i]!.text;
        if (/^if\s/.test(t)) depth++;
        if (t === 'fi') { if (depth === 0) break; depth--; }
        if (/^then\s+/.test(t) && depth === 0) { (inElse ? elseB : thenB).push({ ...list[i]!, text: t.slice(5).trim() }); continue; }
        if (t === 'else' && depth === 0) { inElse = true; continue; }
        if (/^else\s+/.test(t) && depth === 0) { inElse = true; elseB.push({ ...list[i]!, text: t.slice(5).trim() }); continue; }
        (inElse ? elseB : thenB).push(list[i]!);
      }
      await runBlock(condition(cond, f, io) ? thenB : elseB, f, io);
      continue;
    }
    await runStatement(s, f, io);
  }
}

/** One simple statement. */
async function runStatement(s: Stmt, f: Frame, io: ScriptHostIO): Promise<void> {
  const w = words(s.text);
  const at = `${s.file}:${s.line}`;
  if (!w.length) return;
  // Assignments (`name=value`, `export name=value`, `local name=value`).
  const assign = /^(?:export\s+|local\s+)?([A-Za-z_]\w*)=(.*)$/s.exec(s.text);
  if (assign && !/\s/.test(s.text.split('=')[0]!.replace(/^(export|local)\s+/, ''))) { f.vars.set(assign[1]!, expand(assign[2]!.trim(), f, io)); return; }
  const cmd = w[0]!;
  if (cmd === 'set' || cmd === 'export' || cmd === 'printf' || cmd === 'local') return;
  if (cmd === 'shift') { f.args.splice(1, 1); return; }
  if (cmd === 'source' || cmd === '.') {
    const path = expand(w[1]!, f, io), text = io.readTool(path);
    if (text === undefined) throw new DeviceScriptError(`${at}: cannot read ${path}`);
    await runBlock(statements(text, path), { ...f, file: path }, io);
    return;
  }
  if (cmd === 'sleep') { await io.screen.hold(ticksOf(Number(expand(w[1]!, f, io)))); return; }
  if (cmd === 'bash' || cmd === 'sh') {
    const path = expand(w[1]!, f, io), text = io.readTool(path);
    if (text === undefined) throw new DeviceScriptError(`${at}: cannot read ${path}`);
    // A child script inherits the exported variables (the round tools export R, T, ANDROID_SERIAL).
    await runDeviceScript(text, w.slice(2).map(x => expand(x, f, io)), path, io, new Map(f.vars));
    return;
  }
  if (f.funcs.has(cmd)) {
    const callArgs = w.slice(1).map(x => expand(x, f, io));
    await runBlock(f.funcs.get(cmd)!, { ...f, args: [f.args[0]!, ...callArgs] }, io);
    return;
  }
  if (cmd === 'adb') {
    const rest = w.slice(1).map(x => expand(x, f, io));
    if (rest[0] !== 'shell') { io.screen.io.log({ command: `adb ${rest.join(' ')}`.slice(0, 120), route: 'ignored', detail: 'host-side adb' }); return; }
    // `adb shell "a; b; c"` is one remote script; `adb shell input ...` one command.
    const remote = rest.length === 2 ? rest[1]! : rest.slice(1).join(' ');
    for (const part of statements(remote, `${at} (remote)`)) {
      const pw = words(part.text).map(x => expand(x, f, io));
      if (pw[0] === 'input') await io.screen.input(pw.slice(1), part.text);
      else if (pw[0] === 'sleep') await io.screen.hold(ticksOf(Number(pw[1])));
      else io.screen.io.log({ command: part.text.slice(0, 120), route: 'ignored', detail: 'device-side, not input' });
    }
    return;
  }
  if (['magick', 'rm', 'echo', 'mkdir', 'ffmpeg', 'ls', 'date', 'cat'].includes(cmd)) { io.screen.io.log({ command: s.text.slice(0, 120), route: 'ignored', detail: 'host-only' }); return; }
  throw new DeviceScriptError(`${at}: cannot replay \`${s.text}\``);
}

/**
 * The absolute coordinates of a `/tp` the device typed, moved from the device's world to the simulator's: the
 * device's pin (the placement's pinned corner) maps onto the simulated placement's anchor, and each coordinate is
 * read as the device stores it - a 32-bit float (quirk `position-float32`). Relative (`~`) tokens pass through.
 */
export function translateCommand(line: string, pin: { x: number; y: number; z: number } | undefined, anchor: { x: number; y: number; z: number } | undefined): string {
  const t = line.trim().split(/\s+/);
  const name = t[0]?.replace(/^\//, '');
  if (!pin || !anchor || (name !== 'tp' && name !== 'teleport')) return line;
  const axis = ['x', 'y', 'z'] as const;
  for (let k = 0; k < 3; k++) {
    const tok = t[2 + k];
    if (tok === undefined || tok.startsWith('~') || tok.startsWith('^') || !Number.isFinite(Number(tok))) continue;
    const a = axis[k]!;
    t[2 + k] = String(Math.fround(Number(tok)) - pin[a] + anchor[a]);
  }
  return t.join(' ');
}
