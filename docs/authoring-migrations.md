# Authoring migrations

If you maintain a template, you ship a **migration** whenever a version
bump moves, renames, or removes a file the user might have edited.
Migrations let `hex upgrade` carry those edits across the change — a
renamed file's edits flow into the renamed target instead of being
orphaned.

This page is the format + authoring guide. The user-facing flow is
[`upgrade.md`](./upgrade.md).

## Where they live

In your template's source tree:

```
my-template/
  .hex/
    manifest.yaml
    migrations/
      1.0.0-to-1.1.0.yaml
      1.1.0-to-2.0.0.yaml
      2.0.0-to-3.0.0.user.js
```

One file per **hop** (`<from>-to-<to>`). A multi-version upgrade
(`1.0.0 → 1.1.0 → 2.0.0`) discovers every hop in turn and composes
their effects — you write one migration per *version bump*, never one
spanning multiple versions.

A hop without a migration file is fine — the version bump simply had
no structural change to declare.

## Two forms

### Declarative — `.yaml`

```yaml
steps:
  - rename:
      from: src/old-name.ts
      to: src/new-name.ts
  - delete: legacy.txt
  - replace:
      from: config/settings.ini
      to: config/settings.conf
  - delete_if_unmodified: docs/scratch.md
```

`steps:` is an ordered list. Each entry is **exactly one** of:

| Verb                     | Effect                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `rename: { from, to }`   | The file at `from` becomes `to`. Realigns `pristine_old` + the user's tree.                  |
| `replace: { from, to }`  | Same realignment as `rename`; semantically "renamed *and* the contents changed".             |
| `delete: <path>`         | Drop `<path>` from `pristine_new`. The merge then sees it as a template removal.             |
| `delete_if_unmodified: <path>` | Same as `delete`, but kept when the user has edited the file (preserves their edits).  |

Paths are POSIX, relative to the app root.

### JS escape hatch — `.js`

```js
// .hex/migrations/2.0.0-to-3.0.0.js
log.info(`migrating ${migration.from} → ${migration.to}`);
const tree = project.list('src');
for (const name of tree) {
  const path = `src/${name}`;
  project.write(path, project.read(path).replace('old-pkg', 'new-pkg'));
}
```

JS migrations run in the M7 sandbox with:

- `project` — sandboxed filesystem facade (`read` / `write` / `delete` /
  `exists` / `list`) rooted at the tree being transformed.
- `log` — `info` / `warn` / `error` sinks.
- `migration` — `{ from, to }`, the hop being run.

Use `.js` only when the four declarative verbs don't fit. A codemod
across the user's own code is the canonical case — and that's a
**user-tree** migration; see below.

## Where each verb applies

Hex composes the whole declarative chain across every hop, then routes
each op to the tree where it makes the merge correct:

| Op                          | Applied to                                                          |
| --------------------------- | ------------------------------------------------------------------- |
| `rename` / `replace`        | `pristine_old` **and** the user's working tree                      |
| `delete` / `delete_if_unmodified` | `pristine_new`                                                |
| JS (pristine)               | `pristine_old`                                                      |
| JS (`.user.js`)             | The user's working tree, *after* the merge                          |

You don't have to think about this when authoring — it's just useful
to know why your `rename` "works": the user's edited file is renamed in
place so the 3-way merge keys it against the new name. No rename-aware
merge logic needed in the engine.

## The user-tree escape hatch

Sometimes the change you need touches **user code** — a project-wide
import rename, for example. The pristine-tree model can't express that:
the user's source files aren't part of any pristine tree. For these
cases a migration may opt into **user-tree** mode, which runs it
against the user's working copy after the merge.

**Declarative form** — add `user_tree: true`:

```yaml
user_tree: true
steps:
  - rename:
      from: legacy-only.md
      to: legacy-only.archive.md
```

**JS form** — name the file `<from>-to-<to>.user.js`:

```js
// .hex/migrations/2.0.0-to-3.0.0.user.js
for (const name of project.list('src')) {
  const path = `src/${name}`;
  project.write(path, project.read(path).replace('old-pkg', 'new-pkg'));
}
```

A user-tree migration runs against the user's tree, edits land
directly, and the changed files are surfaced at the end of the upgrade
as a warning:

```
⚠ a user-tree migration edited your code directly — review these 3 file(s):
    src/a.ts
    src/b.ts
    src/c.ts
```

The list is also written into `.hex/upgrade-state.yaml` if the merge
conflicted, so it survives a pause.

## Authoring rules

- **Source paths must exist in the tree the op targets.** A
  declarative `rename: { from: A, to: B }` expects `A` to exist in
  `pristine_old` (the engine raises a clear error if it doesn't); the
  user-tree side is tolerant (the user may have deleted the file).
- **Ship the target version's tree at its current structure.** v2.0.0's
  template renders the post-rename names; the migration's job is to
  realign the *old* side, not to massage the new render.
- **One migration per hop, never spanning hops.** Always write a
  v1→v2 migration when bumping v1→v2, even if the change is tiny.
  Multi-version upgrades compose them automatically.
- **Don't combine `.js` and `.user.js` for the same hop** — Hex
  refuses an ambiguous pair.
- **Don't combine declarative `.yaml` with `.js` for the same hop**
  either — pick one form.

## Testing your migration

The cleanest dogfood: render the *previous* version, render the *new*
version, then run an upgrade between them with a user-edited file in
the middle. The integration test at
[`test/integration/upgrade.test.ts`](../test/integration/upgrade.test.ts)
shows the pattern — stage three versions of a fixture template, render
the user app at v1, edit it, upgrade to v3, assert the edit survived.

For a quick sanity check on the migration file in isolation, the test
suite covers each verb in
[`test/core/upgrade/migration.test.ts`](../test/core/upgrade/migration.test.ts).
