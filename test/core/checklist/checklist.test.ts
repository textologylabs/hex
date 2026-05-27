import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Checklist,
  ChecklistError,
  checklistFromTasks,
  countByStatus,
  markTask,
  readChecklistUpward,
  updateChecklist,
  writeChecklist,
} from '../../../src/core/checklist/index.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-checklist-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('checklistFromTasks', () => {
  it('initialises every task as pending', () => {
    const checklist = checklistFromTasks([
      { id: 'install-deps', title: 'Install', detail: 'npm install' },
      { id: 'push', title: 'Push' },
    ]);
    expect(checklist.tasks).toHaveLength(2);
    expect(checklist.tasks.every((t) => t.status === 'pending')).toBe(true);
    expect(checklist.tasks[0]?.detail).toBe('npm install');
    expect(checklist.tasks[1]?.detail).toBeUndefined();
  });

  it('produces an empty checklist for an empty task list', () => {
    expect(checklistFromTasks([])).toEqual({ tasks: [] });
  });
});

describe('writeChecklist + readChecklistUpward', () => {
  it('writes to .hex/checklist.yaml under the given root', async () => {
    const checklist = checklistFromTasks([{ id: 'a', title: 'A' }]);
    const path = await writeChecklist(work, checklist);
    expect(path).toBe(join(work, '.hex', 'checklist.yaml'));
    const raw = await readFile(path, 'utf8');
    expect(raw).toContain('id: a');
    expect(raw).toContain('status: pending');
  });

  it('round-trips through the yaml file', async () => {
    const original = checklistFromTasks([
      { id: 'one', title: 'One', detail: 'do one' },
      { id: 'two', title: 'Two' },
    ]);
    await writeChecklist(work, original);

    const loaded = await readChecklistUpward(work);
    expect(loaded).not.toBeNull();
    expect(loaded?.rootDir).toBe(work);
    expect(loaded?.path).toBe(join(work, '.hex', 'checklist.yaml'));
    expect(loaded?.checklist).toEqual(original);
  });

  it('walks upward from a subdir to find the checklist', async () => {
    await writeChecklist(work, checklistFromTasks([{ id: 'x', title: 'X' }]));
    const sub = join(work, 'src', 'deeply', 'nested');
    await mkdir(sub, { recursive: true });

    const loaded = await readChecklistUpward(sub);
    expect(loaded?.rootDir).toBe(work);
  });

  it('returns null when no checklist exists in any ancestor', async () => {
    const result = await readChecklistUpward(work);
    expect(result).toBeNull();
  });

  it('refuses to write a malformed checklist (defensive)', async () => {
    const bad = { tasks: [{ id: 'BadID', title: 'x', status: 'pending' as const }] };
    await expect(writeChecklist(work, bad)).rejects.toThrow(ChecklistError);
  });

  it('rejects a tampered checklist file with a clear error', async () => {
    const dir = join(work, '.hex');
    await mkdir(dir);
    await writeFile(
      join(dir, 'checklist.yaml'),
      'tasks:\n  - id: BadID\n    title: x\n    status: pending\n',
      'utf8',
    );
    await expect(readChecklistUpward(work)).rejects.toThrow(ChecklistError);
  });

  it('rejects malformed YAML with a clear error', async () => {
    const dir = join(work, '.hex');
    await mkdir(dir);
    await writeFile(join(dir, 'checklist.yaml'), 'tasks: [\n  not-a-mapping\n', 'utf8');
    await expect(readChecklistUpward(work)).rejects.toThrow(ChecklistError);
  });
});

describe('markTask', () => {
  it('marks a task done without mutating the input', () => {
    const original = checklistFromTasks([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ]);
    const updated = markTask(original, 'a', 'done');
    expect(updated.tasks[0]?.status).toBe('done');
    expect(updated.tasks[1]?.status).toBe('pending');
    // Original untouched.
    expect(original.tasks[0]?.status).toBe('pending');
  });

  it('marks a previously-done task back to pending', () => {
    const checklist = markTask(checklistFromTasks([{ id: 'a', title: 'A' }]), 'a', 'done');
    const reset = markTask(checklist, 'a', 'pending');
    expect(reset.tasks[0]?.status).toBe('pending');
  });

  it('throws on unknown ids', () => {
    const checklist = checklistFromTasks([{ id: 'a', title: 'A' }]);
    expect(() => markTask(checklist, 'ghost', 'done')).toThrow(ChecklistError);
  });
});

describe('updateChecklist', () => {
  it('applies the mutator to the on-disk state and returns the new checklist', async () => {
    await writeChecklist(
      work,
      checklistFromTasks([
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
      ]),
    );

    const result = await updateChecklist(work, (current) => markTask(current, 'a', 'done'));
    expect(result.tasks.find((t) => t.id === 'a')?.status).toBe('done');

    const reloaded = await readChecklistUpward(work);
    expect(reloaded?.checklist.tasks.find((t) => t.id === 'a')?.status).toBe('done');
  });

  it('throws when no checklist exists yet', async () => {
    await expect(updateChecklist(work, (c) => c)).rejects.toThrow(ChecklistError);
  });

  it('rejects a mutator that produces a malformed checklist', async () => {
    await writeChecklist(work, checklistFromTasks([{ id: 'a', title: 'A' }]));
    // Empty `id` violates the schema — the mutator's return is the bad shape.
    const badMutator = () =>
      ({ tasks: [{ id: '', title: 'bad', status: 'pending' as const }] }) as unknown as Checklist;
    await expect(updateChecklist(work, badMutator)).rejects.toThrow(ChecklistError);
  });

  it('serialises concurrent toggles — every toggle lands, none is lost', async () => {
    // Five tasks, five workers each toggling a distinct task. Without
    // locking the read-modify-write cycle this is exactly the
    // last-writer-wins race the ticket calls out — each worker would
    // overwrite the others. With `updateChecklist` every toggle ends up
    // on disk.
    const ids = ['a', 'b', 'c', 'd', 'e'];
    await writeChecklist(
      work,
      checklistFromTasks(ids.map((id) => ({ id, title: id.toUpperCase() }))),
    );

    await Promise.all(
      ids.map((id) => updateChecklist(work, (current) => markTask(current, id, 'done'))),
    );

    const final = await readChecklistUpward(work);
    expect(final?.checklist.tasks.every((t) => t.status === 'done')).toBe(true);
  });
});

describe('countByStatus', () => {
  it('counts pending and done tasks', () => {
    const c1 = checklistFromTasks([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
    ]);
    const c2 = markTask(c1, 'a', 'done');
    expect(countByStatus(c1)).toEqual({ pending: 3, done: 0 });
    expect(countByStatus(c2)).toEqual({ pending: 2, done: 1 });
    expect(countByStatus({ tasks: [] })).toEqual({ pending: 0, done: 0 });
  });
});
