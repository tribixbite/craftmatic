/**
 * Bedrock JSON serialization for add-on pack files.
 *
 * Bedrock's actor-property parser types a JSON number by its LITERAL form, not
 * by the declared property type. A `"type": "float"` property whose `default`
 * serializes as `0` (what `JSON.stringify` writes for the JS number `0`) is
 * rejected with
 *
 *   Error loading property 'craftmatic:track_pitch': 'default' value does not
 *   match the specified type 'float'
 *
 * and that failure drops the WHOLE property component for the entity:
 * `query.property(...)` then errors client-side every frame
 * ("query.property called on an actor without a property component") and
 * `Entity.setProperty` throws server-side. Measured on a Pixel 8 Pro
 * (Bedrock 1.26.51) 2026-09-21 in the device content log; it stalled the
 * coaster ride at its first movement tick.
 *
 * `JSON.stringify` cannot emit `0.0` for a JS number, so a float that must keep
 * its decimal point is wrapped in {@link BedrockFloat}, serialized as a tagged
 * string, and unwrapped back to a bare float literal by {@link bedrockJsonText}.
 * Only int/bool/enum actor properties are safe as plain numbers.
 */

/**
 * The tag is generated per serialization, so no value carried in the data —
 * a model label, a set name, anything a user can influence — can forge it and
 * have a string rewritten into a bare number. A fixed tag was forgeable: a
 * label equal to the tag text emitted `"label": 42`, and the same text as an
 * object key would have produced JSON Bedrock cannot parse at all.
 */
let activeTag: string | null = null;
let tagCounter = 0;
const nextTag = () => `__craftmatic_float_${(tagCounter++).toString(36)}_${Math.random().toString(36).slice(2)}__`;
/** Matches the tagged string, including the quotes `JSON.stringify` added. */
const taggedPattern = (tag: string) => new RegExp(`"${tag}\\((-?[0-9]+(?:\\.[0-9]+)?(?:e[+-]?[0-9]+)?)\\)"`, 'g');

/** `0` -> `0.0`; a value that already has a decimal point or exponent is kept. */
function floatLiteralText(value: number): string {
  const text = String(value);
  return /[.e]/i.test(text) ? text : `${text}.0`;
}

/**
 * A number that must survive serialization as a float literal (`0.0`, not `0`).
 * `valueOf` keeps it usable in arithmetic and comparisons.
 */
export class BedrockFloat {
  constructor(readonly value: number) {
    if (!Number.isFinite(value)) throw new Error(`Bedrock float literal must be finite, received ${value}.`);
  }
  toJSON(): string {
    if (!activeTag) throw new Error('A Bedrock float literal must be serialized with bedrockJsonText, not JSON.stringify.');
    return `${activeTag}(${floatLiteralText(this.value)})`;
  }
  valueOf(): number { return this.value; }
  toString(): string { return floatLiteralText(this.value); }
}

/** Marks a number as a Bedrock float literal. Use for `float` actor properties. */
export const bedrockFloat = (value: number): BedrockFloat => new BedrockFloat(value);

/**
 * A `float` actor property, with every number already marked as a float literal.
 * Build float properties with this rather than by hand: an integer literal
 * anywhere in one of them costs the entity its whole property component.
 */
export function floatActorProperty(range: [number, number], defaultValue: number, clientSync = true) {
  if (!(range[0] <= range[1]))
    throw new Error(`Bedrock float property range [${range[0]}, ${range[1]}] is reversed or not finite.`);
  if (!(range[0] <= defaultValue && defaultValue <= range[1]))
    throw new Error(`Bedrock float property default ${defaultValue} is outside its range [${range[0]}, ${range[1]}].`);
  return {
    type: 'float', range: [bedrockFloat(range[0]), bedrockFloat(range[1])],
    default: bedrockFloat(defaultValue), client_sync: clientSync,
  };
}

/**
 * `JSON.stringify` for pack files, restoring {@link BedrockFloat} values as bare
 * float literals. The output stays valid JSON and parses back to the same
 * numbers; only the literal spelling differs.
 */
export function bedrockJsonText(value: unknown, indent?: number): string {
  const tag = nextTag();
  const previous = activeTag;
  activeTag = tag;
  let serialized: string;
  try { serialized = JSON.stringify(value, null, indent); } finally { activeTag = previous; }
  const text = serialized.replace(taggedPattern(tag), '$1');
  // A surviving tag would mean a float literal shipped as a STRING where
  // Bedrock needs a number — the exact fault this module exists to prevent.
  if (text.includes(tag)) throw new Error('A Bedrock float literal did not survive serialization.');
  return text;
}
