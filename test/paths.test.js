import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PathPolicy, PathPolicyError, isInside } from '../src/core/paths.js';
import { tempDir } from './helpers.js';

test('PathPolicy allows files inside roots and rejects everything else', async () => {
  const root = await tempDir('stp-root-');
  const outside = await tempDir('stp-outside-');
  await fs.writeFile(path.join(root, 'spec.json'), '{}');
  await fs.writeFile(path.join(outside, 'secret.json'), '{}');
  const policy = await PathPolicy.create([root]);

  assert.equal(path.basename(await policy.file('spec.json')), 'spec.json', 'relative paths resolve against the first root');
  await assert.rejects(policy.file(path.join(outside, 'secret.json')), PathPolicyError);
  await assert.rejects(policy.file('../' + path.basename(outside) + '/secret.json'), PathPolicyError);
  await assert.rejects(policy.file(path.join(root, 'spec.json'), { extensions: ['.yaml'] }), /Unsupported file type/);
  await assert.rejects(policy.file('missing.json'), /File not found/);

  assert.equal(await policy.directory('generated'), path.join(await fs.realpath(root), 'generated'));
  await assert.rejects(policy.directory(path.join(outside, 'out')), PathPolicyError);
});

test('paths outside the roots are rejected before touching the filesystem (no UNC/SMB lookups)', async () => {
  const root = await tempDir('stp-root-');
  const calls = [];
  const realpath = async p => { calls.push(p); return fs.realpath(p); };
  const policy = await PathPolicy.create([root], { realpath });
  calls.length = 0;
  const targets = ['//127.0.0.1/share/x.json', path.join(root, '..', 'elsewhere', 'x.json')];
  if (process.platform === 'win32') targets.push('\\\\127.0.0.1\\share\\x.json'); // UNC only exists on Windows
  for (const target of targets) {
    await assert.rejects(policy.file(target), PathPolicyError, target);
  }
  assert.deepEqual(calls, [], 'realpath must not be called for paths outside the roots');
});

test('names that merely start with ".." are inside the root', async () => {
  const root = await tempDir('stp-root-');
  await fs.writeFile(path.join(root, '..spec.json'), '{}');
  const policy = await PathPolicy.create([root]);
  assert.equal(path.basename(await policy.file('..spec.json')), '..spec.json');
  assert.equal(isInside(root, path.join(root, '..spec.json')), true);
  assert.equal(isInside(root, path.join(root, '..', 'x')), false);
});

test('PathPolicy resolves symlinks before checking roots', async t => {
  const root = await tempDir('stp-root-');
  const outside = await tempDir('stp-outside-');
  await fs.writeFile(path.join(outside, 'secret.json'), '{}');
  try {
    await fs.symlink(outside, path.join(root, 'link'), 'junction');
  } catch {
    t.skip('symlinks not permitted on this machine');
    return;
  }
  const policy = await PathPolicy.create([root]);
  await assert.rejects(policy.file(path.join(root, 'link', 'secret.json')), PathPolicyError);
  await assert.rejects(policy.directory(path.join(root, 'link', 'new-dir')), PathPolicyError);
});
