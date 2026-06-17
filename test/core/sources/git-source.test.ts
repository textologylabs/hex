import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type GitResolveResult,
  GitSourceError,
  cacheDirFor,
  checkUpstreamDrift,
  resolveGitSource,
} from '../../../src/core/sources/git-source.js';

const execFileAsync = promisify(execFile);

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-git-source-'));
  // Pin core.autocrlf=false for EVERY git invocation in this process —
  // including the clone/checkout `resolveGitSource` runs internally — via
  // git's env-config protocol. Without this, a runner with the Windows
  // default (autocrlf=true) rewrites fixture `\n` to `\r\n` on checkout and
  // the byte-exact content assertions fail. Tests git mechanics, not the
  // host's line-ending policy.
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'core.autocrlf');
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'false');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(work, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  return stdout.trim();
}

async function makeUpstreamRepo(): Promise<string> {
  const upstream = join(work, 'upstream');
  await mkdir(upstream, { recursive: true });
  await git(upstream, 'init', '-q', '-b', 'main');
  await writeFile(join(upstream, 'README.md'), 'hello\n', 'utf8');
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-q', '-m', 'initial');
  // Local URL form acceptable to `git fetch origin`.
  return upstream;
}

function fileUrl(path: string): string {
  return `file://${path}`;
}

describe('resolveGitSource', () => {
  it('clones into the cache and returns the working-tree path on cold start', async () => {
    const upstream = await makeUpstreamRepo();
    const cacheDir = join(work, 'cache');

    const result = await resolveGitSource({ url: fileUrl(upstream) }, { cacheDir });

    expect(result.localPath).toContain('cache');
    expect(result.url).toBe(fileUrl(upstream));
    expect(result.ref).toBe('HEAD');
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);

    const readme = await readFile(join(result.localPath, 'README.md'), 'utf8');
    expect(readme).toBe('hello\n');
  });

  it('reuses the cache on subsequent calls without refetching', async () => {
    const upstream = await makeUpstreamRepo();
    const cacheDir = join(work, 'cache');

    const first = await resolveGitSource({ url: fileUrl(upstream) }, { cacheDir });

    // Delete the upstream — a real fetch would now fail. The cache hit must
    // not reach for the network/disk, so this call still has to succeed.
    await rm(upstream, { recursive: true, force: true });

    const second = await resolveGitSource({ url: fileUrl(upstream) }, { cacheDir });

    expect(second.localPath).toBe(first.localPath);
    expect(second.sha).toBe(first.sha);
    expect(second.fetchedAt).toBe(first.fetchedAt);
  });

  it('refresh: true picks up a new upstream commit', async () => {
    const upstream = await makeUpstreamRepo();
    const cacheDir = join(work, 'cache');

    const first = await resolveGitSource({ url: fileUrl(upstream) }, { cacheDir });

    // Add a second commit upstream.
    await writeFile(join(upstream, 'NEWFILE'), 'second\n', 'utf8');
    await git(upstream, 'add', '.');
    await git(upstream, 'commit', '-q', '-m', 'second');

    const second = await resolveGitSource({ url: fileUrl(upstream) }, { cacheDir, refresh: true });

    expect(second.sha).not.toBe(first.sha);
    expect(second.fetchedAt).not.toBe(first.fetchedAt);
    const newFile = await readFile(join(second.localPath, 'NEWFILE'), 'utf8');
    expect(newFile).toBe('second\n');
  });

  it('caches different refs in different directories', async () => {
    const upstream = await makeUpstreamRepo();
    await git(upstream, 'tag', 'v1');

    // Add a second commit so HEAD diverges from v1.
    await writeFile(join(upstream, 'after-tag.txt'), 'x\n', 'utf8');
    await git(upstream, 'add', '.');
    await git(upstream, 'commit', '-q', '-m', 'after-tag');

    const cacheDir = join(work, 'cache');

    const headResult = await resolveGitSource({ url: fileUrl(upstream) }, { cacheDir });
    const tagResult = await resolveGitSource({ url: fileUrl(upstream), ref: 'v1' }, { cacheDir });

    expect(headResult.localPath).not.toBe(tagResult.localPath);
    expect(headResult.sha).not.toBe(tagResult.sha);
    expect(tagResult.ref).toBe('v1');
  });

  it('writes a meta file beside the working tree with url + ref + sha', async () => {
    const upstream = await makeUpstreamRepo();
    const cacheDir = join(work, 'cache');

    const result: GitResolveResult = await resolveGitSource(
      { url: fileUrl(upstream), ref: 'main' },
      { cacheDir },
    );

    const metaPath = join(cacheDirFor(fileUrl(upstream), 'main', cacheDir), '.hex-meta.json');
    const raw = await readFile(metaPath, 'utf8');
    const meta = JSON.parse(raw);
    expect(meta).toEqual({
      url: fileUrl(upstream),
      ref: 'main',
      sha: result.sha,
      fetchedAt: result.fetchedAt,
    });
  });

  it('throws GitSourceError when the URL is unreachable', async () => {
    const cacheDir = join(work, 'cache');
    const bogus = join(work, 'no-such-repo');
    await expect(resolveGitSource({ url: fileUrl(bogus) }, { cacheDir })).rejects.toThrow(
      GitSourceError,
    );
  });

  it('resolves a 40-char commit SHA as a ref', async () => {
    const upstream = await makeUpstreamRepo();
    const cacheDir = join(work, 'cache');

    // Capture the initial commit SHA, then advance upstream so HEAD diverges.
    const initialSha = await git(upstream, 'rev-parse', 'HEAD');
    await writeFile(join(upstream, 'after.txt'), 'after\n', 'utf8');
    await git(upstream, 'add', '.');
    await git(upstream, 'commit', '-q', '-m', 'after');

    const result = await resolveGitSource(
      { url: fileUrl(upstream), ref: initialSha },
      { cacheDir },
    );

    expect(result.sha).toBe(initialSha);
    expect(result.ref).toBe(initialSha);
    // The "after.txt" file was added in a later commit, so it must NOT be
    // present in the working tree if we really checked out the initial sha.
    await expect(readFile(join(result.localPath, 'after.txt'), 'utf8')).rejects.toThrow();
  });

  it('recovers from a partial cache (meta missing) by re-cloning', async () => {
    const upstream = await makeUpstreamRepo();
    const cacheDir = join(work, 'cache');

    const first = await resolveGitSource({ url: fileUrl(upstream) }, { cacheDir });

    // Wipe the meta file but keep the repo — represents an interrupted run.
    const metaPath = join(cacheDirFor(fileUrl(upstream), undefined, cacheDir), '.hex-meta.json');
    await rm(metaPath, { force: true });

    const second = await resolveGitSource({ url: fileUrl(upstream) }, { cacheDir });
    expect(second.localPath).toBe(first.localPath);
    expect(second.sha).toBe(first.sha);
  });
});

describe('checkUpstreamDrift', () => {
  it('returns no-drift when no cache exists', async () => {
    const cacheDir = join(work, 'cache');
    const drift = await checkUpstreamDrift(
      { url: 'file:///does/not/matter' },
      { cacheDir, now: new Date() },
    );
    expect(drift).toEqual({
      cachedSha: '',
      upstreamSha: null,
      drift: false,
      justChecked: false,
    });
  });

  it('detects drift when upstream advances past the cached SHA', async () => {
    const upstream = await makeUpstreamRepo();
    const cacheDir = join(work, 'cache');

    const fetched = await resolveGitSource({ url: fileUrl(upstream), ref: 'main' }, { cacheDir });

    // Advance upstream by one commit.
    await writeFile(join(upstream, 'after.txt'), 'after\n', 'utf8');
    await git(upstream, 'add', '.');
    await git(upstream, 'commit', '-q', '-m', 'after');

    const drift = await checkUpstreamDrift(
      { url: fileUrl(upstream), ref: 'main' },
      { cacheDir, now: new Date() },
    );

    expect(drift.justChecked).toBe(true);
    expect(drift.cachedSha).toBe(fetched.sha);
    expect(drift.upstreamSha).not.toBe(null);
    expect(drift.drift).toBe(true);
  });

  it('reuses the previous result inside the TTL window', async () => {
    const upstream = await makeUpstreamRepo();
    const cacheDir = join(work, 'cache');

    await resolveGitSource({ url: fileUrl(upstream), ref: 'main' }, { cacheDir });

    const t0 = new Date('2026-05-06T10:00:00.000Z');
    const first = await checkUpstreamDrift(
      { url: fileUrl(upstream), ref: 'main' },
      { cacheDir, now: t0 },
    );
    expect(first.justChecked).toBe(true);

    // Drop the upstream — a real network call would now fail. Within the TTL
    // we must reuse the cached result instead of touching the network.
    await rm(upstream, { recursive: true, force: true });

    const t1 = new Date('2026-05-06T15:59:00.000Z'); // < 6h later
    const second = await checkUpstreamDrift(
      { url: fileUrl(upstream), ref: 'main' },
      { cacheDir, now: t1 },
    );
    expect(second.justChecked).toBe(false);
    expect(second.upstreamSha).toBe(first.upstreamSha);
  });

  it('re-checks once the TTL window has elapsed', async () => {
    const upstream = await makeUpstreamRepo();
    const cacheDir = join(work, 'cache');

    await resolveGitSource({ url: fileUrl(upstream), ref: 'main' }, { cacheDir });

    const t0 = new Date('2026-05-06T10:00:00.000Z');
    const first = await checkUpstreamDrift(
      { url: fileUrl(upstream), ref: 'main' },
      { cacheDir, now: t0 },
    );
    expect(first.justChecked).toBe(true);

    const t1 = new Date('2026-05-06T16:01:00.000Z'); // > 6h later
    const second = await checkUpstreamDrift(
      { url: fileUrl(upstream), ref: 'main' },
      { cacheDir, now: t1 },
    );
    expect(second.justChecked).toBe(true);
  });

  it('reports the previous drift state when ls-remote fails', async () => {
    const upstream = await makeUpstreamRepo();
    const cacheDir = join(work, 'cache');

    await resolveGitSource({ url: fileUrl(upstream), ref: 'main' }, { cacheDir });

    // First check while upstream is alive — TTL=0 forces the network call.
    const t0 = new Date('2026-05-06T10:00:00.000Z');
    await checkUpstreamDrift(
      { url: fileUrl(upstream), ref: 'main' },
      { cacheDir, now: t0, ttlMs: 0 },
    );

    // Kill upstream, re-check past the TTL.
    await rm(upstream, { recursive: true, force: true });

    const t1 = new Date('2026-05-06T20:00:00.000Z');
    const result = await checkUpstreamDrift(
      { url: fileUrl(upstream), ref: 'main' },
      { cacheDir, now: t1, ttlMs: 0 },
    );
    expect(result.justChecked).toBe(false);
    expect(result.error).toMatch(/ls-remote/);
    // Last-known upstream sha equalled cached sha (single commit), so drift is false.
    expect(result.upstreamSha).toBe(result.cachedSha);
    expect(result.drift).toBe(false);
  });
});

describe('cacheDirFor', () => {
  it('produces stable, distinct paths for distinct (url, ref) pairs', () => {
    const base = '/tmp/cache';
    const a = cacheDirFor('https://example.com/a', 'main', base);
    const b = cacheDirFor('https://example.com/a', 'main', base);
    const c = cacheDirFor('https://example.com/a', 'v1', base);
    const d = cacheDirFor('https://example.com/b', 'main', base);

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });

  it('slugifies refs containing slashes for filesystem safety', () => {
    const base = '/tmp/cache';
    const dir = cacheDirFor('https://example.com/a', 'feat/foo', base);
    expect(dir).not.toContain('feat/foo');
    expect(dir).toContain('feat_foo');
  });
});

describe('resolveGitSource — concurrency', () => {
  it('serialises concurrent cold resolves against the same (url, ref)', async () => {
    // Five workers race against an empty cache. They must all converge
    // on the same sha, the meta file must be valid JSON, and no
    // .lock file may be left behind.
    const upstream = await makeUpstreamRepo();
    const cacheDir = join(work, 'cache');
    const entry = { url: fileUrl(upstream) };

    const results = await Promise.all(
      Array.from({ length: 5 }, () => resolveGitSource(entry, { cacheDir })),
    );

    const sha = results[0]?.sha ?? '';
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    for (const r of results) {
      expect(r.sha).toBe(sha);
      expect(r.localPath).toBe(results[0]?.localPath);
    }

    // The meta file is valid JSON and matches what the resolvers returned.
    const cacheRoot = cacheDirFor(entry.url, undefined, cacheDir);
    const meta = JSON.parse(await readFile(join(cacheRoot, '.hex-meta.json'), 'utf8')) as {
      sha: string;
    };
    expect(meta.sha).toBe(sha);

    // The lock was released on every code path.
    const fs = await import('node:fs/promises');
    const entries = await fs.readdir(cacheRoot);
    expect(entries).not.toContain('.lock');
  });

  it('serialises concurrent refreshes against a warm cache', async () => {
    const upstream = await makeUpstreamRepo();
    const cacheDir = join(work, 'cache');
    const entry = { url: fileUrl(upstream) };

    // Warm the cache once.
    await resolveGitSource(entry, { cacheDir });

    // Advance upstream so a refresh has work to do.
    await writeFile(join(upstream, 'README.md'), 'updated\n', 'utf8');
    await git(upstream, 'add', '.');
    await git(upstream, 'commit', '-q', '-m', 'second');
    const newHead = await git(upstream, 'rev-parse', 'HEAD');

    const results = await Promise.all(
      Array.from({ length: 5 }, () => resolveGitSource(entry, { cacheDir, refresh: true })),
    );

    for (const r of results) {
      expect(r.sha).toBe(newHead);
    }
    const cacheRoot = cacheDirFor(entry.url, undefined, cacheDir);
    const meta = JSON.parse(await readFile(join(cacheRoot, '.hex-meta.json'), 'utf8')) as {
      sha: string;
    };
    expect(meta.sha).toBe(newHead);
  });
});
