import type { DeployAdapter, DeployResult } from './types.js';

/**
 * No-op adapter. A template that doesn't ship a deploy story can carry
 * `deploy: { adapter: none }` (or omit the stanza entirely); `hex deploy`
 * resolves the `none` adapter and exits cleanly without doing anything.
 *
 * The `none` adapter is always pre-registered by the registry module.
 */
export const NULL_ADAPTER_NAME = 'none';

export const nullAdapter: DeployAdapter = {
  name: NULL_ADAPTER_NAME,
  requiredEnv: [],
  validateConfig(stanza) {
    return stanza;
  },
  async deploy(): Promise<DeployResult> {
    return {};
  },
};
