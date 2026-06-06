# Git-catalogue marketplaces

Hex's pitch is **a marketplace of templated components without anyone
having to run a server**. A *catalogue* is just a git repo whose root
carries a `marketplace.yaml`. You point Hex at the catalogue, Hex reads
the yaml, and `hex new <namespace>/<package>@<version>` does the rest.

That's the whole model. No registry to host, no auth to manage, no
tarballs to sign. Companies curate by PR; users pull by URL.

This page is the user-facing tour. For the on-disk wire format of
`marketplace.yaml` itself, see
[`src/core/marketplace/catalogue-schema.ts`](../src/core/marketplace/catalogue-schema.ts).
For the parked, more-ambitious hosted-registry model, see
[`docs/marketplace.md`](./marketplace.md).

## Two layers

A catalogue is two layers, both backed by plain git:

1. **The catalogue repo** — a git repo whose root carries one
   `marketplace.yaml`. This is where curation happens: PRs add packages,
   bump versions, declare block + override policy.
2. **The package repos** — every version entry inside `marketplace.yaml`
   points at a `git:` URL + optional `ref:` + optional `path:` for the
   bundle's location inside the repo. Each package's source is its own
   repo with its own release cadence — the catalogue is just an index.

The two layers are independent. A catalogue can point its packages at
any git URL you can `git clone` — public GitHub, private GitLab, your
internal Gitea, anything. The catalogue itself can be public while the
packages it indexes live in private repos (whoever clones the catalogue
needs read access to whichever package repos they actually resolve).

## Adding a catalogue to your config

Add a `catalogue:` entry to your `~/.hex/config.yaml`:

```yaml
sources:
  - path: ~/dev/my-templates                                 # local
  - git: https://github.com/acme/templates                   # bare git
  - catalogue: https://github.com/textologylabs/hex-marketplace
  - catalogue: https://github.com/acme/hex-catalogue
    ref: stable                                              # optional pin
```

`catalogue:` sits beside the existing `path:` and `git:` source kinds.
You can mix all three — Hex unions discovery across the whole list.

The catalogue repo is cloned lazily on first use into
`~/.hex/cache/git/...` (override with `HEX_CACHE_DIR`). `hex sources
refresh` force-fetches every git and catalogue source; `hex sources`
reports per-source cache + drift state, and for catalogues additionally
reports the parsed namespace and package count (or schema-validation
errors).

## Resolving packages

Once a catalogue is in your config, every read command surfaces its
packages:

```sh
hex list                       # mixed table: local + git + catalogues
hex search vite                # name / description / category match
hex browse                     # category drilldown (interactive)
hex new hex/vite-ts-spa my-app # qualified address — pins one catalogue
hex new vite-ts-spa@^1.0 my-app # bare + version spec — walks catalogues
hex new vite-ts-spa my-app     # bare, no version — prefers local first
```

Address grammar (M9.4):

| Form                            | Resolution                                       |
| ------------------------------- | ------------------------------------------------ |
| `<namespace>/<name>@<spec>`     | Pins exactly this catalogue + version            |
| `<namespace>/<name>`            | Pins this catalogue, version = `latest`          |
| `<name>@<spec>`                 | Walks all catalogues, first satisfying hit wins  |
| `<name>`                        | Local discovery first, then catalogues for fallback |

Version specs follow semver-style: `^1.0`, `~1.2.3`, exact `1.0.0`, or
`*` / `latest` for "highest available".

## Block + override policy

Every catalogue can carry two optional policy directives that travel
with it. Both apply only to that catalogue's view of resolution — no
global user-level policy file.

```yaml
# In marketplace.yaml
overrides:
  - name: db-postgres        # when a user types `hex new db-postgres`
    use: acme/db-postgres    # redirect to this qualified target

blocks:
  - other-ns/banned-package  # never surface or resolve this qualified name
```

- `overrides:` — bare-name redirects. When a user resolves a bare name
  (e.g. `db-postgres`), the first catalogue in declared order that
  carries an override for that name wins, and the address is redirected
  to the qualified target. Useful for company-wide defaults ("when
  anyone on our team types `db-postgres`, give them OUR `acme/db-postgres`").
- `blocks:` — qualified-name vetoes. The qualified name is hidden from
  `hex list` / `hex search` / `hex browse` and refused by `hex new`.
  Useful for explicitly vetoing third-party packages.

Both are evaluated catalogue-by-catalogue; blocks union across all
configured catalogues, overrides claim first-match-wins in declared
order (same precedence as bare-name resolution).

## Hosting your own catalogue

The fastest path is the starter template:

```sh
hex new templates/marketplace-catalogue ./my-catalogue
cd my-catalogue
# fill in marketplace.yaml with real packages
git init -b main && git add . && git commit -m "initial catalogue"
git remote add origin <your-github-url>
git push -u origin main
```

The starter ships a fully-validated `marketplace.yaml` skeleton, a
`README.md` covering the consume + publish workflow, and a
`.github/workflows/validate.yml` that runs `hex marketplace validate
marketplace.yaml` on every push and PR — your CI gate against schema
breakage.

### Adding a package

1. PR the `marketplace.yaml` change. Each package needs a `name`,
   optional `description` / `kind` / `categories`, and a `versions:`
   list with at least one entry. Each version needs a `tag` (semver
   triplet) and a `source:` block with `git:` + optional `ref:` /
   `path:`.
2. The validate workflow schema-checks the diff. Merge when green.
3. Users get the new package on their next `hex sources refresh`.

### Bumping a version

1. Cut the version in the package's own repo (tag a release).
2. Append a new entry to that package's `versions:` array in the
   catalogue, pointing at the new tag.
3. PR + merge.

Versions are append-only by convention — never delete or rewrite an
existing entry, since users may have lockfiles pinning it. Use `blocks:`
to retract a published version if you must.

## What this model is good for — and where it breaks down

The git-catalogue model is the right shape when **curation is by
people you trust** (company platform team, OSS project, working group)
and **the package count is in the dozens to low hundreds**. Every
addition gates through a PR; every update is auditable; the catalogue
itself is a normal repo with normal release tooling.

It is **not** the right shape when:

- Anyone in the world can publish to the marketplace. PR review doesn't
  scale to drive-by uploads.
- The catalogue grows past ~thousands of packages. The whole `marketplace.yaml`
  is read and validated on every refresh — keep it small.
- You want richer search (popularity ranking, download counts, deprecation
  signals, full-text on README bodies). The hosted-registry path
  ([`docs/marketplace.md`](./marketplace.md)) is the spec for that future.

For the immediate goals — company-internal templating, OSS template
sharing, opinionated stack curation — the catalogue model covers it.

## Reference

- [`src/core/marketplace/catalogue-schema.ts`](../src/core/marketplace/catalogue-schema.ts)
  — the zod schema for `marketplace.yaml`. The acceptance criteria for
  what counts as a valid catalogue.
- [`src/core/marketplace/catalogue-source.ts`](../src/core/marketplace/catalogue-source.ts)
  — the `CatalogueSource` implementation: clone catalogue repo, resolve
  package version, fetch package source.
- [`templates/marketplace-catalogue/`](../templates/marketplace-catalogue/)
  — the starter template (M13.5).
- `hex marketplace validate <path>` — the schema-check CLI used by the
  starter template's CI gate.
