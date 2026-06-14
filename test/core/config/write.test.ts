import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/core/config/load.js';
import { addSource, removeSource, trustSource } from '../../../src/core/config/write.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hex-config-write-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const opts = () => ({ configDir: dir });

describe('addSource', () => {
  it('creates config.yaml on first add and writes a block-style catalogue entry', async () => {
    const res = await addSource(
      { kind: 'catalogue', url: 'https://x.test/cat', ref: 'main' },
      opts(),
    );
    expect(res.added).toBe(true);

    const raw = await readFile(join(dir, 'config.yaml'), 'utf8');
    expect(raw).toContain('sources:');
    expect(raw).toContain('- catalogue: https://x.test/cat');
    expect(raw).toContain('ref: main');
    // Block, not flow style.
    expect(raw).not.toContain('[');

    const config = await loadConfig(opts());
    expect(config.sources).toEqual([{ kind: 'catalogue', url: 'https://x.test/cat', ref: 'main' }]);
  });

  it('is idempotent — re-adding an identical entry is a no-op', async () => {
    await addSource({ kind: 'catalogue', url: 'https://x.test/cat' }, opts());
    const res = await addSource({ kind: 'catalogue', url: 'https://x.test/cat' }, opts());
    expect(res.added).toBe(false);

    const config = await loadConfig(opts());
    expect(config.sources).toHaveLength(1);
  });

  it('treats a different ref as a distinct entry', async () => {
    await addSource({ kind: 'catalogue', url: 'https://x.test/cat', ref: 'main' }, opts());
    const res = await addSource(
      { kind: 'catalogue', url: 'https://x.test/cat', ref: 'next' },
      opts(),
    );
    expect(res.added).toBe(true);

    const config = await loadConfig(opts());
    expect(config.sources).toHaveLength(2);
  });

  it('adds git and path sources with the right wire shape', async () => {
    await addSource({ kind: 'git', url: 'https://x.test/repo.git' }, opts());
    await addSource({ kind: 'path', path: '/srv/templates' }, opts());

    const config = await loadConfig(opts());
    expect(config.sources).toContainEqual({ kind: 'git', url: 'https://x.test/repo.git' });
    expect(config.sources).toContainEqual({ kind: 'path', path: '/srv/templates' });
  });

  it('preserves other top-level keys and comments in an existing config', async () => {
    await writeFile(
      join(dir, 'config.yaml'),
      '# my hex config\nmarketplaces:\n  - id: hex\n    registry: https://reg.test/\nsources:\n  - path: /existing\n',
      'utf8',
    );

    await addSource({ kind: 'catalogue', url: 'https://x.test/cat' }, opts());

    const raw = await readFile(join(dir, 'config.yaml'), 'utf8');
    expect(raw).toContain('# my hex config');
    expect(raw).toContain('id: hex');

    const config = await loadConfig(opts());
    expect(config.marketplaces).toEqual([{ id: 'hex', registry: 'https://reg.test/' }]);
    expect(config.sources).toContainEqual({ kind: 'path', path: '/existing' });
    expect(config.sources).toContainEqual({ kind: 'catalogue', url: 'https://x.test/cat' });
  });
});

describe('removeSource', () => {
  it('removes a matching source and reports the count', async () => {
    await addSource({ kind: 'catalogue', url: 'https://x.test/cat', ref: 'main' }, opts());
    await addSource({ kind: 'git', url: 'https://x.test/repo.git' }, opts());

    const res = await removeSource('https://x.test/cat', opts());
    expect(res.removed).toBe(1);

    const config = await loadConfig(opts());
    expect(config.sources).toEqual([{ kind: 'git', url: 'https://x.test/repo.git' }]);
  });

  it('matches by identifier regardless of ref', async () => {
    await addSource({ kind: 'catalogue', url: 'https://x.test/cat', ref: 'main' }, opts());
    const res = await removeSource('https://x.test/cat', opts());
    expect(res.removed).toBe(1);
    const config = await loadConfig(opts());
    expect(config.sources).toEqual([]);
  });

  it('reports zero and writes nothing when nothing matches', async () => {
    await addSource({ kind: 'path', path: '/a' }, opts());
    const res = await removeSource('https://nope.test', opts());
    expect(res.removed).toBe(0);
    const config = await loadConfig(opts());
    expect(config.sources).toHaveLength(1);
  });
});

describe('trustSource', () => {
  it('creates trust.sources and adds the identifier', async () => {
    const res = await trustSource('https://x.test/cat', opts());
    expect(res.added).toBe(true);

    const raw = await readFile(join(dir, 'config.yaml'), 'utf8');
    expect(raw).toContain('trust:');
    expect(raw).toContain('- https://x.test/cat');

    const config = await loadConfig(opts());
    expect(config.trust?.sources).toEqual(['https://x.test/cat']);
  });

  it('is idempotent — re-trusting is a no-op', async () => {
    await trustSource('https://x.test/cat', opts());
    const res = await trustSource('https://x.test/cat', opts());
    expect(res.added).toBe(false);
    const config = await loadConfig(opts());
    expect(config.trust?.sources).toEqual(['https://x.test/cat']);
  });

  it('appends to an existing trusted list and preserves sources', async () => {
    await addSource({ kind: 'catalogue', url: 'https://x.test/cat' }, opts());
    await trustSource('https://x.test/cat', opts());
    await trustSource('https://y.test/cat', opts());

    const config = await loadConfig(opts());
    expect(config.trust?.sources).toEqual(['https://x.test/cat', 'https://y.test/cat']);
    expect(config.sources).toContainEqual({ kind: 'catalogue', url: 'https://x.test/cat' });
  });
});
