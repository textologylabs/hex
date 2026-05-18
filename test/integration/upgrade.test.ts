import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  buildLockfile,
  checkLockfileIntegrity,
  readLockfileUpward,
  writeLockfile,
} from '../../src/core/lockfile/index.js';
import { renderBundle } from '../../src/core/render/engine.js';
import { loadFromPath } from '../../src/core/sources/file-source.js';
import {
  type UpgradeEnvironment,
  continueUpgrade,
  runUpgrade,
} from '../../src/core/upgrade/run.js';

/**
 * End-to-end upgrade integration test (M11.8) — dogfood for the
 * M11.1–M11.7 stack.
 *
 * Stages a fixture component template across three versions, renders
 * v1.0.0 into a user app, edits files, then runs `runUpgrade` to
 * v2.0.0. The chain walker visits both hops (1.0.0→1.1.0→2.0.0); the
 * composed migration chain — a `rename` shipped by v1.1.0, a `delete` +
 * `replace` shipped by v2.0.0 — realigns the trees so the 3-way merge
 * carries the user's edits across, even through the rename; the
 * lockfile is rewritten at v2.0.0.
 */

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-int-upgrade-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }
}

/** Stage a versioned fixture template at `<work>/template-<version>`. */
async function writeTemplate(
  version: string,
  files: Record<string, string>,
  migrations: Record<string, string> = {},
): Promise<string> {
  const dir = join(work, `template-${version}`);
  await mkdir(join(dir, '.hex'), { recursive: true });
  await writeFile(
    join(dir, '.hex', 'manifest.yaml'),
    `type: component\nname: demo-upgrade-fixture\nversion: ${version}\n`,
    'utf8',
  );
  await writeFiles(dir, files);
  for (const [name, body] of Object.entries(migrations)) {
    const path = join(dir, '.hex', 'migrations', name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, body, 'utf8');
  }
  return dir;
}

/** `src/app.ts` at a given version — the VERSION line is the only template change. */
function appSource(version: string): string {
  return `// demo app
export const VERSION = '${version}';

export function greet() {
  return 'hello';
}

export const FOOTER = 'stable';
`;
}

/** The guide doc — the template changes the intro line between v1 and v2. */
function guideDoc(intro: string): string {
  return `Guide
=====

${intro}

usage line
`;
}

/**
 * Stage the three template versions and render the user app at v1.0.0
 * with its lockfile. Returns the app path and the upgrade environment
 * that renders + migrates each version.
 */
async function setup(): Promise<{ app: string; environment: UpgradeEnvironment }> {
  const t1 = await writeTemplate('1.0.0', {
    'README.md': '# Demo v1\n',
    'src/app.ts': appSource('1.0.0'),
    'docs/guide.txt': guideDoc('intro line'),
    'legacy.txt': 'legacy code\n',
    'config/settings.ini': 'mode=basic\n',
  });
  // v1.1.0 ships a rename migration: docs/guide.txt → docs/handbook.txt.
  const t11 = await writeTemplate(
    '1.1.0',
    {
      'README.md': '# Demo v1.1\n',
      'src/app.ts': appSource('1.1.0'),
      'docs/guide.txt': guideDoc('intro line'),
      'legacy.txt': 'legacy code\n',
      'config/settings.ini': 'mode=basic\n',
    },
    {
      '1.0.0-to-1.1.0.yaml':
        'steps:\n  - rename:\n      from: docs/guide.txt\n      to: docs/handbook.txt\n',
    },
  );
  // v2.0.0 renders the post-rename layout directly + ships a delete/replace
  // migration. The `delete` prunes pristine_new; the `replace` realigns
  // pristine_old + the user tree onto the new path.
  const t2 = await writeTemplate(
    '2.0.0',
    {
      'README.md': '# Demo v2\n',
      'src/app.ts': appSource('2.0.0'),
      'docs/handbook.txt': guideDoc('intro paragraph'),
      'legacy.txt': 'legacy code\n',
      'config/settings.conf': 'mode=basic\n',
    },
    {
      '1.1.0-to-2.0.0.yaml':
        'steps:\n  - delete: legacy.txt\n  - replace:\n      from: config/settings.ini\n      to: config/settings.conf\n',
    },
  );
  const templates = new Map([
    ['1.0.0', t1],
    ['1.1.0', t11],
    ['2.0.0', t2],
  ]);

  const app = join(work, 'app');
  const appBundle = await loadFromPath(t1);
  await renderBundle(appBundle, app, {});
  await writeLockfile(app, await buildLockfile({ bundle: appBundle, answers: {}, outputDir: app }));

  const environment: UpgradeEnvironment = {
    availableVersions: ['1.0.0', '1.1.0', '2.0.0'],
    async pristineFor(version) {
      const dir = templates.get(version);
      if (!dir) throw new Error(`no template staged for ${version}`);
      const out = await mkdtemp(join(work, `pristine-${version}-`));
      await renderBundle(await loadFromPath(dir), out, {});
      return out;
    },
    async migrationsDirFor(toVersion) {
      const dir = templates.get(toVersion);
      if (!dir) return null;
      const migrations = join(dir, '.hex', 'migrations');
      return existsSync(migrations) ? migrations : null;
    },
  };
  return { app, environment };
}

describe('hex upgrade — multi-step chain end to end', () => {
  it('walks v1.0.0 → v1.1.0 → v2.0.0, carrying edits across the rename', async () => {
    const { app, environment } = await setup();

    // The user edits two files at lines the template never touches —
    // one of them is the file v1.1.0's migration renames.
    const appTs = (await readFile(join(app, 'src/app.ts'), 'utf8')).replace(
      "return 'hello';",
      "return 'hi there';",
    );
    await writeFile(join(app, 'src/app.ts'), appTs, 'utf8');
    const guide = (await readFile(join(app, 'docs/guide.txt'), 'utf8')).replace(
      'usage line',
      'usage line — my notes',
    );
    await writeFile(join(app, 'docs/guide.txt'), guide, 'utf8');

    const outcome = await runUpgrade({ appRoot: app, target: '2.0.0', environment });

    // The merge ran clean across the whole chain.
    expect(outcome.status).toBe('clean');
    expect([outcome.from, outcome.to]).toEqual(['1.0.0', '2.0.0']);
    expect(outcome.merge.merged.sort()).toEqual(['README.md', 'docs/handbook.txt', 'src/app.ts']);
    expect(outcome.merge.deleted).toEqual(['legacy.txt']);
    expect(outcome.merge.added).toEqual([]);

    // The edit to a plain file folded together with the template's change.
    const mergedApp = await readFile(join(app, 'src/app.ts'), 'utf8');
    expect(mergedApp).toContain("export const VERSION = '2.0.0';");
    expect(mergedApp).toContain("return 'hi there';");

    // The edit to the *renamed* file carried across into docs/handbook.txt.
    const handbook = await readFile(join(app, 'docs/handbook.txt'), 'utf8');
    expect(handbook).toContain('intro paragraph'); // the template's change
    expect(handbook).toContain('usage line — my notes'); // the user's edit
    expect(existsSync(join(app, 'docs/guide.txt'))).toBe(false);

    // The template-only file was taken wholesale.
    expect(await readFile(join(app, 'README.md'), 'utf8')).toBe('# Demo v2\n');

    // The delete + replace migrations landed.
    expect(existsSync(join(app, 'legacy.txt'))).toBe(false);
    expect(existsSync(join(app, 'config/settings.conf'))).toBe(true);
    expect(existsSync(join(app, 'config/settings.ini'))).toBe(false);

    // The lockfile reflects the new version + a clean integrity check.
    const lockfileDoc = parseYaml(await readFile(join(app, '.hex', 'lockfile.yaml'), 'utf8')) as {
      root: { version: string };
    };
    expect(lockfileDoc.root.version).toBe('2.0.0');

    const reloaded = await readLockfileUpward(app);
    if (!reloaded) throw new Error('lockfile vanished after upgrade');
    expect((await checkLockfileIntegrity(app, reloaded.lockfile)).ok).toBe(true);

    // No upgrade state and no snapshot left behind on a clean run.
    expect(existsSync(join(app, '.hex', 'upgrade-state.yaml'))).toBe(false);
    expect(existsSync(join(app, '.hex', 'upgrade-backup'))).toBe(false);
  });

  it('stops on a conflicting edit and finishes through `--continue`', async () => {
    const { app, environment } = await setup();

    // The user edits the very line the template also changes (VERSION).
    const edited = (await readFile(join(app, 'src/app.ts'), 'utf8')).replace(
      "export const VERSION = '1.0.0';",
      "export const VERSION = '1.0.0-mine';",
    );
    await writeFile(join(app, 'src/app.ts'), edited, 'utf8');

    const outcome = await runUpgrade({ appRoot: app, target: '2.0.0', environment });

    // The clashing edit conflicts; upgrade state is persisted, lockfile not bumped.
    expect(outcome.status).toBe('conflict');
    expect(outcome.status === 'conflict' && outcome.conflicts).toEqual(['src/app.ts']);
    const conflicted = await readFile(join(app, 'src/app.ts'), 'utf8');
    expect(conflicted).toContain('<<<<<<<');
    expect(conflicted).toContain('>>>>>>> hex 2.0.0');
    expect(existsSync(join(app, '.hex', 'upgrade-state.yaml'))).toBe(true);

    // The user resolves the markers by hand, then continues.
    await writeFile(join(app, 'src/app.ts'), appSource('2.0.0'), 'utf8');
    const resumed = await continueUpgrade(app);
    expect([resumed.from, resumed.to]).toEqual(['1.0.0', '2.0.0']);

    const reloaded = await readLockfileUpward(app);
    if (!reloaded) throw new Error('lockfile vanished after upgrade');
    expect(reloaded.lockfile.root.version).toBe('2.0.0');
    expect((await checkLockfileIntegrity(app, reloaded.lockfile)).ok).toBe(true);
    expect(existsSync(join(app, '.hex', 'upgrade-state.yaml'))).toBe(false);
    expect(existsSync(join(app, '.hex', 'upgrade-backup'))).toBe(false);
  });
});
