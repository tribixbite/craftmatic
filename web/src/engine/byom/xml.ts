/**
 * A small DOM-free XML reader, just enough for LXFML.
 *
 * `lxf-parser.ts` used to call `new DOMParser()` directly, so an `.lxf` could
 * not be parsed anywhere but a browser main thread (not in vitest, Bun, a
 * Worker, or the batch CLI). LXFML needs only elements and attributes: this
 * tokenizer builds a tree of `XmlElement`s and answers the two calls the
 * parser makes, `getAttribute(name)` and `querySelectorAll(tagName)`, with the
 * DOM's semantics for them (descendants, document order, case-sensitive).
 *
 * It is NOT a validating or namespace-aware parser: text nodes are dropped,
 * entities are decoded in attribute values only, and a prefixed name is kept
 * verbatim (`a:b`). It does reject what would make LXFML meaningless: a
 * mismatched or unclosed tag, an unterminated construct, or no root element.
 */

/** The element surface `lxf-parser.ts` reads. `Element` (DOM) satisfies it structurally. */
export interface XmlElementLike {
  getAttribute(name: string): string | null;
  /** Descendant elements with this tag name, in document order. */
  querySelectorAll(tagName: string): Iterable<XmlElementLike>;
}

/** A parsed document: all the parser needs is to find elements in it (`Document` satisfies this). */
export interface XmlDocumentLike {
  querySelectorAll(tagName: string): Iterable<XmlElementLike>;
}

/** Turns XML text into a document, or throws an `Error` whose message says what is wrong. */
export type XmlParser = (text: string) => XmlDocumentLike;

/** Thrown for malformed XML; the message names the byte offset. */
export class XmlParseError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} (at offset ${offset})`);
    this.name = 'XmlParseError';
  }
}

/** One parsed element: its attributes and child elements. Text is not kept. */
export class XmlElement implements XmlElementLike {
  readonly children: XmlElement[] = [];
  constructor(readonly tagName: string, private readonly attributes: ReadonlyMap<string, string>) {}

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  querySelectorAll(tagName: string): XmlElement[] {
    const out: XmlElement[] = [];
    // Explicit stack, pushed in reverse, so a deep document cannot overflow the
    // call stack and the output stays in document order.
    const stack: XmlElement[] = [...this.children].reverse();
    while (stack.length) {
      const el = stack.pop()!;
      if (el.tagName === tagName) out.push(el);
      for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i]!);
    }
    return out;
  }
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode the five predefined entities and numeric references in an attribute value. */
export function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

const NAME_RE = /[^\s=/>"'<]+/y;
const ATTR_RE = /\s*([^\s=/>"'<]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

/**
 * Parse XML text into an element tree.
 * @throws XmlParseError on malformed input.
 */
export function parseXml(input: string): XmlElement {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let i = 0;

  /** Index just past `terminator` searching from `from`, or a parse error. */
  const skipTo = (terminator: string, from: number, what: string): number => {
    const at = text.indexOf(terminator, from);
    if (at < 0) throw new XmlParseError(`unterminated ${what}`, from);
    return at + terminator.length;
  };

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break; // trailing text: ignored
    i = lt;
    if (text.startsWith('<!--', i)) { i = skipTo('-->', i + 4, 'comment'); continue; }
    if (text.startsWith('<![CDATA[', i)) { i = skipTo(']]>', i + 9, 'CDATA section'); continue; }
    if (text.startsWith('<?', i)) { i = skipTo('?>', i + 2, 'processing instruction'); continue; }
    if (text.startsWith('<!', i)) {
      // DOCTYPE, possibly with an internal subset in [ ... ].
      const open = text.indexOf('[', i);
      const close = text.indexOf('>', i);
      if (close < 0) throw new XmlParseError('unterminated declaration', i);
      i = open >= 0 && open < close ? skipTo(']>', open, 'DOCTYPE subset') : close + 1;
      continue;
    }
    if (text.startsWith('</', i)) {
      NAME_RE.lastIndex = i + 2;
      const m = NAME_RE.exec(text);
      const open = stack.pop();
      if (!m || !open || open.tagName !== m[0]) {
        throw new XmlParseError(`unexpected closing tag </${m?.[0] ?? ''}>${open ? `, expected </${open.tagName}>` : ''}`, i);
      }
      i = skipTo('>', NAME_RE.lastIndex, 'closing tag');
      continue;
    }
    // Start tag.
    NAME_RE.lastIndex = i + 1;
    const nameMatch = NAME_RE.exec(text);
    if (!nameMatch) throw new XmlParseError('malformed tag', i);
    const attrs = new Map<string, string>();
    let p = NAME_RE.lastIndex;
    for (;;) {
      ATTR_RE.lastIndex = p;
      const a = ATTR_RE.exec(text);
      if (!a) break;
      // A repeated attribute is an error in XML; the first wins here would hide it.
      if (attrs.has(a[1]!)) throw new XmlParseError(`duplicate attribute "${a[1]}"`, p);
      attrs.set(a[1]!, decodeXmlEntities(a[2] ?? a[3] ?? ''));
      p = ATTR_RE.lastIndex;
    }
    while (p < text.length && /\s/.test(text[p]!)) p++;
    const selfClosing = text[p] === '/';
    if (selfClosing) p++;
    if (text[p] !== '>') throw new XmlParseError(`malformed start tag <${nameMatch[0]}`, i);
    i = p + 1;

    const el = new XmlElement(nameMatch[0], attrs);
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else if (root) throw new XmlParseError('more than one root element', lt);
    else root = el;
    if (!selfClosing) stack.push(el);
  }
  if (stack.length) throw new XmlParseError(`unclosed <${stack[stack.length - 1]!.tagName}>`, text.length);
  if (!root) throw new XmlParseError('no root element', 0);
  return root;
}

/**
 * The document the `XmlParser` contract returns: a virtual node above the root,
 * so `querySelectorAll('LXFML')` finds the root exactly as a DOM `Document` does.
 */
export const parseXmlDocument: XmlParser = (text) => {
  const root = parseXml(text);
  const doc = new XmlElement('#document', new Map());
  doc.children.push(root);
  return doc;
};
