# Deploy + CI/CD

Hex's pitch is **zero to dev environment, fast**. Scaffolding is half of
that. The other half is *putting the app live somewhere a teammate can
hit a URL*. That's what `hex deploy` does, and what the generated
`.github/workflows/deploy.yml` does on every push after.

This page is the user-facing tour. For the internals (adapter
interface, registry, schema), see [`src/core/deploy/`](../src/core/deploy/).

## Two pluggable layers

A template's deploy story is two independent choices:

- **Deploy adapter** — knows how to ship a build artifact to one target.
  Vercel, Cloudflare Pages, Fly, S3, your own VPS — each is its own
  adapter. Hex 0.x ships **Vercel** built in.
- **CI/CD provider** — emits the workflow yaml (`.github/workflows/*.yml`,
  `.gitlab-ci.yml`, …) that runs the deploy adapter on every push. Hex 0.x
  ships **`github-actions`** built in.

The two axes are orthogonal — `vercel × github-actions`,
`vercel × gitlab-ci`, `cloudflare-pages × github-actions` are all valid
combinations. New adapters and providers land via the marketplace
(Phase 5) without touching Hex itself.

Both layers are declared per-template in `.hex/manifest.yaml`:

```yaml
deploy:
  adapter: vercel
  prod: false              # default; true → pass --prod to vercel CLI

cicd:
  provider: github-actions
  node-version: '20'       # default
  deploy-on: push-main     # default; alternative: manual
```

When `hex new` finishes, both stanzas are **pinned into the generated
app's `.hex/lockfile.yaml`** so the generated app is self-describing —
`hex deploy` doesn't need the source bundle to be still reachable.

## `hex deploy` from your laptop

The first deploy happens before the repo even has a remote:

```sh
export VERCEL_TOKEN=…       # see "Tokens" below
hex deploy
```

What that does:

1. Walks upward from cwd like `hex setup` / `hex doctor` looking for
   `.hex/lockfile.yaml`.
2. Reads the `deploy:` stanza and resolves the adapter
   (`vercel`, `none`, …) via the in-process registry.
3. Checks the adapter's required env vars (`VERCEL_TOKEN` for Vercel) —
   exits non-zero with a clear message if any are missing.
4. Calls `adapter.deploy(ctx)`. For Vercel, that shells out to
   `vercel deploy --yes --token "$VERCEL_TOKEN"` (and `--prod` when
   the stanza opts in), captures stdout/stderr, and parses the deploy
   URL.
5. Prints the URL on success; on failure, prints the vercel CLI's own
   stderr so you can see what went wrong.

A few useful flags:

```sh
hex deploy --dry-run        # describe the planned invocation without acting
```

`--dry-run` reports the adapter name, the app root, and which env vars
are set vs missing — useful for checking the pipeline before burning a
real deploy.

If the manifest has no `deploy:` stanza (or `adapter: none`), `hex deploy`
exits cleanly with a "nothing to do" note rather than erroring.

## `.github/workflows/deploy.yml` on every push

The CI/CD provider emits this file at scaffold time. For a vite-ts-spa
shipped with the built-in template:

```yaml
name: Deploy
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run test
      - run: npm run lint
      - run: npm run build
      - name: Deploy via vercel
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
        run: npx --yes vercel@latest deploy --yes --prod --token "$VERCEL_TOKEN"
```

Same Vercel adapter, two callers — your laptop and CI. Switch from
`vercel` to a different adapter and the emitted yaml's deploy step
changes accordingly; the build pipeline is unchanged.

`deploy-on: manual` swaps the trigger to `workflow_dispatch` (run only
when you click "Run workflow" in GitHub).

## Tokens

For Vercel:

1. Get a token at <https://vercel.com/account/tokens> — pick "Full
   account" or scope to a single project.
2. **Local** — export it in your shell (or a `.envrc`, password
   manager, whatever you use). Hex never persists tokens.
3. **CI** — set it as a GitHub repo secret:
   ```sh
   gh secret set VERCEL_TOKEN
   ```
   The emitted workflow already references `${{ secrets.VERCEL_TOKEN }}`.

`vercel link` once locally (creates `.vercel/`, which is in the
template's `gitignore`) so the CLI knows which project to deploy to.

## Adding deploy to your own template

If you author a template, add the stanzas to your `.hex/manifest.yaml`:

```yaml
deploy:
  adapter: vercel

cicd:
  provider: github-actions
```

Both are optional. Omit them and `hex deploy` is a no-op for your
generated apps. Add them and the `hex new` flow plus
`.github/workflows/deploy.yml` work out of the box.

If you also want post-render setup tasks (set the token, run `vercel
link`, etc.), declare them in the manifest's `setup:` block — Hex
walks the user through them after rendering. The vite-ts-spa template
in this repo is a complete example.

## What's coming

Hex 0.x is **Phase 2**: one deploy adapter (Vercel), one CI/CD provider
(`cicd-github-actions`), standalone components only. The roadmap from
[`idea.md`](../idea.md):

- **Recipe-level deploy** (Phase 3 / M5) — composed children, each with
  their own `deploy:` stanza, orchestrated together by `hex deploy`.
- **Step contribution** (Phase 3) — components contribute pipeline
  steps (typecheck, test, migrate, …) that the CI/CD provider
  assembles into the final workflow.
- **More adapters and providers** — Cloudflare Pages, Fly, S3, GitLab
  CI — landing through the marketplace once Phase 5 ships.
