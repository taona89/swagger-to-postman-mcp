/**
 * Shared building blocks for the positive and negative Postman suites.
 */
import { randomUUID } from 'node:crypto';
import { AuthContext } from '../core/auth.js';
import { ChainPlan } from '../core/plan.js';
import { buildRequest } from '../core/request.js';
import { successExpectation, resourceName, pathSegments } from '../core/endpoints.js';
import { toJsonSchema, idKeyCandidates } from '../core/schema.js';
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

  /** Item-level resource a PUT/PATCH/DELETE mutates; must be created by this run. */
  ownedVars(endpoint) {
    if (!['PUT', 'PATCH', 'DELETE'].includes(endpoint.method)) return [];
    const binding = this.plan.itemBinding(endpoint);
    return binding ? [binding.varName] : [];
  }

  guard(endpoint, label, { owned = true } = {}) {
    return TestScriptGenerator.guardScript({
      label,
      requiredVars: this.requiredVars(endpoint),
      ownedVars: owned ? this.ownedVars(endpoint) : [],
    });
  }

  /** Authentication request; credentials come from {{username}} / {{password}}. */
  authItem() {
    const endpoint = this.auth.authEndpoint;
    let body = endpoint.requestBody?.example;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      body = { ...body };
      for (const [key, value] of Object.entries(body)) {
        if (USERNAME_FIELD.test(key)) { this.envDefaults.set('username', String(value ?? '')); body[key] = '{{username}}'; }
        if (PASSWORD_FIELD.test(key)) { this.envDefaults.set('password', String(value ?? '')); body[key] = '{{password}}'; }
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
