/**
 * OpenAPI Wrapper Utility
 * Wraps partial OpenAPI specs (e.g. a pasted `paths` section saved as .txt) into
 * a complete document. Everything happens in memory: the wrapper never writes
 * files, so read-only operations stay read-only.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';

export class OpenAPIWrapper {
  /**
   * Parse a partial spec file and return a complete OpenAPI 3 document.
   * @param {string} filePath path to the partial spec (.txt)
   * @returns {Promise<object>}
   */
  static async wrapPartialSpec(filePath) {
    const content = await fs.readFile(filePath, 'utf8');
    const partialSpec = this.parseContent(content);

    if (!partialSpec || typeof partialSpec !== 'object' || Array.isArray(partialSpec)) {
      throw new Error('Partial spec must be a JSON or YAML object');
    }
    if (partialSpec.openapi || partialSpec.swagger) return partialSpec;

    const apiName = path.basename(filePath, path.extname(filePath))
      .replace(/_(swagger|spec|openapi)$/i, '')
      .split(/[_-]/)
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ') || 'Partial';

    const completeSpec = {
      openapi: '3.0.3',
      info: { title: `${apiName} API`, version: '1.0.0', description: `Wrapped from partial spec ${path.basename(filePath)}` },
      paths: partialSpec.paths || partialSpec,
      components: { schemas: {}, ...(partialSpec.components || {}) },
    };
    completeSpec.components.schemas = completeSpec.components.schemas || {};
    this.addPlaceholderSchemas(completeSpec);
    return completeSpec;
  }

  static parseContent(content) {
    const trimmed = content.trim();
    try { return JSON.parse(trimmed); } catch { /* try other forms */ }
    // A bare list of "path": {...} entries, optionally with a trailing comma
    if (trimmed.startsWith('"')) {
      try { return JSON.parse(`{${trimmed.replace(/,\s*$/, '')}}`); } catch { /* try YAML */ }
    }
    try {
      return yaml.load(content);
    } catch (error) {
      throw new Error(`Failed to parse partial spec as JSON or YAML: ${error.message}`);
    }
  }

  /** Add permissive placeholder schemas for #/components/schemas refs that are not defined. */
  static addPlaceholderSchemas(spec) {
    const refs = new Set();
    const seen = new WeakSet();
    const walk = node => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      if (typeof node.$ref === 'string' && node.$ref.startsWith('#/components/schemas/')) {
        refs.add(node.$ref.slice('#/components/schemas/'.length));
      }
      for (const value of Object.values(node)) walk(value);
    };
    walk(spec.paths);
    for (const name of refs) {
      if (!spec.components.schemas[name]) {
        spec.components.schemas[name] = { type: 'object', description: 'Placeholder: schema not present in partial spec' };
      }
    }
  }
}
