/**
 * BDD Test Case Generator
 * Generates Gherkin .feature files from OpenAPI specifications.
 * Produces both positive and negative scenarios in Given/When/Then format.
 */

export class BDDGenerator {
  constructor(apiSpec) {
    this.apiSpec = apiSpec;
  }

  /**
   * Generate all BDD feature files as a Map of filename → content.
   */
  generate() {
    const features = new Map();

    // Group endpoints by resource (first path segment after base)
    const groups = this.groupByResource();

    for (const [resource, endpoints] of groups) {
      const featureName = this.formatFeatureName(resource);
      const filename = `${this.sanitize(resource)}.feature`;
      const content = this.generateFeature(featureName, resource, endpoints);
      features.set(filename, content);
    }

    return features;
  }

  /**
   * Generate a single combined feature file with all resources.
   */
  generateSingleFile() {
    const apiName = this.apiSpec.info.title || 'API';
    const lines = [];

    lines.push(`# Auto-generated BDD test cases from OpenAPI specification`);
    lines.push(`# API: ${apiName} v${this.apiSpec.info.version || '1.0.0'}`);
    lines.push(`# Generated: ${new Date().toISOString()}`);
    lines.push('');

    const groups = this.groupByResource();

    for (const [resource, endpoints] of groups) {
      const featureName = this.formatFeatureName(resource);
      lines.push(this.generateFeature(featureName, resource, endpoints));
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Generate a Feature block for a resource group.
   */
  generateFeature(featureName, resource, endpoints) {
    const lines = [];
    const apiName = this.apiSpec.info.title || 'API';

    lines.push(`Feature: ${featureName}`);
    lines.push(`  As an API consumer`);
    lines.push(`  I want to interact with the ${featureName} endpoints`);
    lines.push(`  So that I can manage ${resource} resources`);
    lines.push('');

    // Background - shared auth setup
    lines.push(`  Background:`);
    lines.push(`    Given I am authenticated as a valid user`);
    lines.push(`    And the base URL is configured`);
    lines.push('');

    // Categorize endpoints
    const categorized = this.categorize(endpoints);

    // Generate scenarios for each endpoint
    for (const endpoint of endpoints) {
      // Positive scenarios
      const positiveScenarios = this.generatePositiveScenarios(endpoint);
      for (const scenario of positiveScenarios) {
        lines.push(scenario);
        lines.push('');
      }

      // Negative scenarios (for writable endpoints)
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(endpoint.method)) {
        const negativeScenarios = this.generateNegativeScenarios(endpoint);
        for (const scenario of negativeScenarios) {
          lines.push(scenario);
          lines.push('');
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Generate positive BDD scenarios for an endpoint.
   */
  generatePositiveScenarios(endpoint) {
    const scenarios = [];
    const action = this.describeAction(endpoint);
    const resourceName = this.getResourceName(endpoint);
    const expectedStatus = this.getExpectedStatus(endpoint);

    // Main positive scenario
    const lines = [];
    lines.push(`  @positive @${endpoint.method.toLowerCase()}`);
    lines.push(`  Scenario: Successfully ${action}`);

    // Given
    if (endpoint.parameters.filter(p => p.in === 'path').length > 0) {
      for (const param of endpoint.parameters.filter(p => p.in === 'path')) {
        lines.push(`    Given a valid "${param.name}" exists`);
      }
    }

    // When
    if (endpoint.requestBody) {
      lines.push(`    When I send a ${endpoint.method} request to "${endpoint.path}" with a valid request body`);
      const required = this.getRequiredFields(endpoint);
      if (required.length > 0) {
        lines.push(`    And the request body contains:`);
        for (const field of required) {
          lines.push(`      | ${field.name} | ${field.type} | ${field.example} |`);
        }
      }
    } else {
      const queryParams = endpoint.parameters.filter(p => p.in === 'query');
      if (queryParams.length > 0) {
        lines.push(`    When I send a ${endpoint.method} request to "${endpoint.path}" with parameters:`);
        for (const param of queryParams) {
          lines.push(`      | ${param.name} | ${this.exampleValue(param)} |`);
        }
      } else {
        lines.push(`    When I send a ${endpoint.method} request to "${endpoint.path}"`);
      }
    }

    // Then
    lines.push(`    Then the response status code should be ${expectedStatus}`);

    if (expectedStatus === 204) {
      lines.push(`    And the response body should be empty`);
    } else if (endpoint.method === 'GET') {
      const responseSchema = this.getResponseSchema(endpoint, expectedStatus);
      if (responseSchema?.type === 'array') {
        lines.push(`    And the response should be a JSON array`);
        if (responseSchema.items?.properties) {
          const fields = Object.keys(responseSchema.items.properties).slice(0, 5);
          lines.push(`    And each item should contain the fields: ${fields.join(', ')}`);
        }
      } else if (responseSchema?.properties) {
        const fields = Object.keys(responseSchema.properties).slice(0, 5);
        lines.push(`    And the response should be a JSON object`);
        lines.push(`    And the response should contain the fields: ${fields.join(', ')}`);
      } else {
        lines.push(`    And the response should be valid JSON`);
      }
    } else if (endpoint.method === 'POST') {
      lines.push(`    And the response should contain the created resource`);
    } else if (['PUT', 'PATCH'].includes(endpoint.method)) {
      lines.push(`    And the response should contain the updated resource`);
    }

    lines.push(`    And the response time should be less than 5000ms`);

    scenarios.push(lines.join('\n'));

    // Contract validation scenario for GET endpoints
    if (endpoint.method === 'GET') {
      const contractLines = [];
      contractLines.push(`  @contract @${endpoint.method.toLowerCase()}`);
      contractLines.push(`  Scenario: Validate response contract for ${endpoint.path}`);

      if (endpoint.parameters.filter(p => p.in === 'path').length > 0) {
        for (const param of endpoint.parameters.filter(p => p.in === 'path')) {
          contractLines.push(`    Given a valid "${param.name}" exists`);
        }
      }

      contractLines.push(`    When I send a ${endpoint.method} request to "${endpoint.path}"`);
      contractLines.push(`    Then the response status code should be ${expectedStatus}`);
      contractLines.push(`    And the Content-Type header should include "application/json"`);
      contractLines.push(`    And the response should match the schema defined in the specification`);

      scenarios.push(contractLines.join('\n'));
    }

    return scenarios;
  }

  /**
   * Generate negative BDD scenarios for an endpoint.
   */
  generateNegativeScenarios(endpoint) {
    const scenarios = [];
    const resourceName = this.getResourceName(endpoint);

    // 1. No authentication
    scenarios.push(this.buildNegativeScenario(
      endpoint,
      `Reject ${endpoint.method} ${endpoint.path} without authentication`,
      ['Given I am not authenticated'],
      `I send a ${endpoint.method} request to "${endpoint.path}"`,
      401,
      'the response should indicate authentication is required'
    ));

    // 2. Malformed JSON (for endpoints with body)
    if (endpoint.requestBody) {
      scenarios.push(this.buildNegativeScenario(
        endpoint,
        `Reject ${endpoint.method} ${endpoint.path} with malformed JSON`,
        [],
        `I send a ${endpoint.method} request to "${endpoint.path}" with malformed JSON body`,
        422,
        'the response should indicate invalid request format'
      ));

      // 3. Missing required fields
      const required = this.getRequiredFields(endpoint);
      for (const field of required.slice(0, 3)) {
        scenarios.push(this.buildNegativeScenario(
          endpoint,
          `Reject ${endpoint.method} ${endpoint.path} without required field "${field.name}"`,
          [],
          `I send a ${endpoint.method} request to "${endpoint.path}" without the "${field.name}" field`,
          422,
          `the response should indicate "${field.name}" is required`
        ));
      }

      // 4. Invalid data types
      for (const field of required.slice(0, 2)) {
        const invalidType = field.type === 'string' ? 'integer' : 'string';
        scenarios.push(this.buildNegativeScenario(
          endpoint,
          `Reject ${endpoint.method} ${endpoint.path} with invalid type for "${field.name}"`,
          [],
          `I send a ${endpoint.method} request to "${endpoint.path}" with "${field.name}" as a ${invalidType} instead of ${field.type}`,
          422,
          `the response should indicate invalid type for "${field.name}"`
        ));
      }
    }

    // 5. Invalid ID (for endpoints with path params)
    const pathParams = endpoint.parameters.filter(p => p.in === 'path');
    if (pathParams.length > 0) {
      scenarios.push(this.buildNegativeScenario(
        endpoint,
        `Reject ${endpoint.method} ${endpoint.path} with invalid ID format`,
        [`Given the path parameter "${pathParams[0].name}" is set to "invalid_id_format"`],
        `I send a ${endpoint.method} request to "${endpoint.path}"`,
        400,
        'the response should indicate invalid ID format'
      ));

      // 6. Non-existent resource
      scenarios.push(this.buildNegativeScenario(
        endpoint,
        `Reject ${endpoint.method} ${endpoint.path} for non-existent resource`,
        [`Given the path parameter "${pathParams[0].name}" is set to "00000000-0000-0000-0000-000000000000"`],
        `I send a ${endpoint.method} request to "${endpoint.path}"`,
        404,
        'the response should indicate the resource was not found'
      ));
    }

    return scenarios;
  }

  /**
   * Build a single negative scenario in Gherkin format.
   */
  buildNegativeScenario(endpoint, title, givenSteps, whenStep, expectedStatus, thenDetail) {
    const lines = [];
    lines.push(`  @negative @${endpoint.method.toLowerCase()}`);
    lines.push(`  Scenario: ${title}`);

    for (const step of givenSteps) {
      lines.push(`    ${step}`);
    }

    lines.push(`    When ${whenStep}`);
    lines.push(`    Then the response status code should be ${expectedStatus}`);
    lines.push(`    And ${thenDetail}`);
    lines.push(`    And the response should not return a 5xx server error`);

    return lines.join('\n');
  }

  // ── Helpers ──────────────────────────────────────────────

  groupByResource() {
    const groups = new Map();
    for (const endpoint of this.apiSpec.endpoints) {
      const parts = endpoint.path.split('/').filter(p => p && !p.startsWith('{'));
      // Use the last non-param segment as the resource name
      const resource = parts[parts.length - 1] || 'root';
      if (!groups.has(resource)) {
        groups.set(resource, []);
      }
      groups.get(resource).push(endpoint);
    }
    return groups;
  }

  categorize(endpoints) {
    return {
      list: endpoints.filter(e => e.method === 'GET' && !e.parameters.some(p => p.in === 'path')),
      read: endpoints.filter(e => e.method === 'GET' && e.parameters.some(p => p.in === 'path')),
      create: endpoints.filter(e => e.method === 'POST'),
      update: endpoints.filter(e => ['PUT', 'PATCH'].includes(e.method)),
      delete: endpoints.filter(e => e.method === 'DELETE'),
    };
  }

  describeAction(endpoint) {
    const resource = this.getResourceName(endpoint);
    const hasPathParam = endpoint.parameters.some(p => p.in === 'path');

    switch (endpoint.method) {
      case 'GET':
        return hasPathParam ? `retrieve a specific ${resource}` : `list all ${resource}`;
      case 'POST':
        return `create a new ${resource}`;
      case 'PUT':
      case 'PATCH':
        return `update an existing ${resource}`;
      case 'DELETE':
        return `delete a ${resource}`;
      default:
        return `perform ${endpoint.method} on ${resource}`;
    }
  }

  getResourceName(endpoint) {
    const parts = endpoint.path.split('/').filter(p => p && !p.startsWith('{'));
    const last = parts[parts.length - 1] || 'resource';
    return last.replace(/_/g, ' ');
  }

  getExpectedStatus(endpoint) {
    if (endpoint.responses) {
      const codes = Object.keys(endpoint.responses)
        .filter(c => c >= 200 && c < 300)
        .map(Number)
        .sort((a, b) => a - b);
      if (codes.length > 0) return codes[0];
    }
    if (endpoint.method === 'POST') return 201;
    if (endpoint.method === 'DELETE') return 204;
    return 200;
  }

  getResponseSchema(endpoint, statusCode) {
    const resp = endpoint.responses?.[String(statusCode)] || endpoint.responses?.['200'];
    return resp?.schema || null;
  }

  getRequiredFields(endpoint) {
    if (!endpoint.requestBody?.schema?.properties) return [];

    const required = new Set(endpoint.requestBody.schema.required || []);
    const props = endpoint.requestBody.schema.properties;
    const fields = [];

    for (const [name, schema] of Object.entries(props)) {
      fields.push({
        name,
        type: schema.type || 'string',
        required: required.has(name),
        example: this.schemaExample(schema, name),
      });
    }

    // Required fields first, then optional
    return fields.sort((a, b) => (b.required ? 1 : 0) - (a.required ? 1 : 0));
  }

  schemaExample(schema, name) {
    if (schema.example !== undefined) return String(schema.example);
    if (schema.enum?.length > 0) return schema.enum[0];
    if (schema.format === 'uuid') return '<valid-uuid>';
    if (schema.format === 'date') return '2024-01-15';
    if (schema.format === 'date-time') return '2024-01-15T10:00:00Z';

    const lower = (name || '').toLowerCase();
    if (lower.includes('email')) return 'test@example.com';
    if (lower.includes('name')) return 'Test Name';
    if (lower.endsWith('_id') || lower === 'id') return '<valid-uuid>';

    switch (schema.type) {
      case 'integer': case 'number': return '1';
      case 'boolean': return 'true';
      case 'array': return '[]';
      default: return '<valid-value>';
    }
  }

  exampleValue(param) {
    return this.schemaExample(param.schema || {}, param.name);
  }

  formatFeatureName(resource) {
    return resource
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  sanitize(name) {
    return name.replace(/[^a-z0-9_-]/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  }
}
