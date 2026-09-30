/**
 * The mock's honesty mechanism. Every object the simulated `@minecraft/server`
 * hands a script is wrapped by `guard`: a member the mock implements answers
 * normally; a member the REAL API has (per the generated catalog) but the mock
 * does not implement throws `UnmodelledError` and is recorded on the timeline
 * with the script that reached for it - unmodelled means UNKNOWN, never pass;
 * a name the real API lacks reads `undefined`, as it does on the device.
 *
 * The throw happens even when the script catches it (most runtimes wrap API
 * calls in try/catch): the RECORD is what the report ranks, so a swallowed
 * throw is still seen.
 */

import { SERVER_TYPES, SERVER_UI_TYPES, type ApiType } from './api-catalog.js';
import type { Timeline } from '../core/timeline.js';

/** Thrown for an API member the simulator does not model. */
export class UnmodelledError extends Error {
  constructor(readonly member: string) {
    super(`Unmodelled: ${member} is part of the Script API but not of the simulator`);
    this.name = 'UnmodelledError';
  }
}

const catalogType = (name: string): ApiType | undefined => SERVER_TYPES[name] ?? SERVER_UI_TYPES[name];

/** Whether the real API's type has a member (instance, or static when `isStatic`). */
export function apiHas(typeName: string, member: string, isStatic = false): boolean {
  const t = catalogType(typeName);
  if (!t) return false;
  return (isStatic ? t.statics ?? [] : t.members).includes(member);
}

/** Record an unmodelled member and return the error to throw. */
export function unmodelled(timeline: Timeline, member: string): UnmodelledError {
  timeline.unmodelled(member, timeline.callerSource());
  return new UnmodelledError(member);
}

/** Properties JavaScript itself probes on any object (promise resolution, coercion, inspection); never API members. */
const LANGUAGE_PROBES = new Set(['then', 'toJSON', 'constructor', 'valueOf', 'toString', 'inspect', 'asymmetricMatch', '$$typeof', 'nodeType', 'length']);

/**
 * Wrap a mock object as the API type `typeName`. `self` is what `this` should
 * be for the object's methods (the proxy itself).
 */
export function guard<T extends object>(target: T, typeName: string, timeline: Timeline): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop, receiver);
      if (LANGUAGE_PROBES.has(prop)) return undefined;
      if (apiHas(typeName, prop)) throw unmodelled(timeline, `${typeName}.${prop}`);
      return undefined;
    },
    set(t, prop, value, receiver) {
      if (typeof prop === 'symbol' || prop in t) return Reflect.set(t, prop, value, receiver);
      if (apiHas(typeName, prop)) throw unmodelled(timeline, `${typeName}.${prop} (set)`);
      return Reflect.set(t, prop, value, receiver);
    },
  });
}

/**
 * A stand-in for an API export the mock does not implement (a class, an
 * enum, a function). Importing it succeeds, as on the device; USING it -
 * calling, constructing or reading a member - throws and records.
 */
export function unmodelledExport(name: string, timeline: Timeline): unknown {
  const fail = (): never => { throw unmodelled(timeline, name); };
  return new Proxy(function unmodelledExportStandIn() { /* never called: the traps below throw */ }, {
    apply: fail, construct: fail,
    get(_t, prop) {
      if (typeof prop === 'symbol' || LANGUAGE_PROBES.has(prop) || prop === 'prototype' || prop === 'name') return undefined;
      throw unmodelled(timeline, `${name}.${prop}`);
    },
  });
}
