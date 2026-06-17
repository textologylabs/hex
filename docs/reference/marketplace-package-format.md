# Marketplace package format — `hexpkg/1`

The on-the-wire form of a published component or recipe. A `.hexpkg`
file is what a `MarketplaceSource` (M9.2) downloads and what the registry
(M9.9) stores. This page is the spec **and** the record of the signing
decision (M9.1).

## Archive layout

A `.hexpkg` is a **gzipped tar archive** with exactly three members:

| Member         | Contents                                                        |
| -------------- | --------------------------------------------------------------- |
| `artifact/`    | The complete authored bundle tree — `.hex/` + scaffolding files |
| `hexpkg.json`  | The package manifest (identity + per-file hashes + digest)      |
| `hexpkg.sig`   | A detached Ed25519 signature over the manifest                  |

The bundle tree is namespaced under `artifact/` so an authored file can
never collide with the two metadata members. `.git/` and `node_modules/`
are excluded; everything else — including `.hex/` — is packaged verbatim.
`.hexignore` is **not** consulted: it governs rendering, not packaging.

## `hexpkg.json`

```json
{
  "format": "hexpkg/1",
  "name": "db-postgres",
  "version": "2.0.0",
  "type": "component",
  "createdAt": "2026-05-16T10:00:00.000Z",
  "files": [
    { "path": "artifact/.hex/manifest.yaml", "sha256": "<hex>" },
    { "path": "artifact/src/index.ts", "sha256": "<hex>" }
  ],
  "digest": "sha256:<hex>"
}
```

- `name`, `version`, `type` are copied from the bundle's own manifest.
- `files` is the sha256 of every artifact file, sorted by `path`.
- `digest` is `sha256:` + the sha256 of the **canonical manifest bytes**:
  a fixed-key-order, sorted-`files` JSON serialization of every field
  *except* `digest` itself. The same logical manifest always serializes
  to the same bytes, so the digest is reproducible.

## `hexpkg.sig`

```json
{
  "algorithm": "ed25519",
  "keyId": "<16 hex chars>",
  "signature": "<base64>"
}
```

`signature` is an Ed25519 signature over the **canonical manifest bytes**
(the same bytes the digest hashes) — not the raw tar bytes, so tar's
mtime/ordering quirks can never destabilise a signature. `keyId` is the
first 16 hex chars of the sha256 of the signing key's SPKI-DER encoding;
it selects the verifying key and lets the format survive key rotation.

## Verification

A package verifies only if **all** of these hold:

1. `format` is `hexpkg/1`.
2. The digest recomputed from the manifest equals the `digest` field.
3. Every file in `files` exists under `artifact/` with the recorded hash.
4. No artifact file is present that is *not* listed in `files`.
5. `keyId` resolves to a trusted public key, and that key's own derived
   id matches `keyId` (guards against a misconfigured trust store).
6. The Ed25519 signature verifies against that key.

These layer: a changed file fails (3); an added/removed file fails (4);
a substituted digest fails (2); a forged signature fails (6). Tampering
is caught even before the signature check.

## Signing decision — and why

**Chosen:** Ed25519 detached signatures via Node's built-in
`node:crypto`. **Trust root:** the *marketplace* signs packages on
ingestion; Hex clients ship the marketplace's *public* key.

### How comparable marketplaces do it

| System              | Mechanism                                          | Trust root                  |
| ------------------- | -------------------------------------------------- | --------------------------- |
| VS Code Marketplace | Marketplace signs the `.vsix` server-side          | The Marketplace itself      |
| npm                 | Registry-signed metadata (ECDSA) + SRI hashes      | Pinned registry public key  |
| apt / dpkg          | Detached GPG signature on the repo `Release` file  | Publisher GPG keys          |
| PyPI / OCI images   | Sigstore — keyless, OIDC identity, transparency log| Fulcio CA + Rekor log       |

### Rationale

- **Marketplace-as-signer, not publisher-as-signer.** Modern marketplaces
  (VS Code, npm) make the registry the trust root and sign server-side.
  Publishers manage no keys and clients pin *one* key, not a per-publisher
  keyring. The apt model — publishers hold keys, users import them — is
  the older approach with the well-known key-distribution problem; we
  don't repeat it.
- **Ed25519 via `node:crypto`.** Small, fast, deterministic, offline-
  verifiable, and zero new crypto dependencies — Node ships it. The
  signature primitive is the same class of modern signature these
  systems use under the hood.
- **Not Sigstore (for now).** Sigstore is best practice for build
  *provenance*, but it is heavyweight: OIDC plumbing, a Fulcio CA, and a
  network round-trip to a Rekor transparency log just to *verify*.
  Overkill for an MVP registry. The `keyId` field leaves the door open:
  publisher self-signing as optional provenance can be layered on later
  without a format change.
- **`keyId` indirection.** Signatures name a key id, not a key. Key
  rotation and multiple marketplaces (M9.5) need no format revision.

## What M9.1 does not cover

- The registry server and HTTP surface — M9.9.
- `MarketplaceSource` fetch/cache integration — M9.2.
- Where trusted keys are configured and how they are blocked/overridden
  — M9.6 and the config schema.
- Semver resolution across published versions — M9.2/M9.3.
