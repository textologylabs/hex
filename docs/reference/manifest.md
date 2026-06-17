# `.hex/manifest.yaml` — field reference

Every Hex template and component carries one manifest at `.hex/manifest.yaml`.
It declares what the thing is, what it asks the user, and what happens during
and after rendering. This page is the complete field reference, aligned to the
parser in [`src/core/manifest/schema.ts`](../../src/core/manifest/schema.ts).

It is a reference, not a tutorial — for a guided build see the
[authoring guide](../guides/authoring-a-template.md). Each field below lists its
type, meaning, where it is allowed, and a short example.

> **Validation.** The manifest is parsed in two passes: the `prompts:` block is
> [desugared](#prompt-shorthand) into long form, then the whole document is
> validated against a strict schema. A typo'd key, an unknown prompt type, or a
> contract field on the wrong manifest type is a **parse error** with the
> offending path — authoring mistakes surface before any file is rendered.
> Run [`hex lint`](./cli.md#hex-lint) to validate without scaffolding.

---

## Top-level keys

| Key | Type | Required | Allowed on | Meaning |
|-----|------|----------|-----------|---------|
| [`type`](#type) | `component` \| `recipe` | ✅ | both | What this bundle is. |
| [`name`](#name) | string | ✅ | both | Identifier (non-empty). |
| [`version`](#version) | semver string | ✅ | both | `MAJOR.MINOR.PATCH` (+ optional pre-release/build). |
| [`kind`](#kind) | string | — | both | Component category, matched by recipe slots. |
| [`prompts`](#prompts) | list | — | both | Questions asked of the user. |
| [`sections`](#sections) | list | — | both | Groups prompts into a sectioned questionnaire. |
| [`hooks`](#hooks) | object | — | both | Declarative + JS transforms around rendering. |
| [`include`](#include) | list | — | both | Conditionally gate individual files into the output. |
| [`setup`](#setup) | object | — | both | Post-scaffold tasks the user completes. |
| [`composes`](#composes) | map | — | **recipe only** | Child components assembled into the output. |
| [`provides`](#provides) | list \| map | — | **component only** | Symbols this component exposes to siblings. |
| [`consumes`](#consumes) | list | — | **component only** | Symbols this component needs from siblings. |
| [`requires`](#requires) | list | — | **component only** | Peer-presence assertions. |
| [`stub`](#stub) | object | — | **component only** | Opts the component into stub mode. |
| [`deploy`](#deploy) | object | — | both | Deploy adapter stanza. |
| [`cicd`](#cicd) | object | — | both | CI/CD provider stanza. |

The four contract fields (`provides`, `consumes`, `requires`, `stub`) are
**rejected on a recipe**; `composes` is **rejected on a component**. These
constraints are enforced at parse time.

---

### `type`

```yaml
type: component   # or: recipe
```

- `component` — a single building block (an API layer, a DB layer, a CLI). Can
  declare contracts (`provides`/`consumes`/`requires`/`stub`) and be composed by
  a recipe.
- `recipe` — a whole-project scaffold that may `compose` child components.

### `name`

```yaml
name: api-fastify
```

Non-empty string. Used in discovery, lockfiles, and composition references.

### `version`

```yaml
version: 1.4.0
```

Strict semver: `MAJOR.MINOR.PATCH`, optionally with a `-prerelease` or `+build`
suffix (e.g. `2.0.0-rc.1`). Looser forms like `1.x` are rejected.

### `kind`

```yaml
kind: api
```

Optional free-form category. A recipe's [slot](#composes) (`{ kind: api, … }`)
resolves against the `kind` of discovered components, so swapping `api-express`
for `api-fastify` is a source-root change, not a recipe edit.

---

## `prompts`

A list of questions asked of the user before rendering. Each entry is a
**single-key map** — the key is the answer variable name, the value is the
prompt definition (or a [shorthand](#prompt-shorthand)).

```yaml
prompts:
  - project_name:
      type: string
      required: true
      description: Package name (e.g. my-cli)
      pattern: '^[a-z][a-z0-9-]*$'
  - license:
      type: enum
      choices: [MIT, Apache-2.0]
      default: MIT
      description: License
```

Answers are available to templates, `when:` expressions, and hooks under their
variable name (e.g. `{{ project_name }}`).

### Fields common to every prompt type

| Field | Type | Meaning |
|-------|------|---------|
| `description` | string | Label shown at the prompt. |
| `required` | boolean | If `true`, an empty answer is rejected. |
| `when` | string | [Expression](#when-expressions); the prompt is only asked when it evaluates truthy. |

### Prompt types

There are **seven** types, dispatched on `type`.

#### `string`

```yaml
- app_name:
    type: string
    default: my-app
    pattern: '^[a-z][a-z0-9-]*$'
```

| Field | Type | Meaning |
|-------|------|---------|
| `default` | string | Pre-filled value. |
| `pattern` | string | Regex (JS syntax) the answer must match. |

#### `integer` / `number`

```yaml
- port:
    type: integer    # `number` is accepted as an alias
    default: 3000
    min: 1024
    max: 65535
```

| Field | Type | Meaning |
|-------|------|---------|
| `default` | number | Pre-filled value. |
| `min` | number | Lower bound (inclusive). |
| `max` | number | Upper bound (inclusive). |

#### `boolean`

```yaml
- include_examples:
    type: boolean
    default: true
```

| Field | Type | Meaning |
|-------|------|---------|
| `default` | boolean | Pre-filled value. |

#### `enum` — pick one

```yaml
- license:
    type: enum
    choices: [MIT, Apache-2.0, ISC]
    default: MIT
```

| Field | Type | Meaning |
|-------|------|---------|
| `choices` | string[] | Non-empty list of options. |
| `default` | string | One of `choices`. |

#### `multi` — pick many

```yaml
- features:
    type: multi
    choices: [auth, billing, search]
    default: [auth]
```

| Field | Type | Meaning |
|-------|------|---------|
| `choices` | string[] | Non-empty list of options. |
| `default` | string[] | Subset of `choices`. The answer is a list. |

#### `password` — masked input, never persisted

```yaml
- registry_token:
    type: password
    description: npm automation token
```

No `default`. Input is **masked** at the prompt. Use it for tokens and
secrets rather than a `string` prompt.

#### `path`

```yaml
- output_dir:
    type: path
    default: ./dist
    must_exist: false
```

| Field | Type | Meaning |
|-------|------|---------|
| `default` | string | Pre-filled value. |
| `must_exist` | boolean | If `true`, the path must already exist on disk. |

### Prompt shorthand

A scalar (or array) value desugars to the long form before validation:

| You write | Desugars to |
|-----------|-------------|
| `- name: my-app` (string) | `type: string`, `default: my-app` |
| `- count: 3` (number) | `type: integer`, `default: 3` |
| `- enabled: true` (boolean) | `type: boolean`, `default: true` |
| `- license: [MIT, ISC]` (array) | `type: enum`, `choices: [MIT, ISC]`, `default: MIT` |

```yaml
prompts:
  - app_name: my-app            # → string, default "my-app"
  - replicas: 3                 # → integer, default 3
  - debug: false                # → boolean, default false
  - license: [MIT, Apache-2.0]  # → enum, choices [...], default MIT
```

Shorthand has no place for `description`, `required`, `when`, `pattern`, etc. —
reach for the long form when you need them.

---

## `sections`

Opts the manifest into a **sectioned questionnaire**: an outline shown up front,
a header per section, and `(N/M)` progress per question. When `sections:` is
present, **every prompt must appear in exactly one section**, and every listed
prompt name must exist — both are enforced at parse time.

```yaml
sections:
  - title: Basics
    prompts: [project_name, description, author]
  - title: Licence
    prompts: [license]
  - title: Features
    prompts: [include_examples, include_self_update]
```

| Field | Type | Meaning |
|-------|------|---------|
| `title` | string | Section header. |
| `prompts` | string[] | Prompt names assigned to this section (non-empty). |

---

## `hooks`

Transforms applied around rendering. Two lifecycles:

```yaml
hooks:
  pre_render:
    - js: pre_render.js
  post_render:
    - rename: { from: gitignore, to: .gitignore }
    - delete: { glob: 'src/examples/**', when: 'not include_examples' }
    - js: post_render.js
```

- **`pre_render`** runs before files are rendered. Only **JS hooks** are allowed
  here.
- **`post_render`** runs after rendering and accepts three hook kinds: `rename`,
  `delete`, and `js`.

### `rename` hook (post-render only)

```yaml
- rename: { from: gitignore, to: .gitignore }
```

| Field | Type | Meaning |
|-------|------|---------|
| `from` | string | Source path in the rendered tree (non-empty). |
| `to` | string | Destination path (non-empty). |
| `when` | string | Optional [expression](#when-expressions); rename only if truthy. |

The canonical use: ship a `gitignore` file (so it isn't swallowed by your own
repo's ignore rules) and rename it to `.gitignore` in the output.

### `delete` hook (post-render only)

```yaml
- delete: { glob: 'src/examples/**', when: 'not include_examples' }
- delete: { path: 'README.dev.md' }
```

Specify **exactly one** of `path` or `glob` (declaring both is a parse error).

| Field | Type | Meaning |
|-------|------|---------|
| `path` | string | A single file to delete. |
| `glob` | string | A glob; matching files/subtrees are removed. |
| `when` | string | Optional [expression](#when-expressions); delete only if truthy. |

> **`include` vs `delete`.** Use [`include:`](#include) for single-file gating
> (one rule per file) and the `delete` glob hook for many-file subtree gating.

### `js` hook (both lifecycles)

```yaml
- js: post_render.js
  name: repository
  when: 'add_repository_field'
  prompts:
    - github_coord:
        type: string
        default: ''
        description: GitHub repo coordinate (owner/name)
```

| Field | Type | Meaning |
|-------|------|---------|
| `js` | string | A plain `.js` **filename** inside `.hex/hooks/`. No path separators, no `..`. |
| `when` | string | Optional [expression](#when-expressions); the hook runs only if truthy. |
| `name` | string | Namespace for this hook's prompt answers (`answers.hooks.<name>.*`). Kebab/snake-case. Defaults to the filename minus `.js`. |
| `prompts` | list | Prompts that fire at the hook's lifecycle moment, before its JS body runs. Same shape (and shorthand) as the top-level `prompts:`. |

JS hooks run in a **sandbox** (QuickJS-WASM): no filesystem, process, network,
or `child_process`; CPU and memory capped. They receive the answers tree and a
small `project` API (`read`/`write`) for patching rendered files. The sandbox is
the privilege boundary documented in [docs/security.md](../security.md).

---

## `include`

Conditionally gates **individual files** into the output. Each rule names a file
and a `when:` expression; the file is rendered only when the expression is
truthy. Unlike `when` on prompts, the `when:` here is **required**.

```yaml
include:
  - { path: 'src/update.ts', when: 'include_self_update' }
  - { glob: '.github/workflows/*.yml', when: 'include_ci' }
```

Specify **exactly one** of `path` or `glob` per rule.

| Field | Type | Meaning |
|-------|------|---------|
| `path` | string | A single file to gate. |
| `glob` | string | A glob to gate. |
| `when` | string | **Required** [expression](#when-expressions). |

---

## `setup`

Post-scaffold tasks the user completes before the project is fully wired up. Hex
tracks status in `<project>/.hex/checklist.yaml`; the user walks through them in
the post-`hex new` flow or via [`hex setup`](./cli.md#hex-setup).

```yaml
setup:
  message: |
    Your CLI is scaffolded. A few things to wire up before it can publish:
  tasks:
    - id: install-deps
      title: Install dependencies
      run: npm install
    - id: configure-npm-token
      title: Configure the npm publish token
      open: https://www.npmjs.com/
      run: gh secret set NPM_TOKEN
      detail: |
        Sign in to npm → Access Tokens → Generate New Token → Automation,
        then paste it at the prompt.
```

| Field | Type | Meaning |
|-------|------|---------|
| `message` | string | Intro shown above the task list. |
| `tasks` | list | The tasks (see below). |

### Setup task

Every task **must declare at least one** of `run`, `open`, or `detail`.

| Field | Type | Meaning |
|-------|------|---------|
| `id` | string | Kebab-case identifier (`[a-z0-9-]`, no leading/trailing dash). Unique within the manifest. |
| `title` | string | One-line task name. |
| `run` | string | A shell command Hex executes. **Allowlisted** for non-local sources — see below. |
| `open` | string | A URL Hex opens in the browser. If `run` is also present, `open` fires **first**. |
| `detail` | string | Fallback prose the user follows manually. Prefer `run`/`open`. |

The three actions compose: an `open` + `run` task opens the dashboard, waits,
then runs the command, so a "mint a token then store it" step reads top-to-bottom.

> **`run:` is gated.** For a non-local (git/catalogue) source, `run:` commands
> are restricted to an allowlist of binaries and the source must be trusted. A
> local (`file:`) source lifts the allowlist with `--trust-local`. Untrusted
> remote sources prompt the user to trust, review each command, or skip. The
> full model is in [docs/security.md](../security.md) and the allowlist is
> configurable via `trust.allowlist` in
> [`config.yaml`](./config.md#trust).

---

## `composes`

> **Recipe only.**

Maps **slot names** to child components a recipe assembles into the output. Each
value is a child reference in one of four forms.

```yaml
composes:
  # Slot form — fill with any component of this kind matching the version spec.
  api: { kind: api, version: ^0.1.0 }

  # Named form — resolve a specific name via configured source roots.
  ui: ui-react@^2.0.0

  # File form — a local component, path relative to the recipe root.
  auth: file:../components/auth

  # Git form — a component from a git URL, with an optional @ref.
  billing: git+https://github.com/acme/billing.git@v1.2.0
```

The four wire forms:

| Form | Syntax | Resolves to |
|------|--------|-------------|
| Slot | `{ kind: <kind>, version: <spec> }` | Any discovered component with that `kind`. |
| Named | `<name>@<versionSpec>` | A named component from source roots. |
| File | `file:<path>` | A local component (path relative to recipe). |
| Git | `git+<url>[@<ref>]` | A component from a git URL (last `@` is the ref unless it looks like an SSH `git@host:path` URL). |

Slot keys must be kebab-case. The version spec accepts an optional comparator
(`^ ~ >= <= > < =`) plus a semver triplet, or bare `*`.

### Stub mode per slot (M8.2)

Opt a slot into [stub mode](#stub) with a long form. Both shapes accept `stub`:

```yaml
composes:
  db: { kind: db, version: ^2.0.0, stub: true }      # slot + stub
  cache: { component: redis-cache@^1.0.0, stub: true } # named + stub
```

The resolver verifies the chosen component actually declares a `stub:` block.

---

## Component contracts — component only

How components wire to their siblings inside a recipe. See
[stubbable-components.md](../guides/stubbable-components.md) and the composition docs
for the full model.

### `provides`

Symbols a component exposes to siblings. Two surface forms:

```yaml
# Array form — bare declarations (no value produced).
provides:
  - DATABASE_CLIENT

# Map form — symbol → Nunjucks expression, evaluated in the child's own
# answer scope at render time, exposed to siblings under `provided.<symbol>`.
provides:
  HTTP_PORT: "{{ port }}"
  API_FRAMEWORK: "fastify"
```

### `consumes`

Symbols this component needs bound from siblings. A list of non-empty strings.

```yaml
consumes:
  - DATABASE_CLIENT
```

### `requires`

Peer-presence assertions — either by `kind` or by `name` + `version`. Each entry
must match **exactly one** shape (a mixed `{kind, name, version}` is rejected).

```yaml
requires:
  - { kind: db }
  - { name: api-fastify, version: ^0.1.0 }
```

---

## `stub`

> **Component only.**

Declares the component supports **stub mode** via a known engine. Absent `stub:`
means real-only.

```yaml
stub:
  engine: pg-mem      # one of: pg-mem | msw | wiremock
  fixtures: fixtures  # optional dir of seed data, rendered only in stub mode
```

| Field | Type | Meaning |
|-------|------|---------|
| `engine` | enum | One of `pg-mem`, `msw`, `wiremock` (a closed set — a typo is a parse error). |
| `fixtures` | string | Optional path (relative to bundle root) to seed-data directory. |

---

## `deploy`

A deploy adapter stanza. The schema validates only `adapter` (kebab-case); all
other keys are adapter-specific and round-trip unchanged — the adapter's own
`validateConfig` checks them at resolve time. See [deploy.md](../deploy.md).

```yaml
deploy:
  adapter: vercel
  # adapter-specific keys pass through:
  project: my-app
```

| Field | Type | Meaning |
|-------|------|---------|
| `adapter` | string | Deploy adapter name (kebab-case). |
| *(any)* | any | Adapter-specific config, preserved verbatim. |

---

## `cicd`

A CI/CD provider stanza, same passthrough shape as `deploy`.

```yaml
cicd:
  provider: github-actions
  node-version: '20'
```

| Field | Type | Meaning |
|-------|------|---------|
| `provider` | string | CI/CD provider name (kebab-case). |
| *(any)* | any | Provider-specific config, preserved verbatim. |

---

## `when` expressions

`when:` (on prompts, hooks, `include` rules, `rename`/`delete` hooks) is a
**Nunjucks expression** evaluated in boolean context against the answers
collected so far. Truthy → the thing applies.

```yaml
when: containerize                       # a boolean answer
when: '!debug'                           # negation
when: 'not include_examples'             # word-form negation
when: "framework == 'react'"             # equality
when: "framework in ['react', 'vue']"    # membership
```

Undefined variables do not throw — they evaluate falsy. A malformed expression
fails the render with the offending expression in the message.

---

## Worked example — a recipe end-to-end

```yaml
type: recipe
name: node-ts-fullstack
version: 0.1.0

prompts:
  - app_name:
      type: string
      required: true
      description: Application name
      pattern: '^[a-z][a-z0-9-]*$'

composes:
  api: { kind: api, version: ^0.1.0 }

setup:
  message: |
    Fullstack scaffold ready.
  tasks:
    - id: install-deps
      title: Install dependencies
      run: npm install
```

## See also

- [CLI command reference](./cli.md) — `hex lint`, `hex new`, `hex setup`.
- [docs/security.md](../security.md) — the hook sandbox + `run:` trust model.
- [Authoring a template](../guides/authoring-a-template.md) — the guided build.
- [Deploy adapters](../deploy.md) · [Stubbable components](../guides/stubbable-components.md).
