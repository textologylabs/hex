import { defineConfig } from 'vitest/config';

// Many tests exercise real `git` subprocesses against tmpdir fixtures
// (M3 GitSource, M13.1+ catalogue). Under parallel-pool contention the
// default 5s budget is too tight, so the suite was flaking on machines
// it shouldn't have. 20s is generous for the slow cases and never gets
// hit on the fast ones.
export default defineConfig({
  test: {
    testTimeout: 20_000,
  },
});
