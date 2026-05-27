import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { SetupTask } from '../manifest/types.js';
import { withFileLock, writeFileAtomic } from '../util/atomic.js';
import { checklistSchema } from './schema.js';

export type TaskStatus = 'pending' | 'done';

export type ChecklistTask = {
  id: string;
  title: string;
  detail?: string;
  status: TaskStatus;
};

export type Checklist = {
  tasks: ChecklistTask[];
};

export type LoadedChecklist = {
  /** Filesystem path to the `.hex/checklist.yaml` file. */
  path: string;
  /** Directory containing the `.hex/` folder (the generated app root). */
  rootDir: string;
  checklist: Checklist;
};

export class ChecklistError extends Error {
  constructor(
    message: string,
    public readonly path?: string,
  ) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'ChecklistError';
  }
}

export const CHECKLIST_DIRNAME = '.hex';
export const CHECKLIST_FILENAME = 'checklist.yaml';
export const CHECKLIST_REL_PATH = `${CHECKLIST_DIRNAME}/${CHECKLIST_FILENAME}`;
/** Sentinel for serialising concurrent updates to the checklist. */
const CHECKLIST_LOCK_FILENAME = '.checklist.lock';

/**
 * Build a fresh checklist from a manifest's `setup.tasks`. All tasks
 * start as pending. Schema validation in M4.1 already guaranteed unique
 * ids and well-formed titles, so no defensive checks are needed here.
 */
export function checklistFromTasks(tasks: SetupTask[]): Checklist {
  return {
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      ...(t.detail !== undefined ? { detail: t.detail } : {}),
      status: 'pending' as const,
    })),
  };
}

/**
 * Write the checklist to `<rootDir>/.hex/checklist.yaml`, creating the
 * `.hex/` directory if needed. Validates against the schema before
 * writing so a buggy caller cannot persist a malformed file; the write
 * itself is atomic, so a concurrent reader never sees a half-written
 * file. For *partial* updates that must not lose a peer process's
 * concurrent toggles, use `updateChecklist` instead.
 */
export async function writeChecklist(rootDir: string, checklist: Checklist): Promise<string> {
  const parsed = checklistSchema.safeParse(checklist);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new ChecklistError(`refusing to write malformed checklist:\n${issues}`);
  }

  const dir = join(rootDir, CHECKLIST_DIRNAME);
  await mkdir(dir, { recursive: true });
  const path = join(dir, CHECKLIST_FILENAME);
  await writeFileAtomic(path, stringifyYaml(parsed.data));
  return path;
}

/**
 * Atomically apply `mutate` to the on-disk checklist: serialise via an
 * exclusive lock, re-read the latest state inside the lock, mutate,
 * write back atomically. This is what the `hex setup` loop's per-toggle
 * save uses, so two `hex setup` invocations against the same generated
 * app can't lose each other's toggles to last-writer-wins.
 *
 * Throws `ChecklistError` if no checklist exists yet — call
 * `writeChecklist` for the initial creation.
 */
export async function updateChecklist(
  rootDir: string,
  mutate: (current: Checklist) => Checklist,
): Promise<Checklist> {
  const dir = join(rootDir, CHECKLIST_DIRNAME);
  await mkdir(dir, { recursive: true });
  const path = join(dir, CHECKLIST_FILENAME);
  const lockPath = join(dir, CHECKLIST_LOCK_FILENAME);

  return withFileLock(lockPath, async () => {
    if (!(await fileExists(path))) {
      throw new ChecklistError('cannot update — checklist does not exist', path);
    }
    const current = await readChecklistFile(path);
    const next = mutate(current);
    const parsed = checklistSchema.safeParse(next);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('\n');
      throw new ChecklistError(`refusing to write malformed checklist:\n${issues}`, path);
    }
    await writeFileAtomic(path, stringifyYaml(parsed.data));
    return parsed.data;
  });
}

/**
 * Walk upward from `startDir` looking for `.hex/checklist.yaml`. Stops at
 * the filesystem root. Returns null if no checklist was found.
 *
 * Lets `hex setup` / `hex doctor` work from any subdir of the generated
 * app — same convention as `git`/`npm` finding their roots.
 */
export async function readChecklistUpward(startDir: string): Promise<LoadedChecklist | null> {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, CHECKLIST_DIRNAME, CHECKLIST_FILENAME);
    if (await fileExists(candidate)) {
      const checklist = await readChecklistFile(candidate);
      return { path: candidate, rootDir: dir, checklist };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Mark a task with the given id. Returns a new checklist; never mutates
 * the input. Throws `ChecklistError` if the id does not exist.
 */
export function markTask(checklist: Checklist, id: string, status: TaskStatus): Checklist {
  let found = false;
  const tasks = checklist.tasks.map((t) => {
    if (t.id !== id) return t;
    found = true;
    return { ...t, status };
  });
  if (!found) throw new ChecklistError(`unknown task id: ${id}`);
  return { tasks };
}

/**
 * Count tasks by status. Convenience for surfaces that want to print
 * "N pending" without re-doing the loop.
 */
export function countByStatus(checklist: Checklist): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = { pending: 0, done: 0 };
  for (const t of checklist.tasks) counts[t.status] += 1;
  return counts;
}

async function readChecklistFile(path: string): Promise<Checklist> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new ChecklistError(
      `cannot read checklist: ${err instanceof Error ? err.message : String(err)}`,
      path,
    );
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new ChecklistError(
      `invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
      path,
    );
  }

  const result = checklistSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new ChecklistError(`schema validation failed:\n${issues}`, path);
  }
  return result.data;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}
