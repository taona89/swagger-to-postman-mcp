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

  /** Security scheme used by an endpoint (first scheme when the spec is silent). */
  schemeFor(endpoint) {
    if (endpoint.security === null) return this.schemes[0] || null;
    if (!endpoint.requiresAuth) return null;
    return this.schemes.find(s => s.key === endpoint.authSchemeKey) || this.schemes[0] || null;
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
    const scheme = this.schemeFor(endpoint);

    if (!scheme) {
      // Auth endpoint but no declared scheme: token cookie convention.
      request.header.push({ key: 'Cookie', value: 'token={{token}}', type: 'text' });
      return request;
    }
    if (scheme.type === 'http' && scheme.scheme === 'basic') {
      request.auth = {
        type: 'basic',
        basic: [
          { key: 'username', value: '{{username}}', type: 'string' },
          { key: 'password', value: '{{password}}', type: 'string' },
        ],
      };
    } else if (scheme.type === 'apiKey' && scheme.in === 'query') {
      request.url.query = [...(request.url.query || []), { key: scheme.paramName, value: '{{apiKey}}' }];
      request.url.raw += `${request.url.raw.includes('?') ? '&' : '?'}${scheme.paramName}={{apiKey}}`;
    } else if (scheme.type === 'apiKey' && scheme.in === 'cookie') {
      request.header.push({ key: 'Cookie', value: `${scheme.paramName}={{apiKey}}`, type: 'text' });
    } else if (scheme.type === 'apiKey') {
      request.header.push({ key: scheme.paramName || 'X-API-Key', value: '{{apiKey}}', type: 'text' });
    } else {
      // http bearer, oauth2, openIdConnect
      request.header.push({ key: 'Authorization', value: 'Bearer {{token}}', type: 'text' });
    }
    return request;
  }

  /** Credential variables used by generated requests. */
  credentialVariables() {
    return ['token', 'apiKey'];
  }
}
