/**
 * Escaping helpers. Every value that originates from an OpenAPI document is
 * untrusted input and must pass through one of these before it is embedded in
 * generated JavaScript, HTML or Markdown.
 */

/**
 * Serialize a value as a JavaScript literal (string, number, object...).
 * JSON is a subset of JavaScript, so the result can never break out of the
 * literal position it is placed in.
 */
export function js(value) {
  return JSON.stringify(value === undefined ? null : value);
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

/** Make a value safe for a single Markdown table cell. */
export function mdCell(value) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Make a value safe for one line of a Gherkin feature file. */
export function gherkinText(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').trim();
}

/** Make a value safe for a Gherkin data-table cell. */
export function gherkinCell(value) {
  return gherkinText(value).replace(/\|/g, '\\|');
}
