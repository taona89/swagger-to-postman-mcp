import { v4 as uuidv4 } from 'uuid';
import { TestScriptGenerator } from './test-script-generator.js';

/**
 * Negative Test Generator
 * Generates Postman collection for negative test scenarios (error cases, validation)
 */
export class NegativeTestGenerator {
  constructor(apiSpec) {
    this.apiSpec = apiSpec;
    this.collection = null;
    this.authEndpoint = this.detectAuthEndpoint();
    this.authHeader = this.buildAuthHeader();
  }

  /**
   * Detect the auth endpoint from the spec (POST /auth, /login, /token, etc.)
   */
  detectAuthEndpoint() {
    const authPaths = ['/auth', '/login', '/signin', '/sign-in', '/token',
                       '/oauth/token', '/authenticate', '/session'];
    return this.apiSpec.endpoints.find(e =>
      e.method === 'POST' &&
      authPaths.some(p => e.path.toLowerCase() === p ||
                          e.path.toLowerCase().endsWith(p))
    ) || null;
  }

  /**
   * Build the auth header object based on the spec's securitySchemes.
   */
  buildAuthHeader() {
    const schemes = this.apiSpec.authSchemes;

    if (schemes && schemes.length > 0) {
      const scheme = schemes[0];
      if (scheme.type === 'http' && scheme.scheme === 'bearer') {
        return { key: 'Authorization', value: 'Bearer {{token}}', type: 'text' };
      }
      if (scheme.type === 'apiKey' && scheme.in === 'header') {
        return { key: scheme.name || 'x-api-key', value: '{{apiKey}}', type: 'text' };
      }
      if (scheme.type === 'apiKey' && scheme.in === 'cookie') {
        return { key: 'Cookie', value: `${scheme.name || 'token'}={{token}}`, type: 'text' };
      }
    }

    if (this.authEndpoint) {
      return { key: 'Cookie', value: 'token={{token}}', type: 'text' };
    }

    return null;
  }

  /**
   * Build the auth setup request item
   */
  generateAuthSetupItem() {
    const authScheme = this.apiSpec.authSchemes[0] || null;
    const headers = [{ key: 'Content-Type', value: 'application/json', type: 'text' }];
    const request = {
      method: this.authEndpoint.method,
      header: headers,
      url: this.buildUrl(this.authEndpoint, {})
    };

    if (this.authEndpoint.requestBody) {
      request.body = {
        mode: 'raw',
        raw: JSON.stringify(this.authEndpoint.requestBody.example, null, 2),
        options: { raw: { language: 'json' } }
      };
    }

    return {
      name: '0. Authenticate',
      description: 'Obtain auth token and store it in the environment for all subsequent requests.',
      event: [{
        listen: 'test',
        script: {
          exec: TestScriptGenerator.generateAuthSetupScript(authScheme),
          type: 'text/javascript'
        }
      }],
      request
    };
  }

  /**
   * Generate complete negative test collection
   */
  generate() {
    this.collection = {
      info: {
        _postman_id: uuidv4(),
        name: `${this.apiSpec.info.title || 'API'} - Negative Test Suite`,
        description: `Comprehensive negative test scenarios for ${this.apiSpec.info.title}. Tests invalid inputs, missing fields, unauthorized access, malformed data, and error handling.`,
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      variable: this.generateCollectionVariables(),
      item: []
    };

    // Add setup folder for getting valid IDs
    this.collection.item.push(this.generateSetupFolder());

    // Generate negative test folders for each endpoint
    this.generateNegativeFolders();

    return this.collection;
  }

  /**
   * Generate collection variables
   */
  generateCollectionVariables() {
    return [
      {
        key: 'baseUrl',
        value: this.apiSpec.baseUrl || '{{baseUrl}}',
        type: 'string'
      }
    ];
  }

  /**
   * Generate setup folder
   */
  generateSetupFolder() {
    const setupItems = [];

    // Step 0 — authenticate first if an auth endpoint is detected
    if (this.authEndpoint) {
      setupItems.push(this.generateAuthSetupItem());
    }

    // Find GET endpoints that return lists
    const listEndpoints = this.apiSpec.endpoints.filter(
      e => e.method === 'GET' && !e.path.includes('{')
    );

    listEndpoints.slice(0, 3).forEach((endpoint, index) => {
      const resourceName = this.getResourceName(endpoint);

      // Collect all path parameter names across all endpoints that relate to this resource
      const relatedPathParams = new Set();
      this.apiSpec.endpoints.forEach(ep => {
        ep.parameters.filter(p => p.in === 'path').forEach(p => {
          const pName = p.name.toLowerCase();
          const rName = resourceName.toLowerCase();
          const singular = rName.endsWith('s') ? rName.slice(0, -1) : rName;
          if (pName.includes(singular) || pName === 'id') {
            relatedPathParams.add(p.name);
          }
        });
      });

      const storeAsVars = [
        `valid_${resourceName}_id`,
        ...Array.from(relatedPathParams).map(p => `valid_${p}`),
        ...Array.from(relatedPathParams)
      ];
      const uniqueStoreAs = [...new Set(storeAsVars)];

      setupItems.push({
        name: `Get Valid ${this.formatName(resourceName)} ID`,
        event: [
          {
            listen: 'test',
            script: {
              exec: TestScriptGenerator.generateSetupScript(
                this.formatName(resourceName),
                uniqueStoreAs
              ),
              type: 'text/javascript'
            }
          }
        ],
        request: this.buildRequest(endpoint, {})
      });
    });

    return {
      name: '1. Setup - Get Valid IDs',
      description: 'Setup requests to get valid IDs for negative testing',
      item: setupItems
    };
  }

  /**
   * Generate negative test folders for all endpoints
   */
  generateNegativeFolders() {
    const categorized = this.categorizeEndpoints();
    let folderIndex = 2;

    // POST negative tests
    if (categorized.create.length > 0) {
      categorized.create.forEach(endpoint => {
        this.collection.item.push(
          this.generateEndpointNegativeFolder(endpoint, folderIndex++)
        );
      });
    }

    // PUT/PATCH negative tests
    if (categorized.update.length > 0) {
      categorized.update.forEach(endpoint => {
        this.collection.item.push(
          this.generateEndpointNegativeFolder(endpoint, folderIndex++)
        );
      });
    }

    // DELETE negative tests
    if (categorized.delete.length > 0) {
      categorized.delete.forEach(endpoint => {
        this.collection.item.push(
          this.generateEndpointNegativeFolder(endpoint, folderIndex++)
        );
      });
    }

    // GET negative tests
    if (categorized.read.length > 0) {
      categorized.read.forEach(endpoint => {
        this.collection.item.push(
          this.generateEndpointNegativeFolder(endpoint, folderIndex++)
        );
      });
    }
  }

  /**
   * Generate negative test folder for a specific endpoint
   */
  generateEndpointNegativeFolder(endpoint, folderIndex) {
    const resourceName = this.formatName(this.getResourceName(endpoint));
    const negativeTests = [];

    // Generate different negative scenarios based on method
    if (endpoint.method === 'POST' || endpoint.method === 'PUT' || endpoint.method === 'PATCH') {
      // Missing required fields
      if (endpoint.requestBody && endpoint.requestBody.schema.properties) {
        const requiredFields = endpoint.requestBody.schema.required || [];

        requiredFields.forEach(fieldName => {
          negativeTests.push(
            this.createNegativeTest(
              endpoint,
              `[NEG] ${endpoint.method} ${resourceName} - Missing ${fieldName}`,
              `Missing Required Field: ${fieldName}`,
              { removedField: fieldName }
            )
          );
        });

        // Empty values for required fields
        Object.keys(endpoint.requestBody.schema.properties).slice(0, 3).forEach(fieldName => {
          negativeTests.push(
            this.createNegativeTest(
              endpoint,
              `[NEG] ${endpoint.method} ${resourceName} - Empty ${fieldName}`,
              `Empty ${fieldName}`,
              { emptyField: fieldName }
            )
          );
        });

        // Invalid data types
        Object.entries(endpoint.requestBody.schema.properties).slice(0, 2).forEach(([fieldName, schema]) => {
          negativeTests.push(
            this.createNegativeTest(
              endpoint,
              `[NEG] ${endpoint.method} ${resourceName} - Invalid ${fieldName} Type`,
              `Invalid Type for ${fieldName}`,
              { invalidField: fieldName, expectedType: schema.type }
            )
          );
        });
      }

      // Malformed JSON (for POST/PUT/PATCH)
      negativeTests.push(
        this.createNegativeTest(
          endpoint,
          `[NEG] ${endpoint.method} ${resourceName} - Malformed JSON`,
          'Malformed JSON Body',
          { malformedJson: true }
        )
      );
    }

    // Invalid ID (for endpoints with path parameters)
    if (endpoint.path.includes('{')) {
      negativeTests.push(
        this.createNegativeTest(
          endpoint,
          `[NEG] ${endpoint.method} ${resourceName} - Invalid ID`,
          'Invalid ID',
          { invalidId: true }
        )
      );

      negativeTests.push(
        this.createNegativeTest(
          endpoint,
          `[NEG] ${endpoint.method} ${resourceName} - Non-existent ID`,
          'Non-existent ID',
          { nonExistentId: true }
        )
      );
    }

    // Unauthorized access
    negativeTests.push(
      this.createNegativeTest(
        endpoint,
        `[NEG] ${endpoint.method} ${resourceName} - No Authentication`,
        'No Authentication Token',
        { noAuth: true }
      )
    );

    return {
      name: `${folderIndex}. ${resourceName} - Negative Scenarios`,
      description: `Negative test cases for ${resourceName} ${endpoint.method} endpoint`,
      item: negativeTests
    };
  }

  /**
   * Create a single negative test
   */
  createNegativeTest(endpoint, testName, scenario, options) {
    return {
      name: testName,
      event: [
        {
          listen: 'test',
          script: {
            exec: TestScriptGenerator.generateNegativeTests(endpoint, scenario),
            type: 'text/javascript'
          }
        }
      ],
      request: this.buildNegativeRequest(endpoint, options),
      description: `Attempt to ${endpoint.method} with ${scenario}`
    };
  }

  /**
   * Build negative test request
   */
  buildNegativeRequest(endpoint, options) {
    const request = {
      method: endpoint.method,
      header: [],
      url: this.buildUrl(endpoint, options)
    };

    // Inject auth header unless this is a no-auth test scenario
    if (!options.noAuth && this.authHeader) {
      request.header.push(this.authHeader);
    }

    // Build body for POST/PUT/PATCH
    if (['POST', 'PUT', 'PATCH'].includes(endpoint.method)) {
      request.header.push({
        key: 'Content-Type',
        value: 'application/json',
        type: 'text'
      });

      if (options.malformedJson) {
        // Malformed JSON
        request.body = {
          mode: 'raw',
          raw: '{ invalid json here }',
          options: {
            raw: { language: 'json' }
          }
        };
      } else if (endpoint.requestBody) {
        // Build modified body based on scenario
        const body = this.buildNegativeBody(endpoint.requestBody.example, options);
        request.body = {
          mode: 'raw',
          raw: JSON.stringify(body, null, 2),
          options: {
            raw: { language: 'json' }
          }
        };
      }
    }

    return request;
  }

  /**
   * Build negative test body
   */
  buildNegativeBody(example, options) {
    if (!example) return {};

    const body = JSON.parse(JSON.stringify(example)); // Deep clone

    if (options.removedField) {
      delete body[options.removedField];
    } else if (options.emptyField) {
      body[options.emptyField] = '';
    } else if (options.invalidField) {
      // Set invalid type
      if (options.expectedType === 'string') {
        body[options.invalidField] = 12345;
      } else if (options.expectedType === 'number' || options.expectedType === 'integer') {
        body[options.invalidField] = 'not_a_number';
      } else if (options.expectedType === 'boolean') {
        body[options.invalidField] = 'not_a_boolean';
      } else if (options.expectedType === 'array') {
        body[options.invalidField] = 'not_an_array';
      } else if (options.expectedType === 'object') {
        body[options.invalidField] = 'not_an_object';
      }
    }

    return body;
  }

  /**
   * Build URL for negative test
   */
  buildUrl(endpoint, options) {
    const pathParts = endpoint.path.split('/').filter(p => p);
    const resolvedParts = pathParts.map(part => {
      if (part.startsWith('{') && part.endsWith('}')) {
        const paramName = part.slice(1, -1);
        if (options.invalidId) {
          return 'invalid_id_format';
        } else if (options.nonExistentId) {
          return '00000000-0000-0000-0000-000000000000';
        }
        return `{{valid_${paramName}}}`;
      }
      return part;
    });
    const urlObj = {
      raw: `{{baseUrl}}/${resolvedParts.join('/')}`,
      host: ['{{baseUrl}}'],
      path: resolvedParts
    };

    // Add query parameters with smart defaults
    const queryParams = endpoint.parameters.filter(p => p.in === 'query');
    if (queryParams.length > 0) {
      urlObj.query = queryParams.map(param => ({
        key: param.name,
        value: this.getQueryParamValue(param),
        description: param.description
      }));
    }

    return urlObj;
  }

  /**
   * Build standard request
   */
  buildRequest(endpoint, options) {
    const request = {
      method: endpoint.method,
      header: [],
      url: this.buildUrl(endpoint, options)
    };

    if (this.authHeader) {
      request.header.push(this.authHeader);
    }

    return request;
  }

  /**
   * Categorize endpoints
   */
  categorizeEndpoints() {
    const crud = {
      create: [],
      read: [],
      update: [],
      delete: [],
      list: []
    };

    for (const endpoint of this.apiSpec.endpoints) {
      // Skip auth endpoint — handled separately in setup
      if (this.authEndpoint && endpoint.operationId === this.authEndpoint.operationId) continue;

      const { method, path } = endpoint;

      if (method === 'POST') {
        crud.create.push(endpoint);
      } else if (method === 'GET') {
        if (path.includes('{')) {
          crud.read.push(endpoint);
        } else {
          crud.list.push(endpoint);
        }
      } else if (method === 'PUT' || method === 'PATCH') {
        crud.update.push(endpoint);
      } else if (method === 'DELETE') {
        crud.delete.push(endpoint);
      }
    }

    return crud;
  }

  /**
   * Get resource name from endpoint
   */
  getResourceName(endpoint) {
    const parts = endpoint.path.split('/').filter(p => p && !p.startsWith('{'));
    return parts[parts.length - 1] || 'resource';
  }

  /**
   * Format name for display
   */
  formatName(name) {
    return name
      .split(/[_-]/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Get smart query parameter value
   * Returns environment variable reference or sample data based on parameter name
   */
  getQueryParamValue(param) {
    // If example exists and is not empty, use it
    if (param.example !== undefined && param.example !== '') {
      return String(param.example);
    }

    const paramName = param.name.toLowerCase();
    const paramType = param.schema?.type || 'string';

    // Map common parameter names to environment variables or smart defaults
    const paramMappings = {
      // IDs - use environment variables from setup phase
      'id': '{{id}}',
      'ids': '{{ids}}',
      'area_id': '{{valid_areas}}',
      'areas': '{{valid_areas}}',
      'area': '{{valid_areas}}',
      'asset_id': '{{valid_asset_ids}}',
      'asset_ids': '{{valid_asset_ids}}',
      'type_id': '{{valid_types_id}}',
      'method_id': '{{valid_methods_id}}',
      'state_id': '{{valid_states_id}}',
      'tenant_id': '{{tenantId}}',

      // Search and filter parameters
      'search': 'test',
      'search_string': 'test',
      'search_term': 'search',
      'query': 'test',
      'q': 'test',
      'filter': '',
      'keyword': 'test',

      // Pagination
      'page': '1',
      'limit': '10',
      'offset': '0',
      'size': '10',
      'per_page': '10',
      'page_size': '10',

      // Sorting
      'sort': 'id',
      'sort_by': 'id',
      'order': 'asc',
      'order_by': 'id',

      // Boolean flags
      'active': 'true',
      'enabled': 'true',
      'deleted': 'false',
      'is_active': 'true',
      'include_deleted': 'false',

      // Date/time
      'date': '2024-01-15',
      'start_date': '2024-01-01',
      'end_date': '2024-12-31',
      'from': '2024-01-01',
      'to': '2024-12-31',
      'created_at': '2024-01-15',
      'updated_at': '2024-01-15',
    };

    // Check for exact match first
    if (paramMappings[paramName]) {
      return paramMappings[paramName];
    }

    // Check for partial matches (e.g., any param ending with '_id' or 'id')
    if (paramName.endsWith('_id') || paramName.endsWith('_ids') || paramName === 'id') {
      const resourceName = paramName.replace(/_ids?$/, '');
      return `{{valid_${resourceName}_id}}`;
    }

    // Type-based defaults
    if (paramType === 'integer' || paramType === 'number') {
      return param.schema?.minimum !== undefined ? String(param.schema.minimum) : '1';
    }

    if (paramType === 'boolean') {
      return 'true';
    }

    if (paramType === 'array') {
      return '';
    }

    // For string types, check if it's required
    if (param.required) {
      // Required string parameters should have a sample value
      if (paramName.includes('name')) return 'test';
      if (paramName.includes('email')) return 'test@example.com';
      if (paramName.includes('username')) return 'testuser';
      return 'sample_value';
    }

    // Default for optional string parameters - empty string
    return '';
  }
}
