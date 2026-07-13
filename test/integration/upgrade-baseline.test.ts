import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeNewRender } from '../../src/commands/new.js';
import { runPlainUpgrade } from '../../src/commands/upgrade.js';
import { readLockfileUpward } from '../../src/core/lockfile/index.js';
import { loadFromPath } from '../../src/core/sources/file-source.js';
import { BASELINE_REL_PATH } from '../../src/core/upgrade/baseline.js';
import { UpgradeError } from '../../src/core/upgrade/run.js';

/**
 * Regression cover for the pristine baseline (`.hex/pristine/`).
 *
 * These drive the *real* `hex upgrade` wiring — `runPlainUpgrade`, the
 * same function the CLI action calls — rather than handing the engine a
 * synthetic `UpgradeEnvironment`. That distinction is the whole point:
 * the M11.8 integration test injects a faithful version→template map, so
 * it passed happily while the shipped command was reconstructing its
 * merge base from a template path that no longer held the locked version.
 *
 * Two failures fell out of that, both reproduced below:
 *   1. a template updated in place made base == theirs, so the upgrade
 *      silently dropped every change the template shipped;
 *   2. side-by-side version dirs left `root.source` pinned to the
 *      original template forever, poisoning the base of the *next*
 *      upgrade into conflicts nobody caused.
 */

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-baseline-int-'));
  // runPlainUpgrade reports progress on stdout; keep the test output clean.
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Write/overwrite a template at `dir` with the given version + files. */
async function writeTemplate(
  dir: string,
  version: string,
  files: Record<string, string>,
): Promise<string> {
  await mkdir(join(dir, '.hex'), { recursive: true });
  await writeFile(
    join(dir, '.hex', 'manifest.yaml'),
    `type: component\nname: baseline-fixture\nversion: ${version}\nkind: lib\nprompts: []\n`,
    'utf8',
  );
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }
  return dir;
}

/** Render an app from `template` the way `hex new` does. */
async function renderApp(template: string, out: string): Promise<string> {
  const bundle = await loadFromPath(template);
  await executeNewRender(bundle, out, { answers: {}, warnings: [] }, { force: false });
  return out;
}

const read = (path: string): Promise<string> => readFile(path, 'utf8');

async function lockedVersion(app: string): Promise<string | undefined> {
  return (await readLockfileUpward(app))?.lockfile.root.version;
}

async function lockedSourcePath(app: string): Promise<string | undefined> {
  const source = (await readLockfileUpward(app))?.lockfile.root.source;
  return source?.kind === 'file' ? source.path : undefined;
}

describe('hex new stores the pristine baseline', () => {
  it('captures the rendered tree under .hex/pristine/', async () => {
    const tpl = await writeTemplate(join(work, 'tpl'), '1.0.0', {
      'README.md': 'line A\n',
      'src/index.ts': 'export const x = 1;\n',
    });
    const app = await renderApp(tpl, join(work, 'app'));

    expect(await read(join(app, BASELINE_REL_PATH, 'README.md'))).toBe('line A\n');
    expect(await read(join(app, BASELINE_REL_PATH, 'src/index.ts'))).toBe('export const x = 1;\n');
  });
});

describe('upgrade against a template updated in place (the `git pull` workflow)', () => {
  it("applies the template's changes instead of silently dropping them", async () => {
    const tpl = join(work, 'tpl');
    await writeTemplate(tpl, '1.0.0', { 'README.md': 'line A\n' });
    const app = await renderApp(tpl, join(work, 'app'));

    // The maintainer ships 2.0.0 in the same directory. The 1.0.0 content
    // no longer exists anywhere — except in the app's stored baseline.
    await writeTemplate(tpl, '2.0.0', { 'README.md': 'line B\n' });

    await runPlainUpgrade(tpl, false, app);

    // Before the baseline, the base re-rendered from `tpl` — which by now
    // held 2.0.0 — so base == theirs, the merge saw nothing to do, and the
    // app kept "line A" while the lockfile claimed 2.0.0.
    expect(await read(join(app, 'README.md'))).toBe('line B\n');
    expect(await lockedVersion(app)).toBe('2.0.0');
    // …and the baseline has moved on with it.
    expect(await read(join(app, BASELINE_REL_PATH, 'README.md'))).toBe('line B\n');
  });

  it('still preserves a user edit that the template did not touch', async () => {
    const tpl = join(work, 'tpl');
    await writeTemplate(tpl, '1.0.0', { 'README.md': 'line A\n', 'keep.txt': 'mine\n' });
    const app = await renderApp(tpl, join(work, 'app'));
    await writeFile(join(app, 'keep.txt'), 'my precious local edit\n', 'utf8');

    await writeTemplate(tpl, '2.0.0', { 'README.md': 'line B\n', 'keep.txt': 'mine\n' });
    await runPlainUpgrade(tpl, false, app);

    expect(await read(join(app, 'README.md'))).toBe('line B\n');
    expect(await read(join(app, 'keep.txt'))).toBe('my precious local edit\n');
  });
});

describe('consecutive upgrades across side-by-side version dirs', () => {
  it('advances root.source, so the next upgrade merges against the right base', async () => {
    const t1 = await writeTemplate(join(work, 't1'), '1.0.0', { 'README.md': 'line A\n' });
    const t2 = await writeTemplate(join(work, 't2'), '2.0.0', { 'README.md': 'line B\n' });
    const t3 = await writeTemplate(join(work, 't3'), '3.0.0', {
      'README.md': 'line B\n', // v3 leaves README alone…
      'NOTES.md': 'notes\n', // …and only adds a file
    });

    const app = await renderApp(t1, join(work, 'app'));
    expect(await lockedSourcePath(app)).toBe(t1);

    await runPlainUpgrade(t2, false, app);
    // The rewritten lockfile used to carry the *old* source through, leaving
    // it pointing at t1 while claiming 2.0.0.
    expect(await lockedSourcePath(app)).toBe(t2);
    expect(await read(join(app, 'README.md'))).toBe('line B\n');

    // The user edits a file the template is about to leave alone.
    await writeFile(join(app, 'README.md'), 'line C\n', 'utf8');

    await runPlainUpgrade(t3, false, app);

    // With a t1 base this merged as "template changed A→B, user changed
    // A→C" and blew up into a conflict. The correct base (t2, "line B")
    // makes it a clean user-only change.
    const readme = await read(join(app, 'README.md'));
    expect(readme).toBe('line C\n');
    expect(readme).not.toContain('<<<<<<<');
    expect(await read(join(app, 'NOTES.md'))).toBe('notes\n');
    expect(await lockedVersion(app)).toBe('3.0.0');
    expect(await lockedSourcePath(app)).toBe(t3);
    expect(existsSync(join(app, '.hex', 'upgrade-state.yaml'))).toBe(false);
  });
});

describe('apps generated before the baseline existed', () => {
  it('refuses when the recorded template no longer holds the locked version', async () => {
    const tpl = join(work, 'tpl');
    await writeTemplate(tpl, '1.0.0', { 'README.md': 'line A\n' });
    const app = await renderApp(tpl, join(work, 'app'));
    // Simulate an app generated by a Hex that never stored a baseline.
    await rm(join(app, BASELINE_REL_PATH), { recursive: true, force: true });

    await writeTemplate(tpl, '2.0.0', { 'README.md': 'line B\n' });

    await expect(runPlainUpgrade(tpl, false, app)).rejects.toThrow(UpgradeError);
    await expect(runPlainUpgrade(tpl, false, app)).rejects.toThrow(/cannot rebuild the 1\.0\.0/);

    // Refused, not corrupted: the tree and the locked version are untouched.
    expect(await read(join(app, 'README.md'))).toBe('line A\n');
    expect(await lockedVersion(app)).toBe('1.0.0');
  });

  it('falls back to re-rendering when the recorded template still holds the locked version', async () => {
    const t1 = await writeTemplate(join(work, 't1'), '1.0.0', { 'README.md': 'line A\n' });
    const t2 = await writeTemplate(join(work, 't2'), '2.0.0', { 'README.md': 'line B\n' });
    const app = await renderApp(t1, join(work, 'app'));
    await rm(join(app, BASELINE_REL_PATH), { recursive: true, force: true });

    // t1 is still there at 1.0.0, so reconstruction is faithful — the
    // pre-baseline path stays supported for apps whose template survives.
    await runPlainUpgrade(t2, false, app);

    expect(await read(join(app, 'README.md'))).toBe('line B\n');
    expect(await lockedVersion(app)).toBe('2.0.0');
    // The upgrade leaves a baseline behind, so it is a one-off.
    expect(await read(join(app, BASELINE_REL_PATH, 'README.md'))).toBe('line B\n');
  });
});
