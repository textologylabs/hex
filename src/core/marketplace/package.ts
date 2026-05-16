import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { create, extract } from 'tar';
import { loadFromPath } from '../sources/file-source.js';

/**
 * Marketplace package format + signing (M9.1).
 *
 * A `.hexpkg` is a gzipped tar archive that is the on-the-wire form of a
 * published component or recipe. It carries three members:
 *
 *   - `artifact/`     — the complete authored bundle tree (`.hex/` +
 *                       scaffolding files), namespaced under one prefix
 *                       so it can never collide with the metadata files.
 *   - `hexpkg.json`   — the package manifest: identity + a per-file
 *                       sha256 table + an overall `digest`.
 *   - `hexpkg.sig`    — a detached Ed25519 signature over the manifest's
 *                       canonical bytes.
 *
 * The signature covers a *canonical serialization of the manifest*, not
 * the raw tar bytes, so tar's mtime/ordering quirks can never destabilise
 * a signature. Any change to any artifact file changes that file's
 * sha256, which changes the digest, which breaks the signature — so
 * tamper-detection holds even before the signature is checked.
 *
 * Trust model: the marketplace is the signer (the VS Code Marketplace
 * model), not the publisher. Hex clients ship the marketplace's *public*
 * key; the `keyId` in `hexpkg.sig` lets the format survive key rotation
 * and multiple marketplaces. See `docs/marketplace-package-format.md`.
 */

/** Format identifier embedded in every `hexpkg.json`. */
export const HEXPKG_FORMAT = 'hexpkg/1';

/** The only signature algorithm `hexpkg/1` defines. */
export const SIG_ALGORITHM = 'ed25519';

/** Tar-internal layout: artifact files live under this prefix. */
const ARTIFACT_PREFIX = 'artifact';
/** Tar-internal name of the package manifest. */
const MANIFEST_ENTRY = 'hexpkg.json';
/** Tar-internal name of the detached signature. */
const SIGNATURE_ENTRY = 'hexpkg.sig';

/** Directory names never included in a package. */
const EXCLUDED_DIRS = new Set(['.git', 'node_modules']);

export class MarketplacePackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketplacePackageError';
  }
}

/** One artifact file's path (tar-relative) and content hash. */
export type HexpkgFileEntry = {
  /** POSIX path inside the archive, always under `artifact/`. */
  path: string;
  /** Lowercase hex sha256 of the file's bytes. */
  sha256: string;
};

/** Parsed `hexpkg.json`. */
export type HexpkgManifest = {
  format: string;
  /** Bundle name, from the component/recipe manifest. */
  name: string;
  /** Bundle version, from the component/recipe manifest. */
  version: string;
  type: 'component' | 'recipe';
  /** ISO-8601 pack timestamp. */
  createdAt: string;
  /** Per-file hash table, sorted by `path`. */
  files: HexpkgFileEntry[];
  /** `sha256:<hex>` over the canonical manifest bytes. */
  digest: string;
};

/** Parsed `hexpkg.sig`. */
export type HexpkgSignature = {
  algorithm: string;
  /** Identifies which signing key produced `signature`. */
  keyId: string;
  /** Base64 Ed25519 signature over the canonical manifest bytes. */
  signature: string;
};

/** A freshly generated Ed25519 signing keypair. */
export type SigningKeypair = {
  /** PKCS#8 PEM — held by the marketplace, never shipped to clients. */
  privateKeyPem: string;
  /** SPKI PEM — shipped to / pinned by clients. */
  publicKeyPem: string;
  /** Stable id derived from the public key. */
  keyId: string;
};

/** What `packPackage` needs to sign: just the private key. */
export type Signer = {
  /** PKCS#8 PEM of an Ed25519 private key. */
  privateKeyPem: string;
};

/** Result of a successful `packPackage`. */
export type PackResult = {
  archivePath: string;
  manifest: HexpkgManifest;
  signature: HexpkgSignature;
};

/** Outcome of `verifyPackage` — a discriminated union. */
export type VerifyResult =
  | { ok: true; manifest: HexpkgManifest; keyId: string }
  | { ok: false; reason: string };

/** Trust input for verification: keyId → SPKI public-key PEM. */
export type TrustedKeys = Record<string, string>;

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/**
 * Derive the stable `keyId` for a public key: the first 16 hex chars of
 * the sha256 of its SPKI-DER encoding. Deterministic and independent of
 * PEM whitespace.
 */
export function keyIdFor(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return sha256Hex(der as Buffer).slice(0, 16);
}

/** Generate an Ed25519 keypair for marketplace signing. */
export function generateSigningKeypair(): SigningKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return { publicKeyPem, privateKeyPem, keyId: keyIdFor(publicKeyPem) };
}

function publicPemFromPrivate(privateKeyPem: string): string {
  const priv = createPrivateKey(privateKeyPem);
  return createPublicKey(priv).export({ type: 'spki', format: 'pem' }) as string;
}

/**
 * Canonical, deterministic byte serialization of the manifest's signed
 * fields — everything except the derived `digest`. Object keys are
 * emitted in a fixed order and `files` is sorted by path, so the same
 * logical manifest always produces the same bytes regardless of how it
 * was constructed.
 */
function canonicalManifestBytes(fields: Omit<HexpkgManifest, 'digest'>): Buffer {
  const ordered = {
    format: fields.format,
    name: fields.name,
    version: fields.version,
    type: fields.type,
    createdAt: fields.createdAt,
    files: [...fields.files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => ({ path: f.path, sha256: f.sha256 })),
  };
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

function digestOf(canonical: Buffer): string {
  return `sha256:${sha256Hex(canonical)}`;
}

type ArtifactFile = { relativePath: string; absolutePath: string };

/**
 * Recursively collect every regular file under a bundle root. Unlike the
 * render walker this keeps `.hex/` (the package must carry the manifest)
 * and ignores `.hexignore` (a render-time concern). Symlinks and the
 * excluded dirs (`.git`, `node_modules`) are skipped.
 */
async function collectArtifactFiles(rootPath: string): Promise<ArtifactFile[]> {
  const out: ArtifactFile[] = [];
  async function walk(absDir: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(absPath);
      } else if (entry.isFile()) {
        out.push({ relativePath: toPosix(relative(rootPath, absPath)), absolutePath: absPath });
      }
      // symlinks / special files are intentionally skipped
    }
  }
  await walk(rootPath);
  return out.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
}

/**
 * Build the package manifest for a bundle: load + validate the
 * component/recipe manifest, hash every artifact file, and compute the
 * digest. Returns the manifest plus the canonical bytes it was hashed
 * from (so the caller can sign exactly those bytes) and the file list.
 */
async function buildManifest(
  bundleRoot: string,
): Promise<{ manifest: HexpkgManifest; canonical: Buffer; files: ArtifactFile[] }> {
  // Validates the bundle is loadable before we package a broken one.
  const bundle = await loadFromPath(bundleRoot);
  const files = await collectArtifactFiles(bundleRoot);
  if (files.length === 0) {
    throw new MarketplacePackageError(`bundle has no files to package: ${bundleRoot}`);
  }

  const entries: HexpkgFileEntry[] = [];
  for (const f of files) {
    const bytes = await readFile(f.absolutePath);
    entries.push({ path: `${ARTIFACT_PREFIX}/${f.relativePath}`, sha256: sha256Hex(bytes) });
  }

  const signed: Omit<HexpkgManifest, 'digest'> = {
    format: HEXPKG_FORMAT,
    name: bundle.manifest.name,
    version: bundle.manifest.version,
    type: bundle.manifest.type,
    createdAt: new Date().toISOString(),
    files: entries,
  };
  const canonical = canonicalManifestBytes(signed);
  return { manifest: { ...signed, digest: digestOf(canonical) }, canonical, files };
}

/**
 * Pack a component/recipe bundle into a signed `.hexpkg` archive at
 * `outPath`. Stages the artifact + metadata in a temp directory and
 * writes one gzipped tar; the temp dir is always cleaned up.
 */
export async function packPackage(
  bundleRoot: string,
  outPath: string,
  signer: Signer,
): Promise<PackResult> {
  const { manifest, canonical, files } = await buildManifest(bundleRoot);

  const sigBytes = sign(null, canonical, createPrivateKey(signer.privateKeyPem));
  const signature: HexpkgSignature = {
    algorithm: SIG_ALGORITHM,
    keyId: keyIdFor(publicPemFromPrivate(signer.privateKeyPem)),
    signature: sigBytes.toString('base64'),
  };

  const stage = await mkdtemp(join(tmpdir(), 'hex-pack-'));
  try {
    for (const f of files) {
      const dest = join(stage, ARTIFACT_PREFIX, f.relativePath);
      await mkdir(dirname(dest), { recursive: true });
      await cp(f.absolutePath, dest);
    }
    await writeFile(join(stage, MANIFEST_ENTRY), JSON.stringify(manifest, null, 2), 'utf8');
    await writeFile(join(stage, SIGNATURE_ENTRY), JSON.stringify(signature, null, 2), 'utf8');
    await mkdir(dirname(outPath), { recursive: true });
    await create({ gzip: true, file: outPath, cwd: stage, portable: true }, [
      ARTIFACT_PREFIX,
      MANIFEST_ENTRY,
      SIGNATURE_ENTRY,
    ]);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }

  return { archivePath: outPath, manifest, signature };
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Recursively list POSIX-relative file paths under `root`. */
async function listFilesUnder(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await listFilesUnder(join(root, entry.name), rel)));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Verify a `.hexpkg` archive: extract it, recompute every file hash and
 * the digest, and check the detached signature against a trusted key.
 *
 * Returns a discriminated result rather than throwing for verification
 * *failures* (untrusted key, tampering, digest mismatch) — those are
 * expected outcomes a caller branches on. It still throws
 * `MarketplacePackageError` for unusable input (archive missing /
 * unreadable / not a tar).
 *
 * Tamper-detection layers, any one of which fails the package:
 *   - a changed artifact file → its sha256 no longer matches the table
 *   - an added / removed artifact file → file set differs from the table
 *   - a substituted digest → recomputed digest differs from the field
 *   - a forged / wrong-key signature → Ed25519 verification fails
 */
export async function verifyPackage(
  archivePath: string,
  trustedKeys: TrustedKeys,
): Promise<VerifyResult> {
  const tmp = await mkdtemp(join(tmpdir(), 'hex-verify-'));
  try {
    try {
      await extract({ file: archivePath, cwd: tmp });
    } catch (err) {
      throw new MarketplacePackageError(
        `could not extract package ${archivePath}: ${err instanceof Error ? err.message : err}`,
      );
    }

    const manifest = await readJson<HexpkgManifest>(join(tmp, MANIFEST_ENTRY));
    if (!manifest) return { ok: false, reason: `missing or unreadable ${MANIFEST_ENTRY}` };
    const sig = await readJson<HexpkgSignature>(join(tmp, SIGNATURE_ENTRY));
    if (!sig) return { ok: false, reason: `missing or unreadable ${SIGNATURE_ENTRY}` };

    if (manifest.format !== HEXPKG_FORMAT) {
      return { ok: false, reason: `unsupported package format: ${manifest.format}` };
    }
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      return { ok: false, reason: 'package manifest lists no files' };
    }

    // Digest must match the canonical bytes recomputed from the manifest.
    const canonical = canonicalManifestBytes(manifest);
    const recomputedDigest = digestOf(canonical);
    if (recomputedDigest !== manifest.digest) {
      return { ok: false, reason: 'digest mismatch — manifest has been altered' };
    }

    // Every listed file must exist with the recorded hash.
    const declared = new Set<string>();
    for (const entry of manifest.files) {
      declared.add(entry.path);
      let bytes: Buffer;
      try {
        bytes = await readFile(join(tmp, entry.path));
      } catch {
        return { ok: false, reason: `file declared in manifest but missing: ${entry.path}` };
      }
      if (sha256Hex(bytes) !== entry.sha256) {
        return { ok: false, reason: `file tampered: ${entry.path}` };
      }
    }

    // No undeclared artifact files may be present (catches additions).
    const present = await listFilesUnder(join(tmp, ARTIFACT_PREFIX), ARTIFACT_PREFIX);
    for (const path of present) {
      if (!declared.has(path)) {
        return { ok: false, reason: `unexpected file not in manifest: ${path}` };
      }
    }

    // Signature checks.
    if (sig.algorithm !== SIG_ALGORITHM) {
      return { ok: false, reason: `unsupported signature algorithm: ${sig.algorithm}` };
    }
    const publicKeyPem = trustedKeys[sig.keyId];
    if (!publicKeyPem) {
      return { ok: false, reason: `untrusted signing key: ${sig.keyId}` };
    }
    if (keyIdFor(publicKeyPem) !== sig.keyId) {
      return { ok: false, reason: `key id mismatch for ${sig.keyId} — trust store misconfigured` };
    }
    let signatureValid: boolean;
    try {
      signatureValid = verify(
        null,
        canonical,
        createPublicKey(publicKeyPem),
        Buffer.from(sig.signature, 'base64'),
      );
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      return { ok: false, reason: 'signature verification failed' };
    }

    return { ok: true, manifest, keyId: sig.keyId };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
