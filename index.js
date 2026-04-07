#!/usr/bin/env node

/**
 * MCP Server – Swagger to Postman Collection Generator
 * Exposes tools for listing, analyzing, validating OpenAPI specs and generating Postman test suites.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { OpenAPIParser } from './src/parsers/openapi-parser.js';
import { PositiveTestGenerator } from './src/generators/positive-generator.js';
import { NegativeTestGenerator } from './src/generators/negative-generator.js';
import { HTMLReportGenerator } from './src/generators/html-report-generator.js';
import { TechSpecGenerator } from './src/generators/tech-spec-generator.js';
import { DataFileGenerator } from './src/generators/data-file-generator.js';
import { BDDGenerator } from './src/generators/bdd-generator.js';
import { VariableChecker } from './src/validators/variable-checker.js';
import { CoverageChecker } from './src/validators/coverage-checker.js';
import { ScriptChecker } from './src/validators/script-checker.js';
import { OpenAPIWrapper } from './src/utils/openapi-wrapper.js';
import { sanitizeFilename, scanCollectionVariables, buildExampleValues } from './generate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SWAGGER_DIR = path.join(__dirname, 'swagger');

// Redirect console.log to stderr so MCP protocol on stdout stays clean
const origLog = console.log;
console.log = (...args) => process.stderr.write(args.join(' ') + '\n');

const server = new McpServer({
  name: 'swagger-to-postman',
  version: '1.0.0',
});

// ── Tool 1: list_swagger_files ──────────────────────────────────────────────
server.tool(
  'list_swagger_files',
  'List available OpenAPI/Swagger specs in the swagger/ directory',
  {},
  async () => {
    try {
      const entries = await fs.readdir(SWAGGER_DIR);
      const specs = entries
        .filter(f => /\.(ya?ml|json|txt)$/i.test(f))
        .map(f => ({ filename: f, path: path.join(SWAGGER_DIR, f) }));
      return { content: [{ type: 'text', text: JSON.stringify(specs, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error listing swagger files: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool 2: analyze_openapi ─────────────────────────────────────────────────
server.tool(
  'analyze_openapi',
  'Parse an OpenAPI spec and return its structure (endpoints, methods, schemas) without generating files',
  { spec_path: z.string().describe('Path to the OpenAPI spec file') },
  async ({ spec_path }) => {
    try {
      const resolved = path.resolve(spec_path);
      let actualPath = resolved;
      if (resolved.toLowerCase().endsWith('.txt')) {
        actualPath = await OpenAPIWrapper.processTxtFile(resolved);
      }
      const parser = new OpenAPIParser();
      const apiSpec = await parser.parse(actualPath);

      const methodCount = {};
      apiSpec.endpoints.forEach(e => {
        methodCount[e.method] = (methodCount[e.method] || 0) + 1;
      });

      const analysis = {
        name: apiSpec.info.title || 'Unknown',
        version: apiSpec.info.version || '1.0.0',
        description: apiSpec.info.description || 'No description',
        baseUrl: apiSpec.baseUrl,
        endpointCount: apiSpec.endpoints.length,
        methods: methodCount,
        endpoints: apiSpec.endpoints.map(e => ({
          method: e.method,
          path: e.path,
          summary: e.summary || e.operationId,
          parameters: e.parameters.length,
          hasRequestBody: !!e.requestBody,
        })),
      };
      return { content: [{ type: 'text', text: JSON.stringify(analysis, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error analyzing spec: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool 3: generate_tests ──────────────────────────────────────────────────
server.tool(
  'generate_tests',
  'Generate the full Postman test suite (positive, negative, environment, readme, techspec, HTML report) from an OpenAPI spec',
  {
    spec_path: z.string().describe('Path to the OpenAPI spec file'),
    output_dir: z.string().optional().describe('Output directory (default: ./generated)'),
    generate_data_file: z.boolean().optional().describe('Generate iteration data file for Newman --iteration-data'),
    data_format: z.enum(['csv', 'json']).optional().describe('Data file format (default: json)'),
    row_count: z.number().int().positive().optional().describe('Number of data rows to generate (default: 3)'),
    variables: z.string().optional().describe('JSON string of custom variables to inject into the environment file'),
    env_file: z.string().optional().describe('Path to an existing Postman environment file to reuse values from'),
  },
  async ({ spec_path, output_dir, generate_data_file, data_format, row_count, variables, env_file }) => {
    try {
      const resolved = path.resolve(spec_path);
      const outDir = path.resolve(output_dir || './generated');

      let actualPath = resolved;
      if (resolved.toLowerCase().endsWith('.txt')) {
        actualPath = await OpenAPIWrapper.processTxtFile(resolved);
      }

      const parser = new OpenAPIParser();
      const apiSpec = await parser.parse(actualPath);
      await fs.mkdir(outDir, { recursive: true });
      const baseName = sanitizeFilename(apiSpec.info.title);

      // Parse custom variables
      let customVariables = null;
      if (variables) {
        try {
          customVariables = JSON.parse(variables);
        } catch (e) {
          return { content: [{ type: 'text', text: `Error parsing variables JSON: ${e.message}` }], isError: true };
        }
      }

      // Positive tests
      const positiveGenerator = new PositiveTestGenerator(apiSpec, { dataDriven: !!generate_data_file });
      const positiveCollection = positiveGenerator.generate();
      const positiveFile = path.join(outDir, `${baseName}_Positive.postman_collection.json`);
      await fs.writeFile(positiveFile, JSON.stringify(positiveCollection, null, 2), 'utf8');

      // Negative tests
      const negativeGenerator = new NegativeTestGenerator(apiSpec);
      const negativeCollection = negativeGenerator.generate();
      const negativeFile = path.join(outDir, `${baseName}_Negative.postman_collection.json`);
      await fs.writeFile(negativeFile, JSON.stringify(negativeCollection, null, 2), 'utf8');

      // Environment
      const positiveVars = scanCollectionVariables(positiveCollection);
      const negativeVars = scanCollectionVariables(negativeCollection);
      const allVars = new Set([...positiveVars, ...negativeVars]);
      const exampleValues = buildExampleValues(apiSpec);

      // Load values from source env file if provided
      const existingEnvValues = new Map();
      let existingBaseUrl = apiSpec.baseUrl;
      let existingUsername = 'your_username';
      let existingPassword = 'your_password';
      if (env_file) {
        try {
          const existing = JSON.parse(await fs.readFile(path.resolve(env_file), 'utf8'));
          if (existing.values && Array.isArray(existing.values)) {
            for (const v of existing.values) {
              if (v.key && v.value && v.value !== '' && !v.value.startsWith('(set at runtime')) {
                existingEnvValues.set(v.key, v.value);
              }
            }
            if (existingEnvValues.has('baseUrl')) existingBaseUrl = existingEnvValues.get('baseUrl');
            if (existingEnvValues.has('username')) existingUsername = existingEnvValues.get('username');
            if (existingEnvValues.has('password')) existingPassword = existingEnvValues.get('password');
          }
        } catch (e) { /* source env file not found, use defaults */ }
      }

      const fixedKeys = new Set(['baseUrl', 'username', 'password', 'authCookie', 'sessionToken', 'tenantId']);
      const mergedVars = new Set([...allVars, ...exampleValues.keys()]);
      const envVariables = [];
      for (const varName of mergedVars) {
        if (fixedKeys.has(varName)) continue;
        envVariables.push({ key: varName, value: existingEnvValues.get(varName) || exampleValues.get(varName) || '', enabled: true });
      }
      envVariables.sort((a, b) => a.key.localeCompare(b.key));

      const environment = {
        id: `${Date.now()}-env`,
        name: `${apiSpec.info.title} - Environment`,
        values: [
          { key: 'baseUrl', value: existingBaseUrl, enabled: true },
          { key: 'username', value: existingUsername, enabled: true },
          { key: 'password', value: existingPassword, enabled: true },
          { key: 'authCookie', value: '(set at runtime by login)', enabled: true },
          { key: 'sessionToken', value: '(set at runtime by login)', enabled: true },
          { key: 'tenantId', value: existingEnvValues.get('tenantId') || exampleValues.get('tenantId') || '', enabled: true },
          ...envVariables,
        ],
      };
      // Apply custom variable injection
      if (customVariables) {
        for (const [key, value] of Object.entries(customVariables)) {
          const existing = environment.values.find(v => v.key === key);
          if (existing) {
            existing.value = String(value);
          } else {
            environment.values.push({ key, value: String(value), enabled: true });
          }
        }
      }

      const envFile = path.join(outDir, `${baseName}_environment.json`);
      await fs.writeFile(envFile, JSON.stringify(environment, null, 2), 'utf8');

      // Tech Spec
      const techSpecGenerator = new TechSpecGenerator(apiSpec);
      const techSpec = techSpecGenerator.generate();
      const techSpecFile = path.join(outDir, `${baseName}_TechSpec.md`);
      await fs.writeFile(techSpecFile, techSpec, 'utf8');

      // HTML Report
      const htmlReport = HTMLReportGenerator.generate(apiSpec, positiveCollection, negativeCollection);
      const htmlFile = path.join(outDir, `${baseName}_Report.html`);
      await fs.writeFile(htmlFile, htmlReport, 'utf8');

      // README
      const readme = `# ${apiSpec.info.title} - Test Suite\n\nGenerated ${new Date().toISOString()}\n`;
      const readmeFile = path.join(outDir, `${baseName}_README.md`);
      await fs.writeFile(readmeFile, readme, 'utf8');

      // Data File (if requested)
      let dataFilePath = null;
      if (generate_data_file) {
        const fmt = data_format || 'json';
        const dataGenerator = new DataFileGenerator(apiSpec, { rowCount: row_count ?? 3 });
        const rows = dataGenerator.generate();
        const ext = fmt === 'csv' ? 'csv' : 'json';
        dataFilePath = path.join(outDir, `${baseName}_iteration_data.${ext}`);
        const content = fmt === 'csv' ? dataGenerator.toCSV(rows) : dataGenerator.toJSON(rows);
        await fs.writeFile(dataFilePath, content, 'utf8');
      }

      const generatedFiles = [
        positiveFile, negativeFile, envFile, readmeFile, techSpecFile, htmlFile,
        ...(dataFilePath ? [dataFilePath] : []),
      ].map(f => path.basename(f));

      // Verification
      const varResult = new VariableChecker().check(positiveCollection, negativeCollection, environment);
      const covResult = new CoverageChecker().check(apiSpec, positiveCollection, negativeCollection);
      const scriptResult = new ScriptChecker().check(positiveCollection, negativeCollection);

      const result = {
        api: apiSpec.info.title,
        outputDir: outDir,
        files: generatedFiles,
        stats: {
          endpoints: apiSpec.endpoints.length,
          positiveFolders: positiveCollection.item.length,
          negativeScenarios: negativeCollection.item.length,
          envVariables: environment.values.length,
        },
        verification: {
          variables: {
            resolved: varResult.resolved,
            total: varResult.total,
            missing: varResult.missing,
            empty: varResult.empty,
          },
          coverage: {
            positivePercent: covResult.positivePercent,
            negativePercent: covResult.negativePercent,
            uncoveredPositive: covResult.uncoveredPositive,
            uncoveredNegative: covResult.uncoveredNegative,
          },
          scripts: {
            valid: scriptResult.valid,
            total: scriptResult.total,
            errors: scriptResult.errors,
          },
        },
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error generating tests: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool 4: validate_spec ───────────────────────────────────────────────────
server.tool(
  'validate_spec',
  'Check if an OpenAPI spec is valid before generating tests',
  { spec_path: z.string().describe('Path to the OpenAPI spec file') },
  async ({ spec_path }) => {
    try {
      const resolved = path.resolve(spec_path);
      let actualPath = resolved;
      if (resolved.toLowerCase().endsWith('.txt')) {
        actualPath = await OpenAPIWrapper.processTxtFile(resolved);
      }
      const parser = new OpenAPIParser();
      const apiSpec = await parser.parse(actualPath);

      const result = {
        valid: true,
        info: {
          title: apiSpec.info.title,
          version: apiSpec.info.version,
          endpoints: apiSpec.endpoints.length,
        },
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const result = { valid: false, error: err.message };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  }
);

// ── Tool 5: verify_collection ────────────────────────────────────────────────
server.tool(
  'verify_collection',
  'Verify a generated Postman collection: check variable completeness, test script syntax, and optionally endpoint coverage',
  {
    collection_path: z.string().describe('Path to a Postman collection JSON file'),
    env_path: z.string().optional().describe('Path to a Postman environment JSON file'),
    spec_path: z.string().optional().describe('Path to the OpenAPI spec (enables coverage check)'),
  },
  async ({ collection_path, env_path, spec_path }) => {
    try {
      const collection = JSON.parse(await fs.readFile(path.resolve(collection_path), 'utf8'));
      const emptyCollection = { item: [] };

      const result = {};

      // Script syntax check
      const scriptResult = new ScriptChecker().check(collection, emptyCollection);
      result.scripts = {
        valid: scriptResult.valid,
        total: scriptResult.total,
        errors: scriptResult.errors,
      };

      // Variable completeness (if env provided)
      if (env_path) {
        const environment = JSON.parse(await fs.readFile(path.resolve(env_path), 'utf8'));
        const varResult = new VariableChecker().check(collection, emptyCollection, environment);
        result.variables = {
          resolved: varResult.resolved,
          total: varResult.total,
          missing: varResult.missing,
          empty: varResult.empty,
          unused: varResult.unused,
        };
      }

      // Coverage (if spec provided)
      if (spec_path) {
        const resolved = path.resolve(spec_path);
        let actualPath = resolved;
        if (resolved.toLowerCase().endsWith('.txt')) {
          actualPath = await OpenAPIWrapper.processTxtFile(resolved);
        }
        const parser = new OpenAPIParser();
        const apiSpec = await parser.parse(actualPath);
        const covResult = new CoverageChecker().check(apiSpec, collection, emptyCollection);
        result.coverage = {
          positivePercent: covResult.positivePercent,
          total: covResult.total,
          uncovered: covResult.uncoveredPositive,
        };
      }

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error verifying collection: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool 6: generate_bdd ─────────────────────────────────────────────────────
server.tool(
  'generate_bdd',
  'Generate BDD (Behavior-Driven Development) test cases in Gherkin format from an OpenAPI spec',
  {
    spec_path: z.string().describe('Path to the OpenAPI spec file'),
    output_dir: z.string().optional().describe('Output directory (default: ./generated)'),
    single_file: z.boolean().optional().describe('Generate a single .feature file instead of one per resource (default: true)'),
  },
  async ({ spec_path, output_dir, single_file }) => {
    try {
      const resolved = path.resolve(spec_path);
      const outDir = path.resolve(output_dir || './generated');

      let actualPath = resolved;
      if (resolved.toLowerCase().endsWith('.txt')) {
        actualPath = await OpenAPIWrapper.processTxtFile(resolved);
      }

      const parser = new OpenAPIParser();
      const apiSpec = await parser.parse(actualPath);
      await fs.mkdir(outDir, { recursive: true });
      const baseName = apiSpec.info.title.replace(/[^a-z0-9_-]/gi, '_').replace(/_+/g, '_');

      const bddGenerator = new BDDGenerator(apiSpec);
      const generatedFiles = [];

      if (single_file !== false) {
        // Single combined file (default)
        const content = bddGenerator.generateSingleFile();
        const filePath = path.join(outDir, `${baseName}_BDD.feature`);
        await fs.writeFile(filePath, content, 'utf8');
        generatedFiles.push(path.basename(filePath));
      } else {
        // One file per resource
        const features = bddGenerator.generate();
        for (const [filename, content] of features) {
          const filePath = path.join(outDir, filename);
          await fs.writeFile(filePath, content, 'utf8');
          generatedFiles.push(filename);
        }
      }

      const result = {
        api: apiSpec.info.title,
        outputDir: outDir,
        files: generatedFiles,
        endpoints: apiSpec.endpoints.length,
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error generating BDD tests: ${err.message}` }], isError: true };
    }
  }
);

// ── Start server ────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('swagger-to-postman MCP server running on stdio\n');
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
