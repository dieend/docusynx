import {createRequire} from 'node:module';
import {JSDOM} from 'jsdom';

interface CssNode {
  type: string;
  name?: string;
  value?: string;
}

interface CssTree {
  parse(source: string, options: {context: 'stylesheet' | 'declarationList' | 'value'; onParseError(error: Error): void}): CssNode;
  walk(ast: CssNode, callback: (node: CssNode) => void): void;
}

const cssTree = createRequire(import.meta.url)('css-tree') as CssTree;

const cssValueAttributes = new Set([
  'clip-path',
  'color',
  'cursor',
  'fill',
  'filter',
  'flood-color',
  'lighting-color',
  'marker-end',
  'marker-mid',
  'marker-start',
  'mask',
  'stop-color',
  'stroke',
]);

const externalCssFunctions = new Set(['cross-fade', '-webkit-cross-fade', 'image', 'image-set', '-webkit-image-set', 'src']);
const unsafeSvgElements = new Set(['animate', 'animatecolor', 'animatemotion', 'animatetransform', 'foreignobject', 'script', 'set']);
const xmlDeclaration = /^\s*<\?xml\s+version\s*=\s*(?:"1\.0"|'1\.0')(?:\s+encoding\s*=\s*(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8'))?(?:\s+standalone\s*=\s*(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>/;

export function assertSafeSvg(svg: string): void {
  if (/<!doctype\b/i.test(svg)) {
    throw unsafe('document type declaration');
  }
  const declaration = svg.match(xmlDeclaration)?.[0] ?? '';
  if (/<\?/.test(svg.slice(declaration.length))) {
    throw unsafe('processing instruction');
  }
  let document: Document;
  try {
    document = new JSDOM(svg, {contentType: 'image/svg+xml'}).window.document;
  } catch (error) {
    throw unsafe(`invalid XML: ${errorMessage(error)}`);
  }
  if (document.doctype) {
    throw unsafe('document type declaration');
  }
  for (const child of document.childNodes) {
    if (child.nodeType === child.PROCESSING_INSTRUCTION_NODE) {
      throw unsafe('processing instruction');
    }
  }
  const root = document.documentElement;
  if (root.localName.toLowerCase() !== 'svg' || (root.namespaceURI && root.namespaceURI !== 'http://www.w3.org/2000/svg')) {
    throw unsafe('invalid root element');
  }
  for (const element of document.querySelectorAll('*')) {
    const elementName = element.localName.toLowerCase();
    if (unsafeSvgElements.has(elementName)) {
      throw unsafe(elementName);
    }
    if (elementName === 'style') {
      validateCss(element.textContent ?? '', 'stylesheet');
    }
    for (const attribute of element.attributes) {
      const name = attribute.localName.toLowerCase();
      if (name === 'base' && attribute.namespaceURI === 'http://www.w3.org/XML/1998/namespace') {
        throw unsafe('xml:base attribute');
      }
      if (name.startsWith('on')) {
        throw unsafe('event handler');
      }
      if (name === 'href' || name === 'src') {
        validateReference(elementName, attribute.value);
      } else if (name === 'style') {
        validateCss(attribute.value, 'declarationList');
      } else if (cssValueAttributes.has(name)) {
        validateCss(attribute.value, 'value');
      }
    }
  }
}

function validateReference(elementName: string, reference: string): void {
  const navigation = elementName === 'a' && /^(?:https?:|mailto:|#)/i.test(reference);
  if (!navigation && !reference.startsWith('#') && !isSafeRasterDataUrl(reference)) {
    throw unsafe('external reference');
  }
}

function validateCss(source: string, context: 'stylesheet' | 'declarationList' | 'value'): void {
  const canonical = canonicalizeCss(source);
  assertBalancedCss(canonical);
  let ast: CssNode;
  try {
    ast = cssTree.parse(canonical, {
      context,
      onParseError(error) {
        throw error;
      },
    });
  } catch (error) {
    throw unsafe(`invalid CSS: ${errorMessage(error)}`);
  }
  cssTree.walk(ast, (node) => {
    const name = typeof node.name === 'string' ? node.name.toLowerCase() : undefined;
    if (node.type === 'Atrule' && name === 'import') {
      throw unsafe('CSS import');
    }
    if (node.type === 'Url') {
      if (typeof node.value !== 'string' || !node.value.startsWith('#')) {
        throw unsafe('CSS external reference');
      }
    }
    if (node.type === 'Function' && name && externalCssFunctions.has(name)) {
      throw unsafe('CSS external resource function');
    }
    if (node.type === 'Raw' && /(?:@import\b|\burl\s*\()/i.test(node.value ?? '')) {
      throw unsafe('CSS external reference');
    }
  });
}

function assertBalancedCss(source: string): void {
  const pairs: Record<string, string> = {'(': ')', '[': ']', '{': '}'};
  const closing = new Set(Object.values(pairs));
  const stack: string[] = [];
  let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = '';
      } else if (/[\n\r\f]/.test(character)) {
        throw unsafe('invalid CSS string');
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (pairs[character]) {
      stack.push(character);
    } else if (closing.has(character)) {
      const open = stack.pop();
      if (!open || pairs[open] !== character) {
        throw unsafe('unbalanced CSS delimiter');
      }
    }
  }
  if (quote || stack.length > 0) {
    throw unsafe('unbalanced CSS delimiter');
  }
}

function canonicalizeCss(source: string): string {
  let output = '';
  let quote = '';
  for (let index = 0; index < source.length;) {
    const character = source[index]!;
    if (!quote && character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) {
        throw unsafe('invalid CSS comment');
      }
      index = end + 2;
      continue;
    }
    if (character === '\\') {
      const decoded = decodeCssEscape(source, index);
      if (quote && (decoded.value === quote || decoded.value === '\\')) {
        output += '\\';
      }
      output += decoded.value;
      index = decoded.next;
      continue;
    }
    output += character;
    index += 1;
    if ((character === '"' || character === "'") && (!quote || quote === character)) {
      quote = quote ? '' : character;
    }
  }
  if (quote) {
    throw unsafe('invalid CSS string');
  }
  if (output.includes('/*') || output.includes('*/')) {
    throw unsafe('invalid CSS comment');
  }
  return output;
}

function decodeCssEscape(source: string, start: number): {value: string; next: number} {
  let index = start + 1;
  if (index >= source.length || /[\n\r\f]/.test(source[index]!)) {
    throw unsafe('invalid CSS escape');
  }
  let hex = '';
  while (index < source.length && hex.length < 6 && /[0-9a-f]/i.test(source[index]!)) {
    hex += source[index]!;
    index += 1;
  }
  if (!hex) {
    const codePoint = source.codePointAt(index)!;
    return {value: String.fromCodePoint(codePoint), next: index + (codePoint > 0xffff ? 2 : 1)};
  }
  if (index < source.length && /[\t\n\f\r ]/.test(source[index]!)) {
    if (source[index] === '\r' && source[index + 1] === '\n') index += 1;
    index += 1;
  }
  const codePoint = Number.parseInt(hex, 16);
  return {
    value: codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? '\ufffd'
      : String.fromCodePoint(codePoint),
    next: index,
  };
}

function isSafeRasterDataUrl(value: string): boolean {
  return /^data:image\/(?:avif|gif|jpeg|png|webp);base64,[a-z0-9+/]+={0,2}$/i.test(value);
}

function unsafe(detail: string): Error {
  return new Error(`unsafe SVG content: ${detail}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
