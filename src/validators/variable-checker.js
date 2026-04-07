/**
 * Checks that all {{variables}} referenced in collections are defined
 * and populated in the environment file.
 */

import { scanCollectionVariables } from '../../generate.js';

export class VariableChecker {
  /**
   * @param {object} positiveCollection - Postman positive collection JSON
   * @param {object} negativeCollection - Postman negative collection JSON
   * @param {object} environment - Postman environment JSON ({ values: [{ key, value }] })
   * @returns {{ total: number, resolved: number, missing: string[], empty: string[], unused: string[] }}
   */
  check(positiveCollection, negativeCollection, environment) {
    // Variables set at runtime by test scripts — don't flag as missing
    const runtimeVars = new Set([
      'authCookie', 'sessionToken', 'tenantId',
    ]);
    const runtimePrefixes = ['created_', 'valid_'];

    const isRuntimeVar = (name) => {
      if (runtimeVars.has(name)) return true;
      return runtimePrefixes.some(p => name.startsWith(p));
    };

    // Collect all {{var}} references from both collections
    const positiveVars = scanCollectionVariables(positiveCollection);
    const negativeVars = scanCollectionVariables(negativeCollection);
    const allReferenced = new Set([...positiveVars, ...negativeVars]);

    // Build map of environment values
    const envMap = new Map();
    for (const v of (environment.values || [])) {
      envMap.set(v.key, v.value || '');
    }

    const missing = [];
    const empty = [];
    const resolved = [];

    for (const varName of allReferenced) {
      if (isRuntimeVar(varName)) {
        // Runtime vars are expected to be empty or placeholder — skip
        continue;
      }

      if (!envMap.has(varName)) {
        missing.push(varName);
      } else if (envMap.get(varName) === '' || envMap.get(varName).startsWith('(set at runtime')) {
        empty.push(varName);
      } else {
        resolved.push(varName);
      }
    }

    // Find unused env variables (defined but never referenced)
    const unused = [];
    for (const [key] of envMap) {
      if (!allReferenced.has(key) && !isRuntimeVar(key)) {
        unused.push(key);
      }
    }

    const total = resolved.length + missing.length + empty.length;

    return {
      total,
      resolved: resolved.length,
      missing: missing.sort(),
      empty: empty.sort(),
      unused: unused.sort(),
    };
  }
}
