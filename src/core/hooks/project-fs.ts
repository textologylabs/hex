import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export class ProjectFsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFsError';
  }
}

/**
 * Sandboxed filesystem facade rooted at a project directory.
 *
 * Every path argument is interpreted as a *relative* path under the root.
 * Absolute paths, `..` traversal, and symlinks resolving outside the root
 * are all rejected before any filesystem operation happens, so a hook
 * cannot read or write anywhere except inside its own generated tree.
 *
 * Methods are synchronous because the QuickJS host-function bridge they
 * back is synchronous — the asyncified QuickJS variant would let us go
 * async, but at meaningful binary-size + complexity cost we don't need yet.
 */
export class ProjectFs {
  private readonly rootReal: string;

  constructor(root: string) {
    if (!existsSync(root)) {
      throw new ProjectFsError(`project root does not exist: ${root}`);
    }
    this.rootReal = realpathSync(root);
  }

  read(path: string): string {
    const target = this.resolveSafe(path);
    return readFileSync(target, 'utf8');
  }

  write(path: string, content: string): void {
    if (typeof content !== 'string') {
      throw new ProjectFsError('write() content must be a string');
    }
    const target = this.resolveSafe(path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }

  delete(path: string): void {
    const target = this.resolveSafe(path);
    rmSync(target, { recursive: true, force: true });
  }

  exists(path: string): boolean {
    const target = this.resolveSafe(path);
    return existsSync(target);
  }

  list(path: string): string[] {
    const target = this.resolveSafe(path);
    const st = statSync(target);
    if (!st.isDirectory()) {
      throw new ProjectFsError(`list() target is not a directory: ${path}`);
    }
    return readdirSync(target);
  }

  /**
   * Resolve a hook-supplied relative path to a real absolute path that is
   * guaranteed to be inside the project root.
   *
   * Strategy: walk up the resolved target until we hit an ancestor that
   * actually exists, realpath that ancestor, then verify it is the root
   * or a descendant. This handles non-existent targets (write/exists) and
   * symlink-based escapes uniformly — a symlink that resolves outside the
   * root makes its containing directory's realpath fall outside, which
   * the prefix check rejects.
   */
  private resolveSafe(rel: string): string {
    if (typeof rel !== 'string') {
      throw new ProjectFsError('path must be a string');
    }
    if (rel.length === 0) {
      throw new ProjectFsError('path cannot be empty');
    }
    if (isAbsolute(rel)) {
      throw new ProjectFsError(`absolute paths are not allowed: ${rel}`);
    }

    const joined = resolve(this.rootReal, rel);

    let probe = joined;
    const trailing: string[] = [];
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break;
      trailing.unshift(basename(probe));
      probe = parent;
    }

    const probeReal = realpathSync(probe);
    const r = relative(this.rootReal, probeReal);
    if (r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) {
      throw new ProjectFsError(`path escapes project root: ${rel}`);
    }

    return trailing.length === 0 ? probeReal : join(probeReal, ...trailing);
  }
}
