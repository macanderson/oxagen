# Installable Plugins — Plan 2: Catalog Sync (registry client + Inngest sync + README render + catalog capabilities)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate `mcp.catalog_servers` from MCP registries (cursor-paginated incremental sync), render+sanitize server READMEs, and expose registry management + catalog browse/get over both the `/v1` API and MCP surfaces with parity.

**Architecture:** A typed registry OpenAPI client + pure mapping/derivation functions + a README render pipeline + a sync service all live in `@oxagen/plugins` (built in Plan 1). An Inngest cron syncs all enabled registries incrementally; an Inngest event handles on-demand single-registry/server refresh. Six capabilities (`plugin.registry.add|remove|list|sync`, `plugin.catalog.browse|get`) are declared as contracts in `@oxagen/oxagen`, handled in `@oxagen/handlers` (global/system-DB scope — the catalog is cross-tenant), and wired into `apps/api` routes + `apps/mcp` tools.

**Tech Stack:** TypeScript 6.0.3, Drizzle ORM 0.45.2, Zod 3.25.76, `inngest@3.54.2`, the `unified`/`remark-*`/`rehype-sanitize`/`rehype-stringify` markdown stack (already in the lockfile via `streamdown`), Vitest 2.1.9.

**Spec:** `docs/superpowers/specs/2026-06-06-installable-plugins-mcp-design.md` (§5 catalog sync, §8 capabilities)

**Builds on Plan 1 (shipped):** tables `mcp.registries` (`mcpRegistries`), `mcp.catalog_servers` (`mcpCatalogServers`) in `packages/database/src/schema/mcp.ts`; the default registry seeded in `0008_installable_plugins.sql` (`registry.modelcontextprotocol.io`, `org_id NULL`, `is_default_seed=true`); the `@oxagen/plugins` package.

---

## Grounded conventions (verified against the codebase)

- **Contract pattern** — `registerCapability({...})` from `@oxagen/oxagen` (`packages/oxagen/src/registry.ts`), shape in `packages/oxagen/src/types.ts`. Example: `packages/oxagen/src/contracts/workspace.create.ts`. Fields: `name, domain, description, mode, surfaces, layers, scoped, sensitivity, defaultEffect, defaultRoles, input (Zod), output (Zod)`.
- **API route** — `apps/api/src/routes/v1/<name>.ts`: `cap.input.parse(body)` → `invoke(cap.name, body, ctx, { surface: "api" })`. Example: `apps/api/src/routes/v1/workspace.create.ts`.
- **MCP tool** — `apps/mcp/src/tools/<name>.ts`: exports `schema` (Zod shape), `metadata` (ToolMetadata), default handler calling `invoke(cap.name, args, ctx, { surface: "mcp" })`. Example: `apps/mcp/src/tools/workspace.create.ts`.
- **Handler** — `packages/handlers/src/<name>.ts`, registered via `registerHandler("<name>", async () => (await import("./<name>")).handler)` in `packages/handlers/src/register.ts`.
- **DB seam** — `withSystemDb` / `withTenantDb` from `@oxagen/database`; `runInTenantScope` from `@oxagen/tenancy`. **Registries and catalog are global/cross-tenant** (the seed has `org_id NULL`; the catalog is shared across orgs), so the sync service and catalog reads use `withSystemDb`. `plugin.registry.add/remove/list` are org-scoped writes/reads but the registry table mixes global+org rows, so those handlers also use `withSystemDb` and filter by `orgId` explicitly. (Raw `db()` is ESLint-banned.)
- **Inngest** — client `inngest` from `packages/inngest-functions/src/inngest.ts`; typed events in the `Events` type (same file, ~lines 7–70); functions registered in the `functions` array in `packages/inngest-functions/src/functions.ts`; served at `apps/api/src/routes/inngest.ts`. Cron: `inngest.createFunction({ id, retries }, { cron: "..." }, handler)`. Event: `inngest.createFunction({ id, retries }, { event: "name" }, handler)`; dispatch via `inngest.send({ name, data })`.
- **Manifest parity** — `pnpm check:manifest` (warn-only) checks each capability's `layers` have matching files: `api`→`apps/api/src/routes/v1/<name>.ts`, `mcp`→`apps/mcp/src/tools/<name>.ts`, `unit`→`packages/oxagen/src/contracts/<name>.test.ts`. Run it after adding contracts.
- **Markdown** — use the `unified` pipeline (`remark-parse`→`remark-gfm`→`remark-rehype`→`rehype-sanitize`→`rehype-stringify`); all already resolved in the lockfile via `streamdown`, so declaring them as direct deps of `@oxagen/plugins` adds no new packages to the install graph.

---

## File Structure

**`@oxagen/plugins`** (`packages/plugins/`)
- Modify: `packages/plugins/package.json` — add `zod`, `@oxagen/database`, `@oxagen/tenancy`, and the `unified`/`remark-*`/`rehype-*` deps
- Create: `packages/plugins/src/registry/types.ts` — Zod schemas for `ServerDetail`, `ServerResponse`, list response
- Create: `packages/plugins/src/registry/registry-client.ts` — `listServers`, `getServerVersion`
- Create: `packages/plugins/src/registry/registry-client.test.ts`
- Create: `packages/plugins/src/registry/map-server.ts` — `deriveTransportTypes`, `deriveAuthKind`, `mapServerDetailToCatalogRow`
- Create: `packages/plugins/src/registry/map-server.test.ts`
- Create: `packages/plugins/src/registry/readme.ts` — `fetchAndRenderReadme`
- Create: `packages/plugins/src/registry/readme.test.ts`
- Create: `packages/plugins/src/registry/sync-service.ts` — `syncRegistry`
- Create: `packages/plugins/src/registry/sync-service.test.ts`
- Modify: `packages/plugins/src/index.ts` — export the registry surface

**Inngest** (`packages/inngest-functions/`)
- Modify: `packages/inngest-functions/src/inngest.ts` — add `plugin/registry.sync` to the `Events` type
- Create: `packages/inngest-functions/src/functions/plugin.catalog-sync-cron.ts`
- Create: `packages/inngest-functions/src/functions/plugin.registry-sync.ts`
- Modify: `packages/inngest-functions/src/functions.ts` — add both to the `functions` array

**Capabilities** (contracts → handlers → routes → tools → tests)
- Create per capability: `packages/oxagen/src/contracts/<name>.ts`, `packages/oxagen/src/contracts/<name>.test.ts`, `packages/handlers/src/<name>.ts`, `apps/api/src/routes/v1/<name>.ts`, `apps/mcp/src/tools/<name>.ts`
- Modify: `packages/handlers/src/register.ts` — register the 6 handlers
- Modify: `apps/api/src/routes/v1/index.ts` (or the route registrar) + `apps/mcp` tool index as the existing convention requires (VERIFY: check how `workspace.create` route/tool are registered and mirror it)

---

## Task 1: Add Plan 2 dependencies to `@oxagen/plugins`

**Files:**
- Modify: `packages/plugins/package.json`

- [ ] **Step 1: Add the runtime deps** (edit `dependencies` to read exactly):

```json
  "dependencies": {
    "@oxagen/crypto": "workspace:*",
    "@oxagen/database": "workspace:*",
    "@oxagen/tenancy": "workspace:*",
    "zod": "3.25.76",
    "unified": "11.0.5",
    "remark-parse": "11.0.0",
    "remark-gfm": "4.0.1",
    "remark-rehype": "11.1.2",
    "rehype-sanitize": "6.0.0",
    "rehype-stringify": "10.0.1"
  },
```

VERIFY the exact resolved versions against `pnpm-lock.yaml` before pinning (the Explore reported unified 11.0.5 / remark-parse 11.0.0 / remark-gfm 4.0.1 / remark-rehype 11.1.2 / rehype-sanitize 6.0.0; confirm `rehype-stringify`'s locked version and adjust). Use the one-latest-stable-version-workspace-wide rule: match whatever the lockfile already resolved.

- [ ] **Step 2: Install (deps change → no-frozen-lockfile)**

Run: `pnpm install --no-frozen-lockfile`
Expected: completes; no NEW packages downloaded for the unified/remark/rehype set (already in the graph via `streamdown`); `zod` re-added.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/package.json pnpm-lock.yaml
git commit -m "chore(plugins): add registry-sync deps (zod, db, tenancy, unified markdown stack)"
```

---

## Task 2: Registry OpenAPI client + Zod response types

**Files:**
- Create: `packages/plugins/src/registry/types.ts`
- Create: `packages/plugins/src/registry/registry-client.ts`
- Test: `packages/plugins/src/registry/registry-client.test.ts`

- [ ] **Step 1: Create `packages/plugins/src/registry/types.ts`**

```ts
import { z } from "zod";

/** A sized icon for UI rendering. */
export const iconSchema = z.object({
  src: z.string().url(),
  mimeType: z.string().optional(),
  sizes: z.array(z.string()).optional(),
  theme: z.enum(["light", "dark"]).optional(),
});

/** Source repository metadata. */
export const repositorySchema = z.object({
  url: z.string(),
  source: z.string(),
  id: z.string().optional(),
  subfolder: z.string().optional(),
});

/** A declared secret-bearing input (env var / header / remote variable). */
export const secretFlagSchema = z.object({
  isSecret: z.boolean().optional(),
  isRequired: z.boolean().optional(),
});

/** Local package install descriptor. */
export const packageSchema = z
  .object({
    registryType: z.string(),
    identifier: z.string(),
    version: z.string().optional(),
    transport: z.object({ type: z.string() }).passthrough().optional(),
    runtimeHint: z.string().optional(),
    environmentVariables: z
      .array(z.object({ name: z.string() }).merge(secretFlagSchema).passthrough())
      .optional(),
  })
  .passthrough();

/** Remote (hosted) transport descriptor. */
export const remoteSchema = z
  .object({
    type: z.string(),
    url: z.string(),
    headers: z
      .array(z.object({ name: z.string(), value: z.string().optional() }).merge(secretFlagSchema).passthrough())
      .optional(),
    variables: z.record(z.object({}).merge(secretFlagSchema).passthrough()).optional(),
  })
  .passthrough();

/** The publisher-authored server record. */
export const serverDetailSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    version: z.string(),
    title: z.string().optional(),
    repository: repositorySchema.optional(),
    websiteUrl: z.string().optional(),
    icons: z.array(iconSchema).optional(),
    packages: z.array(packageSchema).optional(),
    remotes: z.array(remoteSchema).optional(),
  })
  .passthrough();

/** Registry-managed metadata wrapper. */
export const serverMetaSchema = z
  .object({
    status: z.enum(["active", "deprecated", "deleted"]).optional(),
    statusMessage: z.string().optional(),
    statusChangedAt: z.string().optional(),
    publishedAt: z.string().optional(),
    updatedAt: z.string().optional(),
    isLatest: z.boolean().optional(),
  })
  .passthrough();

export const serverResponseSchema = z.object({
  server: serverDetailSchema,
  _meta: serverMetaSchema.optional(),
});

export const listServersResponseSchema = z.object({
  servers: z.array(serverResponseSchema),
  metadata: z.object({ nextCursor: z.string().optional(), count: z.number().optional() }).optional(),
});

export type Icon = z.infer<typeof iconSchema>;
export type Repository = z.infer<typeof repositorySchema>;
export type ServerDetail = z.infer<typeof serverDetailSchema>;
export type ServerMeta = z.infer<typeof serverMetaSchema>;
export type ServerResponse = z.infer<typeof serverResponseSchema>;
export type ListServersResponse = z.infer<typeof listServersResponseSchema>;
```

- [ ] **Step 2: Write the failing test** `packages/plugins/src/registry/registry-client.test.ts`

```ts
import { describe, expect, it, vi, afterEach } from "vitest";
import { listServers, getServerVersion } from "./registry-client";

const BASE = "https://registry.example.com";

function mockFetchOnce(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })) as unknown as typeof fetch,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("registry-client", () => {
  it("lists servers and returns the next cursor", async () => {
    mockFetchOnce({
      servers: [{ server: { name: "io.x/a", description: "d", version: "1.0.0" }, _meta: { isLatest: true } }],
      metadata: { nextCursor: "cur-2", count: 1 },
    });
    const res = await listServers(BASE, { limit: 50 });
    expect(res.servers).toHaveLength(1);
    expect(res.servers[0].server.name).toBe("io.x/a");
    expect(res.nextCursor).toBe("cur-2");
  });

  it("passes cursor/search/updatedSince as query params", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ servers: [] }), text: async () => "{}" }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    await listServers(BASE, { cursor: "c1", search: "git", updatedSince: "2026-01-01T00:00:00Z" });
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain("cursor=c1");
    expect(calledUrl).toContain("search=git");
    expect(calledUrl).toContain("updated_since=2026-01-01");
  });

  it("throws on a non-ok response", async () => {
    mockFetchOnce({ error: "boom" }, false);
    await expect(listServers(BASE, {})).rejects.toThrow(/registry list failed/i);
  });

  it("fetches a single server version", async () => {
    mockFetchOnce({ server: { name: "io.x/a", description: "d", version: "2.0.0" }, _meta: { isLatest: true } });
    const res = await getServerVersion(BASE, "io.x/a", "latest");
    expect(res.server.version).toBe("2.0.0");
  });
});
```

- [ ] **Step 2b: Run it to verify it fails**

Run: `pnpm --filter @oxagen/plugins test:unit -- registry-client`
Expected: FAIL — "Cannot find module './registry-client'".

- [ ] **Step 3: Create `packages/plugins/src/registry/registry-client.ts`**

```ts
/**
 * Typed client for the MCP Registry OpenAPI (https://registry.modelcontextprotocol.io).
 * Discovery endpoints are unauthenticated; responses are Zod-validated. Cursor
 * pagination: follow metadata.nextCursor until absent.
 */
import {
  listServersResponseSchema,
  serverResponseSchema,
  type ServerResponse,
} from "./types";

export interface ListServersOptions {
  cursor?: string;
  limit?: number;
  search?: string;
  /** RFC3339 timestamp — incremental sync filter. */
  updatedSince?: string;
}

export interface ListServersResult {
  servers: ServerResponse[];
  nextCursor: string | undefined;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export async function listServers(
  baseUrl: string,
  opts: ListServersOptions,
): Promise<ListServersResult> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.search) params.set("search", opts.search);
  if (opts.updatedSince) params.set("updated_since", opts.updatedSince);
  const qs = params.toString();
  const url = joinUrl(baseUrl, `/v0.1/servers${qs ? `?${qs}` : ""}`);

  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`registry list failed: ${res.status} ${await res.text()}`);
  }
  const parsed = listServersResponseSchema.parse(await res.json());
  return { servers: parsed.servers, nextCursor: parsed.metadata?.nextCursor };
}

export async function getServerVersion(
  baseUrl: string,
  name: string,
  version: string,
): Promise<ServerResponse> {
  const url = joinUrl(
    baseUrl,
    `/v0.1/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
  );
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`registry get failed: ${res.status} ${await res.text()}`);
  }
  return serverResponseSchema.parse(await res.json());
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @oxagen/plugins test:unit -- registry-client`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/src/registry/types.ts packages/plugins/src/registry/registry-client.ts packages/plugins/src/registry/registry-client.test.ts
git commit -m "feat(plugins): MCP registry OpenAPI client + Zod response types"
```

---

## Task 3: Mapping + derivation pure functions

**Files:**
- Create: `packages/plugins/src/registry/map-server.ts`
- Test: `packages/plugins/src/registry/map-server.test.ts`

- [ ] **Step 1: Write the failing test** `packages/plugins/src/registry/map-server.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { deriveTransportTypes, deriveAuthKind, mapServerDetailToCatalogRow } from "./map-server";
import type { ServerDetail, ServerMeta } from "./types";

const REGISTRY_ID = "11111111-1111-1111-1111-111111111111";

describe("deriveTransportTypes", () => {
  it("collects distinct transport types from packages + remotes", () => {
    const sd: ServerDetail = {
      name: "io.x/a", description: "d", version: "1.0.0",
      packages: [{ registryType: "npm", identifier: "a", transport: { type: "stdio" } }],
      remotes: [{ type: "streamable-http", url: "https://x" }, { type: "sse", url: "https://y" }],
    };
    expect(deriveTransportTypes(sd).sort()).toEqual(["sse", "stdio", "streamable-http"]);
  });
});

describe("deriveAuthKind", () => {
  it("returns 'none' when nothing is secret", () => {
    const sd: ServerDetail = { name: "io.x/a", description: "d", version: "1.0.0", remotes: [{ type: "sse", url: "https://x" }] };
    expect(deriveAuthKind(sd)).toBe("none");
  });
  it("returns 'secret' when a remote variable is secret", () => {
    const sd: ServerDetail = {
      name: "io.x/a", description: "d", version: "1.0.0",
      remotes: [{ type: "streamable-http", url: "https://x", variables: { API_KEY: { isSecret: true } } }],
    };
    expect(deriveAuthKind(sd)).toBe("secret");
  });
  it("returns 'secret' when a package env var is secret", () => {
    const sd: ServerDetail = {
      name: "io.x/a", description: "d", version: "1.0.0",
      packages: [{ registryType: "npm", identifier: "a", transport: { type: "stdio" }, environmentVariables: [{ name: "TOKEN", isSecret: true }] }],
    };
    expect(deriveAuthKind(sd)).toBe("secret");
  });
});

describe("mapServerDetailToCatalogRow", () => {
  it("maps a ServerDetail + meta into catalog columns", () => {
    const sd: ServerDetail = {
      name: "io.x/weather", description: "Weather", version: "1.2.3", title: "Weather",
      repository: { url: "https://github.com/x/weather", source: "github" },
      icons: [{ src: "https://x/i.png" }],
      remotes: [{ type: "streamable-http", url: "https://api/mcp", variables: { K: { isSecret: true } } }],
    };
    const meta: ServerMeta = { status: "active", isLatest: true, publishedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" };
    const row = mapServerDetailToCatalogRow(sd, meta, REGISTRY_ID);
    expect(row.registryId).toBe(REGISTRY_ID);
    expect(row.name).toBe("io.x/weather");
    expect(row.version).toBe("1.2.3");
    expect(row.isLatest).toBe(true);
    expect(row.status).toBe("active");
    expect(row.authKind).toBe("secret");
    expect(row.transportTypes).toEqual(["streamable-http"]);
    expect(row.upstreamUpdatedAt).toBeInstanceOf(Date);
  });
  it("defaults status to active and isLatest to false when meta is absent", () => {
    const sd: ServerDetail = { name: "io.x/a", description: "d", version: "1.0.0" };
    const row = mapServerDetailToCatalogRow(sd, undefined, REGISTRY_ID);
    expect(row.status).toBe("active");
    expect(row.isLatest).toBe(false);
    expect(row.authKind).toBe("none");
  });
});
```

- [ ] **Step 1b: Run it to verify it fails**

Run: `pnpm --filter @oxagen/plugins test:unit -- map-server`
Expected: FAIL — "Cannot find module './map-server'".

- [ ] **Step 2: Create `packages/plugins/src/registry/map-server.ts`**

```ts
/**
 * Pure mapping/derivation from a registry ServerDetail to a mcp.catalog_servers
 * row. auth_kind is a heuristic: 'secret' if ANY env-var/header/remote-variable
 * is flagged isSecret, else 'none'. (Real OAuth detection happens at connect
 * time in Plan 4; the registry record does not declare OAuth explicitly.)
 */
import type { ServerDetail, ServerMeta } from "./types";

export type AuthKind = "oauth" | "secret" | "none";

export function deriveTransportTypes(sd: ServerDetail): string[] {
  const set = new Set<string>();
  for (const p of sd.packages ?? []) {
    if (p.transport?.type) set.add(p.transport.type);
  }
  for (const r of sd.remotes ?? []) {
    if (r.type) set.add(r.type);
  }
  return [...set];
}

export function deriveAuthKind(sd: ServerDetail): AuthKind {
  const anySecret =
    (sd.packages ?? []).some((p) => (p.environmentVariables ?? []).some((e) => e.isSecret === true)) ||
    (sd.remotes ?? []).some(
      (r) =>
        (r.headers ?? []).some((h) => h.isSecret === true) ||
        Object.values(r.variables ?? {}).some((v) => v.isSecret === true),
    );
  return anySecret ? "secret" : "none";
}

function toDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Column values for an upsert into mcp.catalog_servers (excludes id/audit). */
export interface CatalogRowInput {
  registryId: string;
  name: string;
  version: string;
  isLatest: boolean;
  title: string | null;
  description: string;
  repository: ServerDetail["repository"] | null;
  websiteUrl: string | null;
  icons: NonNullable<ServerDetail["icons"]>;
  packages: NonNullable<ServerDetail["packages"]>;
  remotes: NonNullable<ServerDetail["remotes"]>;
  transportTypes: string[];
  authKind: AuthKind;
  status: string;
  publishedAt: Date | null;
  upstreamUpdatedAt: Date | null;
  statusChangedAt: Date | null;
  meta: Record<string, unknown>;
}

export function mapServerDetailToCatalogRow(
  sd: ServerDetail,
  meta: ServerMeta | undefined,
  registryId: string,
): CatalogRowInput {
  return {
    registryId,
    name: sd.name,
    version: sd.version,
    isLatest: meta?.isLatest ?? false,
    title: sd.title ?? null,
    description: sd.description,
    repository: sd.repository ?? null,
    websiteUrl: sd.websiteUrl ?? null,
    icons: sd.icons ?? [],
    packages: sd.packages ?? [],
    remotes: sd.remotes ?? [],
    transportTypes: deriveTransportTypes(sd),
    authKind: deriveAuthKind(sd),
    status: meta?.status ?? "active",
    publishedAt: toDate(meta?.publishedAt),
    upstreamUpdatedAt: toDate(meta?.updatedAt),
    statusChangedAt: toDate(meta?.statusChangedAt),
    meta: (meta ?? {}) as Record<string, unknown>,
  };
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `pnpm --filter @oxagen/plugins test:unit -- map-server`
Expected: PASS (6 tests).

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/src/registry/map-server.ts packages/plugins/src/registry/map-server.test.ts
git commit -m "feat(plugins): registry server-detail mapping + transport/auth derivation"
```

---
