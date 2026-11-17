/**
 * File-system access policy for the MCP server.
 *
 * Tool arguments are chosen by a language model that may be steered by text in
 * the documents it reads, so every path is resolved and checked against a set of
 * allowed root directories before anything is read or written.
 *
 * The check is lexical first: a path outside the roots (including UNC paths such
 * as \\host\share, which would open an SMB connection) is rejected without
 * touching the filesystem. Paths that pass are then re-checked after resolving
 * symlinks and junctions.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export class PathPolicyError extends Error {}

/** True when `target` is `root` or inside it (names like "..spec.json" are fine). */
export function isInside(root, target) {
  const relative = path.relative(root, target);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !relative.startsWith('../');
}

export class PathPolicy {
  /**
   * @param {string[]} roots allowed directories; relative paths resolve against the first
   * @param {object} [deps] injectable filesystem functions (tests)
   */
  constructor(roots, deps = {}) {
    const unique = [...new Set(roots.filter(Boolean).map(r => path.resolve(r)))];
    if (unique.length === 0) throw new Error('PathPolicy needs at least one root directory');
    this.roots = unique;
    this.realpath = deps.realpath || fs.realpath;
    this.stat = deps.stat || fs.stat;
  }

  static async create(roots, deps = {}) {
    const policy = new PathPolicy(roots, deps);
    policy.realRoots = await Promise.all(policy.roots.map(r => policy.realpath(r).catch(() => r)));
    return policy;
  }

  resolve(p) {
    return path.isAbsolute(p) ? path.resolve(p) : path.resolve(this.roots[0], p);
  }

  denied(absolute) {
    return new PathPolicyError(`Access denied: ${absolute} is outside the allowed directories (${this.roots.join(', ')}). ` +
      'Add the directory to SWAGGER_MCP_ALLOWED_DIRS or expose it as an MCP root.');
  }

  async assertAllowed(absolute) {
    const realRoots = this.realRoots || this.roots;
    // 1. Lexical check: nothing outside the roots ever reaches the filesystem.
    if (![...this.roots, ...realRoots].some(root => isInside(root, absolute))) throw this.denied(absolute);

    // 2. Resolve symlinks on the deepest existing ancestor so links cannot escape a root.
    let existing = absolute;
    const rest = [];
    for (;;) {
      try {
        existing = await this.realpath(existing);
        break;
      } catch {
        const parent = path.dirname(existing);
        if (parent === existing) break;
        rest.unshift(path.basename(existing));
        existing = parent;
      }
    }
    const real = path.join(existing, ...rest);
    if (!realRoots.some(root => isInside(root, real))) throw this.denied(absolute);
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
    const stat = await this.stat(real).catch(() => null);
    if (!stat?.isFile()) throw new PathPolicyError(`File not found: ${absolute}`);
    return real;
  }

  /** A directory inside the roots (created later by the caller if missing). */
  async directory(p) {
    if (typeof p !== 'string' || p.trim() === '') throw new PathPolicyError('A directory path is required');
    return this.assertAllowed(this.resolve(p));
  }
}
