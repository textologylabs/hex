import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  NewCommandError,
  collectNewAnswers,
  executeNewRender,
  resolveTemplateFromCatalogues,
  tryParseCatalogueAddress,
} from '../../src/commands/new.js';
import type { HexConfig } from '../../src/core/config/types.js';
import { lockfileSchema } from '../../src/core/lockfile/index.js';
import type { MarketplaceYaml } from '../../src/core/marketplace/catalogue-schema.js';
import type { Prompter } from '../../src/core/prompts/types.js';

const execFileAsync = promisify(execFile);

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-new-cat-'));
});

afterEach(async () => {
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

function fileUrl(p: string): string {
  return `file://${p}`;
}

/**
 * Build a git repo holding N template versions, each at its own tag.
 * Each tag holds `.hex/manifest.yaml` + a README — minimal but valid.
 */
async function makePackageRepo(
  name: string,
  versions: Array<{ tag: string; manifest: string; extraFiles?: Record<string, string> }>,
): Promise<string> {
  const upstream = join(work, `pkg-${name}`);
  await mkdir(upstream, { recursive: true });
  await git(upstream, 'init', '-q', '-b', 'main');

  for (const v of versions) {
    await mkdir(join(upstream, '.hex'), { recursive: true });
    await writeFile(join(upstream, '.hex', 'manifest.yaml'), v.manifest, 'utf8');
    await writeFile(join(upstream, 'README.md'), `# ${name}@${v.tag}\n`, 'utf8');
    for (const [path, body] of Object.entries(v.extraFiles ?? {})) {
      const abs = join(upstream, path);
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, body, 'utf8');
    }
    await git(upstream, 'add', '.');
    await git(upstream, 'commit', '-q', '-m', `release ${v.tag}`);
    await git(upstream, 'tag', v.tag);
  }
  return upstream;
}

async function makeCatalogueRepo(name: string, yaml: MarketplaceYaml): Promise<string> {
  const upstream = join(work, `cat-${name}`);
  await mkdir(upstream, { recursive: true });
  await git(upstream, 'init', '-q', '-b', 'main');
  await writeFile(join(upstream, 'marketplace.yaml'), stringifyYaml(yaml), 'utf8');
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-q', '-m', 'init');
  return upstream;
}

function configWith(catalogues: string[]): HexConfig {
  return {
    sources: catalogues.map((url) => ({ kind: 'catalogue', url })),
    marketplaces: [],
  };
}

function manifestFor(name: string, version: string): string {
  return `type: component
name: ${name}
version: ${version}

prompts:
  - project_name:
      type: string
      required: true
      description: Project name
`;
}

describe('tryParseCatalogueAddress', () => {
  it('returns the parsed parts for a qualified address', () => {
    expect(tryParseCatalogueAddress('hex/vite-ts-spa@^1.0')).toEqual({
      marketplace: 'hex',
      name: 'vite-ts-spa',
      version: '^1.0.0',
    });
  });

  it('returns the parsed parts for a bare address with no version', () => {
    expect(tryParseCatalogueAddress('vite-ts-spa')).toEqual({
      marketplace: null,
      name: 'vite-ts-spa',
      version: 'latest',
    });
  });

  it('returns null on malformed input', () => {
    expect(tryParseCatalogueAddress('foo/bar/baz')).toBeNull();
  });
});

describe('resolveTemplateFromCatalogues', () => {
  it('resolves a qualified address against the matching catalogue', async () => {
    const pkg = await makePackageRepo('demo', [
      { tag: '1.0.0', manifest: manifestFor('demo', '1.0.0') },
      { tag: '2.0.0', manifest: manifestFor('demo', '2.0.0') },
    ]);
    const cat = await makeCatalogueRepo('hex', {
      namespace: 'hex',
      packages: [
        {
          name: 'demo',
          versions: [
            { tag: '1.0.0', source: { git: fileUrl(pkg), ref: '1.0.0' } },
            { tag: '2.0.0', source: { git: fileUrl(pkg), ref: '2.0.0' } },
          ],
        },
      ],
    });
    const config = configWith([fileUrl(cat)]);
    const parsed = tryParseCatalogueAddress('hex/demo@^1.0');
    if (!parsed) throw new Error('parser refused fixture');

    const warnings: string[] = [];
    const bundle = await resolveTemplateFromCatalogues(config, parsed, 'hex/demo@^1.0', {
      cacheDir: join(work, 'cache'),
      warn: (m) => warnings.push(m),
    });
    expect(bundle).not.toBeNull();
    expect(bundle?.manifest.version).toBe('1.0.0');
    expect(bundle?.catalogueSource).toEqual({
      catalogueUrl: fileUrl(cat),
      namespace: 'hex',
      packageName: 'demo',
    });
    expect(warnings).toEqual([]);
  });

  it('throws a clear error for an unknown qualified namespace', async () => {
    const cat = await makeCatalogueRepo('hex', {
      namespace: 'hex',
      packages: [
        {
          name: 'demo',
          versions: [{ tag: '1.0.0', source: { git: 'https://example.test/x.git' } }],
        },
      ],
    });
    const config = configWith([fileUrl(cat)]);
    const parsed = tryParseCatalogueAddress('acme/demo');
    if (!parsed) throw new Error('parser refused fixture');
    await expect(
      resolveTemplateFromCatalogues(config, parsed, 'acme/demo', {
        cacheDir: join(work, 'cache'),
        warn: () => {},
      }),
    ).rejects.toBeInstanceOf(NewCommandError);
  });

  it('throws when a qualified version spec cannot be satisfied', async () => {
    const cat = await makeCatalogueRepo('hex', {
      namespace: 'hex',
      packages: [
        {
          name: 'demo',
          versions: [{ tag: '1.0.0', source: { git: 'https://example.test/x.git' } }],
        },
      ],
    });
    const config = configWith([fileUrl(cat)]);
    const parsed = tryParseCatalogueAddress('hex/demo@^2.0');
    if (!parsed) throw new Error('parser refused fixture');
    await expect(
      resolveTemplateFromCatalogues(config, parsed, 'hex/demo@^2.0', {
        cacheDir: join(work, 'cache'),
        warn: () => {},
      }),
    ).rejects.toThrow(/satisfies "\^2\.0\.0"/);
  });

  it('walks catalogues in declared order for a bare name; first hit wins', async () => {
    const pkgA = await makePackageRepo('first', [
      { tag: '1.0.0', manifest: manifestFor('first', '1.0.0') },
    ]);
    const pkgB = await makePackageRepo('second', [
      { tag: '1.0.0', manifest: manifestFor('second', '1.0.0') },
    ]);
    const catA = await makeCatalogueRepo('a', {
      namespace: 'a',
      packages: [{ name: 'shared', versions: [{ tag: '1.0.0', source: { git: fileUrl(pkgA) } }] }],
    });
    const catB = await makeCatalogueRepo('b', {
      namespace: 'b',
      packages: [{ name: 'shared', versions: [{ tag: '1.0.0', source: { git: fileUrl(pkgB) } }] }],
    });
    const config = configWith([fileUrl(catA), fileUrl(catB)]);
    const parsed = tryParseCatalogueAddress('shared@*');
    if (!parsed) throw new Error('parser refused fixture');
    const bundle = await resolveTemplateFromCatalogues(config, parsed, 'shared@*', {
      cacheDir: join(work, 'cache'),
      warn: () => {},
    });
    expect(bundle?.catalogueSource?.namespace).toBe('a');
  });

  it('returns null when a bare-name lookup finds nothing in any catalogue', async () => {
    const cat = await makeCatalogueRepo('hex', {
      namespace: 'hex',
      packages: [{ name: 'demo', versions: [{ tag: '1.0.0', source: { git: 'x' } }] }],
    });
    const config = configWith([fileUrl(cat)]);
    const parsed = tryParseCatalogueAddress('missing@*');
    if (!parsed) throw new Error('parser refused fixture');
    const bundle = await resolveTemplateFromCatalogues(config, parsed, 'missing@*', {
      cacheDir: join(work, 'cache'),
      warn: () => {},
    });
    expect(bundle).toBeNull();
  });
});

describe('end-to-end: hex new → lockfile records catalogue source', () => {
  it('renders a template fetched via catalogue and records the catalogue source in the lockfile', async () => {
    const pkg = await makePackageRepo('demo', [
      {
        tag: '1.0.0',
        manifest: manifestFor('demo', '1.0.0'),
        extraFiles: { 'src/index.txt': 'Hello {{ project_name }}\n' },
      },
    ]);
    const cat = await makeCatalogueRepo('hex', {
      namespace: 'hex',
      packages: [
        {
          name: 'demo',
          versions: [{ tag: '1.0.0', source: { git: fileUrl(pkg), ref: '1.0.0' } }],
        },
      ],
    });
    const config = configWith([fileUrl(cat)]);
    const parsed = tryParseCatalogueAddress('hex/demo@1.0.0');
    if (!parsed) throw new Error('parser refused fixture');
    const bundle = await resolveTemplateFromCatalogues(config, parsed, 'hex/demo@1.0.0', {
      cacheDir: join(work, 'cache'),
      warn: () => {},
    });
    if (!bundle) throw new Error('catalogue resolution returned null');

    const prompter: Prompter = {
      async text() {
        return 'cool-app';
      },
      async confirm() {
        return true;
      },
      async select(opts) {
        return opts.choices[0] ?? '';
      },
      async multiselect() {
        return [];
      },
      async password() {
        return '';
      },
    };

    const ctx = await collectNewAnswers(bundle, prompter, config);
    const outputDir = join(work, 'out');
    await mkdir(outputDir, { recursive: true });
    await executeNewRender(bundle, outputDir, ctx, { force: true });

    const lockfilePath = join(outputDir, '.hex', 'lockfile.yaml');
    const raw = await readFile(lockfilePath, 'utf8');
    const parsedLock = lockfileSchema.parse(parseYaml(raw));

    expect(parsedLock.root).toEqual({
      name: 'demo',
      version: '1.0.0',
      type: 'component',
      source: {
        kind: 'catalogue',
        catalogue_url: fileUrl(cat),
        namespace: 'hex',
        name: 'demo',
      },
    });
    expect(parsedLock.files.some((f) => f.path === 'src/index.txt')).toBe(true);
  });
});
