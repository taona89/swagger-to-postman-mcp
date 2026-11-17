/**
 * Request-chaining plan.
 *
 * Every whole-segment path parameter is bound to the collection it belongs to:
 * in "/booking/{id}" the parameter `id` is bound to the "/booking" collection and
 * resolved through the variable `booking_id`.
 *
 *  - If the collection has a POST, generated suites create a disposable resource
 *    and capture its id (the only resource they ever update or delete).
 *  - Else if it has a GET list, the first listed id is captured (read-only use).
 *  - Otherwise the variable is static and goes into the environment file.
 */
import { pathSegments, isPathParamSegment, literalSegments } from './endpoints.js';
import { generateExample, stripDynamicVariables } from './schema.js';

export class ChainPlan {
  constructor(apiSpec, authContext) {
    this.apiSpec = apiSpec;
    this.bindings = new Map();    // collection path prefix → binding
    this.staticVars = new Map();  // variable name → default value (environment)
    const usedNames = new Set();

    for (const endpoint of apiSpec.endpoints) {
      const segments = pathSegments(endpoint.path);
      segments.forEach((segment, index) => {
        if (isPathParamSegment(segment)) {
          const prefix = '/' + segments.slice(0, index).join('/');
          if (!this.bindings.has(prefix)) {
            let varName = `${(literalSegments(prefix).join('_') || 'root').replace(/[^A-Za-z0-9_]/g, '_')}_id`;
            for (let n = 2; usedNames.has(varName); n++) varName = varName.replace(/(_\d+)?_id$/, `_${n}_id`);
            usedNames.add(varName);
            this.bindings.set(prefix, { prefix, varName, param: null });
          }
          const binding = this.bindings.get(prefix);
          binding.param ??= endpoint.parameters.find(p => p.in === 'path' && p.name === segment.slice(1, -1)) || null;
        } else {
          // Parameters embedded in a segment ("report-{year}.csv") are static values.
          for (const match of segment.matchAll(/\{([^}]+)\}/g)) {
            const param = endpoint.parameters.find(p => p.in === 'path' && p.name === match[1]);
            this.staticVars.set(`param_${match[1]}`, this.exampleFor(param));
          }
        }
      });
    }

    for (const binding of this.bindings.values()) {
      const itemPath = new RegExp(`^${binding.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/$/, '')}/\\{[^}]+\\}$`);
      binding.createOp = apiSpec.endpoints.find(e => e.method === 'POST' && e.path === binding.prefix && !authContext.isAuthEndpoint(e)) || null;
      binding.listOp = apiSpec.endpoints.find(e => e.method === 'GET' && e.path === binding.prefix) || null;
      binding.deleteOp = apiSpec.endpoints.find(e => e.method === 'DELETE' && itemPath.test(e.path)) || null;
      binding.runtime = !!(binding.createOp || binding.listOp);
      if (!binding.runtime) this.staticVars.set(binding.varName, this.exampleFor(binding.param));
    }
  }

  exampleFor(param) {
    if (!param) return '1';
    const value = param.example ?? generateExample(param.schema, { propName: param.name, unique: false });
    if (value === null || value === undefined) return '1';
    return String(stripDynamicVariables(value));
  }

  /** Binding for a whole-segment path parameter of an endpoint. */
  bindingFor(endpoint, paramName) {
    const segments = pathSegments(endpoint.path);
    const index = segments.indexOf(`{${paramName}}`);
    if (index === -1) return null;
    return this.bindings.get('/' + segments.slice(0, index).join('/')) || null;
  }

  varForParam(endpoint, paramName) {
    return this.bindingFor(endpoint, paramName)?.varName ?? `param_${paramName}`;
  }

  /** Bindings for every whole-segment path parameter, outermost first. */
  pathBindings(endpoint) {
    return pathSegments(endpoint.path)
      .filter(isPathParamSegment)
      .map(segment => ({ name: segment.slice(1, -1), binding: this.bindingFor(endpoint, segment.slice(1, -1)) }))
      .filter(entry => entry.binding);
  }

  /** The binding of the resource an item-level operation acts on (its last path parameter). */
  itemBinding(endpoint) {
    const last = pathSegments(endpoint.path).at(-1);
    return last && isPathParamSegment(last) ? this.bindingFor(endpoint, last.slice(1, -1)) : null;
  }

  bindingCreatedBy(endpoint) {
    return [...this.bindings.values()].find(b => b.createOp && b.createOp.key === endpoint.key) || null;
  }

  bindingListedBy(endpoint) {
    return [...this.bindings.values()].find(b => b.listOp && b.listOp.key === endpoint.key) || null;
  }

  /** Runtime (collection-scoped) variables; never written to the environment. */
  runtimeVariables() {
    const names = [];
    for (const binding of this.bindings.values()) {
      if (binding.runtime) names.push(binding.varName, `${binding.varName}__created`);
    }
    return names;
  }
}
