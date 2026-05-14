import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPrompts } from '../../src/core/prompts/engine.js';
import type { Prompter } from '../../src/core/prompts/types.js';
import { renderBundle } from '../../src/core/render/engine.js';
import { loadFromPath } from '../../src/core/sources/file-source.js';

const TEMPLATE_PATH = resolve(__dirname, '..', '..', 'templates', 'node-ts-hooked');

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-int-hooked-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

/**
 * Prompter that answers each known message with a fixed value. Falls
 * back to throwing on anything unexpected — keeps the test honest about
 * which prompts actually fire (top-level vs hook-defined).
 */
function fixedPrompter(answers: {
  project_name: string;
  description: string;
  github_coord: string;
}): Prompter {
  return {
    async text(opts) {
      const map: Record<string, string> = {
        'Package name': answers.project_name,
        'Short description': answers.description,
        'GitHub repo coordinate (owner/name) — leave blank to skip the repository field':
          answers.github_coord,
      };
      const value = map[opts.message];
      if (value === undefined) throw new Error(`unexpected text prompt: ${opts.message}`);
      const validation = opts.validate?.(value);
      if (validation !== undefined) throw new Error(`validation failed: ${validation}`);
      return value;
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

function captureLog() {
  const entries: Array<{ level: 'info' | 'warn' | 'error'; msg: string }> = [];
  return {
    entries,
    sink: {
      info: (msg: string) => entries.push({ level: 'info', msg }),
      warn: (msg: string) => entries.push({ level: 'warn', msg }),
      error: (msg: string) => entries.push({ level: 'error', msg }),
    },
  };
}

describe('node-ts-hooked template — M7 dogfood end-to-end', () => {
  it('runs pre_render + post_render JS hooks, splicing repository into package.json on a valid coord', async () => {
    const bundle = await loadFromPath(TEMPLATE_PATH);
    expect(bundle.sourceKind).toBe('file');
    expect(Object.keys(bundle.jsHookSources).sort()).toEqual(['post_render.js', 'pre_render.js']);

    const prompter = fixedPrompter({
      project_name: 'my-cli',
      description: 'demo CLI',
      github_coord: 'alice/my-cli',
    });

    const topLevel = await runPrompts(
      bundle.manifest.prompts ?? [],
      prompter,
      {},
      bundle.manifest.sections,
    );
    expect(topLevel).toEqual({ project_name: 'my-cli', description: 'demo CLI' });

    const out = join(work, 'my-cli');
    const log = captureLog();
    await renderBundle(bundle, out, topLevel, { prompter, hookLog: log.sink });

    const pkg = JSON.parse(await readFile(join(out, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('my-cli');
    expect(pkg.description).toBe('demo CLI');
    expect(pkg.repository).toBe('github:alice/my-cli');

    expect(log.entries).toEqual([
      { level: 'info', msg: 'node-ts-hooked: pre_render for my-cli (recipe=standalone)' },
      { level: 'info', msg: 'node-ts-hooked: set package.json repository = github:alice/my-cli' },
    ]);
  });

  it('leaves package.json untouched when the hook prompt answer is empty', async () => {
    const bundle = await loadFromPath(TEMPLATE_PATH);
    const prompter = fixedPrompter({
      project_name: 'quiet',
      description: '',
      github_coord: '',
    });

    const topLevel = await runPrompts(
      bundle.manifest.prompts ?? [],
      prompter,
      {},
      bundle.manifest.sections,
    );
    const out = join(work, 'quiet');
    const log = captureLog();
    await renderBundle(bundle, out, topLevel, { prompter, hookLog: log.sink });

    const pkg = JSON.parse(await readFile(join(out, 'package.json'), 'utf8'));
    expect(pkg.repository).toBeUndefined();
    expect(log.entries.map((e) => e.msg)).toContain(
      'node-ts-hooked: no repository coordinate, leaving package.json untouched',
    );
  });

  it('warns and skips when the hook prompt answer is malformed', async () => {
    const bundle = await loadFromPath(TEMPLATE_PATH);
    const prompter = fixedPrompter({
      project_name: 'noisy',
      description: '',
      github_coord: 'not a coord',
    });

    const topLevel = await runPrompts(
      bundle.manifest.prompts ?? [],
      prompter,
      {},
      bundle.manifest.sections,
    );
    const out = join(work, 'noisy');
    const log = captureLog();
    await renderBundle(bundle, out, topLevel, { prompter, hookLog: log.sink });

    const pkg = JSON.parse(await readFile(join(out, 'package.json'), 'utf8'));
    expect(pkg.repository).toBeUndefined();
    expect(log.entries.find((e) => e.level === 'warn')?.msg).toMatch(
      /does not look like owner\/name/,
    );
  });

  it('produces identical output sandboxed vs --trust-local for the same answers', async () => {
    const bundle = await loadFromPath(TEMPLATE_PATH);
    const answers = await runPrompts(
      bundle.manifest.prompts ?? [],
      fixedPrompter({
        project_name: 'parity',
        description: '',
        github_coord: 'alice/parity',
      }),
      {},
      bundle.manifest.sections,
    );

    const sandboxOut = join(work, 'sandbox');
    const trustOut = join(work, 'trust');
    const sandboxedPrompter = fixedPrompter({
      project_name: 'parity',
      description: '',
      github_coord: 'alice/parity',
    });
    const trustPrompter = fixedPrompter({
      project_name: 'parity',
      description: '',
      github_coord: 'alice/parity',
    });

    await renderBundle(bundle, sandboxOut, answers, {
      prompter: sandboxedPrompter,
      hookLog: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await renderBundle(bundle, trustOut, answers, {
      prompter: trustPrompter,
      trustLocal: true,
      hookLog: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const sandboxPkg = await readFile(join(sandboxOut, 'package.json'), 'utf8');
    const trustPkg = await readFile(join(trustOut, 'package.json'), 'utf8');
    expect(sandboxPkg).toBe(trustPkg);
    expect(JSON.parse(sandboxPkg).repository).toBe('github:alice/parity');
  });
});
