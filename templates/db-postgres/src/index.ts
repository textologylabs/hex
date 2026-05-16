import { Client } from 'pg';
import type { Db } from './client.js';

/**
 * Production database client for {{ app_name }} — talks to a real
 * Postgres instance. This is the prod entry point: it imports `pg` only,
 * never the stub, so bundlers tree-shake all stub code out of the
 * production artifact.
 */
export function createDb(): Db {
  const client = new Client({ connectionString: '{{ database_url }}' });
  return {
    async connect() {
      await client.connect();
    },
    async query(sql, params) {
      const result = await client.query(sql, params as unknown[]);
      return result.rows;
    },
    async close() {
      await client.end();
    },
  };
}
