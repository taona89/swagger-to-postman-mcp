/**
 * OpenAPI Wrapper Utility
 * Wraps partial OpenAPI specs (paths only) into complete OpenAPI documents
 */
import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';

export class OpenAPIWrapper {
  /**
   * Wraps a partial OpenAPI spec into a complete document
   * @param {string} filePath - Path to the partial spec file (.txt)
   * @returns {Object} Complete OpenAPI specification
   */
  static async wrapPartialSpec(filePath) {
    console.log(`📝 Reading partial OpenAPI spec: ${filePath}`);

    let content = await fs.readFile(filePath, 'utf8');
    let partialSpec;

    // Try to parse as JSON first (more common for partial specs)
    try {
      // Try parsing as JSON
      partialSpec = JSON.parse(content);
      console.log('✅ Parsed as JSON');
    } catch (jsonError) {
      // If JSON fails, try wrapping it in braces if it looks like object properties
      if (content.trim().startsWith('"') || content.trim().startsWith('/')) {
        try {
          // Remove trailing comma if exists
          let cleanContent = content.trim();
          if (cleanContent.endsWith(',')) {
            cleanContent = cleanContent.slice(0, -1);
            console.log('🔧 Removed trailing comma');
          }

          const wrappedContent = `{${cleanContent}}`;
          partialSpec = JSON.parse(wrappedContent);
          console.log('✅ Parsed as wrapped JSON object');
        } catch (wrapError) {
          // Try YAML as last resort
          try {
            partialSpec = yaml.load(content);
            console.log('✅ Parsed as YAML');
          } catch (yamlError) {
            throw new Error(`Failed to parse spec file. JSON error: ${jsonError.message}, Wrap error: ${wrapError.message}, YAML error: ${yamlError.message}`);
          }
        }
      } else {
        // Try YAML directly
        try {
          partialSpec = yaml.load(content);
          console.log('✅ Parsed as YAML');
        } catch (yamlError) {
          throw new Error(`Failed to parse spec file. JSON error: ${jsonError.message}, YAML error: ${yamlError.message}`);
        }
      }
    }

    // Extract API name from filename
    const fileName = path.basename(filePath, path.extname(filePath));
    const apiName = fileName
      .replace(/_openai|_swagger|_spec/gi, '')
      .split(/[_-]/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

    // Create complete OpenAPI wrapper
    const completeSpec = {
      openapi: '3.0.0',
      info: {
        title: `${apiName} API`,
        version: '1.0.0',
        description: `API for ${apiName}`
      },
      servers: [
        {
          url: 'https://api.example.com',
          description: 'Production server'
        }
      ],
      security: [
        {
          cookieAuth: []
        }
      ],
      paths: {},
      components: {
        securitySchemes: {
          cookieAuth: {
            type: 'apiKey',
            in: 'cookie',
            name: 'session_token'
          }
        },
        schemas: {}
      }
    };

    // If partialSpec is already complete, return it
    if (partialSpec.openapi || partialSpec.swagger) {
      console.log('✅ Spec is already complete OpenAPI format');
      return partialSpec;
    }

    // If it has paths, merge them
    if (partialSpec.paths) {
      completeSpec.paths = partialSpec.paths;
    } else if (typeof partialSpec === 'object' && !Array.isArray(partialSpec)) {
      // Assume the entire object is the paths section
      completeSpec.paths = partialSpec;
    }

    // Merge components if they exist
    if (partialSpec.components) {
      completeSpec.components = {
        ...completeSpec.components,
        ...partialSpec.components,
        securitySchemes: {
          ...completeSpec.components.securitySchemes,
          ...(partialSpec.components.securitySchemes || {})
        }
      };
    }

    // Extract and add schemas from responses
    this.extractSchemas(completeSpec);

    console.log(`✅ Wrapped partial spec into complete OpenAPI document`);
    console.log(`   Endpoints found: ${Object.keys(completeSpec.paths).length}`);

    return completeSpec;
  }

  /**
   * Extract schema references and add placeholder schemas
   * @param {Object} spec - OpenAPI specification
   */
  static extractSchemas(spec) {
    const schemaRefs = new Set();

    // Find all $ref references
    // Use a circular-safe traversal to avoid stack overflow
    const seen = new WeakSet();

    const traverse = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (seen.has(obj)) return; // Skip circular references
      seen.add(obj);

      if (obj.$ref && typeof obj.$ref === 'string' && obj.$ref.startsWith('#/components/schemas/')) {
        const schemaName = obj.$ref.split('/').pop();
        schemaRefs.add(schemaName);
      }

      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          traverse(obj[key]);
        }
      }
    };

    traverse(spec);

    // Add placeholder schemas for all references
    schemaRefs.forEach(schemaName => {
      if (!spec.components.schemas[schemaName]) {
        spec.components.schemas[schemaName] = {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' }
          }
        };
      }
    });
  }

  /**
   * Save wrapped spec to YAML file
   * @param {Object} spec - OpenAPI specification
   * @param {string} outputPath - Output file path
   */
  static async saveAsYAML(spec, outputPath) {
    const yamlContent = yaml.dump(spec, {
      indent: 2,
      lineWidth: 120,
      noRefs: true
    });

    await fs.writeFile(outputPath, yamlContent, 'utf8');
    console.log(`✅ Saved complete OpenAPI spec to: ${outputPath}`);
  }

  /**
   * Process .txt file: wrap and save as .yaml
   * @param {string} txtFilePath - Path to .txt file
   * @returns {string} Path to generated .yaml file
   */
  static async processTxtFile(txtFilePath) {
    const spec = await this.wrapPartialSpec(txtFilePath);

    const outputPath = txtFilePath.replace(/\.txt$/i, '.yaml');
    await this.saveAsYAML(spec, outputPath);

    return outputPath;
  }
}
