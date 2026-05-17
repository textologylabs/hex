import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectNewAnswers, executeNewRender } from '../../../src/commands/new.js';
import {
  type Lockfile,
  checkLockfileIntegrity,
  readLockfileUpward,
} from '../../../src/core/lockfile/index.js';
import type { Prompter } from '../../../src/core/prompts/types.js';
import { loadFromPath } from '../../../src/core/sources/file-source.js';
import { PristineError, reconstructPristine } from '../../../src/core/upgrade/pristine.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-pristine-test-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function writeFileEnsure(path: string, body: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body, 'utf8');
}

async function writeManifest(rootPath: string, body: string): Promise<void> {
  const hexDir = join(rootPath, '.hex');
  await mkdir(hexDir, { recursive: true });
  await writeFile(join(hexDir, 'manifest.yaml'), body, 'utf8');
}

/**
 * A recipe + 2 children. The `api` child carries a declarative
 * post_render rename hook, so reconstruction must replay the hook to
 * land integrity-clean — exercising "hooks execute identically".
 */
async function buildRecipeFixture(): Promise<string> {
  const recipeRoot = join(work, 'recipe');
  const apiRoot = join(work, 'children', 'api');
  const webRoot = join(work, 'children', 'web');

  await writeManifest(
    recipeRoot,
    `type: recipe
name: demo-app
version: 0.1.0

prompts:
  - workspace_name:
      type: string
      required: true
      description: Workspace name

composes:
  api: file:../children/api
  web: file:../children/web
`,
  );
  await writeFileEnsure(join(recipeRoot, 'README.md'), '# {{ workspace_name }}\n');

  await writeManifest(
    apiRoot,
    `type: component
name: api
version: 0.1.0

prompts:
  - port:
      type: integer
      default: 3000

hooks:
  post_render:
    - rename:
        from: server.ts
        to: src/server.ts
`,
  );
  await writeFileEnsure(join(apiRoot, 'server.ts'), 'listen({{ port }})');

  await writeManifest(
    webRoot,
    `type: component
name: web
version: 0.1.0

prompts:
  - framework:
      type: string
      default: react
`,
  );
  await writeFileEnsure(join(webRoot, 'config.ts'), 'framework={{ framework }}');

  return recipeRoot;
}

function recipePrompter(answers: {
  workspace_name: string;
  api: { port: number };
  web: { framework: string };
}): Prompter {
  let currentChild: 'api' | 'web' | null = null;
  return {
    note(_body, title) {
      if (title === 'Configuring "api"') currentChild = 'api';
      else if (title === 'Configuring "web"') currentChild = 'web';
    },
    async text(opts) {
      if (opts.message === 'Workspace name') return answers.workspace_name;
      if (currentChild === 'api' && opts.message === 'port') return String(answers.api.port);
      if (currentChild === 'web' && opts.message === 'framework') return answers.web.framework;
      throw new Error(`unexpected text prompt (current=${currentChild}): ${opts.message}`);
    },
    async confirm(opts) {
      throw new Error(`unexpected confirm prompt: ${opts.message}`);
    },
    async select(opts) {
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

/** Render a template into `out` via the real `hex new` path; return its lockfile. */
async function renderAndLock(
  templatePath: string,
  out: string,
  prompter: Prompter,
): Promise<Lockfile> {
  const bundle = await loadFromPath(templatePath);
  const ctx = await collectNewAnswers(bundle, prompter, { sources: [] });
  await executeNewRender(bundle, out, ctx, { force: false });
  const loaded = await readLockfileUpward(out);
  if (!loaded) throw new Error('lockfile not written by executeNewRender');
  return loaded.lockfile;
}

describe('reconstructPristine — round-trip', () => {
  it('reconstructs a recipe byte-identically (integrity clean)', async () => {
    const recipePath = await buildRecipeFixture();
    const out = join(work, 'out');
    const lockfile = await renderAndLock(
      recipePath,
      out,
      recipePrompter({
        workspace_name: 'demo',
        api: { port: 4000 },
        web: { framework: 'svelte' },
      }),
    );

    // The hook ran in the original render — recorded under its new path.
    expect(lockfile.files.map((f) => f.path)).toContain('api/src/server.ts');
    expect(lockfile.files.map((f) => f.path)).not.toContain('api/server.ts');

    const pristine = await reconstructPristine(lockfile, { targetDir: join(work, 'pristine') });

    // Byte-identical: every recorded hash matches, nothing missing/added.
    const integrity = await checkLockfileIntegrity(pristine, lockfile);
    expect(integrity).toEqual({ ok: true, modified: [], missing: [], added: [] });
  });

  it('reconstructs a standalone component byte-identically', async () => {
    const componentRoot = join(work, 'one-shot');
    await writeManifest(
      componentRoot,
      `type: component
name: one-shot
version: 1.0.0

prompts:
  - project_name:
      type: string
      required: true
`,
    );
    await writeFileEnsure(join(componentRoot, 'package.json'), '{"name":"{{ project_name }}"}\n');

    const prompter: Prompter = {
      async text(opts) {
        if (opts.message === 'project_name') return 'my-app';
        throw new Error(`unexpected text prompt: ${opts.message}`);
      },
      async confirm() {
        throw new Error('confirm not used');
      },
      async select() {
        throw new Error('select not used');
      },
      async multiselect() {
        throw new Error('multiselect not used');
      },
      async password() {
        throw new Error('password not used');
      },
    };

    const out = join(work, 'out');
    const lockfile = await renderAndLock(componentRoot, out, prompter);

    const pristine = await reconstructPristine(lockfile, { targetDir: join(work, 'pristine') });
    const integrity = await checkLockfileIntegrity(pristine, lockfile);
    expect(integrity.ok).toBe(true);
  });

  it('mkdtemps a fresh directory when no targetDir is given', async () => {
    const recipePath = await buildRecipeFixture();
    const out = join(work, 'out');
    const lockfile = await renderAndLock(
      recipePath,
      out,
      recipePrompter({
        workspace_name: 'demo',
        api: { port: 4000 },
        web: { framework: 'svelte' },
      }),
    );

    const pristine = await reconstructPristine(lockfile);
    expect(pristine).not.toBe(out);
    const integrity = await checkLockfileIntegrity(pristine, lockfile);
    expect(integrity.ok).toBe(true);
    await rm(pristine, { recursive: true, force: true });
  });
});

describe('reconstructPristine — unsupported source', () => {
  it('refuses a marketplace source', async () => {
    const lockfile: Lockfile = {
      schema_version: 1,
      root: {
        name: 'api-fastify',
        version: '1.0.0',
        type: 'component',
        source: { kind: 'marketplace', registry: 'https://registry.hex.dev/', name: 'api-fastify' },
      },
      children: [],
      answers: {},
      files: [],
    };
    await expect(reconstructPristine(lockfile, { targetDir: join(work, 'p') })).rejects.toThrow(
      PristineError,
    );
  });
});
