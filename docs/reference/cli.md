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
[docs/security.md](../security.md#4-network-calls).

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
| [`hex adopt`](#hex-adopt) | Link an existing project to a template (writes `.hex/` only). |
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
| [`hex hexify`](#hex-hexify) | Convert a plain template repo into a hex template, in place. |
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
| `--answers <file>` | — | Render **non-interactively**: take every prompt answer from a YAML file (for CI / reproducible scaffolds). See below. |
| `--trust-local` | `false` | Run JS hooks **unsandboxed** for local `file:` components (dev workflow). Ignored for git/marketplace sources. Also lifts the `run:` allowlist for local sources. |

After rendering, Hex runs the manifest's [`setup`](./manifest.md#setup) tasks.
For an **untrusted remote source**, `run:` tasks never execute silently — Hex
prompts to **Trust**, **Review each**, or **Skip** (see
[docs/security.md](../security.md)). In a non-interactive context they are left
pending for [`hex setup`](#hex-setup).

**`--answers <file>`** makes `hex new` fully non-interactive. The file is a YAML
mapping of prompt name → value; recipe-child answers nest under the slot key
(e.g. `api: { port: 8080 }`). Any prompt you omit falls back to its default;
supplied values are validated against the manifest (type, `pattern`, `min`/`max`,
enum membership). A **required** prompt with no default and no supplied value, a
bad value, or an unreadable file fails with a clear message and a non-zero exit
— it never hangs waiting for input. The post-render setup loop is left pending
for [`hex setup`](#hex-setup). Requires an explicit `[template]` argument (no
interactive picker). Hook-defined prompts aren't covered by the answers file
yet.

```sh
hex new ./templates/vite-ts-spa my-app --answers answers.yaml
```

**Exit codes** — `0` on success; `1` on error (including a bad/missing
`--answers` file or a missing required answer).

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

### `hex adopt`

Link an **existing** project — one never scaffolded by Hex — to a template,
so `hex doctor` and `hex upgrade` work from then on. The template is rendered
into a throwaway shadow directory (never into your project); that tree becomes
`.hex/pristine/`, and the lockfile records the *template's* file hashes, so
your project's own changes surface as ordinary drift.

```
hex adopt [template] [flags]
```

The `template` argument accepts the same forms as `hex new` (path, registered
name, catalogue address); omit it for the interactive picker.

Interactive runs **prefill prompt defaults from the project's own
`package.json`** (name → `project_name`, plus description / author /
license) — a hand-copied instance carries its answers in-band, so adopting a
matching project is just Enter-Enter-Enter. Defaults are only ever offered,
never silently assumed, and `--answers` runs take their values exclusively
from the file.

| Flag | Default | Meaning |
|------|---------|---------|
| `--dry-run` | `false` | Render + compare and print the fit report; write **nothing**. |
| `--json` | `false` | Emit the fit report as machine-readable JSON. |
| `--answers <file>` | — | Answer prompts non-interactively from a YAML file (requires an explicit template argument). |
| `--trust-local` | `false` | Run JS hooks unsandboxed for local `FileSource` templates. |
| `--readopt` | `false` | Replace an existing adoption without asking (required to re-adopt in `--answers` mode). |
| `--provenance [ref]` | — | Split the fit report's `edited` group into edited-by-you / stale / collided using the project's own git history (default ref: its root commit). Report-only. |

**Re-adopting** — running `hex adopt` on an already-adopted project asks
*"Already adopted (name@version) — re-adopt and replace the existing
adoption?"* (default No; declining exits `0` with nothing changed).
Confirming — or passing `--readopt` — replaces the adoption wholesale: fresh
`.hex/pristine/` and lockfile, which **resets the merge base** for future
upgrades. In `--answers` mode the question can't be asked, so `--readopt` is
required explicitly. Running from a *subdirectory* of a hex app still refuses
outright — re-adopt only applies at the app root.

**The contract** — `hex adopt` writes `.hex/` **only**. Nothing else in your
tree is created, modified, or deleted, and `rm -rf .hex` reverses the whole
thing. `--dry-run` is a pure preview.

**The fit report** classifies every file:

| Group | Meaning |
|-------|---------|
| clean | Project bytes match the template exactly. |
| edited | Rendered by the template, but yours differs — preserved by `hex upgrade`'s 3-way merge. |
| missing | Rendered by the template, absent from your project — treated as your deletion. |
| untracked | Yours alone; the template doesn't render it — ignored by upgrades. |

`fit % = clean / recorded`. A fit preview on a known instance is also a
quality gauge for a freshly authored template: low fit means the template's
parameterisation doesn't reproduce the project it supposedly describes.

**`--provenance` (provenance-aware fit)** — plain `edited` conflates two
stories: *the team changed this* and *the template moved on after the copy*.
The project's own git history can tell them apart: `--provenance`
materialises the instance's tree at an early ref (default: its **root
commit** — the closest recorded state to the original hand-copy) and
compares three trees per edited file. The report then splits `edited` into
**edited by you** (preserved by upgrade), **stale** (the template improved;
upgrade refreshes these for free), and **collided** (both changed — the
future merge conflicts, enumerated *before* any upgrade runs). Advisory and
report-only: it never changes what adopt writes, `fitPercent` is unmoved,
`edited` remains the full union in JSON, and any git failure (no repo, bad
ref) prints a warning and continues without the split — never a hard error.
Teams squash, so treat the ref as a hint: pass one explicitly
(`--provenance <tag-or-sha>`) when you know the true copy point. One
line-ending caveat: the ref tree is materialised with the blobs as stored
(LF), so a working tree checked out with CRLF conversion will over-report
"edited by you" — normalise line endings first for an honest split.

**Exit codes** — `0` on success *even at low fit* (fit is information, not a
gate — inspect and decide) and on a declined re-adopt; `1` on hard errors
(inside a hex app's subdirectory, re-adopt in answers mode without
`--readopt`, recipe template, unreadable answers file or lockfile, zero-file
render); `130` on cancel.

**V1 limitation** — component templates only; adopting against a recipe is
not yet supported.

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
repo's CI. See [docs/marketplace-catalogue.md](./marketplace-catalogue.md).

```
hex hive validate [path]
```

| Arg | Meaning |
|-----|---------|
| `[path]` | Path to a `marketplace.yaml` (defaults to `./marketplace.yaml`). |

**Exit codes** — `1` if the file is missing or fails validation; otherwise `0`.

---

## Authoring & publishing

### `hex hexify`

Convert a plain, manually-maintained template repo into a hex template **in
place**: a guided dialogue proposes parameterisations (seeded from
`package.json` — name, description, author, license — plus your own
value→prompt pairs), then Hex injects a generated `.hex/manifest.yaml` (one
string prompt per parameter, defaults = the original concrete values),
substitutes `{{ placeholder }}`s across file contents **and** filenames,
neutralises pre-existing template-engine hazards (GitHub Actions'
`${{ secrets.X }}`, stray `{{` / `{%` / `#}` sequences), and writes a
`.gitignore`-seeded `.hexignore`.

```
hex hexify [flags]      # runs on the current directory
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--dry-run` | `false` | Run the whole pipeline — round-trip proof included — and write **nothing**. |
| `--json` | `false` | Emit the hexify report as machine-readable JSON. |
| `--against <instance>` | — | Path to a known **instance** of this template: the template↔instance diff is mined for candidate value pairs, proposed with evidence in the same confirm dialogue. |
| `--emit-prompt [file]` | — | Write a self-contained **AI-agent briefing** (default `hexify-prompt.md`) and stop — nothing else is touched, no TTY needed. |
| `--plan <file>` | — | Load an agent-produced `hexify.plan.yaml`; its params become proposals. With `--dry-run` the run is fully headless (the agent's verify loop). |

**`--against` (instance-informed mining)** — pointing hexify at a project that
was hand-copied from this template turns parameterisation discovery from
guesswork into evidence: everywhere the template says `acme-portal` and the
instance consistently says `zed-portal` is a parameter site, including values
`package.json` seeding can never find (service names in manifests, ports, org
slugs). Mined pairs are proposed with their evidence ("↔ `zed-portal` in the
instance, 7 differing spots") and a suggested prompt name; they only ever
*propose* — the confirm dialogue and the round-trip proof are unchanged. Best
results come from an instance at an **early** revision (check one out first);
later drift just produces junk proposals to decline.

**`--emit-prompt` / `--plan` (AI-assisted parameterisation)** — the guided
dialogue and mining find single values; an AI agent can find what they
structurally can't (multi-word strings, casing variants, judgment calls like
ports and org slugs). Hex itself never talks to an AI — the handoff is two
files you carry:

```
hex hexify --against ../zed-portal --emit-prompt   # writes hexify-prompt.md
# hand hexify-prompt.md to any agent → it answers with hexify.plan.yaml
hex hexify --plan hexify.plan.yaml --dry-run --json  # the agent's verify loop
hex hexify --plan hexify.plan.yaml                   # interactive apply
```

The briefing carries the rules, the evidence (seeds, every mined pair with
its files, the inventory), the plan schema, and instructions for the agent to
grade itself against `hex adopt`'s fit-%. On the `--plan` side, each param is
a *proposal*: a value that appears nowhere counts 0 occurrences and is
surfaced (`planned.unmatched` in the JSON report), the write path confirms
every param by hand, and the round-trip proof is unchanged — a wrong plan
cannot corrupt the repo. `--plan --dry-run` runs with no prompts at all so an
agent can iterate; the actual write is always interactive.

**The contract** — nothing is written unless the **round-trip proof** passes:
the hexified template is built in a throwaway shadow directory and rendered
back with the original values as answers; every file must come back
byte-identical to your repo before a single in-place byte moves. On top of
that, the preflight requires a **clean git tree** — review the result with
`git diff`, undo the rewrites with `git checkout .`, and remove the newly
generated files with `git clean -fd -- .hex .hexignore`. Two untracked
files are tolerated by the clean-tree check: `hexify-prompt.md` and
`hexify.plan.yaml` — hexify's own working files, never touched by the
rewrite. (`--emit-prompt` skips the git preflight entirely: it rewrites
nothing.)

**Preflight refusals (exit 1)** — already a hex template (`.hex/manifest.yaml`
exists); a hex *app* (lockfile found, here or in a parent); not a git repo;
dirty working tree; an unreadable or invalid `--plan` file; `--emit-prompt`
combined with `--plan`, `--json`, or `--dry-run`.

**After hexify** — commit, then: `hex new <repo>` scaffolds fresh instances;
existing hand-copied instances can be [`hex adopt`](#hex-adopt)ed — the fit
report's fit-% is your hexification quality gauge (low fit pinpoints exactly
where the parameterisation is wrong).

**Exit codes** — `0` on success (and on a declined confirm — nothing
written); `1` on preflight refusal or a failed round-trip proof; `130` on
cancel.

**V1 scope** — single component template, string prompts only; prompt
patterns, sections, and recipe awareness are follow-ups.

### `hex lint`

Check a stubbable component template against the prod-clean conventions (the
stub engine isolated in devDependencies, separate prod/dev entry points, etc.).
See [docs/stubbable-components.md](../guides/stubbable-components.md).

```
hex lint <path>
```

| Arg | Meaning |
|-----|---------|
| `<path>` | Path to the component template directory. |

**Exit codes** — `1` if any lint violation is found; otherwise `0`.

### `hex publish`

Publish a component or recipe to a marketplace registry as a signed `hexpkg`.
See [docs/marketplace-package-format.md](./marketplace-package-format.md).

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
- [docs/upgrade.md](../upgrade.md) · [docs/deploy.md](../deploy.md) · [docs/marketplace-catalogue.md](./marketplace-catalogue.md).
