import type { SetupTask } from '../manifest/types.js';
import type { ResolvedRecipe } from './resolve.js';

/**
 * Walk a resolved recipe tree depth-first and produce a single flat list
 * of setup tasks aggregated from the recipe and every (recursively-)
 * composed child that declares `setup.tasks`. The caller passes this to
 * `checklistFromTasks` + `writeChecklist` (M4 mechanism) to land a single
 * `<rootDir>/.hex/checklist.yaml` for the generated app.
 *
 * Task IDs are prefixed with each enclosing key path so collisions across
 * the tree are impossible — recipe's own bare IDs stay bare; a direct
 * child's tasks become `<key>-<id>`; a grandchild's tasks become
 * `<outer>-<inner>-<id>`. Kebab-case is preserved end-to-end.
 *
 * Order: recipe-level tasks first, then each child in `composes:`
 * declaration order, descending into nested recipes before the next
 * sibling. Mirrors the prompt-collection and render order so the
 * checklist reads top-to-bottom in the same shape the user filled out.
 */
export function aggregateRecipeSetup(resolved: ResolvedRecipe): SetupTask[] {
  const out: SetupTask[] = [];
  collect(resolved, [], out);
  return out;
}

function collect(resolved: ResolvedRecipe, prefix: string[], out: SetupTask[]): void {
  const recipeTasks = resolved.recipeBundle.manifest.setup?.tasks ?? [];
  for (const t of recipeTasks) {
    out.push(prefixTask(t, prefix));
  }
  for (const [key, child] of resolved.children) {
    if (child.resolved) {
      collect(child.resolved, [...prefix, key], out);
      continue;
    }
    const childTasks = child.bundle.manifest.setup?.tasks ?? [];
    for (const t of childTasks) {
      out.push(prefixTask(t, [...prefix, key]));
    }
  }
}

function prefixTask(task: SetupTask, prefix: string[]): SetupTask {
  if (prefix.length === 0) return task;
  const id = `${prefix.join('-')}-${task.id}`;
  return task.detail !== undefined
    ? { id, title: task.title, detail: task.detail }
    : { id, title: task.title };
}
