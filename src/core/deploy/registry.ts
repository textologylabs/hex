import { NULL_ADAPTER_NAME, nullAdapter } from './null-adapter.js';
import type { CicdProvider, DeployAdapter } from './types.js';

export class DeployRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeployRegistryError';
  }
}

const adapters = new Map<string, DeployAdapter>();
const providers = new Map<string, CicdProvider>();

function installBuiltins(): void {
  adapters.set(nullAdapter.name, nullAdapter);
}

installBuiltins();

export function registerDeployAdapter(adapter: DeployAdapter): void {
  if (adapters.has(adapter.name)) {
    throw new DeployRegistryError(`deploy adapter "${adapter.name}" already registered`);
  }
  adapters.set(adapter.name, adapter);
}

export function getDeployAdapter(name: string): DeployAdapter {
  const adapter = adapters.get(name);
  if (!adapter) {
    const known = listDeployAdapterNames().join(', ') || '<none>';
    throw new DeployRegistryError(`unknown deploy adapter "${name}" (registered: ${known})`);
  }
  return adapter;
}

export function listDeployAdapterNames(): string[] {
  return [...adapters.keys()].sort();
}

export function registerCicdProvider(provider: CicdProvider): void {
  if (providers.has(provider.name)) {
    throw new DeployRegistryError(`cicd provider "${provider.name}" already registered`);
  }
  providers.set(provider.name, provider);
}

export function getCicdProvider(name: string): CicdProvider {
  const provider = providers.get(name);
  if (!provider) {
    const known = listCicdProviderNames().join(', ') || '<none>';
    throw new DeployRegistryError(`unknown cicd provider "${name}" (registered: ${known})`);
  }
  return provider;
}

export function listCicdProviderNames(): string[] {
  return [...providers.keys()].sort();
}

/**
 * Reset the registries to their built-in defaults. Test-only — used to
 * isolate registrations between test files.
 */
export function _resetRegistriesForTest(): void {
  adapters.clear();
  providers.clear();
  installBuiltins();
}

export { NULL_ADAPTER_NAME };
