/**
 * File-system access policy for the MCP server.
 *
 * Tool arguments are chosen by a language model that may be steered by text in
 * the documents it reads, so every path is resolved and checked against a set of
 * allowed root directories before anything is read or written.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export class PathPolicyError extends Error {}

export function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function realpathOrSelf(p) {
  try { return await fs.realpath(p); } catch { return p; }
}

export class PathPolicy {
  /**
   * @param {string[]} roots allowed directories; relative paths resolve against the first
   */
  constructor(roots) {
    const unique = [...new Set(roots.filter(Boolean).map(r => path.resolve(r)))];
    if (unique.length === 0) throw new Error('PathPolicy needs at least one root directory');
    this.roots = unique;
  }

  static async create(roots) {
    const policy = new PathPolicy(roots);
    policy.realRoots = await Promise.all(policy.roots.map(realpathOrSelf));
    return policy;
  }

  resolve(p) {
    return path.isAbsolute(p) ? path.resolve(p) : path.resolve(this.roots[0], p);
  }

  async assertAllowed(absolute) {
    // Resolve symlinks on the deepest existing ancestor so links cannot escape a root.
    let existing = absolute;
    const rest = [];
    for (;;) {
      try {
        existing = await fs.realpath(existing);
        break;
      } catch {
        const parent = path.dirname(existing);
        if (parent === existing) break;
        rest.unshift(path.basename(existing));
        existing = parent;
      }
    }
    const real = path.join(existing, ...rest);
    const roots = this.realRoots || this.roots;
    if (!roots.some(root => isInside(root, real))) {
      throw new PathPolicyError(`Access denied: ${absolute} is outside the allowed directories (${this.roots.join(', ')}). ` +
        'Add the directory to SWAGGER_MCP_ALLOWED_DIRS or expose it as an MCP root.');
    }
    return real;
  }

  /** An existing file inside the roots, optionally restricted to extensions. */
  async file(p, { extensions } = {}) {
    if (typeof p !== 'string' || p.trim() === '') throw new PathPolicyError('A file path is required');
    const absolute = this.resolve(p);
    if (extensions && !extensions.includes(path.extname(absolute).toLowerCase())) {
      throw new PathPolicyError(`Unsupported file type "${path.extname(absolute)}" (expected ${extensions.join(', ')})`);
    }
    const real = await this.assertAllowed(absolute);
    const stat = await fs.stat(real).catch(() => null);
    if (!stat?.isFile()) throw new PathPolicyError(`File not found: ${absolute}`);
    return real;
  }

  /** A directory inside the roots (created later by the caller if missing). */
  async directory(p) {
    if (typeof p !== 'string' || p.trim() === '') throw new PathPolicyError('A directory path is required');
    return this.assertAllowed(this.resolve(p));
  }
}
