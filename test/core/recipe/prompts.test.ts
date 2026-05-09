import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ConfirmOpts,
  MultiSelectOpts,
  PasswordOpts,
  Prompter,
  SelectOpts,
  TextOpts,
} from '../../../src/core/prompts/types.js';
import { runRecipePrompts } from '../../../src/core/recipe/prompts.js';
import { resolveRecipe } from '../../../src/core/recipe/resolve.js';
import { loadFromPath } from '../../../src/core/sources/file-source.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-recipe-prompts-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function writeManifest(rootPath: string, manifest: object): Promise<void> {
  const hexDir = join(rootPath, '.hex');
  await mkdir(hexDir, { recursive: true });
  await writeFile(join(hexDir, 'manifest.yaml'), serialize(manifest), 'utf8');
}

function serialize(obj: unknown, indent = 0): string {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (Array.isArray(obj)) {
    return `\n${obj.map((v) => `${' '.repeat(indent)}- ${serialize(v, indent + 2)}`).join('\n')}`;
  }
  const entries = Object.entries(obj);
  return `\n${entries
    .map(([k, v]) => `${' '.repeat(indent)}${k}: ${serialize(v, indent + 2)}`)
    .join('\n')}`;
}

type ScriptedAnswer =
  | { kind: 'text'; value: string }
  | { kind: 'confirm'; value: boolean }
  | { kind: 'select'; value: string }
  | { kind: 'multi'; value: string[] }
  | { kind: 'password'; value: string };

type RecordedAsk = {
  kind: ScriptedAnswer['kind'];
  message: string;
};

type RecordedNote = { title: string | undefined; body: string };

function recordingPrompter(answers: ScriptedAnswer[]): {
  prompter: Prompter;
  asks: RecordedAsk[];
  notes: RecordedNote[];
} {
  let i = 0;
  const asks: RecordedAsk[] = [];
  const notes: RecordedNote[] = [];

  const next = (kind: ScriptedAnswer['kind']): ScriptedAnswer => {
    const a = answers[i++];
    if (!a) throw new Error(`scripted prompter ran out of answers at ask #${i}`);
    if (a.kind !== kind) {
      throw new Error(`scripted prompter: expected ${kind} at ask #${i}, got ${a.kind}`);
    }
    return a;
  };

  const prompter: Prompter = {
    async text(opts: TextOpts) {
      asks.push({ kind: 'text', message: opts.message });
      return (next('text') as { kind: 'text'; value: string }).value;
    },
    async confirm(opts: ConfirmOpts) {
      asks.push({ kind: 'confirm', message: opts.message });
      return (next('confirm') as { kind: 'confirm'; value: boolean }).value;
    },
    async select(opts: SelectOpts) {
      asks.push({ kind: 'select', message: opts.message });
      return (next('select') as { kind: 'select'; value: string }).value;
    },
    async multiselect(opts: MultiSelectOpts) {
      asks.push({ kind: 'multi', message: opts.message });
      return (next('multi') as { kind: 'multi'; value: string[] }).value;
    },
    async password(opts: PasswordOpts) {
      asks.push({ kind: 'password', message: opts.message });
      return (next('password') as { kind: 'password'; value: string }).value;
    },
    note(body, title) {
      notes.push({ body, title });
    },
  };
  return { prompter, asks, notes };
}

async function loadResolved(
  recipePath: string,
): Promise<Awaited<ReturnType<typeof resolveRecipe>>> {
  const bundle = await loadFromPath(recipePath);
  return resolveRecipe(bundle, { config: { sources: [] } });
}

describe('runRecipePrompts — ordering', () => {
  it('asks recipe-level prompts before any child prompts, and children in declaration order', async () => {
    const recipeRoot = join(work, 'recipe');
    const apiRoot = join(work, 'children', 'api');
    const uiRoot = join(work, 'children', 'ui');

    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
      prompts: [
        { app_name: { type: 'string', default: 'demo' } },
        { containerize: { type: 'boolean', default: true } },
      ],
      composes: { api: 'file:../children/api', ui: 'file:../children/ui' },
    });
    await writeManifest(apiRoot, {
      type: 'component',
      name: 'api',
      version: '0.1.0',
      prompts: [{ port: { type: 'integer', default: 3000 } }],
    });
    await writeManifest(uiRoot, {
      type: 'component',
      name: 'ui',
      version: '0.1.0',
      prompts: [{ framework: { type: 'string', default: 'react' } }],
    });

    const resolved = await loadResolved(recipeRoot);
    const { prompter, asks } = recordingPrompter([
      { kind: 'text', value: 'demo' }, // recipe app_name
      { kind: 'confirm', value: true }, // recipe containerize
      { kind: 'text', value: '4000' }, // api.port
      { kind: 'text', value: 'react' }, // ui.framework
    ]);

    const answers = await runRecipePrompts(resolved, prompter);

    expect(asks.map((a) => a.message)).toEqual(['app_name', 'containerize', 'port', 'framework']);
    expect(answers).toEqual({
      app_name: 'demo',
      containerize: true,
      api: { port: 4000 },
      ui: { framework: 'react' },
    });
  });

  it('emits a "Configuring <key>" note before each child with prompts', async () => {
    const recipeRoot = join(work, 'recipe');
    const apiRoot = join(work, 'children', 'api');
    const uiRoot = join(work, 'children', 'ui');

    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
      composes: { api: 'file:../children/api', ui: 'file:../children/ui' },
    });
    await writeManifest(apiRoot, {
      type: 'component',
      name: 'api',
      version: '0.1.0',
      prompts: [{ port: { type: 'integer', default: 3000 } }],
    });
    await writeManifest(uiRoot, {
      type: 'component',
      name: 'ui',
      version: '0.1.0',
      prompts: [{ framework: { type: 'string', default: 'react' } }],
    });

    const resolved = await loadResolved(recipeRoot);
    const { prompter, notes } = recordingPrompter([
      { kind: 'text', value: '3000' },
      { kind: 'text', value: 'react' },
    ]);

    await runRecipePrompts(resolved, prompter);

    expect(notes.map((n) => n.title)).toEqual(['Configuring "api"', 'Configuring "ui"']);
  });
});

describe('runRecipePrompts — namespacing & cross-scope visibility', () => {
  it('child prompt sees recipe-level answers via bare reference (when:)', async () => {
    const recipeRoot = join(work, 'recipe');
    const apiRoot = join(work, 'children', 'api');

    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
      prompts: [{ containerize: { type: 'boolean', default: true } }],
      composes: { api: 'file:../children/api' },
    });
    await writeManifest(apiRoot, {
      type: 'component',
      name: 'api',
      version: '0.1.0',
      prompts: [{ image_tag: { type: 'string', default: 'latest', when: 'containerize' } }],
    });

    const resolved = await loadResolved(recipeRoot);
    const { prompter, asks } = recordingPrompter([
      { kind: 'confirm', value: false }, // containerize=false → image_tag skipped
    ]);

    const answers = await runRecipePrompts(resolved, prompter);
    expect(asks.map((a) => a.message)).toEqual(['containerize']);
    expect(answers).toEqual({
      containerize: false,
      api: {},
    });
  });

  it('sibling presence: a later child can branch on whether an earlier child key exists', async () => {
    const recipeRoot = join(work, 'recipe');
    const apiRoot = join(work, 'children', 'api');
    const uiRoot = join(work, 'children', 'ui');

    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
      composes: { api: 'file:../children/api', ui: 'file:../children/ui' },
    });
    // api child has no prompts, but its key is still present in answers as {}
    await writeManifest(apiRoot, {
      type: 'component',
      name: 'api',
      version: '0.1.0',
    });
    // ui child gates a prompt on `api` being present (truthy as object)
    await writeManifest(uiRoot, {
      type: 'component',
      name: 'ui',
      version: '0.1.0',
      prompts: [
        { api_url: { type: 'string', default: '/api', when: 'api' } },
        { framework: { type: 'string', default: 'react' } },
      ],
    });

    const resolved = await loadResolved(recipeRoot);
    const { prompter, asks } = recordingPrompter([
      { kind: 'text', value: '/api' },
      { kind: 'text', value: 'react' },
    ]);

    const answers = await runRecipePrompts(resolved, prompter);
    expect(asks.map((a) => a.message)).toEqual(['api_url', 'framework']);
    expect(answers).toEqual({
      api: {},
      ui: { api_url: '/api', framework: 'react' },
    });
  });

  it("sibling field access: a child can read another child's answer via answers.<sibling>.<prompt>", async () => {
    const recipeRoot = join(work, 'recipe');
    const apiRoot = join(work, 'children', 'api');
    const uiRoot = join(work, 'children', 'ui');

    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
      composes: { api: 'file:../children/api', ui: 'file:../children/ui' },
    });
    await writeManifest(apiRoot, {
      type: 'component',
      name: 'api',
      version: '0.1.0',
      prompts: [{ port: { type: 'integer', default: 3000 } }],
    });
    await writeManifest(uiRoot, {
      type: 'component',
      name: 'ui',
      version: '0.1.0',
      prompts: [
        // gate on the sibling's port being non-default — proves the sibling's
        // answer object is reachable from a later child's when:.
        { proxy_port: { type: 'integer', default: 0, when: 'api.port == 4000' } },
      ],
    });

    const resolved = await loadResolved(recipeRoot);
    const { prompter, asks } = recordingPrompter([
      { kind: 'text', value: '4000' }, // api.port = 4000 → ui.proxy_port asked
      { kind: 'text', value: '4000' },
    ]);

    const answers = await runRecipePrompts(resolved, prompter);
    expect(asks.map((a) => a.message)).toEqual(['port', 'proxy_port']);
    expect(answers).toEqual({
      api: { port: 4000 },
      ui: { proxy_port: 4000 },
    });
  });

  it('child prompts named like recipe-level keys do not leak back into recipe scope', async () => {
    const recipeRoot = join(work, 'recipe');
    const apiRoot = join(work, 'children', 'api');

    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
      prompts: [{ app_name: { type: 'string', default: 'recipe-level' } }],
      composes: { api: 'file:../children/api' },
    });
    // child re-uses the prompt name "app_name" — should land at answers.api.app_name,
    // not overwrite the recipe-level answers.app_name.
    await writeManifest(apiRoot, {
      type: 'component',
      name: 'api',
      version: '0.1.0',
      prompts: [{ app_name: { type: 'string', default: 'child-level' } }],
    });

    const resolved = await loadResolved(recipeRoot);
    const { prompter } = recordingPrompter([
      { kind: 'text', value: 'recipe-level' },
      { kind: 'text', value: 'child-level' },
    ]);

    const answers = await runRecipePrompts(resolved, prompter);
    expect(answers).toEqual({
      app_name: 'recipe-level',
      api: { app_name: 'child-level' },
    });
  });
});

describe('runRecipePrompts — degenerate cases', () => {
  it('returns just the initial answers for a recipe with no prompts and no children', async () => {
    const recipeRoot = join(work, 'recipe');
    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'empty',
      version: '0.1.0',
    });
    const resolved = await loadResolved(recipeRoot);
    const { prompter, asks } = recordingPrompter([]);
    const answers = await runRecipePrompts(resolved, prompter, { foo: 1 });
    expect(asks).toHaveLength(0);
    expect(answers).toEqual({ foo: 1 });
  });

  it('still creates an empty namespace for a child that has no prompts', async () => {
    const recipeRoot = join(work, 'recipe');
    const apiRoot = join(work, 'children', 'api');
    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
      composes: { api: 'file:../children/api' },
    });
    await writeManifest(apiRoot, {
      type: 'component',
      name: 'api',
      version: '0.1.0',
    });
    const resolved = await loadResolved(recipeRoot);
    const { prompter, notes } = recordingPrompter([]);
    const answers = await runRecipePrompts(resolved, prompter);
    expect(answers).toEqual({ api: {} });
    // No section header for a prompt-less child — keeps the UX quiet.
    expect(notes).toHaveLength(0);
  });
});
