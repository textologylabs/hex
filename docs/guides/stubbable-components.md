# Authoring stubbable components

A **stubbable component** ships a stub implementation alongside the real
one — same author, same version, same publish flow. Recipes can then run
that component in stub mode per slot, getting a fast, dependency-free dev
loop without a separate `*-stub` package drifting out of sync.

This page covers how to author one so it stays **prod-clean**: the
production build must never carry stub code. `hex lint <path>` checks the
three conventions below.

## 1. Declare the `stub:` block

In `.hex/manifest.yaml`:

```yaml
type: component
name: db-postgres
version: 2.0.0
kind: db
stub:
  engine: pg-mem        # one of: pg-mem, msw, wiremock
  fixtures: fixtures    # optional — seed-data directory (see §5)
```

A component with no `stub:` block is real-only. The engine id is
validated against a closed catalogue.

## 2. Separate entry points

Ship two entry points so bundlers tree-shake stub code out of prod:

- `src/index.ts` — production. Imports the real client only.
- `src/index.dev.ts` — development. Imports the stub.

Wire `package.json` scripts so `dev` uses the dev entry and `build` /
`start` use the prod entry. The prod artifact then never references stub
code.

## 3. Stub engines in `devDependencies`

In-process stub engines (`pg-mem`, `msw`) are npm packages. Keep them in
`devDependencies` only — a prod `npm install --omit=dev` then pulls none
of it:

```json
{
  "devDependencies": {
    "pg-mem": "^3.0.0"
  }
}
```

Out-of-process engines (`wiremock`) run as a container, not a dependency
— this convention does not apply to them.

## 4. Docker compose profiles

For an out-of-process engine, gate the stub service behind a `dev`
profile so `docker-compose up` stays prod-shape and only
`docker-compose --profile dev up` adds the stub:

```yaml
services:
  wiremock:
    image: wiremock/wiremock
    profiles: [dev]
```

When several components in a recipe declare the same out-of-process
engine, Hex emits a single shared service at the recipe root (M8.3).

## 5. Fixtures

If the `stub:` block declares `fixtures:`, that directory is rendered
into `<component>/fixtures/` in the generated tree **only when the slot
runs in stub mode**. Fixture files pass through the same Nunjucks engine
as scaffolding files, so seed data can reference recipe answers.

## Checking your work

```
hex lint path/to/component
```

A clean component reports `stubs prod-clean: ✓`. Any failing check exits
non-zero, so the command doubles as a CI / marketplace gate.
