import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { generateSigningKeypair } from '../src/core/marketplace/package.js';

/**
 * Generate the marketplace signing keypair (M9.9). Run once when
 * standing up the registry:
 *
 *   npm run registry:keygen [out-dir]
 *
 * Writes `marketplace.key` (PKCS#8 private — keep secret, point
 * `HEX_REGISTRY_KEY` at it) and `marketplace.pub` (SPKI public — ship
 * this to clients so they can pin it). Prints the `keyId`.
 */
async function main(): Promise<void> {
  const outDir = resolve(process.argv[2] ?? '.');
  await mkdir(outDir, { recursive: true });
  const { privateKeyPem, publicKeyPem, keyId } = generateSigningKeypair();

  const keyPath = join(outDir, 'marketplace.key');
  const pubPath = join(outDir, 'marketplace.pub');
  await writeFile(keyPath, privateKeyPem, { mode: 0o600 });
  await writeFile(pubPath, publicKeyPem, 'utf8');

  process.stdout.write(
    `marketplace signing keypair generated
  keyId:       ${keyId}
  private key: ${keyPath}  (secret — set HEX_REGISTRY_KEY to this)
  public key:  ${pubPath}  (publish — clients pin this)
`,
  );
}

main().catch((err) => {
  process.stderr.write(`keygen failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
