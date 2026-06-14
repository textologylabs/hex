# `hex` — CLI command reference

Every command Hex registers, with its synopsis, arguments, flags, and exit-code
semantics. Aligned to the command definitions in
[`src/commands/`](../../src/commands/). For the manifest these commands read and
validate, see the [manifest reference](./manifest.md).

```
hex <command> [args] [flags]
```

## Global flags

| Flag | Meaning |
|------|---------|
| `-v`, `--version` | Print the version and exit. |
| `-h`, `--help` | Print help. Available on every command (`hex <command> --help`). |

On startup `hex` performs a best-effort **self-update check** (a network call to
the npm registry). Set `HEX_NO_UPDATE_CHECK=1` to disable it — see
[docs/security.md](../security.md#self-update).

## Exit codes

Hex follows the standard convention:

| Code | Meaning |
|------|---------|
| `0` | Success. |
| `1` | Failure — an uncaught error (printed as `error: …`), **or** a command-specific failure: lint violations, a failed publish, an invalid `marketplace.yaml`, unresolved upgrade conflicts, or a source that failed to refresh. |
| *(other)* | [`hex deploy`](#hex-deploy) and [`hex setup`](#hex-setup) **propagate** the exit code of the command they run. |

Per-command specifics are noted in each section below.

## Command map

| Command | Purpose |
|---------|---------|
| **Scaffolding** | |
| [`hex new`](#hex-new) | Render a template into a new directory. |
| [`hex list`](#hex-list) | List templates across configured sources. |
| [`hex setup`](#hex-setup) | Walk outstanding post-scaffold setup tasks. |
| [`hex upgrade`](#hex-upgrade) | Upgrade a generated app to a newer template version. |
| [`hex deploy`](#hex-deploy) | Deploy the current project via its configured adapter. |
| [`hex doctor`](#hex-doctor) | Inspect environment, lockfile, and outstanding tasks. |
| **The hive — sources & discovery** | |
| [`hex hive`](#hex-hive) | The honeycomb hub (umbrella for the commands below). |
| [`hex hive list`](#hex-hive-list) | List configured sources + cache/drift status (default). |
| [`hex hive refresh`](#hex-hive-refresh) | Force-refresh git + catalogue sources. |
| [`hex hive search`](#hex-hive-search) | Search templates + components. |
| [`hex hive browse`](#hex-hive-browse) | Browse categories. |
| [`hex hive add`](#hex-hive-add) | Add a source to your config. |
| [`hex hive remove`](#hex-hive-remove) | Remove a source from your config. |
| [`hex hive info`](#hex-hive-info) | Show a package's versions + where it resolves from. |
| [`hex hive validate`](#hex-hive-validate) | Schema-validate a `marketplace.yaml`. |
| **Authoring & publishing** | |
| [`hex lint`](#hex-lint) | Check a stubbable component against prod-clean conventions. |
| [`hex publish`](#hex-publish) | Publish a component/recipe to a registry. |
| **Deprecated aliases** | [`sources`](#deprecated-aliases) · [`search`](#deprecated-aliases) · [`browse`](#deprecated-aliases) · [`marketplace`](#deprecated-aliases) |

---

## Scaffolding

### `hex new`

Render a template (or recipe) into a new directory, running its prompts, hooks,
and post-scaffold setup loop.

```
hex new [template] [output] [flags]
```

**Arguments**

| Arg | Meaning |
|-----|---------|
| `[template]` | Template path or registered name. A qualified `<ns>/<name>@<spec>` resolves through configured catalogues. Omit to pick interactively. |
| `[output]` | Path where the generated project is written. |

**Flags**

| Flag | Default | Meaning |
|------|---------|---------|
| `-f`, `--force` | `false` | Overwrite a non-empty output directory. |
| `--no-setup` | — | Skip the post-render interactive setup loop. |
| `--trust-local` | `false` | Run JS hooks **unsandboxed** for local `file:` components (dev workflow). Ignored for git/marketplace sources. Also lifts the `run:` allowlist for local sources. |

After rendering, Hex runs the manifest's [`setup`](./manifest.md#setup) tasks.
For an **untrusted remote source**, `run:` tasks never execute silently — Hex
prompts to **Trust**, **Review each**, or **Skip** (see
[docs/security.md](../security.md)). In a non-interactive context they are left
pending for [`hex setup`](#hex-setup).

**Exit codes** — `0` on success; `1` on error.

### `hex list`

List the templates available across every configured source root.

```
hex list [--json]
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--json` | `false` | Emit machine-readable JSON. |

**Exit codes** — `0` on success; `1` on error.

### `hex setup`

Walk through the outstanding [setup tasks](./manifest.md#setup) for the current
project (tracked in `<project>/.hex/checklist.yaml`). Useful after `hex new
--no-setup`, or to finish tasks left pending from an untrusted source.

```
hex setup
```

**Exit codes** — propagates the exit code of any `run:` task that fails;
otherwise `0`.

### `hex upgrade`

Upgrade a generated app to a newer version of its template, using the
`.hex/lockfile.yaml` to reconstruct the pristine baseline and 3-way merge. See
[docs/upgrade.md](../upgrade.md).

```
hex upgrade [template] [flags]
```

**Arguments**

| Arg | Meaning |
|-----|---------|
| `[template]` | Path to the newer version of the template. |

**Flags**

| Flag | Default | Meaning |
|------|---------|---------|
| `--continue` | `false` | Resume a paused upgrade after resolving conflicts. |
| `--abort` | `false` | Discard an in-progress upgrade, rolling the tree back. |
| `--prompt-on-orphans` | `false` | Interactively triage orphaned files (kept by default). |

**Exit codes** — `0` when the upgrade completes clean; `1` when files have
conflict markers to resolve (then run `hex upgrade --continue` or `--abort`).

### `hex deploy`

Deploy the current project via the deploy adapter named in its lockfile/manifest.
See [docs/deploy.md](../deploy.md).

```
hex deploy [--dry-run]
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--dry-run` | — | Describe the planned invocation without running it. |

**Exit codes** — propagates the deploy adapter's exit code (`0` on success).

### `hex doctor`

Inspect terminal capabilities, runtime info, the project lockfile + its
integrity, and any outstanding setup tasks. A read-only health check.

```
hex doctor [--json]
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--json` | `false` | Emit machine-readable JSON. |

**Exit codes** — always `0` (informational; it reports rather than gates).

---

## The hive — sources & discovery

### `hex hive`

The honeycomb hub — the umbrella noun for discovering, managing, and inspecting
template sources. Running bare `hex hive` invokes [`hive list`](#hex-hive-list)
(the default action).

```
hex hive [subcommand] [args] [flags]
```

### `hex hive list`

List configured sources (paths, git roots, catalogues) with cache + drift
status. **Default** subcommand of `hex hive`.

```
hex hive list [--json]
hex hive            # same thing
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--json` | `false` | Emit machine-readable JSON. |

### `hex hive refresh`

Force-refresh every git + catalogue source, ignoring the cache.

```
hex hive refresh
```

**Exit codes** — `1` if any source fails to refresh; otherwise `0`.

### `hex hive search`

Free-text search across templates + components in all configured sources.

```
hex hive search <query> [--json]
```

| Arg / Flag | Default | Meaning |
|------------|---------|---------|
| `<query>` | — | Free-text search query (required). |
| `--json` | `false` | Emit machine-readable JSON. |

### `hex hive browse`

Browse categories and the templates filed under them.

```
hex hive browse [category] [--json]
```

| Arg / Flag | Default | Meaning |
|------------|---------|---------|
| `[category]` | — | Category to list directly (skips the interactive picker). |
| `--json` | `false` | Emit machine-readable JSON. |

### `hex hive add`

Add a source to `~/.hex/config.yaml`. Defaults to a **catalogue** source;
`--git` / `--path` select the other kinds. Idempotent — re-adding an identical
entry is a no-op — and document-preserving (comments + other keys survive).

```
hex hive add <url> [flags]
```

| Arg / Flag | Default | Meaning |
|------------|---------|---------|
| `<url>` | — | Catalogue/git URL, or a local path with `--path`. |
| `--ref <ref>` | — | Pin a git ref (branch / tag / sha). |
| `--git` | `false` | Add as a plain git template source instead of a catalogue. |
| `--path` | `false` | Add as a local filesystem path source. |
| `--trust` | `false` | Also **trust** this source to auto-run its `run:` setup tasks (see [docs/security.md](../security.md)). |

### `hex hive remove`

Remove a source from config by its URL or path. Alias: `hex hive rm`. Drops
every matching source regardless of kind/ref.

```
hex hive remove <url>
hex hive rm <url>
```

| Arg | Meaning |
|-----|---------|
| `<url>` | The catalogue/git URL or path to remove. |

### `hex hive info`

Show a package's published versions (newest first) and where it resolves from,
across every configured marketplace and catalogue.

```
hex hive info <package> [--json]
```

| Arg / Flag | Default | Meaning |
|------------|---------|---------|
| `<package>` | — | Package name (`api`) or qualified address (`acme/api`, restricts to that namespace). |
| `--json` | `false` | Emit machine-readable JSON. |

### `hex hive validate`

Schema-validate a `marketplace.yaml` catalogue file. Useful in a catalogue
repo's CI. See [docs/marketplace-catalogue.md](../marketplace-catalogue.md).

```
hex hive validate [path]
```

| Arg | Meaning |
|-----|---------|
| `[path]` | Path to a `marketplace.yaml` (defaults to `./marketplace.yaml`). |

**Exit codes** — `1` if the file is missing or fails validation; otherwise `0`.

---

## Authoring & publishing

### `hex lint`

Check a stubbable component template against the prod-clean conventions (the
stub engine isolated in devDependencies, separate prod/dev entry points, etc.).
See [docs/stubbable-components.md](../stubbable-components.md).

```
hex lint <path>
```

| Arg | Meaning |
|-----|---------|
| `<path>` | Path to the component template directory. |

**Exit codes** — `1` if any lint violation is found; otherwise `0`.

### `hex publish`

Publish a component or recipe to a marketplace registry as a signed `hexpkg`.
See [docs/marketplace-package-format.md](../marketplace-package-format.md).

```
hex publish <dir> --registry <url> [flags]
```

| Arg / Flag | Required | Meaning |
|------------|----------|---------|
| `<dir>` | ✅ | Component or recipe directory to publish. |
| `--registry <url>` | ✅ | Registry base URL (e.g. `https://registry.hex.dev/`). |
| `--token <token>` | — | Publish token. Falls back to the `HEX_PUBLISH_TOKEN` env var. |
| `--description <text>` | — | One-line description for the catalogue. |
| `--category <name...>` | — | Browse category (repeatable). |

> **Token handling.** Prefer `HEX_PUBLISH_TOKEN` over `--token` so the secret
> doesn't land in your shell history.

**Exit codes** — `1` on any publish failure (auth, validation, network);
otherwise `0`.

---

## Deprecated aliases

The discovery + source commands were consolidated under [`hex hive`](#hex-hive)
in M15.1. The old top-level nouns remain registered as **hidden aliases** — they
still work but no longer appear in `--help`. Prefer the `hive` forms.

| Deprecated | Use instead |
|------------|-------------|
| `hex sources` / `hex sources refresh` | `hex hive` / `hex hive refresh` |
| `hex search <query>` | `hex hive search <query>` |
| `hex browse [category]` | `hex hive browse [category]` |
| `hex marketplace validate [path]` | `hex hive validate [path]` |

## See also

- [Manifest field reference](./manifest.md) — what `hex new` / `hex lint` read.
- [docs/security.md](../security.md) — the `run:` trust model and hook sandbox.
- [docs/upgrade.md](../upgrade.md) · [docs/deploy.md](../deploy.md) · [docs/marketplace-catalogue.md](../marketplace-catalogue.md).
