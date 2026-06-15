# Authoring a template from scratch

This guide builds a complete Hex component from nothing — a small **greeter
service** template — touching every authoring feature you'll reach for in
practice: prompts (including a conditional one), Nunjucks in both file contents
and filenames, a file gated on an answer, a declarative rename hook, and a
JavaScript hook that patches a rendered file. By the end you'll have a template
you can scaffold from and hand to a team.

It pairs with the [manifest reference](../reference/manifest.md) (the
field-by-field spec) and the [CLI reference](../reference/cli.md). If you haven't
scaffolded *from* a template yet, skim [getting started](../getting-started.md)
first.

## The mental model

A template (Hex calls it a **bundle**) is just a directory:

- A **`.hex/`** control directory holding the `manifest.yaml` (and any JS hooks).
- **Template files** — the actual project files, with [Nunjucks](https://mozilla.github.io/nunjucks/)
  placeholders in their contents and/or names.

When a user runs `hex new`, Hex runs this pipeline:

```
prompts  →  pre_render JS hooks  →  render walk (files + filenames)  →  post_render hooks (rename / delete / JS)
```

Every prompt answer is in scope as a Nunjucks variable (`{{ project_name }}`)
and as the `answers` object inside JS hooks.

We'll build this bundle:

```
greeter/
├── .hex/
│   ├── manifest.yaml
│   └── hooks/
│       └── set-repository.js
├── .hexignore
├── gitignore                 # renamed to .gitignore on render
├── package.json
├── tsconfig.json
├── README.md
├── Dockerfile                # only emitted when the user opts in
└── src/
    ├── index.ts
    └── {{ project_name }}.ts  # filename is itself a template
```

## Step 1 — create the layout

```sh
mkdir -p greeter/.hex/hooks greeter/src
cd greeter
```

## Step 2 — the manifest header

Create `.hex/manifest.yaml`. Every bundle declares its `type`, `name`, `version`,
and (for a component) an optional `kind`:

```yaml
type: component
name: greeter
version: 0.1.0
kind: service
```

- `type: component` — a building block (a `recipe` is a whole-project scaffold
  that composes components; see the [manifest reference](../reference/manifest.md#type)).
- `kind: service` — a free-form category a recipe can match a slot against.

## Step 3 — prompts

Add a `prompts:` block. Each entry is a single-key map: the key is the answer
variable, the value is the prompt definition. We use a **string**, two **enums**,
a **boolean**, and a **conditional** prompt:

```yaml
prompts:
  - project_name:
      type: string
      required: true
      description: Package name (e.g. my-service)
      pattern: '^[a-z][a-z0-9-]*$'
  - description:
      type: string
      default: ''
      description: Short description
  - license:
      type: enum
      choices: [MIT, Apache-2.0]
      default: MIT
      description: License
  - greeting:
      type: enum
      choices: [hello, hej, bonjour]
      default: hello
      description: Which greeting should the service speak?
  - containerize:
      type: boolean
      default: false
      description: Add a Dockerfile?
  - log_level:
      type: enum
      choices: [debug, info, warn]
      default: info
      description: Container log level
      when: containerize
```

The last prompt has **`when: containerize`** — a
[Nunjucks expression](../reference/manifest.md#when-expressions). Hex only asks
for a log level if the user answered yes to `containerize`. The `pattern` on
`project_name` rejects anything that isn't a lower-case package name.

> **Shorthand.** For a plain default you can skip the long form: `- description: ''`
> desugars to a string prompt, `- containerize: false` to a boolean, and a YAML
> list like `- license: [MIT, Apache-2.0]` to an enum. See
> [shorthand](../reference/manifest.md#prompt-shorthand). We use the long form
> here because we need `description`, `pattern`, and `when`.

## Step 4 — Nunjucks in file contents

Now the template files. Placeholders use `{{ variable }}`. Create `package.json`:

```json
{
  "name": "{{ project_name }}",
  "version": "0.1.0",
  "description": "{{ description }}",
  "license": "{{ license }}",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  }
}
```

`tsconfig.json` (no placeholders — copied through unchanged):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "strict": true
  },
  "include": ["src"]
}
```

`README.md`:

```markdown
# {{ project_name }}

{{ description }}

A small service that greets you. Run `npm install && npm run build && npm start`.

Licensed under {{ license }}.
```

## Step 5 — Nunjucks in *filenames*

Hex renders **paths** through the same engine, so a file's name can depend on an
answer. Create the greeting module at the literal path `src/{{ project_name }}.ts`
— the braces are part of the filename on disk:

```ts
// Greeting module for {{ project_name }}.
const GREETING = '{{ greeting }}';

export function greet(name: string): string {
  return `${GREETING}, ${name}!`;
}
```

And `src/index.ts` imports it — note the import path is templated too, so the two
stay in sync:

```ts
import { greet } from './{{ project_name }}.js';

console.log(greet('world'));
```

> **Gating a whole file?** Use an [`include:` rule](#step-6--a-conditional-file)
> (next step), not `{% if %}` around a filename. A path that renders empty is
> skipped, but `include:` is the clear, declarative way to say "only emit this
> file when…".

## Step 6 — a conditional file

We want the `Dockerfile` emitted only when the user opts into `containerize`. Add
an `include:` block to the manifest — each rule names a file and a **required**
`when:`:

```yaml
include:
  - { path: 'Dockerfile', when: 'containerize' }
```

Then create `Dockerfile` (it also reads the conditional `log_level` answer):

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY . .
RUN npm install && npm run build
ENV LOG_LEVEL={{ log_level }}
CMD ["npm", "start"]
```

If the user answers no to `containerize`, the file is never written (and
`log_level` is never asked).

## Step 7 — `.hexignore` and the rename hook

Two housekeeping pieces.

**`.hexignore`** — gitignore-style patterns excluded from the render walk, so
build artefacts in your template dir never leak into output:

```
node_modules/
dist/
.DS_Store
```

**The `.gitignore` problem.** You want the scaffolded project to have a
`.gitignore`, but if you name the file `.gitignore` in your template, your *own*
tooling may hide or ignore it. The convention: ship it as `gitignore` and rename
it on render with a declarative **`rename` hook**. Create `gitignore`:

```
node_modules/
dist/
*.log
```

Then add a `hooks:` block to the manifest:

```yaml
hooks:
  post_render:
    - rename: { from: gitignore, to: .gitignore }
```

`rename` and `delete` are *declarative* hooks — no code, just a manifest entry.
See the [hooks reference](../reference/manifest.md#hooks).

## Step 8 — a JavaScript hook

For logic beyond rename/delete, write a **JS hook**. Ours reads the rendered
`package.json` and splices in a `repository` field from a question it asks
itself. Extend the `post_render` list:

```yaml
hooks:
  post_render:
    - rename: { from: gitignore, to: .gitignore }
    - js: set-repository.js
      name: repository
      prompts:
        - github_coord:
            type: string
            default: ''
            description: GitHub repo (owner/name) — blank to skip
```

- **`js: set-repository.js`** — a plain filename inside `.hex/hooks/` (no paths,
  no `..`).
- **`name: repository`** — the namespace its prompt answers land under
  (`answers.hooks.repository.*`).
- **`prompts:`** — questions the hook asks at its lifecycle moment, same shape as
  the top-level block.

Create `.hex/hooks/set-repository.js`:

```js
// post_render hook: read the rendered package.json, optionally add a
// `repository` field from the hook-defined prompt, write it back.
var coord = (answers.hooks.repository.github_coord || '').trim();

if (coord.length === 0) {
  log.info('greeter: no repo coordinate given, leaving package.json as-is');
} else if (!/^[\w.-]+\/[\w.-]+$/.test(coord)) {
  log.warn('greeter: "' + coord + '" is not owner/name — skipping repository field');
} else {
  var pkg = JSON.parse(project.read('package.json'));
  pkg.repository = 'github:' + coord;
  project.write('package.json', JSON.stringify(pkg, null, 2) + '\n');
  log.info('greeter: set repository = github:' + coord);
}
```

A hook runs in a **sandbox** with a small surface:

| In scope | What it is |
|----------|-----------|
| `answers` | The full answer tree, including `answers.hooks.<name>.*`. |
| `recipe` | Recipe metadata if composed, else `null`. |
| `project.read(path)` / `project.write(path, contents)` | Read/write files in the rendered output. |
| `log.info(msg)` / `log.warn(msg)` | Surface messages to the user. |

By default the sandbox is **QuickJS-WASM** — no filesystem, process, or network
beyond the `project` facade, with CPU + memory caps. That's the boundary a
consumer relies on when scaffolding from your template. See
[docs/security.md](../security.md). The `--trust-local` flag (next step) runs
hooks as ordinary Node instead — a convenience for local authoring, or when your
hook genuinely needs a Node API the sandbox withholds.

## Step 9 — test it locally

Point `hex new` at your bundle directory and an output path. Use
`--trust-local` so JS hooks run unsandboxed during development:

```sh
hex new ./greeter /tmp/greet-out --trust-local
```

`hex new` is interactive — run it at a real terminal (a TTY). Hex confirms the
template, then walks your prompts. Answer them — pick
`bonjour`, say yes to `containerize`, choose `debug`, and give a repo coordinate
like `acme/greet-svc` at the hook's question. You'll see the hook log:

```
greeter: set repository = github:acme/greet-svc
```

The result in `/tmp/greet-out`:

```
/tmp/greet-out/.gitignore        ← renamed from gitignore
/tmp/greet-out/Dockerfile        ← emitted because containerize = true
/tmp/greet-out/README.md
/tmp/greet-out/package.json      ← repository field spliced in by the hook
/tmp/greet-out/src/greet-svc.ts  ← filename rendered from {{ project_name }}
/tmp/greet-out/src/index.ts      ← imports './greet-svc.js'
/tmp/greet-out/tsconfig.json
```

`package.json` came out as:

```json
{
  "name": "greet-svc",
  "version": "0.1.0",
  "description": "A friendly greeter",
  "license": "MIT",
  "type": "module",
  "main": "dist/index.js",
  "scripts": { "build": "tsc", "start": "node dist/index.js" },
  "repository": "github:acme/greet-svc"
}
```

Run it to prove it's real:

```sh
cd /tmp/greet-out && npm install && npm run build && npm start
# → bonjour, world!
```

Re-run with `containerize` = no and you'll see no `Dockerfile`, and Hex won't
ask for a log level — the `when:` did its job.

> **Iterating.** Edit the template, re-run `hex new` into a fresh output dir
> (add `-f` to overwrite a non-empty one). There's no build step for a template
> — it's just files.

> **Headless testing.** `hex new --answers <file.yaml>` renders without prompts
> (handy for a golden-output test of your template) — see
> [Scaffold non-interactively](../getting-started.md#scaffold-non-interactively-ci--scripts).
> One caveat for *this* template: the answers file doesn't yet cover
> **hook-defined** prompts (our `github_coord`), so a template with hook prompts
> still needs a terminal for that part.

## Step 10 — validate with `hex lint`

`hex lint` loads and **schema-validates** your manifest (a malformed manifest
fails here with the offending path), then runs the **stub prod-clean checks** if
the component declares a [`stub:` block](../reference/manifest.md#stub):

```sh
hex lint ./greeter
# greeter declares no `stub:` block — real-only, nothing to lint.
```

Our greeter isn't stubbable, so lint confirms the manifest is valid and has
nothing further to check. If you later add a `stub:` engine, lint enforces that
the stub stays out of production dependencies — see
[stubbable components](../stubbable-components.md). Either way, `hex lint` exits
non-zero on a failure, so it's a usable CI / marketplace gate.

## You're done

You built a working template covering prompts (string + enum + boolean +
`when:`), Nunjucks in contents *and* filenames, a conditional `include:` file,
a declarative `rename` hook, and a sandboxed JS hook with its own prompt. The
`greeter/` directory is a complete, shareable bundle.

## Next steps

- **Make it discoverable** — drop `greeter/` into a directory and register it:
  `hex hive add --path /path/to/templates`, then `hex new` lists it
  interactively. See the [CLI reference](../reference/cli.md#hex-hive-add).
- **Publish it** — package and sign it for a registry with
  [`hex publish`](../reference/cli.md#hex-publish); see the
  [package format](../marketplace-package-format.md).
- **Share it with an org** — put it in a git-catalogue marketplace so a team
  pulls it by name: [set up a catalogue](./catalogue-for-your-org.md).
- **Add setup tasks** — declare a [`setup:` block](../reference/manifest.md#setup)
  so the user gets a guided post-scaffold checklist (install deps, wire CI, …).
- **Compose it** — a [recipe](../reference/manifest.md#composes) can pull your
  `service` component into a larger scaffold.
- **The full spec** — every field is in the [manifest reference](../reference/manifest.md).
