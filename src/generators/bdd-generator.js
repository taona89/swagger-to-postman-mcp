/**
 * BDD Test Case Generator
 * Generates Gherkin .feature files from an OpenAPI spec.
 *
 * The scenarios are specification-level test cases (no step definitions are
 * generated). They use the same oracles as the Postman suites, so a scenario and
 * its Postman test always agree on the expected status code.
 */
import { AuthContext } from '../core/auth.js';
import {
  successExpectation, negativeExpectation, codesLabel, resourceName, hasPathParams, BODY_METHODS,
} from '../core/endpoints.js';
import { flattenSchema, schemaType, generateExample, stripDynamicVariables } from '../core/schema.js';
import { gherkinText, gherkinCell } from '../core/escape.js';

const statusStep = expectation => (expectation.codes && expectation.codes.length === 1
  ? `Then the response status code should be ${expectation.codes[0]}`
  : `Then the response status code should be ${codesLabel(expectation.codes)}`);

export class BDDGenerator {
  constructor(apiSpec) {
    this.apiSpec = apiSpec;
    this.auth = new AuthContext(apiSpec);
  }

  /** One feature file per resource: Map of filename → content (names unique, case-insensitively). */
  generate() {
    const features = new Map();
    const used = new Set();
    for (const [resource, endpoints] of this.groupByResource()) {
      const base = this.sanitize(resource);
      let name = base;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}_${n}`;
      used.add(name.toLowerCase());
      features.set(`${name}.feature`, this.generateFeature(resource, endpoints));
    }
    return features;
  }

  /** All resources in one feature file. */
  generateSingleFile() {
    const lines = [
      '# Auto-generated BDD test cases from OpenAPI specification',
      `# API: ${gherkinText(this.apiSpec.info.title)} v${gherkinText(this.apiSpec.info.version)}`,
      '# Specification-level scenarios: step definitions are not generated.',
      '',
    ];
    for (const [resource, endpoints] of this.groupByResource()) {
      lines.push(this.generateFeature(resource, endpoints), '');
    }
    return lines.join('\n');
  }

  generateFeature(resource, endpoints) {
    const featureName = this.formatFeatureName(resource);
    const lines = [
      `Feature: ${featureName}`,
      '  As an API consumer',
      `  I want to interact with the ${featureName} endpoints`,
      `  So that I can manage ${gherkinText(resource)} resources`,
      '',
      '  Background:',
      '    Given the API base URL is configured',
      '',
    ];
    for (const endpoint of endpoints) {
      if (this.auth.isAuthEndpoint(endpoint)) continue;
      for (const scenario of [...this.positiveScenarios(endpoint), ...this.negativeScenarios(endpoint)]) {
        lines.push(scenario, '');
      }
    }
    return lines.join('\n');
  }

  positiveScenarios(endpoint) {
    const scenarios = [];
    const expectation = successExpectation(endpoint);
    const path = gherkinText(endpoint.path);
    const lines = [
      `  @positive @${endpoint.method.toLowerCase()}`,
      `  Scenario: Successfully ${this.describeAction(endpoint)} (${endpoint.method} ${path})`,
    ];
    if (this.auth.sendsAuth(endpoint)) lines.push('    Given I am authenticated');
    for (const param of endpoint.parameters.filter(p => p.in === 'path')) {
      lines.push(`    And a "${gherkinText(param.name)}" of a resource created by this test exists`);
    }

    const fields = this.bodyFields(endpoint);
    if (fields.length > 0) {
      lines.push(`    When I send a ${endpoint.method} request to "${path}" with the body:`);
      lines.push('      | field | type | required | example |');
      for (const field of fields) {
        lines.push(`      | ${gherkinCell(field.name)} | ${gherkinCell(field.type)} | ${field.required ? 'yes' : 'no'} | ${gherkinCell(field.example)} |`);
      }
    } else {
      const query = endpoint.parameters.filter(p => p.in === 'query' && p.required);
      if (query.length > 0) {
        lines.push(`    When I send a ${endpoint.method} request to "${path}" with the query parameters:`);
        lines.push('      | parameter | value |');
        for (const param of query) {
          lines.push(`      | ${gherkinCell(param.name)} | ${gherkinCell(this.example(param.schema, param.name, param.example))} |`);
        }
      } else {
        lines.push(`    When I send a ${endpoint.method} request to "${path}"`);
      }
    }
    lines.push(`    ${statusStep(expectation)}`);

    const documented = this.successResponse(endpoint);
    if (documented?.schema) lines.push('    And the response body should match the schema documented for that status code');
    else if (expectation.codes?.includes(204)) lines.push('    And a 204 response should have an empty body');
    lines.push('    And the response time should be below the configured threshold');
    scenarios.push(lines.join('\n'));
    return scenarios;
  }

  negativeScenarios(endpoint) {
    const scenarios = [];
    const path = gherkinText(endpoint.path);
    const add = (scenario, title, given, when) => {
      const expectation = negativeExpectation(endpoint, scenario);
      const lines = [`  @negative @${endpoint.method.toLowerCase()}${expectation.specGap ? ' @spec-gap' : ''}`, `  Scenario: ${title}`];
      if (scenario !== 'noAuth' && this.auth.sendsAuth(endpoint)) lines.push('    Given I am authenticated');
      lines.push(...given.map(step => `    ${step}`), `    When ${when}`, `    ${statusStep(expectation)}`);
      scenarios.push(lines.join('\n'));
    };

    if (BODY_METHODS.includes(endpoint.method) && endpoint.requestBody && /json/i.test(endpoint.requestBody.contentType)) {
      const fields = this.bodyFields(endpoint);
      for (const field of fields.filter(f => f.required)) {
        add('missingField', `Reject ${endpoint.method} ${path} without required field "${gherkinText(field.name)}"`, [],
          `I send a ${endpoint.method} request to "${path}" with a valid body without the "${gherkinText(field.name)}" field`);
      }
      for (const field of fields.filter(f => f.type !== 'any')) {
        add('wrongType', `Reject ${endpoint.method} ${path} when "${gherkinText(field.name)}" is not a ${field.type}`, [],
          `I send a ${endpoint.method} request to "${path}" with a valid body where "${gherkinText(field.name)}" has the wrong type`);
      }
      add('malformedJson', `Reject ${endpoint.method} ${path} with a malformed JSON body`, [],
        `I send a ${endpoint.method} request to "${path}" with a malformed JSON body`);
    }

    if (hasPathParams(endpoint)) {
      const last = endpoint.parameters.filter(p => p.in === 'path').at(-1);
      add('nonExistentId', `Reject ${endpoint.method} ${path} for a non-existent "${gherkinText(last.name)}"`,
        [`Given "${gherkinText(last.name)}" refers to a resource that does not exist`],
        `I send a ${endpoint.method} request to "${path}"`);
    }

    if (this.auth.requiresAuth(endpoint)) {
      add('noAuth', `Reject ${endpoint.method} ${path} without credentials`, ['Given I am not authenticated'],
        `I send a ${endpoint.method} request to "${path}"`);
    }
    return scenarios;
  }

  // ── Helpers ──────────────────────────────────────────────

  groupByResource() {
    const groups = new Map();
    for (const endpoint of this.apiSpec.endpoints) {
      if (this.auth.isAuthEndpoint(endpoint)) continue; // exercised as a step, not a feature
      const resource = resourceName(endpoint);
      if (!groups.has(resource)) groups.set(resource, []);
      groups.get(resource).push(endpoint);
    }
    return groups;
  }

  describeAction(endpoint) {
    const resource = resourceName(endpoint).replace(/_/g, ' ');
    const item = hasPathParams(endpoint);
    switch (endpoint.method) {
      case 'GET': return item ? `retrieve a ${resource}` : `list ${resource}`;
      case 'POST': return `create a ${resource}`;
      case 'PUT':
      case 'PATCH': return `update a ${resource}`;
      case 'DELETE': return `delete a ${resource}`;
      default: return `${endpoint.method} ${resource}`;
    }
  }

  successResponse(endpoint) {
    const code = Object.keys(endpoint.responses || {}).find(c => /^2\d\d$/.test(c));
    return code ? endpoint.responses[code] : null;
  }

  bodyFields(endpoint) {
    if (!endpoint.requestBody) return [];
    const schema = flattenSchema(endpoint.requestBody.schema);
    const required = new Set(schema.required || []);
    return Object.entries(schema.properties || {})
      .filter(([, prop]) => !prop?.readOnly)
      .map(([name, prop]) => ({
        name,
        type: schemaType(prop) || 'any',
        required: required.has(name),
        example: this.example(prop, name),
      }))
      .sort((a, b) => Number(b.required) - Number(a.required));
  }

  example(schema, name, explicit) {
    const value = explicit !== undefined ? explicit : generateExample(schema, { propName: name, unique: false });
    const clean = stripDynamicVariables(value);
    return typeof clean === 'object' && clean !== null ? JSON.stringify(clean) : String(clean ?? '');
  }

  formatFeatureName(resource) {
    return gherkinText(resource).replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  sanitize(name) {
    return String(name).replace(/[^a-z0-9_-]/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'root';
  }
}
