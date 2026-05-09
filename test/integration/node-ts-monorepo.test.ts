import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Prompter } from '../../src/core/prompts/types.js';
import { runRecipePrompts } from '../../src/core/recipe/prompts.js';
import { renderRecipe } from '../../src/core/recipe/render.js';
import { resolveRecipe } from '../../src/core/recipe/resolve.js';
import { loadFromPath } from '../../src/core/sources/file-source.js';

const RECIPE_PATH = resolve(__dirname, '..', '..', 'templates', 'node-ts-monorepo');

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-int-monorepo-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

type FixtureAnswers = {
  workspace_name: string;
  cli: {
    project_name: string;
    description: string;
    author: string;
    license: 'MIT' | 'Apache-2.0';
    include_examples: boolean;
    include_self_update: boolean;
    include_publish_workflow: boolean;
  };
  lib: {
    project_name: string;
    description: string;
    author: string;
    license: 'MIT' | 'Apache-2.0';
  };
};

// One scripted prompter that answers each prompt by message — the engine
// asks recipe-level prompts first, then per-child prompts in `composes:`
// declaration order. Multiple children share prompt names (project_name,
// description, …), so we route per-child by tracking which child is
// currently being configured via the `note` calls the engine emits before
// each child section.
function fixedPrompter(answers: FixtureAnswers): Prompter {
  let currentChild: 'cli' | 'lib' | null = null;
  const childAnswers = (k: 'cli' | 'lib') => answers[k];

  return {
    note(_body, title) {
      if (title === 'Configuring "cli"') currentChild = 'cli';
      else if (title === 'Configuring "lib"') currentChild = 'lib';
    },
    async text(opts) {
      if (opts.message === 'Workspace name (root package.json `name`)') {
        return answers.workspace_name;
      }
      if (currentChild === null) {
        throw new Error(`unexpected text prompt before any child section: ${opts.message}`);
      }
      const a = childAnswers(currentChild);
      const map: Record<string, string> = {
        'Package name (e.g. my-cli)': a.project_name,
        'Package name (e.g. my-lib)': a.project_name,
        'Short description': a.description,
        Author: a.author,
      };
      const value = map[opts.message];
      if (value === undefined) {
        throw new Error(`unexpected text prompt for ${currentChild}: ${opts.message}`);
      }
      const validation = opts.validate?.(value);
      if (validation !== undefined) throw new Error(`validation failed: ${validation}`);
      return value;
    },
    async confirm(opts) {
      if (currentChild !== 'cli') {
        throw new Error(`unexpected confirm prompt for ${currentChild}: ${opts.message}`);
      }
      const a = answers.cli;
      if (opts.message === 'Include an example "hello" command?') return a.include_examples;
      if (opts.message === 'Include a self-update prompt on launch?') return a.include_self_update;
      if (opts.message === 'Include a GitHub Actions workflow that publishes on tag?') {
        return a.include_publish_workflow;
      }
      throw new Error(`unexpected confirm prompt: ${opts.message}`);
    },
    async select(opts) {
      if (currentChild === null) {
        throw new Error(`unexpected select prompt before any child section: ${opts.message}`);
      }
      if (opts.message === 'License') return childAnswers(currentChild).license;
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

describe('node-ts-monorepo template — end-to-end', () => {
  it('renders a complete monorepo with workspace orchestration + both children', async () => {
    const bundle = await loadFromPath(RECIPE_PATH);
    const resolved = await resolveRecipe(bundle, { config: { sources: [] } });

    const fixture: FixtureAnswers = {
      workspace_name: 'demo-mono',
      cli: {
        project_name: 'demo-cli',
        description: 'The CLI for demo-mono',
        author: 'Test Author',
        license: 'MIT',
        include_examples: true,
        include_self_update: false,
        include_publish_workflow: false,
      },
      lib: {
        project_name: 'demo-lib',
        description: 'The library for demo-mono',
        author: 'Test Author',
        license: 'MIT',
      },
    };

    const answers = await runRecipePrompts(resolved, fixedPrompter(fixture));

    // Answer-tree namespacing — recipe-level at root, children nested.
    expect(answers.workspace_name).toBe('demo-mono');
    expect((answers.cli as { project_name: string }).project_name).toBe('demo-cli');
    expect((answers.lib as { project_name: string }).project_name).toBe('demo-lib');

    const out = join(work, 'out');
    const result = await renderRecipe(resolved, out, answers);

    // Recipe-root orchestration files
    const rootPkg = JSON.parse(await readFile(join(out, 'package.json'), 'utf8'));
    expect(rootPkg.name).toBe('demo-mono');
    expect(rootPkg.private).toBe(true);
    expect(rootPkg.workspaces).toEqual(['cli', 'lib']);

    const rootReadme = await readFile(join(out, 'README.md'), 'utf8');
    expect(rootReadme).toContain('# demo-mono');
    expect(rootReadme).toContain('demo-cli');
    expect(rootReadme).toContain('demo-lib');

    // Recipe's gitignore-rename hook fired
    expect(existsSync(join(out, '.gitignore'))).toBe(true);
    expect(existsSync(join(out, 'gitignore'))).toBe(false);

    // Children rendered into their subdirs
    const cliPkg = JSON.parse(await readFile(join(out, 'cli', 'package.json'), 'utf8'));
    expect(cliPkg.name).toBe('demo-cli');
    expect(cliPkg.bin['demo-cli']).toBe('./dist/cli.js');

    const libPkg = JSON.parse(await readFile(join(out, 'lib', 'package.json'), 'utf8'));
    expect(libPkg.name).toBe('demo-lib');
    expect(libPkg.main).toBe('./dist/index.cjs');
    expect(libPkg.types).toBe('./dist/index.d.ts');

    // Each child's gitignore hook fired against its own subtree
    expect(existsSync(join(out, 'cli', '.gitignore'))).toBe(true);
    expect(existsSync(join(out, 'lib', '.gitignore'))).toBe(true);

    // CLI feature gates: include_self_update=false → src/update.ts excluded.
    expect(existsSync(join(out, 'cli', 'src', 'update.ts'))).toBe(false);
    // include_examples=true → examples retained
    expect(existsSync(join(out, 'cli', 'src', 'cli.ts'))).toBe(true);

    // Result shape exposes per-child render data
    expect([...result.children.keys()]).toEqual(['cli', 'lib']);
    expect(result.children.get('cli')?.subdir).toBe('cli');
    expect(result.children.get('lib')?.subdir).toBe('lib');
    // Recipe wrote root README + root package.json + a gitignore (later
    // renamed to .gitignore by the post_render hook). `written` records
    // pre-rename paths.
    expect(result.recipe.written.sort()).toEqual(['README.md', 'gitignore', 'package.json']);
    expect(result.recipe.renamed).toEqual([{ from: 'gitignore', to: '.gitignore' }]);
  });
});
