import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { validateMarketplaceFile } from '../../src/commands/marketplace.js';
import { runPrompts } from '../../src/core/prompts/engine.js';
import type { Prompter } from '../../src/core/prompts/types.js';
import { renderBundle } from '../../src/core/render/engine.js';
import { loadFromPath } from '../../src/core/sources/file-source.js';

const TEMPLATE_PATH = resolve(__dirname, '..', '..', 'templates', 'marketplace-catalogue');

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-int-mkt-cat-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

type FixtureAnswers = {
  namespace: string;
  description: string;
  maintainer: string;
  license: string;
};

function fixedPrompter(answers: FixtureAnswers): Prompter {
  return {
    async text(opts) {
      const map: Record<string, string> = {
        'Catalogue namespace (the qualifier in `<namespace>/<name>`)': answers.namespace,
        'One-line catalogue description': answers.description,
        'Primary maintainer (GitHub username or org)': answers.maintainer,
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
      if (opts.message === 'Licence') return answers.license;
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

describe('marketplace-catalogue template — end-to-end', () => {
  it('manifest carries the catalogue identity prompts + setup tasks', async () => {
    const bundle = await loadFromPath(TEMPLATE_PATH);
    expect(bundle.manifest.kind).toBe('catalogue');
    const promptNames = (bundle.manifest.prompts ?? []).map((p) => p.name);
    expect(promptNames).toEqual(['namespace', 'description', 'maintainer', 'license']);
    const taskIds = (bundle.manifest.setup?.tasks ?? []).map((t) => t.id);
    expect(taskIds).toContain('git-init');
    expect(taskIds).toContain('validate-locally');
    expect(taskIds).toContain('add-first-package');
    expect(taskIds).toContain('tell-users');
  });

  it('renders a complete catalogue tree with templated identity', async () => {
    const bundle = await loadFromPath(TEMPLATE_PATH);
    const answers = await runPrompts(
      bundle.manifest.prompts ?? [],
      fixedPrompter({
        namespace: 'acme',
        description: 'Acme platform components',
        maintainer: 'acme-platform',
        license: 'MIT',
      }),
      {},
      bundle.manifest.sections,
    );

    const out = join(work, 'render');
    await renderBundle(bundle, out, answers, { force: true });

    // Tree shape — every expected top-level entry is present.
    for (const file of [
      'marketplace.yaml',
      'README.md',
      'LICENSE',
      '.gitignore',
      '.github/workflows/validate.yml',
    ]) {
      expect(existsSync(join(out, file)), `missing ${file}`).toBe(true);
    }

    // The gitignore rename hook fired.
    expect(existsSync(join(out, 'gitignore'))).toBe(false);

    // Identity templated into both yaml and README.
    const yaml = await readFile(join(out, 'marketplace.yaml'), 'utf8');
    expect(yaml).toContain('namespace: acme');
    expect(yaml).toContain('Acme platform components');
    expect(yaml).toContain('- acme-platform');

    const readme = await readFile(join(out, 'README.md'), 'utf8');
    expect(readme).toContain('# acme');
    expect(readme).toContain('hex new acme/<package-name>@<version> my-app');

    const license = await readFile(join(out, 'LICENSE'), 'utf8');
    expect(license).toContain('MIT License');
    expect(license).toContain('Copyright (c) acme-platform');
  });

  it('rendered marketplace.yaml schema-validates clean', async () => {
    const bundle = await loadFromPath(TEMPLATE_PATH);
    const answers = await runPrompts(
      bundle.manifest.prompts ?? [],
      fixedPrompter({
        namespace: 'acme',
        description: 'Acme platform components',
        maintainer: 'acme-platform',
        license: 'MIT',
      }),
      {},
      bundle.manifest.sections,
    );

    const out = join(work, 'render');
    await renderBundle(bundle, out, answers, { force: true });

    const result = await validateMarketplaceFile(join(out, 'marketplace.yaml'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.namespace).toBe('acme');
      expect(result.packageCount).toBe(1);
    }
  });

  it('renders with an empty description (optional prompt left blank)', async () => {
    const bundle = await loadFromPath(TEMPLATE_PATH);
    const answers = await runPrompts(
      bundle.manifest.prompts ?? [],
      fixedPrompter({
        namespace: 'acme',
        description: '',
        maintainer: 'acme-platform',
        license: 'Apache-2.0',
      }),
      {},
      bundle.manifest.sections,
    );

    const out = join(work, 'render');
    await renderBundle(bundle, out, answers, { force: true });

    const yaml = await readFile(join(out, 'marketplace.yaml'), 'utf8');
    // The `description:` line is gated on a truthy value — should be absent.
    expect(yaml).not.toMatch(/^description:\s/m);

    const parsed = parseYaml(yaml);
    expect(parsed.namespace).toBe('acme');

    const validation = await validateMarketplaceFile(join(out, 'marketplace.yaml'));
    expect(validation.ok).toBe(true);

    const license = await readFile(join(out, 'LICENSE'), 'utf8');
    expect(license).toContain('Apache License');
  });

  it('rejects an invalid namespace via the prompt pattern', async () => {
    const bundle = await loadFromPath(TEMPLATE_PATH);
    await expect(
      runPrompts(
        bundle.manifest.prompts ?? [],
        fixedPrompter({
          namespace: 'NOT VALID',
          description: '',
          maintainer: 'acme-platform',
          license: 'MIT',
        }),
        {},
        bundle.manifest.sections,
      ),
    ).rejects.toThrow(/validation failed/);
  });
});
