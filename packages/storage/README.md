# @oxagen/storage

Vendor-neutral blob storage. Code writes and reads binary objects through one
`StorageAdapter`, and `STORAGE_DRIVER` picks the backend: Vercel Blob in
production, the local filesystem in CI and local development.

## Boundary

- **Owns:**
  - The `StorageAdapter` contract: `put`, `get`, and `delete` over a logical
    key (`src/types.ts`).
  - The process-wide adapter selected by `STORAGE_DRIVER` (`src/client.ts`).
  - The Vercel Blob driver (`src/vercel-blob.ts`) and the filesystem driver
    (`src/fs-driver.ts`).
  - Asset kinds, their size limits and allowed MIME types, and server-derived
    object keys (`src/assets.ts`).
  - Copying an OAuth avatar from an allowlisted provider host into the store
    (`src/ingest.ts`).
- **Does not own:**
  - The Postgres rows that reference stored objects:
    [`@oxagen/database`](../database/README.md).
  - Encrypting run evidence before it is stored, and the tenant-first key
    layout for evidence: [`@oxagen/run-ledger`](../run-ledger/README.md)
    (`src/evidence-store.ts`) with [`@oxagen/crypto`](../crypto/README.md).
  - Upload and serve handlers: [`@oxagen/handlers`](../handlers/README.md).
- **Depends on:**
  - `@oxagen/config`: `requireEnv` for `STORAGE_DRIVER`,
    `BLOB_READ_WRITE_TOKEN`, and `STORAGE_FS_ROOT`.
- **Used by:** `apps/api`, `apps/app`, `apps/app_deprecated`,
  `@oxagen/handlers`, `@oxagen/inngest-functions`, and `@oxagen/run-ledger`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `StorageAdapter` | port | `packages/storage/src/types.ts` | Implemented by `src/vercel-blob.ts` and `src/fs-driver.ts` |
| `storage()` | export | `packages/storage/src/client.ts` | `packages/run-ledger/src/evidence-store.ts`, `packages/handlers/src/asset.upload.ts`, `apps/api/src/routes/v1/run.export.download.ts`, `apps/app/src/features/shell/export-storage.ts` |
| `STORAGE_DRIVER` | boundary | `packages/storage/src/client.ts` | Declared in `packages/config/src/env.ts` and `packages/config/src/registry.ts` |
| App import allowlist | boundary | `apps/app/src/test/arch/layers.ts` | Admits `@oxagen/storage` in `src/features/shell/export-storage.ts` only |
| `ingestImageFromUrl` | export | `packages/storage/src/ingest.ts` | `apps/app_deprecated/src/app/(onboarding)/new-organization/actions.ts` only. `apps/app` does not call it. |

## Entry points

- `.` (`src/index.ts`): `storage()`, both driver factories,
  `StorageNotFoundError`, the adapter types, asset limits and key helpers, and
  image ingestion.

## Rules

- Never import `@vercel/blob` outside this package. Depend on `StorageAdapter`.
- A new driver implements `StorageAdapter`, joins the `STORAGE_DRIVER` enum in
  `packages/config/src/env.ts`, and gets a case in `src/client.ts`.
- A returned `url` is a public CDN URL only for a public object on a driver
  with a CDN. For a private object, and for every filesystem object, it is the
  key, and the bytes come back through `get`.
- Object keys are derived on the server (`deriveAssetKey`), never taken from a
  request.
- `ingestImageFromUrl` fetches over HTTPS from an allowlist of OAuth avatar
  hosts only, because the source URL comes from a form submission.
- The store holds binary assets only. Metadata and transactional state stay in
  Postgres.

## Tests

```bash
pnpm --filter @oxagen/storage test:unit src/client.test.ts
```

Tests sit beside their source under `src/`.
