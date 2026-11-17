/**
 * Suite generation service shared by the CLI (generate.js) and the MCP server (index.js).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { OpenAPIParser } from '../parsers/openapi-parser.js';
import { PositiveTestGenerator } from '../generators/positive-generator.js';
import { NegativeTestGenerator } from '../generators/negative-generator.js';
import { HTMLReportGenerator } from '../generators/html-report-generator.js';
import { TechSpecGenerator } from '../generators/tech-spec-generator.js';
import { DataFileGenerator } from '../generators/data-file-generator.js';
import { BDDGenerator } from '../generators/bdd-generator.js';
import { generateSuiteReadme } from '../generators/readme-generator.js';
import { VariableChecker } from '../validators/variable-checker.js';
import { CoverageChecker } from '../validators/coverage-checker.js';
import { ScriptChecker } from '../validators/script-checker.js';
import { buildEnvironment, readEnvironmentValues } from './environment.js';
import { sanitizeFilename } from './endpoints.js';
import { isOpaqueBody } from './request.js';

export class OverwriteError extends Error {}

/** lstat-based: also sees dangling symlinks, which fs.access would miss. */
async function lstatOrNull(file) {
  try { return await fs.lstat(file); } catch { return null; }
}

async function writeAll(outputDir, contents, overwrite) {
  const clashes = [];
  for (const name of contents.keys()) {
    const stat = await lstatOrNull(path.join(outputDir, name));
    if (stat?.isSymbolicLink()) throw new OverwriteError(`Refusing to write through the symbolic link ${path.join(outputDir, name)}`);
    if (stat) clashes.push(name);
  }
  if (!overwrite && clashes.length > 0) {
    throw new OverwriteError(`Refusing to overwrite existing files in ${outputDir}: ${clashes.join(', ')}. ` +
      'Pass overwrite: true (CLI: omit --no-overwrite) or choose another output directory.');
  }
  await fs.mkdir(outputDir, { recursive: true });
  for (const [name, content] of contents) {
    await fs.writeFile(path.join(outputDir, name), content, 'utf8');
  }
  return [...contents.keys()];
}

function suiteWarnings(apiSpec, positiveGenerator, dataFormat) {
  const warnings = [];
  if (!apiSpec.baseUrl) warnings.push('The spec has no server URL: set baseUrl in the environment file.');
  const { plan, auth } = positiveGenerator;
  for (const endpoint of apiSpec.endpoints) {
    if (auth.isAuthEndpoint(endpoint)) continue;
    const guard = positiveGenerator.mutationGuard(endpoint);
    if (guard.needsOptIn) {
      warnings.push(`${endpoint.key}: skipped unless allowMutationOfExistingData=true (${guard.reason}); it would modify data the run did not create.`);
    }
    if (isOpaqueBody(endpoint)) {
      warnings.push(`${endpoint.key}: ${endpoint.requestBody.contentType} body is sent as example text; no field-level negative tests.`);
    }
  }
  for (const binding of plan.bindings.values()) {
    if (!binding.runtime) {
      warnings.push(`Path variable ${binding.varName} (${binding.prefix}/{...}) has no create or list endpoint; set its value in the environment.`);
    }
    if (binding.createOp && !binding.deleteOp) {
      warnings.push(`Resources created via ${binding.createOp.key} are not cleaned up: the spec has no DELETE for ${binding.prefix}/{...}.`);
    }
  }
  if (apiSpec.authSchemes.length > 0 && !auth.authEndpoint) {
    warnings.push('No token endpoint detected: fill token/apiKey (or username/password) in the environment before running.');
  }
  if (dataFormat && positiveGenerator.dataFields.size === 0) {
    warnings.push('Data-driven mode requested, but no JSON request bodies were found to drive.');
  }
  return warnings;
}

/**
 * Generate the full suite.
 * @param {object} options
 * @param {string} options.specPath
 * @param {string} options.outputDir absolute or relative to cwd
 * @param {'csv'|'json'|null} [options.dataFormat]
 * @param {number} [options.rowCount=3]
 * @param {object} [options.variables] values that override everything in the environment
 * @param {string} [options.envFile] existing environment to reuse values from (default: the previous output)
 * @param {boolean} [options.overwrite=true]
 * @param {boolean} [options.bdd=false] also write a single BDD feature file
 * @param {number} [options.responseTimeMs=5000]
 */
export async function generateSuite(options) {
  const {
    specPath, dataFormat = null, rowCount = 3, variables = {}, envFile = null,
    overwrite = true, bdd = false, responseTimeMs = 5000,
  } = options;
  const outputDir = path.resolve(options.outputDir || './generated');
  const apiSpec = await new OpenAPIParser().parse(specPath);
  const baseName = sanitizeFilename(apiSpec.info.title);
  const names = {
    positive: `${baseName}_Positive.postman_collection.json`,
    negative: `${baseName}_Negative.postman_collection.json`,
    environment: `${baseName}_environment.json`,
    techSpec: `${baseName}_TechSpec.md`,
    report: `${baseName}_Report.html`,
    readme: `${baseName}_README.md`,
  };

  const positiveGenerator = new PositiveTestGenerator(apiSpec, { dataDriven: !!dataFormat, responseTimeMs });
  const positive = positiveGenerator.generate();
  const negativeGenerator = new NegativeTestGenerator(apiSpec, { responseTimeMs });
  const negative = negativeGenerator.generate();

  const existing = await readEnvironmentValues(envFile ? path.resolve(envFile) : path.join(outputDir, names.environment));
  const environment = buildEnvironment({
    apiSpec,
    collections: [positive, negative],
    defaults: new Map([...negativeGenerator.envDefaults, ...positiveGenerator.envDefaults]),
    existing,
    custom: variables || {},
  });

  const verification = {
    variables: new VariableChecker().check(positive, negative, environment),
    coverage: new CoverageChecker().check(apiSpec, positive, negative),
    scripts: new ScriptChecker().check(positive, negative),
  };
  const specGaps = negativeGenerator.specGaps;

  const contents = new Map([
    [names.positive, JSON.stringify(positive, null, 2)],
    [names.negative, JSON.stringify(negative, null, 2)],
    [names.environment, JSON.stringify(environment, null, 2)],
    [names.techSpec, new TechSpecGenerator(apiSpec).generate()],
    [names.report, HTMLReportGenerator.generate(apiSpec, positive, negative, { coverage: verification.coverage, specGaps })],
  ]);

  let dataFile = null;
  let dataRows = 0;
  if (dataFormat) {
    const generator = new DataFileGenerator(apiSpec, {
      rowCount,
      fields: positiveGenerator.dataFields.size > 0 ? positiveGenerator.dataFields : undefined,
    });
    const rows = generator.generate();
    dataRows = rows.length;
    dataFile = `${baseName}_iteration_data.${dataFormat === 'csv' ? 'csv' : 'json'}`;
    contents.set(dataFile, dataFormat === 'csv' ? generator.toCSV(rows) : generator.toJSON(rows));
  }
  if (bdd) contents.set(`${baseName}_BDD.feature`, new BDDGenerator(apiSpec).generateSingleFile());
  contents.set(names.readme, generateSuiteReadme({ apiSpec, files: names, dataFile, specGaps }));

  const files = await writeAll(outputDir, contents, overwrite);
  const countRequests = collection => {
    let n = 0;
    const walk = items => items.forEach(item => (item.item ? walk(item.item) : n++));
    walk(collection.item);
    return n;
  };

  return {
    api: apiSpec.info.title,
    specVersion: apiSpec.specVersion,
    outputDir,
    files,
    stats: {
      endpoints: apiSpec.endpoints.length,
      positiveRequests: countRequests(positive),
      negativeRequests: countRequests(negative),
      environmentVariables: environment.values.length,
      dataRows,
    },
    verification,
    specGaps,
    warnings: suiteWarnings(apiSpec, positiveGenerator, dataFormat),
  };
}

/** Generate BDD feature file(s). */
export async function generateBdd({ specPath, outputDir, singleFile = true, overwrite = true }) {
  const apiSpec = await new OpenAPIParser().parse(specPath);
  const generator = new BDDGenerator(apiSpec);
  const contents = singleFile
    ? new Map([[`${sanitizeFilename(apiSpec.info.title)}_BDD.feature`, generator.generateSingleFile()]])
    : generator.generate();
  const resolved = path.resolve(outputDir || './generated');
  const files = await writeAll(resolved, contents, overwrite);
  return { api: apiSpec.info.title, outputDir: resolved, files, endpoints: apiSpec.endpoints.length };
}
