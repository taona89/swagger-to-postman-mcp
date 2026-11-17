/**
 * Schema utilities that operate on dereferenced OpenAPI schemas.
 * Dereferenced specs may contain circular object graphs, so every recursive
 * walk here tracks its ancestors and stops at a cycle.
 */
import RandExp from 'randexp';

const MAX_DEPTH = 25;

// Formats understood by the Ajv 6 instance bundled in the Postman sandbox.
// Any other format (int32, int64, double, byte, binary, password...) makes
// Ajv throw "unknown format", so those are dropped from embedded schemas.
const AJV6_FORMATS = new Set([
  'date', 'time', 'date-time', 'uri', 'uri-reference', 'uri-template', 'url',
  'email', 'hostname', 'ipv4', 'ipv6', 'regex', 'uuid', 'json-pointer',
  'json-pointer-uri-fragment', 'relative-json-pointer',
]);
const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);
const PASSTHROUGH_KEYWORDS = new Set([
  'title', 'enum', 'const', 'minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength',
  'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
]);

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Assign an own property even for keys like "__proto__" (spec property names are untrusted). */
export function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  return target;
}

/**
 * Merge allOf members and pick the first oneOf/anyOf branch, producing a single
 * schema that describes one concrete shape. Returns a new shallow object.
 */
export function flattenSchema(schema, depth = 0, stack = []) {
  if (!isObject(schema) || depth > MAX_DEPTH || stack.includes(schema)) return {};
  const next = [...stack, schema];
  let result = { ...schema };

  if (Array.isArray(schema.allOf)) {
    delete result.allOf;
    for (const member of schema.allOf) {
      const flat = flattenSchema(member, depth + 1, next);
      result = {
        ...flat,
        ...result,
        properties: { ...(flat.properties || {}), ...(result.properties || {}) },
        required: [...new Set([...(flat.required || []), ...(result.required || [])])],
      };
    }
    if (Object.keys(result.properties).length === 0) delete result.properties;
    if (result.required.length === 0) delete result.required;
  }

  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(result[key]) && result[key].length > 0) {
      const branch = flattenSchema(result[key][0], depth + 1, next);
      const merged = { ...branch, ...result };
      delete merged[key];
      merged.properties = { ...(branch.properties || {}), ...(result.properties || {}) };
      if (Object.keys(merged.properties).length === 0) delete merged.properties;
      result = merged;
    }
  }
  return result;
}

/** Best-effort JSON type of a schema (first non-null type). */
export function schemaType(schema) {
  if (!isObject(schema)) return undefined;
  if (schema.type) return Array.isArray(schema.type) ? schema.type.find(t => t !== 'null') : schema.type;
  if (schema.properties || schema.additionalProperties) return 'object';
  if (schema.items) return 'array';
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const sample = schema.enum.find(v => v !== null);
    if (typeof sample === 'number') return Number.isInteger(sample) ? 'integer' : 'number';
    if (typeof sample === 'boolean') return 'boolean';
    return 'string';
  }
  if (schema.allOf || schema.oneOf || schema.anyOf) return schemaType(flattenSchema(schema));
  return undefined;
}

/**
 * Convert an OpenAPI 3.0 / Swagger 2.0 schema into a JSON Schema that the
 * Postman sandbox (Ajv 6, draft-07) accepts:
 *  - `nullable: true` becomes a `null` type / enum member
 *  - boolean exclusiveMinimum/exclusiveMaximum become numeric (draft-06+)
 *  - unknown formats, OpenAPI-only and vendor keywords are dropped
 *  - writeOnly properties are removed from response schemas
 *  - oneOf becomes anyOf (OpenAPI variants often overlap, e.g. with a discriminator)
 *  - subschemas used more than once, including cycles, are emitted once under
 *    `definitions` and referenced with $ref, so output size stays linear
 *  - unresolved (external) $refs become `{}` (accept anything)
 */
export function toJsonSchema(schema, { mode = 'response' } = {}) {
  if (!isObject(schema) || schema.$ref) return {};

  // Pass 1: count how often each composite node is reached (cycles count twice).
  const counts = new Map();
  const visit = node => {
    if (!isObject(node) || node.$ref) return;
    counts.set(node, (counts.get(node) || 0) + 1);
    if (counts.get(node) > 1) return;
    for (const child of childSchemas(node)) visit(child);
  };
  visit(schema);
  const shared = new Set([...counts].filter(([node, n]) => n > 1 && childSchemas(node).length > 0).map(([node]) => node));

  // Pass 2: convert, replacing shared nodes with $refs into definitions.
  const definitions = {};
  const names = new Map();
  const convert = (node, depth) => {
    if (!isObject(node) || node.$ref || depth > MAX_DEPTH) return {};
    if (!shared.has(node)) return convertNode(node, mode, child => convert(child, depth + 1));
    if (!names.has(node)) {
      const name = `s${names.size}`;
      names.set(node, name);
      definitions[name] = {}; // reserve before converting, so cycles terminate
      definitions[name] = convertNode(node, mode, child => convert(child, 0));
    }
    return { $ref: `#/definitions/${names.get(node)}` };
  };

  let out = convert(schema, 0);
  if (out.$ref) out = { allOf: [out] };
  if (Object.keys(definitions).length > 0) out.definitions = definitions;
  return out;
}

function childSchemas(node) {
  const children = [];
  for (const prop of Object.values(node.properties || {})) children.push(prop);
  if (Array.isArray(node.items)) children.push(...node.items);
  else if (isObject(node.items)) children.push(node.items);
  if (isObject(node.additionalProperties)) children.push(node.additionalProperties);
  for (const key of ['allOf', 'oneOf', 'anyOf']) if (Array.isArray(node[key])) children.push(...node[key]);
  if (isObject(node.not)) children.push(node.not);
  return children.filter(isObject);
}

function convertNode(schema, mode, recurse) {
  const hidden = name => {
    const prop = schema.properties?.[name];
    return isObject(prop) && (mode === 'response' ? prop.writeOnly : prop.readOnly) === true;
  };
  const out = {};

  for (const [key, value] of Object.entries(schema)) {
    if (PASSTHROUGH_KEYWORDS.has(key)) { out[key] = value; continue; }
    switch (key) {
      case 'type': {
        const types = (Array.isArray(value) ? value : [value]).filter(t => JSON_TYPES.has(t));
        if (types.length === 1) out.type = types[0];
        else if (types.length > 1) out.type = types;
        break;
      }
      case 'format':
        if (AJV6_FORMATS.has(value)) out.format = value;
        break;
      case 'pattern':
        try { new RegExp(value); out.pattern = value; } catch { /* drop patterns JS cannot compile */ }
        break;
      case 'properties':
        out.properties = {};
        for (const [name, prop] of Object.entries(value || {})) {
          if (!hidden(name)) setOwn(out.properties, name, recurse(prop));
        }
        break;
      case 'required':
        if (Array.isArray(value)) {
          const required = value.filter(name => !hidden(name));
          if (required.length > 0) out.required = required;
        }
        break;
      case 'items':
        out.items = Array.isArray(value) ? value.map(recurse) : recurse(value);
        break;
      case 'additionalProperties':
        out.additionalProperties = isObject(value) ? recurse(value) : value;
        break;
      case 'allOf':
      case 'anyOf':
        if (Array.isArray(value)) out[key] = [...(out[key] || []), ...value.map(recurse)];
        break;
      case 'oneOf':
        if (Array.isArray(value)) out.anyOf = [...(out.anyOf || []), ...value.map(recurse)];
        break;
      case 'not':
        out.not = recurse(value);
        break;
      default:
        // nullable, example(s), discriminator, xml, readOnly, writeOnly,
        // deprecated, externalDocs, x-* ... are not JSON Schema validation keywords.
        break;
    }
  }

  for (const [exclusive, inclusive] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']]) {
    const value = schema[exclusive];
    if (typeof value === 'number') out[exclusive] = value;
    else if (value === true && typeof schema[inclusive] === 'number') {
      out[exclusive] = schema[inclusive];
      delete out[inclusive];
    }
  }

  if (schema.nullable === true) {
    if (out.type) out.type = [...new Set([...(Array.isArray(out.type) ? out.type : [out.type]), 'null'])];
    if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
    if (!out.type && (out.allOf || out.oneOf || out.anyOf)) return { anyOf: [{ type: 'null' }, out] };
  }
  return out;
}

// ── Example generation ─────────────────────────────────────────────────────

const FIXED = {
  date: '2030-01-15',
  'date-time': '2030-01-15T10:00:00Z',
  time: '10:00:00',
  email: 'test.user@example.com',
  uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  uri: 'https://example.com',
  url: 'https://example.com',
  hostname: 'example.com',
  ipv4: '192.0.2.10',
  ipv6: '2001:db8::1',
  byte: 'dGVzdA==',
  binary: 'test',
  password: 'P@ssw0rd123!',
};

/** Name-based string values. `unique` marks values that should differ per run. */
const NAME_HEURISTICS = [
  [/^(first_?name|given_?name)$/, 'Test', true],
  [/^(last_?name|surname|family_?name)$/, 'User', true],
  [/^(user_?name|login)$/, 'testuser', true],
  [/email$/, FIXED.email, false],
  [/(^|_)(phone|mobile)(_?number)?$/, '+15550100', false],
  [/^(name|title|label)$|_name$|name$/, 'Test Name', true],
  [/^(description|desc|summary|comment|comments|note|notes|message|reason|body|content|text)$/, 'Generated by swagger-to-postman', false],
  [/^(code|sku|slug|key|reference|ref)$|_(code|key|slug)$/, 'TEST', true],
  [/^(address|street)$|_address$/, '123 Test Street', false],
  [/^city$/, 'Test City', false],
  [/^(country|country_?code)$/, 'US', false],
  [/^(zip|zip_?code|postal_?code|postcode)$/, '90210', false],
  [/(url|uri|website|link)$/, 'https://example.com', false],
  [/^(image|avatar|photo)$|_image$/, 'https://example.com/image.png', false],
  [/^status$|_status$/, 'active', false],
  [/^role$|_role$/, 'user', false],
  [/^priority$/, 'medium', false],
  [/^(color|colour)$/, '#3498db', false],
  [/^(currency)$/, 'USD', false],
  [/^(locale|language)$/, 'en', false],
];

function applyLength(value, schema) {
  let result = value;
  if (typeof schema.maxLength === 'number' && result.length > schema.maxLength) result = result.slice(0, schema.maxLength);
  if (typeof schema.minLength === 'number' && result.length < schema.minLength) result = result.padEnd(schema.minLength, 'x');
  return result;
}

function patternValue(pattern, schema) {
  try {
    const generator = new RandExp(pattern);
    generator.max = Math.min(schema.maxLength ?? 12, 12);
    generator.randInt = (min) => min; // deterministic: always the smallest choice
    for (let i = 0; i < 5; i++) {
      const candidate = generator.gen();
      const lengthOk = (schema.minLength === undefined || candidate.length >= schema.minLength)
        && (schema.maxLength === undefined || candidate.length <= schema.maxLength);
      if (lengthOk && new RegExp(pattern).test(candidate)) return candidate;
    }
  } catch { /* fall through */ }
  return null;
}

function stringExample(schema, propName, unique) {
  if (schema.format && FIXED[schema.format] !== undefined) return applyLength(FIXED[schema.format], schema);
  if (schema.pattern) {
    const generated = patternValue(schema.pattern, schema);
    if (generated !== null) return generated;
  }
  const lower = (propName || '').toLowerCase();
  let base = 'test_value';
  let wantsUnique = true;
  for (const [regex, value, isUnique] of NAME_HEURISTICS) {
    if (regex.test(lower)) { base = value; wantsUnique = isUnique; break; }
  }
  if (base === 'test_value' && /(^|_)id$|Id$/.test(propName || '')) {
    base = FIXED.uuid;
    wantsUnique = false;
  }
  // {{$timestamp}} makes values unique per run (avoids 409 duplicates) but is
  // only safe when no length/pattern constraint could be violated by it.
  const suffix = '_{{$timestamp}}';
  const room = schema.maxLength === undefined || base.length + 11 <= schema.maxLength;
  if (unique && wantsUnique && room && !schema.pattern) return base + suffix;
  return applyLength(base, schema);
}

function numberExample(schema, type) {
  const step = type === 'integer' ? 1 : 0.5;
  let min = typeof schema.minimum === 'number' ? schema.minimum : undefined;
  if (schema.exclusiveMinimum === true && min !== undefined) min += step;
  if (typeof schema.exclusiveMinimum === 'number') min = schema.exclusiveMinimum + step;
  let max = typeof schema.maximum === 'number' ? schema.maximum : undefined;
  if (schema.exclusiveMaximum === true && max !== undefined) max -= step;
  if (typeof schema.exclusiveMaximum === 'number') max = schema.exclusiveMaximum - step;

  let value = min !== undefined ? min : 1;
  if (max !== undefined && value > max) value = max;
  if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
    value = Math.ceil(value / schema.multipleOf) * schema.multipleOf;
  }
  return type === 'integer' ? Math.ceil(value) : value;
}

/**
 * Generate an example value for a schema.
 * @param {object} schema
 * @param {object} [options]
 * @param {string} [options.propName] property name, used for heuristics
 * @param {'request'|'response'} [options.mode] request omits readOnly properties
 * @param {boolean} [options.unique] allow {{$timestamp}} suffixes for unique-per-run strings
 */
export function generateExample(schema, options = {}, depth = 0, stack = []) {
  // A node budget shared by the whole example keeps mutually referencing schemas
  // from producing exponentially large bodies.
  if (depth === 0) options = { ...options, budget: { left: 500 } };
  const { propName = '', mode = 'request', unique = true, budget } = options;
  if (!isObject(schema) || schema.$ref || depth > 8 || stack.includes(schema)) return null;
  if (budget && budget.left-- <= 0) return null;
  const next = [...stack, schema];
  const s = flattenSchema(schema);

  if (s.example !== undefined) return clone(s.example);
  if (Array.isArray(s.examples) && s.examples.length > 0) return clone(s.examples[0]);
  if (s.const !== undefined) return clone(s.const);
  if (s.default !== undefined && s.default !== '') return clone(s.default);
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum.find(v => v !== null) ?? s.enum[0];

  const type = schemaType(s);
  switch (type) {
    case 'object': {
      const out = {};
      for (const [name, prop] of Object.entries(s.properties || {})) {
        if (mode === 'request' && prop?.readOnly) continue;
        if (mode === 'response' && prop?.writeOnly) continue;
        const value = generateExample(prop, { ...options, propName: name }, depth + 1, next);
        if (value !== null) setOwn(out, name, value);
      }
      return out;
    }
    case 'array': {
      const item = generateExample(s.items, { ...options, propName }, depth + 1, next);
      if (item === null) return [];
      return Array.from({ length: Math.max(s.minItems || 1, 1) }, () => clone(item));
    }
    case 'integer':
    case 'number':
      return numberExample(s, type);
    case 'boolean':
      return true;
    case 'string':
      return stringExample(s, propName, unique);
    default:
      return null;
  }
}

/** A deep copy of an example with Postman dynamic variables removed. */
export function stripDynamicVariables(value) {
  if (typeof value === 'string') return value.replace(/_?\{\{\$[^}]+\}\}/g, '');
  if (Array.isArray(value)) return value.map(stripDynamicVariables);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripDynamicVariables(v)]));
  return value;
}

/** Value of the wrong JSON type for a schema, used by negative tests. */
export function wrongTypeValue(schema) {
  switch (schemaType(schema)) {
    case 'string': return 12345;
    case 'integer':
    case 'number': return 'not_a_number';
    case 'boolean': return 'not_a_boolean';
    case 'array': return 'not_an_array';
    case 'object': return 'not_an_object';
    default: return undefined;
  }
}

/** True when the schema forbids an empty string, so "" is a meaningful negative input. */
export function forbidsEmptyString(schema) {
  const s = flattenSchema(schema);
  if (schemaType(s) !== 'string') return false;
  if (typeof s.minLength === 'number' && s.minLength >= 1) return true;
  if (Array.isArray(s.enum) && !s.enum.includes('')) return true;
  if (s.format && AJV6_FORMATS.has(s.format)) return true;
  if (s.pattern) {
    try { return !new RegExp(s.pattern).test(''); } catch { return false; }
  }
  return false;
}

/**
 * Leaf properties of a request-body schema as dotted paths ("bookingdates.checkin")
 * mapped to their (flattened) schemas. readOnly properties are skipped.
 */
export function leafSchemas(schema, prefix = '', depth = 0, stack = []) {
  const leaves = {};
  if (!isObject(schema) || depth > 6 || stack.includes(schema)) return leaves;
  const s = flattenSchema(schema);
  for (const [name, prop] of Object.entries(s.properties || {})) {
    if (prop?.readOnly) continue;
    const key = prefix ? `${prefix}.${name}` : name;
    const flat = flattenSchema(prop);
    if (schemaType(flat) === 'object' && flat.properties) {
      for (const [leaf, leafSchema] of Object.entries(leafSchemas(flat, key, depth + 1, [...stack, schema]))) {
        setOwn(leaves, leaf, leafSchema);
      }
    } else {
      setOwn(leaves, key, flat);
    }
  }
  return leaves;
}

/** Dotted leaf path → JSON type (used to coerce CSV strings back to JSON types). */
export function leafTypes(schema) {
  const types = {};
  for (const [key, s] of Object.entries(leafSchemas(schema))) setOwn(types, key, schemaType(s) || 'string');
  return types;
}

export function singularize(word) {
  const w = String(word || '');
  if (/ies$/i.test(w)) return w.slice(0, -3) + 'y';
  if (/(ss|x|ch|sh)es$/i.test(w)) return w.slice(0, -2);
  if (/s$/i.test(w) && !/ss$/i.test(w)) return w.slice(0, -1);
  return w;
}

/**
 * Candidate property names that hold a resource identifier, most specific first.
 * Combines what the response schema declares with common conventions.
 */
export function idKeyCandidates(schema, resource) {
  const singular = singularize(resource).toLowerCase().replace(/[^a-z0-9]/g, '');
  const plural = String(resource || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const matches = name => {
    const n = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return n === 'id' || n === `${singular}id` || n === `${plural}id` || n === 'uuid' || n === `${singular}uuid`;
  };
  const found = [];
  const collect = s => {
    const flat = flattenSchema(s);
    for (const name of Object.keys(flat.properties || {})) if (matches(name)) found.push(name);
    return flat;
  };
  const root = collect(schema);
  if (schemaType(root) === 'array') collect(root.items);
  for (const wrapper of ['data', 'item', 'result', singular]) {
    const inner = root.properties?.[wrapper];
    if (inner) {
      const flat = collect(inner);
      if (schemaType(flat) === 'array') collect(flat.items);
    }
  }
  return [...new Set([...found, 'id', `${singular}Id`, `${singular}_id`, `${singular}id`])];
}
