# Security & trust model

Hex fetches templates and components from places you may not control — a
git repo, an org catalogue, (eventually) a hosted marketplace — and then
**runs code from them on your machine**: JavaScript hooks during
rendering, and shell commands during post-scaffold setup. This document
is the threat model and the privilege boundaries that contain it.

The short version:

| Surface | What runs | Containment |
|---|---|---|
| **JS hooks** (`.hex/hooks/*.js`) | template-authored JavaScript, at render time | QuickJS-WASM sandbox — no filesystem, process, or network; CPU + memory capped |
| **`run:` setup tasks** | shell commands, after scaffolding | allowlisted binaries **+** source-trust gating |
| **Marketplace packages** | downloaded `.hexpkg` archives | Ed25519 signature verified before unpack (fail-closed) |

Nothing from an untrusted source executes on your machine without either
(a) the sandbox, or (b) your explicit consent.

---

## 1. JS hook sandbox

A component can ship `pre_render` / `post_render` hooks written in
JavaScript (`.hex/hooks/<name>.js`). These run inside an embedded
**QuickJS-WASM** interpreter (`src/core/hooks/sandbox.ts`), not the host
Node process. Inside the sandbox a hook can see only what Hex bridges in:

- `answers`, `recipe`, a sandboxed `project.*` filesystem facade scoped
  to the output directory, and a `log.*` sink.
- **No** `require`, `process`, `child_process`, `fs`, or network. The
  interpreter has no host bindings beyond the four surfaces above.

Resource limits stop a malicious or runaway hook: a per-call **CPU
deadline (default 5 s)** and a **memory ceiling (default 32 MiB)**;
breaching either aborts the hook.

The `project` facade itself guards against path traversal — absolute
paths, `..` escapes, and symlinks resolving outside the output root are
rejected — so even the filesystem access a hook *does* have can't reach
outside the generated project.

### `--trust-local`

`hex new --trust-local` runs JS hooks **unsandboxed** in the host Node
process. This exists only for the dev loop — iterating on a template you
are writing yourself. It applies **only to `file:` sources** (a local
path or a `kind: path` source root). Hooks from git / catalogue /
marketplace sources are **always** sandboxed, regardless of the flag —
the trust gradient is the bundle's origin, not the user's wish. Each
unsandboxed hook prints a loud warning so the bypass is never silent.

---

## 2. `run:` setup tasks

A setup task may declare a `run:` command (`npm install`, `git init`,
`gh secret set …`). After scaffolding, `hex new` offers to execute the
pending tasks. Two independent gates apply.

### 2a. The command allowlist

`run:` commands are tokenised (no shell — no `$VAR`, globs, `&&`, or
pipes) and the binary is checked against an allowlist. The default is:

```
npm  npx  yarn  pnpm  bun  node  git  gh  hex  vercel
```

**The allowlist is a guardrail against typos and casual mistakes, not a
sandbox.** Several allowlisted binaries can reach arbitrary code —
`npx <anything>` fetches and runs a package, `npm install` runs install
scripts, `node -e "…"` is arbitrary JS, `git` can fire hooks. That is
exactly why the allowlist is **not** the only gate (see 2b).

You can change the allowlist in `~/.hex/config.yaml`:

```yaml
trust:
  allowlist: [npm, git]   # tighten to just these
  # allowlist: []         # lock down — NO run: task may auto-run
```

An empty list blocks every `run:` task. An org that wants Hex to scaffold
files but never execute anything sets `allowlist: []`.

### 2b. Source trust

The allowlist says *which binaries*; source trust says *whose commands*.

- **Local (`file:`) sources** are trusted to auto-run — you chose the
  path. (The allowlist still applies unless `--trust-local`.)
- **Remote sources** (git / catalogue / marketplace) auto-run their
  `run:` tasks **only** when the source is on your trusted list:

  ```yaml
  trust:
    sources:
      - https://github.com/acme/hex-catalogue
  ```

  Add one from the CLI instead of hand-editing:
  `hex hive add <url> --trust`, or `hex hive add --trust` on an existing
  source.

When you scaffold from an **untrusted remote source**, Hex does not run
its tasks silently. In an interactive terminal it asks how to proceed:

```
⚠ acme/api is an untrusted remote source — its setup tasks run code on your machine.
  ❯ Trust this source & run its tasks   (remembers it in config.yaml)
    Review each command before it runs   (this run only)
    Skip — leave tasks pending, I'll run them myself
```

- **Trust** persists the source to `trust.sources` and runs the tasks;
  it won't ask again for that source.
- **Review each** runs the auto-pass but pauses for a y/N on *every*
  command.
- **Skip** leaves the tasks pending; run them later with `hex setup`
  (each is narrated and confirmed by the M14.11 hand-off ritual).

In a **non-interactive** context (CI, piped, `--no-setup`) an untrusted
remote source's tasks **never auto-run** — they're left pending. To
auto-run in CI, pre-trust the source in `config.yaml`. This makes trust
an auditable, reviewable artifact (your security team can read
`config.yaml`) rather than a click no one can see.

---

## 3. Marketplace package signatures

Published marketplace packages use the `hexpkg/1` format: a gzipped tar
carrying the bundle plus a manifest (a per-file sha256 table + overall
digest) and a detached **Ed25519** signature
(`src/core/marketplace/package.ts`).

The trust model is **marketplace-as-signer** (the VS Code Marketplace
model): the client pins the marketplace's public key, and
`resolveMarketplaceSource` verifies the signature **before unpacking** —
a tampered or unsigned package is refused and never reaches the cache.
Verification is **fail-closed**: an absent or unverifiable key aborts the
fetch rather than proceeding unverified.

> The hosted-registry surface (`hex publish` + `MarketplaceSource`) is
> currently **parked** behind the git-catalogue model — see
> [`marketplace.md`](./marketplace.md). The git-catalogue path (M13) is
> the supported way to share components in a team today; it relies on git
> auth + the source-trust gating in §2, not package signatures.

---

## 4. Network calls

Hex makes one outbound call you should know about: on every interactive
run it checks `registry.npmjs.org` for a newer version and offers to
self-update. Disable it with `HEX_NO_UPDATE_CHECK=1` (recommended for
locked-down / air-gapped / proxied environments). A failed or blocked
update check never blocks the command you actually ran. No telemetry or
analytics are collected.

Source fetches go only to the git remotes / registries you configure in
`~/.hex/config.yaml`, through your system `git` (so SSH agents and
credential helpers apply as usual).

---

## Reporting

Found a security issue? Open a private advisory on the
[textologylabs/hex](https://github.com/textologylabs/hex) repository
rather than a public issue.
