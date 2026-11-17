import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_DIR, BOOKER_SPEC, tempDir } from './helpers.js';

const cli = (args, cwd = PROJECT_DIR) => spawnSync(process.execPath, [path.join(PROJECT_DIR, 'generate.js'), ...args], { cwd, encoding: 'utf8' });

test('CLI generates the suite when invoked by absolute path (any OS)', async () => {
  const out = await tempDir('stp-cli-');
  const run = cli([BOOKER_SPEC, out, '--data-file', 'csv', '--bdd']);
  assert.equal(run.status, 0, run.stderr);
  const files = (await fs.readdir(out)).sort();
  assert.deepEqual(files, [
    'Restful_Booker_BDD.feature',
    'Restful_Booker_Negative.postman_collection.json',
    'Restful_Booker_Positive.postman_collection.json',
    'Restful_Booker_README.md',
    'Restful_Booker_Report.html',
    'Restful_Booker_TechSpec.md',
    'Restful_Booker_environment.json',
    'Restful_Booker_iteration_data.csv',
  ]);
  assert.match(run.stdout, /Coverage: 8\/8 operations/);
});

test('CLI accepts flags before positional arguments and keeps existing environment values', async () => {
  const out = await tempDir('stp-cli-');
  assert.equal(cli(['--variables', '{"baseUrl":"https://staging.example.com"}', BOOKER_SPEC, out]).status, 0);
  // regenerate without --variables: the previous environment value is preserved
  assert.equal(cli([BOOKER_SPEC, out]).status, 0);
  const env = JSON.parse(await fs.readFile(path.join(out, 'Restful_Booker_environment.json'), 'utf8'));
  assert.equal(env.values.find(v => v.key === 'baseUrl').value, 'https://staging.example.com');
  assert.equal(env.values.find(v => v.key === 'password').type, 'secret');
});

test('CLI --no-overwrite refuses to replace files', async () => {
  const out = await tempDir('stp-cli-');
  assert.equal(cli([BOOKER_SPEC, out]).status, 0);
  const second = cli([BOOKER_SPEC, out, '--no-overwrite']);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /Refusing to overwrite/);
});

test('CLI rejects unknown options and bad values', () => {
  assert.equal(cli([BOOKER_SPEC, '--bogus']).status, 1);
  assert.match(cli([BOOKER_SPEC, '--row-count', 'zero']).stderr, /positive integer/);
  assert.match(cli([BOOKER_SPEC, '--data-file', 'xml']).stderr, /Invalid --data-file/);
  assert.equal(cli(['--help']).status, 0);
});
