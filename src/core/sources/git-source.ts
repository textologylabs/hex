import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { withFileLock, writeFileAtomic } from '../util/atomic.js';

const execFileAsync = promisify(execFile);

export class GitSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitSourceError';
  }
}

export type GitResolveResult = {
  /** Filesystem path to the working tree (stable as long as the cache exists). */
  localPath: string;
  /** Original URL, verbatim from config. */
  url: string;
  /** Resolved ref — the input ref or `HEAD` when not specified. */
  ref: string;
  /** Commit SHA at the resolved ref. */
  sha: string;
  /** When the cache was last refreshed (ISO 8601). */
  fetchedAt: string;
};

export type ResolveOpts = {
  /** Override the cache root. Defaults to HEX_CACHE_DIR or ~/.hex/cache. */
  cacheDir?: string;
  /** Force a re-fetch even when a cache hit would otherwise satisfy the call. */
  refresh?: boolean;
};

const META_FILENAME = '.hex-meta.json';
const REPO_SUBDIR = 'repo';
const LOCK_FILENAME = '.lock';

export function getDefaultCacheDir(): string {
  const env = process.env.HEX_CACHE_DIR;
  if (env && env.length > 0) return env;
  return join(homedir(), '.hex', 'cache');
}

function shortHash(input: string, len: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, len);
}

function refSlug(ref: string): string {
  return ref.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Canonical cache directory for a `(url, ref)` pair. Each ref caches in
 * its own subdir so switching ref does not trash the other's checkout.
 *
 * Layout: `<base>/git/<urlHash16>/<refSlug>-<refHash8>/`
 */
export function cacheDirFor(url: string, ref: string | undefined, baseDir: string): string {
  const refKey = ref ?? '_head';
  return join(baseDir, 'git', shortHash(url, 16), `${refSlug(refKey)}-${shortHash(refKey, 8)}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function assertGitAvailable(): Promise<void> {
  try {
    await execFileAsync('git', ['--version']);
  } catch (err) {
    throw new GitSourceError(
      `git executable not found on PATH — install git to use git source roots (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
}

async function runGit(args: string[], cwd: string): Promise<void> {
  try {
    await execFileAsync('git', args, { cwd, env: process.env });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = e.stderr?.trim() || e.message || String(err);
    throw new GitSourceError(`git ${args.join(' ')} failed: ${detail}`);
  }
}

async function revParseHead(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
  return stdout.trim();
}

async function clone(url: string, ref: string | undefined, repoDir: string): Promise<string> {
  await mkdir(repoDir, { recursive: true });
  await runGit(['init', '-q'], repoDir);
  await runGit(['remote', 'add', 'origin', url], repoDir);
  await runGit(['fetch', '--depth', '1', 'origin', ref ?? 'HEAD'], repoDir);
  await runGit(['checkout', '-q', 'FETCH_HEAD'], repoDir);
  return revParseHead(repoDir);
}

async function refetch(url: string, ref: string | undefined, repoDir: string): Promise<string> {
  // Make sure origin still points at the configured URL — it could have been
  // edited under us, or the cache could be partial from a failed previous run.
  await runGit(['remote', 'set-url', 'origin', url], repoDir);
  await runGit(['fetch', '--depth', '1', 'origin', ref ?? 'HEAD'], repoDir);
  await runGit(['reset', '--hard', 'FETCH_HEAD'], repoDir);
  return revParseHead(repoDir);
}

export type GitMeta = {
  url: string;
  ref: string;
  sha: string;
  fetchedAt: string;
  /** When we last asked upstream for its SHA via `git ls-remote`. */
  lastCheckedAt?: string;
  /** Last upstream SHA observed by an `ls-remote` check. */
  lastKnownUpstreamSha?: string;
};
type Meta = GitMeta;

/** Default 6h TTL between `git ls-remote` calls per (url, ref). */
export const DEFAULT_UPSTREAM_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

export type UpstreamCheckResult = {
  /** SHA recorded the last time we cloned/refreshed. Empty when uncached. */
  cachedSha: string;
  /** Last SHA observed upstream — null if no check has ever succeeded. */
  upstreamSha: string | null;
  /** True iff `upstreamSha` is known and differs from `cachedSha`. */
  drift: boolean;
  /** True if this call actually performed a network `ls-remote`. */
  justChecked: boolean;
  /** Populated when `ls-remote` failed in this call; never thrown. */
  error?: string;
};

export type UpstreamCheckOpts = {
  cacheDir?: string;
  /** Minimum interval between consecutive `ls-remote` calls. Default 6h. */
  ttlMs?: number;
  /** Override `now()` for tests. */
  now?: Date;
};

async function readMeta(metaPath: string): Promise<Meta | null> {
  try {
    const raw = await readFile(metaPath, 'utf8');
    return JSON.parse(raw) as Meta;
  } catch {
    return null;
  }
}

/**
 * Read the meta record for a cached git source, or `null` if absent.
 * Useful for status commands that want to display fetch time / sha
 * without triggering a network call.
 */
export async function readGitMeta(
  entry: { url: string; ref?: string },
  cacheDir?: string,
): Promise<GitMeta | null> {
  const baseDir = cacheDir ?? getDefaultCacheDir();
  const metaPath = join(cacheDirFor(entry.url, entry.ref, baseDir), META_FILENAME);
  return readMeta(metaPath);
}

async function writeMeta(metaPath: string, meta: Meta): Promise<void> {
  await writeFileAtomic(metaPath, JSON.stringify(meta, null, 2));
}

/**
 * Resolve a git source root into a local working tree, fetching on cache
 * miss and reusing the cache on hit. Set `opts.refresh` to force a
 * re-fetch even when the cache is warm.
 *
 * Authentication is delegated to the system `git` — SSH agent, credential
 * helpers, and `~/.gitconfig` all work transparently.
 */
export async function resolveGitSource(
  entry: { url: string; ref?: string },
  opts: ResolveOpts = {},
): Promise<GitResolveResult> {
  await assertGitAvailable();

  const baseDir = opts.cacheDir ?? getDefaultCacheDir();
  const cacheRoot = cacheDirFor(entry.url, entry.ref, baseDir);
  const repoDir = join(cacheRoot, REPO_SUBDIR);
  const metaPath = join(cacheRoot, META_FILENAME);

  // Fast path — a warm cache needs no lock (reads are safe because
  // `writeMeta` is atomic). The slow path below re-checks under the lock.
  const cached = await readMeta(metaPath);
  if (cached && (await pathExists(join(repoDir, '.git'))) && !opts.refresh) {
    return {
      localPath: repoDir,
      url: cached.url,
      ref: cached.ref,
      sha: cached.sha,
      fetchedAt: cached.fetchedAt,
    };
  }

  await mkdir(cacheRoot, { recursive: true });
  return withFileLock(join(cacheRoot, LOCK_FILENAME), async () => {
    // A peer process may have completed the clone/refetch while we
    // were waiting on the lock — re-check inside the critical section.
    const fresh = await readMeta(metaPath);
    const repoExists = await pathExists(join(repoDir, '.git'));
    if (fresh && repoExists && !opts.refresh) {
      return {
        localPath: repoDir,
        url: fresh.url,
        ref: fresh.ref,
        sha: fresh.sha,
        fetchedAt: fresh.fetchedAt,
      };
    }

    let sha: string;
    if (repoExists) {
      sha = await refetch(entry.url, entry.ref, repoDir);
    } else {
      // Cold cache or partial state — start fresh.
      if (await pathExists(repoDir)) await rm(repoDir, { recursive: true, force: true });
      sha = await clone(entry.url, entry.ref, repoDir);
    }

    const meta: Meta = {
      url: entry.url,
      ref: entry.ref ?? 'HEAD',
      sha,
      fetchedAt: new Date().toISOString(),
    };
    await writeMeta(metaPath, meta);

    return {
      localPath: repoDir,
      url: meta.url,
      ref: meta.ref,
      sha: meta.sha,
      fetchedAt: meta.fetchedAt,
    };
  });
}

/**
 * Ask the remote what SHA `<ref>` (or `HEAD`) currently points at, without
 * fetching any objects. Lightweight enough for periodic drift checks.
 */
async function lsRemoteSha(url: string, ref: string | undefined): Promise<string> {
  const target = ref ?? 'HEAD';
  let stdout: string;
  try {
    const result = await execFileAsync('git', ['ls-remote', url, target], { env: process.env });
    stdout = result.stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = e.stderr?.trim() || e.message || String(err);
    throw new GitSourceError(`git ls-remote ${url} ${target} failed: ${detail}`);
  }

  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new GitSourceError(`git ls-remote ${url} ${target} returned no refs`);
  }
  // Each line is `<sha>\t<ref-name>`. Take the first match — for `HEAD` and
  // unambiguous refs there's only one line; for ambiguous refs (a branch and
  // tag with the same name) we accept the first the server returned.
  const first = lines[0] as string;
  const sha = first.split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new GitSourceError(`git ls-remote ${url} ${target} produced unexpected output: ${first}`);
  }
  return sha;
}

/**
 * Compare the cached SHA against upstream's current SHA via `git ls-remote`,
 * gated by a TTL so consecutive `hex list` calls do not hammer the network.
 *
 * Failures (offline, auth error, host down) are caught and reported in the
 * `error` field — never thrown. Drift detection then degrades gracefully:
 * we surface whatever was last known, so a transient failure does not erase
 * a previously-detected drift.
 *
 * Side effect: on a successful `ls-remote`, the meta file is updated with
 * `lastCheckedAt` and `lastKnownUpstreamSha`. A failed check does NOT bump
 * `lastCheckedAt`, so the next call will retry instead of being silenced
 * for the rest of the TTL window.
 */
export async function checkUpstreamDrift(
  entry: { url: string; ref?: string },
  opts: UpstreamCheckOpts = {},
): Promise<UpstreamCheckResult> {
  const baseDir = opts.cacheDir ?? getDefaultCacheDir();
  const cacheRoot = cacheDirFor(entry.url, entry.ref, baseDir);
  const metaPath = join(cacheRoot, META_FILENAME);
  const ttlMs = opts.ttlMs ?? DEFAULT_UPSTREAM_CHECK_TTL_MS;
  const now = opts.now ?? new Date();

  const meta = await readMeta(metaPath);
  if (!meta) {
    // Nothing cached → nothing to compare against.
    return { cachedSha: '', upstreamSha: null, drift: false, justChecked: false };
  }

  const cachedSha = meta.sha;
  const lastChecked = meta.lastCheckedAt ? new Date(meta.lastCheckedAt) : null;
  const elapsed = lastChecked ? now.getTime() - lastChecked.getTime() : Number.POSITIVE_INFINITY;
  const withinTtl = elapsed < ttlMs;

  if (withinTtl) {
    const upstreamSha = meta.lastKnownUpstreamSha ?? null;
    return {
      cachedSha,
      upstreamSha,
      drift: upstreamSha !== null && upstreamSha !== cachedSha,
      justChecked: false,
    };
  }

  let upstreamSha: string;
  try {
    upstreamSha = await lsRemoteSha(entry.url, entry.ref);
  } catch (err) {
    const lastKnown = meta.lastKnownUpstreamSha ?? null;
    return {
      cachedSha,
      upstreamSha: lastKnown,
      drift: lastKnown !== null && lastKnown !== cachedSha,
      justChecked: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Persist the upstream-check result under the lock so a concurrent
  // `resolveGitSource` cannot stomp the freshly-written fields.
  await withFileLock(join(cacheRoot, LOCK_FILENAME), async () => {
    const latest = (await readMeta(metaPath)) ?? meta;
    const updated: Meta = {
      ...latest,
      lastCheckedAt: now.toISOString(),
      lastKnownUpstreamSha: upstreamSha,
    };
    await writeMeta(metaPath, updated);
  });

  return {
    cachedSha,
    upstreamSha,
    drift: upstreamSha !== cachedSha,
    justChecked: true,
  };
}
