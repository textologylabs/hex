import { readFile } from 'node:fs/promises';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { AuthError, type TokenStore, authenticatePublish, loadTokens } from './auth.js';
import { PublishError, publishPackage } from './publish.js';
import {
  renderBrowsePage,
  renderCategoryPage,
  renderDetailPage,
  renderNotFound,
  renderResults,
  renderSearchPage,
} from './site.js';
import {
  type CataloguePackage,
  StoreError,
  findPackage,
  listCategories,
  packagesInCategory,
  readCatalogue,
  readIndex,
  searchCatalogue,
} from './store.js';

/**
 * The Hex marketplace registry server (M9.9).
 *
 * Read side — pure static-shaped JSON the `MarketplaceSource` (M9.2) and
 * `Catalogue` (M9.3) clients already fetch:
 *   GET /catalogue.json            GET /<name>/index.json
 *   GET /packages/<file>.hexpkg
 *
 * Write side — the only endpoint with logic:
 *   POST /publish   (Bearer token; server packs + signs the upload)
 *
 * Website — server-rendered HTMX pages: GET / , /search , /browse , /p/<name>.
 *
 * Publishes are serialised through an in-process lock so concurrent
 * uploads cannot interleave catalogue/index regeneration. The whole
 * thing is one Node process — no framework, no database.
 */

export type RegistryServerConfig = {
  /** Store root directory (holds catalogue.json, <name>/, packages/). */
  storeDir: string;
  /** PKCS#8 PEM of the marketplace signing key. */
  marketplacePrivateKeyPem: string;
  /** Publish token → publisher map. */
  tokens: TokenStore;
};

const NAME_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Path to htmx, resolved from the `htmx.org` dependency — served at
 * `/assets/htmx.min.js`, never loaded from a third-party CDN (a
 * marketplace must not hand its visitors a script it doesn't control).
 */
const HTMX_PATH = join(
  dirname(createRequire(import.meta.url).resolve('htmx.org/package.json')),
  'dist',
  'htmx.min.js',
);

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, 'application/json', `${JSON.stringify(value, null, 2)}\n`);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Serialises publishes so catalogue/index regeneration never interleaves. */
function createLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = chain.then(fn, fn);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result as Promise<T>;
  };
}

/** Build the registry HTTP server. Caller owns `.listen()`. */
export function createRegistryServer(config: RegistryServerConfig): Server {
  const withPublishLock = createLock();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // ── publish ───────────────────────────────────────────────────────
    if (path === '/publish') {
      if (method !== 'POST') return sendJson(res, 405, { error: 'POST required' });
      let publisher: string;
      try {
        ({ publisher } = authenticatePublish(config.tokens, req.headers.authorization));
      } catch (err) {
        return sendJson(res, 401, {
          error: err instanceof AuthError ? err.message : 'unauthorized',
        });
      }
      const upload = await readBody(req);
      if (upload.length === 0) return sendJson(res, 400, { error: 'empty upload' });
      try {
        const published = await withPublishLock(() =>
          publishPackage({
            rootDir: config.storeDir,
            upload,
            marketplacePrivateKeyPem: config.marketplacePrivateKeyPem,
            description: header(req, 'x-hex-description'),
            categories: headerList(req, 'x-hex-categories'),
          }),
        );
        return sendJson(res, 201, { published, publisher });
      } catch (err) {
        if (err instanceof StoreError) return sendJson(res, 409, { error: err.message });
        if (err instanceof PublishError) return sendJson(res, 400, { error: err.message });
        return sendJson(res, 500, { error: err instanceof Error ? err.message : 'publish failed' });
      }
    }

    if (method !== 'GET') return sendJson(res, 405, { error: 'GET required' });

    // ── registry read endpoints ───────────────────────────────────────
    if (path === '/catalogue.json') {
      return sendJson(res, 200, await readCatalogue(config.storeDir));
    }
    const indexMatch = /^\/([^/]+)\/index\.json$/.exec(path);
    if (indexMatch) {
      const name = decodeURIComponent(indexMatch[1] as string);
      if (!NAME_SEGMENT_RE.test(name)) return sendJson(res, 404, { error: 'not found' });
      const index = await readIndex(config.storeDir, name);
      return index
        ? sendJson(res, 200, index)
        : sendJson(res, 404, { error: `no package "${name}"` });
    }
    const pkgMatch = /^\/packages\/([^/]+)$/.exec(path);
    if (pkgMatch) {
      const file = decodeURIComponent(pkgMatch[1] as string);
      if (!NAME_SEGMENT_RE.test(file)) return sendJson(res, 404, { error: 'not found' });
      try {
        const bytes = await readFile(join(config.storeDir, 'packages', file));
        return send(res, 200, 'application/octet-stream', bytes);
      } catch {
        return sendJson(res, 404, { error: 'package not found' });
      }
    }

    // ── static assets ─────────────────────────────────────────────────
    if (path === '/assets/htmx.min.js') {
      try {
        const js = await readFile(HTMX_PATH);
        return send(res, 200, 'application/javascript', js);
      } catch {
        return send(res, 404, 'text/plain', 'asset not found');
      }
    }

    // ── website ───────────────────────────────────────────────────────
    const catalogue = await readCatalogue(config.storeDir);

    if (path === '/' || path === '/search') {
      const query = url.searchParams.get('q') ?? '';
      const results = searchCatalogue(catalogue, query);
      // HTMX requests get just the results fragment to swap in.
      if (path === '/search' && req.headers['hx-request'] === 'true') {
        return send(res, 200, 'text/html', renderResults(results));
      }
      return send(res, 200, 'text/html', renderSearchPage(query, results));
    }

    if (path === '/browse') {
      const category = url.searchParams.get('category');
      if (category) {
        return send(
          res,
          200,
          'text/html',
          renderCategoryPage(category, packagesInCategory(catalogue, category)),
        );
      }
      return send(res, 200, 'text/html', renderBrowsePage(listCategories(catalogue)));
    }

    const detailMatch = /^\/p\/([^/]+)$/.exec(path);
    if (detailMatch) {
      const name = decodeURIComponent(detailMatch[1] as string);
      const pkg: CataloguePackage | undefined = findPackage(catalogue, name);
      if (!pkg) return send(res, 404, 'text/html', renderNotFound(`No package "${name}".`));
      const index = await readIndex(config.storeDir, name);
      const versions = (index?.versions ?? []).map((v) => v.version);
      return send(res, 200, 'text/html', renderDetailPage(pkg, versions));
    }

    return send(res, 404, 'text/html', renderNotFound('Page not found.'));
  }

  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'internal error' });
      } else {
        res.end();
      }
    });
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function headerList(req: IncomingMessage, name: string): string[] | undefined {
  const v = header(req, name);
  if (!v) return undefined;
  const parts = v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/** Entry point: read config from the environment and start listening. */
async function main(): Promise<void> {
  const storeDir = process.env.HEX_REGISTRY_STORE;
  const keyPath = process.env.HEX_REGISTRY_KEY;
  const tokensPath = process.env.HEX_REGISTRY_TOKENS;
  const port = Number(process.env.PORT ?? 8080);

  if (!storeDir || !keyPath || !tokensPath) {
    process.stderr.write(
      'hex-registry: set HEX_REGISTRY_STORE, HEX_REGISTRY_KEY, HEX_REGISTRY_TOKENS\n',
    );
    process.exit(1);
  }

  const marketplacePrivateKeyPem = await readFile(keyPath, 'utf8');
  const tokens = await loadTokens(tokensPath);

  const server = createRegistryServer({ storeDir, marketplacePrivateKeyPem, tokens });
  server.listen(port, () => {
    process.stdout.write(`hex-registry listening on :${port} (store: ${storeDir})\n`);
  });
}

// Run only when executed directly, not when imported by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`hex-registry: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
