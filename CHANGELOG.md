# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- M8.3 — Out-of-process stub-engine dedup at recipe level. A stub-engine catalogue (`src/core/stub/catalogue.ts`) classifies each engine as `in-process` (pg-mem, msw — package-manager hoisting handles dedup) or `out-of-process` (wiremock — runs in its own container, default port 8080). When a recipe has multiple stubbed children declaring the same out-of-process engine, `collectStubServices` folds them into one shared service. `renderRecipe` exposes the deduped list as a `stub_services` answer (so the recipe-root `docker-compose.yml` template can `{% for %}` over it — emitting exactly one service block per engine) and threads each service's coordinates into `provided.STUB_<ENGINE>_HOST` / `_PORT` so any consuming child reaches the shared instance.
- M8.2 — Recipe-side stub-per-slot wiring. A recipe's `composes:` block accepts a new long object form — `db: { component: <spec>, stub?: true }` — where `component` is any of the existing string wire forms (`<name>@<version>`, `file:`, `git+`); `stub: true` is also accepted on the M6.3 slot form (`{ kind, version, stub: true }`). Every `ChildRef` now carries an optional `stub` flag. At resolve time, `stub: true` against a component that declares no `stub:` block (or against a recipe) is rejected with a `RecipeResolutionError` naming the slot. When a child is stubbed, the well-known `stub_enabled` answer (`true`/`false`) lands in that child's render context, so `include:` rules and Nunjucks `{% if stub_enabled %}` can branch on it.
- M8.1 — Manifest `stub:` block on components. A component can declare `stub: { engine: <id>, fixtures?: <path> }` to advertise that it supports stub mode; absent `stub:` means the component is real-only. `engine` is validated against a closed catalogue (`STUB_ENGINES` — initially `pg-mem`, `msw`, `wiremock`, extensible by editing the one list). `fixtures` is an optional non-empty path (M8.4 will render it into the generated tree). The block is rejected on recipes (component-only, like `provides`/`consumes`/`requires`) and rejects unknown keys.

## [0.7.0] — 2026-05-14

### Added

- M7.7 — `node-ts-hooked` reference component dogfooding the M7 JS-hook surface end-to-end. The bundle's `.hex/manifest.yaml` declares both a `pre_render` JS hook (logs the rendering context — answers, recipe metadata) and a `post_render` JS hook (`name: repository`) with its own `prompts:` block. The post_render hook reads the rendered `package.json` via `project.read`, parses it, optionally splices in a `"repository": "github:owner/name"` field based on the hook-prompt answer (validated, with branch-by-branch `log.info`/`log.warn`), and writes back via `project.write`. The accompanying integration test (`test/integration/node-ts-hooked.test.ts`) exercises the full load → top-level prompts → render → pre_render → walk → post_render path, including the empty-coord, malformed-coord, and `--trust-local` parity branches. Closes M7.
- M7.6 — `hex new --trust-local` for unsandboxed dev-loop hook execution. When passed, JS hooks for FileSource components (local `kind: path` source roots or direct path arguments to `hex new <path>`) run unsandboxed in the host Node process via `Function()`, bypassing QuickJS. Convenient while iterating on your own components. Git/marketplace components (`sourceKind: 'git'`) always sandbox regardless of the flag — the trust gradient is the bundle's, not the user's. Loud warning at startup and per executed hook so the bypass is never silent. To plumb the gradient: `ComponentBundle` and `TemplateEntry` gain a `sourceKind: 'file' | 'git'` marker; `loadFromPath(path, sourceKind?)` accepts the explicit tag; discovery + recipe resolver thread the right value based on each child's `ChildRef` variant.
- M7.5 — Hook-defined prompts. A JS hook can declare its own `prompts:` block alongside `js:` (`when:` already supported); shorthand prompt forms are desugared the same way as top-level prompts. The hook also accepts an optional `name:` field — the namespace key under which prompt answers land in `answers.hooks.<name>.*`. Without an explicit `name:`, the filename minus `.js` is used. Prompts fire at the hook's lifecycle moment, just before the hook body runs; answers thread through to subsequent phases (walk, declarative post_render, post_render JS hooks all see the augmented tree). Hooks read the full answers tree (shared read) but persist writes only to their own namespace (isolated write). `renderBundle`/`renderRecipe`/`executeNewRender` gained a `prompter` option, and the CLI threads its clack prompter through both prompt collection and the render call.
- M7.4 — JS hook lifecycle wiring. `renderBundle` now fires `pre_render` JS hooks after the output-dir writeable check + mkdir, before the template walk, so a hook can short-circuit the render by throwing (HookExecutionError aborts before any file is written). `post_render` JS hooks fire after the declarative rename/delete pass, so they observe the final tree shape. Each hook executes inside a freshly-created QuickJS sandbox with four context surfaces installed as globals: `answers` (full prompt tree), `recipe` (`{ name, version }` of the outermost recipe when rendering inside one, `null` for standalone components), `project.*` (sandboxed FS facade from M7.2), and `log.{info,warn,error}` routed to console by default (overridable via `RenderOptions.hookLog`). `JsHook.when` is honoured. Existing declarative + JS hooks coexist on the same lifecycle.
- M7.3 — JS hook discovery + manifest declaration. Component manifests can now declare JS hooks alongside the existing declarative entries: `hooks.pre_render: [{ js: '<filename>' }]` and `hooks.post_render: [..., { js: '<filename>' }, ...]`. The filename refers to a file inside the bundle's `.hex/hooks/` directory (plain `.js` filename — no path separators, no `..`), and the bundle loader eagerly reads the file into `ComponentBundle.jsHookSources` at load time. Missing hook files fail loading with an authoring error naming the lifecycle, filename, and expected path. The existing declarative rename/delete hooks are untouched. JS hooks are discovered now; the sandbox doesn't execute them yet — that lands with M7.4.
- M7.2 — Sandboxed project FS facade. `src/core/hooks/project-fs.ts` exposes `read` / `write` / `delete` / `exists` / `list` over a project root, with a traversal guard that rejects absolute paths, `..` escapes, and symlinks whose realpath resolves outside the root (works for non-existent targets too, by realpath-ing the longest existing ancestor). `Sandbox.installProjectFs(fs)` bridges the five operations into the QuickJS context as `project.*` host functions — rejections surface inside the hook as catchable JS errors with usable messages, not silent failures. Not wired into the render pipeline yet (M7.4).
- M7.1 — QuickJS-WASM hook sandbox foundation. `src/core/hooks/sandbox.ts` embeds the `quickjs-emscripten` runtime (release-sync variant, ~684 KiB WASM blob bundled into `node_modules`, no native binaries, no runtime download). `createSandbox()` returns a fresh isolated runtime + context per call; `runScript()` executes user code with a per-call CPU deadline (default 5 s) and a runtime-wide memory ceiling (default 32 MiB), throwing `SandboxError` on script error, timeout, or OOM. Hooks running here cannot see `require`, `process`, or any Node primitive — only what later M7 work bridges in. Not wired into the render pipeline yet (that lands with M7.4).
- M4 — post-scaffold setup tasks. Templates can declare a `setup:` block in `.hex/manifest.yaml` with an optional `message` and `tasks` (each with `id`, `title`, optional `detail`). Hex tracks user progress in the generated app's `.hex/checklist.yaml`. When `hex new` finishes rendering, it writes the checklist, prints the message, and on a TTY walks the user through each task interactively — `Mark as done` / `Skip for now` / `Quit`. State persists after every toggle so a hard exit cannot lose progress.
- `hex setup` — resume the interactive loop from any directory inside a generated app (walks upward from cwd to find `.hex/checklist.yaml`, matching how `git`/`npm` find their roots). Walks all tasks regardless of status; done tasks can be flipped back to pending.
- `hex doctor` — when run inside a generated app, appends an "Outstanding setup tasks" section listing pending task ids + titles. Stays silent when no checklist is found or every task is already done.
- `hex new --no-setup` — skip the post-render interactive loop. Non-TTY invocations skip automatically and print "N setup tasks pending — run hex setup".
- `node-ts-cli` template gains an `include_publish_workflow` prompt (default true) gating a `.github/workflows/publish.yml` that publishes on `v*` tag, plus a four-task `setup:` block (install deps, init git + push, set NPM_TOKEN, tag first release).

## [0.5.0] — 2026-05-06

### Added

- M3 — `GitSource`. Source roots in `~/.hex/config.yaml` now accept `{ git: <url>, ref?: <branch|tag|sha> }` alongside `{ path: <dir> }`. Repos are cloned lazily into `~/.hex/cache/git/<urlHash>/<refSlug>-<refHash>/repo/` (override the cache root via `HEX_CACHE_DIR`) on first use; subsequent commands hit the cache without touching the network. Auth flows through the system `git` (SSH agent, credential helpers, `~/.gitconfig`). Cold-cache fetches use `git init && fetch --depth 1 && checkout FETCH_HEAD`, which works uniformly for branches, tags, and reachable SHAs.
- Upstream drift detection. `git ls-remote` is invoked at most once per 6h per (url, ref) to compare upstream's SHA against the cached SHA. When they diverge, `hex list` emits a warning telling you to run `hex sources refresh`. Failures (offline, auth, host down) are caught silently — drift detection degrades gracefully and never blocks offline use.
- `hex sources` — list configured sources with cache + drift status. Path sources show `exists`/`missing`; git sources show cached SHA, fetch timestamp, and `fresh`/`drift` indicator. `--json` flag for scriptable output. Reads cache state without triggering network calls.
- `hex sources refresh` — force-refresh every git source through the resolver, ignoring TTL and cache hits. Reports per-source success/failure and exits non-zero if any source failed.

## [0.4.0] — 2026-05-02

### Added

- `hex list` — enumerate templates discovered across configured source roots. `--json` for scriptable output.
- `~/.hex/config.yaml` (overridable via `HEX_CONFIG_DIR`) — declares `sources:` for template discovery. `~`-expansion and config-relative path resolution. Empty / missing file is treated as no sources, not an error.
- `hex new` interactive picker: when invoked with no `<template>` argument, lists templates from configured sources and lets the user pick. Bare names resolve via discovery; path-shaped args (`./foo`, `/abs`, `~/x`, anything with a separator) bypass discovery and load directly. Output directory is also prompted when omitted.
- Manifest `sections:` — optional grouping of prompts into named sections, with strict coverage validation (every prompt classified exactly once). Drives the questionnaire UX: an outline up front, a section header per group ("Section 1 of 5 — Basics"), and `(N/M)` per-question progress. Sections whose prompts are all `when:`-skipped suppress their header. Manifests without `sections:` continue to render flat.
- `node-ts-cli` template: `include_self_update` prompt (default true) gates a templated `src/update.ts` and the corresponding wiring in `src/cli.ts`. The ported self-update flow is deps-free (raw ANSI, no picocolors), reads VERSION from the generated app's own `package.json` at runtime, and respects `NO_UPDATE_CHECK=1`. Template manifest now uses `sections:` (Basics / Licence / Features).

### Changed

- `Prompter` interface gains optional UI hooks (`outline`, `sectionStart`, `sectionEnd`, `progress`). Existing scripted prompters omit them with no behavioural change.

## [0.3.0] — 2026-05-02

### Added

- `hex new <template> <output> [--force]` — render a templated component into a target directory. Loads a manifest, runs prompts, renders files through Nunjucks, and applies declarative post-render hooks.
- Manifest schema (`.hex/manifest.yaml`) with zod-validated structure: typed prompts (`string` with optional `pattern`, `integer`/`number` with `min`/`max`, `boolean`, `enum`, `multi`, `password`, `path` with `must_exist`), shorthand desugaring (YAML array → enum, bare boolean/number/string → typed default), `include:` rules for conditional file inclusion, and `hooks.post_render` (`rename`, `delete` by `path` or `glob`).
- `FileSource` — load a component bundle from a local path. `manifest.yaml` and `manifest.yml` both honoured.
- Prompts engine — pluggable `Prompter` interface (production wiring on `@clack/prompts` v1.3) with per-type widgets (text/confirm/select/multiselect/password) and Nunjucks-native `when:` evaluation (`not`, `==`, `in`, …).
- Render engine — Nunjucks for both file contents and rendered file paths (`{{ … }}` in filenames), `.hexignore` support, manifest-level `include:` evaluation, binary-file pass-through, path-traversal guard.
- Post-render hooks — `rename` (with optional `when:` and `--force`-aware target overwrite) and `delete` (by `path` or `glob`, with `when:`); empty ancestor directories left behind by `delete` are pruned.
- Reference template `templates/node-ts-cli/` — minimal Node + TypeScript CLI (commander, tsup, biome, vitest) demonstrating prompts, conditional content (`include_examples`), licence branching, and rename/delete hooks.

### Fixed

- Splash module now walks upward to locate `package.json`, so `npm run dev` (tsx-from-source) and the bundled `dist/` both resolve VERSION correctly.

## [0.2.0] — 2026-04-26

### Added

- Self-update flow on launch. Hex checks the npm registry on every interactive run, prompts the user when a newer version is available, runs `npm i -g @hexology/hex@latest`, and re-launches the new binary with the same args. Skipped when stdin/stdout isn't a TTY (CI, pipes, redirects), when `HEX_NO_UPDATE_CHECK=1` is set, or when the registry fetch fails / times out (2s).

### Changed

- `VERSION` is now read at runtime from `package.json` instead of being hardcoded in `src/brand/splash.ts`. Single source of truth; editing the installed `package.json` lets you fake an older version for testing the self-update prompt.

## [0.1.1] — 2026-04-25

### Changed

- Package renamed from `hex` to `@hexology/hex`. The `@hexology` scope is reserved for related tools (CLI, future component libraries, marketplace client). The bin command remains `hex`.
- Splash redrawn as a font-independent ASCII honeycomb (5 tessellated cells using `/`, `\`, `_`); no longer relies on Unicode `⬢`/`⬡`/`⬣` glyphs that fall back to circles in fonts without those codepoints.
- Brand surface now shows "hex {version} — Application Stack Composer" plus a pitch line beside the splash on every entry point (`doctor`, `--help`, default help). VERSION + tagline + pitch live in `brand/splash.ts` so any new surface that calls `splash()` inherits them.
- `hex doctor` trimmed — drops the TTY / Unicode glyphs / ANSI colours capability rows; keeps Node, Platform, Terminal.
- CLI emits a single trailing newline only when stdout is a TTY, so interactive output ends with one breathing line before the prompt while piped/redirected output stays clean.

### Removed

- `program.description` from the root commander setup — the splash pitch covers it, and Commander was rendering it verbatim under the splash in `--help`.

## [0.1.0] — 2026-04-25

### Added

- Initial Node + TypeScript CLI scaffold (`hex` binary).
- Brand surface: hexagonal cell glyphs (`⬢` `⬡` `⬣`) with ASCII fallback (`[#]` `[ ]` `[!]`), honey-tinted splash, picocolors-based palette.
- Terminal capability detection (Unicode via locale, ANSI colour, TTY) honouring `NO_COLOR`, `HEX_FORCE_ASCII`, `HEX_FORCE_UNICODE`.
- `hex --version` and `hex --help`.
- `hex doctor` — prints runtime info and a glyph-rendering check.
- Build pipeline: tsup (esbuild) bundling to ESM for Node 20+.
- Dev tooling: vitest (tests), biome (lint + format), tsx (dev runner), strict TypeScript.
