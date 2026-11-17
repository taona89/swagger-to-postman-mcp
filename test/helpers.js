import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BOOKER_SPEC = path.join(PROJECT_DIR, 'swagger', 'restful_booker.json');

export async function tempDir(prefix = 'stp-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2));
  return file;
}

/** Flatten a collection into its request items. */
export function requestItems(collection) {
  const items = [];
  const walk = list => list.forEach(item => (item.item ? walk(item.item) : items.push(item)));
  walk(collection.item);
  return items;
}

export function scriptOf(item, listen = 'test') {
  return (item.event || []).filter(e => e.listen === listen).flatMap(e => e.script.exec).join('\n');
}

const require = createRequire(import.meta.url);

/**
 * Run a collection with Newman against baseUrl.
 * @returns {Promise<{ failures: Array<{item, test, message}>, stats: object, executions: object[], skipped: string[] }>}
 */
export function runNewman(collection, environment, baseUrl, iterationData) {
  const newman = require('newman');
  const env = structuredClone(environment);
  const entry = env.values.find(v => v.key === 'baseUrl');
  if (entry) entry.value = baseUrl;
  else env.values.push({ key: 'baseUrl', value: baseUrl, enabled: true });

  const skipped = [];
  return new Promise((resolve, reject) => {
    newman.run({ collection, environment: env, iterationData, reporters: [] })
      .on('console', (err, args) => {
        const text = args.messages.join(' ');
        if (text.includes('[SKIPPED]')) skipped.push(text);
      })
      .on('done', (err, summary) => {
        if (err) { reject(err); return; }
        resolve({
          stats: summary.run.stats,
          executions: summary.run.executions,
          skipped,
          failures: summary.run.failures.map(f => ({
            item: f.source?.name,
            test: f.error?.test || f.error?.name,
            message: f.error?.message,
          })),
        });
      });
  });
}
