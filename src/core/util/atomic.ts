import { open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Small, dependency-free concurrency primitives for state files Hex
 * persists outside the project tree (the git-source cache; the
 * generated-app checklist; …). Two surfaces:
 *
 * - `writeFileAtomic` — write to a temp sibling and `rename` over the
 *   target, so a concurrent reader observes either the previous or the
 *   new bytes, never a half-written file.
 * - `withFileLock` — serialise a read-modify-write block via an
 *   exclusive-create lockfile. The lockfile is rm'd in `finally`; a
 *   crashed-process lock is reclaimed after `staleMs` so a dead Hex
 *   does not block live ones forever.
 *
 * Cross-platform: `open(.., 'wx')` is atomic-exclusive on POSIX and
 * Windows; `rename` is atomic on the same filesystem (which every
 * cache directory we write to is).
 */

export class LockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockTimeoutError';
  }
}

/**
 * Atomically replace `targetPath`'s contents with `content`. Writes to
 * a temp sibling first, then `rename`s — never leaves a partial file
 * visible. The parent directory must exist.
 */
export async function writeFileAtomic(targetPath: string, content: string): Promise<void> {
  const tmp = join(
    dirname(targetPath),
    `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, targetPath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export type LockOpts = {
  /** Total wait before giving up. Default 30s. */
  timeoutMs?: number;
  /** A lockfile older than this is considered orphaned and stolen. Default 60s. */
  staleMs?: number;
  /** Poll interval while waiting on a held lock. Default 100ms. */
  pollMs?: number;
};

/**
 * Run `fn` under an exclusive lock at `lockPath`. Serialises concurrent
 * callers across processes via `open(.., 'wx')`; a lock older than
 * `staleMs` is reclaimed so a crash can never wedge things permanently.
 *
 * The parent directory of `lockPath` must exist — typically the caller
 * has already `mkdir(recursive:true)`'d the cache root.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: LockOpts = {},
): Promise<T> {
  await acquireLock(lockPath, opts);
  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}

async function acquireLock(lockPath: string, opts: LockOpts): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const staleMs = opts.staleMs ?? 60_000;
  const pollMs = opts.pollMs ?? 100;
  const start = Date.now();

  while (true) {
    try {
      const fh = await open(lockPath, 'wx');
      await fh.write(`${process.pid}\n`);
      await fh.close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    // Lock held — try to determine whether the holder is alive.
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(lockPath)).mtimeMs;
    } catch {
      // Holder released between our `open` and `stat` — loop immediately.
      continue;
    }
    if (Date.now() - mtimeMs > staleMs) {
      await rm(lockPath, { force: true });
      continue;
    }

    if (Date.now() - start > timeoutMs) {
      throw new LockTimeoutError(
        `could not acquire lock at ${lockPath} after ${timeoutMs}ms (held for >${Math.round(
          (Date.now() - mtimeMs) / 1000,
        )}s)`,
      );
    }
    await sleep(pollMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
