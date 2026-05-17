import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { buildLockfile, writeLockfile } from '../../../src/core/lockfile/index.js';
import type { ComponentBundle } from '../../../src/core/sources/file-source.js';
import {
  type UpgradeEnvironment,
  UpgradeError,
  abortUpgrade,
  continueUpgrade,
  runUpgrade,
} from '../../../src/core/upgrade/run.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-run-test-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }
  await mkdir(dir, { recursive: true });
}

function fakeBundle(): ComponentBundle {
  return {
    manifest: { type: 'component', name: 'app', version: '1.0.0' },
    rootPath: '/srv/templates/app',
    jsHookSources: {},
    sourceKind: 'file',
  };
}

/** A generated app at v1.0.0 whose lockfile matches its tree. */
async function makeApp(files: Record<string, string>): Promise<string> {
  const dir = join(work, 'app');
  await writeTree(dir, files);
  const lockfile = await buildLockfile({ bundle: fakeBundle(), answers: {}, outputDir: dir });
  await writeLockfile(dir, lockfile);
  return dir;
}

/**
 * An environment whose `pristineFor` copies a prebuilt tree into a fresh
 * temp dir each call — the chain walker owns and deletes those dirs.
 */
function envFrom(trees: Record<string, Record<string, string>>): UpgradeEnvironment {
  return {
    availableVersions: Object.keys(trees),
    async pristineFor(version) {
      const files = trees[version];
      if (!files) throw new Error(`no prebuilt tree for ${version}`);
      const dir = await mkdtemp(join(work, `pristine-${version}-`));
      await writeTree(dir, files);
      return dir;
    },
  };
}

async function readApp(app: string, rel: string): Promise<string> {
  return readFile(join(app, rel), 'utf8');
}

async function lockfileVersion(app: string): Promise<string> {
  const doc = parseYaml(await readFile(join(app, '.hex', 'lockfile.yaml'), 'utf8')) as {
    root: { version: string };
  };
  return doc.root.version;
}

describe('runUpgrade — happy path', () => {
  it('cleanly merges and rewrites the lockfile at the new version', async () => {
    const app = await makeApp({ 'a.txt': 'v1\n', 'keep.txt': 'same\n' });
    const env = envFrom({
      '1.0.0': { 'a.txt': 'v1\n', 'keep.txt': 'same\n' },
      '2.0.0': { 'a.txt': 'v2\n', 'keep.txt': 'same\n', 'new.txt': 'fresh\n' },
    });

    const outcome = await runUpgrade({ appRoot: app, target: '2.0.0', environment: env });

    expect(outcome.status).toBe('clean');
    expect(await readApp(app, 'a.txt')).toBe('v2\n');
    expect(await readApp(app, 'new.txt')).toBe('fresh\n');
    expect(await lockfileVersion(app)).toBe('2.0.0');
    // No upgrade-state file and no leftover snapshot on a clean run.
    expect(existsSync(join(app, '.hex', 'upgrade-state.yaml'))).toBe(false);
    expect(existsSync(join(app, '.hex', 'upgrade-backup'))).toBe(false);
  });

  it('refuses to start when an upgrade is already in progress', async () => {
    const app = await makeApp({ 'a.txt': 'v1\n' });
    await writeFile(
      join(app, '.hex', 'upgrade-state.yaml'),
      'schema_version: 1\nfrom: 1.0.0\nto: 2.0.0\nconflicts: []\n',
      'utf8',
    );
    const env = envFrom({ '1.0.0': { 'a.txt': 'v1\n' }, '2.0.0': { 'a.txt': 'v2\n' } });
    await expect(runUpgrade({ appRoot: app, target: '2.0.0', environment: env })).rejects.toThrow(
      /already in progress/,
    );
  });
});

describe('runUpgrade — conflict path', () => {
  it('writes markers, persists upgrade state, and reports the conflict', async () => {
    // User edited a.txt; the template also changed the same line.
    const app = await makeApp({ 'a.txt': 'line1\nuser-edit\nline3\n' });
    const env = envFrom({
      '1.0.0': { 'a.txt': 'line1\noriginal\nline3\n' },
      '2.0.0': { 'a.txt': 'line1\ntemplate-edit\nline3\n' },
    });

    const outcome = await runUpgrade({ appRoot: app, target: '2.0.0', environment: env });

    expect(outcome.status).toBe('conflict');
    expect(outcome.status === 'conflict' && outcome.conflicts).toEqual(['a.txt']);

    const merged = await readApp(app, 'a.txt');
    expect(merged).toContain('<<<<<<<');
    expect(merged).toContain('>>>>>>> hex 2.0.0');

    // State persisted; lockfile NOT yet bumped; snapshot retained for --abort.
    const state = parseYaml(await readFile(join(app, '.hex', 'upgrade-state.yaml'), 'utf8')) as {
      from: string;
      to: string;
      conflicts: string[];
    };
    expect(state).toMatchObject({ from: '1.0.0', to: '2.0.0', conflicts: ['a.txt'] });
    expect(await lockfileVersion(app)).toBe('1.0.0');
    expect(existsSync(join(app, '.hex', 'upgrade-backup'))).toBe(true);
  });
});

describe('continueUpgrade', () => {
  it('finalises once the user has resolved the markers', async () => {
    const app = await makeApp({ 'a.txt': 'line1\nuser-edit\nline3\n' });
    const env = envFrom({
      '1.0.0': { 'a.txt': 'line1\noriginal\nline3\n' },
      '2.0.0': { 'a.txt': 'line1\ntemplate-edit\nline3\n' },
    });
    await runUpgrade({ appRoot: app, target: '2.0.0', environment: env });

    // User resolves the conflict by hand.
    await writeFile(join(app, 'a.txt'), 'line1\nresolved\nline3\n', 'utf8');

    const { from, to } = await continueUpgrade(app);
    expect([from, to]).toEqual(['1.0.0', '2.0.0']);
    expect(await lockfileVersion(app)).toBe('2.0.0');
    expect(existsSync(join(app, '.hex', 'upgrade-state.yaml'))).toBe(false);
    expect(existsSync(join(app, '.hex', 'upgrade-backup'))).toBe(false);
  });

  it('refuses while conflict markers remain unresolved', async () => {
    const app = await makeApp({ 'a.txt': 'line1\nuser-edit\nline3\n' });
    const env = envFrom({
      '1.0.0': { 'a.txt': 'line1\noriginal\nline3\n' },
      '2.0.0': { 'a.txt': 'line1\ntemplate-edit\nline3\n' },
    });
    await runUpgrade({ appRoot: app, target: '2.0.0', environment: env });

    // The user has NOT touched the marker-laden file.
    await expect(continueUpgrade(app)).rejects.toThrow(/unresolved conflict markers/);
    expect(await lockfileVersion(app)).toBe('1.0.0');
  });

  it('errors when there is no upgrade in progress', async () => {
    const app = await makeApp({ 'a.txt': 'v1\n' });
    await expect(continueUpgrade(app)).rejects.toThrow(UpgradeError);
  });
});

describe('abortUpgrade', () => {
  it('rolls the working tree back to its pre-upgrade state', async () => {
    const app = await makeApp({ 'a.txt': 'line1\nuser-edit\nline3\n', 'keep.txt': 'mine\n' });
    const env = envFrom({
      '1.0.0': { 'a.txt': 'line1\noriginal\nline3\n' },
      '2.0.0': { 'a.txt': 'line1\ntemplate-edit\nline3\n', 'added.txt': 'new\n' },
    });
    await runUpgrade({ appRoot: app, target: '2.0.0', environment: env });
    // Mid-upgrade the tree carries markers + the template's new file.
    expect((await readApp(app, 'a.txt')).includes('<<<<<<<')).toBe(true);
    expect(existsSync(join(app, 'added.txt'))).toBe(true);

    const { from, to } = await abortUpgrade(app);
    expect([from, to]).toEqual(['1.0.0', '2.0.0']);

    // Working tree restored exactly; the upgrade left nothing behind.
    expect(await readApp(app, 'a.txt')).toBe('line1\nuser-edit\nline3\n');
    expect(await readApp(app, 'keep.txt')).toBe('mine\n');
    expect(existsSync(join(app, 'added.txt'))).toBe(false);
    expect(existsSync(join(app, '.hex', 'upgrade-state.yaml'))).toBe(false);
    expect(existsSync(join(app, '.hex', 'upgrade-backup'))).toBe(false);
    expect(await lockfileVersion(app)).toBe('1.0.0');
  });

  it('errors when there is no upgrade in progress', async () => {
    const app = await makeApp({ 'a.txt': 'v1\n' });
    await expect(abortUpgrade(app)).rejects.toThrow(UpgradeError);
  });
});
