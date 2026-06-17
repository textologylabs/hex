# Lockfile format — `.hex/lockfile.yaml`

The lockfile is what makes a generated application **self-describing**.
When `hex new` scaffolds an app it writes `.hex/lockfile.yaml` into the
output tree (M10.2); `hex doctor` and the M11 upgrade engine read it
back (M10.3).

`.hex/` is the same folder name an *authored* component uses — but the
contents mirror, rather than repeat, each other:

| Surface             | File                  | Describes          |
| ------------------- | --------------------- | ------------------ |
| Authored component  | `.hex/manifest.yaml`  | *how to scaffold*  |
| Generated app       | `.hex/lockfile.yaml`  | *what was scaffolded* |

The lockfile records exactly the `{recipe, components+versions, answers,
hashes}` set `idea.md` §11 calls "enough to reconstruct `pristine_old`"
— the input the upgrade engine re-renders to compute a patch.

This page is the format spec. M10.1 defined the schema; M10.2 writes the
file at the end of `hex new`; M10.3 reads it and verifies integrity.

## Shape

```yaml
schema_version: 1
hex_version: 0.7.0
generated_at: 2026-05-17T09:00:00.000Z
root:
  name: hex/node-ts-fullstack
  version: 0.1.0
  type: recipe
  source:
    kind: marketplace
    registry: https://registry.hex.dev/
    name: node-ts-fullstack
children:
  - key: api
    name: hex/api-fastify
    version: 0.1.0
    type: component
    stub: false
    source:
      kind: marketplace
      registry: https://registry.hex.dev/
      name: api-fastify
answers:
  app_name: my-app
  api:
    port: 3000
files:
  - path: package.json
    sha256: <64 hex chars>
  - path: api/src/index.ts
    sha256: <64 hex chars>
```

## Fields

| Field            | Purpose                                                          |
| ---------------- | ---------------------------------------------------------------- |
| `schema_version` | Format version. `1` today. A reader refuses a higher version with an upgrade hint rather than guessing. |
| `hex_version`    | The Hex build that wrote the file. Informational. Optional.      |
| `generated_at`   | ISO-8601 render timestamp. Informational. Optional.              |
| `root`           | The recipe — or, for a standalone-component scaffold, the component itself. The engine has no `if (recipe)` branch (`idea.md`, "two archetypes, one engine"), so a component is just a `root` with no `children`. |
| `children`       | The recipe's composed children, one per `composes:` slot, recorded **recursively** — a child that is itself a recipe carries its own `children`. Empty for a standalone component. |
| `answers`        | The full answers tree exactly as the render consumed it — including per-child and per-hook answers (`idea.md` §5). `stub: true` lives here too, as an ordinary stored answer. |
| `files`          | Per-file content hashes of the rendered tree, sorted by `path`.  |

### Artifact identity (`root`, each `children[]`)

`name` + `version` + `type` (`component` \| `recipe`), plus a `source`
spec — *how to re-fetch this exact artifact* during an upgrade. A child
additionally carries its `composes:` slot `key` and a `stub` flag, and —
when the child is itself a recipe — its own nested `children`. A
component child (a leaf) omits `children` entirely.

### Source spec

One variant per `Source` implementation, discriminated on `kind`:

| `kind`        | Fields              | Origin                         |
| ------------- | ------------------- | ------------------------------ |
| `file`        | `path`              | A local path source (M1)       |
| `git`         | `url`, `ref?`       | A git source (M3)              |
| `marketplace` | `registry`, `name`  | A marketplace source (M9)      |

## Hashing

Each `files[]` entry stores the **lowercase-hex sha256** of the file's
bytes as Hex rendered them — post-hooks, post-render. sha256 is the same
algorithm the marketplace package format (`hexpkg/1`) already uses, so
the codebase has one content-hash primitive, not two.

The hash table is what lets M10.3 detect files the user has edited since
generation: re-hash the current tree, compare against the recorded
digests, and any mismatch is a file that diverged. The upgrade engine
uses that to decide whether to merge cleanly or surface a conflict.

## Writing the lockfile (M10.2)

`hex new` writes `.hex/lockfile.yaml` at the end of its render path, for
both archetypes — no `if (recipe)` branch. The `files` table is hashed
from the rendered tree **on disk**, after hooks have run, so renames and
deletes are reflected faithfully. `.hex/`, `.git/`, and `node_modules/`
are excluded from the walk: the first is Hex's own metadata (hashing it
would make the table describe itself), the others are not part of the
rendered artifact.

The composition tree is recorded **recursively** — a recipe child that
itself composes other artifacts carries them under its own `children`,
so the lockfile captures the whole tree, not just the root's immediate
children.

Source specs are recorded as precisely as the render pipeline exposes:
a `git:` child reference carries its upstream coordinate verbatim;
`file:` references, bare `name`/`slot` references, and the root bundle
are recorded as the resolved local path they loaded from.

## Reading + integrity (M10.3)

`readLockfileUpward(startDir)` walks upward from a directory looking for
`.hex/lockfile.yaml` — the same convention `readChecklistUpward` uses, so
`hex doctor` and the M11 upgrade engine work from any subdirectory of a
generated app. It returns the loaded lockfile with its path and the app
root, or `null` if none is found.

The reader checks `schema_version` *before* full schema validation: a
file whose version is newer than this build of Hex supports is refused
with an explicit "upgrade Hex" hint, rather than a wall of schema errors
from shapes a future format introduced. A malformed file (bad YAML,
schema mismatch) is rejected with a `LockfileError`.

`checkLockfileIntegrity(rootDir, lockfile)` compares the current tree
against the recorded hash table and **never throws** — it returns the
divergence so the caller decides what to do:

| Field      | Meaning                                              |
| ---------- | ---------------------------------------------------- |
| `modified` | Recorded files whose current bytes differ            |
| `missing`  | Recorded files no longer present                     |
| `added`    | Files now in the tree but absent from the lockfile   |
| `ok`       | True only when all three are empty                   |

The comparison walk excludes `.hex/`, `.git/`, and `node_modules/` —
identical to the `buildLockfile` walk, so it stays apples-to-apples.
