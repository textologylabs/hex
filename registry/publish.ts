import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extract } from 'tar';
import { packPackage } from '../src/core/marketplace/package.js';
import { loadFromPath } from '../src/core/sources/file-source.js';
import { addPackage } from './store.js';

/**
 * The publish flow (M9.9). A developer uploads the *unsigned* component
 * tree (a gzipped tar of the bundle directory); the registry validates
 * it, packs and **signs** it with the marketplace key, and ingests it.
 *
 * This is the marketplace-as-signer model (M9.1): developers hold a
 * publish *token*, not a signing key, and clients trust exactly one
 * key — the marketplace's. The signing key therefore lives on the
 * server; see `docs/registry-deploy.md` for the trade-off.
 */

export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishError';
  }
}

export type PublishInput = {
  /** Store root directory. */
  rootDir: string;
  /** Uploaded bytes — a gzipped tar of the component/recipe directory. */
  upload: Buffer;
  /** PKCS#8 PEM of the marketplace signing key. */
  marketplacePrivateKeyPem: string;
  /** Optional human description for the catalogue row. */
  description?: string;
  /** Optional browse categories for the catalogue row. */
  categories?: string[];
};

export type PublishResult = {
  name: string;
  version: string;
  type: 'component' | 'recipe';
  kind?: string;
  /** Digest of the signed package. */
  digest: string;
};

/**
 * Validate, sign, and ingest an uploaded bundle. Throws `PublishError`
 * for a malformed upload; `StoreError` (from `addPackage`) escapes
 * unwrapped so the server can map "already published" to HTTP 409.
 */
export async function publishPackage(input: PublishInput): Promise<PublishResult> {
  const scratch = await mkdtemp(join(tmpdir(), 'hex-publish-'));
  const bundleDir = join(scratch, 'bundle');
  const signedPath = join(scratch, 'signed.hexpkg');

  try {
    // Unpack the upload into a scratch directory.
    const tarPath = join(scratch, 'upload.tgz');
    await writeFile(tarPath, input.upload);
    await mkdir(bundleDir, { recursive: true });
    try {
      await extract({ file: tarPath, cwd: bundleDir });
    } catch (err) {
      throw new PublishError(
        `upload is not a readable tar.gz: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Validate the bundle by loading its manifest.
    let manifestKind: string | undefined;
    let manifestType: 'component' | 'recipe';
    try {
      const bundle = await loadFromPath(bundleDir);
      manifestKind = bundle.manifest.kind;
      manifestType = bundle.manifest.type;
    } catch (err) {
      throw new PublishError(
        `uploaded bundle is not a valid Hex component/recipe: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Pack + sign with the marketplace key.
    let manifest: Awaited<ReturnType<typeof packPackage>>['manifest'];
    try {
      ({ manifest } = await packPackage(bundleDir, signedPath, {
        privateKeyPem: input.marketplacePrivateKeyPem,
      }));
    } catch (err) {
      throw new PublishError(
        `could not pack the uploaded bundle: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Ingest — `addPackage` throws `StoreError` on a duplicate version.
    await addPackage({
      rootDir: input.rootDir,
      signedPackagePath: signedPath,
      name: manifest.name,
      version: manifest.version,
      type: manifestType,
      kind: manifestKind,
      description: input.description,
      categories: input.categories,
    });

    return {
      name: manifest.name,
      version: manifest.version,
      type: manifestType,
      kind: manifestKind,
      digest: manifest.digest,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
