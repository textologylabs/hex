import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Prompter } from '../../src/core/prompts/types.js';
import { runRecipePrompts } from '../../src/core/recipe/prompts.js';
import { renderRecipe } from '../../src/core/recipe/render.js';
import { resolveRecipe } from '../../src/core/recipe/resolve.js';
import { loadFromPath } from '../../src/core/sources/file-source.js';

// Absolute path to the M8.6 reference component shipped in-repo. The
// recipe composes it via a `file:` spec so this test exercises the real
// stubbable component, not a synthetic fixture.
const DB_POSTGRES = resolve(dirname(fileURLToPath(import.meta.url)), '../../templates/db-postgres');

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-int-stub-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

/**
 * Write a recipe that composes the `db-postgres` reference component
 * under the `db` key, with the slot's stub mode set to `stubbed`.
 * Returns the recipe root path.
 */
async function buildRecipe(stubbed: boolean): Promise<string> {
  const recipeRoot = join(work, 'recipe');
  const hexDir = join(recipeRoot, '.hex');
  await mkdir(hexDir, { recursive: true });
  await writeFile(
    join(hexDir, 'manifest.yaml'),
    `type: recipe
name: stub-demo
version: 0.1.0

composes:
  db:
    component: file:${DB_POSTGRES}
    stub: ${stubbed}
`,
    'utf8',
  );
  // Recipe-root orchestration file — proves the recipe render still runs.
  await writeFile(join(recipeRoot, 'README.md'), '# stub-demo workspace\n', 'utf8');
  return recipeRoot;
}

/** Scripted prompter answering the db-postgres component's two prompts. */
function dbPrompter(): Prompter {
  return {
    note() {},
    async text(opts) {
      if (opts.message === 'Application name') return 'demo';
      if (opts.message === 'Postgres connection URL (production mode)') {
        return 'postgres://localhost:5432/demo';
      }
      throw new Error(`unexpected text prompt: ${opts.message}`);
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

type Rendered = {
  /** Recipe output root. */
  out: string;
  /** The `db` child subdir within the output root. */
  db: string;
};

/** Render the recipe (stub on/off) into a fresh output dir. */
async function renderWithStub(stubbed: boolean): Promise<Rendered> {
  const recipePath = await buildRecipe(stubbed);
  const bundle = await loadFromPath(recipePath);
  const resolved = await resolveRecipe(bundle, { config: { sources: [] } });
  const answers = await runRecipePrompts(resolved, dbPrompter());
  // Unique output dir per render so both modes can render under the
  // same `work` tmpdir without tripping the non-empty-target guard.
  const out = await mkdtemp(join(work, 'out-'));
  await renderRecipe(resolved, out, answers, { force: true });
  return { out, db: join(out, 'db') };
}

describe('M8.7 — stub recipe integration: db-postgres rendered stub on/off', () => {
  it('renders the shared component skeleton identically in both modes', async () => {
    // The dev/prod entry points and the shared client are part of the
    // component's normal tree — present whether or not the slot is
    // stubbed. Stub mode does not gate them; it only adds fixtures.
    for (const stubbed of [true, false]) {
      const { out, db } = await renderWithStub(stubbed);
      expect(existsSync(join(db, 'src', 'index.ts')), `index.ts stub=${stubbed}`).toBe(true);
      expect(existsSync(join(db, 'src', 'index.dev.ts')), `index.dev.ts stub=${stubbed}`).toBe(
        true,
      );
      expect(existsSync(join(db, 'src', 'client.ts')), `client.ts stub=${stubbed}`).toBe(true);
      expect(existsSync(join(db, 'package.json')), `package.json stub=${stubbed}`).toBe(true);
      // pg-mem is an in-process engine — no compose service, so the
      // recipe never emits a docker-compose.yml for it.
      expect(existsSync(join(out, 'docker-compose.yml'))).toBe(false);
    }
  });

  it('emits stub fixtures only when the slot is stubbed', async () => {
    const { db } = await renderWithStub(true);
    const seed = join(db, 'fixtures', 'seed.sql');
    expect(existsSync(seed), 'fixtures/seed.sql present in stub mode').toBe(true);
    // Fixtures are Nunjucks-rendered — the `{{ app_name }}` placeholder
    // in seed.sql resolves to the component's answer.
    const seedBody = await readFile(seed, 'utf8');
    expect(seedBody).toContain("'demo'");
    expect(seedBody).not.toContain('{{ app_name }}');
  });

  it('omits the fixtures directory entirely when the slot is not stubbed', async () => {
    const { db } = await renderWithStub(false);
    // The manifest's `stub.fixtures` directory is excluded from the main
    // walk; with stub off the stub-mode path never runs, so no fixtures.
    expect(existsSync(join(db, 'fixtures'))).toBe(false);
    expect(existsSync(join(db, 'fixtures', 'seed.sql'))).toBe(false);
  });

  it('produces a strict file-layout delta — fixtures/ is the only difference', async () => {
    // Render both modes side by side and diff the db child subtree. The
    // stub decision is observable purely as the presence of `fixtures/`;
    // every other path is identical. This is the M8 contract: stub mode
    // is additive and prod-clean — flipping it off yields exactly the
    // real-only tree with nothing left behind.
    const stubbedPaths = await collectRelPaths((await renderWithStub(true)).db);
    const realPaths = await collectRelPaths((await renderWithStub(false)).db);

    const onlyInStub = stubbedPaths.filter((p) => !realPaths.includes(p));
    const onlyInReal = realPaths.filter((p) => !stubbedPaths.includes(p));

    expect(onlyInReal).toEqual([]);
    expect(onlyInStub.sort()).toEqual(['fixtures', 'fixtures/seed.sql']);
  });
});

/** Recursively collect paths under `root`, relative to it, sorted. */
async function collectRelPaths(root: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push(rel);
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
    }
  }
  await walk(root, '');
  return out.sort();
}
