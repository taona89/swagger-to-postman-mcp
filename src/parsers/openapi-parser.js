import SwaggerParser from 'swagger-parser';
import fs from 'fs';
import yaml from 'js-yaml';

/**
 * OpenAPI/Swagger Parser
 * Extracts endpoints, schemas, and operations from OpenAPI specifications
 */
export class OpenAPIParser {
  constructor() {
    this.spec = null;
    this.endpoints = [];
    this.schemas = {};
    this.authSchemes = [];
  }

  /**
   * Parse OpenAPI specification from file or URL
   */
  async parse(specPath) {
    try {
      // Try manual YAML parsing first (faster and avoids swagger-parser issues)
      console.log('📖 Reading spec file...');
      const fileContent = fs.readFileSync(specPath, 'utf8');

      if (specPath.endsWith('.yaml') || specPath.endsWith('.yml')) {
        this.spec = yaml.load(fileContent);
      } else {
        this.spec = JSON.parse(fileContent);
      }
      console.log('✅ Spec file parsed');

      // Extract information
      console.log('🔍 Extracting endpoints...');
      this.extractEndpoints();
      console.log('✅ Endpoints extracted:', this.endpoints.length);

      console.log('🔍 Extracting schemas...');
      this.extractSchemas();
      console.log('✅ Schemas extracted:', Object.keys(this.schemas).length);

      console.log('🔍 Extracting auth schemes...');
      this.extractAuthSchemes();
      console.log('✅ Auth schemes extracted:', this.authSchemes.length);

      return {
        info: this.spec.info || {},
        baseUrl: this.getBaseUrl(),
        endpoints: this.endpoints,
        schemas: this.schemas,
        authSchemes: this.authSchemes
      };
    } catch (error) {
      throw new Error(`Failed to parse OpenAPI spec: ${error.message}`);
    }
  }

  /**
   * Extract all endpoints from the spec
   */
  extractEndpoints() {
    this.endpoints = [];

    if (!this.spec.paths) {
      return;
    }

    for (const [path, pathItem] of Object.entries(this.spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(method.toLowerCase())) {
          this.endpoints.push({
            path,
            method: method.toUpperCase(),
            operationId: operation.operationId || `${method}_${path.replace(/\//g, '_')}`,
            summary: operation.summary || '',
            description: operation.description || '',
            tags: operation.tags || [],
            parameters: this.extractParameters(operation, pathItem),
            requestBody: this.extractRequestBody(operation),
            responses: this.extractResponses(operation),
            security: operation.security || pathItem.security || this.spec.security || []
          });
        }
      }
    }
  }

  /**
   * Extract parameters (path, query, header)
   */
  extractParameters(operation, pathItem) {
    const params = [];

    // Path-level parameters
    if (pathItem.parameters) {
      params.push(...pathItem.parameters);
    }

    // Operation-level parameters
    if (operation.parameters) {
      params.push(...operation.parameters);
    }

    return params.map(param => ({
      name: param.name,
      in: param.in,
      required: param.required || false,
      schema: param.schema || {},
      description: param.description || '',
      example: param.example || this.generateExample(param.schema)
    }));
  }

  /**
   * Extract request body schema
   */
  extractRequestBody(operation) {
    if (!operation.requestBody) {
      return null;
    }

    const content = operation.requestBody.content || {};
    const jsonContent = content['application/json'] || content['application/x-www-form-urlencoded'];

    if (!jsonContent) {
      return null;
    }

    return {
      required: operation.requestBody.required || false,
      schema: jsonContent.schema || {},
      example: jsonContent.example || this.generateExampleFromSchema(jsonContent.schema)
    };
  }

  /**
   * Extract response schemas
   */
  extractResponses(operation) {
    const responses = {};

    if (!operation.responses) {
      return responses;
    }

    for (const [statusCode, response] of Object.entries(operation.responses)) {
      const content = response.content || {};
      const jsonContent = content['application/json'];

      responses[statusCode] = {
        description: response.description || '',
        schema: jsonContent?.schema || {},
        example: jsonContent?.example || null
      };
    }

    return responses;
  }

  /**
   * Extract schemas/models
   */
  extractSchemas() {
    this.schemas = this.spec.components?.schemas || {};
  }

  /**
   * Extract authentication schemes
   */
  extractAuthSchemes() {
    this.authSchemes = [];

    const securitySchemes = this.spec.components?.securitySchemes || {};

    for (const [name, scheme] of Object.entries(securitySchemes)) {
      this.authSchemes.push({
        name,
        type: scheme.type,
        scheme: scheme.scheme,
        bearerFormat: scheme.bearerFormat,
        in: scheme.in,
        description: scheme.description || ''
      });
    }
  }

  /**
   * Get base URL from servers
   */
  getBaseUrl() {
    if (this.spec.servers && this.spec.servers.length > 0) {
      return this.spec.servers[0].url;
    }

    // Fallback to Swagger 2.0 format
    if (this.spec.host) {
      const scheme = this.spec.schemes?.[0] || 'https';
      const basePath = this.spec.basePath || '';
      return `${scheme}://${this.spec.host}${basePath}`;
    }

    return '{{baseUrl}}';
  }

  /**
   * Generate example value from schema
   * @param {object} schema - JSON Schema object
   * @param {number} depth - recursion depth
   * @param {WeakSet} seen - cycle detection
   * @param {string} propName - property name (used for smart heuristics)
   */
  generateExample(schema, depth = 0, seen = new WeakSet(), propName = '') {
    // Prevent infinite recursion
    if (depth > 10) return null;
    if (!schema) return null;
    if (typeof schema === 'object' && seen.has(schema)) return null;
    if (typeof schema === 'object') seen.add(schema);

    if (schema.example !== undefined) {
      return schema.example;
    }

    // Use default only if it's not an empty string
    if (schema.default !== undefined && schema.default !== '') {
      return schema.default;
    }

    switch (schema.type) {
      case 'string':
        if (schema.format === 'uuid') return '550e8400-e29b-41d4-a716-446655440000';
        if (schema.format === 'date') return '2024-01-15';
        if (schema.format === 'date-time') return '2024-01-15T10:00:00Z';
        if (schema.format === 'email') return 'test@example.com';
        if (schema.enum) return schema.enum[0];
        return this.generateSmartStringValue(propName);
      case 'number':
      case 'integer':
        return schema.minimum || 1;
      case 'boolean':
        return true;
      case 'array':
        return schema.items ? [this.generateExample(schema.items, depth + 1, seen, propName)] : [];
      case 'object':
        return this.generateExampleFromSchema(schema, depth + 1, seen);
      default:
        return null;
    }
  }

  /**
   * Generate a realistic string value based on property name heuristics.
   * Appends Postman's {{$timestamp}} dynamic variable for uniqueness per run.
   */
  generateSmartStringValue(propName) {
    if (!propName) return 'test_value_{{$timestamp}}';

    const lower = propName.toLowerCase();

    // Name-like fields — unique per run
    if (lower === 'name' || lower.endsWith('_name') || lower.endsWith('name'))
      return 'Test Name_{{$timestamp}}';
    if (lower === 'title')
      return 'Test Title_{{$timestamp}}';
    if (lower === 'label')
      return 'Test Label_{{$timestamp}}';
    if (lower === 'username' || lower === 'user_name')
      return 'testuser_{{$timestamp}}';
    if (lower === 'firstname' || lower === 'first_name')
      return 'TestFirst_{{$timestamp}}';
    if (lower === 'lastname' || lower === 'last_name')
      return 'TestLast_{{$timestamp}}';

    // Description / text fields — unique per run
    if (lower === 'description' || lower === 'desc')
      return 'Auto-generated description_{{$timestamp}}';
    if (lower === 'comment' || lower === 'comments' || lower === 'note' || lower === 'notes')
      return 'Test comment_{{$timestamp}}';
    if (lower === 'reason')
      return 'Test reason_{{$timestamp}}';
    if (lower === 'message' || lower === 'msg')
      return 'Test message_{{$timestamp}}';
    if (lower === 'summary')
      return 'Test summary_{{$timestamp}}';
    if (lower === 'body' || lower === 'content' || lower === 'text')
      return 'Test content_{{$timestamp}}';

    // Identifiers — unique per run
    if (lower === 'code' || lower.endsWith('_code'))
      return 'TEST_{{$timestamp}}';
    if (lower === 'key' || lower.endsWith('_key'))
      return 'test_key_{{$timestamp}}';
    if (lower === 'slug')
      return 'test-slug-{{$timestamp}}';
    if (lower === 'sku')
      return 'SKU_{{$timestamp}}';
    if (lower === 'reference' || lower === 'ref')
      return 'REF_{{$timestamp}}';

    // Contact / address — fixed values (no timestamp)
    if (lower === 'email' || lower.endsWith('_email'))
      return 'test@example.com';
    if (lower === 'phone' || lower === 'phonenumber' || lower === 'phone_number')
      return '+1-555-0100';
    if (lower === 'address' || lower.endsWith('_address'))
      return '123 Test Street';
    if (lower === 'city')
      return 'Test City';
    if (lower === 'state' || lower === 'province')
      return 'CA';
    if (lower === 'country' || lower === 'country_code')
      return 'US';
    if (lower === 'zipcode' || lower === 'zip_code' || lower === 'zip' || lower === 'postalcode' || lower === 'postal_code')
      return '90210';

    // URLs — fixed values
    if (lower === 'url' || lower === 'website' || lower === 'link' || lower.endsWith('_url'))
      return 'https://example.com';
    if (lower === 'image' || lower === 'avatar' || lower === 'photo' || lower.endsWith('_image') || lower.endsWith('_url'))
      return 'https://example.com/image.png';

    // Status / type — fixed values
    if (lower === 'status')
      return 'active';
    if (lower === 'type' || lower.endsWith('_type'))
      return 'default';
    if (lower === 'role')
      return 'user';
    if (lower === 'priority')
      return 'medium';
    if (lower === 'color' || lower === 'colour')
      return '#3498db';

    // Fallback — unique per run
    return `test_${lower}_{{$timestamp}}`;
  }

  /**
   * Generate example object from schema
   */
  generateExampleFromSchema(schema, depth = 0, seen = new WeakSet()) {
    // Prevent infinite recursion
    if (depth > 10) return {};
    if (!schema) return {};
    if (typeof schema === 'object' && seen.has(schema)) return {};
    if (typeof schema === 'object') seen.add(schema);

    if (schema.example) {
      return schema.example;
    }

    if (schema.type === 'object' && schema.properties) {
      const example = {};
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        example[propName] = this.generateExample(propSchema, depth + 1, seen, propName);
      }
      return example;
    }

    if (schema.type === 'array' && schema.items) {
      return [this.generateExample(schema.items, depth + 1, seen)];
    }

    return this.generateExample(schema, depth + 1, seen);
  }

  /**
   * Get required fields from schema
   */
  getRequiredFields(schema) {
    if (!schema || !schema.properties) {
      return [];
    }
    return schema.required || [];
  }

  /**
   * Identify CRUD operations
   */
  identifyCRUDOperations() {
    const crud = {
      create: [],
      read: [],
      update: [],
      delete: [],
      list: []
    };

    for (const endpoint of this.endpoints) {
      const { method, path, operationId, summary } = endpoint;
      const lowerSummary = (summary + operationId).toLowerCase();

      if (method === 'POST') {
        crud.create.push(endpoint);
      } else if (method === 'GET') {
        if (path.includes('{') || lowerSummary.includes('get') || lowerSummary.includes('retrieve')) {
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
}
