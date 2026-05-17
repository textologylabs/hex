import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TokenStore } from '../../registry/auth.js';
import { type RegistryServerConfig, createRegistryServer } from '../../registry/server.js';
import { createBundleTarball } from '../../src/commands/publish.js';
import { type SigningKeypair, generateSigningKeypair } from '../../src/core/marketplace/package.js';
import { resolveMarketplaceSource } from '../../src/core/marketplace/source.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-registry-test-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

/** Write a minimal component bundle and return its directory. */
async function writeComponent(name: string, version: string): Promise<string> {
  const dir = join(work, `src-${name}-${version}`);
  await mkdir(join(dir, '.hex'), { recursive: true });
  await writeFile(
    join(dir, '.hex', 'manifest.yaml'),
    `type: component\nname: ${name}\nversion: ${version}\nkind: db\n`,
    'utf8',
  );
  await writeFile(join(dir, 'index.ts'), `export const v = '${version}';\n`, 'utf8');
  return dir;
}

type Harness = {
  baseUrl: string;
  keys: SigningKeypair;
  storeDir: string;
  close: () => Promise<void>;
};

/** Start a registry server on an ephemeral port. */
async function startRegistry(tokens: TokenStore): Promise<Harness> {
  const keys = generateSigningKeypair();
  const storeDir = join(work, 'store');
  const config: RegistryServerConfig = {
    storeDir,
    marketplacePrivateKeyPem: keys.privateKeyPem,
    tokens,
  };
  const server = createRegistryServer(config);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    keys,
    storeDir,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** POST a component directory to the registry's /publish endpoint. */
async function publish(
  baseUrl: string,
  token: string,
  dir: string,
  extra: Record<string, string> = {},
): Promise<Response> {
  const body = await createBundleTarball(dir);
  return fetch(`${baseUrl}/publish`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, ...extra },
    body,
  });
}

describe('registry server — publish', () => {
  it('publishes a bundle, signs it, and exposes it on the read endpoints', async () => {
    const reg = await startRegistry(new Map([['tok-abc', 'alice']]));
    try {
      const res = await publish(
        reg.baseUrl,
        'tok-abc',
        await writeComponent('db-postgres', '1.0.0'),
        {
          'x-hex-description': 'Postgres access',
          'x-hex-categories': 'database,backend',
        },
      );
      expect(res.status).toBe(201);
      const payload = (await res.json()) as { published: { name: string }; publisher: string };
      expect(payload.published.name).toBe('db-postgres');
      expect(payload.publisher).toBe('alice');

      // catalogue.json reflects the publish.
      const catalogue = (await (await fetch(`${reg.baseUrl}/catalogue.json`)).json()) as {
        packages: Array<{ name: string; latest: string; categories: string[] }>;
      };
      expect(catalogue.packages[0]).toMatchObject({
        name: 'db-postgres',
        latest: '1.0.0',
        categories: ['database', 'backend'],
      });

      // index.json lists the version.
      const index = (await (await fetch(`${reg.baseUrl}/db-postgres/index.json`)).json()) as {
        versions: Array<{ version: string }>;
      };
      expect(index.versions.map((v) => v.version)).toEqual(['1.0.0']);
    } finally {
      await reg.close();
    }
  });

  it('rejects publishing without a valid token', async () => {
    const reg = await startRegistry(new Map([['tok-abc', 'alice']]));
    try {
      const dir = await writeComponent('api', '1.0.0');
      expect((await publish(reg.baseUrl, 'wrong-token', dir)).status).toBe(401);

      const noAuth = await fetch(`${reg.baseUrl}/publish`, {
        method: 'POST',
        body: await createBundleTarball(dir),
      });
      expect(noAuth.status).toBe(401);
    } finally {
      await reg.close();
    }
  });

  it('rejects republishing an existing version with 409', async () => {
    const reg = await startRegistry(new Map([['tok-abc', 'alice']]));
    try {
      const dir = await writeComponent('api', '1.0.0');
      expect((await publish(reg.baseUrl, 'tok-abc', dir)).status).toBe(201);
      expect((await publish(reg.baseUrl, 'tok-abc', dir)).status).toBe(409);
    } finally {
      await reg.close();
    }
  });

  it('rejects an upload that is not a valid bundle with 400', async () => {
    const reg = await startRegistry(new Map([['tok-abc', 'alice']]));
    try {
      const res = await fetch(`${reg.baseUrl}/publish`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-abc' },
        body: Buffer.from('not a tarball'),
      });
      expect(res.status).toBe(400);
    } finally {
      await reg.close();
    }
  });
});

describe('registry server — publish → fetch loop', () => {
  it('a published package resolves end-to-end via MarketplaceSource', async () => {
    const reg = await startRegistry(new Map([['tok-abc', 'alice']]));
    try {
      await publish(reg.baseUrl, 'tok-abc', await writeComponent('db-postgres', '2.0.0'));

      // Fetch it back the way a real `hex new` would — over HTTP, with
      // signature verification against the marketplace's public key.
      const result = await resolveMarketplaceSource(
        { registry: `${reg.baseUrl}/`, name: 'db-postgres', version: '^2.0.0' },
        {
          cacheDir: join(work, 'cache'),
          trustedKeys: { [reg.keys.keyId]: reg.keys.publicKeyPem },
        },
      );
      expect(result.version).toBe('2.0.0');
      expect(result.bundle.manifest.name).toBe('db-postgres');
      expect(result.keyId).toBe(reg.keys.keyId);
    } finally {
      await reg.close();
    }
  });
});

describe('registry server — website', () => {
  it('serves search, browse, and detail pages', async () => {
    const reg = await startRegistry(new Map([['tok-abc', 'alice']]));
    try {
      await publish(reg.baseUrl, 'tok-abc', await writeComponent('db-postgres', '1.0.0'), {
        'x-hex-categories': 'database',
      });

      const home = await fetch(`${reg.baseUrl}/`);
      expect(home.headers.get('content-type')).toMatch(/text\/html/);
      expect(await home.text()).toContain('db-postgres');

      // HTMX request to /search gets just the results fragment.
      const fragment = await (
        await fetch(`${reg.baseUrl}/search?q=postgres`, { headers: { 'hx-request': 'true' } })
      ).text();
      expect(fragment).toContain('db-postgres');
      expect(fragment).not.toContain('<html');

      const browse = await (await fetch(`${reg.baseUrl}/browse`)).text();
      expect(browse).toContain('database');

      const detail = await fetch(`${reg.baseUrl}/p/db-postgres`);
      expect(detail.status).toBe(200);
      expect(await detail.text()).toContain('hex new hex/db-postgres');

      expect((await fetch(`${reg.baseUrl}/p/missing`)).status).toBe(404);
    } finally {
      await reg.close();
    }
  });

  it('serves htmx from the htmx.org dependency', async () => {
    const reg = await startRegistry(new Map());
    try {
      const res = await fetch(`${reg.baseUrl}/assets/htmx.min.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/javascript/);
      expect((await res.text()).length).toBeGreaterThan(1000);
    } finally {
      await reg.close();
    }
  });
});
