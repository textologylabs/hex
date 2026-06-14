# Set up a catalogue for your org

This is the platform-team scenario: you want everyone in your organisation to
scaffold from a **curated, versioned set of templates** — without standing up a
server. Hex's answer is a **git-catalogue**: a git repo whose root carries one
`marketplace.yaml` indexing your packages. You curate by PR; your team pulls by
URL.

We'll walk the whole journey as a fictional "Acme" platform team: scaffold the
catalogue repo, index two real packages, gate it with CI, onboard the team, and
have them scaffold by name. By the end Acme engineers run
`hex new acme/api my-service` and get the blessed template.

For the underlying model and the full `marketplace.yaml` field set, see the
[catalogue reference](../marketplace-catalogue.md). For the commands used here,
the [CLI reference](../reference/cli.md).

## The shape of it

```
                 ┌─ acme-catalogue (git repo) ──────────────┐
 platform team → │  marketplace.yaml   ← curation by PR      │
                 │  .github/workflows/validate.yml  ← gate   │
                 └───────────────┬──────────────────────────┘
                                 │ indexes (git URL + ref + path)
              ┌──────────────────┼───────────────────┐
        acme/api repo       acme/web repo        … more package repos
                                 │
                                 ▼
   engineer:  hex hive add https://github.com/acme/acme-catalogue
              hex new acme/api my-service
```

Two independent layers:

1. **The catalogue repo** — one `marketplace.yaml`. This is the index + the
   curation surface (PRs add packages, bump versions, set policy).
2. **The package repos** — each version entry points at a `git:` URL + `ref:` +
   optional `path:`. Each package keeps its own repo and release cadence; the
   catalogue is just a pointer list. The catalogue can be public while the
   package repos are private (a consumer needs read access to whichever packages
   they actually resolve).

## Step 1 — scaffold the catalogue repo

Hex ships a `marketplace-catalogue` template. Scaffold it:

```sh
hex new templates/marketplace-catalogue ./acme-catalogue
```

It asks for the **namespace** (the `acme` qualifier in `acme/<package>`), a
description, the maintainer, and a licence:

```
Catalogue identity
  Namespace          ›  acme
  One-line description ›  Acme's blessed application templates
  Primary maintainer ›  acme-platform
Licence
  License            ›  MIT
```

You get a ready-to-push repo:

```
acme-catalogue/
├── marketplace.yaml              # the index — edit this
├── .github/workflows/validate.yml # CI gate (Step 4)
├── README.md
├── .gitignore
└── LICENSE
```

The scaffolded `marketplace.yaml` carries your namespace + maintainer and a
single placeholder `example` package to replace.

## Step 2 — index your first two packages

Open `marketplace.yaml` and replace the placeholder with two real packages.
Each `versions:` entry points at a git repo, a `ref:` (tag/branch/SHA), and an
optional `path:` if the bundle lives in a subdirectory of that repo:

```yaml
namespace: acme
description: Acme's blessed application templates

maintainers:
  - acme-platform

packages:
  - name: api
    description: Acme's standard Fastify API service
    kind: api
    categories: [backend]
    versions:
      - tag: 1.0.0
        source:
          git: https://github.com/acme/api-template
          ref: v1.0.0
      - tag: 1.1.0
        source:
          git: https://github.com/acme/api-template
          ref: v1.1.0

  - name: web
    description: Acme's standard Vite + TS single-page app
    kind: webapp
    categories: [frontend]
    versions:
      - tag: 2.0.0
        source:
          git: https://github.com/acme/web-template
          ref: v2.0.0
          path: packages/spa   # the bundle lives in a subdir of the repo
```

Notes that matter in practice:

- **`name` is the unqualified package name** — consumers type `acme/api`, where
  `acme` is the catalogue `namespace`.
- **Multiple versions per package** are normal: list each release as its own
  `versions:` entry. A consumer's `@^1.0.0` spec resolves to the highest match
  (`1.1.0` here).
- **`ref:` should be an immutable tag** for a real release, so a given version
  always resolves to the same tree. Branches work but drift.
- **`path:`** points at the directory holding the package's `.hex/manifest.yaml`,
  when the package isn't at the repo root.

### Optional — org-wide policy

A catalogue can also express **overrides** (redirect a bare name to your blessed
pick) and **blocks** (veto packages from other catalogues your team distrusts):

```yaml
# When anyone in the org types `hex new db-postgres`, give them ours:
overrides:
  - name: db-postgres
    use: acme/db-postgres

# Refuse to surface a package from a third-party catalogue:
blocks:
  - sketchy-ns/abandoned-thing
```

## Step 3 — validate locally, then push

Before pushing, validate the file with the same check CI will run:

```sh
hex hive validate marketplace.yaml
```

It schema-validates the catalogue (namespace, every package + version source,
policy blocks/overrides) and exits non-zero on any problem — so a typo'd `git:`
URL or a malformed version entry is caught here, not by a confused teammate.

Then put it on a remote:

```sh
cd acme-catalogue
git init -b main
git add .
git commit -m "acme catalogue: api + web"
git remote add origin https://github.com/acme/acme-catalogue.git
git push -u origin main
```

## Step 4 — turn on the CI gate

The scaffold ships `.github/workflows/validate.yml`, which runs the catalogue
validation on every push + PR:

```yaml
name: validate
on:
  push:
    branches: [main]
  pull_request:
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Validate marketplace.yaml
        run: npx --yes @hexology/hex@latest marketplace validate marketplace.yaml
```

This is what makes the catalogue safe to curate by PR: a contributor can't merge
a `marketplace.yaml` that doesn't parse. The command shown is the
`hex marketplace validate` alias — equivalent to `hex hive validate`; both run
the same check. For a reproducible gate, pin the CLI version
(`@hexology/hex@0.x.y`) instead of `@latest`.

Once it's pushed, the gate is live — open a PR adding a package and watch the
`validate` check run.

## Step 5 — onboard the team

Tell every engineer to add the catalogue once:

```sh
hex hive add https://github.com/acme/acme-catalogue
```

`hive add` defaults to a `catalogue:` source, so no flags are needed. It writes
the entry into `~/.hex/config.yaml` (idempotent, comment-preserving) — no
hand-editing YAML. Pin a ref if you maintain a `stable` branch:

```sh
hex hive add https://github.com/acme/acme-catalogue --ref stable
```

They can confirm it's wired up:

```sh
hex hive                 # lists sources; the catalogue shows `acme · 2 packages`
hex hive search api      # finds acme/api
hex hive info acme/api   # shows published versions, newest first
```

## Step 6 — scaffold by name

Now any engineer scaffolds the blessed template by qualified name:

```sh
hex new acme/api my-service
hex new acme/web@^2.0.0 my-frontend   # version spec optional; defaults to latest
```

Hex resolves the name through the catalogue, clones the package repo at the
indexed `ref:`, and renders it. The generated app's `.hex/lockfile.yaml` records
the exact catalogue + package + version, so [`hex upgrade`](../reference/cli.md#hex-upgrade)
later can pull a newer version when Acme publishes one.

## The ongoing loop

- **Publish a new template version** — tag a release in the package repo, then
  open a PR on the catalogue adding the new `versions:` entry. CI validates;
  you merge; the team gets it on their next `hex hive refresh`.
- **Drift awareness** — Hex checks at most once per 6h per source whether the
  catalogue is ahead of the local cache and nudges users to
  `hex hive refresh`. Offline use never blocks.
- **Trust** — a catalogue's templates can carry `run:` setup tasks. Those don't
  auto-run from a remote source unless the consumer trusts it
  (`hex hive add --trust <url>`, or the per-scaffold prompt). The platform team
  can tell engineers to trust the org catalogue once. See
  [docs/security.md](../security.md).

## See also

- [Catalogue reference](../marketplace-catalogue.md) — the full `marketplace.yaml`
  field set, resolution order, and multi-catalogue aggregation.
- [Authoring a template](./authoring-a-template.md) — build the packages your
  catalogue indexes.
- [CLI reference](../reference/cli.md) — `hex hive add` / `validate` / `info`.
- [Security model](../security.md) — the `run:` trust gate for remote sources.
