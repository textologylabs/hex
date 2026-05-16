# {{ app_name }} — database access

Postgres data access for **{{ app_name }}**, scaffolded from the Hex
`db-postgres` reference component.

## Real vs stub

This component ships two entry points — same `Db` interface, picked by
which script you run:

| Entry point        | Backed by        | Used by           |
| ------------------ | ---------------- | ----------------- |
| `src/index.ts`     | real Postgres    | `build` / `start` |
| `src/index.dev.ts` | pg-mem in-memory | `dev`             |

`createDb()` returns the same `Db` shape either way, so application code
imports it without caring which implementation it got.

### Why a stub

The stub (pg-mem) needs no container, no connection string, and starts
instantly — the local dev loop stays fast and hermetic. `fixtures/seed.sql`
seeds it on connect, so every dev run starts from the same known data.

### Staying prod-clean

- `pg-mem` is a **devDependency** — a prod `npm install --omit=dev`
  pulls none of it.
- The prod entry point (`src/index.ts`) imports `pg` only; the bundler
  tree-shakes all stub code out of the production artifact.
- `fixtures/` is scaffolded into the tree only when the recipe runs this
  slot in stub mode.

The trade-off: pg-mem implements a large but not complete subset of
Postgres. Behaviour-sensitive queries should still be exercised against
real Postgres in CI before release.
