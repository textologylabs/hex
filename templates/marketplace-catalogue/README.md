# {{ namespace }}

{% if description %}{{ description }}{% else %}A Hex marketplace catalogue.{% endif %}

This repo is a [Hex](https://github.com/textologylabs/hex) **catalogue** —
a git repo whose root carries a `marketplace.yaml` listing every package
under the `{{ namespace }}/` namespace, with each version's git source.

## How to consume this catalogue

Add it to your `~/.hex/config.yaml`:

```yaml
sources:
  - catalogue: <this-repo-url>
```

Then refresh and resolve:

```sh
hex sources refresh
hex new {{ namespace }}/<package-name>@<version> my-app
```

`hex list`, `hex search`, and `hex browse` will also surface every
package in this catalogue alongside any local / git sources you have.

## How to add a package (PR workflow)

1. Open `marketplace.yaml`.
2. Add an entry under `packages:` with at least one version. Each version
   needs a `tag` (must be `MAJOR.MINOR.PATCH`) and a `source` block with
   the package's `git:` URL, optional `ref:` (tag / branch / SHA), and
   optional `path:` (subdirectory inside the repo).
3. Open a pull request. The validate workflow at
   `.github/workflows/validate.yml` schema-checks `marketplace.yaml` on
   every push and PR — schema errors block the merge.

## How to publish a new version of an existing package

1. Cut the version in the package's own repo (tag a release).
2. Append a new entry to that package's `versions:` array in
   `marketplace.yaml`, pointing at the new tag.
3. PR + merge. Users pick up the new version on their next
   `hex sources refresh`.

## Block + override policy

`marketplace.yaml` carries two optional policy directives the catalogue
contributes to aggregate resolution:

- `overrides:` — a list of `{ name, use }` pairs that redirect a bare
  name to a qualified target. Useful for opinionated team defaults.
- `blocks:` — a list of qualified names (`<other-namespace>/<name>`)
  this catalogue refuses to surface or resolve. Useful for vetoing
  packages from catalogues your team distrusts.

Examples are commented out in `marketplace.yaml`; uncomment + edit when
you need them.

## Maintainers

- {{ maintainer }}

## Licence

{{ license }}
