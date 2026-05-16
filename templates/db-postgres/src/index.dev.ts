import { readFileSync } from 'node:fs';
import { newDb } from 'pg-mem';
import type { Db } from './client.js';

/**
 * Development database client for {{ app_name }} — an in-memory Postgres
 * (pg-mem). No container, no connection string, instant startup. The dev
 * entry point imports `pg-mem` (a devDependency); `package.json`'s `dev`
 * script wires this file so the prod build never sees it.
 *
 * `fixtures/seed.sql` is loaded on connect, so a fresh dev run starts
 * from the same seed data every time.
 */
export function createDb(): Db {
  const mem = newDb();

  return {
    async connect() {
      const seed = readFileSync(new URL('../fixtures/seed.sql', import.meta.url), 'utf8');
      mem.public.none(seed);
    },
    async query(sql) {
      return mem.public.many(sql);
    },
    async close() {
      // pg-mem is in-memory — nothing to release.
    },
  };
}
