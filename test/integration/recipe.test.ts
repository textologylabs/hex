import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { checklistFromTasks, writeChecklist } from '../../src/core/checklist/index.js';
import type { Prompter } from '../../src/core/prompts/types.js';
import { runRecipePrompts } from '../../src/core/recipe/prompts.js';
import { renderRecipe } from '../../src/core/recipe/render.js';
import { resolveRecipe } from '../../src/core/recipe/resolve.js';
import { aggregateRecipeSetup } from '../../src/core/recipe/setup.js';
import { loadFromPath } from '../../src/core/sources/file-source.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-int-recipe-'));
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
 * Build a fixture recipe tree under `work`:
 *
 *   recipe (own setup tasks + 1 recipe-level prompt)
 *   ├── api  (component, has setup tasks, prompts: port)
 *   └── web  (component, no setup tasks, prompts: framework, references {{ api.port }})
 */
async function buildFixture(): Promise<string> {
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
    Workspace scaffolded. A few things to wire up:
  tasks:
    - id: install-deps
      title: Install workspace dependencies
      detail: npm install at the workspace root
`,
  );
  // Recipe root files reference recipe-level + child answers.
  await writeFileEnsure(
    join(recipeRoot, 'README.md'),
    `# {{ workspace_name }}

api on port {{ api.port }} | web on {{ web.framework }}
`,
  );
  await writeFileEnsure(
    join(recipeRoot, 'package.json'),
    `{
  "name": "{{ workspace_name }}",
  "private": true,
  "workspaces": ["api", "web"]
}
`,
  );

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
    - id: db-migrate
      title: Run the initial DB migration
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
  // Cross-child reference: web's template reads the api sibling's port.
  await writeFileEnsure(
    join(webRoot, 'config.ts'),
    'framework={{ framework }} api_port={{ api.port }}',
  );

  return recipeRoot;
}

function fixedPrompter(answers: {
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

describe('recipe pipeline — load → resolve → prompt → render → checklist', () => {
  it('walks the full pipeline end-to-end against a fixture recipe + 2 children', async () => {
    const recipePath = await buildFixture();

    // Step 1: load via loadFromPath
    const bundle = await loadFromPath(recipePath);
    expect(bundle.manifest.type).toBe('recipe');
    expect(bundle.manifest.name).toBe('demo-app');

    // Step 2: walk composes → resolveRecipe (file: source for speed)
    const resolved = await resolveRecipe(bundle, { config: { sources: [] } });
    expect([...resolved.children.keys()]).toEqual(['api', 'web']);
    expect(resolved.children.get('api')?.bundle.manifest.name).toBe('api');
    expect(resolved.children.get('web')?.bundle.manifest.name).toBe('web');

    // Step 3: prompt user (scripted)
    const answers = await runRecipePrompts(
      resolved,
      fixedPrompter({
        workspace_name: 'demo',
        api: { port: 4000 },
        web: { framework: 'svelte' },
      }),
    );
    expect(answers).toEqual({
      workspace_name: 'demo',
      api: { port: 4000 },
      web: { framework: 'svelte' },
    });

    // Step 4: render children into subdirs + recipe root
    const out = join(work, 'out');
    const renderResult = await renderRecipe(resolved, out, answers);

    // ── final file layout ─────────────────────────────────────────────
    // Children own disjoint subdirs.
    expect(existsSync(join(out, 'api', 'server.ts'))).toBe(true);
    expect(existsSync(join(out, 'web', 'config.ts'))).toBe(true);
    // Recipe owns root orchestration.
    expect(existsSync(join(out, 'README.md'))).toBe(true);
    expect(existsSync(join(out, 'package.json'))).toBe(true);
    // Each child rendered exactly its own tree — no cross-contamination.
    expect(existsSync(join(out, 'api', 'config.ts'))).toBe(false);
    expect(existsSync(join(out, 'web', 'server.ts'))).toBe(false);

    // ── content templating ────────────────────────────────────────────
    expect(await readFile(join(out, 'api', 'server.ts'), 'utf8')).toBe('listen(4000)');

    // ── child-of-recipe answers visible from root ─────────────────────
    // Root README references both api.port and web.framework — proves
    // child answers nest cleanly under the outer key and the recipe-root
    // render runs after children with full visibility.
    const readme = await readFile(join(out, 'README.md'), 'utf8');
    expect(readme).toContain('# demo');
    expect(readme).toContain('api on port 4000');
    expect(readme).toContain('web on svelte');

    // Root package.json embeds the recipe-level workspace_name.
    const pkg = JSON.parse(await readFile(join(out, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('demo');
    expect(pkg.workspaces).toEqual(['api', 'web']);

    // ── cross-child answer visibility ─────────────────────────────────
    // web's config.ts references the api sibling's port via {{ api.port }}.
    expect(await readFile(join(out, 'web', 'config.ts'), 'utf8')).toBe(
      'framework=svelte api_port=4000',
    );

    // Render result shape exposes per-child render data.
    expect(renderResult.children.get('api')?.subdir).toBe('api');
    expect(renderResult.children.get('web')?.subdir).toBe('web');
    expect(renderResult.recipe.written.sort()).toEqual(['README.md', 'package.json']);

    // ── checklist file written via M4 mechanism ───────────────────────
    // Aggregate setup tasks across the recipe tree (recipe + each child)
    // and write a single .hex/checklist.yaml. This is the wiring the CLI
    // command will adopt for recipe-mode `hex new`.
    const tasks = aggregateRecipeSetup(resolved);
    expect(tasks.map((t) => t.id)).toEqual([
      // recipe-level task — bare id
      'install-deps',
      // api's tasks — prefixed with the child key
      'api-env-file',
      'api-db-migrate',
    ]);
    const checklistPath = await writeChecklist(out, checklistFromTasks(tasks));
    expect(checklistPath).toBe(join(out, '.hex', 'checklist.yaml'));

    const onDisk = parseYaml(await readFile(checklistPath, 'utf8')) as {
      tasks: Array<{ id: string; status: string; title: string; detail?: string }>;
    };
    expect(onDisk.tasks.map((t) => t.id)).toEqual([
      'install-deps',
      'api-env-file',
      'api-db-migrate',
    ]);
    // All tasks land as `pending` — nobody has marked them done yet.
    expect(onDisk.tasks.every((t) => t.status === 'pending')).toBe(true);
    // Detail propagated for the one task that declared it.
    expect(onDisk.tasks.find((t) => t.id === 'api-env-file')?.detail).toBe('cp .env.example .env');
  });

  it('skips the checklist when neither recipe nor any child declares setup tasks', async () => {
    // Same fixture shape but with no setup tasks anywhere — the checklist
    // step is a no-op (caller writes nothing).
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

    const bundle = await loadFromPath(recipeRoot);
    const resolved = await resolveRecipe(bundle, { config: { sources: [] } });
    const out = join(work, 'out');
    await renderRecipe(resolved, out, {});

    const tasks = aggregateRecipeSetup(resolved);
    expect(tasks).toEqual([]);
    // Caller would skip writeChecklist when tasks is empty — assert the
    // file is absent so the contract is observable.
    expect(existsSync(join(out, '.hex', 'checklist.yaml'))).toBe(false);
  });
});
