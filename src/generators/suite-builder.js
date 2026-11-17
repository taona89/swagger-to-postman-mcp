/**
 * Shared building blocks for the positive and negative Postman suites.
 */
import { randomUUID } from 'node:crypto';
import { AuthContext } from '../core/auth.js';
import { ChainPlan } from '../core/plan.js';
import { buildRequest } from '../core/request.js';
import { successExpectation, resourceName, pathSegments, isPathParamSegment } from '../core/endpoints.js';
import { toJsonSchema, idKeyCandidates, flattenSchema } from '../core/schema.js';
import { TestScriptGenerator } from './test-script-generator.js';

const COLLECTION_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const USERNAME_FIELD = /^(user(_?name)?|login|email)$/i;
const PASSWORD_FIELD = /^pass(word)?$/i;

export const depth = endpoint => pathSegments(endpoint.path).length;

export class SuiteBuilder {
  constructor(apiSpec, options = {}) {
    this.apiSpec = apiSpec;
    this.responseTimeMs = options.responseTimeMs ?? 5000;
    this.auth = new AuthContext(apiSpec);
    this.plan = new ChainPlan(apiSpec, this.auth);
    /** Default environment values contributed by this suite (name → value). */
    this.envDefaults = new Map(this.plan.staticVars);
  }

  get ctx() {
    return { plan: this.plan, auth: this.auth };
  }

  makeItem({ name, request, prerequest = [], test = [], description, disableCookies = false }) {
    const event = [];
    if (prerequest.length > 0) event.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: prerequest } });
    if (test.length > 0) event.push({ listen: 'test', script: { type: 'text/javascript', exec: test } });
    const item = { name, event, request };
    if (description) item.description = description;
    // Stops the Newman/Postman cookie jar from re-sending session cookies
    if (disableCookies) item.protocolProfileBehavior = { disableCookies: true };
    return item;
  }

  /** Documented responses (filtered by status) as { code: { json, schema } } for contract checks. */
  contractFor(endpoint, filter) {
    const contract = {};
    for (const [code, response] of Object.entries(endpoint.responses || {})) {
      if (!/^\d{3}$/.test(code) || !filter(Number(code))) continue;
      const json = /json/i.test(response.contentType || '');
      let schema = null;
      if (json && response.schema) {
        const converted = toJsonSchema(response.schema, { mode: 'response' });
        schema = Object.keys(converted).length > 0 ? converted : null;
      }
      if (json || schema) contract[code] = { json, schema };
    }
    return contract;
  }

  successSchema(endpoint) {
    const codes = Object.keys(endpoint.responses || {}).filter(c => /^2\d\d$/.test(c)).sort();
    for (const code of codes) if (endpoint.responses[code].schema) return endpoint.responses[code].schema;
    return null;
  }

  /** Runtime path variables an endpoint needs. */
  requiredVars(endpoint) {
    return this.plan.pathBindings(endpoint).filter(e => e.binding.runtime).map(e => e.binding.varName);
  }

  /**
   * Ownership requirements for a request that can modify existing data:
   * every PUT/PATCH/DELETE, and every POST whose path contains a parameter
   * (sub-resources, actions like /orders/{id}/cancel).
   *  - each path resource must have been created by this run (owned), except
   *    parameters replaced by fake values (`exclude`, e.g. a non-existent id);
   *  - requests that no run can own (collection-level update/delete, path
   *    values from the environment) need the explicit opt-in.
   * @returns {{ ownedVars: string[], needsOptIn: boolean, reason: string|null }}
   */
  mutationGuard(endpoint, { exclude = [] } = {}) {
    const segments = pathSegments(endpoint.path);
    const hasParams = segments.some(s => s.includes('{'));
    const mutating = ['PUT', 'PATCH', 'DELETE'].includes(endpoint.method) || (endpoint.method === 'POST' && hasParams);
    if (!mutating) return { ownedVars: [], needsOptIn: false, reason: null };

    if (segments.some(s => s.includes('{') && !isPathParamSegment(s))) {
      return { ownedVars: [], needsOptIn: true, reason: 'path value comes from the environment' };
    }
    if (!hasParams) return { ownedVars: [], needsOptIn: true, reason: 'collection-level operation' };

    const remaining = this.plan.pathBindings(endpoint).filter(entry => !exclude.includes(entry.name));
    const unowned = remaining.filter(entry => !entry.binding.createOp);
    if (unowned.length > 0) {
      return { ownedVars: [], needsOptIn: true, reason: `no create endpoint for ${unowned.map(e => e.binding.prefix).join(', ')}` };
    }
    return { ownedVars: remaining.map(entry => entry.binding.varName), needsOptIn: false, reason: null };
  }

  guard(endpoint, label, { exclude = [] } = {}) {
    const { ownedVars, needsOptIn } = this.mutationGuard(endpoint, { exclude });
    return TestScriptGenerator.guardScript({
      label,
      requiredVars: this.requiredVars(endpoint).filter(name => !this.plan.pathBindings(endpoint)
        .some(entry => exclude.includes(entry.name) && entry.binding.varName === name)),
      ownedVars,
      needsOptIn,
    });
  }

  /**
   * Authentication request; credentials come from {{username}} / {{password}}.
   * The environment is pre-filled only with credentials the spec itself gives as
   * examples; generated placeholders stay empty so the user is asked to fill them.
   */
  authItem() {
    const endpoint = this.auth.authEndpoint;
    let body = endpoint.requestBody?.example;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      body = { ...body };
      const properties = flattenSchema(endpoint.requestBody.schema).properties || {};
      for (const [key, value] of Object.entries(body)) {
        const prop = properties[key] || {};
        const fromSpec = endpoint.requestBody.exampleFromSpec || prop.example !== undefined || prop.default !== undefined;
        const defaultValue = fromSpec && value !== null && value !== undefined ? String(value) : '';
        if (USERNAME_FIELD.test(key)) { this.envDefaults.set('username', defaultValue); body[key] = '{{username}}'; }
        if (PASSWORD_FIELD.test(key)) { this.envDefaults.set('password', defaultValue); body[key] = '{{password}}'; }
      }
    }
    return this.makeItem({
      name: 'Authenticate',
      description: 'Obtains a token for all subsequent requests. Credentials come from the environment.',
      request: buildRequest(endpoint, this.ctx, { body }),
      test: TestScriptGenerator.authScript(successExpectation(endpoint), this.contractFor(endpoint, code => code >= 200 && code < 300)),
    });
  }

  createCapture(endpoint) {
    const binding = this.plan.bindingCreatedBy(endpoint);
    if (!binding) return null;
    return { kind: 'create', varName: binding.varName, keys: idKeyCandidates(this.successSchema(endpoint), resourceName(endpoint)) };
  }

  listCapture(endpoint) {
    const binding = this.plan.bindingListedBy(endpoint);
    if (!binding) return null;
    return { kind: 'list', varName: binding.varName, keys: idKeyCandidates(this.successSchema(endpoint), resourceName(endpoint)) };
  }

  /** Positive-style request (used for setup/teardown in both suites). */
  positiveItem(endpoint, { name, capture = null, release = null, request, prerequest = [] }) {
    return this.makeItem({
      name,
      description: endpoint.description || endpoint.summary || undefined,
      request: request || buildRequest(endpoint, this.ctx),
      prerequest: [...this.guard(endpoint, name), ...prerequest],
      test: TestScriptGenerator.positiveScript(endpoint, {
        expectation: successExpectation(endpoint),
        contract: this.contractFor(endpoint, code => code >= 200 && code < 300),
        capture,
        release,
      }),
    });
  }

  runtimeVariables() {
    const names = this.plan.runtimeVariables();
    if (this.auth.authEndpoint) names.push(...this.auth.credentialVariables());
    return names;
  }

  /** Assemble the collection; the first request resets run state. */
  collection(name, description, folders) {
    const nonEmpty = folders.filter(f => f.item.length > 0);
    const runtime = this.runtimeVariables();
    const first = nonEmpty[0]?.item[0];
    if (first && runtime.length > 0) {
      const reset = TestScriptGenerator.resetScript(runtime);
      const pre = first.event.find(e => e.listen === 'prerequest');
      if (pre) pre.script.exec = [...reset, ...pre.script.exec];
      else first.event.unshift({ listen: 'prerequest', script: { type: 'text/javascript', exec: reset } });
    }
    return {
      info: { _postman_id: randomUUID(), name, description, schema: COLLECTION_SCHEMA },
      variable: [
        { key: 'baseUrl', value: this.apiSpec.baseUrl || '', type: 'string' },
        { key: 'responseTimeThresholdMs', value: String(this.responseTimeMs), type: 'string' },
        { key: 'allowMutationOfExistingData', value: 'false', type: 'string' },
        ...runtime.map(key => ({ key, value: '', type: 'string' })),
      ],
      item: nonEmpty,
    };
  }
}
