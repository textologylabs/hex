import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  type AdoptCommandEffects,
  type AdoptFitReport,
  buildAdoptReport,
  formatAdoptText,
  runAdoptCommand,
} from '../../src/commands/adopt.js';
import {
  type Lockfile,
  type LockfileIntegrity,
  hashTree,
  lockfileSchema,
} from '../../src/core/lockfile/index.js';
import { PromptCancelledError } from '../../src/core/prompts/types.js';
import type { Prompter } from '../../src/core/prompts/types.js';
import { loadFromPath } from '../../src/core/sources/file-source.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-cmd-adopt-'));
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
 * A minimal component template: one prompt, two files (one templated).
 */
async function buildTemplateFixture(name = 'template'): Promise<string> {
  const root = join(work, name);
  await writeManifest(
    root,
    `type: component
name: adoptable
version: 0.3.0

prompts:
  - project_name:
      type: string
      required: true
`,
  );
  await writeFileEnsure(join(root, 'package.json'), '{"name": "{{ project_name }}"}\n');
  await writeFileEnsure(join(root, 'src', 'index.ts'), 'export const x = 1;\n');
  return root;
}

function scriptedPrompter(answers: Record<string, string>): Prompter {
  return {
    async text(opts) {
      const value = answers[opts.message];
      if (value === undefined) throw new Error(`unexpected text prompt: ${opts.message}`);
      return value;
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
}

type Capture = {
  effects: AdoptCommandEffects;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
  shadowDirs: string[];
};

function captureEffects(
  templateRoot: string | null,
  prompter: Prompter = scriptedPrompter({ project_name: 'my-app' }),
): Capture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const shadowDirs: string[] = [];
  return {
    stdout,
    stderr,
    exitCodes,
    shadowDirs,
    effects: {
      stdout: { write: (s) => void stdout.push(s) },
      stderr: { write: (s) => void stderr.push(s) },
      setExitCode: (code) => void exitCodes.push(code),
      prompterFactory: () => prompter,
      resolveTemplate: async () => {
        if (!templateRoot) throw new Error('resolveTemplate should not be called');
        return loadFromPath(templateRoot, 'file');
      },
      makeShadowDir: async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hex-adopt-test-'));
        shadowDirs.push(dir);
        return dir;
      },
    },
  };
}

/** A project whose files byte-match what the fixture template renders for `my-app`. */
async function buildMatchingProject(name = 'project'): Promise<string> {
  const root = join(work, name);
  await writeFileEnsure(join(root, 'package.json'), '{"name": "my-app"}\n');
  await writeFileEnsure(join(root, 'src', 'index.ts'), 'export const x = 1;\n');
  return root;
}

function fakeLockfile(paths: string[]): Lockfile {
  return {
    schema_version: 1,
    hex_version: '1.0.0',
    generated_at: '2026-08-02T00:00:00.000Z',
    root: {
      name: 'adoptable',
      version: '0.3.0',
      type: 'component',
      source: { kind: 'file', path: '/tmp/t' },
    },
    children: [],
    answers: {},
    files: paths.map((path) => ({ path, sha256: 'a'.repeat(64) })),
  } as Lockfile;
}

describe('buildAdoptReport', () => {
  it('partitions clean/edited/missing/untracked and rounds fitPercent', () => {
    const lf = fakeLockfile(['a.ts', 'b.ts', 'c.ts']);
    const integrity: LockfileIntegrity = {
      ok: false,
      modified: ['b.ts'],
      missing: [],
      added: ['extra.md'],
    };
    const report = buildAdoptReport(lf, integrity, { dryRun: false });
    expect(report.clean).toEqual(['a.ts', 'c.ts']);
    expect(report.edited).toEqual(['b.ts']);
    expect(report.missing).toEqual([]);
    expect(report.untracked).toEqual(['extra.md']);
    expect(report.recorded).toBe(3);
    expect(report.fitPercent).toBe(67); // 2/3 → 66.67 → 67
    expect(report.template).toEqual({ name: 'adoptable', version: '0.3.0', type: 'component' });
  });

  it('reports a perfect fit as 100% with groups sorted', () => {
    const lf = fakeLockfile(['z.ts', 'a.ts']);
    const integrity: LockfileIntegrity = { ok: true, modified: [], missing: [], added: [] };
    const report = buildAdoptReport(lf, integrity, { dryRun: true });
    expect(report.fitPercent).toBe(100);
    expect(report.clean).toEqual(['a.ts', 'z.ts']);
    expect(report.dryRun).toBe(true);
  });
});

describe('formatAdoptText', () => {
  it('renders non-empty groups and omits empty ones', () => {
    const lf = fakeLockfile(['a.ts', 'b.ts']);
    const integrity: LockfileIntegrity = {
      ok: false,
      modified: ['b.ts'],
      missing: [],
      added: ['mine.md'],
    };
    const text = formatAdoptText(buildAdoptReport(lf, integrity, { dryRun: false }));
    expect(text).toContain('Adopted');
    expect(text).toContain('adoptable@0.3.0');
    expect(text).toContain('fit 50%');
    expect(text).toContain('edited');
    expect(text).toContain('b.ts');
    expect(text).toContain('untracked');
    expect(text).toContain('mine.md');
    expect(text).not.toContain('missing');
    expect(text).toContain('rm -rf .hex');
  });

  it('truncates long groups and switches header for --dry-run', () => {
    const paths = Array.from({ length: 15 }, (_, i) => `f${String(i).padStart(2, '0')}.ts`);
    const lf = fakeLockfile(paths);
    const integrity: LockfileIntegrity = { ok: false, modified: paths, missing: [], added: [] };
    const text = formatAdoptText(buildAdoptReport(lf, integrity, { dryRun: true }));
    expect(text).toContain('Fit preview');
    expect(text).toContain('nothing written');
    expect(text).toContain('… and 5 more');
    expect(text).not.toContain('f10.ts'); // 11th sorted entry — beyond MAX_LISTED
    expect(text).not.toContain('rm -rf .hex'); // no reversal hint when nothing was written
  });
});

describe('runAdoptCommand', () => {
  it('adopts a matching project: .hex only, fit 100%', async () => {
    const template = await buildTemplateFixture();
    const project = await buildMatchingProject();
    const cap = captureEffects(template);

    await runAdoptCommand(project, 'adoptable', cap.effects, {});

    expect(cap.exitCodes).toEqual([]);
    expect(cap.stderr).toEqual([]);
    expect(existsSync(join(project, '.hex', 'lockfile.yaml'))).toBe(true);
    expect(existsSync(join(project, '.hex', 'pristine', 'package.json'))).toBe(true);
    expect(cap.stdout.join('')).toContain('fit 100%');
  });

  it('writes a schema-valid lockfile recording answers and files', async () => {
    const template = await buildTemplateFixture();
    const project = await buildMatchingProject();
    const cap = captureEffects(template);

    await runAdoptCommand(project, 'adoptable', cap.effects, {});

    const lock = lockfileSchema.parse(
      parseYaml(await readFile(join(project, '.hex', 'lockfile.yaml'), 'utf8')),
    );
    expect(lock.root).toMatchObject({ name: 'adoptable', version: '0.3.0', type: 'component' });
    expect(lock.root.source.kind).toBe('file');
    expect(lock.answers).toEqual({ project_name: 'my-app' });
    expect(lock.files.map((f) => f.path).sort()).toEqual(['package.json', 'src/index.ts']);
  });

  it('records PRISTINE hashes for edited files, not the project bytes', async () => {
    const template = await buildTemplateFixture();
    const project = await buildMatchingProject();
    // User edit: diverge from what the template renders.
    await writeFile(join(project, 'src', 'index.ts'), 'export const x = 2; // edited\n', 'utf8');
    const cap = captureEffects(template);

    await runAdoptCommand(project, 'adoptable', cap.effects, {});

    // Pristine holds template content...
    expect(await readFile(join(project, '.hex', 'pristine', 'src', 'index.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
    // ...and the lockfile hash matches pristine, not the edited project file.
    const lock = lockfileSchema.parse(
      parseYaml(await readFile(join(project, '.hex', 'lockfile.yaml'), 'utf8')),
    );
    const pristineHashes = new Map(
      (await hashTree(join(project, '.hex', 'pristine'))).map((f) => [f.path, f.sha256]),
    );
    const entry = lock.files.find((f) => f.path === 'src/index.ts');
    expect(entry?.sha256).toBe(pristineHashes.get('src/index.ts'));
    // The report calls it edited.
    expect(cap.stdout.join('')).toContain('edited');
  });

  it('is non-destructive: project tree unchanged, only .hex added', async () => {
    const template = await buildTemplateFixture();
    const project = await buildMatchingProject();
    await writeFileEnsure(join(project, 'notes.md'), 'mine\n');
    const before = await hashTree(project); // hashTree already excludes .hex
    const topBefore = (await readdir(project)).sort();
    const cap = captureEffects(template);

    await runAdoptCommand(project, 'adoptable', cap.effects, {});

    expect(await hashTree(project)).toEqual(before);
    const topAfter = (await readdir(project)).sort();
    expect(topAfter).toEqual([...topBefore, '.hex'].sort());
  });

  it('classifies all four ways and emits parseable --json', async () => {
    const template = await buildTemplateFixture();
    const project = await buildMatchingProject();
    await writeFile(join(project, 'src', 'index.ts'), 'edited\n', 'utf8'); // edited
    await rm(join(project, 'package.json')); // missing
    await writeFileEnsure(join(project, 'mine.css'), 'body{}\n'); // untracked
    const cap = captureEffects(template);

    await runAdoptCommand(project, 'adoptable', cap.effects, { json: true });

    const report = JSON.parse(cap.stdout.join('')) as AdoptFitReport;
    expect(report.clean).toEqual([]);
    expect(report.edited).toEqual(['src/index.ts']);
    expect(report.missing).toEqual(['package.json']);
    expect(report.untracked).toEqual(['mine.css']);
    expect(report.fitPercent).toBe(0);
    expect(report.dryRun).toBe(false);
  });

  it('--dry-run leaves zero trace', async () => {
    const template = await buildTemplateFixture();
    const project = await buildMatchingProject();
    const before = await hashTree(project);
    const topBefore = (await readdir(project)).sort();
    const cap = captureEffects(template);

    await runAdoptCommand(project, 'adoptable', cap.effects, { dryRun: true });

    expect(cap.exitCodes).toEqual([]);
    expect(existsSync(join(project, '.hex'))).toBe(false);
    expect(await hashTree(project)).toEqual(before);
    expect((await readdir(project)).sort()).toEqual(topBefore);
    expect(cap.stdout.join('')).toContain('Fit preview');
  });

  const writeExistingLockfile = (project: string): Promise<void> =>
    writeFileEnsure(
      join(project, '.hex', 'lockfile.yaml'),
      [
        'schema_version: 1',
        'hex_version: 1.0.0',
        'generated_at: 2026-08-02T00:00:00.000Z',
        'root:',
        '  name: adoptable',
        '  version: 0.3.0',
        '  type: component',
        '  source: { kind: file, path: /tmp/t }',
        'children: []',
        'answers: {}',
        'files: []',
        '',
      ].join('\n'),
    );

  /** The scripted prompter plus a scripted re-adopt confirm. */
  const readoptPrompter = (confirmAnswer: boolean): Prompter => ({
    ...scriptedPrompter({ project_name: 'my-app' }),
    async confirm(opts) {
      if (!opts.message.includes('re-adopt'))
        throw new Error(`unexpected confirm: ${opts.message}`);
      return confirmAnswer;
    },
  });

  it('asks before re-adopting; declining leaves everything unchanged (A5)', async () => {
    const template = await buildTemplateFixture();
    const project = await buildMatchingProject();
    await writeExistingLockfile(project);
    const before = await readFile(join(project, '.hex', 'lockfile.yaml'), 'utf8');
    const cap = captureEffects(template, readoptPrompter(false));

    await runAdoptCommand(project, 'adoptable', cap.effects, {});

    expect(cap.exitCodes).toEqual([]);
    expect(cap.stdout.join('')).toContain('re-adopt declined — nothing changed');
    expect(cap.shadowDirs).toEqual([]); // declined before any render
    expect(await readFile(join(project, '.hex', 'lockfile.yaml'), 'utf8')).toBe(before);
  });

  it('re-adopts on confirm: the previous adoption is replaced wholesale (A5)', async () => {
    const template = await buildTemplateFixture();
    const project = await buildMatchingProject();
    // First adoption records my-app.
    const first = captureEffects(template);
    await runAdoptCommand(project, 'adoptable', first.effects, {});
    expect(first.exitCodes).toEqual([]);

    // Re-adopt with DIFFERENT answers: confirm yes, then other-app.
    const prompter: Prompter = {
      ...scriptedPrompter({ project_name: 'other-app' }),
      async confirm() {
        return true;
      },
    };
    const cap = captureEffects(template, prompter);
    await runAdoptCommand(project, 'adoptable', cap.effects, {});

    expect(cap.exitCodes).toEqual([]);
    const lock = lockfileSchema.parse(
      parseYaml(await readFile(join(project, '.hex', 'lockfile.yaml'), 'utf8')),
    );
    expect(lock.answers).toEqual({ project_name: 'other-app' });
    // The project still holds my-app bytes, so the new baseline calls
    // package.json edited — the merge base genuinely reset.
    expect(cap.stdout.join('')).toContain('edited');
  });

  it('answers mode refuses re-adopt without --readopt, replaces with it (A5)', async () => {
    const template = await buildTemplateFixture();
    const project = await buildMatchingProject();
    await writeExistingLockfile(project);
    const answersFile = join(work, 'readopt-answers.yaml');
    await writeFileEnsure(answersFile, 'project_name: my-app\n');

    const refused = captureEffects(template);
    await runAdoptCommand(project, 'adoptable', refused.effects, { answers: answersFile });
    expect(refused.exitCodes).toEqual([1]);
    expect(refused.stderr.join('')).toMatch(/--readopt/);
    expect(refused.shadowDirs).toEqual([]);

    const replaced = captureEffects(template);
    await runAdoptCommand(project, 'adoptable', replaced.effects, {
      answers: answersFile,
      readopt: true,
    });
    expect(replaced.exitCodes).toEqual([]);
    expect(replaced.stdout.join('')).toContain('Adopted');
    expect(replaced.stderr.join('')).toContain('re-adopting over adoptable@0.3.0');
  });

  it('hard-refuses from a nested subdirectory of a hex app', async () => {
    const template = await buildTemplateFixture();
    const project = await buildMatchingProject();
    await writeExistingLockfile(project);
    const cap = captureEffects(template, readoptPrompter(true));

    await runAdoptCommand(join(project, 'src'), 'adoptable', cap.effects, {});

    expect(cap.exitCodes).toEqual([1]);
    expect(cap.stderr.join('')).toMatch(/inside a hex app/);
    expect(cap.shadowDirs).toEqual([]);
  });

  it('refuses (does not crash) on a malformed existing lockfile', async () => {
    const template = await buildTemplateFixture();
    const project = await buildMatchingProject();
    await writeFileEnsure(join(project, '.hex', 'lockfile.yaml'), '{{{{ not yaml');
    const cap = captureEffects(template);

    await runAdoptCommand(project, 'adoptable', cap.effects, {});

    expect(cap.exitCodes).toEqual([1]);
    expect(cap.stderr.join('')).toMatch(/unreadable/);
    expect(cap.shadowDirs).toEqual([]);
  });

  it('refuses recipes with a clear message', async () => {
    const recipeRoot = join(work, 'recipe');
    await writeManifest(
      recipeRoot,
      `type: recipe
name: workspace
version: 0.1.0
composes:
  api: file:../nowhere
`,
    );
    const project = await buildMatchingProject();
    const cap = captureEffects(recipeRoot);

    await runAdoptCommand(project, 'workspace', cap.effects, {});

    expect(cap.exitCodes).toEqual([1]);
    expect(cap.stderr.join('')).toMatch(/not yet supported by hex adopt/);
    expect(existsSync(join(project, '.hex'))).toBe(false);
  });

  it('refuses a template that renders zero files', async () => {
    const emptyRoot = join(work, 'empty-template');
    await writeManifest(
      emptyRoot,
      `type: component
name: empty
version: 0.1.0
`,
    );
    const project = await buildMatchingProject();
    const cap = captureEffects(emptyRoot);

    await runAdoptCommand(project, 'empty', cap.effects, {});

    expect(cap.exitCodes).toEqual([1]);
    expect(cap.stderr.join('')).toMatch(/zero files/);
    expect(existsSync(join(project, '.hex'))).toBe(false);
  });

  it('--answers: adopts headless from a YAML file', async () => {
    const template = await buildTemplateFixture();
    const project = await buildMatchingProject();
    await writeFileEnsure(join(work, 'answers.yaml'), 'project_name: my-app\n');
    const cap = captureEffects(template);

    await runAdoptCommand(project, 'adoptable', cap.effects, {
      answers: join(work, 'answers.yaml'),
    });

    expect(cap.exitCodes).toEqual([]);
    expect(cap.stdout.join('')).toContain('fit 100%');
  });

  it('--answers: missing required prompt value exits 1 with the prompt named', async () => {
    const template = await buildTemplateFixture();
    const project = await buildMatchingProject();
    await writeFileEnsure(join(work, 'answers.yaml'), 'unrelated: value\n');
    const cap = captureEffects(template);

    await runAdoptCommand(project, 'adoptable', cap.effects, {
      answers: join(work, 'answers.yaml'),
    });

    expect(cap.exitCodes).toEqual([1]);
    expect(cap.stderr.join('')).toMatch(/project_name/);
    expect(existsSync(join(project, '.hex'))).toBe(false);
  });

  it('--answers: requires a template argument; missing file exits 1', async () => {
    const template = await buildTemplateFixture();
    const project = await buildMatchingProject();

    const noArg = captureEffects(template);
    await runAdoptCommand(project, undefined, noArg.effects, { answers: 'answers.yaml' });
    expect(noArg.exitCodes).toEqual([1]);
    expect(noArg.stderr.join('')).toMatch(/requires a template argument/);

    const missingFile = captureEffects(template);
    await runAdoptCommand(project, 'adoptable', missingFile.effects, {
      answers: join(work, 'nope.yaml'),
    });
    expect(missingFile.exitCodes).toEqual([1]);
    expect(existsSync(join(project, '.hex'))).toBe(false);
  });

  it('propagates PromptCancelledError (exit-130 path) without writing .hex', async () => {
    const template = await buildTemplateFixture();
    const project = await buildMatchingProject();
    const cancelling: Prompter = {
      ...scriptedPrompter({}),
      async text() {
        throw new PromptCancelledError();
      },
    };
    const cap = captureEffects(template, cancelling);

    await expect(runAdoptCommand(project, 'adoptable', cap.effects, {})).rejects.toThrow(
      PromptCancelledError,
    );
    expect(existsSync(join(project, '.hex'))).toBe(false);
  });

  it('cleans the shadow dir after success and after a mid-shadow failure', async () => {
    const template = await buildTemplateFixture();
    const project = await buildMatchingProject();

    const ok = captureEffects(template);
    await runAdoptCommand(project, 'adoptable', ok.effects, {});
    expect(ok.shadowDirs).toHaveLength(1);
    expect(existsSync(ok.shadowDirs[0] as string)).toBe(false);

    // Failure mid-shadow: template whose declarative hook renames a
    // missing file → renderBundle throws after the shadow dir exists.
    const brokenRoot = join(work, 'broken');
    await writeManifest(
      brokenRoot,
      `type: component
name: broken
version: 0.1.0
hooks:
  post_render:
    - rename: { from: does-not-exist.txt, to: x.txt }
`,
    );
    await writeFileEnsure(join(brokenRoot, 'file.txt'), 'x\n');
    const fresh = await buildMatchingProject('project-2');
    const bad = captureEffects(brokenRoot);
    await expect(runAdoptCommand(fresh, 'broken', bad.effects, {})).rejects.toThrow();
    expect(bad.shadowDirs).toHaveLength(1);
    expect(existsSync(bad.shadowDirs[0] as string)).toBe(false);
    expect(existsSync(join(fresh, '.hex'))).toBe(false);
  });
});
