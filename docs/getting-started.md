# Getting started — from zero to a running app in ~10 minutes

This is the linear path: install Hex, scaffold a real app from a reference
template, walk its setup tasks, and watch it run in your browser. No prior Hex
knowledge assumed.

When you're done, see the [manifest reference](./reference/manifest.md) and
[CLI reference](./reference/cli.md) for the full surface, or the
[authoring guide](./guides/authoring-a-template.md) to build your own template.

**Prerequisites:** Node.js ≥ 20 and npm. A browser. That's it.

---

## 1. Install Hex

```sh
npm install -g @hexology/hex
```

Or run it without installing, via npx:

```sh
npx --yes @hexology/hex@latest --version
```

Verify:

```sh
hex --version
hex doctor      # prints Node version, platform, and terminal info
```

## 2. Get a template to scaffold from

Hex renders *templates*. The Hex repo ships a set of reference templates — the
quickest way to see Hex work end-to-end is to point it at one. Clone the repo
anywhere:

```sh
git clone https://github.com/textologylabs/hex.git ~/hex-src
```

We'll use `~/hex-src/templates/vite-ts-spa` — a Vite + TypeScript single-page
app. You can pass that path straight to `hex new`.

> **Tip — make templates discoverable.** Instead of typing a path every time,
> register the directory as a *source root* so `hex new` (with no argument)
> lists it interactively. The `--path` flag says "this is a **local
> directory**" (a bare `hex hive add <url>` adds a remote *catalogue* instead):
>
> ```sh
> hex hive add --path ~/hex-src/templates
> hex list            # shows every discovered template
> ```
>
> Source roots live in `~/.hex/config.yaml`. See the
> [CLI reference](./reference/cli.md#hex-hive-add).

## 3. Scaffold the app

```sh
hex new ~/hex-src/templates/vite-ts-spa my-app
```

Hex confirms what it's about to render:

```
Template: vite-ts-spa @0.1.0
```

Then, because this template groups its prompts into
[sections](./reference/manifest.md#sections), it shows an outline up front and
walks each section in turn. Question counters are **per section** (`(1/3)` =
first of three in this section):

```
2 sections
  1. Basics (3 questions)
  2. Licence (1 question)

Section 1 of 2 — Basics
  (1/3) Package name (e.g. my-app)   ›  my-app
  (2/3) Short description            ›  My first Hex app
  (3/3) Author                       ›  Ada Lovelace

Section 2 of 2 — Licence
  (1/1) License                      ›  MIT
```

- **Package name** is validated against `^[a-z][a-z0-9-]*$` — lower-case,
  starts with a letter.
- The others have sensible defaults; press Enter to accept.
- Sectioning is opt-in: a template that doesn't declare `sections:` just shows a
  flat list of prompts with no section headers.

> **`hex new` is interactive** — it asks these questions in your terminal, so
> run it at a real prompt (a TTY). There's no non-interactive/answers-file mode
> yet, so it isn't suited to CI or piped/headless shells.

Hex renders the project into `my-app/`.

## 4. Walk the setup tasks

Because this template ships a [`setup:` block](./reference/manifest.md#setup),
Hex immediately walks you through the post-scaffold tasks. The first one is:

```
Install dependencies
  Hex will run: npm install
```

The template is a **local (`file:`) source**, so Hex trusts it to run its
allowlisted commands and executes them as you confirm each step. (For an
*untrusted remote* source, Hex would instead ask whether to trust it, review
each command, or skip — see [docs/security.md](./security.md).)

For this 10-minute path you only need the first task — **Install
dependencies**. The remaining tasks wire the app up for deployment (git init,
Vercel link, deploy token, first deploy); **Skip** them for now — you can return
any time with:

```sh
cd my-app
hex setup           # resumes the outstanding tasks
hex doctor          # shows what's still pending
```

> Prefer to skip the whole loop while scaffolding? `hex new … --no-setup`
> renders the files and leaves every task pending for `hex setup` later.

## 5. See it run

If you let the **Install dependencies** task run, `node_modules/` is already in
place. Otherwise install now, then start the dev server:

```sh
cd my-app
npm install         # only if you skipped the install task
npm run dev
```

Vite prints a local URL (typically `http://localhost:5173`). Open it — you have
a running, freshly scaffolded SPA. 🎉

## What just happened

| Step | What Hex did |
|------|--------------|
| `hex new` | Rendered the template's files, substituting your prompt answers, and ran its post-render hooks (e.g. `gitignore` → `.gitignore`). |
| Lockfile | Wrote `my-app/.hex/lockfile.yaml` recording the template + version + answers — this is what powers [`hex upgrade`](./reference/cli.md#hex-upgrade) and [`hex deploy`](./reference/cli.md#hex-deploy) later. |
| Setup loop | Tracked task status in `my-app/.hex/checklist.yaml` and ran the trusted, allowlisted commands you confirmed. |

## Next steps

- **Finish wiring it up** — run `hex setup` in `my-app` to do the deploy tasks
  (Vercel link, token, first deploy). See [docs/deploy.md](./deploy.md).
- **Use your own templates** — register a source root with
  [`hex hive add --path`](./reference/cli.md#hex-hive-add), or a git/catalogue
  source for a team.
- **Author a template** — the [authoring guide](./guides/authoring-a-template.md)
  builds one from scratch; the [manifest reference](./reference/manifest.md) is
  the field-by-field spec.
- **Upgrade later** — when the template ships a new version,
  [`hex upgrade`](./reference/cli.md#hex-upgrade) merges the changes into your
  app using the lockfile.
