import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRecipe } from '../../../src/core/recipe/resolve.js';
import { aggregateRecipeSetup } from '../../../src/core/recipe/setup.js';
import { loadFromPath } from '../../../src/core/sources/file-source.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-recipe-setup-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function writeManifest(rootPath: string, body: string): Promise<void> {
  const hexDir = join(rootPath, '.hex');
  await mkdir(hexDir, { recursive: true });
  await writeFile(join(hexDir, 'manifest.yaml'), body, 'utf8');
}

describe('aggregateRecipeSetup', () => {
  it('returns an empty list for a recipe with no setup and no children', async () => {
    const recipeRoot = join(work, 'recipe');
    await writeManifest(
      recipeRoot,
      `type: recipe
name: empty
version: 0.1.0
`,
    );
    const bundle = await loadFromPath(recipeRoot);
    const resolved = await resolveRecipe(bundle, { config: { sources: [] } });
    expect(aggregateRecipeSetup(resolved)).toEqual([]);
  });

  it('keeps recipe-level tasks bare and prefixes direct children with their key', async () => {
    const recipeRoot = join(work, 'recipe');
    const apiRoot = join(work, 'children', 'api');
    const uiRoot = join(work, 'children', 'ui');
    await writeManifest(
      recipeRoot,
      `type: recipe
name: demo
version: 0.1.0
composes:
  api: file:../children/api
  ui: file:../children/ui
setup:
  tasks:
    - id: install-deps
      title: Install workspace deps
`,
    );
    await writeManifest(
      apiRoot,
      `type: component
name: api
version: 0.1.0
setup:
  tasks:
    - id: env-file
      title: Create .env from example
      detail: cp .env.example .env
    - id: db-migrate
      title: Run initial DB migration
`,
    );
    await writeManifest(
      uiRoot,
      `type: component
name: ui
version: 0.1.0
`,
    );
    const bundle = await loadFromPath(recipeRoot);
    const resolved = await resolveRecipe(bundle, { config: { sources: [] } });
    const tasks = aggregateRecipeSetup(resolved);

    expect(tasks).toEqual([
      { id: 'install-deps', title: 'Install workspace deps' },
      { id: 'api-env-file', title: 'Create .env from example', detail: 'cp .env.example .env' },
      { id: 'api-db-migrate', title: 'Run initial DB migration' },
    ]);
  });

  it('recursively prefixes nested-recipe tasks with the full key path', async () => {
    const outerRoot = join(work, 'outer');
    const innerRoot = join(work, 'inner');
    const leafRoot = join(work, 'leaf');
    await writeManifest(
      outerRoot,
      `type: recipe
name: outer
version: 0.1.0
composes:
  inner: file:../inner
setup:
  tasks:
    - id: outer-task
      title: Outer task
`,
    );
    await writeManifest(
      innerRoot,
      `type: recipe
name: inner
version: 0.1.0
composes:
  leaf: file:../leaf
setup:
  tasks:
    - id: inner-task
      title: Inner task
`,
    );
    await writeManifest(
      leafRoot,
      `type: component
name: leaf
version: 0.1.0
setup:
  tasks:
    - id: leaf-task
      title: Leaf task
`,
    );
    const bundle = await loadFromPath(outerRoot);
    const resolved = await resolveRecipe(bundle, { config: { sources: [] } });
    const tasks = aggregateRecipeSetup(resolved);

    // Recipe-level tasks at every level get prefixed with their enclosing
    // key path; the outermost recipe's own tasks stay bare.
    expect(tasks.map((t) => t.id)).toEqual([
      'outer-task',
      'inner-inner-task',
      'inner-leaf-leaf-task',
    ]);
  });

  it('preserves declaration order across recipe + children', async () => {
    const recipeRoot = join(work, 'recipe');
    const aRoot = join(work, 'children', 'a');
    const bRoot = join(work, 'children', 'b');
    await writeManifest(
      recipeRoot,
      `type: recipe
name: demo
version: 0.1.0
composes:
  a: file:../children/a
  b: file:../children/b
setup:
  tasks:
    - id: r1
      title: r1
`,
    );
    await writeManifest(
      aRoot,
      `type: component
name: a
version: 0.1.0
setup:
  tasks:
    - id: t1
      title: t1
    - id: t2
      title: t2
`,
    );
    await writeManifest(
      bRoot,
      `type: component
name: b
version: 0.1.0
setup:
  tasks:
    - id: t1
      title: t1
`,
    );
    const bundle = await loadFromPath(recipeRoot);
    const resolved = await resolveRecipe(bundle, { config: { sources: [] } });
    const ids = aggregateRecipeSetup(resolved).map((t) => t.id);
    // Recipe → a → a → b. Same `t1` id used by a and b doesn't collide
    // because the prefix differs.
    expect(ids).toEqual(['r1', 'a-t1', 'a-t2', 'b-t1']);
  });
});
