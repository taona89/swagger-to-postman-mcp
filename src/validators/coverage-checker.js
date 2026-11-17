/**
 * Maps every request in the collections back to a spec operation by matching
 * path templates (a "{param}" segment matches any value, so "{{booking_id}}"
 * and "not-a-number" both match "/booking/{id}") and reports operation coverage.
 */
import { pathSegments, WRITE_METHODS } from '../core/endpoints.js';
import { AuthContext } from '../core/auth.js';

export class CoverageChecker {
  /**
   * @returns {{ total, writableTotal, positiveCovered, negativeCovered, uncoveredPositive, uncoveredNegative, positivePercent, negativePercent, excluded }}
   */
  check(apiSpec, positiveCollection, negativeCollection) {
    const operations = apiSpec.endpoints.map(e => ({ key: e.key, method: e.method, segments: pathSegments(e.path) }));
    const positive = this.coveredOperations(operations, positiveCollection);
    const negative = this.coveredOperations(operations, negativeCollection);

    const auth = new AuthContext(apiSpec);
    const excluded = auth.authEndpoint ? [`${auth.authEndpoint.key} (authentication endpoint; exercised in setup)`] : [];
    const writable = operations.filter(op => WRITE_METHODS.includes(op.method) && op.key !== auth.authEndpoint?.key);

    const uncoveredPositive = operations.filter(op => !positive.has(op.key)).map(op => op.key).sort();
    const uncoveredNegative = writable.filter(op => !negative.has(op.key)).map(op => op.key).sort();
    const percent = (covered, total) => (total === 0 ? 100 : Math.round((covered / total) * 100));

    return {
      total: operations.length,
      writableTotal: writable.length,
      positiveCovered: operations.length - uncoveredPositive.length,
      negativeCovered: writable.length - uncoveredNegative.length,
      uncoveredPositive,
      uncoveredNegative,
      positivePercent: percent(operations.length - uncoveredPositive.length, operations.length),
      negativePercent: percent(writable.length - uncoveredNegative.length, writable.length),
      excluded,
    };
  }

  coveredOperations(operations, collection) {
    const covered = new Set();
    for (const request of this.requests(collection)) {
      const match = this.match(operations, request.method, request.segments);
      if (match) covered.add(match.key);
    }
    return covered;
  }

  /** Most specific operation (most literal segment matches) for a request. */
  match(operations, method, segments) {
    let best = null;
    let bestScore = -1;
    for (const op of operations) {
      if (op.method !== method || op.segments.length !== segments.length) continue;
      let score = 0;
      let ok = true;
      op.segments.forEach((segment, i) => {
        if (!ok) return;
        if (segment.includes('{')) {
          const pattern = new RegExp(`^${segment.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}/g, '.+')}$`);
          ok = pattern.test(segments[i]) || /^\{\{.+\}\}$/.test(segments[i]);
        } else {
          ok = segment === segments[i];
          score += 1;
        }
      });
      if (ok && score > bestScore) { best = op; bestScore = score; }
    }
    return best;
  }

  requests(collection) {
    const found = [];
    const walk = items => {
      for (const item of items || []) {
        if (item.item) { walk(item.item); continue; }
        if (!item.request) continue;
        const method = String(item.request.method || 'GET').toUpperCase();
        const url = item.request.url;
        let segments;
        if (url && typeof url === 'object' && Array.isArray(url.path)) {
          segments = url.path.map(String).filter(Boolean);
        } else {
          const raw = typeof url === 'string' ? url : url?.raw || '';
          segments = raw.replace(/^\{\{baseUrl\}\}/, '').replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0].split('/').filter(Boolean);
        }
        found.push({ method, segments });
      }
    };
    walk(collection?.item);
    return found;
  }
}
