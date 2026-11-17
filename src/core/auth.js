/**
 * Authentication model: which endpoint issues credentials, which requests carry
 * them, and which requests must be rejected without them.
 */
import { pathSegments, isPathParamSegment, documentedErrorCodes } from './endpoints.js';

const AUTH_SEGMENTS = new Set(['auth', 'login', 'signin', 'sign-in', 'token', 'tokens', 'authenticate', 'session', 'sessions']);

/** POST endpoint that issues credentials, e.g. POST /auth, /login, /oauth/token. */
export function detectAuthEndpoint(apiSpec) {
  return apiSpec.endpoints.find(endpoint => {
    if (endpoint.method !== 'POST' || endpoint.requiresAuth === true) return false;
    const segments = pathSegments(endpoint.path);
    if (segments.length === 0 || segments.length > 4 || segments.some(isPathParamSegment)) return false;
    return AUTH_SEGMENTS.has(segments.at(-1).toLowerCase());
  }) || null;
}

export class AuthContext {
  constructor(apiSpec) {
    this.apiSpec = apiSpec;
    this.schemes = apiSpec.authSchemes || [];
    this.authEndpoint = detectAuthEndpoint(apiSpec);
  }

  isAuthEndpoint(endpoint) {
    return !!this.authEndpoint && endpoint.key === this.authEndpoint.key;
  }

  /**
   * Security schemes an endpoint must send together (all schemes of its first
   * requirement; the first defined scheme when the spec is silent).
   */
  schemesFor(endpoint) {
    if (endpoint.security === null) return this.schemes.slice(0, 1);
    if (!endpoint.requiresAuth) return [];
    const schemes = (endpoint.authSchemeKeys || []).map(key => this.schemes.find(s => s.key === key)).filter(Boolean);
    return schemes.length > 0 ? schemes : this.schemes.slice(0, 1);
  }

  /** Variable holding the key for an apiKey scheme: the first one uses {{apiKey}}. */
  apiKeyVariable(scheme) {
    const first = this.schemes.find(s => s.type === 'apiKey');
    return !first || first.key === scheme.key ? 'apiKey' : `apiKey_${scheme.key.replace(/[^A-Za-z0-9_]/g, '_')}`;
  }

  /** Whether requests for this endpoint should carry credentials. */
  sendsAuth(endpoint) {
    if (this.isAuthEndpoint(endpoint)) return false;
    if (endpoint.security !== null) return endpoint.requiresAuth === true;
    // Spec is silent: send credentials if there is any way to obtain them.
    return this.schemes.length > 0 || !!this.authEndpoint;
  }

  /**
   * Whether a request without credentials must be rejected.
   * Declared security is authoritative; when the spec is silent, only endpoints
   * that document a 401/403 response get a "no authentication" test.
   */
  requiresAuth(endpoint) {
    if (this.isAuthEndpoint(endpoint)) return false;
    if (endpoint.security !== null) return endpoint.requiresAuth === true;
    const errors = documentedErrorCodes(endpoint);
    return errors.includes(401) || errors.includes(403);
  }

  /** Add credentials to a Postman request object (mutates and returns it). */
  apply(request, endpoint) {
    if (!this.sendsAuth(endpoint)) return request;
    const schemes = this.schemesFor(endpoint);

    if (schemes.length === 0) {
      // Auth endpoint but no declared scheme: token cookie convention.
      request.header.push({ key: 'Cookie', value: 'token={{token}}', type: 'text' });
      return request;
    }
    const cookies = [];
    for (const scheme of schemes) {
      const keyVar = `{{${this.apiKeyVariable(scheme)}}}`;
      if (scheme.type === 'http' && scheme.scheme === 'basic') {
        request.auth = {
          type: 'basic',
          basic: [
            { key: 'username', value: '{{username}}', type: 'string' },
            { key: 'password', value: '{{password}}', type: 'string' },
          ],
        };
      } else if (scheme.type === 'apiKey' && scheme.in === 'query') {
        request.url.query = [...(request.url.query || []), { key: scheme.paramName, value: keyVar }];
        request.url.raw += `${request.url.raw.includes('?') ? '&' : '?'}${scheme.paramName}=${keyVar}`;
      } else if (scheme.type === 'apiKey' && scheme.in === 'cookie') {
        cookies.push(`${scheme.paramName}=${keyVar}`);
      } else if (scheme.type === 'apiKey') {
        request.header.push({ key: scheme.paramName || 'X-API-Key', value: keyVar, type: 'text' });
      } else {
        // http bearer, oauth2, openIdConnect
        request.header.push({ key: 'Authorization', value: 'Bearer {{token}}', type: 'text' });
      }
    }
    if (cookies.length > 0) request.header.push({ key: 'Cookie', value: cookies.join('; '), type: 'text' });
    return request;
  }

  /** Credential variables used by generated requests. */
  credentialVariables() {
    return ['token', 'apiKey'];
  }
}
