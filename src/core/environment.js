/**
 * Postman environment construction and {{variable}} scanning.
 */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const SECRET_KEY = /pass(word)?|secret|token|api_?key|credential|auth/i;
const LEADING_KEYS = ['baseUrl', 'username', 'password'];

/** All {{variable}} references in a collection's requests (dynamic {{$...}} variables excluded). */
export function scanCollectionVariables(collection) {
  const variables = new Set();
  const regex = /\{\{([^{}]+)\}\}/g;
  const walk = node => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      for (const match of node.matchAll(regex)) {
        if (!match[1].startsWith('$')) variables.add(match[1]);
      }
      return;
    }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key !== 'event') walk(value); // scripts are code, not variable references
      }
    }
  };
  walk(collection.item);
  return variables;
}

/** Variables assigned by scripts at runtime (pm.*.set("name", ...)). */
export function scanScriptAssignedVariables(collection) {
  const names = new Set();
  const regex = /pm\.(?:collectionVariables|environment|variables|globals)\.set\(\s*(["'])([^"']+)\1/g;
  const walk = items => {
    for (const item of items || []) {
      if (item.item) walk(item.item);
      for (const event of item.event || []) {
        const exec = event.script?.exec;
        const code = Array.isArray(exec) ? exec.join('\n') : String(exec || '');
        for (const match of code.matchAll(regex)) names.add(match[2]);
      }
    }
  };
  walk(collection.item);
  for (const event of collection.event || []) {
    const exec = event.script?.exec;
    const code = Array.isArray(exec) ? exec.join('\n') : String(exec || '');
    for (const match of code.matchAll(regex)) names.add(match[2]);
  }
  return names;
}

/** Non-empty values from an existing Postman environment file (missing file → empty map). */
export async function readEnvironmentValues(filePath) {
  const values = new Map();
  if (!filePath) return values;
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return values;
    throw new Error(`Cannot read environment file ${filePath}: ${error.message}`);
  }
  for (const entry of parsed.values || []) {
    if (entry?.key && typeof entry.value === 'string' && entry.value !== '' && !entry.value.startsWith('(set at runtime')) {
      values.set(entry.key, entry.value);
    }
  }
  return values;
}

/**
 * Build a Postman environment.
 * Value precedence: custom variables > existing environment > generator defaults > ''.
 * Runtime variables (captured ids, tokens obtained by the auth request) are left
 * out: an environment value would override the freshly captured one.
 */
export function buildEnvironment({ apiSpec, collections, defaults = new Map(), existing = new Map(), custom = {} }) {
  const runtime = new Set();
  const declared = new Set();
  const referenced = new Set();
  for (const collection of collections) {
    scanScriptAssignedVariables(collection).forEach(name => runtime.add(name));
    (collection.variable || []).forEach(v => declared.add(v.key));
    scanCollectionVariables(collection).forEach(name => referenced.add(name));
  }

  const keys = new Set(['baseUrl']);
  for (const name of referenced) {
    if (runtime.has(name)) continue;
    if (declared.has(name) && name !== 'baseUrl') continue; // collection defaults are enough
    keys.add(name);
  }
  for (const name of defaults.keys()) if (referenced.has(name) && !runtime.has(name)) keys.add(name);
  for (const name of Object.keys(custom || {})) keys.add(name);

  const valueOf = key => {
    if (custom && Object.prototype.hasOwnProperty.call(custom, key)) return String(custom[key]);
    if (existing.has(key)) return existing.get(key);
    if (key === 'baseUrl') return apiSpec.baseUrl || '';
    return defaults.get(key) ?? '';
  };

  const ordered = [
    ...LEADING_KEYS.filter(k => keys.has(k)),
    ...[...keys].filter(k => !LEADING_KEYS.includes(k)).sort((a, b) => a.localeCompare(b)),
  ];
  return {
    id: randomUUID(),
    name: `${apiSpec.info.title} - Environment`,
    values: ordered.map(key => ({
      key,
      value: valueOf(key),
      type: SECRET_KEY.test(key) ? 'secret' : 'default',
      enabled: true,
    })),
    _postman_variable_scope: 'environment',
  };
}
