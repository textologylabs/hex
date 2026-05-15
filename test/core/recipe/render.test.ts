import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Answers } from '../../../src/core/prompts/types.js';
import { renderRecipe } from '../../../src/core/recipe/render.js';
import { resolveRecipe } from '../../../src/core/recipe/resolve.js';
import { RenderError } from '../../../src/core/render/engine.js';
import { loadFromPath } from '../../../src/core/sources/file-source.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-recipe-render-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function writeFileEnsure(path: string, body: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body, 'utf8');
}

async function writeManifest(rootPath: string, manifest: string): Promise<void> {
  const hexDir = join(rootPath, '.hex');
  await mkdir(hexDir, { recursive: true });
  await writeFile(join(hexDir, 'manifest.yaml'), manifest, 'utf8');
}

async function loadResolved(recipePath: string) {
  const bundle = await loadFromPath(recipePath);
  return resolveRecipe(bundle, { config: { sources: [] } });
}

async function buildSimpleRecipe(answers: Answers = {}): Promise<{
  out: string;
  recipeRoot: string;
  apiRoot: string;
  uiRoot: string;
  result: Awaited<ReturnType<typeof renderRecipe>>;
}> {
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
`,
  );
  await writeManifest(
    apiRoot,
    `type: component
name: api
version: 0.1.0
`,
  );
  await writeFileEnsure(join(apiRoot, 'server.ts'), '// api on {{ port }}');
  await writeManifest(
    uiRoot,
    `type: component
name: ui
version: 0.1.0
`,
  );
  await writeFileEnsure(join(uiRoot, 'app.tsx'), '// ui ({{ framework }})');

  const resolved = await loadResolved(recipeRoot);
  const out = join(work, 'out');
  const result = await renderRecipe(resolved, out, answers);
  return { out, recipeRoot, apiRoot, uiRoot, result };
}

describe('renderRecipe — default subdir layout', () => {
  it('renders each child into <output>/<key>/ keyed by composes block', async () => {
    const { out, result } = await buildSimpleRecipe({
      api: { port: 4000 },
      ui: { framework: 'react' },
    });

    expect([...result.children.keys()]).toEqual(['api', 'ui']);
    expect(result.children.get('api')?.subdir).toBe('api');
    expect(result.children.get('ui')?.subdir).toBe('ui');

    expect(await readFile(join(out, 'api', 'server.ts'), 'utf8')).toBe('// api on 4000');
    expect(await readFile(join(out, 'ui', 'app.tsx'), 'utf8')).toBe('// ui (react)');
  });

  it('rejects a non-empty outer outputPath without --force', async () => {
    const recipeRoot = join(work, 'recipe');
    await writeManifest(
      recipeRoot,
      `type: recipe
name: demo
version: 0.1.0
`,
    );
    const resolved = await loadResolved(recipeRoot);
    const out = join(work, 'out');
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'preexisting.txt'), 'x', 'utf8');

    await expect(renderRecipe(resolved, out, {})).rejects.toBeInstanceOf(RenderError);
  });
});

describe('renderRecipe — subdir override', () => {
  it("uses answers['<key>_dir'] when present", async () => {
    const { out, result } = await buildSimpleRecipe({
      api_dir: 'apps/api',
      ui_dir: 'apps/ui',
      api: { port: 3000 },
      ui: { framework: 'svelte' },
    });

    expect(result.children.get('api')?.subdir).toBe('apps/api');
    expect(result.children.get('ui')?.subdir).toBe('apps/ui');
    expect(existsSync(join(out, 'apps', 'api', 'server.ts'))).toBe(true);
    expect(existsSync(join(out, 'apps', 'ui', 'app.tsx'))).toBe(true);
    // Default-named dirs should not exist.
    expect(existsSync(join(out, 'api'))).toBe(false);
    expect(existsSync(join(out, 'ui'))).toBe(false);
  });

  it('falls back to the key when the override is an empty string', async () => {
    const { result } = await buildSimpleRecipe({
      api_dir: '   ',
      api: { port: 1 },
      ui: { framework: 'react' },
    });
    expect(result.children.get('api')?.subdir).toBe('api');
  });

  it('rejects an absolute subdir override', async () => {
    const recipeRoot = join(work, 'recipe');
    const apiRoot = join(work, 'children', 'api');
    await writeManifest(
      recipeRoot,
      `type: recipe
name: demo
version: 0.1.0
composes:
  api: file:../children/api
`,
    );
    await writeManifest(
      apiRoot,
      `type: component
name: api
version: 0.1.0
`,
    );
    const resolved = await loadResolved(recipeRoot);
    const out = join(work, 'out');

    await expect(renderRecipe(resolved, out, { api_dir: '/etc/passwd' })).rejects.toThrow(
      /must not be absolute/,
    );
  });

  it('rejects a subdir containing ".."', async () => {
    const recipeRoot = join(work, 'recipe');
    const apiRoot = join(work, 'children', 'api');
    await writeManifest(
      recipeRoot,
      `type: recipe
name: demo
version: 0.1.0
composes:
  api: file:../children/api
`,
    );
    await writeManifest(
      apiRoot,
      `type: component
name: api
version: 0.1.0
`,
    );
    const resolved = await loadResolved(recipeRoot);
    const out = join(work, 'out');

    await expect(renderRecipe(resolved, out, { api_dir: '../escape' })).rejects.toThrow(
      /forbidden path segment/,
    );
  });

  it('rejects two children resolving to the same subdir', async () => {
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
`,
    );
    await writeManifest(
      apiRoot,
      `type: component
name: api
version: 0.1.0
`,
    );
    await writeManifest(
      uiRoot,
      `type: component
name: ui
version: 0.1.0
`,
    );
    const resolved = await loadResolved(recipeRoot);
    const out = join(work, 'out');

    await expect(
      renderRecipe(resolved, out, { api_dir: 'shared', ui_dir: 'shared' }),
    ).rejects.toThrow(/already used by child "api"/);
  });
});

describe('renderRecipe — child render scope', () => {
  it("flattens the child's namespace at root and exposes recipe + sibling answers", async () => {
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
`,
    );
    await writeManifest(
      apiRoot,
      `type: component
name: api
version: 0.1.0
`,
    );
    await writeFileEnsure(join(apiRoot, 'config.ts'), 'app={{ project_name }} port={{ port }}');
    await writeManifest(
      uiRoot,
      `type: component
name: ui
version: 0.1.0
`,
    );
    // ui renders second — should be able to see the api sibling's nested answers.
    await writeFileEnsure(
      join(uiRoot, 'config.ts'),
      'framework={{ framework }} api_port={{ api.port }}',
    );
    const resolved = await loadResolved(recipeRoot);
    const out = join(work, 'out');
    await renderRecipe(resolved, out, {
      project_name: 'my-app',
      api: { port: 4000 },
      ui: { framework: 'svelte' },
    });
    expect(await readFile(join(out, 'api', 'config.ts'), 'utf8')).toBe('app=my-app port=4000');
    expect(await readFile(join(out, 'ui', 'config.ts'), 'utf8')).toBe(
      'framework=svelte api_port=4000',
    );
  });
});

describe('renderRecipe — recipe root rendering', () => {
  it('renders the recipe bundle into outputPath after children, with child answers in scope', async () => {
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
`,
    );
    // Recipe owns the root-level orchestration files.
    await writeFileEnsure(
      join(recipeRoot, 'package.json'),
      '{ "name": "{{ project_name }}", "workspaces": ["{{ api_dir | default("api") }}"] }',
    );
    await writeFileEnsure(
      join(recipeRoot, 'docker-compose.yml'),
      'services:\n  api:\n    ports: ["{{ api.port }}:{{ api.port }}"]',
    );
    await writeManifest(
      apiRoot,
      `type: component
name: api
version: 0.1.0
`,
    );
    await writeFileEnsure(join(apiRoot, 'server.ts'), '// api');
    await writeManifest(
      uiRoot,
      `type: component
name: ui
version: 0.1.0
`,
    );
    await writeFileEnsure(join(uiRoot, 'app.tsx'), '// ui');

    const resolved = await loadResolved(recipeRoot);
    const out = join(work, 'out');
    const result = await renderRecipe(resolved, out, {
      project_name: 'my-app',
      api: { port: 4000 },
      ui: { framework: 'react' },
    });

    expect(result.recipe.written.sort()).toEqual(['docker-compose.yml', 'package.json']);
    expect(await readFile(join(out, 'package.json'), 'utf8')).toBe(
      '{ "name": "my-app", "workspaces": ["api"] }',
    );
    expect(await readFile(join(out, 'docker-compose.yml'), 'utf8')).toBe(
      'services:\n  api:\n    ports: ["4000:4000"]',
    );
    // Children still rendered into their subdirs.
    expect(await readFile(join(out, 'api', 'server.ts'), 'utf8')).toBe('// api');
    expect(await readFile(join(out, 'ui', 'app.tsx'), 'utf8')).toBe('// ui');
  });

  it("a recipe template under a child's subdir is skipped (collision protection)", async () => {
    const recipeRoot = join(work, 'recipe');
    const apiRoot = join(work, 'children', 'api');
    await writeManifest(
      recipeRoot,
      `type: recipe
name: demo
version: 0.1.0
composes:
  api: file:../children/api
`,
    );
    // Recipe template tree contains an `api/` directory. The api child also
    // renders into `<out>/api/`. The recipe walk should skip its own `api/`
    // tree to keep from clobbering the child's output.
    await writeFileEnsure(join(recipeRoot, 'README.md'), '# {{ project_name }}');
    await writeFileEnsure(join(recipeRoot, 'api', 'leaked.ts'), 'should NOT be emitted');
    await writeManifest(
      apiRoot,
      `type: component
name: api
version: 0.1.0
`,
    );
    await writeFileEnsure(join(apiRoot, 'real.ts'), 'child file');

    const resolved = await loadResolved(recipeRoot);
    const out = join(work, 'out');
    const result = await renderRecipe(resolved, out, { project_name: 'demo' });

    expect(result.recipe.written).toEqual(['README.md']);
    expect(existsSync(join(out, 'api', 'leaked.ts'))).toBe(false);
    expect(await readFile(join(out, 'api', 'real.ts'), 'utf8')).toBe('child file');
  });

  it("a recipe-root file gated by a child's presence renders or is skipped via include rules", async () => {
    const recipeRoot = join(work, 'recipe');
    const apiRoot = join(work, 'children', 'api');
    await writeManifest(
      recipeRoot,
      `type: recipe
name: demo
version: 0.1.0
composes:
  api: file:../children/api
include:
  - { path: docker-compose.yml, when: 'api.containerize' }
`,
    );
    await writeFileEnsure(join(recipeRoot, 'README.md'), '# {{ project_name }}');
    await writeFileEnsure(join(recipeRoot, 'docker-compose.yml'), 'services: { api: {} }');
    await writeManifest(
      apiRoot,
      `type: component
name: api
version: 0.1.0
`,
    );

    const resolved = await loadResolved(recipeRoot);
    const out = join(work, 'out');

    // Case 1: child says don't containerize → recipe-root docker-compose.yml is filtered out.
    const result1 = await renderRecipe(resolved, out, {
      project_name: 'demo',
      api: { containerize: false },
    });
    expect(result1.recipe.written.sort()).toEqual(['README.md']);
    expect(existsSync(join(out, 'docker-compose.yml'))).toBe(false);

    // Case 2: containerize true → docker-compose.yml is emitted. Use --force to overwrite.
    await rm(out, { recursive: true, force: true });
    const result2 = await renderRecipe(
      resolved,
      out,
      { project_name: 'demo', api: { containerize: true } },
      { force: true },
    );
    expect(result2.recipe.written.sort()).toEqual(['README.md', 'docker-compose.yml'].sort());
    expect(existsSync(join(out, 'docker-compose.yml'))).toBe(true);
  });

  it("recipe-root render runs after children — child output is observable when the recipe's hook fires", async () => {
    // Recipe declares a delete hook against api/scratch.txt. The api child
    // wrote that file. If the recipe ran BEFORE the child, the hook would
    // fail (target not found). Test passes ⇒ recipe ran after.
    const recipeRoot = join(work, 'recipe');
    const apiRoot = join(work, 'children', 'api');
    await writeManifest(
      recipeRoot,
      `type: recipe
name: demo
version: 0.1.0
composes:
  api: file:../children/api
hooks:
  post_render:
    - delete:
        path: api/scratch.txt
`,
    );
    await writeFileEnsure(join(recipeRoot, 'README.md'), '# demo');
    await writeManifest(
      apiRoot,
      `type: component
name: api
version: 0.1.0
`,
    );
    await writeFileEnsure(join(apiRoot, 'scratch.txt'), 'temp');
    await writeFileEnsure(join(apiRoot, 'real.ts'), 'kept');

    const resolved = await loadResolved(recipeRoot);
    const out = join(work, 'out');
    const result = await renderRecipe(resolved, out, {});

    expect(result.recipe.deleted).toEqual(['api/scratch.txt']);
    expect(existsSync(join(out, 'api', 'scratch.txt'))).toBe(false);
    expect(await readFile(join(out, 'api', 'real.ts'), 'utf8')).toBe('kept');
  });
});

describe('renderRecipe — hook & include scoping', () => {
  it("a child's post_render delete hook only touches its own subtree", async () => {
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
`,
    );
    await writeManifest(
      apiRoot,
      `type: component
name: api
version: 0.1.0
hooks:
  post_render:
    - delete:
        path: scratch.txt
`,
    );
    await writeFileEnsure(join(apiRoot, 'scratch.txt'), 'temp');
    await writeFileEnsure(join(apiRoot, 'kept.ts'), 'kept');
    await writeManifest(
      uiRoot,
      `type: component
name: ui
version: 0.1.0
`,
    );
    // Both children declare a file at the same relative path, but they live
    // in disjoint subtrees so no collision is possible.
    await writeFileEnsure(join(uiRoot, 'scratch.txt'), 'ui-keep');

    const resolved = await loadResolved(recipeRoot);
    const out = join(work, 'out');
    const result = await renderRecipe(resolved, out, {});

    // api child's delete hook ran against api/scratch.txt only.
    expect(result.children.get('api')?.deleted).toEqual(['scratch.txt']);
    expect(existsSync(join(out, 'api', 'scratch.txt'))).toBe(false);
    expect(existsSync(join(out, 'api', 'kept.ts'))).toBe(true);
    // ui's identically-named file untouched — proves hook scoping.
    expect(await readFile(join(out, 'ui', 'scratch.txt'), 'utf8')).toBe('ui-keep');
  });

  it("a child's include rule only filters its own subtree", async () => {
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
`,
    );
    // api gates Dockerfile on containerize; ui has its own Dockerfile, no rule.
    await writeManifest(
      apiRoot,
      `type: component
name: api
version: 0.1.0
include:
  - { path: Dockerfile, when: 'containerize' }
`,
    );
    await writeFileEnsure(join(apiRoot, 'Dockerfile'), 'api docker');
    await writeFileEnsure(join(apiRoot, 'main.ts'), 'main');
    await writeManifest(
      uiRoot,
      `type: component
name: ui
version: 0.1.0
`,
    );
    await writeFileEnsure(join(uiRoot, 'Dockerfile'), 'ui docker');

    const resolved = await loadResolved(recipeRoot);
    const out = join(work, 'out');
    await renderRecipe(resolved, out, { containerize: false });

    // api's Dockerfile filtered out by its own include rule.
    expect(existsSync(join(out, 'api', 'Dockerfile'))).toBe(false);
    expect(existsSync(join(out, 'api', 'main.ts'))).toBe(true);
    // ui's Dockerfile unaffected — its manifest has no include rule.
    expect(await readFile(join(out, 'ui', 'Dockerfile'), 'utf8')).toBe('ui docker');
  });
});

describe('renderRecipe — nested recipes', () => {
  it('renders a 2-level recipe (outer → inner-recipe → leaf) into nested subdirs', async () => {
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
`,
    );
    await writeFileEnsure(join(outerRoot, 'README.md'), 'outer readme: {{ project_name }}');
    await writeManifest(
      innerRoot,
      `type: recipe
name: inner
version: 0.1.0
composes:
  leaf: file:../leaf
`,
    );
    await writeFileEnsure(join(innerRoot, 'inner.txt'), 'inner says hi');
    await writeManifest(
      leafRoot,
      `type: component
name: leaf
version: 0.1.0
`,
    );
    await writeFileEnsure(join(leafRoot, 'leaf.ts'), 'leaf with {{ flavour }}');

    const resolved = await loadResolved(outerRoot);
    const out = join(work, 'out');
    const result = await renderRecipe(resolved, out, {
      project_name: 'demo',
      inner: { leaf: { flavour: 'vanilla' } },
    });

    // outer recipe-root output
    expect(await readFile(join(out, 'README.md'), 'utf8')).toBe('outer readme: demo');
    // inner recipe rendered into <out>/inner/
    expect(await readFile(join(out, 'inner', 'inner.txt'), 'utf8')).toBe('inner says hi');
    // leaf component rendered into <out>/inner/leaf/
    expect(await readFile(join(out, 'inner', 'leaf', 'leaf.ts'), 'utf8')).toBe('leaf with vanilla');

    // result shape: outer.children.inner.nestedRecipe surfaces inner's tree
    const innerChild = result.children.get('inner');
    expect(innerChild?.subdir).toBe('inner');
    expect(innerChild?.nestedRecipe).toBeDefined();
    const leafChild = innerChild?.nestedRecipe?.children.get('leaf');
    expect(leafChild?.subdir).toBe('leaf');
  });

  it("an outer recipe-root template can reference a nested-leaf's answer via answers.<inner>.<leaf>.<prompt>", async () => {
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
`,
    );
    // outer root README pulls leaf's port out of two levels of nesting
    await writeFileEnsure(join(outerRoot, 'README.md'), 'inner-leaf port = {{ inner.leaf.port }}');
    await writeManifest(
      innerRoot,
      `type: recipe
name: inner
version: 0.1.0
composes:
  leaf: file:../leaf
`,
    );
    await writeManifest(
      leafRoot,
      `type: component
name: leaf
version: 0.1.0
`,
    );
    await writeFileEnsure(join(leafRoot, 'config.ts'), 'port {{ port }}');

    const resolved = await loadResolved(outerRoot);
    const out = join(work, 'out');
    await renderRecipe(resolved, out, { inner: { leaf: { port: 8080 } } });

    expect(await readFile(join(out, 'README.md'), 'utf8')).toBe('inner-leaf port = 8080');
    expect(await readFile(join(out, 'inner', 'leaf', 'config.ts'), 'utf8')).toBe('port 8080');
  });
});

describe('renderRecipe — provides / consumes wiring (M6.4)', () => {
  it('exposes a sibling-provided value to a consuming child via `provided.*`', async () => {
    const recipeRoot = join(work, 'recipe');
    const dbRoot = join(work, 'children', 'db');
    const apiRoot = join(work, 'children', 'api');
    await writeManifest(
      recipeRoot,
      `type: recipe
name: demo
version: 0.1.0
composes:
  db: file:../children/db
  api: file:../children/api
`,
    );
    await writeManifest(
      dbRoot,
      `type: component
name: pg
version: 0.1.0
kind: db
provides:
  DB_URL: "postgres://{{ host }}:{{ port }}/{{ database }}"
`,
    );
    await writeManifest(
      apiRoot,
      `type: component
name: api
version: 0.1.0
kind: api
consumes:
  - DB_URL
`,
    );
    await writeFileEnsure(join(apiRoot, '.env.template'), 'DATABASE_URL={{ provided.DB_URL }}');

    const resolved = await loadResolved(recipeRoot);
    const out = join(work, 'out');
    await renderRecipe(resolved, out, {
      db: { host: 'pg.local', port: 5432, database: 'app' },
    });

    expect(await readFile(join(out, 'api', '.env.template'), 'utf8')).toBe(
      'DATABASE_URL=postgres://pg.local:5432/app',
    );
  });

  it('makes `provided.*` available to the recipe-root render too', async () => {
    const recipeRoot = join(work, 'recipe');
    const dbRoot = join(work, 'children', 'db');
    await writeManifest(
      recipeRoot,
      `type: recipe
name: demo
version: 0.1.0
composes:
  db: file:../children/db
`,
    );
    await writeManifest(
      dbRoot,
      `type: component
name: pg
version: 0.1.0
kind: db
provides:
  DB_URL: "postgres://{{ host }}:{{ port }}/{{ database }}"
`,
    );
    await writeFileEnsure(join(recipeRoot, 'docker-compose.yml'), 'url: {{ provided.DB_URL }}');

    const resolved = await loadResolved(recipeRoot);
    const out = join(work, 'out');
    await renderRecipe(resolved, out, {
      db: { host: 'pg.local', port: 5432, database: 'app' },
    });

    expect(await readFile(join(out, 'docker-compose.yml'), 'utf8')).toBe(
      'url: postgres://pg.local:5432/app',
    );
  });

  it('treats array-form `provides` as bare declarations (empty string under `provided.*`)', async () => {
    const recipeRoot = join(work, 'recipe');
    const dbRoot = join(work, 'children', 'db');
    const apiRoot = join(work, 'children', 'api');
    await writeManifest(
      recipeRoot,
      `type: recipe
name: demo
version: 0.1.0
composes:
  db: file:../children/db
  api: file:../children/api
`,
    );
    await writeManifest(
      dbRoot,
      `type: component
name: pg
version: 0.1.0
kind: db
provides:
  - DB_URL
`,
    );
    await writeManifest(
      apiRoot,
      `type: component
name: api
version: 0.1.0
kind: api
consumes:
  - DB_URL
`,
    );
    await writeFileEnsure(join(apiRoot, '.env.template'), 'URL=[{{ provided.DB_URL }}]');

    const resolved = await loadResolved(recipeRoot);
    const out = join(work, 'out');
    await renderRecipe(resolved, out, {});

    expect(await readFile(join(out, 'api', '.env.template'), 'utf8')).toBe('URL=[]');
  });

  it('does not leak `provided` across recipe boundaries', async () => {
    // Outer recipe has a db component providing DB_URL. Inner recipe (a
    // sibling) has its own api child consuming DB_URL. The inner-level
    // `provided` map is built from inner siblings only, so DB_URL is not
    // visible inside the inner recipe — the api template renders empty.
    const outerRoot = join(work, 'outer');
    const dbRoot = join(work, 'db');
    const innerRoot = join(work, 'inner');
    const apiRoot = join(work, 'inner-api');
    await writeManifest(
      outerRoot,
      `type: recipe
name: outer
version: 0.1.0
composes:
  db: file:../db
  inner: file:../inner
`,
    );
    await writeManifest(
      dbRoot,
      `type: component
name: pg
version: 0.1.0
kind: db
provides:
  DB_URL: "postgres://localhost"
`,
    );
    await writeManifest(
      innerRoot,
      `type: recipe
name: inner
version: 0.1.0
composes:
  api: file:../inner-api
`,
    );
    await writeManifest(
      apiRoot,
      `type: component
name: api
version: 0.1.0
kind: api
`,
    );
    await writeFileEnsure(join(apiRoot, '.env.template'), 'URL=[{{ provided.DB_URL }}]');

    const resolved = await loadResolved(outerRoot);
    const out = join(work, 'out');
    await renderRecipe(resolved, out, {});

    expect(await readFile(join(out, 'inner', 'api', '.env.template'), 'utf8')).toBe('URL=[]');
  });
});

describe('renderRecipe — stub_enabled in child scope (M8.2)', () => {
  async function buildStubRecipe(stub: boolean): Promise<string> {
    const recipeRoot = join(work, 'recipe');
    const dbRoot = join(work, 'children', 'db');
    await writeManifest(
      recipeRoot,
      `type: recipe
name: demo
version: 0.1.0
composes:
  db:
    component: file:../children/db
${stub ? '    stub: true\n' : ''}`,
    );
    await writeManifest(
      dbRoot,
      `type: component
name: db-postgres
version: 2.0.0
kind: db
stub:
  engine: pg-mem
`,
    );
    await writeFileEnsure(join(dbRoot, 'mode.txt'), 'stub={{ stub_enabled }}');

    const resolved = await loadResolved(recipeRoot);
    const out = join(work, 'out');
    await renderRecipe(resolved, out, {});
    return readFile(join(out, 'db', 'mode.txt'), 'utf8');
  }

  it('exposes stub_enabled=true to a stubbed child', async () => {
    expect(await buildStubRecipe(true)).toBe('stub=true');
  });

  it('exposes stub_enabled=false to a non-stubbed child', async () => {
    expect(await buildStubRecipe(false)).toBe('stub=false');
  });
});

describe('renderRecipe — out-of-process stub engine dedup (M8.3)', () => {
  async function buildWiremockRecipe(secondChildStub: boolean): Promise<string> {
    const recipeRoot = join(work, 'recipe');
    const apiRoot = join(work, 'children', 'api');
    const payRoot = join(work, 'children', 'pay');
    await writeManifest(
      recipeRoot,
      `type: recipe
name: demo
version: 0.1.0
composes:
  api:
    component: file:../children/api
    stub: true
  pay:
    component: file:../children/pay
${secondChildStub ? '    stub: true\n' : ''}`,
    );
    // Recipe-root docker-compose template iterates the deduped service list.
    await writeFileEnsure(
      join(recipeRoot, 'docker-compose.yml'),
      `services:
{% for svc in stub_services %}  {{ svc.engine }}:
    ports: ["{{ svc.port }}:{{ svc.port }}"]
{% endfor %}`,
    );
    for (const [root, name] of [
      [apiRoot, 'api-stub'],
      [payRoot, 'pay-stub'],
    ] as const) {
      await writeManifest(
        root,
        `type: component
name: ${name}
version: 1.0.0
stub:
  engine: wiremock
`,
      );
      await writeFileEnsure(
        join(root, 'endpoint.txt'),
        'mock={{ provided.STUB_WIREMOCK_HOST }}:{{ provided.STUB_WIREMOCK_PORT }}',
      );
    }

    const resolved = await loadResolved(recipeRoot);
    const out = join(work, 'out');
    await renderRecipe(resolved, out, {});
    return out;
  }

  it('emits one shared wiremock service for two children stubbing the same engine', async () => {
    const out = await buildWiremockRecipe(true);
    const compose = await readFile(join(out, 'docker-compose.yml'), 'utf8');
    expect(compose.match(/wiremock:/g) ?? []).toHaveLength(1);
    expect(compose).toContain('ports: ["8080:8080"]');
  });

  it('wires both stubbed children to the shared service coordinates', async () => {
    const out = await buildWiremockRecipe(true);
    expect(await readFile(join(out, 'api', 'endpoint.txt'), 'utf8')).toBe('mock=wiremock:8080');
    expect(await readFile(join(out, 'pay', 'endpoint.txt'), 'utf8')).toBe('mock=wiremock:8080');
  });

  it('a non-stubbed sibling adds no second service (only api stubbed)', async () => {
    const out = await buildWiremockRecipe(false);
    const compose = await readFile(join(out, 'docker-compose.yml'), 'utf8');
    expect(compose.match(/wiremock:/g) ?? []).toHaveLength(1);
  });
});
