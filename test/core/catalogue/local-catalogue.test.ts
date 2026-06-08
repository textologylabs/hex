import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCAL_MARKETPLACE_ID,
  browseLocalCatalogue,
  searchLocalCatalogue,
} from '../../../src/core/catalogue/local-catalogue.js';

let workspace: string;

async function makeTemplate(root: string, name: string, manifestBody: string): Promise<void> {
  const hexDir = join(root, name, '.hex');
  await mkdir(hexDir, { recursive: true });
  await writeFile(join(hexDir, 'manifest.yaml'), manifestBody, 'utf8');
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'hex-local-catalogue-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('searchLocalCatalogue', () => {
  it('returns every template under a path: source root with an empty query', async () => {
    await makeTemplate(
      workspace,
      'alpha',
      'type: component\nname: alpha\nversion: 1.0.0\nkind: cli\n',
    );
    await makeTemplate(workspace, 'beta', 'type: recipe\nname: beta\nversion: 0.2.0\n');

    const { entries, warnings } = await searchLocalCatalogue(
      { sources: [{ kind: 'path', path: workspace }] },
      '',
    );

    expect(warnings).toEqual([]);
    expect(entries.map((e) => e.name).sort()).toEqual(['alpha', 'beta']);
    expect(entries.every((e) => e.marketplace === LOCAL_MARKETPLACE_ID)).toBe(true);
  });

  it('maps version to latest and kind to a single category for components', async () => {
    await makeTemplate(
      workspace,
      'api-express',
      'type: component\nname: api-express\nversion: 0.3.1\nkind: api\n',
    );

    const { entries } = await searchLocalCatalogue(
      { sources: [{ kind: 'path', path: workspace }] },
      '',
    );

    expect(entries).toEqual([
      {
        marketplace: LOCAL_MARKETPLACE_ID,
        name: 'api-express',
        type: 'component',
        kind: 'api',
        latest: '0.3.1',
        categories: ['api'],
      },
    ]);
  });

  it('files a recipe with no categories — recipes have no kind', async () => {
    await makeTemplate(workspace, 'fs', 'type: recipe\nname: fs\nversion: 1.0.0\n');

    const { entries } = await searchLocalCatalogue(
      { sources: [{ kind: 'path', path: workspace }] },
      '',
    );

    expect(entries).toEqual([
      {
        marketplace: LOCAL_MARKETPLACE_ID,
        name: 'fs',
        type: 'recipe',
        latest: '1.0.0',
        categories: [],
      },
    ]);
  });

  it('case-insensitive substring match on name', async () => {
    await makeTemplate(
      workspace,
      'node-ts-cli',
      'type: component\nname: node-ts-cli\nversion: 1.0.0\nkind: cli\n',
    );
    await makeTemplate(
      workspace,
      'vite-ts-spa',
      'type: component\nname: vite-ts-spa\nversion: 1.0.0\nkind: webapp\n',
    );
    const config = { sources: [{ kind: 'path' as const, path: workspace }] };

    expect((await searchLocalCatalogue(config, 'CLI')).entries.map((e) => e.name)).toEqual([
      'node-ts-cli',
    ]);
    expect((await searchLocalCatalogue(config, 'spa')).entries.map((e) => e.name)).toEqual([
      'vite-ts-spa',
    ]);
    expect((await searchLocalCatalogue(config, 'nope')).entries).toEqual([]);
  });

  it('forwards discovery warnings to the caller', async () => {
    const missing = join(workspace, 'does-not-exist');
    const { entries, warnings } = await searchLocalCatalogue(
      { sources: [{ kind: 'path', path: missing }] },
      '',
    );
    expect(entries).toEqual([]);
    expect(warnings.some((w) => w.includes(missing))).toBe(true);
  });

  it('a config with no path: / git: sources yields zero entries (catalogue: skipped)', async () => {
    const { entries, warnings } = await searchLocalCatalogue(
      {
        sources: [{ kind: 'catalogue', url: 'https://example.invalid/' }],
      },
      '',
    );
    expect(entries).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe('browseLocalCatalogue', () => {
  it('filters entries by category (case-insensitive, derived from kind)', async () => {
    await makeTemplate(
      workspace,
      'api-express',
      'type: component\nname: api-express\nversion: 1.0.0\nkind: api\n',
    );
    await makeTemplate(
      workspace,
      'api-fastify',
      'type: component\nname: api-fastify\nversion: 1.0.0\nkind: api\n',
    );
    await makeTemplate(
      workspace,
      'node-ts-cli',
      'type: component\nname: node-ts-cli\nversion: 1.0.0\nkind: cli\n',
    );

    const config = { sources: [{ kind: 'path' as const, path: workspace }] };

    const apiHits = await browseLocalCatalogue(config, 'api');
    expect(apiHits.entries.map((e) => e.name).sort()).toEqual(['api-express', 'api-fastify']);

    const cliHits = await browseLocalCatalogue(config, 'CLI');
    expect(cliHits.entries.map((e) => e.name)).toEqual(['node-ts-cli']);

    const empty = await browseLocalCatalogue(config, 'nonexistent');
    expect(empty.entries).toEqual([]);
  });
});
