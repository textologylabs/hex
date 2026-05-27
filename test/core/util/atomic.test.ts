import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LockTimeoutError, withFileLock, writeFileAtomic } from '../../../src/core/util/atomic.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-atomic-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('writes content via a temp + rename', async () => {
    const target = join(work, 'state.json');
    await writeFileAtomic(target, '{"a":1}');
    expect(await readFile(target, 'utf8')).toBe('{"a":1}');
  });

  it('overwrites an existing file in place', async () => {
    const target = join(work, 'state.json');
    await writeFile(target, 'old');
    await writeFileAtomic(target, 'new');
    expect(await readFile(target, 'utf8')).toBe('new');
  });

  it('leaves no stray temp siblings on success', async () => {
    const target = join(work, 'state.json');
    await writeFileAtomic(target, 'x');
    const entries = await import('node:fs/promises').then((m) => m.readdir(work));
    expect(entries.filter((n) => n !== 'state.json')).toEqual([]);
  });
});

describe('withFileLock', () => {
  it('serialises concurrent callers — no two execute the critical section at once', async () => {
    const lockPath = join(work, '.lock');
    let inside = 0;
    let maxInside = 0;
    const runOnce = async (): Promise<void> => {
      await withFileLock(lockPath, async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await new Promise((r) => setTimeout(r, 20));
        inside--;
      });
    };
    await Promise.all([runOnce(), runOnce(), runOnce(), runOnce(), runOnce()]);
    expect(maxInside).toBe(1);
  });

  it('releases the lock when the body resolves', async () => {
    const lockPath = join(work, '.lock');
    await withFileLock(lockPath, async () => {});
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lock when the body throws', async () => {
    const lockPath = join(work, '.lock');
    await expect(
      withFileLock(lockPath, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('reclaims a stale lock past `staleMs`', async () => {
    const lockPath = join(work, '.lock');
    // Plant a "lock" that looks like a crashed holder.
    await writeFile(lockPath, '12345\n');
    // Backdate its mtime well past the stale threshold.
    const past = new Date(Date.now() - 60_000);
    await import('node:fs/promises').then((m) => m.utimes(lockPath, past, past));

    let ran = false;
    await withFileLock(
      lockPath,
      async () => {
        ran = true;
      },
      { staleMs: 1_000 },
    );
    expect(ran).toBe(true);
  });

  it('times out when a fresh lock is held longer than `timeoutMs`', async () => {
    const lockPath = join(work, '.lock');
    // Hold the lock for longer than the timeout in a separate promise.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withFileLock(lockPath, () => held);

    await new Promise((r) => setTimeout(r, 50)); // let the holder acquire
    await expect(
      withFileLock(lockPath, async () => {}, {
        timeoutMs: 100,
        pollMs: 20,
        staleMs: 60_000,
      }),
    ).rejects.toBeInstanceOf(LockTimeoutError);

    release();
    await holder;
  });

  it('parent directory of the lockfile must exist', async () => {
    // Sanity: caller is expected to mkdir(recursive:true) the cache root first.
    const lockPath = join(work, 'present', '.lock');
    await mkdir(join(work, 'present'), { recursive: true });
    await stat(join(work, 'present')); // exists → acquire succeeds.
    await withFileLock(lockPath, async () => {});
    expect(existsSync(lockPath)).toBe(false);
  });
});
