/**
 * Escaping helpers. Every value that originates from an OpenAPI document is
 * untrusted input and must pass through one of these before it is embedded in
 * generated JavaScript, HTML or Markdown.
 */

/**
 * Serialize a value as a JavaScript expression (string, number, object...).
 * JSON is a subset of JavaScript, so the result cannot break out of the
 * position it is placed in. U+2028/U+2029 are escaped as well, and objects
 * with a "__proto__" key are emitted through JSON.parse so the key stays an
 * own property instead of becoming a prototype setter.
 */
export function js(value) {
  const json = JSON.stringify(value === undefined ? null : value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  if (value !== null && typeof value === 'object' && json.includes('"__proto__"')) {
    return `JSON.parse(${JSON.stringify(json)})`;
  }
  return json;
}

/** Text for a single-line comment or heading: no line terminators survive. */
export function oneLine(value) {
  return String(value ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ');
}

/** Single-quoted POSIX shell word. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

/** Make a value safe for a single Markdown table cell. */
export function mdCell(value) {
  if (value === null || value === undefined || value === '') return '-';
  return oneLine(value).replace(/\|/g, '\\|');
}

/** Inline Markdown code span that cannot be closed early. */
export function mdCode(value) {
  return `\`${oneLine(value).replace(/`/g, "'")}\``;
}

/** Make a value safe for one line of a Gherkin feature file. */
export function gherkinText(value) {
  return oneLine(value).trim();
}

/** Make a value safe for a Gherkin data-table cell (\\ and | are escaped). */
export function gherkinCell(value) {
  return gherkinText(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}
