-- Seed data for {{ app_name }}, loaded by the pg-mem stub on connect.
-- This file is scaffolded into the generated tree only when the slot
-- runs in stub mode — edit and version-control it like any other source.

CREATE TABLE app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO app_meta (key, value) VALUES
  ('app_name', '{{ app_name }}'),
  ('seeded_by', 'hex db-postgres stub');
