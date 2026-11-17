import {
  categorizeEndpoints, negativeExpectation, NEGATIVE_SCENARIOS, BODY_METHODS, codesLabel,
} from '../core/endpoints.js';
import { buildRequest } from '../core/request.js';
import { flattenSchema, schemaType, wrongTypeValue, forbidsEmptyString } from '../core/schema.js';
import { SuiteBuilder, depth } from './suite-builder.js';
import { TestScriptGenerator } from './test-script-generator.js';

const MAX_FIELD_TESTS = 25;
const NON_EXISTENT_UUID = 'ffffffff-ffff-4fff-bfff-ffffffffffff';

/**
 * Negative Test Generator
 *
 * Each test changes exactly one thing in an otherwise valid request (valid
 * credentials, valid ids of resources created in setup, valid body), so a
 * rejection can only be caused by the fault under test.
 *
 * Status oracle: the codes that are correct for the scenario (e.g. 400/422 for
 * a missing field) intersected with the codes the spec documents. When the spec
 * documents none of them, the conventional codes are asserted and the operation
 * is reported as a spec gap.
 */
export class NegativeTestGenerator extends SuiteBuilder {
  constructor(apiSpec, options = {}) {
    super(apiSpec, options);
    /** [{ operation, scenario, assertedCodes }] — scenarios the spec does not document. */
    this.specGaps = [];
  }

  generate() {
    const crud = categorizeEndpoints(this.apiSpec.endpoints, this.auth.authEndpoint);
    const bindings = [...this.plan.bindings.values()].filter(b => b.runtime)
      .sort((a, b) => a.prefix.split('/').length - b.prefix.split('/').length);

    // Setup: credentials + one disposable resource per creatable collection
    const setup = this.auth.authEndpoint ? [this.authItem()] : [];
    for (const binding of bindings) {
      if (binding.createOp) {
        setup.push(this.positiveItem(binding.createOp, {
          name: `Create disposable resource: POST ${binding.createOp.path}`,
          capture: this.createCapture(binding.createOp),
        }));
      } else if (binding.listOp) {
        setup.push(this.positiveItem(binding.listOp, {
          name: `Find an existing id: GET ${binding.listOp.path}`,
          capture: this.listCapture(binding.listOp),
        }));
      }
    }

    const operations = [...crud.create, ...crud.update, ...crud.delete, ...crud.read, ...crud.list]
      .map(endpoint => ({ endpoint, tests: this.operationTests(endpoint) }))
      .filter(entry => entry.tests.length > 0);
    const folders = [{ name: '0. Setup', description: 'Authentication and disposable test data', item: setup }];
    operations.forEach(({ endpoint, tests }, index) => {
      folders.push({
        name: `${index + 1}. ${endpoint.method} ${endpoint.path}`,
        description: `Negative scenarios for ${endpoint.method} ${endpoint.path}`,
        item: tests,
      });
    });

    // Teardown: delete what setup created, children first
    const teardown = bindings
      .filter(b => b.createOp && b.deleteOp)
      .sort((a, b) => depth(b.deleteOp) - depth(a.deleteOp))
      .map(b => this.positiveItem(b.deleteOp, {
        name: `Delete disposable resource: DELETE ${b.deleteOp.path}`,
        release: { varName: b.varName },
      }));
    folders.push({ name: `${operations.length + 1}. Teardown`, description: 'Removes the disposable resources created in setup', item: teardown });

    return this.collection(
      `${this.apiSpec.info.title} - Negative Test Suite`,
      `Negative scenarios for ${this.apiSpec.info.title}: one fault per request, status codes checked against the spec.`,
      folders,
    );
  }

  operationTests(endpoint) {
    const tests = [];
    const body = endpoint.requestBody;
    const jsonBody = body && /json/i.test(body.contentType);

    if (BODY_METHODS.includes(endpoint.method) && jsonBody) {
      const schema = flattenSchema(body.schema);
      const example = body.example;
      if (schemaType(schema) === 'object' && example && typeof example === 'object' && !Array.isArray(example)) {
        for (const field of schema.required || []) {
          const value = structuredClone(example);
          delete value[field];
          tests.push(this.negativeItem(endpoint, 'missingField', `missing required field "${field}"`, { body: value }));
        }
        for (const [field, prop] of Object.entries(schema.properties || {}).slice(0, MAX_FIELD_TESTS)) {
          if (prop?.readOnly) continue;
          const wrong = wrongTypeValue(prop);
          if (wrong === undefined) continue;
          tests.push(this.negativeItem(endpoint, 'wrongType', `"${field}" has the wrong type (${schemaType(prop)} expected)`, {
            body: { ...structuredClone(example), [field]: wrong },
          }));
        }
        for (const [field, prop] of Object.entries(schema.properties || {}).slice(0, MAX_FIELD_TESTS)) {
          if (prop?.readOnly || !forbidsEmptyString(prop)) continue;
          tests.push(this.negativeItem(endpoint, 'emptyValue', `"${field}" is an empty string`, {
            body: { ...structuredClone(example), [field]: '' },
          }));
        }
      }
      tests.push(this.negativeItem(endpoint, 'malformedJson', 'malformed JSON body', { rawBody: '{ "malformed": ' }));
    }

    const itemBinding = this.plan.itemBinding(endpoint);
    if (itemBinding) {
      const paramName = endpoint.path.split('/').at(-1).slice(1, -1);
      const param = endpoint.parameters.find(p => p.in === 'path' && p.name === paramName);
      const invalid = this.invalidIdValue(param);
      if (invalid !== null) {
        tests.push(this.negativeItem(endpoint, 'invalidId', `invalid "${paramName}" format (${invalid})`, {
          pathOverrides: { [paramName]: invalid }, owned: false,
        }));
      }
      const missing = this.nonExistentIdValue(param);
      if (missing !== null) {
        tests.push(this.negativeItem(endpoint, 'nonExistentId', `non-existent "${paramName}"`, {
          pathOverrides: { [paramName]: missing }, owned: false,
        }));
      }
    }

    if (this.auth.requiresAuth(endpoint)) {
      tests.push(this.negativeItem(endpoint, 'noAuth', 'no credentials', { omitAuth: true }));
    }
    return tests;
  }

  /**
   * @param {object} endpoint
   * @param {string} scenario key of NEGATIVE_SCENARIOS
   * @param {string} detail human description of the single fault
   * @param {object} options body | rawBody | pathOverrides | omitAuth | owned
   */
  negativeItem(endpoint, scenario, detail, options = {}) {
    const expectation = negativeExpectation(endpoint, scenario);
    if (expectation.specGap && !this.specGaps.some(g => g.operation === endpoint.key && g.scenario === scenario)) {
      this.specGaps.push({ operation: endpoint.key, scenario: NEGATIVE_SCENARIOS[scenario].label, assertedCodes: expectation.codes });
    }
    const name = `[NEG] ${endpoint.method} ${endpoint.path} - ${detail}`;
    return this.makeItem({
      name,
      description: `Expects ${codesLabel(expectation.codes)}${expectation.specGap ? ' (not documented in the spec)' : ''}.`,
      request: buildRequest(endpoint, this.ctx, options),
      prerequest: this.guard(endpoint, name, { owned: options.owned !== false }),
      test: TestScriptGenerator.negativeScript(endpoint, {
        title: name,
        expectation,
        contract: this.contractFor(endpoint, code => code >= 400 && code < 500),
      }),
      disableCookies: !!options.omitAuth,
    });
  }

  invalidIdValue(param) {
    const schema = flattenSchema(param?.schema || {});
    const type = schemaType(schema);
    if (type === 'integer' || type === 'number') return 'not-a-number';
    if (schema.format === 'uuid') return 'not-a-uuid';
    if (schema.pattern) {
      try { if (!new RegExp(schema.pattern).test('!invalid!')) return '!invalid!'; } catch { return null; }
    }
    return null; // any string is a syntactically valid id
  }

  nonExistentIdValue(param) {
    const schema = flattenSchema(param?.schema || {});
    const type = schemaType(schema);
    if (type === 'integer' || type === 'number') {
      return typeof schema.maximum === 'number' ? schema.maximum : 2147483647;
    }
    if (schema.format === 'uuid') return NON_EXISTENT_UUID;
    if (schema.pattern) return null;
    return 'does-not-exist-{{$timestamp}}';
  }
}
