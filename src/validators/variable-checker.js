/**
 * Checks that every {{variable}} a collection references will resolve at run time:
 * from the environment, from a collection-level default, or from a script that
 * assigns it during the run (captured ids, auth tokens).
 */
import { scanCollectionVariables, scanScriptAssignedVariables } from '../core/environment.js';

const CONFIG_VARIABLES = new Set(['responseTimeThresholdMs', 'allowMutationOfExistingData']);

export class VariableChecker {
  /**
   * @param {object} positiveCollection
   * @param {object} negativeCollection
   * @param {object} environment Postman environment ({ values: [{ key, value }] })
   * @returns {{ total:number, resolved:number, missing:string[], empty:string[], unused:string[], runtime:string[] }}
   */
  check(positiveCollection, negativeCollection, environment) {
    const collections = [positiveCollection, negativeCollection].filter(Boolean);
    const referenced = new Set();
    const runtime = new Set();
    const declared = new Map();
    for (const collection of collections) {
      scanCollectionVariables(collection).forEach(v => referenced.add(v));
      scanScriptAssignedVariables(collection).forEach(v => runtime.add(v));
      for (const v of collection.variable || []) declared.set(v.key, v.value ?? '');
    }

    const env = new Map((environment?.values || []).filter(v => v.enabled !== false).map(v => [v.key, v.value ?? '']));
    const missing = [];
    const empty = [];
    const resolved = [];
    const runtimeReferenced = [];

    for (const name of referenced) {
      if (runtime.has(name)) { runtimeReferenced.push(name); continue; }
      if (env.has(name)) {
        (env.get(name) === '' ? empty : resolved).push(name);
      } else if (declared.has(name)) {
        (declared.get(name) === '' ? empty : resolved).push(name);
      } else {
        missing.push(name);
      }
    }

    const unused = [...env.keys()].filter(key => !referenced.has(key) && !CONFIG_VARIABLES.has(key));
    return {
      total: resolved.length + missing.length + empty.length,
      resolved: resolved.length,
      missing: missing.sort(),
      empty: empty.sort(),
      unused: unused.sort(),
      runtime: runtimeReferenced.sort(),
    };
  }
}
