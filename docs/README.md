# Hex documentation

Hex is a scaffolding tool that assembles applications from templated components.
This is the documentation index.

**New here?** Start with [Getting started](./getting-started.md) — scaffold your
first app in ten minutes. Then [Authoring a template](./guides/authoring-a-template.md)
if you want to build your own.

**Already have template repos your teams copy by hand?** The
[brownfield handbook](./guides/brownfield-reuse.md) is your path: convert the
templates in place, link the existing copies, and propagate improvements.

The docs split three ways: **guides** walk a scenario start to finish,
**reference** specs every field and flag, and a handful of **cross-cutting**
pages cover topics that span both.

## Guides — scenario walkthroughs

| Guide | When you want to… |
|-------|-------------------|
| [Getting started](./getting-started.md) | Scaffold an app from an existing template (the 10-minute path). |
| [Authoring a template](./guides/authoring-a-template.md) | Build a template of your own — prompts, Nunjucks, hooks, setup tasks. |
| [Brownfield reuse handbook](./guides/brownfield-reuse.md) | Bring an existing template estate under management — hexify, adopt, upgrade. |
| [Set up a catalogue for your org](./guides/catalogue-for-your-org.md) | Distribute curated templates to a team via a git-catalogue, no server. |
| [Authoring migrations](./guides/authoring-migrations.md) | Ship a migration so `hex upgrade` carries user edits across a version bump. |
| [Authoring stubbable components](./guides/stubbable-components.md) | Build a component that ships a prod-clean stub alongside the real thing. |
| [Upgrading a generated app](./upgrade.md) | Pull a new template version into an existing app via 3-way merge. |
| [Deploying](./deploy.md) | Deploy a generated project through its configured adapter. |

## Reference — specifications

| Reference | Covers |
|-----------|--------|
| [CLI commands](./reference/cli.md) | Every `hex` command: synopsis, args, flags, exit codes. |
| [Manifest fields](./reference/manifest.md) | The `.hex/manifest.yaml` an author writes — every field. |
| [`config.yaml`](./reference/config.md) | The `~/.hex/config.yaml` user config, the cache, and env vars. |
| [Lockfile format](./reference/lockfile-format.md) | The `.hex/lockfile.yaml` a generated app carries. |
| [Catalogue format](./reference/marketplace-catalogue.md) | The `marketplace.yaml` a git-catalogue source indexes packages with. |
| [Package format](./reference/marketplace-package-format.md) | The `hexpkg/1` signed-archive format for published packages. |

## Cross-cutting

| Page | Covers |
|------|--------|
| [Security & trust model](./security.md) | The hook sandbox, the `run:` allowlist + source-trust gates, package signatures, network calls. |
| [Troubleshooting](./troubleshooting.md) | Symptom → cause → fix for the common failures. |

## Parked & internal

These document work that is parked or maintainer-internal — kept for the pickup
notes, not part of the day-to-day user path.

| Page | Status |
|------|--------|
| [Roadmap & post-1.0 parking notes](./roadmap.md) | **1.0 shipped, dev paused** — what 1.0 delivers, parked work + un-park signals, known limitations, how to resume. |
| [Hosted-registry path](./marketplace.md) | **Parked** at M9.9 — the more-ambitious hosted marketplace, behind the git-catalogue model. |
| [Registry deploy runbook](./registry-deploy.md) | **Parked** — operational runbook for standing up the hosted registry. |
| [Testing & manual QA](./testing.md) | Internal — the test strategy and the manual cross-platform walk. |
