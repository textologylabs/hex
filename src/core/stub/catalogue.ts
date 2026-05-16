import type { StubEngine } from '../manifest/types.js';

/**
 * Stub-engine catalogue (M8.3).
 *
 * Engines split by execution model:
 *
 * - `in-process` — a library imported into the generated app (pg-mem,
 *   msw). Multiple children using the same library need no coordination;
 *   package-manager hoisting dedups the dependency.
 * - `out-of-process` — a service that runs in its own container
 *   (wiremock). When several children stub against the same
 *   out-of-process engine, the recipe should emit ONE shared service —
 *   see `collectStubServices`.
 *
 * `port` is the container port an out-of-process engine listens on; it
 * is the value templates wire into `docker-compose.yml` and the
 * `provided.STUB_<ENGINE>_PORT` symbol.
 */
export type EngineProcessModel = 'in-process' | 'out-of-process';

type EngineInfo = {
  process: EngineProcessModel;
  /** Default container port — defined for out-of-process engines only. */
  port?: number;
  /**
   * npm package an in-process engine ships as — the library a stubbable
   * component must list in `devDependencies`. Undefined for
   * out-of-process engines (they run as a container, not a dependency).
   */
  npmPackage?: string;
};

const CATALOGUE: Record<StubEngine, EngineInfo> = {
  'pg-mem': { process: 'in-process', npmPackage: 'pg-mem' },
  msw: { process: 'in-process', npmPackage: 'msw' },
  wiremock: { process: 'out-of-process', port: 8080 },
};

export function engineProcessModel(engine: StubEngine): EngineProcessModel {
  return CATALOGUE[engine].process;
}

export function isOutOfProcess(engine: StubEngine): boolean {
  return CATALOGUE[engine].process === 'out-of-process';
}

/** Container port for an out-of-process engine; `undefined` otherwise. */
export function enginePort(engine: StubEngine): number | undefined {
  return CATALOGUE[engine].port;
}

/**
 * npm package an in-process engine is distributed as — the library a
 * stubbable component must keep in `devDependencies`. `undefined` for
 * out-of-process engines.
 */
export function engineNpmPackage(engine: StubEngine): string | undefined {
  return CATALOGUE[engine].npmPackage;
}
