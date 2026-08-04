import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AdoptCommandEffects,
  type AdoptFitReport,
  runAdoptCommand,
} from '../../src/commands/adopt.js';
import {
  type HexifyCommandEffects,
  defaultHexifyCommandEffects,
  runHexifyCommand,
} from '../../src/commands/hexify.js';
import { executeNewRender } from '../../src/commands/new.js';
import { runPrompts } from '../../src/core/prompts/engine.js';
import { createNonInteractivePrompter } from '../../src/core/prompts/non-interactive-prompter.js';
import type { Answers, Prompter } from '../../src/core/prompts/types.js';
import { loadFromPath } from '../../src/core/sources/file-source.js';

/**
 * Integration pack for `hex hexify` (Hex 2.0 / H1): THE workplace arc,
 * on a real git repo with real hazards. The point is to prove the
 * whole reuse story end to end — a manually-maintained template repo
 * is hexified, `hex new` reproduces it byte-for-byte with the default
 * answers and re-parameterises it with different ones, and a
 * hand-copied instance can then be `hex adopt`ed with a truthful fit
 * report. Uses the REAL git preflight, not a fake.
 */

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-hexify-int-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function writeFileEnsure(path: string, body: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);

/**
 * The "manually maintained template repo" a workplace team would have:
 * concrete name everywhere (contents + one filename), a GitHub Actions
 * hazard, a binary, node_modules ON DISK but gitignored, all committed.
 */
async function buildWorkplaceRepo(): Promise<string> {
  const repo = join(work, 'acme-portal');
  await writeFileEnsure(
    join(repo, 'package.json'),
    '{\n  "name": "acme-portal",\n  "description": "The Acme portal",\n  "license": "MIT"\n}\n',
  );
  await writeFileEnsure(
    join(repo, 'src', 'acme-portal.config.ts'),
    'export const appName = "acme-portal";\n',
  );
  await writeFileEnsure(join(repo, 'src', 'index.ts'), 'export const boot = () => "up";\n');
  await writeFileEnsure(
    join(repo, '.github', 'workflows', 'ci.yml'),
    'env:\n  TOKEN: ${{ secrets.NPM_TOKEN }}\n',
  );
  await writeFileEnsure(join(repo, 'logo.png'), PNG_BYTES);
  await writeFileEnsure(join(repo, '.gitignore'), 'node_modules/\ndist/\n');
  await writeFileEnsure(
    join(repo, 'node_modules', 'left-pad', 'index.js'),
    'module.exports = (s) => s;\n',
  );

  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'test');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'initial');
  return repo;
}

/** Accept-every-default prompter — the unscripted guided flow. */
function defaultsPrompter(): Prompter {
  return {
    async text(opts) {
      return opts.default ?? '';
    },
    async confirm(opts) {
      return opts.default ?? true;
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
}

function hexifyEffects(): {
  effects: HexifyCommandEffects;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  return {
    stdout,
    stderr,
    exitCodes,
    effects: {
      stdout: { write: (s) => void stdout.push(s) },
      stderr: { write: (s) => void stderr.push(s) },
      setExitCode: (code) => void exitCodes.push(code),
      prompterFactory: () => defaultsPrompter(),
      // The REAL git preflight — this pack runs on real repos.
      gitStatus: defaultHexifyCommandEffects.gitStatus,
      makeShadowDir: () => mkdtemp(join(tmpdir(), 'hex-hexify-int-shadow-')),
    },
  };
}

/** Resolve a hexified template's answers: all defaults, plus overrides. */
async function answersFor(templateRoot: string, overrides: Answers = {}): Promise<Answers> {
  const bundle = await loadFromPath(templateRoot);
  return runPrompts(
    bundle.manifest.prompts ?? [],
    createNonInteractivePrompter(),
    {},
    undefined,
    overrides,
  );
}

describe('real git preflight', () => {
  it('classifies non-repo, dirty, and clean correctly', async () => {
    const { gitStatus } = defaultHexifyCommandEffects;

    const plain = join(work, 'not-a-repo');
    await mkdir(plain, { recursive: true });
    expect((await gitStatus(plain)).isRepo).toBe(false);

    const repo = await buildWorkplaceRepo();
    expect(await gitStatus(repo)).toEqual({ isRepo: true, clean: true });

    await writeFile(join(repo, 'dirty.txt'), 'uncommitted\n', 'utf8');
    expect(await gitStatus(repo)).toEqual({ isRepo: true, clean: false });
  });
});

describe('the workplace arc: hexify → new → adopt', () => {
  it('hexifies, reproduces byte-for-byte on defaults, re-parameterises, and adopts', async () => {
    const repo = await buildWorkplaceRepo();

    // Pre-hexify snapshot of the files that make up the template.
    const originals = new Map<string, Buffer>();
    for (const rel of [
      'package.json',
      'src/acme-portal.config.ts',
      'src/index.ts',
      '.github/workflows/ci.yml',
      'logo.png',
      '.gitignore',
    ]) {
      originals.set(rel, await readFile(join(repo, ...rel.split('/'))));
    }

    // ---- hexify (guided defaults: project_name, description, license) ----
    const cap = hexifyEffects();
    await runHexifyCommand(repo, cap.effects, {});
    expect(cap.stderr).toEqual([]);
    expect(cap.exitCodes).toEqual([]);
    expect(cap.stdout.join('')).toContain('Hexified');

    // node_modules never entered the template: it is hexignored, and the
    // round-trip proof passed with it filtered on both sides.
    const hexignore = await readFile(join(repo, '.hexignore'), 'utf8');
    expect(hexignore).toContain('node_modules/');
    expect(existsSync(join(repo, 'node_modules', 'left-pad', 'index.js'))).toBe(true);

    // ---- (a) hex new with all defaults reproduces the original bytes ----
    const bundle = await loadFromPath(repo);
    const defaults = await answersFor(repo);
    expect(defaults.project_name).toBe('acme-portal');
    const outA = join(work, 'render-defaults');
    await executeNewRender(bundle, outA, { answers: defaults, warnings: [] }, { force: false });

    for (const [rel, bytes] of originals) {
      const rendered = await readFile(join(outA, ...rel.split('/')));
      expect(rendered.equals(bytes), `byte mismatch in ${rel}`).toBe(true);
    }
    // The ignored dir is not part of the template.
    expect(existsSync(join(outA, 'node_modules'))).toBe(false);

    // ---- (b) hex new as zed-portal re-parameterises everywhere ----
    const zed = await answersFor(repo, { project_name: 'zed-portal' });
    const outB = join(work, 'render-zed');
    await executeNewRender(bundle, outB, { answers: zed, warnings: [] }, { force: false });

    expect(await readFile(join(outB, 'package.json'), 'utf8')).toContain('"name": "zed-portal"');
    expect(existsSync(join(outB, 'src', 'zed-portal.config.ts'))).toBe(true);
    expect(existsSync(join(outB, 'src', 'acme-portal.config.ts'))).toBe(false);
    expect(await readFile(join(outB, 'src', 'zed-portal.config.ts'), 'utf8')).toBe(
      'export const appName = "zed-portal";\n',
    );
    // The escaped Actions hazard renders back literally, whatever the answers.
    expect(await readFile(join(outB, '.github', 'workflows', 'ci.yml'), 'utf8')).toBe(
      'env:\n  TOKEN: ${{ secrets.NPM_TOKEN }}\n',
    );
    // Binary passes through byte-identical.
    expect((await readFile(join(outB, 'logo.png'))).equals(PNG_BYTES)).toBe(true);

    // ---- (c) a hand-copied instance adopts against the hexified template ----
    // Manufacture it: real render, strip .hex (the adopt-pack pattern),
    // then drift one file — weeks of "development".
    await rm(join(outB, '.hex'), { recursive: true, force: true });
    await writeFile(join(outB, 'src', 'index.ts'), 'export const boot = () => "patched";\n');

    const answersFile = join(work, 'answers.yaml');
    await writeFile(
      answersFile,
      'project_name: zed-portal\ndescription: The Acme portal\nlicense: MIT\n',
      'utf8',
    );
    const adopt = adoptEffects(repo);
    await runAdoptCommand(outB, 'acme-portal', adopt.effects, {
      json: true,
      answers: answersFile,
    });
    expect(adopt.exitCodes).toEqual([]);
    const fit = JSON.parse(adopt.stdout.join('')) as AdoptFitReport;
    expect(fit.template.name).toBe('acme-portal');
    expect(fit.edited).toEqual(['src/index.ts']);
    expect(fit.missing).toEqual([]);
    expect(fit.clean).toContain('package.json');
    expect(fit.clean).toContain('src/zed-portal.config.ts');
    expect(fit.clean).toContain('.github/workflows/ci.yml');
  });
});

describe('hexify --against: the H2 mining arc', () => {
  it('a mined parameter makes the instance adopt clean where seeding alone would read edited', async () => {
    const repo = await buildWorkplaceRepo();
    // A value package.json seeding can never discover — the H2 case.
    await writeFileEnsure(
      join(repo, 'conf', 'service.yaml'),
      'service: acme-portal-svc\nowner: platform-team\n',
    );
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'service config');

    // The hand-copied instance: values swapped throughout, one genuine
    // team edit (src/index.ts), everything else faithful.
    const instance = join(work, 'zed-instance');
    await writeFileEnsure(
      join(instance, 'package.json'),
      '{\n  "name": "zed-portal",\n  "description": "The Acme portal",\n  "license": "MIT"\n}\n',
    );
    await writeFileEnsure(
      join(instance, 'src', 'zed-portal.config.ts'),
      'export const appName = "zed-portal";\n',
    );
    await writeFileEnsure(
      join(instance, 'src', 'index.ts'),
      'export const boot = () => "patched";\n',
    );
    await writeFileEnsure(
      join(instance, '.github', 'workflows', 'ci.yml'),
      'env:\n  TOKEN: ${{ secrets.NPM_TOKEN }}\n',
    );
    await writeFileEnsure(join(instance, 'logo.png'), PNG_BYTES);
    await writeFileEnsure(join(instance, '.gitignore'), 'node_modules/\ndist/\n');
    await writeFileEnsure(
      join(instance, 'conf', 'service.yaml'),
      'service: zed-portal-svc\nowner: platform-team\n',
    );

    // Hexify WITH mining — the defaults prompter accepts every proposal,
    // including the mined acme-portal-svc pair under its suggested name.
    const cap = hexifyEffects();
    await runHexifyCommand(repo, cap.effects, { against: instance });
    expect(cap.stderr).toEqual([]);
    expect(cap.exitCodes).toEqual([]);

    const bundle = await loadFromPath(repo);
    const promptNames = (bundle.manifest.prompts ?? []).map((p) => p.name);
    expect(promptNames).toContain('acme_portal_svc');

    // Adopt the instance with its real values: the service file must be
    // CLEAN — without the mined parameter it would classify edited.
    const answersFile = join(work, 'answers.yaml');
    await writeFile(
      answersFile,
      'project_name: zed-portal\nacme_portal_svc: zed-portal-svc\n',
      'utf8',
    );
    const adopt = adoptEffects(repo);
    await runAdoptCommand(instance, 'acme-portal', adopt.effects, {
      json: true,
      answers: answersFile,
    });
    expect(adopt.exitCodes).toEqual([]);
    const fit = JSON.parse(adopt.stdout.join('')) as AdoptFitReport;
    expect(fit.clean).toContain('conf/service.yaml');
    expect(fit.clean).toContain('src/zed-portal.config.ts');
    expect(fit.edited).toEqual(['src/index.ts']);
    expect(fit.fitPercent).toBeGreaterThan(80);
  });
});

function adoptEffects(templateRoot: string): {
  effects: AdoptCommandEffects;
  stdout: string[];
  exitCodes: number[];
} {
  const stdout: string[] = [];
  const exitCodes: number[] = [];
  return {
    stdout,
    exitCodes,
    effects: {
      stdout: { write: (s) => void stdout.push(s) },
      stderr: { write: () => {} },
      setExitCode: (code) => void exitCodes.push(code),
      prompterFactory: () => createNonInteractivePrompter(),
      resolveTemplate: async () => loadFromPath(templateRoot, 'file'),
      makeShadowDir: () => mkdtemp(join(tmpdir(), 'hex-hexify-int-adopt-')),
    },
  };
}
