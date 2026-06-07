# Testing — the manual-test matrix

The automated suite (`npm test`) covers everything Hex's pure code does
and everything it can verify against a `file://` URL on darwin. Three
surfaces remain hard to automate cheaply and have to be walked by hand
**before each release**:

1. **TTY prompts** — the real `@clack/prompts` wiring against an actual
   terminal (`src/core/prompts/clack-prompter.ts`). Unit tests use a
   scripted `Prompter`; a regression in the real implementation only
   shows up here.
2. **Git auth paths other than `file://`** — HTTPS public, HTTPS
   credential-helper, and SSH-agent flows. `resolveGitSource` shells
   out to system `git`, so the auth surface is the user's `~/.gitconfig`
   + agent + credential helper. CI only exercises `file://`.
3. **Windows shell-to-git** — every git resolver call is `execFile('git', …)`.
   msys-git on Windows has quirks around path handling and stdio
   buffering. All current CI runs on darwin.

Each section below names the **specific commands** to run and the
**specific outputs** to look for. If anything new ships in
`src/core/prompts/`, `src/core/sources/git-source.ts`, or
`src/commands/`, extend the relevant section.

---

## 1. TTY prompts (`createClackPrompter`)

Run from a real terminal — no `script`, no `unbuffer`, no piped output
(piping turns off `process.stdout.isTTY` which the prompter relies on).

### 1.1 `hex new` prompt rendering

```sh
hex new templates/node-ts-cli /tmp/hex-test-cli
```

Expect, in order:
- Splash banner.
- `Template: hex/node-ts-cli @0.2.0` (or current version).
- **`text` prompt** for *Package name* with pattern validation: type
  `BAD NAME` and the prompt rejects without leaving the line. Type
  `valid-cli` and it accepts.
- **`text` prompts** for *Short description* and *Author* with empty
  defaults.
- **`select` prompt** for *License* — arrow keys move between MIT and
  Apache-2.0; Enter selects.
- Three **`confirm` prompts** (examples / self-update / publish
  workflow) — `y`/`n`/Enter all behave.
- Spinner showing `rendering` then `rendered N files`.
- Either a `done — /tmp/hex-test-cli` outro (no setup tasks) or the
  M4 setup loop (next test).

### 1.2 `hex setup` interactive loop

```sh
cd /tmp/hex-test-cli   # or any generated app with .hex/checklist.yaml
hex setup
```

Walk through the tasks and confirm:
- `intro( hex setup )` banner.
- `N pending, M done` summary line.
- For each task: a `note()` block with the title + detail and a
  `[ ]` or `[✓]` checkbox, then a `select` with three choices
  (`Mark as done` / `Skip for now` / `Quit (resume with: hex setup)`).
- Toggling persists immediately — open `.hex/checklist.yaml` in another
  terminal mid-loop; the toggled task should already show `status: done`.
- `Quit` exits cleanly with a `N pending — resume with hex setup` outro.
- Re-running `hex setup` resumes where you left off.

### 1.3 Cancellation

Ctrl-C during any prompt:
- Should exit with no stack trace, no partial files on disk.
- A mid-`hex new` cancel must NOT leave a half-written output directory
  (the `executeNewRender` path is transactional in the spinner block).
- A mid-`hex setup` cancel must NOT corrupt `.hex/checklist.yaml` — the
  atomic-write fix landed in the tech-debt sweep covers this.

### 1.4 Other surfaces that use the prompter

- `hex browse` interactive category picker.
- `hex search` — non-interactive, but a TTY-aware piped run should
  print the flat table.

Run each at least once and confirm no rendering glitch since the last
release.

---

## 2. Git auth paths

The unit suite uses `file://` URLs (`test/core/sources/git-source.test.ts`)
because spinning up real SSH/HTTPS servers in CI is heavy. The three
real auth surfaces below have to be walked by hand against actual
remotes.

For each, **start from an empty cache** so you exercise the cold-clone
path:

```sh
rm -rf ~/.hex/cache/git
```

### 2.1 HTTPS, public repo

```yaml
# ~/.hex/config.yaml
sources:
  - git: https://github.com/textologylabs/hex-templates-public
    ref: main
```

```sh
hex sources refresh
hex list
```

Expect a clean clone into `~/.hex/cache/git/<urlHash>/main-<refHash>/repo`
with a sibling `.hex-meta.json`. `hex list` enumerates the templates.

### 2.2 HTTPS, private repo via credential helper

Pre-req: `git config --global credential.helper osxkeychain`
(or your platform's equivalent) and credentials cached for the host.

```yaml
sources:
  - git: https://github.com/<your-org>/<private-repo>
    ref: main
```

Same `refresh` + `list` cycle. The first call should silently use the
credential helper (no prompt). If `git` itself prompts for credentials,
that's a Hex bug — we don't pipe its stdin and the prompt would hang.

### 2.3 SSH, agent-driven

Pre-req: `ssh-add -l` lists your key.

```yaml
sources:
  - git: git@github.com:<your-org>/<private-repo>.git
    ref: main
```

Same cycle. SSH agent should authenticate without interaction.

### 2.4 Failure modes

- **Unreachable URL** (`https://nonexistent.invalid/r`) → `hex sources`
  reports the error per-source, doesn't crash, marks the source as
  unhealthy.
- **Auth failure** (deleted credentials, no agent) → clear error
  surfaced by `GitSourceError`; cache directory is NOT polluted with a
  partial clone.

---

## 3. Windows (`darwin → win32` regressions)

All current CI runs on darwin. Before each release, run the suite on
Windows (a Windows VM or `actions/runner` host) at least once. msys-git
ships with most Windows dev environments.

### 3.1 Suite

```powershell
git clone https://github.com/textologylabs/hex
cd hex
npm install
npm run check
```

If any failure surfaces, the most likely culprits are:

| Surface | Likely failure mode | Where |
| --- | --- | --- |
| Path separators | A test asserts `/` where Windows produces `\` | grep `'/'` literals in test assertions |
| `file://` URL form | Windows file URLs are `file:///C:/...` (three slashes, drive letter) | `git-source.test.ts` |
| stderr decoding | `execFile` stderr buffer may be Buffer rather than string under msys-git | `git-source.ts` `runGit`'s `err.stderr` |
| Cache path layout | sha256-based, should be fine — but verify a 200+ char path doesn't trip `PATH_MAX` | `cacheDirFor` output |
| Atomic rename | `fs.rename` across `temp → target` on same volume is atomic; cross-volume isn't — confirm the `writeFileAtomic` temp lives in the same dir as the target | `src/core/util/atomic.ts` |

### 3.2 End-to-end smoke

```powershell
node dist\cli.js new templates\node-ts-cli C:\Users\<you>\hex-test
```

- Walk the same prompts as §1.1.
- Confirm files were written with correct content + line endings.
- `hex doctor` from inside the generated dir reports lockfile clean.

### 3.3 Known-broken-on-Windows

(Track here as scenarios are discovered. Currently: none confirmed —
Windows hasn't yet been walked in earnest. **First Windows pass is a
release blocker for v1.0.**)

---

## 4. `hex deploy` end-to-end (M12)

Unit tests cover the dispatch shape (scripted adapter, mocked
`execFile`) and the workflow-yaml emitter. What they can't cover is
the actual Vercel CLI and the actual GitHub Actions runner — both have
to be exercised against real services before a release.

### 4.1 Pre-reqs

- A throwaway Vercel project (don't reuse a production one).
  `vercel link` it locally if you haven't.
- A throwaway GitHub repo with `VERCEL_TOKEN` set as a secret:
  ```sh
  gh secret set VERCEL_TOKEN
  ```
- `VERCEL_TOKEN` exported in your local shell for the laptop-deploy
  pass.

### 4.2 Laptop deploy (`hex new` + `hex deploy`)

```sh
rm -rf /tmp/hex-vts && \
  node dist/cli.js new templates/vite-ts-spa /tmp/hex-vts && \
  cd /tmp/hex-vts && \
  npm install && \
  hex deploy --dry-run
```

Expect:
- `--dry-run` prints `adapter: vercel`, the app root, and
  `VERCEL_TOKEN=<set>` (or `<missing>` if you forgot to export it).
- Exit code 0, no Vercel API calls.

Now the real one:

```sh
hex deploy
```

Expect:
- The vercel CLI runs (you'll see its banner).
- A `https://…vercel.app` URL printed on stdout.
- Exit code 0.
- The app is actually reachable at the printed URL.

Failure modes worth a manual sweep — each should exit non-zero with a
single clear message and **no half-deployed state**:
- `unset VERCEL_TOKEN; hex deploy` → "missing required env vars: VERCEL_TOKEN".
- `VERCEL_TOKEN=bogus hex deploy` → vercel CLI's own auth error
  surfaced via `VercelDeployError`.
- `cd /; hex deploy` → "No .hex/lockfile.yaml found …".

### 4.3 CI/CD deploy (GitHub Actions)

Push the generated `/tmp/hex-vts` to the throwaway repo's `main`:

```sh
git init -b main && git add . && git commit -m "init" && \
  git remote add origin <repo-url> && git push -u origin main
```

Then in the GitHub Actions tab:

- The `Deploy` workflow runs.
- All pipeline steps (`npm ci`, typecheck, test, lint, build) pass.
- The `Deploy via vercel` step prints a `https://…vercel.app` URL.
- The workflow concludes green.
- The app is reachable at the printed URL.

If `deploy-on: manual` is set in the manifest, the workflow should
only run via the "Run workflow" button — not on push.

### 4.4 No-adapter path

To confirm the `none` adapter path:

```sh
node dist/cli.js new templates/node-ts-cli /tmp/hex-cli-noop && \
  cd /tmp/hex-cli-noop && hex deploy
```

`node-ts-cli` does not declare a `deploy:` stanza. Expect:
- stdout: `No deploy adapter configured — nothing to do.`
- Exit code 0. No vercel invocation.

---

## 5. Git-catalogue marketplace end-to-end (M13)

Cheap to exercise locally with a `file://` catalogue, but the **real**
surface is a public GitHub catalogue + a `https://` clone — that's the
path users actually walk and the only one that catches auth /
case-sensitivity / proxy-config regressions.

### 5.1 Local round-trip (`file://`)

```sh
# Scaffold a catalogue from the starter template
node dist/cli.js new templates/marketplace-catalogue /tmp/hex-cat-local

# Initialise it as a git repo so it has a clonable URL
cd /tmp/hex-cat-local && git init -q -b main && \
  git add . && git -c user.name=Test -c user.email=t@x git commit -q -m init

# Point Hex at it via ~/.hex/config.yaml
cat >> ~/.hex/config.yaml <<EOF
sources:
  - catalogue: file:///tmp/hex-cat-local
EOF

node dist/cli.js sources           # expect: catalogue line, namespace + 1 package
node dist/cli.js list              # expect: the placeholder `example` row mixed in
node dist/cli.js search example    # expect: hit from your catalogue
```

Expect each of those to surface the catalogue without errors.

### 5.2 Public GitHub catalogue

The seed `textologylabs/hex-marketplace` repo is the canonical fixture.
Add it to `~/.hex/config.yaml`:

```yaml
sources:
  - catalogue: https://github.com/textologylabs/hex-marketplace
```

Then walk:

```sh
node dist/cli.js sources refresh   # expect: clones cleanly, ✓ ok
node dist/cli.js list              # expect: both seeded packages in the table
node dist/cli.js new hex/vite-ts-spa /tmp/hex-cat-vite
```

Verify:
- Catalogue clone landed in `~/.hex/cache/git/...`.
- `/tmp/hex-cat-vite/.hex/lockfile.yaml` carries
  `root.source.kind: catalogue` with the right `catalogue_url` +
  `namespace` + `name`.
- The render itself works — `cd /tmp/hex-cat-vite && npm install && npm run build`.

### 5.3 Schema-validation CI gate

Open a PR on `textologylabs/hex-marketplace` that breaks
`marketplace.yaml` (e.g. add a duplicate package name, or a
non-kebab-case namespace). Expect:
- The `.github/workflows/validate.yml` workflow fails red with the
  schema issues printed.
- Merge is blocked.
Revert the breaking change; the next push should turn the workflow
green.

> **Note: pending Hex npm publish.** The validate workflow uses
> `npx --yes @hexology/hex@latest …`, so 5.3 only goes green once Hex
> is published. Until then, run `node dist/cli.js marketplace validate
> marketplace.yaml` locally as a substitute.

### 5.4 Block + override policy

In the seed catalogue, add a `blocks:` entry (e.g.
`blocks: [other-ns/banned]`) and an `overrides:` entry. Push to a branch
and add it to your config. Expect:
- `hex list` / `hex search` never surface the blocked qualified name.
- `hex new other-ns/banned my-app` fails with the block error.
- A bare `hex new <override-name>` redirects to the override target.

---

## Release runbook

Releases are tag-triggered (M14.2). The actual publish happens in
`.github/workflows/release.yml`; this section is the one-time setup +
the per-release procedure.

### One-time setup

1. **Mint an npm automation token.** Go to
   `https://www.npmjs.com/settings/<your-user>/tokens` → "Generate New
   Token" → **Automation** type (CI-safe, bypasses 2FA on publish).
   Copy the `npm_…` string once — npm doesn't show it again.

2. **Add it as a repo secret.**
   ```sh
   gh secret set NPM_TOKEN -R textologylabs/hex
   # paste the token when prompted
   ```
   `GITHUB_TOKEN` is provided automatically by Actions — no action
   needed for the gh-release step.

3. **Verify the workflow file.** `.github/workflows/release.yml` runs
   on `push` to a `v*.*.*` tag: lint + typecheck + tests → build →
   `tag-matches-package.json-version` guard → `npm publish --access
   public` → `gh release create` with notes lifted from the matching
   `## [<version>]` CHANGELOG section.

### Per-release procedure

After walking the test matrix above:

1. **Bump version.** Edit `package.json` (and `src/brand/splash.ts`
   `VERSION` if it's drifted), commit on `main` with a `release: vX.Y.Z`
   message.

2. **Move CHANGELOG entries.** Take every bullet currently under
   `## [Unreleased]` and put them under a new `## [X.Y.Z] — YYYY-MM-DD`
   heading. Add a 2–3 paragraph headline summarising the release.
   Commit on `main`.

3. **Tag + push.**
   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

4. **Watch the workflow.** `gh run watch -R textologylabs/hex` should
   show the release run go green in ~3–5 minutes. On failure, the tag
   stays (the action ran but the publish or release-create step
   failed) — fix forward and re-push the tag with `git tag -f` if
   necessary, or cut a patch release.

5. **Smoke the published package.** From a clean tmpdir:
   ```sh
   npx --yes @hexology/hex@X.Y.Z --version
   ```
   Expect `X.Y.Z`. If `npx` reports "404 Not Found", npm's CDN is still
   propagating — wait a minute and retry.

### Release checklist

Before tagging a release:

- [ ] §1.1 + §1.2 + §1.3 on macOS (or your dev machine).
- [ ] §2.1 + §2.2 + §2.3 with a real public repo + a real private repo
      you control. §2.4 failure modes covered.
- [ ] §3.1 + §3.2 on Windows.
- [ ] §4.2 + §4.3 + §4.4 against a throwaway Vercel project + a throwaway
      GitHub repo.
- [ ] §5.2 against `textologylabs/hex-marketplace` over `https://`.
      §5.4 block + override against a branch you control. §5.3 once Hex
      is on npm.
- [ ] `npm run check` passes.
- [ ] CHANGELOG entry moved from `[Unreleased]` to `[X.Y.Z]` with date.
- [ ] `package.json` version bumped + committed.
- [ ] `NPM_TOKEN` secret is set on the repo (one-time, see above).

This page is the contract for that walk. If you skip a step, write it
down here as a known gap rather than letting it rot in your head.
