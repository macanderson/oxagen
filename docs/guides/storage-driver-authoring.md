# Storage Driver Authoring Guide

This guide explains how to add a new blob storage provider to the
`@oxagen/storage` package. The storage layer uses a driver pattern so the
concrete backend (Vercel Blob, AWS S3, Cloudflare R2, GCS, etc.) is a
config-only swap controlled by the `STORAGE_DRIVER` env var. Application code
never imports a vendor SDK directly -- it depends on the `StorageAdapter`
interface and the `storage()` singleton.

---

## Overview

All file and blob operations in Oxagen flow through a single interface:
`StorageAdapter`. This contract lives in `packages/storage/src/types.ts` and
is the only surface area that application code (API routes, MCP handlers,
ingestion workers) interacts with.

The adapter pattern provides:

- **Vendor neutrality** -- swap providers without touching import sites.
- **Testability** -- every consumer can mock `StorageAdapter` without coupling
  to a specific SDK.
- **Consistent error semantics** -- all drivers throw `StorageNotFoundError` for
  missing keys, making error handling uniform across the codebase.
- **Lazy, env-driven initialization** -- the active driver is selected at
  runtime by reading `STORAGE_DRIVER` from the environment.

---

## The `StorageAdapter` Interface

```typescript
// packages/storage/src/types.ts

export type StorageBody = Blob | ArrayBuffer | Uint8Array;

export interface PutObjectInput {
  key: string;
  body: StorageBody;
  contentType?: string;
  access?: "public" | "private";
}

export interface PutObjectResult {
  url: string;
  key: string;
  bytes: number;
  access: "public" | "private";
}

export interface GetObjectResult {
  body: ReadableStream<Uint8Array>;
  contentType: string | null;
  sizeBytes: number | null;
}

export interface StorageAdapter {
  readonly driver: string;
  put(input: PutObjectInput): Promise<PutObjectResult>;
  delete(urlOrKey: string): Promise<void>;
  get(key: string): Promise<GetObjectResult>;
}
```

### Method semantics

| Method | Description | Error behavior |
|--------|-------------|----------------|
| `put` | Write an object. Returns a durable URL plus the canonical key. Must be idempotent for the same key (overwrite semantics). | Throw on SDK/network errors. |
| `delete` | Remove an object by URL or key. Must be idempotent -- deleting a non-existent key is a no-op. | Never throw for missing keys. |
| `get` | Stream an object by its canonical key. Returns a `ReadableStream` so callers can pipe directly into a `Response`. | Throw `StorageNotFoundError` when the key does not exist. |

### The `driver` property

Every adapter must expose a `readonly driver: string` field (e.g.
`"vercel-blob"`, `"s3"`, `"r2"`). This is used in structured logs, metrics, and
error messages -- never for branching logic.

### Access control

`PutObjectInput.access` defaults to `"public"` when omitted:

- `"public"` -- the returned `url` is a CDN-accessible URL. Consumers can embed
  it directly in HTML or return it in API responses.
- `"private"` -- the object requires authenticated retrieval via `get()`. The
  returned `url` field is the canonical key/pathname (same as `key`). Never
  expose this URL to end-users.

---

## Step-by-Step: Adding a New Provider

### Step 1 -- Create the driver file

Create `packages/storage/src/<driver-name>.ts`. Follow the naming convention of
the existing `vercel-blob.ts` file.

```
packages/storage/src/s3.ts
```

Export a factory function that accepts any credentials/config the driver needs
and returns a `StorageAdapter`:

```typescript
export function createS3Adapter(config: S3AdapterConfig): StorageAdapter { ... }
```

### Step 2 -- Implement the `StorageAdapter` interface

Your factory function must return an object satisfying `StorageAdapter`. Key
rules:

1. **`put()` must normalize the body to whatever the SDK expects.** The caller
   may pass `Blob`, `ArrayBuffer`, or `Uint8Array`. Convert as needed.
2. **`put()` must report accurate `bytes`.** Use `body.byteLength` for typed
   arrays and `body.size` for Blobs.
3. **`delete()` must be idempotent.** If the SDK throws a 404/NoSuchKey error,
   swallow it silently.
4. **`get()` must throw `StorageNotFoundError` for missing objects.** Import it
   from `./errors`.
5. **`get()` must return a `ReadableStream<Uint8Array>`.** Do not buffer the
   full object in memory.

### Step 3 -- Add environment variables

Open `packages/config/src/env.ts` and:

1. Add your driver name to the `STORAGE_DRIVER` enum:
   ```typescript
   STORAGE_DRIVER: z.enum(["vercel-blob", "s3"]).default("vercel-blob").optional(),
   ```

2. Add any driver-specific env vars (credentials, bucket names, regions):
   ```typescript
   AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
   AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
   S3_BUCKET: z.string().min(1).optional(),
   S3_REGION: z.string().min(1).optional(),
   ```

   Mark them `.optional()` so they are only required when your driver is active.

### Step 4 -- Register in `client.ts`

Open `packages/storage/src/client.ts` and:

1. Add your driver to the `SUPPORTED_DRIVERS` tuple:
   ```typescript
   const SUPPORTED_DRIVERS = ["vercel-blob", "s3"] as const;
   ```

2. Add a case to the `resolveAdapter()` switch:
   ```typescript
   case "s3": {
     const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET, S3_REGION } =
       requireEnv(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "S3_BUCKET", "S3_REGION"] as const);
     if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !S3_BUCKET || !S3_REGION) {
       throw new Error("S3 credentials are not fully configured. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET, and S3_REGION.");
     }
     return createS3Adapter({ accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY, bucket: S3_BUCKET, region: S3_REGION });
   }
   ```

3. Add the import for your factory at the top of the file:
   ```typescript
   import { createS3Adapter } from "./s3";
   ```

### Step 5 -- Write tests

Create `packages/storage/src/<driver-name>.test.ts`. Follow the pattern
established by `vercel-blob.test.ts` (see Testing section below).

---

## Provider Skeleton (S3 Example)

Below is a complete, commented template for a hypothetical S3 driver. Use this
as your starting point.

```typescript
// packages/storage/src/s3.ts

import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { StorageNotFoundError } from "./errors";
import type { StorageAdapter, PutObjectInput, PutObjectResult, GetObjectResult, StorageBody } from "./types";

// ── Config ──────────────────────────────────────────────────────────────────

export interface S3AdapterConfig {
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  /** Optional custom endpoint for S3-compatible services (R2, MinIO). */
  endpoint?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Convert any StorageBody variant to a Buffer for the AWS SDK. */
function toBuffer(body: StorageBody): Buffer {
  if (body instanceof Blob) {
    // Blob.arrayBuffer() is async -- for simplicity, we convert via Uint8Array.
    // In practice, use streaming upload (Upload from @aws-sdk/lib-storage) for
    // large objects.
    throw new Error("Blob bodies require async conversion. Use Uint8Array or ArrayBuffer.");
  }
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return Buffer.from(body);
}

/** Compute byte length of any StorageBody variant. */
function byteLength(body: StorageBody): number {
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  return body.byteLength;
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createS3Adapter(config: S3AdapterConfig): StorageAdapter {
  const client = new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    ...(config.endpoint && { endpoint: config.endpoint, forcePathStyle: true }),
  });

  const bucket = config.bucket;

  return {
    driver: "s3",

    async put(input: PutObjectInput): Promise<PutObjectResult> {
      const access = input.access ?? "public";
      const buf = toBuffer(input.body);

      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: input.key,
          Body: buf,
          ContentType: input.contentType,
          // Map access to S3 ACL. Adjust based on your bucket policy.
          ACL: access === "public" ? "public-read" : "private",
        }),
      );

      const url =
        access === "public"
          ? `https://${bucket}.s3.${config.region}.amazonaws.com/${input.key}`
          : input.key;

      return {
        url,
        key: input.key,
        bytes: byteLength(input.body),
        access,
      };
    },

    async delete(urlOrKey: string): Promise<void> {
      // Extract key from full URL if needed.
      const key = urlOrKey.startsWith("https://")
        ? new URL(urlOrKey).pathname.slice(1) // strip leading /
        : urlOrKey;

      try {
        await client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: key }),
        );
      } catch (err: unknown) {
        // S3 delete is idempotent by default (no error on missing key),
        // but handle edge cases gracefully.
        const code = (err as { name?: string })?.name;
        if (code === "NoSuchKey") return;
        throw err;
      }
    },

    async get(key: string): Promise<GetObjectResult> {
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );

        if (!response.Body) {
          throw new StorageNotFoundError(key);
        }

        // The AWS SDK v3 returns a Readable (Node.js stream). Convert to a
        // web ReadableStream for interface compliance.
        const webStream = response.Body.transformToWebStream() as ReadableStream<Uint8Array>;

        return {
          body: webStream,
          contentType: response.ContentType ?? null,
          sizeBytes: response.ContentLength ?? null,
        };
      } catch (err: unknown) {
        const code = (err as { name?: string })?.name;
        if (code === "NoSuchKey" || code === "NotFound") {
          throw new StorageNotFoundError(key);
        }
        throw err;
      }
    },
  };
}
```

---

## Testing

All storage driver tests follow the same pattern established in
`packages/storage/src/vercel-blob.test.ts`:

1. **Mock the vendor SDK at the module level** using `vi.mock()`.
2. **Create `vi.fn()` references** for each SDK method.
3. **Test each adapter method in isolation** -- `put`, `delete`, `get`.
4. **Reset mocks in `beforeEach`** to prevent test pollution.

### Example test structure

```typescript
// packages/storage/src/s3.test.ts

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the AWS SDK so tests run without credentials or network.
const sendMock = vi.fn();
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { send = sendMock; },
  PutObjectCommand: class { constructor(public input: unknown) {} },
  DeleteObjectCommand: class { constructor(public input: unknown) {} },
  GetObjectCommand: class { constructor(public input: unknown) {} },
}));

import { createS3Adapter } from "./s3";
import { StorageNotFoundError } from "./errors";

describe("createS3Adapter", () => {
  const config = {
    accessKeyId: "AKID",
    secretAccessKey: "SECRET",
    bucket: "my-bucket",
    region: "us-east-1",
  };

  beforeEach(() => {
    sendMock.mockReset();
  });

  it("reports the driver name", () => {
    expect(createS3Adapter(config).driver).toBe("s3");
  });

  it("put: writes an object and returns url + key + bytes", async () => {
    sendMock.mockResolvedValue({});
    const adapter = createS3Adapter(config);
    const body = new Uint8Array([1, 2, 3]);

    const result = await adapter.put({ key: "uploads/file.png", body, contentType: "image/png" });

    expect(result.url).toContain("uploads/file.png");
    expect(result.key).toBe("uploads/file.png");
    expect(result.bytes).toBe(3);
    expect(result.access).toBe("public");
  });

  it("delete: swallows NoSuchKey errors", async () => {
    sendMock.mockRejectedValue({ name: "NoSuchKey" });
    const adapter = createS3Adapter(config);

    // Should not throw
    await adapter.delete("missing/key.txt");
  });

  it("get: throws StorageNotFoundError for missing objects", async () => {
    sendMock.mockRejectedValue({ name: "NoSuchKey" });
    const adapter = createS3Adapter(config);

    await expect(adapter.get("missing/key.txt")).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it("get: returns a ReadableStream for existing objects", async () => {
    const mockStream = new ReadableStream<Uint8Array>();
    sendMock.mockResolvedValue({
      Body: { transformToWebStream: () => mockStream },
      ContentType: "image/png",
      ContentLength: 1024,
    });
    const adapter = createS3Adapter(config);

    const result = await adapter.get("uploads/file.png");

    expect(result.body).toBe(mockStream);
    expect(result.contentType).toBe("image/png");
    expect(result.sizeBytes).toBe(1024);
  });
});
```

### What to cover

- `driver` property returns the expected string.
- `put()` with `access: "public"` (default) and `access: "private"`.
- `put()` correctly computes `bytes` for all `StorageBody` variants.
- `delete()` is idempotent (missing key does not throw).
- `get()` returns the correct `GetObjectResult` shape.
- `get()` throws `StorageNotFoundError` when the key does not exist.
- Edge cases: empty body, null content-type, zero-size objects.

---

## Pre-Ship Checklist

Before merging a new storage driver:

- [ ] Driver file created at `packages/storage/src/<driver-name>.ts`
- [ ] Implements all three `StorageAdapter` methods (`put`, `delete`, `get`)
- [ ] `get()` throws `StorageNotFoundError` for missing keys (import from `./errors`)
- [ ] `delete()` is idempotent (no throw on missing keys)
- [ ] `put()` handles all `StorageBody` variants (`Blob`, `ArrayBuffer`, `Uint8Array`)
- [ ] `readonly driver` property set to a unique string identifier
- [ ] Driver name added to `STORAGE_DRIVER` enum in `packages/config/src/env.ts`
- [ ] Driver-specific env vars added to `packages/config/src/env.ts` as `.optional()`
- [ ] Switch case added to `resolveAdapter()` in `packages/storage/src/client.ts`
- [ ] Driver name added to `SUPPORTED_DRIVERS` tuple in `client.ts`
- [ ] Import for factory function added to `client.ts`
- [ ] Test file created at `packages/storage/src/<driver-name>.test.ts`
- [ ] All existing tests still pass: `pnpm --filter @oxagen/storage test:unit`
- [ ] Type check passes: `pnpm --filter @oxagen/storage typecheck`
- [ ] Coverage thresholds met: `pnpm --filter @oxagen/storage test:coverage`
- [ ] No ESLint warnings introduced

---

## Reference Files

| File | Purpose |
|------|---------|
| `packages/storage/src/types.ts` | `StorageAdapter` interface definition |
| `packages/storage/src/errors.ts` | `StorageNotFoundError` (shared across all drivers) |
| `packages/storage/src/vercel-blob.ts` | Reference implementation (Vercel Blob driver) |
| `packages/storage/src/vercel-blob.test.ts` | Reference test file with `vi.mock` pattern |
| `packages/storage/src/client.ts` | Driver resolution logic (`resolveAdapter()`) |
| `packages/config/src/env.ts` | Environment variable schema |
| `packages/storage/src/index.ts` | Public API barrel (re-exports) |
