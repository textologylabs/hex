export type {
  CicdContext,
  CicdProvider,
  DeployAdapter,
  DeployContext,
  DeployResult,
  EmittedFile,
} from './types.js';
export {
  DeployRegistryError,
  NULL_ADAPTER_NAME,
  _resetRegistriesForTest,
  getCicdProvider,
  getDeployAdapter,
  listCicdProviderNames,
  listDeployAdapterNames,
  registerCicdProvider,
  registerDeployAdapter,
} from './registry.js';
export { nullAdapter } from './null-adapter.js';
export { bootstrapBuiltinAdapters } from './bootstrap.js';
export {
  VercelDeployError,
  createVercelAdapter,
  extractDeployUrl,
  vercelAdapter,
} from './adapters/vercel.js';
export type { VercelRunner, VercelRunnerResult } from './adapters/vercel.js';
export {
  GITHUB_ACTIONS_PROVIDER_NAME,
  GithubActionsProviderError,
  createGithubActionsProvider,
  githubActionsProvider,
} from './providers/github-actions.js';
