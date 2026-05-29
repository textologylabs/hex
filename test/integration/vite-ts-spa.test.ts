import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { runPrompts } from '../../src/core/prompts/engine.js';
import type { Prompter } from '../../src/core/prompts/types.js';
import { renderBundle } from '../../src/core/render/engine.js';
import { loadFromPath } from '../../src/core/sources/file-source.js';

const TEMPLATE_PATH = resolve(__dirname, '..', '..', 'templates', 'vite-ts-spa');

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-int-vite-ts-spa-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

type FixtureAnswers = {
  project_name: string;
  description: string;
  author: string;
  license: string;
};

function fixedPrompter(answers: FixtureAnswers): Prompter {
  return {
    async text(opts) {
      const map: Record<string, string> = {
        'Package name (e.g. my-app)': answers.project_name,
        'Short description': answers.description,
        Author: answers.author,
      };
      const value = map[opts.message];
      if (value === undefined) throw new Error(`unexpected text prompt: ${opts.message}`);
      const validation = opts.validate?.(value);
      if (validation !== undefined) throw new Error(`validation failed: ${validation}`);
      return value;
    },
    async confirm(opts) {
      throw new Error(`unexpected confirm prompt: ${opts.message}`);
    },
    async select(opts) {
      if (opts.message === 'License') return answers.license;
      throw new Error(`unexpected select prompt: ${opts.message}`);
    },
    async multiselect(opts) {
      throw new Error(`unexpected multiselect prompt: ${opts.message}`);
    },
    async password(opts) {
      throw new Error(`unexpected password prompt: ${opts.message}`);
    },
  };
}

describe('vite-ts-spa template — end-to-end', () => {
  it('manifest carries the M12 deploy + cicd stanzas', async () => {
    const bundle = await loadFromPath(TEMPLATE_PATH);
    expect(bundle.manifest.deploy).toEqual({ adapter: 'vercel' });
    expect(bundle.manifest.cicd).toEqual({
      provider: 'github-actions',
      'node-version': '20',
    });
  });

  it('renders a complete buildable SPA with templated identity', async () => {
    const bundle = await loadFromPath(TEMPLATE_PATH);
    const answers = await runPrompts(
      bundle.manifest.prompts ?? [],
      fixedPrompter({
        project_name: 'my-app',
        description: 'Demo SPA',
        author: 'Alice',
        license: 'MIT',
      }),
      {},
      bundle.manifest.sections,
    );

    const out = join(work, 'my-app');
    const result = await renderBundle(bundle, out, answers);

    for (const f of [
      'package.json',
      'tsconfig.json',
      'biome.json',
      'vite.config.ts',
      'index.html',
      'src/main.ts',
      'src/style.css',
      'README.md',
      'LICENSE',
    ]) {
      expect(existsSync(join(out, f))).toBe(true);
    }

    // Rename hook fired
    expect(existsSync(join(out, '.gitignore'))).toBe(true);
    expect(existsSync(join(out, 'gitignore'))).toBe(false);
    expect(result.renamed).toContainEqual({ from: 'gitignore', to: '.gitignore' });

    // package.json templated
    const pkg = JSON.parse(await readFile(join(out, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('my-app');
    expect(pkg.description).toBe('Demo SPA');
    expect(pkg.license).toBe('MIT');
    expect(pkg.scripts.dev).toBe('vite');
    expect(pkg.scripts.build).toContain('vite build');

    // index.html title templated
    const html = await readFile(join(out, 'index.html'), 'utf8');
    expect(html).toContain('<title>my-app</title>');

    // main.ts has identity wired in
    const main = await readFile(join(out, 'src/main.ts'), 'utf8');
    expect(main).toContain('my-app');
    expect(main).toContain('Demo SPA');

    // README mirrored
    const readme = await readFile(join(out, 'README.md'), 'utf8');
    expect(readme).toContain('# my-app');
    expect(readme).toContain('MIT © Alice');
    expect(readme).toContain('hex deploy');

    // LICENSE picked MIT branch
    const license = await readFile(join(out, 'LICENSE'), 'utf8');
    expect(license).toContain('MIT License');
    expect(license).toContain('Alice');
  });

  it('falls back to a sensible main.ts message when no description is given', async () => {
    const bundle = await loadFromPath(TEMPLATE_PATH);
    const answers = await runPrompts(
      bundle.manifest.prompts ?? [],
      fixedPrompter({
        project_name: 'bare',
        description: '',
        author: '',
        license: 'Apache-2.0',
      }),
      {},
      bundle.manifest.sections,
    );

    const out = join(work, 'bare');
    await renderBundle(bundle, out, answers);

    const main = await readFile(join(out, 'src/main.ts'), 'utf8');
    expect(main).toContain('Hello from Hex.');

    const license = await readFile(join(out, 'LICENSE'), 'utf8');
    expect(license).toContain('Apache License');
  });

  it('exposes the M12 setup tasks in the manifest', async () => {
    const bundle = await loadFromPath(TEMPLATE_PATH);
    const ids = bundle.manifest.setup?.tasks?.map((t) => t.id).sort();
    expect(ids).toEqual([
      'first-deploy',
      'git-init',
      'install-deps',
      'set-vercel-token',
      'vercel-link',
    ]);
  });

  it('rejects an invalid project_name (pattern fails)', async () => {
    const bundle = await loadFromPath(TEMPLATE_PATH);
    await expect(
      runPrompts(
        bundle.manifest.prompts ?? [],
        fixedPrompter({
          project_name: 'BadName',
          description: '',
          author: '',
          license: 'MIT',
        }),
        {},
        bundle.manifest.sections,
      ),
    ).rejects.toThrow(/must match pattern/);
  });

  // Sanity check: the vite.config.ts we ship parses as valid TypeScript-style
  // text and the config file's body matches what Vite needs at minimum. Real
  // build verification happens in the M12.6 manual-test matrix.
  it('vite.config.ts contains a defineConfig call', async () => {
    const bundle = await loadFromPath(TEMPLATE_PATH);
    const answers = await runPrompts(
      bundle.manifest.prompts ?? [],
      fixedPrompter({
        project_name: 'cfg',
        description: '',
        author: '',
        license: 'MIT',
      }),
      {},
      bundle.manifest.sections,
    );
    const out = join(work, 'cfg');
    await renderBundle(bundle, out, answers);
    const cfg = await readFile(join(out, 'vite.config.ts'), 'utf8');
    expect(cfg).toMatch(/defineConfig\(/);
  });

  it('manifest validates against the unused-yaml check', async () => {
    // Loading via the file source runs manifest schema validation;
    // a manifest with extra junk in deploy/cicd would already throw at
    // load time. This is the existence assertion that proves we did.
    const bundle = await loadFromPath(TEMPLATE_PATH);
    expect(bundle.manifest.type).toBe('component');
    expect(bundle.manifest.kind).toBe('webapp');
  });

  it('package.json round-trips through JSON.parse', async () => {
    const bundle = await loadFromPath(TEMPLATE_PATH);
    const answers = await runPrompts(
      bundle.manifest.prompts ?? [],
      fixedPrompter({
        project_name: 'parser-app',
        description: '',
        author: '',
        license: 'MIT',
      }),
      {},
      bundle.manifest.sections,
    );
    const out = join(work, 'parser-app');
    await renderBundle(bundle, out, answers);
    const raw = await readFile(join(out, 'package.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('manifest yaml itself parses cleanly (sanity)', async () => {
    const raw = await readFile(join(TEMPLATE_PATH, '.hex', 'manifest.yaml'), 'utf8');
    expect(() => parseYaml(raw)).not.toThrow();
  });
});
