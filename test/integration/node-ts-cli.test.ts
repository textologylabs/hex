import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checklistFromTasks,
  readChecklistUpward,
  writeChecklist,
} from '../../src/core/checklist/index.js';
import { runPrompts } from '../../src/core/prompts/engine.js';
import type { Prompter } from '../../src/core/prompts/types.js';
import { renderBundle } from '../../src/core/render/engine.js';
import { loadFromPath } from '../../src/core/sources/file-source.js';

const TEMPLATE_PATH = resolve(__dirname, '..', '..', 'templates', 'node-ts-cli');

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-int-node-ts-cli-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

type FixtureAnswers = {
  project_name: string;
  description: string;
  author: string;
  license: string;
  include_examples: boolean;
  include_self_update: boolean;
  include_publish_workflow: boolean;
};

function fixedPrompter(answers: FixtureAnswers): Prompter {
  return {
    async text(opts) {
      const map: Record<string, string> = {
        'Package name (e.g. my-cli)': answers.project_name,
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
      if (opts.message === 'Include an example "hello" command?') return answers.include_examples;
      if (opts.message === 'Include a self-update prompt on launch?')
        return answers.include_self_update;
      if (opts.message === 'Include a GitHub Actions workflow that publishes on tag?')
        return answers.include_publish_workflow;
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

describe('node-ts-cli template — end-to-end', () => {
  it('renders a complete project with examples + self-update included', async () => {
    const bundle = await loadFromPath(TEMPLATE_PATH);
    const answers = await runPrompts(
      bundle.manifest.prompts ?? [],
      fixedPrompter({
        project_name: 'my-cli',
        description: 'Demo CLI',
        author: 'Alice',
        license: 'MIT',
        include_examples: true,
        include_self_update: true,
        include_publish_workflow: true,
      }),
      {},
      bundle.manifest.sections,
    );

    const out = join(work, 'my-cli');
    const result = await renderBundle(bundle, out, answers);

    // Files we expect in the output
    expect(existsSync(join(out, 'package.json'))).toBe(true);
    expect(existsSync(join(out, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(out, 'biome.json'))).toBe(true);
    expect(existsSync(join(out, 'tsup.config.ts'))).toBe(true);
    expect(existsSync(join(out, 'src/cli.ts'))).toBe(true);
    expect(existsSync(join(out, 'src/examples/hello.ts'))).toBe(true);
    expect(existsSync(join(out, 'README.md'))).toBe(true);
    expect(existsSync(join(out, 'LICENSE'))).toBe(true);

    // self-update file present and templated
    expect(existsSync(join(out, 'src/update.ts'))).toBe(true);
    const update = await readFile(join(out, 'src/update.ts'), 'utf8');
    expect(update).toContain("PKG_NAME = 'my-cli'");
    expect(update).toContain('export async function maybeUpdate');

    // Rename hook ran
    expect(existsSync(join(out, '.gitignore'))).toBe(true);
    expect(existsSync(join(out, 'gitignore'))).toBe(false);
    expect(result.renamed).toContainEqual({ from: 'gitignore', to: '.gitignore' });

    // package.json was templated
    const pkg = JSON.parse(await readFile(join(out, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('my-cli');
    expect(pkg.description).toBe('Demo CLI');
    expect(pkg.license).toBe('MIT');
    expect(pkg.bin['my-cli']).toBe('./dist/cli.js');

    // cli.ts contains the example command (include_examples = true)
    // and wires up the self-update call
    const cli = await readFile(join(out, 'src/cli.ts'), 'utf8');
    expect(cli).toContain("'my-cli'");
    expect(cli).toContain('Demo CLI');
    expect(cli).toContain('hello [name]');
    expect(cli).toContain("import { maybeUpdate } from './update.js'");
    expect(cli).toContain('await maybeUpdate()');

    // LICENSE picked up MIT branch
    const license = await readFile(join(out, 'LICENSE'), 'utf8');
    expect(license).toContain('MIT License');
    expect(license).toContain('Alice');

    // README picked up author
    const readme = await readFile(join(out, 'README.md'), 'utf8');
    expect(readme).toContain('# my-cli');
    expect(readme).toContain('MIT © Alice');

    // Publish workflow rendered (include_publish_workflow = true)
    expect(existsSync(join(out, '.github/workflows/publish.yml'))).toBe(true);
    const workflow = await readFile(join(out, '.github/workflows/publish.yml'), 'utf8');
    expect(workflow).toContain('NPM_TOKEN');
    expect(readme).toContain('Releasing');

    // The setup block is on the manifest itself; the loop runs in hex new
    // (not renderBundle). What we can assert here: the manifest exposes
    // the tasks for downstream tooling.
    expect(bundle.manifest.setup?.tasks?.map((t) => t.id).sort()).toEqual([
      'configure-git-remote',
      'configure-npm-token',
      'first-release',
      'git-commit-initial',
      'git-init',
      'git-stage',
      'install-deps',
    ]);
  });

  it('drops example command, src/examples/, and self-update when both are off', async () => {
    const bundle = await loadFromPath(TEMPLATE_PATH);
    const answers = await runPrompts(
      bundle.manifest.prompts ?? [],
      fixedPrompter({
        project_name: 'minimal-cli',
        description: '',
        author: '',
        license: 'Apache-2.0',
        include_examples: false,
        include_self_update: false,
        include_publish_workflow: false,
      }),
      {},
      bundle.manifest.sections,
    );

    const out = join(work, 'minimal-cli');
    const result = await renderBundle(bundle, out, answers);

    // examples dir was deleted by post_render hook
    expect(existsSync(join(out, 'src/examples/hello.ts'))).toBe(false);
    expect(result.deleted).toContain('src/examples/hello.ts');

    // self-update file was excluded by include: rule (not even rendered)
    expect(existsSync(join(out, 'src/update.ts'))).toBe(false);

    // cli.ts has neither the example block nor the self-update wiring
    const cli = await readFile(join(out, 'src/cli.ts'), 'utf8');
    expect(cli).not.toContain('hello [name]');
    expect(cli).not.toContain("from './update.js'");
    expect(cli).not.toContain('maybeUpdate');
    expect(cli).toContain("'minimal-cli'");

    // LICENSE picked up Apache branch
    const license = await readFile(join(out, 'LICENSE'), 'utf8');
    expect(license).toContain('Apache License');

    // Publish workflow excluded by include rule (include_publish_workflow = false)
    expect(existsSync(join(out, '.github/workflows/publish.yml'))).toBe(false);
    const readme = await readFile(join(out, 'README.md'), 'utf8');
    expect(readme).not.toContain('Releasing');
  });

  it('renders self-update without examples (mixed flags)', async () => {
    const bundle = await loadFromPath(TEMPLATE_PATH);
    const answers = await runPrompts(
      bundle.manifest.prompts ?? [],
      fixedPrompter({
        project_name: 'leancli',
        description: 'lean',
        author: '',
        license: 'MIT',
        include_examples: false,
        include_self_update: true,
        include_publish_workflow: true,
      }),
      {},
      bundle.manifest.sections,
    );

    const out = join(work, 'leancli');
    await renderBundle(bundle, out, answers);

    expect(existsSync(join(out, 'src/update.ts'))).toBe(true);
    expect(existsSync(join(out, 'src/examples/hello.ts'))).toBe(false);

    const cli = await readFile(join(out, 'src/cli.ts'), 'utf8');
    expect(cli).toContain('await maybeUpdate()');
    expect(cli).not.toContain('hello [name]');
  });

  it('post-render: writes .hex/checklist.yaml with all tasks pending', async () => {
    const bundle = await loadFromPath(TEMPLATE_PATH);
    const answers = await runPrompts(
      bundle.manifest.prompts ?? [],
      fixedPrompter({
        project_name: 'mycli',
        description: '',
        author: '',
        license: 'MIT',
        include_examples: false,
        include_self_update: false,
        include_publish_workflow: true,
      }),
      {},
      bundle.manifest.sections,
    );

    const out = join(work, 'mycli');
    await renderBundle(bundle, out, answers);

    // Mirror what `hex new` does after rendering when setup tasks exist.
    const tasks = bundle.manifest.setup?.tasks ?? [];
    expect(tasks.length).toBeGreaterThan(0);
    await writeChecklist(out, checklistFromTasks(tasks));

    const loaded = await readChecklistUpward(out);
    expect(loaded).not.toBeNull();
    expect(loaded?.rootDir).toBe(out);
    expect(loaded?.checklist.tasks.map((t) => t.id).sort()).toEqual([
      'configure-git-remote',
      'configure-npm-token',
      'first-release',
      'git-commit-initial',
      'git-init',
      'git-stage',
      'install-deps',
    ]);
    expect(loaded?.checklist.tasks.every((t) => t.status === 'pending')).toBe(true);
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
          include_examples: true,
          include_self_update: true,
          include_publish_workflow: true,
        }),
        {},
        bundle.manifest.sections,
      ),
    ).rejects.toThrow(/must match pattern/);
  });
});
