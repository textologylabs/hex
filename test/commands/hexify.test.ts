import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type HexifyCommandEffects,
  type HexifyReport,
  buildHexifyReport,
  formatHexifyText,
  runHexifyCommand,
} from '../../src/commands/hexify.js';
import { buildPlan } from '../../src/core/hexify/pipeline.js';
import type { ScannedFile } from '../../src/core/hexify/pipeline.js';
import { hashTree } from '../../src/core/lockfile/index.js';
import { parseManifestFile } from '../../src/core/manifest/parse.js';
import { PromptCancelledError, type Prompter } from '../../src/core/prompts/types.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-cmd-hexify-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function writeFileEnsure(path: string, body: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}

/**
 * The standard fixture: a plain "manually maintained template" repo.
 * package.json carries the auto-candidate seeds; one filename carries
 * the project name; the workflow file is a pure escape hazard.
 */
async function buildRepoFixture(): Promise<string> {
  const repo = join(work, 'repo');
  await writeFileEnsure(
    join(repo, 'package.json'),
    '{\n  "name": "acme-portal",\n  "description": "The Acme portal",\n  "license": "MIT"\n}\n',
  );
  await writeFileEnsure(
    join(repo, 'src', 'acme-portal.config.ts'),
    'export const app = "acme-portal";\n',
  );
  await writeFileEnsure(
    join(repo, '.github', 'workflows', 'ci.yml'),
    'env:\n  TOKEN: ${{ secrets.NPM_TOKEN }}\n',
  );
  await writeFileEnsure(join(repo, 'README.md'), 'plain readme\n');
  await writeFileEnsure(join(repo, '.gitignore'), 'node_modules/\ndist/\n');
  return repo;
}

/**
 * A prompter that takes every default: candidate confirms default to
 * yes, the custom-param loop defaults to no, the final write confirm
 * defaults to yes — so the unscripted happy path IS the default path.
 * Overrides match on a message substring.
 */
function scriptedPrompter(
  overrides: {
    confirms?: Array<{ match: string; answer: boolean }>;
    texts?: Array<{ match: string; answer: string }>;
  } = {},
): { prompter: Prompter; notes: string[] } {
  const notes: string[] = [];
  const prompter: Prompter = {
    async text(opts) {
      const hit = overrides.texts?.find((t) => opts.message.includes(t.match));
      const value = hit ? hit.answer : (opts.default ?? '');
      const problem = opts.validate?.(value);
      if (problem) throw new Error(`scripted text failed validation: ${problem}`);
      return value;
    },
    async confirm(opts) {
      const hit = overrides.confirms?.find((c) => opts.message.includes(c.match));
      return hit ? hit.answer : (opts.default ?? true);
    },
    async select() {
      throw new Error('select not used by hexify');
    },
    async multiselect() {
      throw new Error('multiselect not used by hexify');
    },
    async password() {
      throw new Error('password not used by hexify');
    },
    note(body) {
      notes.push(body);
    },
  };
  return { prompter, notes };
}

function captureEffects(
  prompter: Prompter,
  overrides: Partial<HexifyCommandEffects> = {},
): {
  effects: HexifyCommandEffects;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
  shadowDirs: string[];
} {
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
      gitStatus: async () => ({ isRepo: true, clean: true }),
      makeShadowDir: async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hex-hexify-test-shadow-'));
        shadowDirs.push(dir);
        return dir;
      },
      ...overrides,
    },
  };
}

describe('buildHexifyReport / formatHexifyText', () => {
  const files: ScannedFile[] = [
    { rel: 'package.json', abs: '/x/package.json', binary: false, text: '{"name": "acme"}' },
    { rel: 'src/acme.ts', abs: '/x/src/acme.ts', binary: false, text: 'acme\n' },
  ];
  const plan = buildPlan(
    files,
    [{ name: 'project_name', value: 'acme', description: 'Package name' }],
    'type: component\nname: acme\nversion: 0.1.0\n',
    '.git/\n',
    ['.git/'],
  );
  const okTrip = { ok: true, checked: 2, mismatched: [], onlyInOriginal: [], onlyInRendered: [] };

  it('partitions rewritten vs renamed and carries the param stats', () => {
    const report = buildHexifyReport(plan, okTrip, { dryRun: false });
    expect(report.template).toMatchObject({ name: 'acme', version: '0.1.0' });
    expect(report.filesChanged).toEqual(['package.json']);
    expect(report.renamed).toEqual([{ from: 'src/acme.ts', to: 'src/{{ project_name }}.ts' }]);
    expect(report.parameters[0]).toMatchObject({ name: 'project_name', value: 'acme' });
    expect(report.parameters[0]?.occurrences.total).toBeGreaterThan(0);
  });

  it('renders success, dry-run, and failure variants', () => {
    const ok = formatHexifyText(buildHexifyReport(plan, okTrip, { dryRun: false }));
    expect(ok).toContain('Hexified');
    expect(ok).toContain('round-trip proof');
    const dry = formatHexifyText(buildHexifyReport(plan, okTrip, { dryRun: true }));
    expect(dry).toContain('preview');
    expect(dry).toContain('nothing written');
    const failed = formatHexifyText(
      buildHexifyReport(
        plan,
        { ok: false, checked: 1, mismatched: ['a.ts'], onlyInOriginal: [], onlyInRendered: [] },
        { dryRun: false },
      ),
    );
    expect(failed).toContain('FAILED');
    expect(failed).toContain('a.ts');
  });
});

describe('runHexifyCommand', () => {
  it('hexifies the fixture repo in place on the default path', async () => {
    const repo = await buildRepoFixture();
    const { prompter } = scriptedPrompter();
    const cap = captureEffects(prompter);

    await runHexifyCommand(repo, cap.effects, {});

    expect(cap.stderr).toEqual([]);
    expect(cap.exitCodes).toEqual([]);

    // Manifest: valid, prompts with the original values as defaults.
    const manifest = await parseManifestFile(join(repo, '.hex', 'manifest.yaml'));
    expect(manifest.type).toBe('component');
    expect(manifest.name).toBe('acme-portal');
    const promptNames = (manifest.prompts ?? []).map((p) => p.name);
    expect(promptNames).toContain('project_name');
    expect(promptNames).toContain('description');
    expect(promptNames).toContain('license');

    // Substitution + rename in place.
    expect(await readFile(join(repo, 'package.json'), 'utf8')).toContain('{{ project_name }}');
    expect(existsSync(join(repo, 'src', '{{ project_name }}.config.ts'))).toBe(true);
    expect(existsSync(join(repo, 'src', 'acme-portal.config.ts'))).toBe(false);

    // Escape-only file rewritten so a render reproduces it.
    const ci = await readFile(join(repo, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toContain("{{ '{' }}");

    // .hexignore generated with defaults + .gitignore inheritance.
    const hexignore = await readFile(join(repo, '.hexignore'), 'utf8');
    expect(hexignore).toContain('.git/');
    expect(hexignore).toContain('dist/');

    // Untouched file stays untouched.
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('plain readme\n');

    expect(cap.stdout.join('')).toContain('Hexified');
    // Shadow cleaned up after success.
    expect(cap.shadowDirs).toHaveLength(1);
    expect(existsSync(cap.shadowDirs[0] ?? '')).toBe(false);
  });

  it('--dry-run runs the full gate and leaves zero trace', async () => {
    const repo = await buildRepoFixture();
    const before = await hashTree(repo);
    const topBefore = (await readdir(repo)).sort();
    const { prompter } = scriptedPrompter();
    const cap = captureEffects(prompter);

    await runHexifyCommand(repo, cap.effects, { dryRun: true, json: true });

    expect(cap.exitCodes).toEqual([]);
    expect(await hashTree(repo)).toEqual(before);
    expect((await readdir(repo)).sort()).toEqual(topBefore);
    expect(existsSync(join(repo, '.hex'))).toBe(false);
    const report = JSON.parse(cap.stdout.join('')) as HexifyReport;
    expect(report.dryRun).toBe(true);
    expect(report.roundTrip.ok).toBe(true);
    expect(report.roundTrip.checked).toBeGreaterThan(0);
  });

  it('emits a parseable --json report with the full shape', async () => {
    const repo = await buildRepoFixture();
    const { prompter } = scriptedPrompter();
    const cap = captureEffects(prompter);

    await runHexifyCommand(repo, cap.effects, { json: true });

    const report = JSON.parse(cap.stdout.join('')) as HexifyReport;
    expect(report.template).toMatchObject({ name: 'acme-portal', version: '0.1.0' });
    expect(report.parameters.map((p) => p.name)).toContain('project_name');
    expect(report.renamed).toEqual([
      { from: 'src/acme-portal.config.ts', to: 'src/{{ project_name }}.config.ts' },
    ]);
    expect(report.filesChanged).toContain('package.json');
    expect(report.filesChanged).toContain('.github/workflows/ci.yml');
    expect(report.roundTrip.ok).toBe(true);
    expect(report.dryRun).toBe(false);
  });

  it('refuses an existing hex template', async () => {
    const repo = await buildRepoFixture();
    await writeFileEnsure(
      join(repo, '.hex', 'manifest.yaml'),
      'type: component\nname: x\nversion: 0.1.0\n',
    );
    const { prompter } = scriptedPrompter();
    const cap = captureEffects(prompter);

    await runHexifyCommand(repo, cap.effects, {});

    expect(cap.exitCodes).toEqual([1]);
    expect(cap.stderr.join('')).toMatch(/already a hex template/);
    expect(cap.shadowDirs).toEqual([]);
  });

  it('refuses a hex app (lockfile present)', async () => {
    const repo = await buildRepoFixture();
    await writeFileEnsure(
      join(repo, '.hex', 'lockfile.yaml'),
      [
        'schema_version: 1',
        'hex_version: 1.0.0',
        'generated_at: 2026-08-02T00:00:00.000Z',
        'root:',
        '  name: someapp',
        '  version: 0.1.0',
        '  type: component',
        '  source: { kind: file, path: /tmp/t }',
        'children: []',
        'answers: {}',
        'files: []',
        '',
      ].join('\n'),
    );
    const { prompter } = scriptedPrompter();
    const cap = captureEffects(prompter);

    await runHexifyCommand(repo, cap.effects, {});

    expect(cap.exitCodes).toEqual([1]);
    expect(cap.stderr.join('')).toMatch(/hex app/);
    expect(cap.shadowDirs).toEqual([]);
  });

  it('refuses (does not crash) on a malformed lockfile', async () => {
    const repo = await buildRepoFixture();
    await writeFileEnsure(join(repo, '.hex', 'lockfile.yaml'), '{{{{ not yaml');
    const { prompter } = scriptedPrompter();
    const cap = captureEffects(prompter);

    await runHexifyCommand(repo, cap.effects, {});

    expect(cap.exitCodes).toEqual([1]);
    expect(cap.stderr.join('')).toMatch(/unreadable/);
  });

  it('refuses outside a git repo, and refuses a dirty tree', async () => {
    const repo = await buildRepoFixture();
    const { prompter } = scriptedPrompter();

    const noRepo = captureEffects(prompter, {
      gitStatus: async () => ({ isRepo: false, clean: false }),
    });
    await runHexifyCommand(repo, noRepo.effects, {});
    expect(noRepo.exitCodes).toEqual([1]);
    expect(noRepo.stderr.join('')).toMatch(/not a git repository/);

    const dirty = captureEffects(prompter, {
      gitStatus: async () => ({ isRepo: true, clean: false }),
    });
    await runHexifyCommand(repo, dirty.effects, {});
    expect(dirty.exitCodes).toEqual([1]);
    expect(dirty.stderr.join('')).toMatch(/not clean/);
    expect(dirty.shadowDirs).toEqual([]);
  });

  it('gate failure writes NOTHING and exits 1 — and still cleans the shadow', async () => {
    const repo = await buildRepoFixture();
    const before = await hashTree(repo);
    const { prompter } = scriptedPrompter();
    const cap = captureEffects(prompter, {
      // The only honest way to fail the gate: corrupt the shadow after
      // the pipeline built it.
      afterShadowBuild: async (shadowTemplateDir) => {
        await appendFile(join(shadowTemplateDir, 'README.md'), 'CORRUPTED\n');
      },
    });

    await runHexifyCommand(repo, cap.effects, { json: true });

    expect(cap.exitCodes).toEqual([1]);
    expect(cap.stderr.join('')).toMatch(/round-trip proof failed/);
    const report = JSON.parse(cap.stdout.join('')) as HexifyReport;
    expect(report.roundTrip.ok).toBe(false);
    expect(report.roundTrip.mismatched).toContain('README.md');
    // Zero trace on the repo.
    expect(await hashTree(repo)).toEqual(before);
    expect(existsSync(join(repo, '.hex'))).toBe(false);
    // Shadow still cleaned.
    expect(existsSync(cap.shadowDirs[0] ?? '')).toBe(false);
  });

  it('a cancel propagates and leaves the repo untouched', async () => {
    const repo = await buildRepoFixture();
    const before = await hashTree(repo);
    const prompter: Prompter = {
      ...scriptedPrompter().prompter,
      async confirm() {
        throw new PromptCancelledError();
      },
    };
    const cap = captureEffects(prompter);

    await expect(runHexifyCommand(repo, cap.effects, {})).rejects.toThrow(PromptCancelledError);
    expect(await hashTree(repo)).toEqual(before);
    expect(existsSync(join(repo, '.hex'))).toBe(false);
    expect(cap.shadowDirs).toEqual([]);
  });

  it('declining the final write confirm aborts cleanly with exit 0', async () => {
    const repo = await buildRepoFixture();
    const { prompter } = scriptedPrompter({
      confirms: [{ match: 'Write the hexified template', answer: false }],
    });
    const cap = captureEffects(prompter);

    await runHexifyCommand(repo, cap.effects, {});

    expect(cap.exitCodes).toEqual([]);
    expect(cap.stdout.join('')).toContain('aborted — nothing written');
    expect(existsSync(join(repo, '.hex'))).toBe(false);
    expect(cap.shadowDirs).toEqual([]);
  });

  it('declining the zero-param fallback writes nothing', async () => {
    const repo = join(work, 'plain');
    await writeFileEnsure(join(repo, 'README.md'), 'no candidates here\n');
    const { prompter } = scriptedPrompter({
      confirms: [{ match: 'hexify anyway', answer: false }],
    });
    const cap = captureEffects(prompter);

    await runHexifyCommand(repo, cap.effects, {});

    expect(cap.exitCodes).toEqual([]);
    expect(cap.stdout.join('')).toContain('nothing hexified');
    expect(existsSync(join(repo, '.hex'))).toBe(false);
  });

  it('--against refuses a path that is not a directory', async () => {
    const repo = await buildRepoFixture();
    const { prompter } = scriptedPrompter();
    const cap = captureEffects(prompter);

    await runHexifyCommand(repo, cap.effects, { against: join(work, 'no-such-dir') });

    expect(cap.exitCodes).toEqual([1]);
    expect(cap.stderr.join('')).toMatch(/--against path is not a directory/);
    expect(cap.shadowDirs).toEqual([]);
  });

  it('--against mines instance pairs, proposes with evidence, and skips seed duplicates', async () => {
    const repo = await buildRepoFixture();
    // A value package.json seeding can never discover.
    await writeFileEnsure(
      join(repo, 'conf', 'service.yaml'),
      'service: acme-portal-svc\nowner: platform-team\n',
    );
    // The "manually instantiated" project: same shape, values swapped,
    // plus genuine drift.
    const instance = join(work, 'instance');
    await writeFileEnsure(
      join(instance, 'package.json'),
      '{\n  "name": "zed-portal",\n  "description": "The Acme portal",\n  "license": "MIT"\n}\n',
    );
    await writeFileEnsure(
      join(instance, 'src', 'zed-portal.config.ts'),
      'export const app = "zed-portal";\n',
    );
    await writeFileEnsure(
      join(instance, 'conf', 'service.yaml'),
      'service: zed-portal-svc\nowner: platform-team\nannotations: added-by-team\n',
    );
    await writeFileEnsure(join(instance, 'README.md'), 'plain readme\n');

    const { prompter } = scriptedPrompter();
    const confirmMessages: string[] = [];
    const baseConfirm = prompter.confirm.bind(prompter);
    prompter.confirm = async (opts) => {
      confirmMessages.push(opts.message);
      return baseConfirm(opts);
    };
    const cap = captureEffects(prompter);

    await runHexifyCommand(repo, cap.effects, { against: instance });

    expect(cap.stderr).toEqual([]);
    expect(cap.exitCodes).toEqual([]);

    // The mined pair was proposed WITH its instance evidence, and the
    // accepted parameter landed in the manifest under the suggested name.
    expect(confirmMessages.some((m) => m.includes('↔ "zed-portal-svc"'))).toBe(true);
    const manifest = await parseManifestFile(join(repo, '.hex', 'manifest.yaml'));
    expect(manifest.prompts?.map((p) => p.name)).toContain('acme_portal_svc');
    expect(await readFile(join(repo, 'conf', 'service.yaml'), 'utf8')).toBe(
      'service: {{ acme_portal_svc }}\nowner: platform-team\n',
    );

    // "acme-portal" was already accepted from the package.json seeds —
    // the identical mined pair must NOT be re-proposed.
    const minedProposals = confirmMessages.filter((m) => m.includes('↔ "'));
    expect(minedProposals.some((m) => m.includes('"acme-portal"?'))).toBe(false);
  });

  it('works without a package.json via the custom-parameter loop', async () => {
    const repo = join(work, 'no-pkg');
    await writeFileEnsure(join(repo, 'conf.txt'), 'endpoint: special-sauce.internal\n');
    let addAsked = 0;
    const { prompter } = scriptedPrompter({
      confirms: [{ match: 'Add a custom parameter', answer: true }],
      texts: [
        { match: 'Concrete value', answer: 'special-sauce' },
        { match: 'Prompt name', answer: 'service_name' },
      ],
    });
    // First "add another?" yes, second no — wrap confirm to count.
    const base = prompter.confirm.bind(prompter);
    prompter.confirm = async (opts) => {
      if (opts.message.includes('Add a custom parameter')) {
        addAsked++;
        return addAsked === 1;
      }
      return base(opts);
    };
    const cap = captureEffects(prompter);

    await runHexifyCommand(repo, cap.effects, {});

    expect(cap.exitCodes).toEqual([]);
    const manifest = await parseManifestFile(join(repo, '.hex', 'manifest.yaml'));
    // No package.json → template name defaults to the directory name.
    expect(manifest.name).toBe(basename(repo));
    expect(manifest.prompts?.map((p) => p.name)).toEqual(['service_name']);
    expect(await readFile(join(repo, 'conf.txt'), 'utf8')).toBe(
      'endpoint: {{ service_name }}.internal\n',
    );
  });
});
