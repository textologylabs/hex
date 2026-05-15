import type { StubEngine } from '../manifest/types.js';
import type { ResolvedRecipe } from '../recipe/resolve.js';
import { enginePort, isOutOfProcess } from './catalogue.js';

/**
 * A shared out-of-process stub service for a recipe (M8.3). One per
 * distinct out-of-process engine across the recipe's stubbed children —
 * if two children both stub against `wiremock`, they share a single
 * service rather than each spinning up their own.
 */
export type StubService = {
  engine: StubEngine;
  /** docker-compose service name and in-network hostname. */
  host: string;
  /** Container port the engine listens on. */
  port: number;
};

/**
 * Collect the deduplicated set of out-of-process stub services a recipe
 * needs, walking its immediate stubbed children.
 *
 * Only children with `ref.stub === true` whose component declares an
 * out-of-process engine contribute. In-process engines (pg-mem, msw)
 * produce no service — package-manager hoisting handles them. Nested
 * sub-recipes are not descended into: each recipe level owns its own
 * `docker-compose.yml`, so a nested recipe collects its own services.
 *
 * Result order follows first-declaration order in the composes block.
 */
export function collectStubServices(resolved: ResolvedRecipe): StubService[] {
  const seen = new Map<StubEngine, StubService>();
  for (const child of resolved.children.values()) {
    if (child.ref.stub !== true) continue;
    const stub = child.bundle.manifest.stub;
    if (!stub || !isOutOfProcess(stub.engine)) continue;
    if (seen.has(stub.engine)) continue;
    const port = enginePort(stub.engine);
    if (port === undefined) continue;
    seen.set(stub.engine, { engine: stub.engine, host: stub.engine, port });
  }
  return [...seen.values()];
}

/**
 * Render-context symbol prefix for a stub engine's coordinates, e.g.
 * `wiremock` → `STUB_WIREMOCK`. Non-alphanumerics collapse to `_` so
 * hyphenated engine ids stay valid as `provided.*` keys.
 */
export function engineSymbolPrefix(engine: StubEngine): string {
  return `STUB_${engine.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}
