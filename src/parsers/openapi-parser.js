import SwaggerParser from '@apidevtools/swagger-parser';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAPIWrapper } from '../utils/openapi-wrapper.js';
import { generateExample } from '../core/schema.js';
import { isInside } from '../core/paths.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const PARAM_SCHEMA_KEYS = [
  'type', 'format', 'items', 'enum', 'default', 'minimum', 'maximum', 'exclusiveMinimum',
  'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'multipleOf',
];

function toFilePath(url) {
  if (/^file:/i.test(url)) return fileURLToPath(url);
  return path.resolve(url);
}

function realpathOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

/**
 * $ref resolution options: HTTP refs are never fetched (SSRF), and file refs are
 * only followed when they stay inside the directory of the root spec file. The
 * path is checked lexically first (so a UNC path never reaches the filesystem)
 * and then again after resolving symlinks/junctions.
 */
function refOptions(baseDir) {
  const realBase = realpathOrNull(baseDir) || baseDir;
  return {
    resolve: {
      http: false,
      file: {
        canRead: file => {
          if (!/^file:|^[a-z]:[\\/]|^\//i.test(file.url) && !path.isAbsolute(file.url)) return false;
          const target = toFilePath(file.url);
          if (!isInside(baseDir, target) && !isInside(realBase, target)) return false;
          const real = realpathOrNull(target);
          return real !== null && isInside(realBase, real);
        },
      },
    },
    dereference: { circular: true },
  };
}

function pickMediaType(content) {
  const types = Object.keys(content || {});
  return types.find(t => t === 'application/json')
    || types.find(t => /\+json$|\/json/i.test(t))
    || types.find(t => t === 'application/x-www-form-urlencoded')
    || types.find(t => t === 'multipart/form-data')
    || types[0]
    || null;
}

function firstExample(examples) {
  if (!examples || typeof examples !== 'object') return undefined;
  const first = Object.values(examples)[0];
  return first && typeof first === 'object' && 'value' in first ? first.value : undefined;
}

function substituteServerVariables(server) {
  if (!server?.url) return '';
  return server.url.replace(/\{([^}]+)\}/g, (match, name) => server.variables?.[name]?.default ?? match);
}

/**
 * OpenAPI / Swagger parser.
 * Produces one normalized model for OpenAPI 3.x and Swagger 2.0 documents, with
 * every internal $ref dereferenced (schemas may contain cycles).
 */
export class OpenAPIParser {
  /** Load the raw document: .txt partial specs are wrapped in memory, never written to disk. */
  async load(input) {
    if (typeof input === 'string') {
      // Resolve the spec's own symlinks so relative $refs are checked against its real folder.
      const basePath = realpathOrNull(path.resolve(input)) || path.resolve(input);
      if (/\.txt$/i.test(input)) return { basePath, api: await OpenAPIWrapper.wrapPartialSpec(basePath) };
      return { basePath, api: null };
    }
    return { basePath: path.resolve('openapi.json'), api: input };
  }

  /**
   * Validate a spec against the OpenAPI / Swagger schema.
   * @returns {Promise<{ valid: boolean, errors: string[], info?: object }>}
   */
  async validate(input) {
    const { basePath, api } = await this.load(input);
    try {
      const source = api ? structuredClone(api) : basePath;
      const validated = await SwaggerParser.validate(basePath, source, refOptions(path.dirname(basePath)));
      return { valid: true, errors: [], info: validated.info || {} };
    } catch (error) {
      const errors = String(error.message || error)
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .slice(0, 50);
      return { valid: false, errors };
    }
  }

  async parse(input) {
    let api;
    try {
      const { basePath, api: loaded } = await this.load(input);
      api = await SwaggerParser.dereference(basePath, loaded ?? basePath, refOptions(path.dirname(basePath)));
    } catch (error) {
      const hint = /resolve \$ref/i.test(error.message)
        ? ' (external $refs are only followed for files inside the spec\'s folder; http(s) refs are never fetched)'
        : '';
      throw new Error(`Failed to parse OpenAPI spec: ${error.message}${hint}`);
    }
    return this.normalize(api);
  }

  normalize(api) {
    const swagger2 = typeof api.swagger === 'string';
    const authSchemes = this.extractAuthSchemes(api, swagger2);
    const globalSecurity = Array.isArray(api.security) ? api.security : null;
    const endpoints = [];

    for (const [routePath, pathItem] of Object.entries(api.paths || {})) {
      if (!pathItem || typeof pathItem !== 'object') continue;
      for (const method of METHODS) {
        const operation = pathItem[method];
        if (!operation) continue;
        const rawParams = this.mergeParameters(pathItem.parameters, operation.parameters);
        const security = Array.isArray(operation.security) ? operation.security : globalSecurity;
        const requirement = security?.find(req => Object.keys(req || {}).length > 0);

        endpoints.push({
          key: `${method.toUpperCase()} ${routePath}`,
          path: routePath,
          method: method.toUpperCase(),
          operationId: operation.operationId || `${method}_${routePath}`.replace(/[^a-z0-9_]/gi, '_'),
          summary: operation.summary || '',
          description: operation.description || '',
          tags: Array.isArray(operation.tags) ? operation.tags : [],
          parameters: rawParams
            .filter(p => !['body', 'formData'].includes(p.in))
            .map(p => this.normalizeParameter(p, swagger2)),
          requestBody: swagger2
            ? this.swagger2RequestBody(rawParams, operation, api)
            : this.openApiRequestBody(operation),
          responses: swagger2
            ? this.swagger2Responses(operation, api)
            : this.openApiResponses(operation),
          // null → the spec does not say whether this operation needs auth
          security: security ?? null,
          requiresAuth: security ? security.length > 0 && !security.some(req => Object.keys(req || {}).length === 0) : undefined,
          // every scheme of the first requirement must be sent together ({ a: [], b: [] } = a AND b)
          authSchemeKeys: requirement ? Object.keys(requirement) : [],
        });
      }
    }

    return {
      specVersion: swagger2 ? `swagger-${api.swagger}` : `openapi-${api.openapi}`,
      info: {
        title: api.info?.title || 'API',
        version: api.info?.version || '1.0.0',
        description: api.info?.description || '',
      },
      baseUrl: this.baseUrl(api, swagger2),
      endpoints,
      schemas: (swagger2 ? api.definitions : api.components?.schemas) || {},
      authSchemes,
      securityDeclared: globalSecurity !== null || endpoints.some(e => e.security !== null),
    };
  }

  mergeParameters(pathLevel = [], operationLevel = []) {
    const merged = new Map();
    for (const param of [...(pathLevel || []), ...(operationLevel || [])]) {
      if (param && param.name) merged.set(`${param.in}:${param.name}`, param);
    }
    return [...merged.values()];
  }

  normalizeParameter(param, swagger2) {
    let schema = param.schema;
    if (!schema && swagger2) {
      schema = Object.fromEntries(PARAM_SCHEMA_KEYS.filter(k => param[k] !== undefined).map(k => [k, param[k]]));
    }
    schema = schema || {};
    const example = param.example ?? param['x-example'] ?? firstExample(param.examples) ?? schema.example;
    return {
      name: param.name,
      in: param.in,
      required: param.in === 'path' ? true : !!param.required,
      schema,
      description: param.description || '',
      example,
    };
  }

  openApiRequestBody(operation) {
    const body = operation.requestBody;
    if (!body?.content) return null;
    const contentType = pickMediaType(body.content);
    if (!contentType) return null;
    const media = body.content[contentType] || {};
    const schema = media.schema || {};
    const specExample = media.example ?? firstExample(media.examples);
    const example = specExample ?? generateExample(schema, { mode: 'request' });
    return { required: !!body.required, contentType, schema, example, exampleFromSpec: specExample !== undefined };
  }

  swagger2RequestBody(params, operation, api) {
    const consumes = operation.consumes || api.consumes || [];
    const bodyParam = params.find(p => p.in === 'body');
    if (bodyParam) {
      const contentType = consumes.find(t => /json/i.test(t)) || consumes[0] || 'application/json';
      const schema = bodyParam.schema || {};
      const specExample = bodyParam['x-example'];
      const example = specExample ?? generateExample(schema, { mode: 'request' });
      return { required: !!bodyParam.required, contentType, schema, example, exampleFromSpec: specExample !== undefined };
    }
    const formParams = params.filter(p => p.in === 'formData');
    if (formParams.length === 0) return null;
    const schema = {
      type: 'object',
      properties: Object.fromEntries(formParams.map(p => [p.name, this.normalizeParameter(p, true).schema])),
      required: formParams.filter(p => p.required).map(p => p.name),
    };
    const multipart = formParams.some(p => p.type === 'file') || consumes.includes('multipart/form-data');
    return {
      required: formParams.some(p => p.required),
      contentType: multipart ? 'multipart/form-data' : 'application/x-www-form-urlencoded',
      schema,
      example: generateExample(schema, { mode: 'request' }),
      exampleFromSpec: false,
    };
  }

  openApiResponses(operation) {
    const responses = {};
    for (const [code, response] of Object.entries(operation.responses || {})) {
      const contentType = pickMediaType(response?.content);
      const media = contentType ? response.content[contentType] : null;
      responses[code] = {
        description: response?.description || '',
        contentType,
        schema: media?.schema || null,
        example: media?.example ?? firstExample(media?.examples) ?? null,
      };
    }
    return responses;
  }

  swagger2Responses(operation, api) {
    const produces = operation.produces || api.produces || ['application/json'];
    const responses = {};
    for (const [code, response] of Object.entries(operation.responses || {})) {
      const schema = response?.schema || null;
      responses[code] = {
        description: response?.description || '',
        contentType: schema ? (produces.find(t => /json/i.test(t)) || produces[0]) : null,
        schema,
        example: response?.examples?.['application/json'] ?? null,
      };
    }
    return responses;
  }

  extractAuthSchemes(api, swagger2) {
    const definitions = (swagger2 ? api.securityDefinitions : api.components?.securitySchemes) || {};
    return Object.entries(definitions).map(([key, scheme]) => {
      let type = scheme.type;
      let httpScheme = scheme.scheme ? String(scheme.scheme).toLowerCase() : undefined;
      if (swagger2 && type === 'basic') { type = 'http'; httpScheme = 'basic'; }
      return {
        key,                       // name of the scheme in securitySchemes
        type,                      // http | apiKey | oauth2 | openIdConnect
        scheme: httpScheme,        // bearer | basic (http only)
        bearerFormat: scheme.bearerFormat,
        in: scheme.in,             // header | query | cookie (apiKey only)
        paramName: scheme.name,    // actual header / query / cookie name (apiKey only)
        description: scheme.description || '',
      };
    });
  }

  baseUrl(api, swagger2) {
    if (swagger2) {
      if (!api.host) return api.basePath || '';
      const scheme = api.schemes?.[0] || 'https';
      return `${scheme}://${api.host}${api.basePath || ''}`;
    }
    return substituteServerVariables(api.servers?.[0]);
  }
}
