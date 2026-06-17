# Upgrading a generated app — `hex upgrade`

When the template your app was scaffolded from ships a new version, `hex
upgrade` pulls the change into your working tree the same way `git
rebase` would — clean changes apply silently, conflicts come back with
the familiar `<<<<<<< ======= >>>>>>>` markers, and your edits survive.

This page is the user-facing workflow. The format spec for what the
upgrade reads and writes lives at [`lockfile-format.md`](./reference/lockfile-format.md);
authoring migrations is [`authoring-migrations.md`](./guides/authoring-migrations.md).

## What it does, in one paragraph

Your generated app carries a `.hex/lockfile.yaml` recording the version,
the answers you gave, and a content hash of every file as Hex rendered
it. `hex upgrade` re-renders the app twice — once at the **old**
version (`pristine_old`), once at the **target** (`pristine_new`) — and
3-way merges the diff onto your working tree. The lockfile is the only
thing that makes this possible: without it the engine can't tell what
the template originally produced apart from what you've edited.

## Commands

```sh
hex upgrade <new-template>           # upgrade to the version at <new-template>
hex upgrade --continue               # finish a paused upgrade after resolving conflicts
hex upgrade --abort                  # discard a paused upgrade, restoring the tree
hex upgrade --prompt-on-orphans      # interactive orphan triage (otherwise kept silently)
```

`<new-template>` is a path to a newer copy of the template. (Marketplace
discovery for `hex upgrade` lives behind the M9 epic — file paths and
local clones work today.)

The command runs at or below the generated app's root — it walks
upward looking for `.hex/lockfile.yaml`, the same way `hex doctor`
does.

## The flow

1. **Snapshot** — the working tree is copied into `.hex/upgrade-backup/`
   before anything else, so `--abort` can roll back exactly.
2. **Pristine reconstruction** — Hex re-renders the app at the **locked
   version** using the answers stored in the lockfile, producing
   `pristine_old`.
3. **Chain walk** — for a multi-version upgrade (`1.0.0 → 1.1.0 → 2.0.0`)
   Hex walks every published version, *composing* each hop's migration.
   It then renders the target version to produce `pristine_new`.
4. **3-way merge** — for each file: `base = pristine_old`,
   `theirs = pristine_new`, `ours = your working tree`. Clean hunks
   apply silently; conflicting ones land with markers in place.
5. **Finalise**
   - **Clean** — the lockfile is rewritten at the new version,
     re-hashing the merged tree. `.hex/upgrade-backup/` is removed.
     Exit 0.
   - **Conflict** — marker-laden files stay in place,
     `.hex/upgrade-state.yaml` is written with the list of conflicted
     files, and the snapshot is retained. Exit non-zero.

## Resolving conflicts

A conflicted file looks exactly like a rebase conflict — your changes
between `<<<<<<<` and `=======`, the incoming template's between
`=======` and `>>>>>>>`. Resolve them by editing, drop the markers, then:

```sh
hex upgrade --continue
```

`--continue` refuses while any conflicted file still carries markers
and tells you which ones — you can't accidentally bake a conflict into
the lockfile. Once every marker is gone it bumps the lockfile and clears
state + snapshot.

If you'd rather walk away:

```sh
hex upgrade --abort
```

That restores the working tree from the snapshot exactly as it was
*before* the upgrade ran.

## Orphans

When the new template removes a file that **you've edited**, deleting
it would throw away your work. Hex keeps it in place and records it as
an *orphan*. At the end of the upgrade you see:

```
⚠ 2 orphaned file(s) have your edits — kept in place, review and clean
  up if desired:
    src/legacy/helpers.ts
    config/old.conf
```

Orphans are written into the lockfile under a new `orphans:` list, so
`hex doctor` and a later upgrade can tell *kept user orphans* apart
from *template-owned files*. An **untouched** file the template removes
is just deleted — no orphan.

If you'd rather triage each orphan interactively:

```sh
hex upgrade --prompt-on-orphans <new-template>
```

For each orphan you get a *keep / delete* selector. Cancel keeps the
file (the safe default).

## Migrations

A template version bump can ship a **migration** — a small file at
`.hex/migrations/<from>-to-<to>.yaml` that describes structural changes
(renames, deletions) so the merge can carry your edits across them. A
renamed file's user edits flow into the renamed target rather than
orphaning; a deleted file's removal is recognised as a template
removal rather than a user addition.

You almost never need to think about migrations as a *user* of a
template — they're authored by whoever maintains the template you
scaffolded from. The flow above is the same whether or not migrations
ship. See [`authoring-migrations.md`](./guides/authoring-migrations.md) if
you're on the other side of that line.

## A worked example, end to end

The shortest real run that exercises both a clean apply *and* a conflict.
Every block below is actual output.

**1. Scaffold from v1 of a template** (a tiny `greeter` with a `README.md`
and a `greet.txt`):

```sh
hex new ./greeter-v1 myapp --answers answers.yaml
#   answers.yaml is just `project_name: myapp`
```

```
◇  rendered 2 files
└  done — myapp
```

The generated `myapp/greet.txt` reads `Hello from myapp!` and carries a
`.hex/lockfile.yaml` pinned at `1.0.0`.

**2. Edit a file.** You make `greet.txt` your own:

```
Hello from myapp! Have a great day.
```

You leave `README.md` untouched.

**3. v2 of the template ships** — its `greet.txt` line changes to
`Hello from myapp, welcome aboard!` (collides with your edit) and its
`README.md` "Usage" line changes (you never touched it, so it'll apply
cleanly). Point `hex upgrade` at it:

```sh
cd myapp
hex upgrade ../greeter-v2
```

```
hex upgrade 1.0.0 → 2.0.0  (0 added, 1 merged, 0 deleted)
✗ 1 file(s) have conflicts — resolve the markers, then
    greet.txt
  run `hex upgrade --continue` when done, or `hex upgrade --abort`
```

`README.md` already carries the new "Usage" line — a clean hunk applied
silently. `greet.txt` came back with markers:

```
<<<<<<< your changes
Hello from myapp! Have a great day.
=======
Hello from myapp, welcome aboard!
>>>>>>> hex 2.0.0
```

**4. Try to continue too early** — the guard catches it:

```sh
hex upgrade --continue
```

```
✗ 1 file(s) still have unresolved conflict markers:
  greet.txt
```

**5. Resolve and continue.** Edit `greet.txt` to keep both intents and
drop the markers:

```
Hello from myapp, welcome aboard! Have a great day.
```

```sh
hex upgrade --continue
```

```
✓ upgrade 1.0.0 → 2.0.0 complete
```

The lockfile is now at `2.0.0`, the merged tree is re-hashed, and
`.hex/upgrade-state.yaml` + the backup are gone. Had you wanted to bail
at step 4 instead, `hex upgrade --abort` would have restored `greet.txt`
(and everything else) exactly as it was before step 3.

## What's never touched

`.hex/`, `.git/`, and `node_modules/` are excluded from every read,
write, snapshot, and rollback. Your project metadata, version control,
and dependency tree are off-limits to the engine.

## Exit codes

| Exit | Meaning                                                    |
| ---- | ---------------------------------------------------------- |
| 0    | Clean upgrade landed, or `--continue` / `--abort` finished |
| 1    | Conflicts; an upgrade is already in progress; usage error  |

## Troubleshooting

> *"no `.hex/lockfile.yaml` here"*

You're outside a Hex-generated app, or the lockfile was deleted. Apps
generated before M10.2 didn't have one and can't be upgraded — re-scaffold
from the same answers and copy your edits over.

> *"an upgrade is already in progress"*

`.hex/upgrade-state.yaml` exists from a previous paused upgrade. Finish
it with `--continue` (once markers are resolved) or discard it with
`--abort`.

> *"N file(s) still have unresolved conflict markers"*

`--continue` found `<<<<<<<` / `>>>>>>>` still in one of the conflicted
files. The message names them — fix and try again.

> *Doctor says "N files diverged from the lockfile"*

That's pre-upgrade integrity, not an error from the upgrade itself —
Hex is just reporting the files you've edited. Those are exactly the
files the merge will treat as "ours" when the template changes them.
