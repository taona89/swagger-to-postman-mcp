/**
 * End-to-end: generate suites from swagger/restful_booker.json and run them
 * with Newman against a spec-compliant mock. Then switch on deliberate defects
 * in the mock and check that the suites catch each one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateSuite } from '../src/core/suite.js';
import { startMock } from './fixtures/restful-booker-mock.js';
import { BOOKER_SPEC, tempDir, runNewman } from './helpers.js';

async function suite(options = {}) {
  const outputDir = await tempDir('stp-int-');
  const result = await generateSuite({ specPath: BOOKER_SPEC, outputDir, ...options });
  const read = async marker => JSON.parse(await fs.readFile(path.join(outputDir, result.files.find(f => f.includes(marker))), 'utf8'));
  return {
    result,
    positive: await read('_Positive.'),
    negative: await read('_Negative.'),
    environment: await read('_environment.'),
    dataFile: result.files.find(f => f.includes('_iteration_data.')) ? path.join(outputDir, result.files.find(f => f.includes('_iteration_data.'))) : undefined,
  };
}

async function run(collection, environment, { faults = [], data } = {}) {
  const mock = await startMock({ faults });
  try {
    const outcome = await runNewman(collection, environment, mock.url, data);
    return { ...outcome, mock };
  } finally {
    await mock.close();
  }
}

const describeFailures = failures => failures.map(f => `${f.item} :: ${f.test} :: ${f.message}`).join('\n');

test('generated suites pass against a spec-compliant API and leave its data untouched', async () => {
  const { positive, negative, environment, result } = await suite();
  assert.deepEqual(result.verification.scripts.errors, []);
  assert.equal(result.verification.coverage.negativePercent, 100);

  for (const [name, collection] of [['positive', positive], ['negative', negative]]) {
    const outcome = await run(collection, environment);
    assert.deepEqual(outcome.failures, [], `${name}:\n${describeFailures(outcome.failures)}`);
    assert.deepEqual(outcome.skipped, [], `${name} skipped requests`);
    assert.ok(outcome.stats.assertions.total > 20);
    assert.ok(outcome.mock.bookings.has(1) && outcome.mock.bookings.has(2), `${name}: seed bookings must survive`);
    assert.deepEqual([...outcome.mock.bookings.keys()].sort(), [1, 2], `${name}: created bookings are cleaned up`);
    const mutations = outcome.mock.requests.filter(r => ['PUT', 'PATCH', 'DELETE'].includes(r.method) && /\/booking\/[12]$/.test(r.path));
    assert.deepEqual(mutations, [], `${name}: never mutates seed data`);
  }
});

for (const format of ['csv', 'json']) {
  test(`data-driven positive suite passes with a ${format} iteration file`, async () => {
    const { positive, environment, dataFile } = await suite({ dataFormat: format, rowCount: 3 });
    const outcome = await run(positive, environment, { data: dataFile });
    assert.equal(outcome.stats.iterations.total, 3);
    assert.deepEqual(outcome.failures, [], describeFailures(outcome.failures));
    assert.deepEqual([...outcome.mock.bookings.keys()].sort(), [1, 2]);
  });
}

const FAULTS = {
  acceptWrongTypes: { suite: 'negative', expect: /has the wrong type/ },
  wrongContract: { suite: 'positive', expect: /\[CONTRACT\] Response body matches the documented schema/ },
  noAuthCheck: { suite: 'negative', expect: /no credentials/ },
  missingReturns200: { suite: 'negative', expect: /GET \/booking\/\{id\} - non-existent/ },
  noIdOnCreate: { suite: 'positive', expect: /\[CHAIN\] Created resource id is returned/ },
};

for (const [fault, { suite: which, expect }] of Object.entries(FAULTS)) {
  test(`detects API defect: ${fault}`, async () => {
    const generated = await suite();
    const outcome = await run(generated[which], generated.environment, { faults: [fault] });
    assert.ok(outcome.failures.length > 0, `${fault} went undetected`);
    assert.ok(outcome.failures.some(f => expect.test(`${f.item} ${f.test}`)), `${fault}: unexpected failures\n${describeFailures(outcome.failures)}`);
  });
}
