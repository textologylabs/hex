import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AdoptCommandEffects,
  type AdoptFitReport,
  defaultAdoptCommandEffects,
  runAdoptCommand,
} from '../../src/commands/adopt.js';
import { buildDoctorReport } from '../../src/commands/doctor.js';
import { executeNewRender } from '../../src/commands/new.js';
import { runPlainUpgrade } from '../../src/commands/upgrade.js';
import { _resetRegistriesForTest, bootstrapBuiltinAdapters } from '../../src/core/deploy/index.js';
import { checkLockfileIntegrity, readLockfileUpward } from '../../src/core/lockfile/index.js';
import { createNonInteractivePrompter } from '../../src/core/prompts/non-interactive-prompter.js';
import { loadFromPath } from '../../src/core/sources/file-source.js';
import { BASELINE_REL_PATH } from '../../src/core/upgrade/baseline.js';

/**
 * Integration pack for `hex adopt` (Hex 2.0 / A2): real templates, real
 * command wiring — no synthetic environments. The M11.8 lesson applies:
 * the point of these tests is to prove that ADOPTED state behaves
 * exactly like SCAFFOLDED state for the downstream commands (`doctor`,
 * `upgrade`), not merely that adopt's own outputs look right.
 */

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-adopt-int-'));
  // runPlainUpgrade reports progress on stdout; keep test output clean.
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeEffects(templateRoot: string): {
  effects: AdoptCommandEffects;
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
      prompterFactory: () => createNonInteractivePrompter(),
      resolveTemplate: async () => loadFromPath(templateRoot, 'file'),
      makeShadowDir: () => mkdtemp(join(tmpdir(), 'hex-adopt-int-shadow-')),
      // The REAL git-backed provenance — this pack runs on real repos.
      materialiseProvenance: defaultAdoptCommandEffects.materialiseProvenance,
    },
  };
}

/** Write/overwrite a prompt-less component template at `dir`. */
async function writeTemplate(
  dir: string,
  version: string,
  files: Record<string, string>,
): Promise<string> {
  await mkdir(join(dir, '.hex'), { recursive: true });
  await writeFile(
    join(dir, '.hex', 'manifest.yaml'),
    `type: component\nname: adopt-fixture\nversion: ${version}\nkind: lib\nprompts: []\n`,
    'utf8',
  );
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }
  return dir;
}

/**
 * Manufacture a "manually instantiated" project: render via the real
 * `hex new` machinery, then strip `.hex/` — leaving exactly what a team
 * that copied the template by hand would have.
 */
async function renderThenStripHex(template: string, out: string): Promise<string> {
  const bundle = await loadFromPath(template);
  await executeNewRender(bundle, out, { answers: {}, warnings: [] }, { force: false });
  await rm(join(out, '.hex'), { recursive: true, force: true });
  return out;
}

const read = (path: string): Promise<string> => readFile(path, 'utf8');

describe('adopt → doctor agreement', () => {
  it("doctor's integrity report agrees with the fit report on an adopted project", async () => {
    const template = await writeTemplate(join(work, 'template'), '1.0.0', {
      'README.md': 'hello\n',
      'src/lib.ts': 'export const a = 1;\n',
    });
    const app = await renderThenStripHex(template, join(work, 'app'));
    await writeFile(join(app, 'src/lib.ts'), 'export const a = 2; // mine\n', 'utf8');

    const cap = makeEffects(template);
    await runAdoptCommand(app, 'adopt-fixture', cap.effects, { json: true });
    expect(cap.exitCodes).toEqual([]);
    const fit = JSON.parse(cap.stdout.join('')) as AdoptFitReport;

    // Now the real doctor path: load the adopted lockfile, check
    // integrity, build the doctor report — its classification must be
    // the same partition the fit report printed.
    const loaded = await readLockfileUpward(app);
    expect(loaded).not.toBeNull();
    if (!loaded) return;
    const integrity = await checkLockfileIntegrity(loaded.rootDir, loaded.lockfile);
    expect(integrity.modified).toEqual(fit.edited);
    expect(integrity.missing).toEqual(fit.missing);
    expect(integrity.added).toEqual(fit.untracked);

    const report = buildDoctorReport(
      { node: 'v0', platform: 'test', terminal: 'test' },
      null,
      loaded,
      integrity,
    );
    expect(report.lockfile?.integrity?.modified).toEqual(['src/lib.ts']);
    expect(report.lockfile?.root).toMatchObject({ name: 'adopt-fixture', version: '1.0.0' });
  });
});

describe('adopt → upgrade round-trip (the proof that adopted state upgrades)', () => {
  it('preserves the user edit, lands the template change, advances the lockfile', async () => {
    // v1 template: README the template will evolve; keep.ts the user will edit.
    const v1 = await writeTemplate(join(work, 'v1'), '1.0.0', {
      'README.md': 'v1 docs\n',
      'src/keep.ts': 'original\n',
    });
    const app = await renderThenStripHex(v1, join(work, 'app'));

    // Weeks of "development": the user edits keep.ts.
    await writeFile(join(app, 'src/keep.ts'), 'user edited\n', 'utf8');

    // Adopt against v1.
    const cap = makeEffects(v1);
    await runAdoptCommand(app, 'adopt-fixture', cap.effects, { json: true });
    expect(cap.exitCodes).toEqual([]);
    const fit = JSON.parse(cap.stdout.join('')) as AdoptFitReport;
    expect(fit.edited).toEqual(['src/keep.ts']);
    expect(fit.clean).toContain('README.md');
    expect(existsSync(join(app, BASELINE_REL_PATH, 'README.md'))).toBe(true);

    // v2 template (side-by-side dir): README changes; keep.ts untouched.
    const v2 = await writeTemplate(join(work, 'v2'), '2.0.0', {
      'README.md': 'v2 docs\n',
      'src/keep.ts': 'original\n',
    });

    // The real upgrade command over the ADOPTED app.
    await runPlainUpgrade(v2, false, app);

    // Template change landed; user edit preserved.
    expect(await read(join(app, 'README.md'))).toBe('v2 docs\n');
    expect(await read(join(app, 'src/keep.ts'))).toBe('user edited\n');

    // Lockfile advanced, baseline refreshed to v2.
    const after = await readLockfileUpward(app);
    expect(after?.lockfile.root.version).toBe('2.0.0');
    expect(await read(join(app, BASELINE_REL_PATH, 'README.md'))).toBe('v2 docs\n');
  });
});

describe('flagship template headless (vite-ts-spa via --answers)', () => {
  beforeEach(() => {
    // The template's cicd stanza makes executeNewRender emit a workflow,
    // which needs the deploy registry the CLI bootstraps at startup.
    _resetRegistriesForTest();
    bootstrapBuiltinAdapters();
  });
  afterEach(() => {
    _resetRegistriesForTest();
  });

  it('classifies a drifted real-template project and emits parseable JSON', async () => {
    const templateRoot = join(process.cwd(), 'templates', 'vite-ts-spa');
    const answers = {
      project_name: 'adopt-spa',
      description: 'adopted',
      author: 'test',
      license: 'MIT',
    };

    // Manufacture the "manually instantiated" project with the same
    // answers the adoption will use.
    const bundle = await loadFromPath(templateRoot);
    const app = join(work, 'spa');
    await executeNewRender(bundle, app, { answers, warnings: [] }, { force: false });
    await rm(join(app, '.hex'), { recursive: true, force: true });

    // Drift: one user edit. (The CI workflow emitted by hex new stays in
    // the tree — adopt's shadow render doesn't produce it, so it must be
    // classified as untracked, exactly like any user-owned file.)
    await writeFile(join(app, 'src', 'main.ts'), '// user rewrote this\n', 'utf8');

    const answersFile = join(work, 'answers.yaml');
    await writeFile(
      answersFile,
      Object.entries(answers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n'),
      'utf8',
    );

    const cap = makeEffects(templateRoot);
    await runAdoptCommand(app, 'vite-ts-spa', cap.effects, { json: true, answers: answersFile });

    expect(cap.exitCodes).toEqual([]);
    const fit = JSON.parse(cap.stdout.join('')) as AdoptFitReport;
    expect(fit.template.name).toBe('vite-ts-spa');
    expect(fit.edited).toEqual(['src/main.ts']);
    expect(fit.missing).toEqual([]);
    expect(fit.untracked).toContain('.github/workflows/deploy.yml');
    expect(fit.clean).toContain('package.json');
    expect(fit.clean).toContain('.gitignore'); // rename hook honoured in the shadow
    expect(fit.fitPercent).toBeGreaterThan(80);
    expect(fit.fitPercent).toBeLessThan(100);
  });
});

describe('adopt --provenance: the A7 three-buckets arc (real git)', () => {
  async function git(cwd: string, ...args: string[]): Promise<void> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('git', args, { cwd });
  }

  it('splits edited into yours / stale / collided against the instance root commit', async () => {
    // Template v1 — what the team originally copied.
    const template = await writeTemplate(join(work, 'template'), '1.0.0', {
      'a.ts': 'a v1\n',
      'b.ts': 'b v1\n',
      'c.ts': 'c v1\n',
      'd.ts': 'd v1\n',
    });
    const app = await renderThenStripHex(template, join(work, 'app'));

    // The copy moment becomes the root commit — the provenance baseline.
    await git(app, 'init', '-q', '-b', 'main');
    await git(app, 'config', 'user.email', 't@e.c');
    await git(app, 'config', 'user.name', 't');
    await git(app, 'add', '-A');
    await git(app, 'commit', '-q', '-m', 'copied from template');

    // The team edits a and c.
    await writeFile(join(app, 'a.ts'), 'a v1 + team change\n', 'utf8');
    await writeFile(join(app, 'c.ts'), 'c v1 + team change\n', 'utf8');
    await git(app, 'add', '-A');
    await git(app, 'commit', '-q', '-m', 'team work');

    // Meanwhile the template evolves: b and c change upstream.
    await writeTemplate(template, '1.1.0', {
      'a.ts': 'a v1\n',
      'b.ts': 'b v2 upstream\n',
      'c.ts': 'c v2 upstream\n',
      'd.ts': 'd v1\n',
    });

    // Adopt with provenance: a = yours, b = stale, c = collided, d = clean.
    const { effects, stdout, stderr, exitCodes } = makeEffects(template);
    await runAdoptCommand(app, 'adopt-fixture', effects, {
      dryRun: true,
      json: true,
      provenance: true,
    });

    expect(stderr).toEqual([]);
    expect(exitCodes).toEqual([]);
    const report = JSON.parse(stdout.join('')) as AdoptFitReport;
    expect(report.edited).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(report.clean).toContain('d.ts');
    expect(report.provenance).toMatchObject({
      ref: 'root commit',
      editedByYou: ['a.ts'],
      stale: ['b.ts'],
      collided: ['c.ts'],
    });
    expect(report.provenance?.sha).toMatch(/^[0-9a-f]{40}$/);
    // Report-only: nothing written on dry-run.
    expect(existsSync(join(app, '.hex'))).toBe(false);
  });

  it('warns and continues when the project has no git history', async () => {
    const template = await writeTemplate(join(work, 'template'), '1.0.0', {
      'a.ts': 'a v1\n',
    });
    const app = await renderThenStripHex(template, join(work, 'app-nogit'));

    const { effects, stdout, stderr, exitCodes } = makeEffects(template);
    await runAdoptCommand(app, 'adopt-fixture', effects, {
      dryRun: true,
      json: true,
      provenance: true,
    });

    expect(exitCodes).toEqual([]);
    expect(stderr.join('')).toContain('continuing without the split');
    const report = JSON.parse(stdout.join('')) as AdoptFitReport;
    expect(report.provenance).toBeUndefined();
    expect(report.fitPercent).toBe(100);
  });
});
