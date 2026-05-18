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

describe('runUpgrade — user-tree migrations', () => {
  /** A fresh migrations dir holding one named migration file. */
  async function migrationsWith(name: string, body: string): Promise<string> {
    const dir = await mkdtemp(join(work, 'migrations-'));
    await writeFile(join(dir, name), body, 'utf8');
    return dir;
  }

  it('routes a user-tree JS migration against the working copy', async () => {
    const app = await makeApp({
      'src/a.ts': "import x from 'old-pkg';\n",
      'src/b.ts': "import y from 'old-pkg';\n",
    });
    // Pristine trees identical at both versions — the 3-way merge is a
    // clean no-op, so only the codemod touches the tree.
    const tree = {
      'src/a.ts': "import x from 'old-pkg';\n",
      'src/b.ts': "import y from 'old-pkg';\n",
    };
    const migrations = await migrationsWith(
      '1.0.0-to-2.0.0.user.js',
      `for (var i = 0, names = project.list('src'); i < names.length; i++) {
  var p = 'src/' + names[i];
  project.write(p, project.read(p).replace('old-pkg', 'new-pkg'));
}`,
    );
    const env: UpgradeEnvironment = {
      ...envFrom({ '1.0.0': tree, '2.0.0': tree }),
      migrationsDirFor: async (to) => (to === '2.0.0' ? migrations : null),
    };

    const outcome = await runUpgrade({ appRoot: app, target: '2.0.0', environment: env });

    expect(outcome.status).toBe('clean');
    expect(outcome.userTreeChanges).toEqual(['src/a.ts', 'src/b.ts']);
    expect(await readApp(app, 'src/a.ts')).toBe("import x from 'new-pkg';\n");
    expect(await readApp(app, 'src/b.ts')).toBe("import y from 'new-pkg';\n");
    expect(await lockfileVersion(app)).toBe('2.0.0');
  });

  it('records the user-tree changes in upgrade-state on the conflict path', async () => {
    const app = await makeApp({
      'a.txt': 'line1\nuser-edit\nline3\n',
      'src/imp.ts': "import x from 'old-pkg';\n",
    });
    const migrations = await migrationsWith(
      '1.0.0-to-2.0.0.user.js',
      "project.write('src/imp.ts', project.read('src/imp.ts').replace('old-pkg', 'new-pkg'));",
    );
    const env: UpgradeEnvironment = {
      ...envFrom({
        '1.0.0': {
          'a.txt': 'line1\noriginal\nline3\n',
          'src/imp.ts': "import x from 'old-pkg';\n",
        },
        '2.0.0': {
          'a.txt': 'line1\ntemplate-edit\nline3\n',
          'src/imp.ts': "import x from 'old-pkg';\n",
        },
      }),
      migrationsDirFor: async (to) => (to === '2.0.0' ? migrations : null),
    };

    const outcome = await runUpgrade({ appRoot: app, target: '2.0.0', environment: env });

    expect(outcome.status).toBe('conflict');
    expect(outcome.userTreeChanges).toEqual(['src/imp.ts']);
    expect(await readApp(app, 'src/imp.ts')).toBe("import x from 'new-pkg';\n");

    const state = parseYaml(await readFile(join(app, '.hex', 'upgrade-state.yaml'), 'utf8')) as {
      user_tree_changes: string[];
    };
    expect(state.user_tree_changes).toEqual(['src/imp.ts']);
  });
});

describe('runUpgrade — orphan handling', () => {
  it('keeps an edited file the upgrade removed and records it as an orphan', async () => {
    const app = await makeApp({ 'a.txt': 'same\n', 'keep.txt': 'my edits\n' });
    const env = envFrom({
      '1.0.0': { 'a.txt': 'same\n', 'keep.txt': 'generated\n' },
      '2.0.0': { 'a.txt': 'same\n' },
    });

    const outcome = await runUpgrade({ appRoot: app, target: '2.0.0', environment: env });

    expect(outcome.status).toBe('clean');
    expect(outcome.orphans).toEqual(['keep.txt']);
    // The user's edited copy is left in place untouched.
    expect(await readApp(app, 'keep.txt')).toBe('my edits\n');

    // The lockfile records the orphan so doctor / a later upgrade can
    // tell it apart from template-owned files.
    const lf = parseYaml(await readFile(join(app, '.hex', 'lockfile.yaml'), 'utf8')) as {
      orphans?: string[];
    };
    expect(lf.orphans).toEqual(['keep.txt']);
  });

  it('deletes the orphan when the onOrphan callback elects delete', async () => {
    const app = await makeApp({ 'a.txt': 'same\n', 'keep.txt': 'my edits\n' });
    const env = envFrom({
      '1.0.0': { 'a.txt': 'same\n', 'keep.txt': 'generated\n' },
      '2.0.0': { 'a.txt': 'same\n' },
    });

    const outcome = await runUpgrade({
      appRoot: app,
      target: '2.0.0',
      environment: env,
      onOrphan: async () => 'delete',
    });

    expect(outcome.orphans).toEqual([]);
    expect(existsSync(join(app, 'keep.txt'))).toBe(false);
    const lf = parseYaml(await readFile(join(app, '.hex', 'lockfile.yaml'), 'utf8')) as {
      orphans?: string[];
    };
    expect(lf.orphans).toBeUndefined();
  });
});

describe('runUpgrade — pristine migrations', () => {
  /** A fresh migrations dir holding one named migration file. */
  async function migrationsWith(name: string, body: string): Promise<string> {
    const dir = await mkdtemp(join(work, 'migrations-'));
    await writeFile(join(dir, name), body, 'utf8');
    return dir;
  }

  it('carries a user edit across a declarative rename migration', async () => {
    const app = await makeApp({ 'old.txt': 'top\nkeep1\nkeep2\nmid\nbottom\n' });
    // The user edits the file the migration is about to rename, at a line
    // well clear of the line the template changes.
    await writeFile(join(app, 'old.txt'), 'top\nkeep1\nkeep2\nMINE\nbottom\n', 'utf8');

    const migrations = await migrationsWith(
      '1.0.0-to-2.0.0.yaml',
      'steps:\n  - rename:\n      from: old.txt\n      to: new.txt\n',
    );
    const env: UpgradeEnvironment = {
      // The template renders the post-rename name with its own change.
      ...envFrom({
        '1.0.0': { 'old.txt': 'top\nkeep1\nkeep2\nmid\nbottom\n' },
        '2.0.0': { 'new.txt': 'TOP\nkeep1\nkeep2\nmid\nbottom\n' },
      }),
      migrationsDirFor: async (to) => (to === '2.0.0' ? migrations : null),
    };

    const outcome = await runUpgrade({ appRoot: app, target: '2.0.0', environment: env });

    expect(outcome.status).toBe('clean');
    expect(existsSync(join(app, 'old.txt'))).toBe(false);
    // The user's edit and the template's change both land in the renamed file.
    expect(await readApp(app, 'new.txt')).toBe('TOP\nkeep1\nkeep2\nMINE\nbottom\n');
  });

  it('removes an untouched file via a declarative delete migration', async () => {
    const app = await makeApp({ 'a.txt': 'a\n', 'gone.txt': 'bye\n' });
    const migrations = await migrationsWith(
      '1.0.0-to-2.0.0.yaml',
      'steps:\n  - delete: gone.txt\n',
    );
    const env: UpgradeEnvironment = {
      ...envFrom({
        '1.0.0': { 'a.txt': 'a\n', 'gone.txt': 'bye\n' },
        '2.0.0': { 'a.txt': 'a\n', 'gone.txt': 'bye\n' },
      }),
      migrationsDirFor: async (to) => (to === '2.0.0' ? migrations : null),
    };

    const outcome = await runUpgrade({ appRoot: app, target: '2.0.0', environment: env });

    expect(outcome.status).toBe('clean');
    expect(outcome.merge.deleted).toEqual(['gone.txt']);
    expect(existsSync(join(app, 'gone.txt'))).toBe(false);
  });
});
