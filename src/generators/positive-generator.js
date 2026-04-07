import { v4 as uuidv4 } from 'uuid';
import { TestScriptGenerator } from './test-script-generator.js';

/**
 * Positive Test Generator
 * Generates Postman collection for positive test scenarios (CRUD operations)
 */
export class PositiveTestGenerator {
  constructor(apiSpec, options = {}) {
    this.apiSpec = apiSpec;
    this.collection = null;
    this.dataDriven = options.dataDriven || false;
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
   * Falls back to Cookie: token={{token}} when an auth endpoint exists but no scheme is defined.
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

    // No scheme defined but an auth endpoint exists — use generic cookie
    if (this.authEndpoint) {
      return { key: 'Cookie', value: 'token={{token}}', type: 'text' };
    }

    return null;
  }

  /**
   * Build the auth setup request item (calls auth endpoint, extracts + stores token)
   */
  generateAuthSetupItem() {
    const authScheme = this.apiSpec.authSchemes[0] || null;
    const headers = [{ key: 'Content-Type', value: 'application/json', type: 'text' }];
    const request = {
      method: this.authEndpoint.method,
      header: headers,
      url: this.buildUrl(this.authEndpoint)
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
   * Extract the expected success status code from the endpoint's OpenAPI responses.
   * Returns the first 2xx code defined, or falls back to a sensible default.
   */
  getExpectedStatus(endpoint, fallback = 200) {
    if (endpoint.responses) {
      const successCodes = Object.keys(endpoint.responses)
        .filter(code => code >= 200 && code < 300)
        .map(Number)
        .sort((a, b) => a - b);
      if (successCodes.length > 0) return successCodes[0];
    }
    return fallback;
  }

  /**
   * Generate complete positive test collection
   */
  generate() {
    this.collection = {
      info: {
        _postman_id: uuidv4(),
        name: `${this.apiSpec.info.title || 'API'} - Positive Test Suite`,
        description: `Comprehensive positive test scenarios for ${this.apiSpec.info.title}. Includes CRUD operations, contract testing, and response validation.`,
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      variable: this.generateCollectionVariables(),
      item: []
    };

    // Add setup folder for reference data
    this.collection.item.push(this.generateSetupFolder());

    // Generate CRUD operation folders
    const crud = this.categorizeEndpoints();

    if (crud.list.length > 0) {
      this.collection.item.push(this.generateListFolder(crud.list));
    }

    if (crud.create.length > 0) {
      this.collection.item.push(this.generateCreateFolder(crud.create));
    }

    if (crud.read.length > 0) {
      this.collection.item.push(this.generateReadFolder(crud.read));
    }

    if (crud.update.length > 0) {
      this.collection.item.push(this.generateUpdateFolder(crud.update));
    }

    if (crud.delete.length > 0) {
      this.collection.item.push(this.generateDeleteFolder(crud.delete));
    }

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
   * Generate setup folder for extracting reference data
   */
  generateSetupFolder() {
    const setupItems = [];

    // Step 0 — authenticate first if an auth endpoint is detected
    if (this.authEndpoint) {
      setupItems.push(this.generateAuthSetupItem());
    }

    // Find GET endpoints that return lists (for reference data)
    const listEndpoints = this.apiSpec.endpoints.filter(
      e => e.method === 'GET' && !e.path.includes('{')
    );

    listEndpoints.slice(0, 3).forEach((endpoint, index) => {
      const resourceName = this.getResourceName(endpoint);
      const itemIndex = index + 1;

      // Collect all path parameter names across all endpoints that relate to this resource
      // e.g. resource "permission_sets" → path params like "permission_set_id", "id"
      const relatedPathParams = new Set();
      this.apiSpec.endpoints.forEach(ep => {
        ep.parameters.filter(p => p.in === 'path').forEach(p => {
          const pName = p.name.toLowerCase();
          const rName = resourceName.toLowerCase();
          // Match if param name contains the singular form of the resource name
          const singular = rName.endsWith('s') ? rName.slice(0, -1) : rName;
          if (pName.includes(singular) || pName === 'id') {
            relatedPathParams.add(p.name);
          }
        });
      });

      // Build list of all variable names to store the ID under
      const storeAsVars = [
        `valid_${resourceName}_id`,
        ...Array.from(relatedPathParams).map(p => `valid_${p}`),
        ...Array.from(relatedPathParams)
      ];
      // Deduplicate
      const uniqueStoreAs = [...new Set(storeAsVars)];

      setupItems.push({
        name: `${itemIndex}. Get ${this.formatName(resourceName)}`,
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
        request: this.buildRequest(endpoint)
      });
    });

    return {
      name: '1. Setup - Extract Reference Data',
      description: 'GET operations to collect reference data for use in subsequent tests',
      item: setupItems
    };
  }

  /**
   * Generate LIST folder (GET all)
   */
  generateListFolder(endpoints) {
    const items = endpoints.map((endpoint, index) => {
      return {
        name: `${index + 1}. ${endpoint.summary || `List ${this.getResourceName(endpoint)}`}`,
        event: [
          {
            listen: 'test',
            script: {
              exec: TestScriptGenerator.generatePositiveTests(endpoint, {
                expectedStatus: this.getExpectedStatus(endpoint, 200),
                contractValidation: true
              }),
              type: 'text/javascript'
            }
          }
        ],
        request: this.buildRequest(endpoint),
        description: endpoint.description
      };
    });

    return {
      name: '2. LIST Operations',
      description: 'GET operations to retrieve lists of resources',
      item: items
    };
  }

  /**
   * Generate CREATE folder (POST)
   */
  generateCreateFolder(endpoints) {
    const items = endpoints.map((endpoint, index) => {
      return {
        name: `${index + 1}. ${endpoint.summary || `Create ${this.getResourceName(endpoint)}`}`,
        event: [
          {
            listen: 'test',
            script: {
              exec: TestScriptGenerator.generatePositiveTests(endpoint, {
                expectedStatus: this.getExpectedStatus(endpoint, 201),
                contractValidation: true
              }),
              type: 'text/javascript'
            }
          }
        ],
        request: this.buildRequest(endpoint),
        description: endpoint.description
      };
    });

    return {
      name: '3. CREATE Operations',
      description: 'POST operations to create new resources',
      item: items
    };
  }

  /**
   * Generate READ folder (GET by ID)
   */
  generateReadFolder(endpoints) {
    const items = endpoints.map((endpoint, index) => {
      return {
        name: `${index + 1}. ${endpoint.summary || `Get ${this.getResourceName(endpoint)}`}`,
        event: [
          {
            listen: 'test',
            script: {
              exec: TestScriptGenerator.generatePositiveTests(endpoint, {
                expectedStatus: this.getExpectedStatus(endpoint, 200),
                contractValidation: true
              }),
              type: 'text/javascript'
            }
          }
        ],
        request: this.buildRequest(endpoint),
        description: endpoint.description
      };
    });

    return {
      name: '4. READ Operations',
      description: 'GET operations to retrieve individual resources',
      item: items
    };
  }

  /**
   * Generate UPDATE folder (PUT/PATCH)
   */
  generateUpdateFolder(endpoints) {
    const items = endpoints.map((endpoint, index) => {
      return {
        name: `${index + 1}. ${endpoint.summary || `Update ${this.getResourceName(endpoint)}`}`,
        event: [
          {
            listen: 'test',
            script: {
              exec: TestScriptGenerator.generatePositiveTests(endpoint, {
                expectedStatus: this.getExpectedStatus(endpoint, 200),
                contractValidation: true
              }),
              type: 'text/javascript'
            }
          }
        ],
        request: this.buildRequest(endpoint),
        description: endpoint.description
      };
    });

    return {
      name: '5. UPDATE Operations',
      description: 'PUT/PATCH operations to update existing resources',
      item: items
    };
  }

  /**
   * Generate DELETE folder
   */
  generateDeleteFolder(endpoints) {
    const items = endpoints.map((endpoint, index) => {
      const expected = this.getExpectedStatus(endpoint, 200);
      return {
        name: `${index + 1}. ${endpoint.summary || `Delete ${this.getResourceName(endpoint)}`}`,
        event: [
          {
            listen: 'test',
            script: {
              exec: TestScriptGenerator.generatePositiveTests(endpoint, {
                expectedStatus: expected,
                contractValidation: expected !== 204
              }),
              type: 'text/javascript'
            }
          }
        ],
        request: this.buildRequest(endpoint),
        description: endpoint.description
      };
    });

    return {
      name: '6. DELETE Operations',
      description: 'DELETE operations to remove resources',
      item: items
    };
  }

  /**
   * Build Postman request from endpoint
   */
  buildRequest(endpoint) {
    const request = {
      method: endpoint.method,
      header: [],
      url: this.buildUrl(endpoint)
    };

    // Inject auth header (skip for the auth endpoint itself — it has no token yet)
    if (this.authHeader &&
        !(this.authEndpoint && endpoint.operationId === this.authEndpoint.operationId)) {
      request.header.push(this.authHeader);
    }

    // Add request body for POST/PUT/PATCH
    if (['POST', 'PUT', 'PATCH'].includes(endpoint.method) && endpoint.requestBody) {
      request.header.push({
        key: 'Content-Type',
        value: 'application/json',
        type: 'text'
      });

      let bodyData = endpoint.requestBody.example;
      if (this.dataDriven && bodyData && typeof bodyData === 'object') {
        bodyData = {};
        for (const [key, val] of Object.entries(endpoint.requestBody.example)) {
          bodyData[key] = `{{${key}}}`;
        }
      }

      request.body = {
        mode: 'raw',
        raw: JSON.stringify(bodyData, null, 2),
        options: {
          raw: {
            language: 'json'
          }
        }
      };
    }

    return request;
  }

  /**
   * Build Postman URL object
   */
  buildUrl(endpoint) {
    const pathParts = endpoint.path.split('/').filter(p => p);
    // Replace {param} with {{param}} in raw URL so Postman resolves variables correctly
    const rawPath = endpoint.path.replace(/\{([^}]+)\}/g, '{{$1}}');
    const urlObj = {
      raw: `{{baseUrl}}${rawPath}`,
      host: ['{{baseUrl}}'],
      path: pathParts.map(part => {
        // Replace path parameters with environment variables
        if (part.startsWith('{') && part.endsWith('}')) {
          const paramName = part.slice(1, -1);
          return `{{${paramName}}}`;
        }
        return part;
      })
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
   * Categorize endpoints by CRUD operation
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
      // Skip auth endpoint — it lives in the Setup folder only
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
      .split('_')
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
