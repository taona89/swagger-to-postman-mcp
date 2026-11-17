import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { OpenAPIParser } from '../src/parsers/openapi-parser.js';
import { BOOKER_SPEC, tempDir, writeJson } from './helpers.js';

const parser = new OpenAPIParser();

test('dereferences $ref request and response schemas', async () => {
  const spec = await parser.parse(BOOKER_SPEC);
  const create = spec.endpoints.find(e => e.key === 'POST /booking');
  assert.deepEqual(Object.keys(create.requestBody.schema.properties),
    ['firstname', 'lastname', 'totalprice', 'depositpaid', 'bookingdates', 'additionalneeds']);
  assert.equal(create.requestBody.schema.properties.bookingdates.properties.checkin.format, 'date');
  const read = spec.endpoints.find(e => e.key === 'GET /booking/{id}');
  assert.ok(read.responses['200'].schema.properties.totalprice);
  assert.equal(spec.specVersion, 'openapi-3.0.0');
});

test('normalizes Swagger 2.0 body parameters, responses and security definitions', async () => {
  const dir = await tempDir();
  const file = await writeJson(path.join(dir, 'pets.json'), {
    swagger: '2.0',
    info: { title: 'Pets', version: '1' },
    host: 'api.example.com',
    basePath: '/v1',
    securityDefinitions: { key: { type: 'apiKey', in: 'header', name: 'X-Pet-Key' }, basicAuth: { type: 'basic' } },
    security: [{ key: [] }],
    paths: {
      '/pets': {
        post: {
          parameters: [{ in: 'body', name: 'body', required: true, schema: { $ref: '#/definitions/Pet' } }],
          responses: { 201: { description: 'ok', schema: { $ref: '#/definitions/Pet' } }, 400: { description: 'bad' } },
        },
      },
      '/pets/{petId}': {
        get: { parameters: [{ in: 'path', name: 'petId', required: true, type: 'integer', minimum: 1 }], responses: { 200: { description: 'ok' } } },
      },
    },
    definitions: { Pet: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, age: { type: 'integer' } } } },
  });
  const spec = await parser.parse(file);
  const create = spec.endpoints.find(e => e.key === 'POST /pets');
  assert.equal(spec.baseUrl, 'https://api.example.com/v1');
  assert.equal(create.requestBody.contentType, 'application/json');
  assert.deepEqual(create.requestBody.schema.required, ['name']);
  assert.ok(create.responses['201'].schema.properties.age);
  assert.equal(create.requiresAuth, true);
  const get = spec.endpoints.find(e => e.key === 'GET /pets/{petId}');
  assert.deepEqual(get.parameters[0].schema, { type: 'integer', minimum: 1 });
  assert.deepEqual(spec.authSchemes.find(s => s.key === 'key'), {
    key: 'key', type: 'apiKey', scheme: undefined, bearerFormat: undefined, in: 'header', paramName: 'X-Pet-Key', description: '',
  });
  assert.equal(spec.authSchemes.find(s => s.key === 'basicAuth').scheme, 'basic');
});

test('keeps the apiKey parameter name separate from the scheme key and honours security: []', async () => {
  const dir = await tempDir();
  const file = await writeJson(path.join(dir, 'api.json'), {
    openapi: '3.0.3',
    info: { title: 'Keys', version: '1' },
    components: { securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } },
    security: [{ ApiKeyAuth: [] }],
    paths: {
      '/private': { get: { responses: { 200: { description: 'ok' } } } },
      '/public': { get: { security: [], responses: { 200: { description: 'ok' } } } },
      '/optional': { get: { security: [{}, { ApiKeyAuth: [] }], responses: { 200: { description: 'ok' } } } },
    },
  });
  const spec = await parser.parse(file);
  assert.equal(spec.authSchemes[0].key, 'ApiKeyAuth');
  assert.equal(spec.authSchemes[0].paramName, 'X-API-Key');
  assert.equal(spec.endpoints.find(e => e.path === '/private').requiresAuth, true);
  assert.equal(spec.endpoints.find(e => e.path === '/public').requiresAuth, false);
  assert.equal(spec.endpoints.find(e => e.path === '/optional').requiresAuth, false);
});

test('rejects documents that are not OpenAPI/Swagger', async () => {
  const dir = await tempDir();
  const file = await writeJson(path.join(dir, 'empty.json'), {});
  await assert.rejects(parser.parse(file), /Failed to parse OpenAPI spec/);
  const result = await parser.validate(file);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test('validate() reports schema errors for an invalid spec', async () => {
  const dir = await tempDir();
  const file = await writeJson(path.join(dir, 'bad.json'), { openapi: '3.0.0', info: { title: 'x' }, paths: {} });
  const result = await parser.validate(file);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /version/);
  assert.equal((await parser.validate(BOOKER_SPEC)).valid, true);
});

test('follows file $refs inside the spec folder only, and never fetches http $refs', async () => {
  const dir = await tempDir();
  await writeJson(path.join(dir, 'outside.json'), { type: 'object', properties: { secret: { type: 'string', example: 'TOPSECRET' } } });
  await writeJson(path.join(dir, 'spec', 'local.json'), { type: 'object', properties: { inner: { type: 'string' } } });
  const response = schema => ({ 200: { description: 'ok', content: { 'application/json': { schema } } } });
  const make = (name, schema) => writeJson(path.join(dir, 'spec', name), {
    openapi: '3.0.0', info: { title: 'R', version: '1' }, paths: { '/a': { get: { responses: response(schema) } } },
  });

  const local = await parser.parse(await make('local-ref.json', { $ref: './local.json' }));
  assert.ok(local.endpoints[0].responses['200'].schema.properties.inner);

  await assert.rejects(parser.parse(await make('escape-ref.json', { $ref: '../outside.json' })));

  let hits = 0;
  const server = http.createServer((req, res) => { hits++; res.end('{"type":"string"}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/schema.json`;
    await assert.rejects(parser.parse(await make('http-ref.json', { $ref: url })));
    assert.equal(hits, 0, 'http $ref must not be fetched');
  } finally {
    server.close();
  }
});

test('file $refs through a junction/symlink to outside the spec folder are refused', async t => {
  const dir = await tempDir();
  const secretDir = await tempDir('stp-secret-');
  await writeJson(path.join(secretDir, 'secret.json'), { type: 'string', example: 'TOPSECRET' });
  await fs.mkdir(path.join(dir, 'spec'));
  try {
    await fs.symlink(secretDir, path.join(dir, 'spec', 'lib'), 'junction');
  } catch {
    t.skip('symlinks not permitted on this machine');
    return;
  }
  const file = await writeJson(path.join(dir, 'spec', 'api.json'), {
    openapi: '3.0.0', info: { title: 'J', version: '1' },
    paths: { '/a': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: './lib/secret.json' } } } } } } } },
  });
  await assert.rejects(parser.parse(file), /Unable to resolve \$ref/);
});

test('combined security requirements send every scheme', async () => {
  const dir = await tempDir();
  const file = await writeJson(path.join(dir, 'multi.json'), {
    openapi: '3.0.3', info: { title: 'M', version: '1' },
    components: { securitySchemes: {
      a: { type: 'apiKey', in: 'header', name: 'X-A' },
      b: { type: 'apiKey', in: 'header', name: 'X-B' },
      c: { type: 'apiKey', in: 'cookie', name: 'sid' },
    } },
    security: [{ a: [], b: [], c: [] }],
    paths: { '/x': { get: { responses: { 200: { description: 'ok' } } } } },
  });
  const spec = await parser.parse(file);
  const { AuthContext } = await import('../src/core/auth.js');
  const request = { header: [], url: { raw: '{{baseUrl}}/x' } };
  new AuthContext(spec).apply(request, spec.endpoints[0]);
  assert.deepEqual(request.header.map(h => `${h.key}: ${h.value}`), ['X-A: {{apiKey}}', 'X-B: {{apiKey_b}}', 'Cookie: sid={{apiKey_c}}']);
});

test('wraps partial .txt specs in memory without writing files', async () => {
  const dir = await tempDir();
  const txt = path.join(dir, 'orders_spec.txt');
  const sibling = path.join(dir, 'orders_spec.yaml');
  await fs.writeFile(sibling, '# user file\n');
  await fs.writeFile(txt, '"/orders": {"get": {"responses": {"200": {"description": "ok"}}}},');
  const spec = await parser.parse(txt);
  assert.equal(spec.info.title, 'Orders API');
  assert.equal(spec.endpoints[0].key, 'GET /orders');
  assert.equal(await fs.readFile(sibling, 'utf8'), '# user file\n');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['orders_spec.txt', 'orders_spec.yaml']);
});

test('handles circular schemas', async () => {
  const dir = await tempDir();
  const file = await writeJson(path.join(dir, 'tree.json'), {
    openapi: '3.0.0',
    info: { title: 'Tree', version: '1' },
    paths: { '/nodes': { post: {
      requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } },
      responses: { 201: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } } },
    } } },
    components: { schemas: { Node: { type: 'object', properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } } } } } },
  });
  const spec = await parser.parse(file);
  const body = spec.endpoints[0].requestBody.example;
  assert.equal(typeof body.name, 'string');
  assert.ok(Array.isArray(body.children));
});
