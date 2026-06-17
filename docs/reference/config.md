# `~/.hex/config.yaml` — configuration reference

Hex's user-level config: where it looks for templates, which marketplaces it
knows, what it's allowed to run, and whether it checks for updates. Every field
is optional — with no config file at all, Hex runs against an empty source list.
Aligned to the schema in
[`src/core/config/schema.ts`](../../src/core/config/schema.ts).

## Location

| | |
|---|---|
| **Default** | `~/.hex/config.yaml` |
| **Override** | `HEX_CONFIG_DIR=/path/to/dir` (the file is always `config.yaml` inside it) |

A **missing** or **empty** file is not an error — it yields an empty config
(no sources, no marketplaces). Malformed YAML or a schema violation raises a
`ConfigError` naming the file and the offending field.

Most of the config is better managed through [`hex hive add` /
`hex hive remove`](./cli.md#hex-hive-add) than by hand — they're idempotent and
preserve your comments and key order.

```yaml
# ~/.hex/config.yaml — every block is optional
sources:
  - path: ~/dev/templates
  - git: https://github.com/acme/api-template
    ref: v1.2.0
  - catalogue: https://github.com/acme/hex-catalogue
    ref: stable
marketplaces:
  - id: acme
    registry: https://registry.acme.internal/
trust:
  allowlist: [npm, git]
  sources:
    - https://github.com/acme/hex-catalogue
update:
  check: false
```

## `sources`

An ordered list of places Hex discovers templates and components. Order is
preserved and matters for bare-name resolution (first match wins). Each entry is
**one** of three kinds, distinguished by its key:

### `path` — a local directory

```yaml
sources:
  - path: ~/dev/templates      # ~ expands to your home directory
  - path: ./team-templates     # relative resolves against the config file's dir
  - path: /opt/hex/templates   # absolute taken as-is
```

Hex walks the directory for bundles (a folder containing
`.hex/manifest.{yaml,yml}`). Path normalisation: a leading `~/` expands to
`$HOME`; a relative path resolves against the **config file's directory** (so a
config committed alongside a dotfiles repo is portable), not `$PWD`.

Local `path:` sources are **trusted** — their `run:` setup tasks may auto-run
(subject to the allowlist). See [Security](../security.md#2b-source-trust).

### `git` — a template repo

```yaml
sources:
  - git: https://github.com/acme/api-template
    ref: v1.2.0          # optional — branch, tag, or SHA
  - git: git@github.com:acme/web-template.git   # SSH works too
```

The repo is cloned **lazily on first use** (a shallow `--depth 1` fetch) into the
cache (below) and walked like a local path. `ref:` pins the checkout; omit it to
track the remote's default `HEAD`. **Prefer an immutable tag** for a stable
source — a branch drifts as it moves.

Authentication is whatever your system `git` already does — SSH agent,
credential helpers, and `~/.gitconfig` all apply. Hex never prompts for
credentials or stores them.

### `catalogue` — a git-catalogue marketplace

```yaml
sources:
  - catalogue: https://github.com/acme/hex-catalogue
    ref: stable          # optional, same semantics as git:
```

Same wire shape as `git:`, but the repo's **root carries a `marketplace.yaml`**
indexing curated packages by namespace. This is how a team distributes
templates without running a server — `hex new acme/api` resolves through it. See
the [catalogue reference](./marketplace-catalogue.md) for the `marketplace.yaml`
format and [Set up a catalogue for your org](../guides/catalogue-for-your-org.md)
for the workflow.

## `marketplaces`

Hosted-registry endpoints, in resolution order. This surface is **parked** for
1.0 (no registry is hosted) — see [marketplace.md](../marketplace.md). The field
is documented for completeness:

```yaml
marketplaces:
  - id: acme                              # address qualifier: acme/<package>
    registry: https://registry.acme.internal/
```

- **`id`** — lowercase alphanumeric plus `.`, `-`, `_` (regex
  `^[a-z0-9][a-z0-9._-]*$`); used as the `<id>/<name>` address qualifier. Must be
  unique — a duplicate id is a config error.
- **`registry`** — the registry base URL.
- **Order is precedence**: for a bare name, the first marketplace with a match
  wins; a qualified `acme/api` disambiguates explicitly.

## `trust`

Added in M15.3. Governs whether a template's `run:` setup tasks may execute. Both sub-keys are
optional; the full model — the two gates, the per-scaffold prompt, the CI
behaviour — is in [Security § 2](../security.md#2-run-setup-tasks).

```yaml
trust:
  allowlist: [npm, git]    # override the built-in safe-binary list
  sources:                 # remote sources trusted to auto-run their run: tasks
    - https://github.com/acme/hex-catalogue
```

- **`allowlist`** — replaces the built-in allowlist
  (`npm npx yarn pnpm bun node git gh hex vercel`) of binaries a `run:` task may
  invoke. `allowlist: []` locks everything down — **no** `run:` task auto-runs,
  anywhere. The allowlist is a guardrail against typos, *not* a sandbox.
- **`sources`** — remote (git / catalogue) source URLs you vouch for. A `run:`
  task from a listed source auto-runs without the per-scaffold trust prompt.
  `hex hive add <url> --trust` appends here for you.

Local `path:` sources are always trusted; remote sources are untrusted unless
listed here or trusted interactively at scaffold time.

## `update`

Added in M15.7. Controls the startup self-update check.

```yaml
update:
  check: false     # disable the npm-registry version check entirely
```

Absent (or `check: true`) leaves the check **enabled** — but it still only fires
at an interactive TTY and never in CI/pipes, is bounded by a 2 s timeout, and
swallows every failure. `check: false` is the central, auditable opt-out a
platform team can ship in a shared config for locked-down / air-gapped /
proxied environments, so disabling doesn't depend on every shell exporting
`HEX_NO_UPDATE_CHECK=1`. See [Security § 4](../security.md#4-network-calls).

## The cache

Git and catalogue sources are cached on disk so repeated runs don't re-clone.

| | |
|---|---|
| **Default** | `~/.hex/cache/` |
| **Override** | `HEX_CACHE_DIR=/path/to/cache` |

Layout: `<cache>/git/<url-hash>/<ref>-<ref-hash>/repo/` — each `(url, ref)` pair
caches in its own subtree, so switching ref never trashes the other checkout. A
sibling `.hex-meta.json` records the resolved SHA and fetch time.

- **Refresh** — `hex hive refresh` force-refetches every git + catalogue source,
  ignoring the cache.
- **Clear** — the cache is disposable; deleting `~/.hex/cache/` (or the
  `HEX_CACHE_DIR` you set) forces a clean re-clone on next use. Nothing in the
  cache is authoritative — your config is.

### Upstream drift

For a `git:` / `catalogue:` source, Hex checks **at most once every 6 hours** per
`(url, ref)` whether the remote has moved ahead of your cached checkout (a single
`git ls-remote`, throttled by the timestamp in `.hex-meta.json`). If it has,
`hex hive` surfaces a nudge:

```
git source https://github.com/acme/api-template@v1.2.0: upstream has new commits
— run 'hex hive refresh' to update (cached: a1b2c3d, upstream: e4f5a6b)
```

Drift is **informational** — it never blocks, and offline use (where the check
fails) is swallowed silently. You stay on the cached version until you choose to
`hex hive refresh`.

## Environment variables

Every knob Hex reads from the environment:

| Variable | Effect |
|----------|--------|
| `HEX_CONFIG_DIR` | Directory holding `config.yaml` (default `~/.hex`). |
| `HEX_CACHE_DIR` | Git/catalogue cache root (default `~/.hex/cache`). |
| `HEX_NO_UPDATE_CHECK` | `=1` disables the startup update check (per-shell equivalent of `update.check: false`). |
| `HEX_PUBLISH_TOKEN` | Publish token for [`hex publish`](./cli.md#hex-publish) (preferred over `--token`). |
| `HEX_FORCE_UNICODE` | `=1` forces Unicode glyphs regardless of detected locale. |
| `HEX_FORCE_ASCII` | `=1` forces the ASCII glyph fallback. |
| `NO_COLOR` | Standard convention — any value disables coloured output. |

## See also

- [CLI reference](./cli.md) — `hex hive add` / `remove` / `refresh` manage this
  file and the cache.
- [Security model](../security.md) — the `trust:` and `update:` blocks in full.
- [Catalogue reference](./marketplace-catalogue.md) — the `marketplace.yaml` a
  `catalogue:` source points at.
- [Set up a catalogue for your org](../guides/catalogue-for-your-org.md) — the
  end-to-end source-configuration workflow.
