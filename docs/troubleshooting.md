# Troubleshooting

Symptoms you might hit, what causes them, and the fix. Grouped by area. Most
entries point at the reference doc with the full story.

## Sources, cache & discovery

> **`hex list` shows nothing / my template isn't found.**

No sources are configured, or the one you expect isn't. Check what Hex sees with
`hex hive` (lists every source with cache + drift status). Add one with
`hex hive add --path ~/dev/templates` (local), `hex hive add <git-url> --git`, or
`hex hive add <catalogue-url>` (the default). A local source only surfaces
directories that contain a `.hex/manifest.{yaml,yml}`. See the
[config reference](./reference/config.md#sources).

> **"upstream has new commits — run `hex hive refresh`".**

Informational drift, not an error. Hex noticed (via a throttled `git ls-remote`,
at most once per 6 h) that a `git:` / `catalogue:` source moved ahead of your
cached checkout. You stay on the cached version until you run `hex hive refresh`.
Offline? The check fails silently and never blocks. See
[drift](./reference/config.md#upstream-drift).

> **A source is stuck on an old version even after the upstream changed.**

The cache is warm and within the 6 h drift window. Force it: `hex hive refresh`
re-fetches every git + catalogue source ignoring the cache. If a checkout looks
corrupt, delete the cache (`~/.hex/cache/`, or your `HEX_CACHE_DIR`) — it's
disposable and re-clones on next use.

> **Where is the cache? Can I move or clear it?**

`~/.hex/cache/` by default; set `HEX_CACHE_DIR` to relocate it. Deleting it is
always safe. Layout and details: [the cache](./reference/config.md#the-cache).

> **git source fails: "git executable not found on PATH".**

Hex shells out to your system `git` for git/catalogue sources. Install git and
ensure it's on `PATH`.

> **git source fails to authenticate (private repo).**

Auth is delegated entirely to your system `git` — Hex never prompts for or
stores credentials. If `git clone <url>` works in your shell, Hex will too. Fix
it at the git layer: SSH agent loaded, credential helper configured, or use an
`https://` URL with a helper / token. For SSH, prefer the `git@host:org/repo.git`
form.

## `hex new` — scaffolding

> **"output directory is non-empty".**

The target already has files. Pass `--force` to overwrite, or pick an empty
directory. Hex refuses by default so it never clobbers existing work.

> **`hex new acme/api` says "no template named acme/api".**

A qualified `<ns>/<name>` resolves through your configured **catalogues** — you
need the catalogue added first (`hex hive add <catalogue-url>`) and the package
indexed in its `marketplace.yaml`. Confirm with `hex hive info acme/api`.

> **`--answers` fails with a missing/invalid answer.**

In non-interactive mode every **required** prompt with no default must be
supplied in the answers file, and supplied values are validated (type,
`pattern`, `min`/`max`, enum membership). The error names the offending prompt;
it never hangs waiting for input. Recipe-child answers nest under the slot key
(`api: { port: 8080 }`). Note hook-defined prompts aren't covered by the answers
file yet. See [`hex new --answers`](./reference/cli.md#hex-new).

> **Setup tasks didn't run after scaffolding.**

Expected for an **untrusted remote source** (or any non-interactive run): `run:`
tasks are left pending rather than executed silently. Finish them with
`hex setup`, or pre-trust the source (`hex hive add <url> --trust`). The full
trust model is in [Security § 2](./security.md#2-run-setup-tasks).

## Hooks & the sandbox

> **A JS hook errors with "no such global" / can't read a file / no network.**

By design. Template JS hooks run in a **QuickJS-WASM sandbox** with no
`require`, `process`, `child_process`, `fs`, or network — only `answers`,
`recipe`, a scoped `project.*` facade, and `log.*`. A hook reaching for anything
else fails. Rewrite it against the bridged surfaces. See
[Security § 1](./security.md#1-js-hook-sandbox).

> **A hook hits the CPU deadline or memory ceiling.**

Hooks are capped (default 5 s CPU, 32 MiB). A breach aborts the hook — it usually
means an accidental infinite loop or runaway allocation, not a limit to raise.

> **"rendered path escapes the output directory".**

A templated filename resolved to a path outside the output root (a `../` or
absolute path leaked through Nunjucks). Guard whole-file emission with the
manifest's [`include:`](./reference/manifest.md) rules rather than `{% if %}`
around a filename.

> **`--trust-local` "isn't working" on a git source.**

`--trust-local` (run hooks unsandboxed, lift the `run:` allowlist) applies
**only to local `file:` sources** — the dev loop for a template you're writing.
Git / catalogue / marketplace bundles are always sandboxed regardless of the
flag; the trust gradient is the bundle's origin, not your wish. See
[`--trust-local`](./security.md#--trust-local).

## `hex upgrade`

> **"no `.hex/lockfile.yaml` here".**

You're outside a Hex-generated app, or the lockfile is gone. `hex upgrade` walks
up from the cwd looking for it. Apps generated before M10.2 have none and can't
be upgraded — re-scaffold from the same answers and copy your edits over.

> **"an upgrade is already in progress".**

A previous upgrade paused on conflicts and left `.hex/upgrade-state.yaml`. Resolve
the conflict markers and run `hex upgrade --continue`, or discard it with
`hex upgrade --abort` (restores the tree from the backup).

> **"N file(s) still have unresolved conflict markers".**

`--continue` found `<<<<<<<` / `>>>>>>>` still in a conflicted file. The message
names them — remove every marker, then `--continue` again. The full conflict
workflow (with real output) is in [the upgrade guide](./upgrade.md#a-worked-example-end-to-end).

> **`hex doctor` says "N files diverged from the lockfile".**

Not an error — it's reporting the files you've edited since scaffolding. Those
are exactly the files a future upgrade treats as "ours" in the 3-way merge.

## Display

> **Glyphs render as `[#]` / `[ ]` instead of hexagons, or boxes are garbled.**

Hex fell back to ASCII because it didn't detect a UTF-8 capable terminal. Force
it with `HEX_FORCE_UNICODE=1` (or `HEX_FORCE_ASCII=1` to pin the fallback). On
Windows, Unicode is detected from the terminal (Windows Terminal, VS Code), not
the locale. Disable colour with `NO_COLOR`. See
[environment variables](./reference/config.md#environment-variables).

## Still stuck?

`hex doctor` is a read-only health check — terminal capabilities, runtime info,
lockfile integrity, and outstanding setup tasks in one place. Run it first; it
often names the problem. For a suspected security issue, open a private advisory
(see [Security § Reporting](./security.md#reporting)).
