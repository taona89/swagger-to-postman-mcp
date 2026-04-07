/**
 * Generates CSV/JSON iteration data files for Newman's --iteration-data flag.
 * Extracts parameterizable fields from the API spec and produces multiple
 * rows of varied example values.
 */

import { v4 as uuidv4 } from 'uuid';

export class DataFileGenerator {
  constructor(apiSpec, options = {}) {
    this.apiSpec = apiSpec;
    this.rowCount = options.rowCount ?? 3;
  }

  /**
   * Resolve $ref, allOf, oneOf, anyOf into a flat schema.
   * Uses apiSpec.schemas to look up $ref targets.
   */
  resolveSchema(schema, depth = 0) {
    if (depth > 10 || !schema) return {};
    if (schema.$ref) {
      const refName = schema.$ref.split('/').pop();
      const resolved = this.apiSpec.schemas?.[refName];
      return resolved ? this.resolveSchema(resolved, depth + 1) : {};
    }
    if (schema.allOf) {
      return Object.assign({}, ...schema.allOf.map(s => this.resolveSchema(s, depth + 1)));
    }
    if (schema.oneOf || schema.anyOf) {
      return this.resolveSchema((schema.oneOf ?? schema.anyOf)[0], depth + 1);
    }
    return schema;
  }

  /**
   * Recursively extract fields from a schema, flattening nested objects.
   * Returns array of field descriptors.
   */
  extractFieldsFromSchema(schema, prefix = '') {
    const resolved = this.resolveSchema(schema);
    const fields = [];
    if (!resolved.properties) return fields;

    for (const [propName, propSchema] of Object.entries(resolved.properties)) {
      const fullName = prefix ? `${prefix}.${propName}` : propName;
      const resolvedProp = this.resolveSchema(propSchema);

      if (resolvedProp.type === 'object' || resolvedProp.allOf || resolvedProp.oneOf || resolvedProp.anyOf) {
        // Recurse into nested objects
        const nested = this.extractFieldsFromSchema(resolvedProp, fullName);
        fields.push(...nested);
      } else {
        fields.push({
          name: fullName,
          type: resolvedProp.type || 'string',
          format: resolvedProp.format || '',
          enum: resolvedProp.enum || null,
          minimum: resolvedProp.minimum,
          maximum: resolvedProp.maximum,
          minLength: resolvedProp.minLength,
          maxLength: resolvedProp.maxLength,
          pattern: resolvedProp.pattern || null,
          example: resolvedProp.example,
          items: resolvedProp.items || null,
          source: 'body',
        });
      }
    }
    return fields;
  }

  /**
   * Extract all parameterizable fields from the spec.
   * Returns array of { name, type, format, enum, source, ... } objects.
   */
  extractFields() {
    const fields = new Map();

    for (const endpoint of this.apiSpec.endpoints) {
      // Path parameters
      for (const param of endpoint.parameters.filter(p => p.in === 'path')) {
        if (!fields.has(param.name)) {
          const schema = param.schema || {};
          fields.set(param.name, {
            name: param.name,
            type: schema.type || 'string',
            format: schema.format || '',
            enum: schema.enum || null,
            minimum: schema.minimum,
            maximum: schema.maximum,
            minLength: schema.minLength,
            pattern: schema.pattern || null,
            example: schema.example,
            items: schema.items || null,
            source: 'path',
          });
        }
      }

      // Query parameters
      for (const param of endpoint.parameters.filter(p => p.in === 'query')) {
        if (!fields.has(param.name)) {
          const schema = param.schema || {};
          fields.set(param.name, {
            name: param.name,
            type: schema.type || 'string',
            format: schema.format || '',
            enum: schema.enum || null,
            minimum: schema.minimum,
            maximum: schema.maximum,
            minLength: schema.minLength,
            pattern: schema.pattern || null,
            example: schema.example,
            items: schema.items || null,
            source: 'query',
          });
        }
      }

      // Request body properties (with nested object and allOf/oneOf/anyOf support)
      if (endpoint.requestBody?.schema) {
        const bodyFields = this.extractFieldsFromSchema(endpoint.requestBody.schema);
        for (const field of bodyFields) {
          if (!fields.has(field.name)) {
            fields.set(field.name, field);
          }
        }
      }
    }

    return Array.from(fields.values());
  }

  /**
   * Generate iteration data rows as an array of objects.
   * Each row contains varied example values for all parameterizable fields.
   */
  generate() {
    const fields = this.extractFields();
    const rows = [];

    for (let i = 0; i < this.rowCount; i++) {
      const row = {};
      for (const field of fields) {
        row[field.name] = this.generateVariant(field, i);
      }
      rows.push(row);
    }

    return rows;
  }

  /**
   * Generate a varied value for a field based on its type/format and the row index.
   */
  generateVariant(field, index) {
    const { name, type, format, example } = field;
    const lower = (name || '').toLowerCase();

    // Date/time formats — relative to today (takes priority over example to avoid invalid date strings)
    if (format === 'date') {
      const d = new Date();
      d.setDate(d.getDate() + index);
      return d.toISOString().split('T')[0];
    }
    if (format === 'date-time') {
      const d = new Date();
      d.setDate(d.getDate() + index);
      d.setHours(10 + index, 0, 0, 0);
      return d.toISOString();
    }

    // Use spec-provided example — vary strings by appending index suffix
    if (example !== undefined && example !== null && example !== '') {
      if (typeof example === 'string' && index > 0) return `${example}_${index + 1}`;
      return example;
    }

    // Enum fields — rotate through values
    if (field.enum && field.enum.length > 0) {
      return field.enum[index % field.enum.length];
    }

    // UUID format or string ID field names (string type only — integers stay numeric)
    if (type === 'string' && (format === 'uuid' || lower.endsWith('_id') || lower.endsWith('_ids') || lower === 'id')) {
      return uuidv4();
    }

    // Pattern present — can't reliably generate from arbitrary regex; surface it clearly
    if (field.pattern) {
      return `PATTERN:${field.pattern}`;
    }

    // Type-based generation
    switch (type) {
      case 'integer':
      case 'number': {
        const min = field.minimum ?? 1;
        const max = field.maximum ?? min + 100;
        return min + (index % Math.max(max - min + 1, 1));
      }

      case 'boolean':
        return index % 2 === 0;

      case 'array': {
        const itemSchema = field.items ? this.resolveSchema(field.items) : { type: 'string' };
        return Array.from({ length: index + 1 }, (_, i) =>
          this.generateVariant(
            { ...itemSchema, name: field.name, enum: itemSchema.enum || null, example: itemSchema.example },
            i
          )
        );
      }

      case 'string':
        return this.generateStringVariant(lower, index, field);

      default:
        return `value_${index + 1}`;
    }
  }

  /**
   * Generate varied string values based on property name heuristics and constraints.
   */
  generateStringVariant(lower, index, field = {}) {
    const suffix = index + 1;

    // Pad result to satisfy minLength constraint
    const pad = (str) => {
      if (field.minLength && str.length < field.minLength) {
        return str.padEnd(field.minLength, '_');
      }
      return str;
    };

    // Name fields (broad matching)
    if (lower.includes('firstname') || lower.includes('first_name'))
      return ['Alice', 'Bob', 'Carol'][index % 3];
    if (lower.includes('lastname') || lower.includes('last_name'))
      return ['Smith', 'Johnson', 'Williams'][index % 3];
    if (lower === 'username' || lower === 'user_name')
      return pad(`testuser${suffix}`);
    if (lower.includes('name'))
      return pad(`Test Name ${suffix}`);
    if (lower === 'title')
      return pad(`Test Title ${suffix}`);
    if (lower === 'label')
      return pad(`Test Label ${suffix}`);

    // Description / text
    if (lower.includes('description') || lower === 'desc')
      return pad(`Description variant ${suffix}`);
    if (lower.includes('comment') || lower.includes('note'))
      return pad(`Comment variant ${suffix}`);
    if (lower === 'message' || lower === 'msg')
      return pad(`Message variant ${suffix}`);
    if (lower === 'summary')
      return pad(`Summary variant ${suffix}`);

    // Contact
    if (lower.includes('email'))
      return `user${suffix}@example.com`;
    if (lower.includes('phone'))
      return `+1-555-010${index}`;

    // Auth
    if (lower.includes('password') || lower.includes('secret'))
      return pad(`P@ssw0rd_${suffix}`);
    if (lower.includes('token'))
      return pad(`token_${suffix}_abcdef`);

    // Status / type / role / priority
    if (lower === 'status' || lower.endsWith('_status'))
      return ['active', 'inactive', 'pending'][index % 3];
    if (lower === 'type' || lower.endsWith('_type'))
      return ['default', 'custom', 'system'][index % 3];
    if (lower === 'role' || lower.endsWith('_role'))
      return ['user', 'admin', 'viewer'][index % 3];
    if (lower === 'priority' || lower.endsWith('_priority'))
      return ['low', 'medium', 'high'][index % 3];

    // Identifiers
    if (lower === 'code' || lower.endsWith('_code'))
      return pad(`CODE_${suffix}`);
    if (lower === 'key' || lower.endsWith('_key'))
      return pad(`key_${suffix}`);
    if (lower === 'slug' || lower.endsWith('_slug'))
      return `test-slug-${suffix}`;

    // URLs
    if (lower.includes('url') || lower === 'website')
      return `https://example.com/resource/${suffix}`;

    // Address
    if (lower.includes('address'))
      return pad(`${100 + index} Test Street`);
    if (lower === 'city')
      return ['New York', 'Los Angeles', 'Chicago'][index % 3];
    if (lower === 'country' || lower === 'country_code')
      return ['US', 'GB', 'CA'][index % 3];
    if (lower === 'zip' || lower.includes('postal') || lower === 'postcode')
      return ['10001', '90001', '60601'][index % 3];

    // Colors
    if (lower === 'color' || lower === 'colour')
      return ['#3498db', '#e74c3c', '#2ecc71'][index % 3];

    // Search / filter
    if (lower.includes('search') || lower.includes('filter'))
      return pad(`search_term_${suffix}`);

    // Fallback
    return pad(`test_${lower.replace(/[^a-z0-9]/g, '_')}_${suffix}`);
  }

  /**
   * Serialize rows to JSON string.
   */
  toJSON(rows) {
    return JSON.stringify(rows, null, 2);
  }

  /**
   * Serialize rows to CSV string.
   * Array/object fields are skipped (Newman CSV does not support them)
   * and a warning comment is prepended.
   */
  toCSV(rows) {
    if (rows.length === 0) return '';

    const allHeaders = Object.keys(rows[0]);
    const skipped = allHeaders.filter(h => {
      const v = rows[0][h];
      return Array.isArray(v) || (typeof v === 'object' && v !== null);
    });
    const headers = allHeaders.filter(h => !skipped.includes(h));

    const lines = [];
    if (skipped.length > 0) {
      lines.push(`# WARNING: Skipped array/object fields (not CSV-compatible with Newman): ${skipped.join(', ')}`);
    }
    lines.push(headers.join(','));

    for (const row of rows) {
      const values = headers.map(h => {
        const val = row[h];
        if (val === null || val === undefined) return '';
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      });
      lines.push(values.join(','));
    }

    return lines.join('\n');
  }
}
