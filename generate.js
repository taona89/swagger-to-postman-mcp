#!/usr/bin/env node

/**
 * CLI tool to generate Postman collections from OpenAPI specs
 * Usage: node generate.js <path-to-openapi-spec> [output-directory]
 */

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
import fs from 'fs/promises';
import path from 'path';

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║       Swagger to Postman Collection Generator                   ║
╚══════════════════════════════════════════════════════════════════╝

Generate Postman test collections from OpenAPI/Swagger specifications.

Usage:
  node generate.js <spec-path> [output-dir] [options]

Arguments:
  spec-path      Path to OpenAPI/Swagger specification (YAML or JSON)
  output-dir     Output directory for generated files (optional, default: ./generated)

Options:
  --env-file <path>       Reuse values from an existing Postman environment file
  --data-file <format>    Generate iteration data file for Newman (csv or json)
  --row-count <n>         Number of data rows to generate (default: 3)
  --variables <json|path> Inject custom variables into the environment file
                          Accepts inline JSON or path to a .json file
  --bdd                   Generate BDD test cases in Gherkin (.feature) format

Examples:
  # Generate from YAML spec
  node generate.js ./specs/my-api.yaml

  # Generate with custom output directory
  node generate.js ./specs/my-api.yaml ./output

  # Generate with data-driven test file
  node generate.js ./specs/my-api.yaml ./output --data-file json

  # Inject custom variables
  node generate.js ./specs/my-api.yaml ./output --variables '{"tenantId":"abc-123"}'

  # Inject variables from file
  node generate.js ./specs/my-api.yaml ./output --variables ./my-variables.json

  # Reuse values from an existing environment file
  node generate.js ./specs/my-api.yaml ./output --env-file ./existing_environment.json

Generated Files:
  • [API_Name]_Positive.postman_collection.json  - Positive test scenarios
  • [API_Name]_Negative.postman_collection.json  - Negative test scenarios
  • [API_Name]_environment.json                  - Environment template
  • [API_Name]_README.md                         - Usage documentation
  • [API_Name]_TechSpec.md                       - Technical specification
  • [API_Name]_Report.html                       - Visual HTML report
  • [API_Name]_iteration_data.json/csv           - Data-driven test file (with --data-file)

Features:
  ✓ CRUD operation detection
  ✓ Contract testing
  ✓ Negative scenarios
  ✓ Authentication handling
  ✓ Environment generation
  ✓ Auto-documentation
  ✓ Data-driven tests (--data-file)
  ✓ Custom variable injection (--variables)

For more information, see README.md
`);
    process.exit(0);
  }

  // Parse positional args (skip flags)
  const positionalArgs = args.filter(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
  const specPath = args[0];
  const outputDir = (args[1] && !args[1].startsWith('--')) ? args[1] : './generated';

  // Parse --data-file flag
  const dataFileIdx = args.indexOf('--data-file');
  const dataFileFormat = dataFileIdx !== -1 ? (args[dataFileIdx + 1] || 'json') : null;
  if (dataFileFormat && !['csv', 'json'].includes(dataFileFormat)) {
    console.error(`❌ Invalid --data-file format: ${dataFileFormat}. Use 'csv' or 'json'.`);
    process.exit(1);
  }

  // Parse --env-file flag
  const envFileIdx = args.indexOf('--env-file');
  const sourceEnvFile = envFileIdx !== -1 ? args[envFileIdx + 1] : null;
  if (envFileIdx !== -1 && !sourceEnvFile) {
    console.error('❌ --env-file requires a path to a Postman environment .json file.');
    process.exit(1);
  }

  // Parse --variables flag
  const variablesIdx = args.indexOf('--variables');
  let customVariables = null;
  if (variablesIdx !== -1) {
    const varArg = args[variablesIdx + 1];
    if (!varArg) {
      console.error('❌ --variables requires a JSON string or path to a .json file.');
      process.exit(1);
    }
    try {
      if (varArg.startsWith('{')) {
        customVariables = JSON.parse(varArg);
      } else {
        const varContent = await fs.readFile(varArg, 'utf8');
        customVariables = JSON.parse(varContent);
      }
    } catch (err) {
      console.error(`❌ Failed to parse --variables: ${err.message}`);
      process.exit(1);
    }
  }

  // Parse --row-count flag
  const rowCountIdx = args.indexOf('--row-count');
  let rowCount = 3;
  if (rowCountIdx !== -1) {
    const n = parseInt(args[rowCountIdx + 1], 10);
    if (!Number.isInteger(n) || n < 1) {
      console.error('❌ --row-count must be a positive integer.');
      process.exit(1);
    }
    rowCount = n;
  }

  // Parse --bdd flag
  const generateBDD = args.includes('--bdd');

  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║       Swagger to Postman Collection Generator                   ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  try {
    // Check if spec file exists
    try {
      await fs.access(specPath);
    } catch (error) {
      console.error(`❌ Error: OpenAPI spec file not found: ${specPath}`);
      console.error('   Please check the file path and try again.\n');
      process.exit(1);
    }

    console.log(`📄 Loading OpenAPI specification: ${specPath}`);

    // Check if .txt file - auto-wrap it
    let actualSpecPath = specPath;
    if (specPath.toLowerCase().endsWith('.txt')) {
      console.log('📦 Detected .txt file - auto-wrapping to OpenAPI format...');
      actualSpecPath = await OpenAPIWrapper.processTxtFile(specPath);
      console.log(`✅ Wrapped spec saved to: ${actualSpecPath}\n`);
    }

    // Parse OpenAPI spec
    const parser = new OpenAPIParser();
    const apiSpec = await parser.parse(actualSpecPath);

    console.log(`✅ Successfully parsed OpenAPI specification`);
    console.log(`   API: ${apiSpec.info.title || 'Unknown'} v${apiSpec.info.version || '1.0.0'}`);
    console.log(`   Description: ${apiSpec.info.description || 'No description'}`);
    console.log(`   Base URL: ${apiSpec.baseUrl}`);
    console.log(`   Endpoints: ${apiSpec.endpoints.length}`);

    // Display endpoint breakdown
    const methodCount = {};
    apiSpec.endpoints.forEach(e => {
      methodCount[e.method] = (methodCount[e.method] || 0) + 1;
    });
    console.log('   Methods:', Object.entries(methodCount).map(([m, c]) => `${m}(${c})`).join(', '));
    console.log();

    // Create output directory
    await fs.mkdir(outputDir, { recursive: true });
    console.log(`📁 Output directory: ${outputDir}\n`);

    // Generate base name for files
    const baseName = sanitizeFilename(apiSpec.info.title);

    // Generate Positive Tests
    console.log('[1/4] 📝 Generating positive test collection...');
    const positiveGenerator = new PositiveTestGenerator(apiSpec, { dataDriven: !!dataFileFormat });
    const positiveCollection = positiveGenerator.generate();
    const positiveFile = path.join(outputDir, `${baseName}_Positive.postman_collection.json`);
    await fs.writeFile(positiveFile, JSON.stringify(positiveCollection, null, 2), 'utf8');
    console.log(`      ✅ ${path.basename(positiveFile)}`);
    console.log(`         Folders: ${positiveCollection.item.length}\n`);

    // Generate Negative Tests
    console.log('[2/4] 📝 Generating negative test collection...');
    const negativeGenerator = new NegativeTestGenerator(apiSpec);
    const negativeCollection = negativeGenerator.generate();
    const negativeFile = path.join(outputDir, `${baseName}_Negative.postman_collection.json`);
    await fs.writeFile(negativeFile, JSON.stringify(negativeCollection, null, 2), 'utf8');
    console.log(`      ✅ ${path.basename(negativeFile)}`);
    console.log(`         Test scenarios: ${negativeCollection.item.length}\n`);

    // Generate Environment
    console.log('[3/4] 📝 Generating environment file...');

    // Pass 1: Scan generated collections for all {{variable}} references
    const positiveVars = scanCollectionVariables(positiveCollection);
    const negativeVars = scanCollectionVariables(negativeCollection);
    const allVars = new Set([...positiveVars, ...negativeVars]);

    // Pass 2: Build example values from OpenAPI spec
    const exampleValues = buildExampleValues(apiSpec);

    // Preserve existing values from a source env file (--env-file) or the output env file
    const envFile = path.join(outputDir, `${baseName}_environment.json`);
    let existingBaseUrl = apiSpec.baseUrl;
    let existingUsername = '';
    let existingPassword = '';
    const existingEnvValues = new Map();

    // Load source env file: prefer --env-file, fall back to existing output file
    const envSource = sourceEnvFile || envFile;
    try {
      const existing = JSON.parse(await fs.readFile(envSource, 'utf8'));
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
      if (sourceEnvFile) {
        console.log(`      📥 Loaded ${existingEnvValues.size} values from: ${sourceEnvFile}`);
      }
    } catch (e) { /* file doesn't exist yet, use defaults */ }

    // Fixed keys that always appear first
    const fixedKeys = new Set(['baseUrl', 'username', 'password', 'authCookie', 'sessionToken', 'tenantId']);

    // Merge: all scanned {{var}} references PLUS all spec-derived variables from buildExampleValues
    const mergedVars = new Set([...allVars, ...exampleValues.keys()]);

    // Build environment variables with example values, overlaying source env values
    const envVariables = [];
    for (const varName of mergedVars) {
      if (fixedKeys.has(varName)) continue; // handled separately
      const value = existingEnvValues.get(varName) || exampleValues.get(varName) || '';
      envVariables.push({ key: varName, value, enabled: true });
    }
    // Sort for deterministic output
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
        { key: 'tenantId', value: exampleValues.get('tenantId') || '', enabled: true },
        ...envVariables
      ]
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

    await fs.writeFile(envFile, JSON.stringify(environment, null, 2), 'utf8');
    console.log(`      ✅ ${path.basename(envFile)}`);
    console.log(`         Variables: ${environment.values.length} (${envVariables.filter(v => v.value !== '').length} with example values)`);
    if (customVariables) {
      console.log(`         Custom variables injected: ${Object.keys(customVariables).length}`);
    }
    console.log();

    // Generate README
    console.log('[4/6] 📝 Generating documentation...');
    const readme = generateReadme(apiSpec, baseName, positiveFile, negativeFile, envFile);
    const readmeFile = path.join(outputDir, `${baseName}_README.md`);
    await fs.writeFile(readmeFile, readme, 'utf8');
    console.log(`      ✅ ${path.basename(readmeFile)}\n`);

    // Generate Technical Specification
    console.log('[5/6] 📋 Generating technical specification...');
    const techSpecGenerator = new TechSpecGenerator(apiSpec);
    const techSpec = techSpecGenerator.generate();
    const techSpecFile = path.join(outputDir, `${baseName}_TechSpec.md`);
    await fs.writeFile(techSpecFile, techSpec, 'utf8');
    console.log(`      ✅ ${path.basename(techSpecFile)}\n`);

    // Generate HTML Report
    console.log('[6/6] 📊 Generating HTML report...');
    const htmlReport = HTMLReportGenerator.generate(apiSpec, positiveCollection, negativeCollection);
    const htmlFile = path.join(outputDir, `${baseName}_Report.html`);
    await fs.writeFile(htmlFile, htmlReport, 'utf8');
    console.log(`      ✅ ${path.basename(htmlFile)}\n`);

    // Generate Data File (if requested)
    let dataFile = null;
    if (dataFileFormat) {
      console.log(`[7/7] 📊 Generating ${dataFileFormat.toUpperCase()} iteration data file...`);
      const dataGenerator = new DataFileGenerator(apiSpec, { rowCount });
      const rows = dataGenerator.generate();
      const ext = dataFileFormat === 'csv' ? 'csv' : 'json';
      dataFile = path.join(outputDir, `${baseName}_iteration_data.${ext}`);
      const content = dataFileFormat === 'csv' ? dataGenerator.toCSV(rows) : dataGenerator.toJSON(rows);
      await fs.writeFile(dataFile, content, 'utf8');
      console.log(`      ✅ ${path.basename(dataFile)}`);
      console.log(`         Rows: ${rows.length}, Fields: ${Object.keys(rows[0] || {}).length}\n`);
    }

    // Generate BDD test cases (if requested)
    let bddFile = null;
    if (generateBDD) {
      console.log('[BDD] 📝 Generating BDD test cases (Gherkin)...');
      const bddGenerator = new BDDGenerator(apiSpec);
      const bddContent = bddGenerator.generateSingleFile();
      bddFile = path.join(outputDir, `${baseName}_BDD.feature`);
      await fs.writeFile(bddFile, bddContent, 'utf8');
      const scenarioCount = (bddContent.match(/^\s+Scenario:/gm) || []).length;
      console.log(`      ✅ ${path.basename(bddFile)}`);
      console.log(`         Scenarios: ${scenarioCount}\n`);
    }

    // ── Verification ────────────────────────────────────────────────
    console.log('╔══════════════════════════════════════════════════════════════════╗');
    console.log('║                    VERIFICATION                                 ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝\n');

    // 1. Variable Completeness
    const varChecker = new VariableChecker();
    const varResult = varChecker.check(positiveCollection, negativeCollection, environment);
    console.log('🔍 Variable Completeness');
    console.log(`   ✅ ${varResult.resolved}/${varResult.total} variables resolved`);
    if (varResult.empty.length > 0) {
      console.log(`   ⚠️  ${varResult.empty.length} variables have empty values: ${varResult.empty.join(', ')}`);
    }
    if (varResult.missing.length > 0) {
      console.log(`   ❌ ${varResult.missing.length} variables missing from environment: ${varResult.missing.join(', ')}`);
    }
    if (varResult.unused.length > 0) {
      console.log(`   ℹ️  ${varResult.unused.length} unused environment variables: ${varResult.unused.join(', ')}`);
    }
    console.log();

    // 2. Endpoint Coverage
    const covChecker = new CoverageChecker();
    const covResult = covChecker.check(apiSpec, positiveCollection, negativeCollection);
    console.log('🔍 Endpoint Coverage');
    console.log(`   ${covResult.positivePercent === 100 ? '✅' : '⚠️'} ${covResult.positiveCovered}/${covResult.total} endpoints in positive tests (${covResult.positivePercent}%)`);
    if (covResult.uncoveredPositive.length > 0) {
      for (const ep of covResult.uncoveredPositive) {
        console.log(`      ❌ ${ep}`);
      }
    }
    console.log(`   ${covResult.negativePercent === 100 ? '✅' : '⚠️'} ${covResult.negativeCovered}/${covResult.writableTotal} writable endpoints in negative tests (${covResult.negativePercent}%)`);
    if (covResult.uncoveredNegative.length > 0) {
      for (const ep of covResult.uncoveredNegative) {
        console.log(`      ❌ ${ep}`);
      }
    }
    const readOnlyCount = covResult.total - covResult.writableTotal;
    if (readOnlyCount > 0) {
      console.log(`   ℹ️  ${readOnlyCount} read-only endpoints skipped for negative tests`);
    }
    console.log();

    // 3. Test Script Syntax
    const scriptChecker = new ScriptChecker();
    const scriptResult = scriptChecker.check(positiveCollection, negativeCollection);
    console.log('🔍 Test Script Syntax');
    if (scriptResult.errors.length === 0) {
      console.log(`   ✅ ${scriptResult.valid}/${scriptResult.total} test scripts have valid syntax`);
    } else {
      console.log(`   ❌ ${scriptResult.errors.length}/${scriptResult.total} scripts have syntax errors:`);
      for (const err of scriptResult.errors) {
        console.log(`      ❌ ${err.folder} > ${err.request}: ${err.error}`);
      }
    }
    console.log();

    // Summary
    console.log('╔══════════════════════════════════════════════════════════════════╗');
    console.log('║                    GENERATION COMPLETE                           ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝\n');

    console.log('📦 Generated Files:');
    console.log(`   1. ${path.basename(positiveFile)}`);
    console.log(`   2. ${path.basename(negativeFile)}`);
    console.log(`   3. ${path.basename(envFile)}`);
    console.log(`   4. ${path.basename(readmeFile)}`);
    console.log(`   5. ${path.basename(techSpecFile)} 📋`);
    console.log(`   6. ${path.basename(htmlFile)} 🌐`);
    if (dataFile) {
      console.log(`   7. ${path.basename(dataFile)} 📊`);
    }
    if (bddFile) {
      console.log(`   ${dataFile ? '8' : '7'}. ${path.basename(bddFile)} 🥒`);
    }
    console.log();

    console.log('📊 Statistics:');
    console.log(`   API: ${apiSpec.info.title}`);
    console.log(`   Endpoints: ${apiSpec.endpoints.length}`);
    console.log(`   Positive tests: ${positiveCollection.item.length} folders`);
    console.log(`   Negative tests: ${negativeCollection.item.length} scenarios\n`);

    console.log('🚀 Next Steps:');
    console.log(`   1. View HTML report: Open ${path.basename(htmlFile)} in browser 🌐`);
    console.log(`   2. Update environment file: ${path.basename(envFile)}`);
    console.log(`   3. Import collections into Postman`);
    console.log(`   4. Run tests with Newman:\n`);
    const positiveReportFile = path.join(outputDir, `${baseName}_Positive_Report.html`);
    const negativeReportFile = path.join(outputDir, `${baseName}_Negative_Report.html`);
    console.log(`      newman run "${positiveFile}" -e "${envFile}" --reporters htmlextra --reporter-htmlextra-export "${positiveReportFile}"`);
    console.log(`      newman run "${negativeFile}" -e "${envFile}" --reporters htmlextra --reporter-htmlextra-export "${negativeReportFile}"`);
    if (dataFile) {
      console.log(`\n   5. Run data-driven tests:\n`);
      console.log(`      newman run "${positiveFile}" -e "${envFile}" --iteration-data "${dataFile}"`);
    }
    console.log();

    console.log('✅ Success! Test collections and HTML report generated successfully.\n');

  } catch (error) {
    console.error('\n❌ Error generating test collections:');
    console.error(`   ${error.message}\n`);

    if (error.message.includes('Cannot read')) {
      console.error('💡 Tip: Ensure your OpenAPI spec is valid. Try validating it:');
      console.error('   npx swagger-cli validate your-spec.yaml\n');
    }

    process.exit(1);
  }
}

export function sanitizeFilename(name) {
  return name
    .replace(/[^a-z0-9_-]/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Recursively scan a Postman collection JSON for all {{variable}} references.
 * Returns a Set of variable names.
 */
export function scanCollectionVariables(collection) {
  const variables = new Set();
  const varRegex = /\{\{([^}]+)\}\}/g;

  // Postman built-in dynamic variables — must not be added to the environment
  const builtInVars = new Set([
    '$timestamp', '$isoTimestamp', '$randomUUID', '$randomInt',
    '$randomAlphaNumeric', '$randomBoolean', '$randomColor',
    '$guid', '$randomEmail', '$randomIP', '$randomUserAgent'
  ]);

  function walk(node) {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      let match;
      while ((match = varRegex.exec(node)) !== null) {
        if (!builtInVars.has(match[1])) {
          variables.add(match[1]);
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object') {
      for (const value of Object.values(node)) {
        walk(value);
      }
    }
  }

  walk(collection);
  return variables;
}

/**
 * Build a map of variable name → example value from the OpenAPI spec.
 * Extracts examples from path params, query params, and request body properties.
 */
export function buildExampleValues(apiSpec) {
  const examples = new Map();

  // Runtime variables - set descriptive placeholders
  examples.set('authCookie', '(set at runtime by login)');
  examples.set('sessionToken', '(set at runtime by login)');

  /**
   * Generate a smart example value for a schema type/format/name combination.
   */
  function exampleForSchema(schema, name) {
    if (!schema) return '';

    // Explicit example in spec
    if (schema.example !== undefined && schema.example !== '') return String(schema.example);
    // Explicit default in spec
    if (schema.default !== undefined && schema.default !== '') return String(schema.default);
    // Enum — use first value
    if (schema.enum && schema.enum.length > 0) return String(schema.enum[0]);

    const type = schema.type || 'string';
    const format = schema.format || '';
    const lowerName = (name || '').toLowerCase();

    // Format-based examples
    if (format === 'uuid') return '550e8400-e29b-41d4-a716-446655440000';
    if (format === 'date') return '2024-01-15';
    if (format === 'date-time') return '2024-01-15T10:00:00Z';
    if (format === 'email') return 'test@example.com';
    if (format === 'uri' || format === 'url') return 'https://example.com';

    // Name-based heuristics
    if (lowerName.includes('email')) return 'test@example.com';
    if (lowerName.includes('url') || lowerName.includes('uri')) return 'https://example.com';
    if (lowerName.includes('name') && lowerName.includes('user')) return 'testuser';
    if (lowerName.includes('name')) return 'Test Name';
    if (lowerName.includes('description')) return 'Sample description';
    if (lowerName.includes('title')) return 'Sample Title';
    if (lowerName.includes('search')) return 'test';
    if (lowerName.includes('color') || lowerName.includes('colour')) return '#FF5733';
    if (lowerName.includes('phone')) return '+1234567890';

    // Type-based fallback
    switch (type) {
      case 'string':
        if (lowerName.endsWith('_id') || lowerName.endsWith('_ids') || lowerName === 'id')
          return '550e8400-e29b-41d4-a716-446655440000';
        return 'sample_value';
      case 'integer':
      case 'number':
        return schema.minimum !== undefined ? String(schema.minimum) : '1';
      case 'boolean':
        return 'true';
      case 'array':
        return '[]';
      default:
        return 'sample_value';
    }
  }

  apiSpec.endpoints.forEach(endpoint => {
    // --- Path parameters ---
    endpoint.parameters.filter(p => p.in === 'path').forEach(param => {
      const paramName = param.name;
      const val = exampleForSchema(param.schema, paramName);

      // Direct param name (used in URL templates)
      examples.set(paramName, val);

      // valid_<param> variant (used by setup scripts)
      if (paramName === 'id') {
        examples.set('valid_id', val);
      } else if (paramName.endsWith('_id') || paramName.endsWith('_ids')) {
        const resourceName = paramName.replace(/_ids?$/, '');
        examples.set(`valid_${resourceName}_id`, val);
        examples.set(`valid_${paramName}`, val);
      } else {
        examples.set(`valid_${paramName}`, val);
      }
    });

    // --- Query parameters ---
    endpoint.parameters.filter(p => p.in === 'query').forEach(param => {
      const paramName = param.name;
      const lowerName = paramName.toLowerCase();
      const val = exampleForSchema(param.schema, paramName);

      // Area-related variables
      if (lowerName.includes('area') && (lowerName.includes('id') || lowerName === 'areas' || lowerName === 'area')) {
        examples.set('valid_areas', val || '550e8400-e29b-41d4-a716-446655440000');
        examples.set('areaId', val || '550e8400-e29b-41d4-a716-446655440000');
        examples.set('areaId2', '660e8400-e29b-41d4-a716-446655440001');
        examples.set('valid_areas_list', val || '550e8400-e29b-41d4-a716-446655440000');
      }

      // Asset-related
      if (lowerName.includes('asset') && lowerName.includes('id')) {
        examples.set('valid_asset_ids', val || '550e8400-e29b-41d4-a716-446655440000');
        examples.set('assetId', val || '550e8400-e29b-41d4-a716-446655440000');
      }

      // Type/method/state ID patterns
      if (lowerName.includes('type') && lowerName.includes('id'))
        examples.set('valid_types_id', val || '550e8400-e29b-41d4-a716-446655440000');
      if (lowerName.includes('method') && lowerName.includes('id'))
        examples.set('valid_methods_id', val || '550e8400-e29b-41d4-a716-446655440000');
      if (lowerName.includes('state') && lowerName.includes('id'))
        examples.set('valid_states_id', val || '550e8400-e29b-41d4-a716-446655440000');

      // Generic _id query params
      if (lowerName.endsWith('_id') || lowerName.endsWith('_ids')) {
        const resourceName = lowerName.replace(/_ids?$/, '');
        examples.set(`valid_${resourceName}_id`, val || '550e8400-e29b-41d4-a716-446655440000');
      }
    });

    // --- Request body properties ---
    if (endpoint.requestBody && endpoint.requestBody.schema && endpoint.requestBody.schema.properties) {
      const props = endpoint.requestBody.schema.properties;
      const example = endpoint.requestBody.example || {};

      for (const [propName, propSchema] of Object.entries(props)) {
        // Use the actual example value if present in the generated body
        if (example[propName] !== undefined && example[propName] !== '' && example[propName] !== null) {
          let val = typeof example[propName] === 'object'
            ? JSON.stringify(example[propName])
            : String(example[propName]);
          // Strip Postman dynamic variables from env values — they only resolve at runtime in requests
          val = val.replace(/_?\{\{\$[^}]+\}\}/g, '');
          examples.set(propName, val);
        } else {
          examples.set(propName, exampleForSchema(propSchema, propName));
        }

        // Also set valid_ variants for ID fields in body
        const lowerProp = propName.toLowerCase();
        if (lowerProp.endsWith('_id') || lowerProp.endsWith('_ids')) {
          const resourceName = lowerProp.replace(/_ids?$/, '');
          const val = examples.get(propName) || '550e8400-e29b-41d4-a716-446655440000';
          examples.set(`valid_${resourceName}_id`, val);
        }
      }
    }
  });

  return examples;
}

function generateReadme(apiSpec, baseName, positiveFile, negativeFile, envFile) {
  return `# ${apiSpec.info.title} - Test Suite

Auto-generated test collections from OpenAPI specification.

## API Information

- **Title:** ${apiSpec.info.title}
- **Version:** ${apiSpec.info.version}
- **Description:** ${apiSpec.info.description || 'No description'}
- **Base URL:** ${apiSpec.baseUrl}
- **Total Endpoints:** ${apiSpec.endpoints.length}

## Generated Collections

### Positive Test Collection
**File:** \`${path.basename(positiveFile)}\`

Contains positive test scenarios:
- Authentication setup
- Reference data extraction
- CRUD operations (Create, Read, Update, Delete, List)
- Contract testing
- Response validation
- Performance checks

### Negative Test Collection
**File:** \`${path.basename(negativeFile)}\`

Contains negative test scenarios:
- Missing required fields
- Empty values
- Invalid data types
- Malformed JSON
- Invalid IDs
- Non-existent resources
- Unauthorized access

## Setup

1. **Update Environment File**

Edit \`${path.basename(envFile)}\`:

\`\`\`json
{
  "baseUrl": "https://your-api-url.com",
  "username": "your_username",
  "password": "your_password"
}
\`\`\`

2. **Import into Postman**

- Open Postman
- Click "Import"
- Select both collection files
- Import environment file

## Running Tests

### Using Newman

\`\`\`bash
# Install Newman
npm install -g newman newman-reporter-htmlextra

# Run positive tests
newman run "${path.basename(positiveFile)}" \\
  -e "${path.basename(envFile)}" \\
  --reporters htmlextra \\
  --reporter-htmlextra-export "${baseName}_Positive_Report.html"

# Run negative tests
newman run "${path.basename(negativeFile)}" \\
  -e "${path.basename(envFile)}" \\
  --reporters htmlextra \\
  --reporter-htmlextra-export "${baseName}_Negative_Report.html"
\`\`\`

### Using Postman

1. Select the imported environment
2. Open a collection
3. Click "Run" button
4. View results in Collection Runner

## API Endpoints

${apiSpec.endpoints.map(e => `- \`${e.method.padEnd(6)} ${e.path}\` - ${e.summary || 'No description'}`).join('\n')}

## Notes

- Update environment variables before running tests
- Positive tests should be run before negative tests
- Check test assertions for specific validation rules

---

Generated on ${new Date().toISOString()} by Swagger to Postman MCP
`;
}

// Run the CLI only when invoked directly (not when imported)
const isDirectRun = process.argv[1] &&
  import.meta.url === new URL('file:///' + process.argv[1].replace(/\\/g, '/')).href;
if (isDirectRun) {
  main();
}
