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

/** Tag wrapping a float literal while it passes through `JSON.stringify`. */
const FLOAT_TAG = '__craftmatic_float__';
/** Matches the tagged string, including the quotes `JSON.stringify` added. */
const FLOAT_TAGGED = new RegExp(`"${FLOAT_TAG}\\((-?[0-9]+(?:\\.[0-9]+)?(?:e[+-]?[0-9]+)?)\\)${FLOAT_TAG}"`, 'gi');

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
  toJSON(): string { return `${FLOAT_TAG}(${floatLiteralText(this.value)})${FLOAT_TAG}`; }
  valueOf(): number { return this.value; }
  toString(): string { return floatLiteralText(this.value); }
}

/** Marks a number as a Bedrock float literal. Use for `float` actor properties. */
export const bedrockFloat = (value: number): BedrockFloat => new BedrockFloat(value);

/**
 * `JSON.stringify` for pack files, restoring {@link BedrockFloat} values as bare
 * float literals. The output stays valid JSON and parses back to the same
 * numbers; only the literal spelling differs.
 */
export function bedrockJsonText(value: unknown, indent?: number): string {
  return JSON.stringify(value, null, indent).replace(FLOAT_TAGGED, '$1');
}
