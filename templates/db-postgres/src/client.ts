/**
 * The data-access surface {{ app_name }} depends on.
 *
 * Both the production entry point (`index.ts`, real Postgres) and the
 * dev entry point (`index.dev.ts`, pg-mem stub) return a `Db` — the
 * rest of the app imports `createDb` without knowing or caring which
 * implementation it got.
 */
export type Db = {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
  close(): Promise<void>;
};
