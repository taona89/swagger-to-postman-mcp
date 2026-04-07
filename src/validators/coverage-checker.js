/**
 * Checks that all endpoints in the OpenAPI spec are covered by
 * generated positive and/or negative test collections.
 */

export class CoverageChecker {
  /**
   * @param {object} apiSpec - Parsed API spec with endpoints[]
   * @param {object} positiveCollection - Postman positive collection JSON
   * @param {object} negativeCollection - Postman negative collection JSON
   * @returns {{ total, positiveCovered, negativeCovered, uncoveredPositive, uncoveredNegative, positivePercent, negativePercent }}
   */
  check(apiSpec, positiveCollection, negativeCollection) {
    // Build set of spec endpoints: "GET /api/resource"
    const specEndpoints = apiSpec.endpoints.map(e => ({
      key: `${e.method} ${e.path}`,
      method: e.method,
      path: e.path,
    }));

    // Extract endpoints from collections
    const positiveEndpoints = this.extractEndpoints(positiveCollection);
    const negativeEndpoints = this.extractEndpoints(negativeCollection);

    // Check positive coverage
    const coveredPositive = [];
    const uncoveredPositive = [];
    for (const ep of specEndpoints) {
      if (positiveEndpoints.has(ep.key)) {
        coveredPositive.push(ep.key);
      } else {
        uncoveredPositive.push(ep.key);
      }
    }

    // For negative tests, only writable endpoints (POST, PUT, PATCH, DELETE) are expected
    const writableEndpoints = specEndpoints.filter(ep =>
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(ep.method)
    );
    const coveredNegative = [];
    const uncoveredNegative = [];
    for (const ep of writableEndpoints) {
      if (negativeEndpoints.has(ep.key)) {
        coveredNegative.push(ep.key);
      } else {
        uncoveredNegative.push(ep.key);
      }
    }

    const positivePercent = specEndpoints.length > 0
      ? Math.round((coveredPositive.length / specEndpoints.length) * 100)
      : 100;
    const negativePercent = writableEndpoints.length > 0
      ? Math.round((coveredNegative.length / writableEndpoints.length) * 100)
      : 100;

    return {
      total: specEndpoints.length,
      writableTotal: writableEndpoints.length,
      positiveCovered: coveredPositive.length,
      negativeCovered: coveredNegative.length,
      uncoveredPositive: uncoveredPositive.sort(),
      uncoveredNegative: uncoveredNegative.sort(),
      positivePercent,
      negativePercent,
    };
  }

  /**
   * Recursively extract "METHOD /path" keys from a Postman collection.
   */
  extractEndpoints(collection) {
    const endpoints = new Set();

    const walk = (items) => {
      if (!items) return;
      for (const item of items) {
        if (item.item) {
          // Folder — recurse
          walk(item.item);
        } else if (item.request) {
          const method = typeof item.request.method === 'string'
            ? item.request.method.toUpperCase()
            : '';
          const rawUrl = typeof item.request.url === 'string'
            ? item.request.url
            : item.request.url?.raw || '';

          // Extract path from URL: remove {{baseUrl}} prefix, normalize {{param}} to {param}
          const path = rawUrl
            .replace(/\{\{baseUrl\}\}/g, '')
            .replace(/\{\{([^}]+)\}\}/g, '{$1}')
            .split('?')[0]; // remove query string

          if (method && path) {
            endpoints.add(`${method} ${path}`);
          }
        }
      }
    };

    walk(collection.item);
    return endpoints;
  }
}
