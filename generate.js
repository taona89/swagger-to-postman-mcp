#!/usr/bin/env node

/**
 * CLI: generate Postman suites from an OpenAPI / Swagger spec.
 * Usage: node generate.js <spec-path> [output-dir] [options]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateSuite } from './src/core/suite.js';

const HELP = `
Swagger to Postman Collection Generator

Usage:
  node generate.js <spec-path> [output-dir] [options]

Arguments:
  spec-path               OpenAPI 3.x / Swagger 2.0 spec (.json, .yaml, .yml, or partial .txt)
  output-dir              Output directory (default: ./generated)

Options:
  --env-file <path>       Reuse values from an existing Postman environment file
  --data-file <csv|json>  Also generate an iteration data file (positive suite becomes data-driven)
  --row-count <n>         Number of data rows (default: 3)
  --variables <json|path> Values that override the environment (inline JSON or a .json file)
  --response-time <ms>    Response time threshold for performance assertions (default: 5000)
  --bdd                   Also generate a Gherkin .feature file
  --no-overwrite          Fail instead of overwriting existing output files
  -h, --help              Show this help

Examples:
  node generate.js swagger/restful_booker.json
  node generate.js ./specs/api.yaml ./out --data-file csv --row-count 5
  node generate.js ./specs/api.yaml ./out --variables '{"baseUrl":"https://staging.example.com"}'
`;

const VALUE_FLAGS = new Set(['--env-file', '--data-file', '--row-count', '--variables', '--response-time']);
const BOOLEAN_FLAGS = new Set(['--bdd', '--no-overwrite', '--help', '-h']);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        if (arg === '--data-file') { flags[arg] = 'json'; continue; }
        throw new Error(`${arg} requires a value`);
      }
      flags[arg] = value;
      i++;
    } else if (BOOLEAN_FLAGS.has(arg)) {
      flags[arg] = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

async function parseVariables(value) {
  if (!value) return {};
  const text = value.trim().startsWith('{') ? value : await fs.readFile(value, 'utf8');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--variables must be a JSON object');
  return parsed;
}

function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  if (flags['--help'] || flags['-h'] || positional.length === 0) {
    console.log(HELP);
    return positional.length === 0 && !flags['--help'] && !flags['-h'] ? 1 : 0;
  }

  const dataFormat = flags['--data-file'] || null;
  if (dataFormat && !['csv', 'json'].includes(dataFormat)) throw new Error(`Invalid --data-file format: ${dataFormat} (use csv or json)`);

  const result = await generateSuite({
    specPath: positional[0],
    outputDir: positional[1] || './generated',
    dataFormat,
    rowCount: flags['--row-count'] ? positiveInt(flags['--row-count'], '--row-count') : 3,
    variables: await parseVariables(flags['--variables']),
    envFile: flags['--env-file'] || null,
    overwrite: !flags['--no-overwrite'],
    bdd: !!flags['--bdd'],
    responseTimeMs: flags['--response-time'] ? positiveInt(flags['--response-time'], '--response-time') : 5000,
  });

  const { verification: v } = result;
  console.log(`\n${result.api} (${result.specVersion}) - ${result.stats.endpoints} operations`);
  console.log(`Output: ${result.outputDir}`);
  for (const file of result.files) console.log(`  ${file}`);
  console.log(`\nPositive requests: ${result.stats.positiveRequests}   Negative requests: ${result.stats.negativeRequests}`);
  console.log(`Coverage: ${v.coverage.positiveCovered}/${v.coverage.total} operations (positive), ` +
    `${v.coverage.negativeCovered}/${v.coverage.writableTotal} writable operations (negative)`);
  for (const op of [...v.coverage.uncoveredPositive, ...v.coverage.uncoveredNegative]) console.log(`  not covered: ${op}`);
  console.log(`Variables: ${v.variables.resolved}/${v.variables.total} resolved` +
    (v.variables.empty.length ? `; fill in: ${v.variables.empty.join(', ')}` : '') +
    (v.variables.missing.length ? `; missing: ${v.variables.missing.join(', ')}` : ''));
  console.log(`Scripts: ${v.scripts.valid}/${v.scripts.total} compile` + (v.scripts.errors.length ? ` (${v.scripts.errors.length} errors)` : ''));
  for (const e of v.scripts.errors) console.log(`  script error: ${e.folder} > ${e.request}: ${e.error}`);
  for (const w of v.scripts.warnings) console.log(`  SCRIPT WARNING: ${w.folder} > ${w.request}: ${w.warning}`);
  for (const gap of result.specGaps) console.log(`Spec gap: ${gap.operation} - ${gap.scenario} (asserting ${gap.assertedCodes.join('/')})`);
  for (const warning of result.warnings) console.log(`Warning: ${warning}`);

  const env = path.join(result.outputDir, result.files.find(f => f.endsWith('_environment.json')));
  const pos = path.join(result.outputDir, result.files.find(f => f.includes('_Positive.')));
  const neg = path.join(result.outputDir, result.files.find(f => f.includes('_Negative.')));
  const data = result.files.find(f => f.includes('_iteration_data.'));
  console.log('\nRun:');
  console.log(`  npx newman run "${pos}" -e "${env}"${data ? ` --iteration-data "${path.join(result.outputDir, data)}"` : ''}`);
  console.log(`  npx newman run "${neg}" -e "${env}"`);
  // Non-zero when a generated script fails to compile or uses risky APIs: never run such a suite unreviewed.
  if (v.scripts.errors.length > 0 || v.scripts.warnings.length > 0) {
    console.error('Generated scripts need review (see script errors/warnings above).');
    return 2;
  }
  return 0;
}

main(process.argv.slice(2))
  .then(code => { process.exitCode = code; })
  .catch(error => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
