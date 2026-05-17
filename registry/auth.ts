import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * Publish authentication (M9.9). A developer publishes with a bearer
 * token; the registry maps tokens to publisher identities. There are no
 * user accounts beyond this — the ticket scopes accounts out. Tokens
 * live in a JSON file the operator manages:
 *
 *   { "<token>": "<publisher-name>", ... }
 *
 * Read access is unauthenticated — the registry is a public marketplace.
 * Only `POST /publish` is gated.
 */

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/** token → publisher name. */
export type TokenStore = Map<string, string>;

/**
 * Load the token store from a JSON file. A missing file yields an empty
 * store — the registry then refuses every publish, which is the correct
 * closed-by-default behaviour for a misconfigured deployment.
 */
export async function loadTokens(path: string): Promise<TokenStore> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AuthError(
      `tokens file ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AuthError(`tokens file ${path} must be a JSON object of token → publisher`);
  }
  const store: TokenStore = new Map();
  for (const [token, publisher] of Object.entries(parsed)) {
    if (typeof publisher !== 'string' || token.length === 0 || publisher.length === 0) {
      throw new AuthError(`tokens file ${path} has a malformed entry`);
    }
    store.set(token, publisher);
  }
  return store;
}

/** Constant-time compare so token lookup does not leak length/prefix via timing. */
function constantTimeFind(tokens: TokenStore, candidate: string): string | null {
  let match: string | null = null;
  const candidateBuf = Buffer.from(candidate);
  for (const [token, publisher] of tokens) {
    const tokenBuf = Buffer.from(token);
    if (tokenBuf.length === candidateBuf.length && timingSafeEqual(tokenBuf, candidateBuf)) {
      match = publisher;
    }
  }
  return match;
}

/**
 * Resolve the publisher behind an `Authorization` header, or throw
 * `AuthError`. Accepts `Authorization: Bearer <token>`.
 */
export function authenticatePublish(
  tokens: TokenStore,
  header: string | undefined,
): { publisher: string } {
  if (!header) throw new AuthError('missing Authorization header');
  const match = /^Bearer (.+)$/.exec(header.trim());
  if (!match) throw new AuthError('Authorization header must be "Bearer <token>"');
  const publisher = constantTimeFind(tokens, match[1] as string);
  if (!publisher) throw new AuthError('invalid publish token');
  return { publisher };
}
