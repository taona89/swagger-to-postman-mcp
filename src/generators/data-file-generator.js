/**
 * Generates CSV/JSON iteration data files for Newman's --iteration-data flag.
 *
 * Columns are the leaf request-body fields of the create/update operations
 * (nested objects as dotted paths, e.g. "bookingdates.checkin"). The positive
 * suite's data-driven pre-request script overlays each row onto the example
 * body and restores JSON types, so CSV strings become numbers/booleans again.
 * Path parameters are never data-driven: ids come from the request chain.
 */
import RandExp from 'randexp';
import { AuthContext } from '../core/auth.js';
import { leafSchemas, generateExample, stripDynamicVariables, schemaType } from '../core/schema.js';

const FIRST_NAMES = ['Alice', 'Bob', 'Carol', 'David', 'Erin'];
const LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones'];
const CITIES = ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix'];

export class DataFileGenerator {
  /**
   * @param {object} apiSpec parsed spec
   * @param {object} [options]
   * @param {number} [options.rowCount=3]
   * @param {Map<string, object>} [options.fields] dotted path → schema (defaults to all create/update body leaves)
   */
  constructor(apiSpec, options = {}) {
    this.apiSpec = apiSpec;
    this.rowCount = options.rowCount ?? 3;
    this.fields = options.fields || this.extractFields();
  }

  extractFields() {
    const auth = new AuthContext(this.apiSpec);
    const fields = new Map();
    for (const endpoint of this.apiSpec.endpoints) {
      if (!['POST', 'PUT', 'PATCH'].includes(endpoint.method) || auth.isAuthEndpoint(endpoint)) continue;
      if (!endpoint.requestBody || !/json/i.test(endpoint.requestBody.contentType)) continue;
      for (const [path, schema] of Object.entries(leafSchemas(endpoint.requestBody.schema))) {
        if (!fields.has(path)) fields.set(path, schema);
      }
    }
    return fields;
  }

  generate() {
    const rows = [];
    for (let index = 0; index < this.rowCount; index++) {
      const row = {};
      for (const [path, schema] of this.fields) row[path] = this.valueFor(path, schema, index);
      rows.push(row);
    }
    return rows;
  }

  valueFor(path, schema, index) {
    const name = path.split('.').pop();
    const lower = name.toLowerCase();
    const type = schemaType(schema);

    if (index === 0 || schema.const !== undefined) {
      return stripDynamicVariables(generateExample(schema, { propName: name, unique: false }));
    }
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      const values = schema.enum.filter(v => v !== null);
      return values[index % values.length];
    }

    switch (type) {
      case 'integer':
      case 'number': {
        const base = Number(generateExample(schema, { propName: name, unique: false })) || 0;
        const step = typeof schema.multipleOf === 'number' ? schema.multipleOf : 1;
        let value = base + index * step;
        const max = typeof schema.maximum === 'number' ? schema.maximum - (schema.exclusiveMaximum === true ? step : 0) : undefined;
        if (max !== undefined && value > max) value = base;
        return value;
      }
      case 'boolean':
        return index % 2 === 0;
      case 'array':
        return [this.valueFor(`${path}[]`, schema.items || { type: 'string' }, index)];
      case 'object':
        return stripDynamicVariables(generateExample(schema, { unique: false })) ?? {};
      case 'string':
        return this.stringVariant(lower, schema, index);
      default:
        return stripDynamicVariables(generateExample(schema, { propName: name, unique: false }));
    }
  }

  stringVariant(lower, schema, index) {
    const n = index + 1;
    const fit = value => {
      let result = String(value);
      if (typeof schema.maxLength === 'number' && result.length > schema.maxLength) result = result.slice(0, schema.maxLength);
      if (typeof schema.minLength === 'number' && result.length < schema.minLength) result = result.padEnd(schema.minLength, 'x');
      return result;
    };

    if (schema.format === 'date' || schema.format === 'date-time') {
      const date = new Date(Date.UTC(2030, 0, 15 + index, 10, 0, 0));
      return schema.format === 'date' ? date.toISOString().slice(0, 10) : date.toISOString().replace('.000', '');
    }
    if (schema.format === 'email' || lower.endsWith('email')) return `user${n}@example.com`;
    if (schema.format === 'uuid') return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
    if (schema.format === 'uri' || schema.format === 'url') return `https://example.com/resource/${n}`;
    if (schema.pattern) {
      try {
        let seed = index;
        const generator = new RandExp(schema.pattern);
        generator.max = Math.min(schema.maxLength ?? 12, 12);
        generator.randInt = (min, max) => min + (seed++ % (max - min + 1));
        const value = generator.gen();
        if (new RegExp(schema.pattern).test(value)) return value;
      } catch { /* fall back to the example */ }
      return stripDynamicVariables(generateExample(schema, { unique: false }));
    }
    if (/^(first_?name|given_?name)$/.test(lower)) return fit(FIRST_NAMES[index % FIRST_NAMES.length]);
    if (/^(last_?name|surname|family_?name)$/.test(lower)) return fit(LAST_NAMES[index % LAST_NAMES.length]);
    if (lower === 'city') return fit(CITIES[index % CITIES.length]);
    const base = String(stripDynamicVariables(generateExample(schema, { propName: lower, unique: false })) ?? 'value');
    return fit(`${base} ${n}`);
  }

  toJSON(rows) {
    return JSON.stringify(rows, null, 2);
  }

  /**
   * CSV for Newman: the first line is always the header row (Newman has no
   * comment syntax). Arrays/objects are written as JSON and parsed back by the
   * data-driven body script.
   */
  toCSV(rows) {
    if (rows.length === 0) return '';
    const headers = Object.keys(rows[0]);
    const cell = value => {
      if (value === null || value === undefined) return '';
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
      return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return [headers.map(cell).join(','), ...rows.map(row => headers.map(h => cell(row[h])).join(','))].join('\n');
  }
}
