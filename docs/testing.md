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

## Release checklist

Before tagging a release:

- [ ] §1.1 + §1.2 + §1.3 on macOS (or your dev machine).
- [ ] §2.1 + §2.2 + §2.3 with a real public repo + a real private repo
      you control. §2.4 failure modes covered.
- [ ] §3.1 + §3.2 on Windows.
- [ ] `npm run check` passes.
- [ ] CHANGELOG entry for the release.
- [ ] `prepublishOnly` script (`npm run check && npm run build`) runs
      automatically on `npm publish` and gates the tarball.

This page is the contract for that walk. If you skip a step, write it
down here as a known gap rather than letting it rot in your head.
