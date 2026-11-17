/**
 * Test Script Generator
 * Builds Postman pre-request and test scripts.
 *
 * Every value that comes from the OpenAPI document is embedded with js(), i.e.
 * as a JSON literal, so spec content can never become executable code.
 */
import { js } from '../core/escape.js';
import { codesLabel } from '../core/endpoints.js';

const ID_WRAPPERS = ['data', 'item', 'result'];
const LIST_WRAPPERS = ['data', 'items', 'results', 'content', 'records', 'value'];

/** Shared runtime helper that finds an id in a response body. */
function pickIdFunction() {
  return [
    'function pickId(value, keys, wrappers) {',
    '    if (!value || typeof value !== "object") return undefined;',
    '    for (const key of keys) {',
    '        if (value[key] !== undefined && value[key] !== null && value[key] !== "") return value[key];',
    '    }',
    '    for (const wrapper of wrappers) {',
    '        const found = pickId(value[wrapper], keys, []);',
    '        if (found !== undefined) return found;',
    '    }',
    '    return undefined;',
    '}',
  ];
}

function expectStatus(title, expectation) {
  if (!expectation.codes) {
    return [
      `pm.test(${js(title)}, function () {`,
      '    pm.expect(pm.response.code).to.be.within(200, 299);',
      '});',
    ];
  }
  return [
    `pm.test(${js(title)}, function () {`,
    `    pm.expect(pm.response.code).to.be.oneOf(${js(expectation.codes)});`,
    '});',
  ];
}

/** Contract checks for whichever documented response code was actually returned. */
function contractChecks(contract, label) {
  if (!contract || Object.keys(contract).length === 0) return [];
  return [
    '',
    `const DOCUMENTED_RESPONSES = ${js(contract)};`,
    'const documented = DOCUMENTED_RESPONSES[String(pm.response.code)];',
    'if (documented && documented.json) {',
    `    pm.test(${js(`[CONTRACT] ${label} Content-Type is JSON`)}, function () {`,
    '        pm.expect(pm.response.headers.get("Content-Type") || "").to.include("json");',
    '    });',
    '}',
    'if (documented && documented.schema) {',
    `    pm.test(${js(`[CONTRACT] ${label} body matches the documented schema`)}, function () {`,
    '        pm.response.to.have.jsonSchema(documented.schema);',
    '    });',
    '}',
  ];
}

export class TestScriptGenerator {
  /** Clears chain variables at the start of a run so stale ids are never reused. */
  static resetScript(variables) {
    if (!variables || variables.length === 0) return [];
    return [
      '// Reset run state: ids captured by earlier runs must not leak into this one',
      `${js(variables)}.forEach(function (name) { pm.collectionVariables.unset(name); });`,
    ];
  }

  /**
   * Skip a request when its prerequisites are missing:
   *  - requiredVars: path variables that must resolve
   *  - ownedVars: resources this request mutates; they must have been created by
   *    this run, and the value actually used ({{name}}) must be the captured one
   *    (an environment or data value of the same name would take precedence)
   *  - needsOptIn: the request modifies data no run can own (collection-level
   *    update/delete, values from the environment); runs only with
   *    allowMutationOfExistingData=true
   * Fails closed: on runners without pm.execution.skipRequest the request is
   * redirected to an unroutable host instead of being sent.
   */
  static guardScript({ label, requiredVars = [], ownedVars = [], needsOptIn = false }) {
    if (requiredVars.length === 0 && ownedVars.length === 0 && !needsOptIn) return [];
    return [
      '(function () {',
      `    const required = ${js(requiredVars)};`,
      `    const owned = ${js(ownedVars)};`,
      `    const needsOptIn = ${js(needsOptIn)};`,
      '    const missing = required.filter(function (name) {',
      '        const value = pm.variables.get(name);',
      '        return value === undefined || value === null || value === "";',
      '    });',
      '    // Opt-in escape hatch: allowMutationOfExistingData=true lets requests modify records this run did not create',
      '    const allowExisting = String(pm.variables.get("allowMutationOfExistingData")) === "true";',
      '    const notOwned = allowExisting ? [] : owned.filter(function (name) {',
      '        return pm.collectionVariables.get(name + "__created") !== "true" ||',
      '            String(pm.variables.get(name)) !== String(pm.collectionVariables.get(name));',
      '    });',
      '    const blockedByOptIn = needsOptIn && !allowExisting;',
      '    if (missing.length > 0 || notOwned.length > 0 || blockedByOptIn) {',
      `        console.warn("[SKIPPED] " + ${js(label)} +`,
      '            (missing.length ? " - unresolved variables: " + missing.join(", ") : "") +',
      '            (notOwned.length ? " - only runs against resources created by this run: " + notOwned.join(", ") : "") +',
      '            (blockedByOptIn ? " - modifies data this run did not create; set allowMutationOfExistingData=true to run it" : ""));',
      '        let skipped = false;',
      '        try {',
      '            if (pm.execution && typeof pm.execution.skipRequest === "function") { pm.execution.skipRequest(); skipped = true; }',
      '        } catch (e) { skipped = false; }',
      '        if (!skipped) {',
      '            // Runner without skipRequest (Newman < 6.1): fail closed',
      '            pm.request.url.update("http://request-skipped.invalid/");',
      '        }',
      '    }',
      '})();',
    ];
  }

  /** Test script for the authentication request: asserts success and stores the token. */
  static authScript(expectation, contract) {
    return [
      `// expected-status: ${codesLabel(expectation.codes)}`,
      ...expectStatus('[AUTH] Authentication request succeeds', expectation),
      ...contractChecks(contract, 'Auth response'),
      '',
      '(function () {',
      '    let body;',
      '    try { body = pm.response.json(); } catch (e) { body = undefined; }',
      '    const keys = ["token", "access_token", "accessToken", "id_token", "idToken", "jwt", "auth_token", "authToken", "apiKey", "api_key"];',
      '    function findToken(value, depth) {',
      '        if (!value || typeof value !== "object" || depth > 2) return undefined;',
      '        for (const key of keys) {',
      '            if (typeof value[key] === "string" && value[key]) return value[key];',
      '        }',
      '        return findToken(value.data, depth + 1) || findToken(value.result, depth + 1);',
      '    }',
      '    const token = findToken(body, 0);',
      '    const hasCookie = pm.response.headers.has("Set-Cookie");',
      '    pm.test("[AUTH] Response provides a token or a session cookie", function () {',
      '        pm.expect(Boolean(token) || hasCookie, "no token field and no Set-Cookie header in the auth response").to.be.true;',
      '    });',
      '    if (token) {',
      '        pm.collectionVariables.set("token", token);',
      '        pm.collectionVariables.set("apiKey", token);',
      '        console.log("Auth token stored");',
      '    }',
      '})();',
    ];
  }

  /**
   * Positive test script.
   * @param {object} endpoint
   * @param {object} options
   * @param {{codes:number[]|null}} options.expectation success oracle
   * @param {object} options.contract map of status code → { json, schema }
   * @param {object} [options.capture] { kind: 'create'|'list', varName, keys }
   * @param {object} [options.release] { varName } – resource deleted by this request
   */
  static positiveScript(endpoint, { expectation, contract, capture, release }) {
    const label = `${endpoint.method} ${endpoint.path}`;
    const lines = [
      `// expected-status: ${codesLabel(expectation.codes)}`,
      ...expectStatus(`[POSITIVE] ${label} returns ${codesLabel(expectation.codes)}`, expectation),
      '',
      'pm.test("[PERFORMANCE] Response time is below the threshold", function () {',
      '    const limit = Number(pm.variables.get("responseTimeThresholdMs")) || 5000;',
      '    pm.expect(pm.response.responseTime).to.be.below(limit);',
      '});',
    ];

    if (expectation.codes?.includes(204)) {
      lines.push(
        '',
        'if (pm.response.code === 204) {',
        '    pm.test("[PAYLOAD] 204 response has no body", function () {',
        '        pm.expect(pm.response.text()).to.be.empty;',
        '    });',
        '}',
      );
    }
    lines.push(...contractChecks(contract, 'Response'));

    if (capture?.kind === 'create') {
      lines.push(
        '',
        '// Capture the id of the created resource; later requests act only on it',
        'if (pm.response.code >= 200 && pm.response.code < 300) {',
        ...pickIdFunction().map(l => `    ${l}`),
        '    let body;',
        '    try { body = pm.response.json(); } catch (e) { body = undefined; }',
        `    let id = pickId(body, ${js(capture.keys)}, ${js(ID_WRAPPERS)});`,
        '    if (id === undefined && pm.response.headers.has("Location")) {',
        '        id = String(pm.response.headers.get("Location")).split("?")[0].replace(/\\/+$/, "").split("/").pop() || undefined;',
        '    }',
        `    pm.test(${js(`[CHAIN] Created resource id is returned (${capture.keys.slice(0, 3).join(', ')}...)`)}, function () {`,
        '        pm.expect(id, "no id field in the response body and no Location header").to.exist;',
        '    });',
        '    if (id !== undefined) {',
        `        pm.collectionVariables.set(${js(capture.varName)}, id);`,
        `        pm.collectionVariables.set(${js(`${capture.varName}__created`)}, "true");`,
        `        console.log(${js(`Captured ${capture.varName}:`)}, id);`,
        '    }',
        '}',
      );
    }

    if (capture?.kind === 'list') {
      lines.push(
        '',
        '// Capture the first listed id for read-only requests (never used for updates or deletes)',
        `if (pm.response.code >= 200 && pm.response.code < 300 && !pm.collectionVariables.get(${js(capture.varName)})) {`,
        ...pickIdFunction().map(l => `    ${l}`),
        '    let body;',
        '    try { body = pm.response.json(); } catch (e) { body = undefined; }',
        `    const list = Array.isArray(body) ? body : (body && ${js(LIST_WRAPPERS)}.map(function (k) { return body[k]; }).find(Array.isArray));`,
        `    const id = list && list.length > 0 ? pickId(list[0], ${js(capture.keys)}, ${js(ID_WRAPPERS)}) : undefined;`,
        '    if (id !== undefined) {',
        `        pm.collectionVariables.set(${js(capture.varName)}, id);`,
        `        console.log(${js(`Captured ${capture.varName} from list:`)}, id);`,
        '    }',
        '}',
      );
    }

    if (release) {
      lines.push(
        '',
        'if (pm.response.code >= 200 && pm.response.code < 300) {',
        `    pm.collectionVariables.unset(${js(`${release.varName}__created`)});`,
        `    pm.collectionVariables.unset(${js(release.varName)});`,
        '}',
      );
    }
    return lines;
  }

  /**
   * Negative test script: one fault per request, one status oracle.
   * @param {object} endpoint
   * @param {object} options
   * @param {string} options.title test title
   * @param {{codes:number[], specGap:boolean}} options.expectation
   * @param {object} options.contract map of status code → { json, schema }
   */
  static negativeScript(endpoint, { title, expectation, contract }) {
    const lines = [
      `// expected-status: ${codesLabel(expectation.codes)}`,
    ];
    if (expectation.specGap) {
      // Never put spec text in comments: a line terminator in it would end the comment.
      lines.push(`// spec gap: none of ${expectation.codes.map(Number).join('/')} is documented for this operation`);
    }
    lines.push(
      `pm.test(${js(`${title} → ${codesLabel(expectation.codes)}`)}, function () {`,
      `    pm.expect(pm.response.code, "status code").to.be.oneOf(${js(expectation.codes)});`,
      '});',
      ...contractChecks(contract, 'Error response'),
    );
    return lines;
  }

  /**
   * Data-driven body: overlays Newman iteration data onto the example body with
   * the schema's JSON types restored. Columns are named "body.<path>" so they can
   * never shadow variables such as {{username}} (data scope outranks the environment).
   */
  static dataDrivenBodyScript(example, types) {
    return [
      '(function () {',
      `    const body = ${js(example)};`,
      `    const types = ${js(types)};`,
      '    const data = pm.iterationData.toObject();',
      '    function coerce(value, type) {',
      '        if (type === "string") return value === null || value === undefined ? value : String(value);',
      '        if (typeof value !== "string") return value;',
      '        if (type === "integer" || type === "number") {',
      '            const n = Number(value);',
      '            return value.trim() !== "" && !Number.isNaN(n) ? n : value;',
      '        }',
      '        if (type === "boolean") return value === "true" ? true : value === "false" ? false : value;',
      '        if (type === "array" || type === "object") {',
      '            try { return JSON.parse(value); } catch (e) { return value; }',
      '        }',
      '        return value;',
      '    }',
      '    function setOwn(target, key, value) {',
      '        Object.defineProperty(target, key, { value: value, enumerable: true, writable: true, configurable: true });',
      '    }',
      '    Object.keys(types).forEach(function (path) {',
      '        const column = "body." + path;',
      '        if (!Object.prototype.hasOwnProperty.call(data, column)) return;',
      '        const keys = path.split(".");',
      '        let target = body;',
      '        for (let i = 0; i < keys.length - 1; i++) {',
      '            const next = Object.prototype.hasOwnProperty.call(target, keys[i]) ? target[keys[i]] : undefined;',
      '            if (typeof next !== "object" || next === null) setOwn(target, keys[i], {});',
      '            target = target[keys[i]];',
      '        }',
      '        setOwn(target, keys[keys.length - 1], coerce(data[column], types[path]));',
      '    });',
      '    pm.variables.set("requestBody", JSON.stringify(body));',
      '})();',
    ];
  }
}
