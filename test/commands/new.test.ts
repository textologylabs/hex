import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  type NewRenderSummary,
  collectNewAnswers,
  executeNewRender,
  planPostRender,
} from '../../src/commands/new.js';
import { checklistFromTasks, writeChecklist } from '../../src/core/checklist/index.js';
import { lockfileSchema } from '../../src/core/lockfile/index.js';
import type { Prompter } from '../../src/core/prompts/types.js';
import { loadFromPath } from '../../src/core/sources/file-source.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-cmd-new-'));
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
 * Build a recipe + 2 children where the recipe and one child carry setup
 * tasks. Mirrors the structure of `test/integration/recipe.test.ts` so the
 * CLI wiring is exercised against the same shape the recipe engine tests
 * cover, just through `collectNewAnswers` + `executeNewRender`.
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

setup:
  message: |
    Workspace scaffolded.
  tasks:
    - id: install-deps
      title: Install workspace dependencies
      detail: npm install
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

setup:
  tasks:
    - id: env-file
      title: Create .env from example
      detail: cp .env.example .env
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

describe('hex new — recipe dispatch wiring', () => {
  it('drives a recipe through collect + render and aggregates setup tasks', async () => {
    const recipePath = await buildRecipeFixture();
    const bundle = await loadFromPath(recipePath);
    expect(bundle.manifest.type).toBe('recipe');

    const ctx = await collectNewAnswers(
      bundle,
      recipePrompter({
        workspace_name: 'demo',
        api: { port: 4000 },
        web: { framework: 'svelte' },
      }),
      { sources: [] },
    );

    // The recipe branch resolves children and produces a tree-shaped answers
    // object — recipe-level at root, children nested under their composes key.
    expect(ctx.resolved).toBeDefined();
    expect(ctx.resolved && [...ctx.resolved.children.keys()]).toEqual(['api', 'web']);
    expect(ctx.answers.workspace_name).toBe('demo');
    expect(ctx.answers.api).toEqual({ port: 4000 });
    expect(ctx.answers.web).toEqual({ framework: 'svelte' });

    const out = join(work, 'out');
    const summary = await executeNewRender(bundle, out, ctx, { force: false });

    // Children land in their subdirs; recipe owns the root file. Three writes
    // total: README.md (recipe), api/server.ts, web/config.ts.
    expect(summary.written).toBe(3);
    expect(summary.childCount).toBe(2);
    expect(existsSync(join(out, 'README.md'))).toBe(true);
    expect(existsSync(join(out, 'api', 'server.ts'))).toBe(true);
    expect(existsSync(join(out, 'web', 'config.ts'))).toBe(true);
    expect(await readFile(join(out, 'api', 'server.ts'), 'utf8')).toBe('listen(4000)');

    // Setup tasks aggregated across the tree: recipe-level bare id first,
    // then api's tasks prefixed with the child key. web has no tasks.
    expect(summary.tasks.map((t) => t.id)).toEqual(['install-deps', 'api-env-file']);
    expect(summary.setupMessage).toContain('Workspace scaffolded');

    // The .action() handler writes the checklist after executeNewRender —
    // assert the bytes round-trip through that same helper.
    await writeChecklist(out, checklistFromTasks(summary.tasks));
    const checklist = parseYaml(await readFile(join(out, '.hex', 'checklist.yaml'), 'utf8')) as {
      tasks: Array<{ id: string; status: string }>;
    };
    expect(checklist.tasks.map((t) => t.id)).toEqual(['install-deps', 'api-env-file']);
    expect(checklist.tasks.every((t) => t.status === 'pending')).toBe(true);
  });

  it('returns an empty task list for a recipe + children that declare no setup', async () => {
    const recipeRoot = join(work, 'recipe');
    const apiRoot = join(work, 'children', 'api');
    await writeManifest(
      recipeRoot,
      `type: recipe
name: empty
version: 0.1.0
composes:
  api: file:../children/api
`,
    );
    await writeFileEnsure(join(recipeRoot, 'README.md'), 'no setup');
    await writeManifest(
      apiRoot,
      `type: component
name: api
version: 0.1.0
`,
    );
    await writeFileEnsure(join(apiRoot, 'index.ts'), 'export {}');

    const bundle = await loadFromPath(recipeRoot);
    const ctx = await collectNewAnswers(bundle, recipePrompter({} as never), { sources: [] });
    const out = join(work, 'out');
    const summary = await executeNewRender(bundle, out, ctx, { force: false });

    expect(summary.tasks).toEqual([]);
    expect(summary.setupMessage).toBeUndefined();
    expect(summary.childCount).toBe(1);
    // The .action() would skip writeChecklist when tasks is empty — assert
    // executeNewRender itself does not produce the file.
    expect(existsSync(join(out, '.hex', 'checklist.yaml'))).toBe(false);
  });

  it('still handles a component bundle through the same helpers (no regression)', async () => {
    // Sanity: the existing component path lands flat answers, no childCount,
    // and surfaces the manifest's own setup.tasks unchanged.
    const componentRoot = join(work, 'one-shot');
    await writeManifest(
      componentRoot,
      `type: component
name: one-shot
version: 0.1.0

prompts:
  - project_name:
      type: string
      required: true

setup:
  message: Done.
  tasks:
    - id: install
      title: npm install
`,
    );
    await writeFileEnsure(join(componentRoot, 'package.json'), '{"name": "{{ project_name }}"}\n');

    const bundle = await loadFromPath(componentRoot);
    expect(bundle.manifest.type).toBe('component');

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
    const ctx = await collectNewAnswers(bundle, prompter, { sources: [] });
    expect(ctx.resolved).toBeUndefined();
    expect(ctx.answers).toEqual({ project_name: 'my-app' });

    const out = join(work, 'out');
    const summary = await executeNewRender(bundle, out, ctx, { force: false });
    expect(summary.childCount).toBe(0);
    expect(summary.written).toBe(1);
    expect(summary.tasks.map((t) => t.id)).toEqual(['install']);
    expect(summary.setupMessage).toBe('Done.');
    const pkg = JSON.parse(await readFile(join(out, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('my-app');
  });
});

describe('hex new — lockfile (M10.2)', () => {
  it('writes a schema-valid lockfile for a recipe matching the rendered tree', async () => {
    const recipePath = await buildRecipeFixture();
    const bundle = await loadFromPath(recipePath);
    const ctx = await collectNewAnswers(
      bundle,
      recipePrompter({
        workspace_name: 'demo',
        api: { port: 4000 },
        web: { framework: 'svelte' },
      }),
      { sources: [] },
    );

    const out = join(work, 'out');
    await executeNewRender(bundle, out, ctx, { force: false });

    const lockPath = join(out, '.hex', 'lockfile.yaml');
    expect(existsSync(lockPath)).toBe(true);

    // Parses cleanly through the schema — no malformed bytes were written.
    const lock = lockfileSchema.parse(parseYaml(await readFile(lockPath, 'utf8')));

    expect(lock.schema_version).toBe(1);
    expect(lock.root).toMatchObject({ name: 'demo-app', version: '0.1.0', type: 'recipe' });
    expect(lock.root.source.kind).toBe('file');

    // Immediate children, each with its composes key + stub flag.
    expect(lock.children.map((c) => c.key)).toEqual(['api', 'web']);
    expect(lock.children.find((c) => c.key === 'api')).toMatchObject({
      name: 'api',
      type: 'component',
      stub: false,
    });

    // Answers tree is captured verbatim.
    expect(lock.answers).toEqual(ctx.answers);

    // The file-hash table covers the whole rendered tree and excludes `.hex/`.
    expect(lock.files.map((f) => f.path).sort()).toEqual([
      'README.md',
      'api/server.ts',
      'web/config.ts',
    ]);
    expect(lock.files.some((f) => f.path.startsWith('.hex/'))).toBe(false);

    // Every recorded hash matches the bytes actually on disk.
    for (const entry of lock.files) {
      const bytes = await readFile(join(out, entry.path));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
    }
  });

  it('writes a schema-valid lockfile for a standalone component (no children)', async () => {
    const componentRoot = join(work, 'one-shot');
    await writeManifest(
      componentRoot,
      `type: component
name: one-shot
version: 1.2.3

prompts:
  - project_name:
      type: string
      required: true
`,
    );
    await writeFileEnsure(join(componentRoot, 'package.json'), '{"name": "{{ project_name }}"}\n');

    const bundle = await loadFromPath(componentRoot);
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
    const ctx = await collectNewAnswers(bundle, prompter, { sources: [] });

    const out = join(work, 'out');
    await executeNewRender(bundle, out, ctx, { force: false });

    const lock = lockfileSchema.parse(
      parseYaml(await readFile(join(out, '.hex', 'lockfile.yaml'), 'utf8')),
    );
    expect(lock.root).toMatchObject({ name: 'one-shot', version: '1.2.3', type: 'component' });
    expect(lock.children).toEqual([]);
    expect(lock.answers).toEqual({ project_name: 'my-app' });
    expect(lock.files.map((f) => f.path)).toEqual(['package.json']);

    const bytes = await readFile(join(out, 'package.json'));
    expect(lock.files[0]?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('records a nested recipe tree recursively', async () => {
    // root recipe → composes a `platform` recipe → composes an `api` component.
    const recipeRoot = join(work, 'recipe');
    const platformRoot = join(work, 'platform');
    const apiRoot = join(work, 'api');

    await writeManifest(
      recipeRoot,
      `type: recipe
name: nested-root
version: 0.1.0
composes:
  platform: file:../platform
`,
    );
    await writeFileEnsure(join(recipeRoot, 'README.md'), '# root\n');

    await writeManifest(
      platformRoot,
      `type: recipe
name: platform
version: 0.2.0
composes:
  api: file:../api
`,
    );
    await writeFileEnsure(join(platformRoot, 'infra.ts'), 'export const infra = true;\n');

    await writeManifest(
      apiRoot,
      `type: component
name: api
version: 0.3.0
`,
    );
    await writeFileEnsure(join(apiRoot, 'server.ts'), 'export const server = true;\n');

    const bundle = await loadFromPath(recipeRoot);
    const ctx = await collectNewAnswers(bundle, recipePrompter({} as never), { sources: [] });
    const out = join(work, 'out');
    await executeNewRender(bundle, out, ctx, { force: false });

    const lock = lockfileSchema.parse(
      parseYaml(await readFile(join(out, '.hex', 'lockfile.yaml'), 'utf8')),
    );

    // The recipe child carries its own descendants.
    expect(lock.children).toHaveLength(1);
    const platform = lock.children[0];
    expect(platform).toMatchObject({ key: 'platform', name: 'platform', type: 'recipe' });
    expect(platform?.children).toHaveLength(1);
    expect(platform?.children?.[0]).toMatchObject({
      key: 'api',
      name: 'api',
      version: '0.3.0',
      type: 'component',
    });
    // The leaf component carries no `children` key.
    expect(platform?.children?.[0]?.children).toBeUndefined();

    // The flat file table still covers the whole nested tree.
    expect(lock.files.map((f) => f.path).sort()).toEqual([
      'README.md',
      'platform/api/server.ts',
      'platform/infra.ts',
    ]);
  });
});

describe('planPostRender', () => {
  function summary(over: Partial<NewRenderSummary> = {}): NewRenderSummary {
    return {
      written: 1,
      renamed: 0,
      deleted: 0,
      childCount: 0,
      tasks: [],
      ...over,
    };
  }

  it('returns no-tasks when the template shipped none', () => {
    expect(planPostRender(summary(), { isTTY: true, setup: true })).toEqual({ kind: 'no-tasks' });
  });

  it('returns has-tasks/interactive when stdout is a TTY and --setup is on', () => {
    const plan = planPostRender(summary({ tasks: [{ id: 'a', title: 'A' }] }), {
      isTTY: true,
      setup: true,
    });
    expect(plan.kind).toBe('has-tasks');
    if (plan.kind === 'has-tasks') {
      expect(plan.interactive).toBe(true);
      expect(plan.pendingCount).toBe(1);
      expect(plan.initial.tasks).toHaveLength(1);
    }
  });

  it('returns has-tasks/non-interactive when --setup is off, even on a TTY', () => {
    const plan = planPostRender(summary({ tasks: [{ id: 'a', title: 'A' }] }), {
      isTTY: true,
      setup: false,
    });
    expect(plan.kind === 'has-tasks' && plan.interactive).toBe(false);
  });

  it('returns has-tasks/non-interactive when not on a TTY, even with --setup on', () => {
    const plan = planPostRender(summary({ tasks: [{ id: 'a', title: 'A' }] }), {
      isTTY: false,
      setup: true,
    });
    expect(plan.kind === 'has-tasks' && plan.interactive).toBe(false);
  });

  it('propagates setupMessage when present, omits it when absent', () => {
    const withMsg = planPostRender(
      summary({ tasks: [{ id: 'a', title: 'A' }], setupMessage: 'hello' }),
      { isTTY: true, setup: true },
    );
    expect(withMsg.kind === 'has-tasks' && withMsg.setupMessage).toBe('hello');

    const without = planPostRender(summary({ tasks: [{ id: 'a', title: 'A' }] }), {
      isTTY: true,
      setup: true,
    });
    expect(without.kind === 'has-tasks' && without.setupMessage).toBeUndefined();
  });
});
