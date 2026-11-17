/**
 * Builds Postman request objects (URL, query, headers, body) for an endpoint.
 */
import { pathSegments } from './endpoints.js';
import { generateExample, stripDynamicVariables, flattenSchema } from './schema.js';

const QUERY_DEFAULTS = {
  page: '1', limit: '10', offset: '0', size: '10', per_page: '10', page_size: '10', pagesize: '10',
  sort: 'id', sort_by: 'id', order: 'asc', order_by: 'id',
};
const SKIPPED_HEADERS = new Set(['authorization', 'cookie', 'content-type', 'accept']);

function toParamString(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(toParamString).join(',');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function parameterValue(param) {
  if (param.example !== undefined) return toParamString(param.example);
  if (param.schema?.default !== undefined) return toParamString(param.schema.default);
  const byName = QUERY_DEFAULTS[String(param.name).toLowerCase()];
  if (byName !== undefined) return byName;
  return toParamString(stripDynamicVariables(generateExample(param.schema, { propName: param.name, unique: false })));
}

/**
 * Postman URL object. Path parameters resolve to chain variables unless an
 * override (e.g. an invalid id for a negative test) is supplied. Optional query
 * parameters are included but disabled, so they never narrow results by accident.
 */
export function buildUrl(endpoint, plan, pathOverrides = {}) {
  const segments = pathSegments(endpoint.path).map(segment =>
    segment.replace(/\{([^}]+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(pathOverrides, name)
        ? String(pathOverrides[name])
        : `{{${plan.varForParam(endpoint, name)}}}`
    )));

  const query = endpoint.parameters
    .filter(p => p.in === 'query')
    .map(p => ({
      key: p.name,
      value: parameterValue(p),
      ...(p.required ? {} : { disabled: true }),
      ...(p.description ? { description: p.description } : {}),
    }));
  const enabled = query.filter(q => !q.disabled);
  // Keep a trailing slash: some frameworks (e.g. Django REST) treat /x and /x/ differently.
  const trailing = segments.length > 0 && String(endpoint.path).endsWith('/');
  const url = {
    raw: `{{baseUrl}}/${segments.join('/')}${trailing ? '/' : ''}${enabled.length ? `?${enabled.map(q => `${q.key}=${q.value}`).join('&')}` : ''}`,
    host: ['{{baseUrl}}'],
    path: trailing ? [...segments, ''] : segments,
  };
  if (query.length > 0) url.query = query;
  return url;
}

function parameterHeaders(endpoint) {
  return endpoint.parameters
    .filter(p => p.in === 'header' && !SKIPPED_HEADERS.has(String(p.name).toLowerCase()))
    .map(p => ({ key: p.name, value: parameterValue(p), type: 'text', ...(p.required ? {} : { disabled: true }) }));
}

const isJson = contentType => /json/i.test(contentType || '');

/**
 * Body for a request.
 * @param {object} endpoint
 * @param {*} value body value (ignored when `raw` is given)
 * @param {string} [raw] exact raw text (malformed JSON tests, data-driven `{{requestBody}}`)
 */
export function buildBody(endpoint, value, raw) {
  const contentType = endpoint.requestBody?.contentType || 'application/json';
  const header = { key: 'Content-Type', value: contentType, type: 'text' };

  if (raw !== undefined || isJson(contentType)) {
    return {
      header,
      body: {
        mode: 'raw',
        raw: raw !== undefined ? raw : JSON.stringify(value ?? {}, null, 2),
        options: { raw: { language: isJson(contentType) ? 'json' : 'text' } },
      },
    };
  }
  const pairs = Object.entries(value && typeof value === 'object' ? value : {})
    .map(([key, v]) => ({ key, value: toParamString(v), type: 'text' }));
  if (contentType === 'application/x-www-form-urlencoded') {
    return { header, body: { mode: 'urlencoded', urlencoded: pairs } };
  }
  if (contentType === 'multipart/form-data') {
    // File fields have no example value; add them so a file can be chosen in Postman.
    const properties = flattenSchema(endpoint.requestBody?.schema || {}).properties || {};
    for (const [key, prop] of Object.entries(properties)) {
      const isFile = prop?.type === 'file' || prop?.format === 'binary' || prop?.format === 'base64';
      if (isFile && !pairs.some(p => p.key === key)) pairs.push({ key, type: 'file', src: [] });
    }
    // Postman sets the multipart boundary itself, so no explicit Content-Type header.
    return { header: null, body: { mode: 'formdata', formdata: pairs } };
  }
  // Other media types (XML, text...): a string example is sent verbatim.
  return { header, body: { mode: 'raw', raw: typeof value === 'string' ? value : toParamString(value) } };
}

/** Request body media types the generators can only send as example text. */
export function isOpaqueBody(endpoint) {
  const type = endpoint.requestBody?.contentType || '';
  return !!endpoint.requestBody && !isJson(type)
    && type !== 'application/x-www-form-urlencoded' && type !== 'multipart/form-data';
}

/**
 * Assemble a full Postman request.
 * @param {object} endpoint
 * @param {object} ctx { plan, auth }
 * @param {object} [options]
 * @param {object} [options.pathOverrides]
 * @param {*} [options.body] body value; defaults to the endpoint's example
 * @param {string} [options.rawBody] exact raw body
 * @param {boolean} [options.omitAuth] send no credentials
 */
export function buildRequest(endpoint, { plan, auth }, options = {}) {
  const request = {
    method: endpoint.method,
    header: parameterHeaders(endpoint),
    url: buildUrl(endpoint, plan, options.pathOverrides),
  };
  if (!options.omitAuth) auth.apply(request, endpoint);

  if (endpoint.requestBody && ['POST', 'PUT', 'PATCH'].includes(endpoint.method)) {
    const value = options.body !== undefined ? options.body : endpoint.requestBody.example;
    const { header, body } = buildBody(endpoint, value, options.rawBody);
    if (header) request.header.push(header);
    request.body = body;
  }
  return request;
}
