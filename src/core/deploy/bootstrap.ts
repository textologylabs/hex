import { vercelAdapter } from './adapters/vercel.js';
import { DeployRegistryError, listDeployAdapterNames, registerDeployAdapter } from './registry.js';

/**
 * Register every built-in deploy adapter into the process-wide registry.
 * Idempotent — re-registration of an already-installed adapter is a no-op
 * so test setups that call this multiple times stay green.
 *
 * `installBuiltins` in `registry.ts` only registers the `none` adapter
 * because the registry must not import concrete adapters (avoids a
 * cycle and keeps the core schema-validation surface small). Concrete
 * built-ins live here and ride in via an explicit bootstrap call from
 * `cli.ts` at startup.
 */
export function bootstrapBuiltinAdapters(): void {
  for (const adapter of [vercelAdapter]) {
    if (listDeployAdapterNames().includes(adapter.name)) continue;
    try {
      registerDeployAdapter(adapter);
    } catch (err) {
      if (err instanceof DeployRegistryError) continue;
      throw err;
    }
  }
}
