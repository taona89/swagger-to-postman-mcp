/**
 * Technical Specification Generator
 * Generates comprehensive technical documentation from OpenAPI specifications
 */
import { mdCell } from '../core/escape.js';
import { flattenSchema, schemaType, stripDynamicVariables } from '../core/schema.js';

export class TechSpecGenerator {
  constructor(apiSpec) {
    this.apiSpec = apiSpec;
  }

  /**
   * Generate complete technical specification document
   */
  generate() {
    const sections = [
      this.generateHeader(),
      this.generateOverview(),
      this.generateAuthentication(),
      this.generateEndpointsSection(),
      this.generateDataModels(),
      this.generateErrorHandling(),
      this.generateVersioning()
    ];

    return sections.join('\n\n---\n\n');
  }

  /**
   * Generate document header
   */
  generateHeader() {
    const title = this.apiSpec.info.title || 'API';
    const version = this.apiSpec.info.version || '1.0.0';
    const date = new Date().toISOString().split('T')[0];

    return `# ${title} - Technical Specification

**Version:** ${version}
**Date:** ${date}
**Status:** ${this.apiSpec.info.description ? 'Active' : 'Draft'}

## Document Information

| Property | Value |
|----------|-------|
| API Name | ${title} |
| Version | ${version} |
| Base URL | ${mdCell(this.apiSpec.baseUrl || '(not set)')} |
| Spec Format | ${this.apiSpec.specVersion} |
| Generated | ${date} |`;
  }

  /**
   * Generate overview section
   */
  generateOverview() {
    const description = this.apiSpec.info.description || 'No description provided';
    const endpointCount = this.apiSpec.endpoints.length;
    const methods = [...new Set(this.apiSpec.endpoints.map(e => e.method))];

    return `## Overview

${description}

### Key Features

- **Total Endpoints:** ${endpointCount}
- **HTTP Methods:** ${methods.join(', ')}
- **Authentication:** ${this.apiSpec.authSchemes.length > 0 ? 'Required' : 'Not Required'}
- **Rate Limiting:** Not Specified
- **API Style:** RESTful

### Supported Operations

${this.generateOperationsSummary()}`;
  }

  /**
   * Generate operations summary
   */
  generateOperationsSummary() {
    const operations = {
      CREATE: this.apiSpec.endpoints.filter(e => e.method === 'POST').length,
      READ: this.apiSpec.endpoints.filter(e => e.method === 'GET').length,
      UPDATE: this.apiSpec.endpoints.filter(e => e.method === 'PUT' || e.method === 'PATCH').length,
      DELETE: this.apiSpec.endpoints.filter(e => e.method === 'DELETE').length
    };

    return Object.entries(operations)
      .filter(([_, count]) => count > 0)
      .map(([op, count]) => `- **${op}:** ${count} endpoint(s)`)
      .join('\n');
  }

  /**
   * Generate authentication section
   */
  generateAuthentication() {
    if (this.apiSpec.authSchemes.length === 0) {
      return `## Authentication

This API does not require authentication.`;
    }

    return `## Authentication

### Authentication Methods

${this.apiSpec.authSchemes.map(scheme => {
  if (scheme.type === 'apiKey') {
    const example = scheme.in === 'header'
      ? `${scheme.paramName}: <api-key>`
      : scheme.in === 'cookie' ? `Cookie: ${scheme.paramName}=<api-key>` : `?${scheme.paramName}=<api-key>`;
    return `#### ${scheme.key} (API key)

- **Location:** ${scheme.in}
- **Parameter Name:** \`${scheme.paramName}\`

**Example:**
\`\`\`
${example}
\`\`\``;
  } else if (scheme.type === 'http') {
    return `#### ${scheme.key} (HTTP ${scheme.scheme || 'auth'})

- **Location:** Authorization header

**Example:**
\`\`\`
Authorization: ${scheme.scheme === 'basic' ? 'Basic <base64 username:password>' : 'Bearer <token>'}
\`\`\``;
  }
  return `#### ${scheme.key} (${scheme.type})\n\nSee the API documentation for details.`;
}).join('\n\n')}`;
  }

  /**
   * Generate endpoints section
   */
  generateEndpointsSection() {
    const groupedEndpoints = this.groupEndpointsByTag();

    return `## API Endpoints

### Endpoint Summary

${this.generateEndpointTable()}

### Detailed Endpoint Documentation

${Object.entries(groupedEndpoints).map(([tag, endpoints]) =>
  this.generateTagSection(tag, endpoints)
).join('\n\n')}`;
  }

  /**
   * Generate endpoint summary table
   */
  generateEndpointTable() {
    return `| Method | Endpoint | Description |
|--------|----------|-------------|
${this.apiSpec.endpoints.map(e =>
  `| ${e.method.padEnd(6)} | \`${mdCell(e.path)}\` | ${mdCell(e.summary || 'No description')} |`
).join('\n')}`;
  }

  /**
   * Group endpoints by tag
   */
  groupEndpointsByTag() {
    const grouped = {};

    this.apiSpec.endpoints.forEach(endpoint => {
      const tag = endpoint.tags && endpoint.tags.length > 0
        ? endpoint.tags[0]
        : 'General';

      if (!grouped[tag]) {
        grouped[tag] = [];
      }
      grouped[tag].push(endpoint);
    });

    return grouped;
  }

  /**
   * Generate section for a tag group
   */
  generateTagSection(tag, endpoints) {
    return `#### ${this.formatTagName(tag)}

${endpoints.map(endpoint => this.generateEndpointDetails(endpoint)).join('\n\n')}`;
  }

  /**
   * Generate detailed endpoint documentation
   */
  generateEndpointDetails(endpoint) {
    const pathParams = endpoint.parameters.filter(p => p.in === 'path');
    const queryParams = endpoint.parameters.filter(p => p.in === 'query');
    const hasBody = endpoint.requestBody && endpoint.requestBody.schema;

    return `##### ${endpoint.method} ${endpoint.path}

**Summary:** ${endpoint.summary || 'No summary'}

**Description:** ${endpoint.description || 'No description provided'}

${pathParams.length > 0 ? `**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
${pathParams.map(p =>
  `| ${mdCell(p.name)} | ${mdCell(schemaType(p.schema) || 'string')} | ${p.required ? 'Yes' : 'No'} | ${mdCell(p.description)} |`
).join('\n')}
` : ''}

${queryParams.length > 0 ? `**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
${queryParams.map(p =>
  `| ${mdCell(p.name)} | ${mdCell(schemaType(p.schema) || 'string')} | ${p.required ? 'Yes' : 'No'} | ${mdCell(p.description)} |`
).join('\n')}
` : ''}

${hasBody ? `**Request Body** (\`${endpoint.requestBody.contentType}\`):

\`\`\`json
${JSON.stringify(stripDynamicVariables(endpoint.requestBody.example), null, 2)}
\`\`\`

**Schema:**
${this.formatSchema(endpoint.requestBody.schema)}
` : ''}

**Responses:**

${this.generateResponsesTable(endpoint.responses)}

**Example Request:**

\`\`\`bash
curl -X ${endpoint.method} "${this.apiSpec.baseUrl}${endpoint.path}"${hasBody ? ` \\
  -H "Content-Type: ${endpoint.requestBody.contentType}" \\
  -d '${JSON.stringify(stripDynamicVariables(endpoint.requestBody.example)).replace(/'/g, "'\\''")}'` : ''}
\`\`\``;
  }

  /**
   * Format schema properties
   */
  formatSchema(schema) {
    const flat = flattenSchema(schema);
    if (!flat.properties) {
      return '- See API specification for schema details';
    }

    return Object.entries(flat.properties)
      .map(([name, prop]) => {
        const required = flat.required?.includes(name) ? '(required)' : '(optional)';
        return `- **${name}** ${required}: ${schemaType(prop) || 'any'} - ${(prop?.description || 'No description').replace(/\r?\n/g, ' ')}`;
      })
      .join('\n');
  }

  /**
   * Generate responses table
   */
  generateResponsesTable(responses) {
    return `| Status Code | Description |
|-------------|-------------|
${Object.entries(responses).map(([code, response]) =>
  `| ${mdCell(code)} | ${mdCell(response.description || 'No description')} |`
).join('\n')}`;
  }

  /**
   * Generate data models section
   */
  generateDataModels() {
    if (!this.apiSpec.schemas || Object.keys(this.apiSpec.schemas).length === 0) {
      return `## Data Models

No data models defined in specification.`;
    }

    return `## Data Models

${Object.entries(this.apiSpec.schemas).map(([name, schema]) =>
      this.generateSchemaDoc(name, schema)
    ).join('\n\n')}`;
  }

  /**
   * Generate schema documentation
   */
  generateSchemaDoc(name, schema) {
    return `### ${name}

${schema.description || 'No description provided'}

**Type:** ${schema.type || 'object'}

${schema.properties ? `**Properties:**

| Property | Type | Required | Description |
|----------|------|----------|-------------|
${Object.entries(schema.properties).map(([propName, prop]) =>
  `| ${mdCell(propName)} | ${mdCell(schemaType(prop) || 'any')} | ${schema.required?.includes(propName) ? 'Yes' : 'No'} | ${mdCell(prop?.description)} |`
).join('\n')}` : ''}

**Example:**

\`\`\`json
${JSON.stringify(this.generateSchemaExample(schema), null, 2)}
\`\`\``;
  }

  /**
   * Generate example from schema
   */
  generateSchemaExample(schema) {
    if (schema.example) return schema.example;

    if (schema.type === 'object' && schema.properties) {
      const example = {};
      Object.entries(schema.properties).forEach(([name, prop]) => {
        example[name] = prop.example || this.getTypeExample(prop.type);
      });
      return example;
    }

    return this.getTypeExample(schema.type);
  }

  /**
   * Get example value for type
   */
  getTypeExample(type) {
    const examples = {
      string: 'string',
      number: 0,
      integer: 0,
      boolean: true,
      array: [],
      object: {}
    };
    return examples[type] || null;
  }

  /**
   * Generate error handling section
   */
  generateErrorHandling() {
    const rows = [];
    for (const endpoint of this.apiSpec.endpoints) {
      for (const [code, response] of Object.entries(endpoint.responses || {})) {
        if (/^[45]\d\d$/.test(code)) {
          rows.push(`| ${mdCell(`${endpoint.method} ${endpoint.path}`)} | ${code} | ${mdCell(response.description)} |`);
        }
      }
    }
    return `## Error Handling

Error responses documented in the specification:

${rows.length > 0 ? `| Operation | Status | Description |
|-----------|--------|-------------|
${rows.join('\n')}` : '_The specification documents no 4xx/5xx responses._'}`;
  }

  /**
   * Generate versioning section
   */
  generateVersioning() {
    return `## API Versioning

**Current Version:** ${this.apiSpec.info.version || '1.0.0'}

### Version History

| Version | Date | Changes |
|---------|------|---------|
| ${this.apiSpec.info.version || '1.0.0'} | ${new Date().toISOString().split('T')[0]} | Initial specification |

### Versioning Strategy

- API version is included in the base URL or headers
- Breaking changes result in new major versions
- Backward-compatible changes increment minor versions
- Bug fixes increment patch versions

---

## Support and Contact

For technical support or questions about this API:

- **Documentation:** See OpenAPI specification file
- **Issues:** Contact API team
- **Updates:** Monitor API changelog

---

*This technical specification was automatically generated from the OpenAPI specification.*`;
  }

  /**
   * Format tag name
   */
  formatTagName(tag) {
    return tag.charAt(0).toUpperCase() + tag.slice(1).replace(/_/g, ' ');
  }
}
