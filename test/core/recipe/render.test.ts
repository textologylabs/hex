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
