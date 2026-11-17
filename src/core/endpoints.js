/**
 * Endpoint classification and the status-code oracles shared by every generator
 * (Postman positive/negative suites, BDD scenarios, HTML report).
 */

export const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
export const BODY_METHODS = ['POST', 'PUT', 'PATCH'];

export const isPathParamSegment = segment => /^\{[^}]+\}$/.test(segment);

export function pathSegments(path) {
  return String(path).split('/').filter(Boolean);
}

export function literalSegments(path) {
  return pathSegments(path).filter(s => !s.includes('{'));
}

/** Last literal path segment, e.g. "/users/{id}/posts/{postId}" → "posts". */
export function resourceName(endpoint) {
  const literals = literalSegments(endpoint.path);
  return literals[literals.length - 1] || 'root';
}

export function hasPathParams(endpoint) {
  return endpoint.parameters.some(p => p.in === 'path');
}

export function formatName(name) {
  return String(name)
    .split(/[_-]/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function sanitizeFilename(name) {
  const cleaned = String(name || 'API')
    .replace(/[^a-z0-9_-]/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return cleaned || 'API';
}

/** Group endpoints by CRUD role. The auth endpoint (if any) is excluded. */
export function categorizeEndpoints(endpoints, authEndpoint = null) {
  const crud = { list: [], create: [], read: [], update: [], delete: [] };
  for (const endpoint of endpoints) {
    if (authEndpoint && endpoint.key === authEndpoint.key) continue;
    const itemLevel = pathSegments(endpoint.path).some(isPathParamSegment) &&
      isPathParamSegment(pathSegments(endpoint.path).at(-1));
    switch (endpoint.method) {
      case 'GET': (itemLevel ? crud.read : crud.list).push(endpoint); break;
      case 'POST': crud.create.push(endpoint); break;
      case 'PUT':
      case 'PATCH': crud.update.push(endpoint); break;
      case 'DELETE': crud.delete.push(endpoint); break;
      default: break;
    }
  }
  return crud;
}

const numericCodes = endpoint => Object.keys(endpoint.responses || {})
  .filter(code => /^\d{3}$/.test(code))
  .map(Number)
  .sort((a, b) => a - b);

/** Documented 4xx codes for an endpoint. */
export function documentedErrorCodes(endpoint) {
  return numericCodes(endpoint).filter(code => code >= 400 && code < 500);
}

const DEFAULT_SUCCESS = {
  GET: [200],
  POST: [200, 201],
  PUT: [200, 204],
  PATCH: [200, 204],
  DELETE: [200, 202, 204],
};

/**
 * Success oracle for an endpoint: every documented 2xx code is acceptable.
 * Falls back to HTTP-conventional codes when the spec documents none, and to
 * "any 2xx" when only a 2XX range or default response is documented.
 * @returns {{ codes: number[]|null, documented: boolean }} codes=null → any 2xx
 */
export function successExpectation(endpoint) {
  const documented = numericCodes(endpoint).filter(code => code >= 200 && code < 300);
  if (documented.length > 0) return { codes: documented, documented: true };
  const keys = Object.keys(endpoint.responses || {});
  if (keys.some(k => /^2xx$/i.test(k))) return { codes: null, documented: true };
  return { codes: DEFAULT_SUCCESS[endpoint.method] || [200], documented: false };
}

/**
 * Status codes that are semantically correct for each negative scenario
 * (RFC 9110 / common REST practice). The oracle is the intersection with the
 * codes the spec documents; when the spec documents none of them, the full
 * acceptable set is asserted and the gap is reported.
 */
export const NEGATIVE_SCENARIOS = {
  missingField: { acceptable: [400, 422], label: 'missing required field' },
  wrongType: { acceptable: [400, 422], label: 'wrong field type' },
  emptyValue: { acceptable: [400, 422], label: 'empty value' },
  malformedJson: { acceptable: [400], label: 'malformed JSON body' },
  invalidId: { acceptable: [400, 404, 422], label: 'invalid identifier format' },
  nonExistentId: { acceptable: [404, 410], label: 'non-existent resource' },
  noAuth: { acceptable: [401, 403], label: 'missing authentication' },
};

/** @returns {{ codes: number[], specGap: boolean, scenario: string }} */
export function negativeExpectation(endpoint, scenario) {
  const { acceptable } = NEGATIVE_SCENARIOS[scenario];
  const documented = documentedErrorCodes(endpoint);
  const intersection = acceptable.filter(code => documented.includes(code));
  if (intersection.length > 0) return { codes: intersection, specGap: false, scenario };
  return { codes: acceptable, specGap: true, scenario };
}

/** Human label for a set of expected codes. */
export function codesLabel(codes) {
  if (!codes) return '2xx';
  return codes.length === 1 ? String(codes[0]) : `one of ${codes.join('/')}`;
}
