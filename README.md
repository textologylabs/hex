# @hexology/hex

Scaffolding tool that assembles applications from templated components — honeycomb-style. Part of the [Hexology](https://github.com/textologylabs/hex) toolset.

Status: **v0.9.0 — first npm release**. Phase 1 (render pipeline, recipes, hosted-marketplace foundations, lockfile, upgrade engine — M1–M11), Phase 2 (deploy + CI/CD — M12), and the git-catalogue marketplace model (M13) are shipped. The M14 release pass added the publish workflow, setup-task executor + hand-off ritual, doctor surfaces, and the dogfood walkthrough. See [`idea.md`](./idea.md) for the roadmap and [`CHANGELOG.md`](./CHANGELOG.md) for what's released.

Install: `npm install -g @hexology/hex` (or `npx --yes @hexology/hex@latest`) and run `hex`.

## Quick start

New to Hex? Follow **[Getting started](./docs/getting-started.md)** — the
~10-minute path from install to a running scaffolded app:

```sh
npm install -g @hexology/hex
git clone https://github.com/textologylabs/hex.git ~/hex-src
hex new ~/hex-src/templates/vite-ts-spa my-app   # walk the prompts
cd my-app && npm run dev                          # see it run
```

Reference docs: **[CLI commands](./docs/reference/cli.md)** ·
**[Manifest fields](./docs/reference/manifest.md)** ·
**[Security model](./docs/security.md)**.

## Configuring source roots

Hex discovers templates by walking configured *source roots*. Add them
to `~/.hex/config.yaml` (override the directory with `HEX_CONFIG_DIR`):

```yaml
sources:
  - path: ~/dev/my-templates                                   # local directory
  - git: https://github.com/acme/templates                     # git remote, default branch
    ref: main
  - git: git@github.com:acme/internal-templates.git            # ssh, default branch
  - catalogue: https://github.com/textologylabs/hex-marketplace # git-catalogue marketplace
```

Each `path` is walked one level deep for templates (directories with a
`.hex/manifest.{yaml,yml}`). Each `git` URL is cloned lazily into
`~/.hex/cache/git/...` (override with `HEX_CACHE_DIR`) on first use,
then walked the same way. Each `catalogue:` URL is a git repo whose root
carries a `marketplace.yaml` listing curated packages by namespace — see
[`docs/marketplace-catalogue.md`](./docs/marketplace-catalogue.md).

`hex list` enumerates discovered templates. `hex sources` reports cache
+ drift status per source (no network on cache hit). `hex sources
refresh` force-refreshes every git source.

Drift detection runs at most once per 6h per (url, ref) using
`git ls-remote`; when upstream is ahead of the cache, `hex list` prints a
warning and tells you to `hex sources refresh`. Network failures are
silent — Hex never blocks offline use.

> **Note on SHA refs.** `ref:` accepts branches, tags, and commit SHAs.
> SHA fetches work uniformly against the local protocol, GitHub, and
> GitLab. Self-hosted servers may need `uploadpack.allowAnySHA1InWant=true`
> for arbitrary commits not reachable from a default branch — branches
> and tags don't need this.

## Post-scaffold setup tasks

Templates can declare a `setup:` block in `.hex/manifest.yaml` listing
post-scaffold work the user must complete (install deps, set CI secrets,
push to a remote, etc.):

```yaml
setup:
  message: |
    Your project is scaffolded. A few things to wire up:
  tasks:
    - id: install-deps
      title: Install dependencies
      detail: npm install
    - id: set-npm-token
      title: Set NPM_TOKEN secret on the GitHub repo
      detail: gh secret set NPM_TOKEN
```

When `hex new` finishes rendering, it writes the generated app's
`.hex/checklist.yaml`, prints the `setup.message`, and (on a TTY) walks
the user through each task interactively — they pick `Mark as done`,
`Skip for now`, or `Quit`. Quitting saves progress; the user resumes any
time with `hex setup` (which finds the checklist by walking upward from
cwd, like `git`/`npm`).

`hex doctor` shows outstanding tasks as a reminder section when run from
inside a generated app. `hex new --no-setup` skips the post-render loop
entirely.

## Try it

```sh
npm install
npm run build
node dist/cli.js doctor
```

Or in dev:

```sh
npm run dev -- doctor
```

## Deploying a generated app

Templates that declare `deploy:` and `cicd:` stanzas in their
`.hex/manifest.yaml` ship two deploy paths in the box: `hex deploy`
from your laptop, and `.github/workflows/deploy.yml` on every push.
Hex 0.x bundles the **Vercel** deploy adapter and the
**`cicd-github-actions`** provider — see
[`docs/deploy.md`](./docs/deploy.md) for the full tour, and the
`templates/vite-ts-spa` template for a working example.

## Marketplaces

Two ways to share templates beyond your laptop:

- **Git-catalogue marketplace** (recommended for company-internal +
  small OSS use). A git repo whose root carries a `marketplace.yaml`
  listing curated packages by namespace. Point Hex at it with a
  `catalogue:` source — no server to run. The
  `templates/marketplace-catalogue` starter scaffolds one in seconds
  with a PR-gated `hex marketplace validate` CI workflow. See
  [`docs/marketplace-catalogue.md`](./docs/marketplace-catalogue.md).
- **Hosted registry** (parked at M9.9 — code complete, deploy not).
  A signed-tarball HTTP service for catalogues that grow past PR-review
  scale or need anonymous publish. The spec, runbook, and pickup notes
  are at [`docs/marketplace.md`](./docs/marketplace.md).

Both speak the same `Catalogue` interface client-side, so a single Hex
install can mix `catalogue:` sources and hosted-registry `marketplaces:`
entries in the same config.

## Upgrading a generated app

When your template ships a new version, `hex upgrade <new-template>`
pulls the change into your working tree via a 3-way merge — clean
changes land silently, conflicts come back with git-style markers, and
your edits survive. See [`docs/upgrade.md`](./docs/upgrade.md) for the
user-facing workflow, and [`docs/authoring-migrations.md`](./docs/authoring-migrations.md)
for the format if you maintain a template.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Run the CLI from source via `tsx`. |
| `npm run build` | Bundle to `dist/` via `tsup`. |
| `npm run start` | Run the built binary. |
| `npm test` | Vitest run. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | Biome check. |
| `npm run format` | Biome format (write). |
| `npm run check` | Typecheck + lint + test. |

Three surfaces don't lend themselves to cheap CI — real TTY prompts,
non-`file://` git auth, and Windows shell-to-git — and have to be
walked by hand before each release. [`docs/testing.md`](./docs/testing.md)
is the matrix.

## Roadmap

See `idea.md` § *Incremental build plan*. Phase 1 (configurable scaffolder, M1–M11) and Phase 2 (deploy + CI/CD, M12) are shipped. The git-catalogue marketplace (M13) makes Hex usable in real teams without anyone running a registry server. The M14 release pass cut v0.9.0 — first published `@hexology/hex` on npm. The hosted-registry path remains parked at M9.9 — see [`docs/marketplace.md`](./docs/marketplace.md) for the pickup notes.
