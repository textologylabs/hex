import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create, extract } from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HEXPKG_FORMAT,
  type HexpkgManifest,
  type HexpkgSignature,
  generateSigningKeypair,
  keyIdFor,
  packPackage,
  verifyPackage,
} from '../../../src/core/marketplace/package.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-pkg-test-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

/** Write a minimal but valid component bundle under `work/<name>`. */
async function writeBundle(name = 'sample'): Promise<string> {
  const root = join(work, name);
  await mkdir(join(root, '.hex'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(
    join(root, '.hex', 'manifest.yaml'),
    `type: component\nname: ${name}\nversion: 1.2.3\n`,
    'utf8',
  );
  await writeFile(join(root, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
  await writeFile(join(root, 'README.md'), `# ${name}\n`, 'utf8');
  return root;
}

/**
 * Extract a packed archive, run `mutate` on the extracted tree, then
 * re-pack it — the standard way to forge a tampered package for tests.
 */
async function repack(
  archivePath: string,
  mutate: (dir: string) => Promise<void>,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hex-pkg-repack-'));
  await extract({ file: archivePath, cwd: dir });
  await mutate(dir);
  const out = `${archivePath}.repacked.hexpkg`;
  await create({ gzip: true, file: out, cwd: dir, portable: true }, [
    'artifact',
    'hexpkg.json',
    'hexpkg.sig',
  ]);
  await rm(dir, { recursive: true, force: true });
  return out;
}

describe('marketplace package — pack → verify round-trip', () => {
  it('packs a bundle and verifies it against the signing key', async () => {
    const root = await writeBundle('db-thing');
    const keys = generateSigningKeypair();
    const archive = join(work, 'db-thing.hexpkg');

    const result = await packPackage(root, archive, { privateKeyPem: keys.privateKeyPem });

    expect(result.manifest.format).toBe(HEXPKG_FORMAT);
    expect(result.manifest.name).toBe('db-thing');
    expect(result.manifest.version).toBe('1.2.3');
    expect(result.manifest.type).toBe('component');
    expect(result.manifest.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The .hex manifest + the two source files are all packaged.
    expect(result.manifest.files.map((f) => f.path).sort()).toEqual([
      'artifact/.hex/manifest.yaml',
      'artifact/README.md',
      'artifact/src/index.ts',
    ]);
    expect(result.signature.algorithm).toBe('ed25519');
    expect(result.signature.keyId).toBe(keys.keyId);

    const verified = await verifyPackage(archive, { [keys.keyId]: keys.publicKeyPem });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.keyId).toBe(keys.keyId);
      expect(verified.manifest.name).toBe('db-thing');
    }
  });

  it('rejects a package signed by a key not in the trust store', async () => {
    const root = await writeBundle();
    const signer = generateSigningKeypair();
    const archive = join(work, 'sample.hexpkg');
    await packPackage(root, archive, { privateKeyPem: signer.privateKeyPem });

    // Trust store holds a *different* key.
    const other = generateSigningKeypair();
    const verified = await verifyPackage(archive, { [other.keyId]: other.publicKeyPem });
    expect(verified).toEqual({ ok: false, reason: `untrusted signing key: ${signer.keyId}` });
  });

  it('rejects when keyId resolves to the wrong key (trust store misconfigured)', async () => {
    const root = await writeBundle();
    const signer = generateSigningKeypair();
    const archive = join(work, 'sample.hexpkg');
    await packPackage(root, archive, { privateKeyPem: signer.privateKeyPem });

    // signer.keyId mapped to some other key's PEM.
    const other = generateSigningKeypair();
    const verified = await verifyPackage(archive, { [signer.keyId]: other.publicKeyPem });
    expect(verified).toEqual({
      ok: false,
      reason: `key id mismatch for ${signer.keyId} — trust store misconfigured`,
    });
  });
});

describe('marketplace package — tamper detection', () => {
  async function packed(): Promise<{
    archive: string;
    keys: ReturnType<typeof generateSigningKeypair>;
  }> {
    const root = await writeBundle();
    const keys = generateSigningKeypair();
    const archive = join(work, 'sample.hexpkg');
    await packPackage(root, archive, { privateKeyPem: keys.privateKeyPem });
    return { archive, keys };
  }

  it('detects a modified artifact file', async () => {
    const { archive, keys } = await packed();
    const forged = await repack(archive, async (dir) => {
      await writeFile(join(dir, 'artifact', 'src', 'index.ts'), 'export const x = 999;\n', 'utf8');
    });
    const verified = await verifyPackage(forged, { [keys.keyId]: keys.publicKeyPem });
    expect(verified).toEqual({ ok: false, reason: 'file tampered: artifact/src/index.ts' });
  });

  it('detects an added artifact file not in the manifest', async () => {
    const { archive, keys } = await packed();
    const forged = await repack(archive, async (dir) => {
      await writeFile(join(dir, 'artifact', 'src', 'evil.ts'), 'malware();\n', 'utf8');
    });
    const verified = await verifyPackage(forged, { [keys.keyId]: keys.publicKeyPem });
    expect(verified).toEqual({
      ok: false,
      reason: 'unexpected file not in manifest: artifact/src/evil.ts',
    });
  });

  it('detects a removed artifact file', async () => {
    const { archive, keys } = await packed();
    const forged = await repack(archive, async (dir) => {
      await rm(join(dir, 'artifact', 'README.md'));
    });
    const verified = await verifyPackage(forged, { [keys.keyId]: keys.publicKeyPem });
    expect(verified).toEqual({
      ok: false,
      reason: 'file declared in manifest but missing: artifact/README.md',
    });
  });

  it('detects a substituted manifest digest', async () => {
    const { archive, keys } = await packed();
    const forged = await repack(archive, async (dir) => {
      const path = join(dir, 'hexpkg.json');
      const manifest = JSON.parse(await readFile(path, 'utf8')) as HexpkgManifest;
      manifest.digest = `sha256:${'0'.repeat(64)}`;
      await writeFile(path, JSON.stringify(manifest, null, 2), 'utf8');
    });
    const verified = await verifyPackage(forged, { [keys.keyId]: keys.publicKeyPem });
    expect(verified).toEqual({
      ok: false,
      reason: 'digest mismatch — manifest has been altered',
    });
  });

  it('detects a forged signature', async () => {
    const { archive, keys } = await packed();
    const forged = await repack(archive, async (dir) => {
      const path = join(dir, 'hexpkg.sig');
      const sig = JSON.parse(await readFile(path, 'utf8')) as HexpkgSignature;
      // Flip the signature bytes — same length, wrong content.
      const bytes = Buffer.from(sig.signature, 'base64');
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      sig.signature = bytes.toString('base64');
      await writeFile(path, JSON.stringify(sig, null, 2), 'utf8');
    });
    const verified = await verifyPackage(forged, { [keys.keyId]: keys.publicKeyPem });
    expect(verified).toEqual({ ok: false, reason: 'signature verification failed' });
  });
});

describe('marketplace package — key helpers', () => {
  it('generates Ed25519 keypairs with a deterministic keyId', async () => {
    const keys = generateSigningKeypair();
    expect(keys.keyId).toMatch(/^[0-9a-f]{16}$/);
    // keyId derives purely from the public key — recomputing matches.
    expect(keyIdFor(keys.publicKeyPem)).toBe(keys.keyId);
    expect(keys.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(keys.publicKeyPem).toContain('BEGIN PUBLIC KEY');
  });

  it('gives distinct keyIds to distinct keys', async () => {
    expect(generateSigningKeypair().keyId).not.toBe(generateSigningKeypair().keyId);
  });
});
