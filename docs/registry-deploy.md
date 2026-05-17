# Deploying the Hex marketplace registry

The registry server (`registry/`) is the public `hex` marketplace: it
serves the `catalogue.json` / `index.json` / `.hexpkg` endpoints that
`MarketplaceSource` and the `Catalogue` fetch, accepts authenticated
`POST /publish` uploads, and renders the search/browse website.

This runbook covers standing it up. The code is built and tested in the
repo; provisioning (DNS, TLS, the host) is the operator's job.

## 1. Generate the marketplace signing keypair

```sh
npm run registry:keygen /etc/hex-registry
```

Writes `marketplace.key` (PKCS#8 private — **secret**) and
`marketplace.pub` (SPKI public). Prints the `keyId`.

- **Private key** — never leaves the registry host; `HEX_REGISTRY_KEY`
  points at it. The server signs every published package with it
  (marketplace-as-signer, M9.1).
- **Public key** — published so clients can pin it as a trusted key.
  Distribute `marketplace.pub` + the `keyId` alongside the registry URL.

> **Trade-off — the signing key is on the server.** Because developers
> self-publish (no developer keys), the marketplace signs on the server,
> so the key lives on an internet-facing host. Keep that host locked
> down. A later iteration can move signing to an offline signer (the
> publish endpoint queues uploads; an offline process signs and writes
> the store) without changing the package format or any client.

## 2. Create the publish-token file

A JSON object of `token → publisher`:

```json
{
  "tok_live_9f3c…": "textology",
  "tok_live_a17b…": "acme-corp"
}
```

Generate tokens with any CSPRNG (e.g. `openssl rand -hex 32`). Add an
entry per publisher; `HEX_REGISTRY_TOKENS` points at this file. An
absent or empty file means *no one can publish* (closed by default).

## 3. Build and run

```sh
npm install
npm run registry:build          # → registry/dist/server.js

HEX_REGISTRY_STORE=/var/lib/hex-registry/store \
HEX_REGISTRY_KEY=/etc/hex-registry/marketplace.key \
HEX_REGISTRY_TOKENS=/etc/hex-registry/tokens.json \
PORT=8080 \
  npm run registry:start
```

Run it under a process supervisor (systemd, pm2, a container) so it
restarts on crash/reboot. The store directory is the registry's only
state — back it up; it is a plain directory tree and rsync-friendly.

## 4. DNS + TLS

The server speaks plain HTTP. Put a TLS-terminating reverse proxy in
front (Caddy or nginx):

- Point a DNS A/AAAA record (e.g. `registry.hex.dev`) at the host.
- Proxy `https://registry.hex.dev` → `http://127.0.0.1:8080`.
- Caddy obtains certificates automatically; with nginx use certbot.

The read endpoints are immutable and cacheable — a CDN in front is
optional and safe.

## 5. Smoke test (publish here, fetch there)

On a publishing machine:

```sh
hex publish ./my-component \
  --registry https://registry.hex.dev/ \
  --token tok_live_9f3c… \
  --description "My component" --category backend
```

On a *different* machine, confirm the package resolves and verifies
against the published public key — this is the end-to-end check the
M9.9 acceptance asks for. The `test/registry/server.test.ts`
"publish → fetch loop" test exercises exactly this path in-process.

## Endpoints

| Method + path                 | Purpose                                  |
| ------------------------------ | ---------------------------------------- |
| `GET /catalogue.json`          | Whole catalogue (search/browse source)   |
| `GET /<name>/index.json`       | A package's published versions           |
| `GET /packages/<file>.hexpkg`  | A signed package archive                 |
| `POST /publish`                | Authenticated publish (Bearer token)     |
| `GET /` · `/search` · `/browse` · `/p/<name>` | The website            |
| `GET /assets/htmx.min.js`      | htmx (the `htmx.org` dependency)         |

## Out of scope (per the M9.9 ticket)

User accounts beyond publish tokens; advanced moderation; package
deletion/yank. Versions are immutable — republishing an existing
`name@version` is refused.
