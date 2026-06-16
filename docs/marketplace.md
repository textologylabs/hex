# Hex marketplace — the hosted-registry path

> **Status: parked.** The git-catalogue model
> ([`docs/marketplace-catalogue.md`](./marketplace-catalogue.md)) is the
> ship-now answer for company-internal and OSS catalogues. This page
> documents the *more ambitious* hosted-registry path that was built up
> through M9 and parked at M9.9 (publishing + frontdoor + deploy). The
> code lives in `registry/`, the package format is specified in
> [`docs/marketplace-package-format.md`](./marketplace-package-format.md),
> and the deploy runbook is
> [`docs/registry-deploy.md`](./registry-deploy.md). Together they form
> the **complete spec** — this page is the index + the rationale for
> picking the work back up.

## Why two models

The catalogue model treats a marketplace as **a curated index of git
URLs**. Anyone with read access to the catalogue repo + the package
repos can resolve any version; updates are PRs against the catalogue.
It scales to dozens of packages, dozens of consumers, and a known
maintainer set.

The hosted-registry model treats a marketplace as **an HTTP service** —
catalogue.json + index.json + signed `.hexpkg` tarballs — backed by a
publishable namespace model and an OAuth-gated `POST /publish`. It
scales to thousands of packages, anonymous discovery, and arbitrary
self-publish from any developer who's claimed a namespace.

The two models speak the same `Catalogue` interface (`search`/`browse`/`listVersions`)
and the same `Source` interface (`resolve(name, version) → bundle`),
so the resolver is agnostic — `~/.hex/config.yaml` can mix `catalogue:`
sources and `marketplaces:` entries in the same config. M9.5's aggregate
catalogue (`src/core/catalogue/aggregate.ts`) is the union point.

## What's built today

Phase 1 (M9.1 → M9.8, all shipped):

- **Package format** — `hexpkg/1`: gzipped tar of `artifact/` (the
  bundle) + `hexpkg.json` (per-file sha256 hashes + digest) +
  `hexpkg.sig` (Ed25519 detached signature over `hexpkg.json`). Format
  decided in M9.1; spec in [`docs/marketplace-package-format.md`](./marketplace-package-format.md).
- **MarketplaceSource** (M9.2) — `src/core/marketplace/source.ts`. HTTP
  fetcher; semver resolution against `<registry>/<name>/index.json`;
  tarball download + signature verification against pinned trusted
  keys; bundle hand-off to the render pipeline.
- **Catalogue interface** (M9.3) — `src/core/catalogue/marketplace.ts`.
  `search` / `browse` / `listVersions` against `<registry>/catalogue.json`.
- **Address parser** (M9.4) — `src/core/marketplace/address.ts`.
  Qualified (`hex/api-fastify@^1.0`) + bare (`api-fastify@^1.0`)
  addressing, with the bare-name walk semantics every downstream
  command shares.
- **Aggregate catalogue** (M9.5) — `src/core/catalogue/aggregate.ts`.
  Unions discovery across N marketplaces, tags each entry with its
  marketplace id, collects per-source failures as warnings.
- **Policy** (M9.6) — `src/core/marketplace/policy.ts`. Block/override
  policy carried inside each registry's `catalogue.json`, folded into
  one `AggregatePolicy` at load time.
- **Registry server** (M9.7) — `registry/server.ts`. Read endpoints
  (`catalogue.json` / `<name>/index.json` / `<name>/<version>.hexpkg`),
  authenticated `POST /publish` with marketplace-as-signer, optional
  search/browse HTML frontdoor.
- **Publish CLI** (M9.8) — `src/commands/publish.ts`. `hex publish
  <component-path> --registry <url> --token <T>` flow.

What's missing for production:

- **M9.9 — `pages.dev` deploy + frontdoor polish + namespace governance**.
  The server runs; the deploy runbook ([`docs/registry-deploy.md`](./registry-deploy.md))
  is complete; what's parked is the *operational* surface: standing up
  `registry.hex.dev` on a managed host (Vercel + R2 + Postgres in the
  original sketch), wiring GitHub OAuth for namespace claims, the
  frontdoor site polish, and the publisher-onboarding flow.

## Why it's parked

The git-catalogue model (M13) covers the immediate use cases:

- **Internal-team templating** — NatWest, Textology, any company
  platform team. A catalogue repo + PR review IS the governance model
  they already use for code. No infra to run, no auth to manage.
- **OSS template sharing** — small communities can ship a
  `github.com/<org>/hex-catalogue` repo and tell consumers to point at
  it. No central registry needed.

The hosted-registry path remains the right answer when the catalogue
model breaks down (see "What this model is good for — and where it
breaks down" in [`marketplace-catalogue.md`](./marketplace-catalogue.md)).
There's no rush to land it ahead of demand.

## Unpark signals

Pick M9.9 back up when:

- A community catalogue grows past a few hundred packages and the
  `marketplace.yaml` review burden becomes the bottleneck.
- Anonymous publish becomes a requirement (third-party developers
  publishing to a public namespace).
- Users want discovery features the catalogue model can't cheaply
  provide — download counts, popularity ranking, deprecation signals
  with rich UI, full-text on README bodies, package pages with version
  histories.
- A first-party Hex registry (`registry.hex.dev`) becomes part of the
  product story for adoption — e.g. a "publish your stack" flow as part
  of the on-ramp.

Any one of those is enough to pull the trigger. None is true today, so
the work is parked rather than abandoned.

## Picking it back up — what to read first

1. **This page** — for the why and the index.
2. **[`docs/marketplace-package-format.md`](./marketplace-package-format.md)**
   — the on-the-wire spec. `hexpkg/1` is frozen, so any new work
   inherits the format.
3. **[`docs/registry-deploy.md`](./registry-deploy.md)** — the deploy
   runbook. Lists the env vars, the keypair generation, the proxy
   topology, the smoke-test flow.
4. **`registry/` source tree** — `server.ts` (HTTP routes), `store.ts`
   (filesystem layout), `publish.ts` (upload + sign + persist),
   `keygen.ts` (Ed25519 keypair generation), `auth.ts` (token map).
5. **`src/core/marketplace/`** + **`src/core/catalogue/`** — the
   client-side. `Source` (`source.ts`) and `Catalogue` (`marketplace.ts`)
   already speak the protocol the server emits, so a re-pickup only
   touches the server and the deploy.
6. **The original M9.9 ClickUp ticket** — for the parking context (why,
   when, what's been deferred).

## Coexistence with the catalogue model

A future-state Hex install can carry both:

```yaml
sources:
  - catalogue: https://github.com/textologylabs/hex-marketplace
  - catalogue: https://github.com/acme/hex-catalogue
marketplaces:
  - id: hex
    registry: https://registry.hex.dev/
  - id: acme
    registry: https://registry.acme.internal/
```

The aggregate layer (M9.5) treats every entry — `catalogue:` or
`marketplaces:` — as a `Catalogue` provider, so a user search hits all
of them. Block + override policy unions across both surfaces. The
`hex/` namespace claim in the registry doesn't need to know about the
catalogue model, and vice versa.

This page exists to make that coexistence cheap when M9.9 finally lands.

## CLI surface while parked (M15.6)

Because the registry isn't hosted, the CLI fences the hosted-registry
surface for 1.0 so it can't be mistaken for a ready feature:

- **`hex publish` is hidden** from `--help` and marked `[experimental]`.
  It still works against a `--registry` you run yourself (the reference
  server in `registry/`), but prints an experimental notice pointing at
  the git-catalogue model first. Sharing templates today goes through
  [a git-catalogue](./guides/catalogue-for-your-org.md), not this.
- **Resolution + signature verification** (`resolveAddress` + `trustedKeys`
  in `core/marketplace/`) is built and unit-tested but **wired to no
  command** — `hex new` resolves through `path:` / `git:` / `catalogue:`
  sources only. The signed-package path activates when the registry is
  picked back up; until then it is not a user-facing feature.
- **Upgrade limitation:** an app scaffolded from a marketplace artifact
  can't be reconstructed for `hex upgrade` (`pristine.ts` fails loudly
  rather than guess). Since `hex new` never resolves a marketplace
  source today, no real lockfile records one — but it's noted here so
  the constraint is explicit when the registry lands.
