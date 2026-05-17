import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationError, applyMigration } from '../../../src/core/upgrade/migration.js';

let work: string;
let treeDir: string;
let migrationsDir: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-migration-test-'));
  treeDir = join(work, 'tree');
  migrationsDir = join(work, 'migrations');
  await mkdir(treeDir, { recursive: true });
  await mkdir(migrationsDir, { recursive: true });
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function writeTreeFile(rel: string, body: string): Promise<void> {
  const abs = join(treeDir, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, body, 'utf8');
}

/** Write a `1.0.0-to-1.1.0` migration file with the given extension/body. */
async function writeMigration(ext: 'yaml' | 'yml' | 'js', body: string): Promise<void> {
  await writeFile(join(migrationsDir, `1.0.0-to-1.1.0.${ext}`), body, 'utf8');
}

const FROM = '1.0.0';
const TO = '1.1.0';

describe('applyMigration — discovery', () => {
  it('is a clean no-op when no migration file exists', async () => {
    const result = await applyMigration(migrationsDir, FROM, TO, { treeDir });
    expect(result).toEqual({ applied: false, renames: [], deletes: [] });
  });

  it('rejects a hop with both a declarative and a JS migration', async () => {
    await writeMigration('yaml', 'steps:\n  - delete: a.txt\n');
    await writeMigration('js', 'log.info("hi");');
    await expect(applyMigration(migrationsDir, FROM, TO, { treeDir })).rejects.toThrow(
      MigrationError,
    );
  });
});

describe('applyMigration — declarative ops', () => {
  it('delete removes a file from the pristine tree', async () => {
    await writeTreeFile('stale.txt', 'old\n');
    await writeMigration('yaml', 'steps:\n  - delete: stale.txt\n');

    const result = await applyMigration(migrationsDir, FROM, TO, { treeDir });
    expect(result.applied).toBe(true);
    expect(result.deletes).toEqual(['stale.txt']);
    expect(existsSync(join(treeDir, 'stale.txt'))).toBe(false);
  });

  it('delete of an absent target is an authoring error', async () => {
    await writeMigration('yaml', 'steps:\n  - delete: nope.txt\n');
    await expect(applyMigration(migrationsDir, FROM, TO, { treeDir })).rejects.toThrow(
      /delete target not found/,
    );
  });

  it('delete_if_unmodified removes the file when the user did not edit it', async () => {
    await writeTreeFile('gen.txt', 'generated\n');
    await writeMigration('yaml', 'steps:\n  - delete_if_unmodified: gen.txt\n');

    const result = await applyMigration(migrationsDir, FROM, TO, {
      treeDir,
      isUserModified: () => false,
    });
    expect(result.deletes).toEqual(['gen.txt']);
    expect(existsSync(join(treeDir, 'gen.txt'))).toBe(false);
  });

  it('delete_if_unmodified keeps the file when the user edited it', async () => {
    await writeTreeFile('gen.txt', 'generated\n');
    await writeMigration('yaml', 'steps:\n  - delete_if_unmodified: gen.txt\n');

    const result = await applyMigration(migrationsDir, FROM, TO, {
      treeDir,
      isUserModified: (p) => p === 'gen.txt',
    });
    expect(result.deletes).toEqual([]);
    expect(existsSync(join(treeDir, 'gen.txt'))).toBe(true);
  });

  it('rename moves a file and records the rename', async () => {
    await writeTreeFile('server.ts', 'listen()\n');
    await writeMigration(
      'yaml',
      'steps:\n  - rename:\n      from: server.ts\n      to: src/server.ts\n',
    );

    const result = await applyMigration(migrationsDir, FROM, TO, { treeDir });
    expect(result.renames).toEqual([{ from: 'server.ts', to: 'src/server.ts', kind: 'rename' }]);
    expect(existsSync(join(treeDir, 'server.ts'))).toBe(false);
    expect(await readFile(join(treeDir, 'src', 'server.ts'), 'utf8')).toBe('listen()\n');
  });

  it('rename fails when the source is missing or the target exists', async () => {
    await writeMigration('yaml', 'steps:\n  - rename:\n      from: gone.ts\n      to: x.ts\n');
    await expect(applyMigration(migrationsDir, FROM, TO, { treeDir })).rejects.toThrow(
      /rename source not found/,
    );

    await writeTreeFile('a.ts', 'a\n');
    await writeTreeFile('b.ts', 'b\n');
    await writeMigration('yaml', 'steps:\n  - rename:\n      from: a.ts\n      to: b.ts\n');
    await expect(applyMigration(migrationsDir, FROM, TO, { treeDir })).rejects.toThrow(
      /rename target already exists/,
    );
  });

  it('replace moves a file and records it distinctly from rename', async () => {
    await writeTreeFile('old-config.ts', 'config\n');
    await writeMigration(
      'yaml',
      'steps:\n  - replace:\n      from: old-config.ts\n      to: config.ts\n',
    );

    const result = await applyMigration(migrationsDir, FROM, TO, { treeDir });
    expect(result.renames).toEqual([{ from: 'old-config.ts', to: 'config.ts', kind: 'replace' }]);
    expect(existsSync(join(treeDir, 'config.ts'))).toBe(true);
  });

  it('runs ops in declaration order', async () => {
    await writeTreeFile('a.txt', 'a\n');
    await writeMigration(
      'yaml',
      'steps:\n  - rename:\n      from: a.txt\n      to: b.txt\n  - delete: b.txt\n',
    );
    const result = await applyMigration(migrationsDir, FROM, TO, { treeDir });
    expect(result.renames).toHaveLength(1);
    expect(result.deletes).toEqual(['b.txt']);
    expect(existsSync(join(treeDir, 'a.txt'))).toBe(false);
    expect(existsSync(join(treeDir, 'b.txt'))).toBe(false);
  });

  it('rejects a malformed migration document', async () => {
    await writeMigration('yaml', 'steps:\n  - frobnicate: a.txt\n');
    await expect(applyMigration(migrationsDir, FROM, TO, { treeDir })).rejects.toThrow(
      /schema validation failed/,
    );
  });
});

describe('applyMigration — JS escape hatch', () => {
  it('runs a .js migration in the sandbox with the project facade', async () => {
    await writeTreeFile('keep.txt', 'keep\n');
    await writeTreeFile('drop.txt', 'drop\n');
    await writeMigration(
      'js',
      `project.delete('drop.txt');
project.write('generated/by-js.txt', 'hello ' + migration.from + '->' + migration.to);`,
    );

    const result = await applyMigration(migrationsDir, FROM, TO, { treeDir });
    expect(result.applied).toBe(true);
    expect(existsSync(join(treeDir, 'drop.txt'))).toBe(false);
    expect(existsSync(join(treeDir, 'keep.txt'))).toBe(true);
    expect(await readFile(join(treeDir, 'generated', 'by-js.txt'), 'utf8')).toBe(
      'hello 1.0.0->1.1.0',
    );
  });

  it('surfaces a throwing JS migration as a MigrationError', async () => {
    await writeMigration('js', 'throw new Error("boom");');
    await expect(applyMigration(migrationsDir, FROM, TO, { treeDir })).rejects.toThrow(
      MigrationError,
    );
  });
});
