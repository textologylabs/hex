import { describe, expect, it } from 'vitest';
import {
  buildDoctorReport,
  formatDoctorText,
  formatLockfileSection,
  formatSetupSection,
} from '../../src/commands/doctor.js';
import { checklistFromTasks, markTask } from '../../src/core/checklist/index.js';
import type { LoadedLockfile, Lockfile, LockfileIntegrity } from '../../src/core/lockfile/index.js';

const fakeEnv = { node: 'v22.0.0', platform: 'linux x64', terminal: 'xterm' };

const fakePath = '/work/.hex/checklist.yaml';
const fakeRoot = '/work';

describe('formatSetupSection', () => {
  it('returns null when no checklist was found', () => {
    expect(formatSetupSection(null)).toBeNull();
  });

  it('returns null when every task is already done', () => {
    let checklist = checklistFromTasks([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ]);
    checklist = markTask(checklist, 'a', 'done');
    checklist = markTask(checklist, 'b', 'done');
    expect(formatSetupSection({ path: fakePath, rootDir: fakeRoot, checklist })).toBeNull();
  });

  it('lists pending tasks, mentions the resume command', () => {
    const checklist = checklistFromTasks([
      { id: 'install-deps', title: 'Install dependencies' },
      { id: 'push-to-github', title: 'Push to GitHub for first deploy' },
    ]);
    const out = formatSetupSection({ path: fakePath, rootDir: fakeRoot, checklist });
    expect(out).not.toBeNull();
    expect(out).toContain('install-deps');
    expect(out).toContain('Install dependencies');
    expect(out).toContain('push-to-github');
    expect(out).toContain('hex setup');
  });

  it('omits done tasks from the list, but reflects them in the count', () => {
    let checklist = checklistFromTasks([
      { id: 'a', title: 'Done one' },
      { id: 'b', title: 'Pending one' },
    ]);
    checklist = markTask(checklist, 'a', 'done');
    const out = formatSetupSection({ path: fakePath, rootDir: fakeRoot, checklist });
    expect(out).not.toBeNull();
    expect(out).toContain('1 pending, 1 done');
    expect(out).toContain('Pending one');
    expect(out).not.toContain('Done one');
  });
});

/** A recipe lockfile with one component child and one nested-recipe child. */
function fakeRecipeLockfile(): Lockfile {
  return {
    schema_version: 1,
    root: {
      name: 'node-ts-fullstack',
      version: '0.1.0',
      type: 'recipe',
      source: { kind: 'file', path: '/srv/node-ts-fullstack' },
    },
    children: [
      {
        key: 'api',
        name: 'api-fastify',
        version: '0.3.0',
        type: 'component',
        stub: false,
        source: { kind: 'file', path: '/srv/api-fastify' },
      },
      {
        key: 'platform',
        name: 'platform',
        version: '0.2.0',
        type: 'recipe',
        stub: false,
        source: { kind: 'file', path: '/srv/platform' },
        children: [
          {
            key: 'db',
            name: 'db-postgres',
            version: '2.0.0',
            type: 'component',
            stub: true,
            source: { kind: 'file', path: '/srv/db-postgres' },
          },
        ],
      },
    ],
    answers: {},
    files: [],
  };
}

function loaded(lockfile: Lockfile): LoadedLockfile {
  return { path: '/work/.hex/lockfile.yaml', rootDir: '/work', lockfile };
}

const cleanIntegrity: LockfileIntegrity = { ok: true, modified: [], missing: [], added: [] };

describe('formatLockfileSection', () => {
  it('returns null when no lockfile was found', () => {
    expect(formatLockfileSection(null, null)).toBeNull();
  });

  it('lists the root identity and every child with its version', () => {
    const out = formatLockfileSection(loaded(fakeRecipeLockfile()), cleanIntegrity);
    expect(out).not.toBeNull();
    expect(out).toContain('recipe node-ts-fullstack@0.1.0');
    expect(out).toContain('api');
    expect(out).toContain('api-fastify@0.3.0');
    // Nested-recipe child and its grandchild both appear.
    expect(out).toContain('platform@0.2.0');
    expect(out).toContain('db-postgres@2.0.0');
    // A stubbed child is marked.
    expect(out).toContain('(stub)');
  });

  it('shows a clean integrity status', () => {
    // Force unicode so the glyph is deterministic regardless of the runner's
    // locale (detectUnicode is LANG-gated; CI runners may be non-UTF-8).
    process.env.HEX_FORCE_UNICODE = '1';
    try {
      const out = formatLockfileSection(loaded(fakeRecipeLockfile()), cleanIntegrity);
      expect(out).toContain('✓');
      expect(out).toContain('integrity clean');
    } finally {
      process.env.HEX_FORCE_UNICODE = undefined;
      delete process.env.HEX_FORCE_UNICODE;
    }
  });

  it('degrades the status glyph to ASCII under HEX_FORCE_ASCII (glyph fallback)', () => {
    process.env.HEX_FORCE_ASCII = '1';
    try {
      const out = formatLockfileSection(loaded(fakeRecipeLockfile()), cleanIntegrity);
      expect(out).toContain('[OK]');
      expect(out).not.toContain('✓');
      expect(out).toContain('integrity clean');
    } finally {
      delete process.env.HEX_FORCE_ASCII;
    }
  });

  it('shows the divergence count and breakdown when files have changed', () => {
    const integrity: LockfileIntegrity = {
      ok: false,
      modified: ['src/index.ts', 'package.json'],
      missing: ['README.md'],
      added: ['src/extra.ts'],
    };
    const out = formatLockfileSection(loaded(fakeRecipeLockfile()), integrity);
    expect(out).not.toBeNull();
    expect(out).toContain('4 files diverged');
    expect(out).toContain('2 modified, 1 missing, 1 added');
  });

  it('uses the singular for a lone divergence', () => {
    const integrity: LockfileIntegrity = {
      ok: false,
      modified: ['src/index.ts'],
      missing: [],
      added: [],
    };
    const out = formatLockfileSection(loaded(fakeRecipeLockfile()), integrity);
    expect(out).toContain('1 file diverged');
  });

  it('notes when integrity was not checked', () => {
    const out = formatLockfileSection(loaded(fakeRecipeLockfile()), null);
    expect(out).toContain('not checked');
  });

  it('handles a standalone component (no children)', () => {
    const lockfile: Lockfile = {
      schema_version: 1,
      root: {
        name: 'db-postgres',
        version: '2.0.0',
        type: 'component',
        source: { kind: 'file', path: '/srv/db-postgres' },
      },
      children: [],
      answers: {},
      files: [],
    };
    const out = formatLockfileSection(loaded(lockfile), cleanIntegrity);
    expect(out).toContain('component db-postgres@2.0.0');
  });
});

describe('buildDoctorReport (M14.8)', () => {
  it('env-only report — no checklist, no lockfile', () => {
    const r = buildDoctorReport(fakeEnv, null, null, null);
    expect(r).toEqual({ env: fakeEnv });
  });

  it('captures pending tasks with their run / open / detail declarations', () => {
    let cl = checklistFromTasks([
      { id: 'install', title: 'Install', run: 'npm install' },
      { id: 'view', title: 'View dashboard', open: 'https://e.test/' },
      { id: 'manual', title: 'Do it', detail: 'just do it' },
      { id: 'done', title: 'Already done', detail: 'nothing' },
    ]);
    cl = markTask(cl, 'done', 'done');

    const r = buildDoctorReport(
      fakeEnv,
      { path: fakePath, rootDir: fakeRoot, checklist: cl },
      null,
      null,
    );
    expect(r.setup?.counts).toEqual({ pending: 3, done: 1 });
    expect(r.setup?.pending).toEqual([
      { id: 'install', title: 'Install', run: 'npm install' },
      { id: 'view', title: 'View dashboard', open: 'https://e.test/' },
      { id: 'manual', title: 'Do it', detail: 'just do it' },
    ]);
  });

  it('captures the lockfile shape + integrity', () => {
    const r = buildDoctorReport(fakeEnv, null, loaded(fakeRecipeLockfile()), cleanIntegrity);
    expect(r.lockfile?.root).toEqual({
      name: 'node-ts-fullstack',
      version: '0.1.0',
      type: 'recipe',
    });
    expect(r.lockfile?.children[0]).toMatchObject({ key: 'api', name: 'api-fastify' });
    // Nested children preserved
    expect(r.lockfile?.children[1]?.children?.[0]).toMatchObject({ key: 'db', stub: true });
    expect(r.lockfile?.integrity).toEqual(cleanIntegrity);
  });

  it('records the lockfileWarning when a present lockfile was unreadable', () => {
    const r = buildDoctorReport(fakeEnv, null, null, null, 'schema validation failed');
    expect(r.lockfile).toBeUndefined();
    expect(r.lockfileWarning).toBe('schema validation failed');
  });

  it('omits setup from the report entirely when no checklist was found', () => {
    const r = buildDoctorReport(fakeEnv, null, loaded(fakeRecipeLockfile()), cleanIntegrity);
    expect(r.setup).toBeUndefined();
  });
});

describe('formatDoctorText (M14.8)', () => {
  it('renders lockfile BEFORE outstanding setup tasks', () => {
    const cl = checklistFromTasks([{ id: 'a', title: 'A', run: 'npm install' }]);
    const out = formatDoctorText(
      buildDoctorReport(
        fakeEnv,
        { path: fakePath, rootDir: fakeRoot, checklist: cl },
        loaded(fakeRecipeLockfile()),
        cleanIntegrity,
      ),
    );
    const lockIdx = out.indexOf('Lockfile');
    const setupIdx = out.indexOf('Outstanding setup tasks');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(setupIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(setupIdx);
  });

  it("appends each pending task's action hint inline", () => {
    const cl = checklistFromTasks([
      { id: 'install', title: 'Install', run: 'npm install' },
      { id: 'view', title: 'View dashboard', open: 'https://e.test/' },
      { id: 'manual', title: 'Do it', detail: 'just do it' },
    ]);
    const out = formatDoctorText(
      buildDoctorReport(fakeEnv, { path: fakePath, rootDir: fakeRoot, checklist: cl }, null, null),
    );
    expect(out).toContain('→ run: npm install');
    expect(out).toContain('→ open: https://e.test/');
    // Detail-only tasks get no inline hint (action is the title).
    const manualLine = out.split('\n').find((l) => l.includes('manual  '));
    expect(manualLine).toBeDefined();
    expect(manualLine).not.toContain('→');
  });

  it('renders the lockfileWarning in place of the full lockfile block', () => {
    const out = formatDoctorText(
      buildDoctorReport(fakeEnv, null, null, null, 'schema validation failed'),
    );
    expect(out).toContain('Lockfile');
    expect(out).toContain('schema validation failed');
    // The full "(component foo@bar)" header should be absent.
    expect(out).not.toContain('integrity clean');
  });

  it('omits the setup section when there are no pending tasks', () => {
    let cl = checklistFromTasks([{ id: 'a', title: 'A', detail: 'x' }]);
    cl = markTask(cl, 'a', 'done');
    const out = formatDoctorText(
      buildDoctorReport(fakeEnv, { path: fakePath, rootDir: fakeRoot, checklist: cl }, null, null),
    );
    expect(out).not.toContain('Outstanding setup tasks');
  });
});
