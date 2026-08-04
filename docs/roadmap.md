# Roadmap & post-1.0 parking notes

**Status: 1.0.0 shipped (2026-07-25). Active development is paused.**

This document is the handoff for whoever picks Hex back up. It records
what 1.0 delivers, the work that was deliberately parked (and the signal
that should un-park it), and the known limitations that ship with 1.0.
The **ClickUp `Backlog` is the source of truth for prioritisation** — this
file is the narrative context the board can't hold.

## What 1.0 delivers

- **Scaffolding** — `hex new` renders whole applications from templated
  components and recipes (cookiecutter-style prompts, `sections`, `when`
  conditions, declarative + JS hooks). Non-interactive `hex new --answers
  <file>` for CI / reproducible scaffolds.
- **Upgrade** — `hex upgrade` 3-way-merges template changes into a
  generated app against a stored `.hex/pristine/` baseline (no re-deriving
  the base — see `docs/upgrade.md`).
- **Marketplace** — git-catalogue model via `hex hive` (add/list/refresh
  sources, browse/search, `hex lint`). See `docs/guides/` +
  `docs/reference/`.
- **Trust** — template-authored `run:` setup commands are gated behind an
  interactive Trust / Review / Skip prompt; nothing stranger-authored runs
  headless (`docs/security.md`).
- **Deploy + CI/CD** — `hex deploy` (Vercel adapter) and an emitted
  GitHub Actions workflow; the `vite-ts-spa` reference template dogfoods
  zero-to-deployed (`docs/deploy.md`).
- **Cross-platform** — macOS / Linux / Windows CI lanes; `--answers` and
  ASCII/unicode + colour fallbacks.

## Parked work (with un-park signals)

### 1. Hosted registry (M9.9)
**Parked.** The git-catalogue model covers current needs (incl. the
internal-enterprise use case). The hosted-registry surface is *built and unit-tested*
but wired to no command — `hex publish` is hidden/`[experimental]`, and
the signed-package resolution path (`resolveAddress` + `trustedKeys`) has
no caller (fenced in M15.6).
**Un-park when:** a community catalogue grows past a few hundred packages,
anonymous publish is required, richer discovery is needed, or a
first-party `registry.hex.dev` becomes part of the product story.
**Pointers:** `docs/marketplace.md` (the "why parked" + six-step pickup
notes), `docs/reference/marketplace-package-format.md`, `registry/`.

### 2. Headless setup auto-run — ClickUp 869e3jxpq (open, high)
**Feature decision.** Today no setup `run:` task executes without an
interactive TTY — pre-trusting a source only suppresses the interactive
Trust prompt; it does **not** enable CI auto-run (the docs were corrected
to say so in the 1.0 line). Adding an explicit opt-in headless path
(e.g. `hex new --run-setup` / `hex setup --yes`) would run
stranger-authored code without a human present, so it needs a deliberate
security design + gating before it's built.
**Un-park when:** a user genuinely needs scripted/CI scaffolds that also
*execute* setup tasks (not just render). Secondary: a scaffold blocked by
the `run:` allowlist still exits 0 — consider a non-zero exit / `--strict`
so CI callers can detect the block.

### 3. Recipe-level deploy / CI-CD orchestration (Phase 3 / M5)
**Not started.** `hex deploy` and the cicd provider act on a single
component's `deploy:` / `cicd:` stanza. Orchestrating deploy across a
recipe's composed children (each with its own stanza) is Phase 3 — see
the note in `src/core/deploy/types.ts` and idea.md §10 ("step
contribution" model). The per-adapter deploy-step shape in
`renderDeployStep` is intentionally minimal until then.

### 4. Hook-defined prompts in `--answers` (M15.17 gap)
**Known gap.** The answers file covers component / recipe / recipe-child
prompts, but **not** hook-defined prompts (`answers.hooks.<name>.*`) — a
template using them still needs a terminal. Close this to make every
template fully headless-scaffoldable.

### 5. Emitted CI workflow is not upgrade-reconciled
**By design, revisit if needed.** `.github/workflows/deploy.yml` is
emitted at `hex new` time as a developer-owned artifact — it is *not* in
the lockfile file table or the `hex upgrade` pristine baseline, so a
later template change to the workflow shape won't propagate on upgrade
(and Hex won't clobber a workflow the user edited). If templates start
shipping meaningful workflow changes across versions, add a reconcile
path (emit into pristine, or a dedicated `hex deploy --sync-workflow`).
See `src/core/deploy/emit.ts`.

### 6. Setup-loop end-state UX polish (from 869dt5pjv, the deferred half)
**Minor.** The all-done → clean-outro path is fixed. The broader polish
was deferred: when the loop *does* run with tasks remaining, give done
tasks a clearer primary action (e.g. `Next` / `Looks good`) and reword
`Quit`'s "resume with hex setup" hint so it doesn't imply unfinished work
when nothing is pending.

### 7. First deploy: preview vs production (minor)
`vite-ts-spa`'s first deploy is a **preview** (a working live URL, safer
than publishing an untested scaffold to prod). To make it production, add
`prod: true` to the template's `deploy:` stanza.

## How to resume

1. Read this file, then the **ClickUp `Backlog`** (space `hex`, id
   `90127416505`) for current priorities — the board ranks; this file
   explains.
2. Re-run the **1.0 acceptance-drill** pattern (a real-TTY walk of the
   primary flows) after any substantive change — it's the one thing the
   test suite can't cover. The deploy/setup walk in particular needs a
   real terminal, `gh` auth, and a Vercel account.
3. Release mechanics (tag → `release.yml` → npm publish) are the
   maintainer's; the dev loop stops at a merged version-bump PR.
