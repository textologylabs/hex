import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import {
  type RefreshResult,
  gatherSourceStatuses,
  refreshAllCatalogueSources,
  refreshAllGitSources,
} from '../../src/commands/sources.js';
import { resolveGitSource } from '../../src/core/sources/git-source.js';

const execFileAsync = promisify(execFile);

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-sources-cmd-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function runGit(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

async function makeUpstream(): Promise<string> {
  const upstream = join(work, 'upstream');
  await mkdir(upstream, { recursive: true });
  await runGit(upstream, 'init', '-q', '-b', 'main');
  await writeFile(join(upstream, 'README.md'), 'hello\n', 'utf8');
  await runGit(upstream, 'add', '.');
  await runGit(upstream, 'commit', '-q', '-m', 'initial');
  return upstream;
}

describe('gatherSourceStatuses', () => {
  it('reports exists/missing for path sources without touching git', async () => {
    const present = join(work, 'present');
    const missing = join(work, 'no-such-dir');
    await mkdir(present);

    const statuses = await gatherSourceStatuses({
      sources: [
        { kind: 'path', path: present },
        { kind: 'path', path: missing },
      ],
    });

    expect(statuses).toEqual([
      { kind: 'path', path: present, exists: true },
      { kind: 'path', path: missing, exists: false },
    ]);
  });

  it('reports uncached for a git source that has never been fetched', async () => {
    const cacheDir = join(work, 'cache');
    const statuses = await gatherSourceStatuses(
      { sources: [{ kind: 'git', url: 'file:///tmp/nope', ref: 'main' }] },
      { cacheDir },
    );

    expect(statuses).toHaveLength(1);
    const first = statuses[0];
    expect(first?.kind).toBe('git');
    if (first?.kind !== 'git') return;
    expect(first.status.cached).toBe(false);
    expect(first.status.sha).toBeUndefined();
    expect(first.status.fetchedAt).toBeUndefined();
  });

  it('reports cached + fresh after a clone, with no drift', async () => {
    const upstream = await makeUpstream();
    const cacheDir = join(work, 'cache');

    await resolveGitSource({ url: `file://${upstream}`, ref: 'main' }, { cacheDir });

    const statuses = await gatherSourceStatuses(
      { sources: [{ kind: 'git', url: `file://${upstream}`, ref: 'main' }] },
      { cacheDir },
    );

    const first = statuses[0];
    expect(first?.kind).toBe('git');
    if (first?.kind !== 'git') return;
    expect(first.status.cached).toBe(true);
    expect(first.status.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(first.status.drift).toBe(false);
    expect(first.status.upstreamSha).toBe(first.status.sha);
  });

  it('reports drift when upstream has advanced past the cached SHA', async () => {
    const upstream = await makeUpstream();
    const cacheDir = join(work, 'cache');

    const fetched = await resolveGitSource(
      { url: `file://${upstream}`, ref: 'main' },
      { cacheDir },
    );

    // Advance upstream.
    await writeFile(join(upstream, 'after.txt'), 'after\n', 'utf8');
    await runGit(upstream, 'add', '.');
    await runGit(upstream, 'commit', '-q', '-m', 'after');

    const statuses = await gatherSourceStatuses(
      { sources: [{ kind: 'git', url: `file://${upstream}`, ref: 'main' }] },
      { cacheDir },
    );

    const first = statuses[0];
    expect(first?.kind).toBe('git');
    if (first?.kind !== 'git') return;
    expect(first.status.cached).toBe(true);
    expect(first.status.sha).toBe(fetched.sha);
    expect(first.status.drift).toBe(true);
    expect(first.status.upstreamSha).not.toBe(fetched.sha);
  });

  it('handles a mixed config of path + multiple git sources', async () => {
    const present = join(work, 'present');
    await mkdir(present);
    const upA = await makeUpstream();
    const upB = join(work, 'upstreamB');
    await mkdir(upB);
    await runGit(upB, 'init', '-q', '-b', 'main');
    await writeFile(join(upB, 'B'), 'b\n', 'utf8');
    await runGit(upB, 'add', '.');
    await runGit(upB, 'commit', '-q', '-m', 'b');

    const cacheDir = join(work, 'cache');
    // Prime only one of the two git sources.
    await resolveGitSource({ url: `file://${upA}`, ref: 'main' }, { cacheDir });

    const statuses = await gatherSourceStatuses(
      {
        sources: [
          { kind: 'path', path: present },
          { kind: 'git', url: `file://${upA}`, ref: 'main' },
          { kind: 'git', url: `file://${upB}`, ref: 'main' },
        ],
      },
      { cacheDir },
    );

    expect(statuses).toHaveLength(3);
    expect(statuses[0]?.kind).toBe('path');
    if (statuses[0]?.kind === 'path') expect(statuses[0].exists).toBe(true);

    expect(statuses[1]?.kind).toBe('git');
    if (statuses[1]?.kind === 'git') expect(statuses[1].status.cached).toBe(true);

    expect(statuses[2]?.kind).toBe('git');
    if (statuses[2]?.kind === 'git') expect(statuses[2].status.cached).toBe(false);
  });
});

describe('refreshAllGitSources', () => {
  it('returns an empty result when no git sources are configured', async () => {
    const cacheDir = join(work, 'cache');
    const results = await refreshAllGitSources(
      { sources: [{ kind: 'path', path: '/tmp' }] },
      { cacheDir },
    );
    expect(results).toEqual([]);
  });

  it('clones an uncached git source and records the SHA', async () => {
    const upstream = await makeUpstream();
    const cacheDir = join(work, 'cache');

    const results = await refreshAllGitSources(
      { sources: [{ kind: 'git', url: `file://${upstream}`, ref: 'main' }] },
      { cacheDir },
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(results[0]?.error).toBeUndefined();
  });

  it('advances a stale cache to the latest upstream SHA', async () => {
    const upstream = await makeUpstream();
    const cacheDir = join(work, 'cache');

    const initial = await resolveGitSource(
      { url: `file://${upstream}`, ref: 'main' },
      { cacheDir },
    );

    // Advance upstream.
    await writeFile(join(upstream, 'NEW'), 'x\n', 'utf8');
    await runGit(upstream, 'add', '.');
    await runGit(upstream, 'commit', '-q', '-m', 'second');

    const results = await refreshAllGitSources(
      { sources: [{ kind: 'git', url: `file://${upstream}`, ref: 'main' }] },
      { cacheDir },
    );

    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.sha).not.toBe(initial.sha);
  });

  it('reports per-source failures without aborting the rest', async () => {
    const ok = await makeUpstream();
    const cacheDir = join(work, 'cache');

    const results = await refreshAllGitSources(
      {
        sources: [
          { kind: 'git', url: `file://${join(work, 'no-such')}` },
          { kind: 'git', url: `file://${ok}`, ref: 'main' },
        ],
      },
      { cacheDir },
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toBeTruthy();
    expect(results[1]?.ok).toBe(true);
    expect(results[1]?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('fires onStart and onComplete callbacks per source in order', async () => {
    const upstream = await makeUpstream();
    const cacheDir = join(work, 'cache');
    const events: string[] = [];

    const results: RefreshResult[] = await refreshAllGitSources(
      { sources: [{ kind: 'git', url: `file://${upstream}`, ref: 'main' }] },
      {
        cacheDir,
        onStart: (display) => events.push(`start:${display}`),
        onComplete: (r) => events.push(`done:${r.display}:${r.ok ? 'ok' : 'err'}`),
      },
    );

    const display = `file://${upstream}@main`;
    expect(events).toEqual([`start:${display}`, `done:${display}:ok`]);
    expect(results[0]?.ok).toBe(true);
  });
});

async function makeCatalogueRepo(
  yaml: Record<string, unknown>,
  name = 'catalogue-upstream',
): Promise<string> {
  const upstream = join(work, name);
  await mkdir(upstream, { recursive: true });
  await runGit(upstream, 'init', '-q', '-b', 'main');
  await writeFile(join(upstream, 'marketplace.yaml'), stringifyYaml(yaml), 'utf8');
  await runGit(upstream, 'add', '.');
  await runGit(upstream, 'commit', '-q', '-m', 'init');
  return upstream;
}

describe('catalogue sources (M13.2)', () => {
  it('gatherSourceStatuses reports catalogue with namespace + package count when cached', async () => {
    const upstream = await makeCatalogueRepo({
      namespace: 'hex',
      packages: [
        { name: 'a', versions: [{ tag: '0.1.0', source: { git: 'https://x/y' } }] },
        { name: 'b', versions: [{ tag: '0.1.0', source: { git: 'https://x/y' } }] },
      ],
    });
    const cacheDir = join(work, 'cache');
    await resolveGitSource({ url: `file://${upstream}`, ref: 'main' }, { cacheDir });

    const statuses = await gatherSourceStatuses(
      {
        sources: [{ kind: 'catalogue', url: `file://${upstream}`, ref: 'main' }],
      },
      { cacheDir },
    );

    expect(statuses).toHaveLength(1);
    const s = statuses[0];
    expect(s?.kind).toBe('catalogue');
    if (s?.kind !== 'catalogue') throw new Error('expected catalogue');
    expect(s.status.cached).toBe(true);
    expect(s.status.namespace).toBe('hex');
    expect(s.status.packageCount).toBe(2);
    expect(s.status.catalogueError).toBeUndefined();
  });

  it('gatherSourceStatuses surfaces catalogueError when marketplace.yaml is malformed', async () => {
    const upstream = join(work, 'bad-catalogue');
    await mkdir(upstream, { recursive: true });
    await runGit(upstream, 'init', '-q', '-b', 'main');
    await writeFile(join(upstream, 'marketplace.yaml'), 'namespace: Bad\npackages: []\n', 'utf8');
    await runGit(upstream, 'add', '.');
    await runGit(upstream, 'commit', '-q', '-m', 'init');

    const cacheDir = join(work, 'cache');
    await resolveGitSource({ url: `file://${upstream}`, ref: 'main' }, { cacheDir });

    const statuses = await gatherSourceStatuses(
      {
        sources: [{ kind: 'catalogue', url: `file://${upstream}`, ref: 'main' }],
      },
      { cacheDir },
    );

    const s = statuses[0];
    if (s?.kind !== 'catalogue') throw new Error('expected catalogue');
    expect(s.status.cached).toBe(true);
    expect(s.status.catalogueError).toMatch(/schema validation failed/);
    expect(s.status.namespace).toBeUndefined();
  });

  it('gatherSourceStatuses reports uncached + no validation attempt when cache is cold', async () => {
    const upstream = await makeCatalogueRepo({
      namespace: 'hex',
      packages: [{ name: 'a', versions: [{ tag: '0.1.0', source: { git: 'https://x/y' } }] }],
    });
    const cacheDir = join(work, 'cache');

    const statuses = await gatherSourceStatuses(
      {
        sources: [{ kind: 'catalogue', url: `file://${upstream}`, ref: 'main' }],
      },
      { cacheDir },
    );
    const s = statuses[0];
    if (s?.kind !== 'catalogue') throw new Error('expected catalogue');
    expect(s.status.cached).toBe(false);
    expect(s.status.namespace).toBeUndefined();
    expect(s.status.catalogueError).toBeUndefined();
  });

  it('refreshAllCatalogueSources clones + validates and returns the sha', async () => {
    const upstream = await makeCatalogueRepo({
      namespace: 'hex',
      packages: [{ name: 'a', versions: [{ tag: '0.1.0', source: { git: 'https://x/y' } }] }],
    });
    const cacheDir = join(work, 'cache');

    const results = await refreshAllCatalogueSources(
      {
        sources: [{ kind: 'catalogue', url: `file://${upstream}`, ref: 'main' }],
      },
      { cacheDir },
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('refreshAllCatalogueSources reports schema failures per-source without crashing', async () => {
    const goodUpstream = await makeCatalogueRepo(
      {
        namespace: 'hex',
        packages: [{ name: 'a', versions: [{ tag: '0.1.0', source: { git: 'https://x/y' } }] }],
      },
      'good-catalogue',
    );

    const badUpstream = join(work, 'bad-catalogue');
    await mkdir(badUpstream, { recursive: true });
    await runGit(badUpstream, 'init', '-q', '-b', 'main');
    await writeFile(
      join(badUpstream, 'marketplace.yaml'),
      'namespace: BAD\npackages: []\n',
      'utf8',
    );
    await runGit(badUpstream, 'add', '.');
    await runGit(badUpstream, 'commit', '-q', '-m', 'init');

    const cacheDir = join(work, 'cache');
    const results = await refreshAllCatalogueSources(
      {
        sources: [
          { kind: 'catalogue', url: `file://${goodUpstream}`, ref: 'main' },
          { kind: 'catalogue', url: `file://${badUpstream}`, ref: 'main' },
        ],
      },
      { cacheDir },
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
    expect(results[1]?.error).toMatch(/schema validation failed/);
  });

  it('refreshAllCatalogueSources fires onStart/onComplete per source', async () => {
    const upstream = await makeCatalogueRepo({
      namespace: 'hex',
      packages: [{ name: 'a', versions: [{ tag: '0.1.0', source: { git: 'https://x/y' } }] }],
    });
    const events: string[] = [];

    const results = await refreshAllCatalogueSources(
      {
        sources: [{ kind: 'catalogue', url: `file://${upstream}`, ref: 'main' }],
      },
      {
        cacheDir: join(work, 'cache'),
        onStart: (d) => events.push(`start:${d}`),
        onComplete: (r) => events.push(`done:${r.display}:${r.ok ? 'ok' : 'fail'}`),
      },
    );

    const display = `file://${upstream}@main`;
    expect(events).toEqual([`start:${display}`, `done:${display}:ok`]);
    expect(results[0]?.ok).toBe(true);
  });

  it('refreshAllGitSources skips catalogue sources (separation of concerns)', async () => {
    const upstream = await makeCatalogueRepo({
      namespace: 'hex',
      packages: [{ name: 'a', versions: [{ tag: '0.1.0', source: { git: 'https://x/y' } }] }],
    });

    const gitResults: RefreshResult[] = await refreshAllGitSources(
      {
        sources: [{ kind: 'catalogue', url: `file://${upstream}`, ref: 'main' }],
      },
      { cacheDir: join(work, 'cache') },
    );

    expect(gitResults).toEqual([]);
  });
});
