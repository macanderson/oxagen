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

## Task 4: README fetch + render + sanitize

**Files:**
- Create: `packages/plugins/src/registry/readme.ts`
- Test: `packages/plugins/src/registry/readme.test.ts`

- [ ] **Step 1: Write the failing test** `packages/plugins/src/registry/readme.test.ts`

```ts
import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchAndRenderReadme } from "./readme";

afterEach(() => vi.unstubAllGlobals());

function stubReadme(md: string, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, status: ok ? 200 : 404, text: async () => md })) as unknown as typeof fetch,
  );
}

describe("fetchAndRenderReadme", () => {
  it("renders markdown to sanitized HTML", async () => {
    stubReadme("# Hello\n\nSome **bold** text.");
    const html = await fetchAndRenderReadme({ url: "https://github.com/x/repo", source: "github" });
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("strips script tags", async () => {
    stubReadme("ok\n\n<script>alert(1)</script>");
    const html = await fetchAndRenderReadme({ url: "https://github.com/x/repo", source: "github" });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(1)");
  });

  it("rewrites relative image src to the repo raw base", async () => {
    stubReadme("![logo](docs/logo.png)");
    const html = await fetchAndRenderReadme({ url: "https://github.com/x/repo", source: "github" });
    expect(html).toContain("https://raw.githubusercontent.com/x/repo/HEAD/docs/logo.png");
  });

  it("returns null for a non-github repository", async () => {
    const html = await fetchAndRenderReadme({ url: "https://gitlab.com/x/repo", source: "gitlab" });
    expect(html).toBeNull();
  });

  it("returns null when the README fetch fails", async () => {
    stubReadme("nope", false);
    const html = await fetchAndRenderReadme({ url: "https://github.com/x/repo", source: "github" });
    expect(html).toBeNull();
  });
});
```

- [ ] **Step 1b: Run it to verify it fails**

Run: `pnpm --filter @oxagen/plugins test:unit -- readme`
Expected: FAIL — "Cannot find module './readme'".

- [ ] **Step 2: Create `packages/plugins/src/registry/readme.ts`**

```ts
/**
 * Fetch a server's README from its source repo and render it to sanitized HTML.
 * Server-side (Node, no DOM) via the unified pipeline. Only GitHub repos are
 * supported for now (raw.githubusercontent.com); other sources return null.
 * Relative image sources are rewritten to the repo raw base so they resolve.
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import type { Repository } from "./types";

interface GithubRef {
  owner: string;
  repo: string;
  subfolder: string;
}

/** Parse https://github.com/<owner>/<repo>[.git] into owner/repo. */
function parseGithub(repository: Repository): GithubRef | null {
  if (repository.source !== "github") return null;
  const m = repository.url.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/, "");
  const subfolder = (repository.subfolder ?? "").replace(/^\/+|\/+$/g, "");
  return { owner, repo, subfolder };
}

function rawBase(ref: GithubRef): string {
  const sub = ref.subfolder ? `${ref.subfolder}/` : "";
  return `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/HEAD/${sub}`;
}

/** Minimal rehype plugin: rewrite relative <img src> to absolute raw URLs. */
function rehypeRewriteImages(base: string) {
  return (tree: unknown) => {
    const visit = (node: { tagName?: string; properties?: Record<string, unknown>; children?: unknown[] }) => {
      if (node.tagName === "img" && node.properties && typeof node.properties.src === "string") {
        const src = node.properties.src;
        if (!/^https?:\/\//i.test(src) && !src.startsWith("data:")) {
          node.properties.src = base + src.replace(/^\.?\//, "");
        }
      }
      for (const child of node.children ?? []) visit(child as typeof node);
    };
    visit(tree as { children?: unknown[] });
  };
}

const TTL_MS = 24 * 60 * 60 * 1000;

/** True when a cached README is still fresh and should not be refetched. */
export function isReadmeFresh(fetchedAt: Date | null, now: number): boolean {
  return fetchedAt != null && now - fetchedAt.getTime() < TTL_MS;
}

export async function fetchAndRenderReadme(repository: Repository): Promise<string | null> {
  const ref = parseGithub(repository);
  if (!ref) return null;

  const base = rawBase(ref);
  const candidates = ["README.md", "readme.md", "README.markdown"];
  let markdown: string | null = null;
  for (const file of candidates) {
    const res = await fetch(`${base}${file}`, { headers: { accept: "text/plain" } });
    if (res.ok) {
      markdown = await res.text();
      break;
    }
  }
  if (markdown == null) return null;

  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeRewriteImages, base)
    .use(rehypeSanitize)
    .use(rehypeStringify)
    .process(markdown);
  return String(file);
}
```

> Note: `rehypeRewriteImages` runs BEFORE `rehypeSanitize` so the rewritten `src` survives sanitization (sanitize allows `img[src]` with http(s) URLs by default).

- [ ] **Step 3: Run the test to verify it passes**

Run: `pnpm --filter @oxagen/plugins test:unit -- readme`
Expected: PASS (5 tests).

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/src/registry/readme.ts packages/plugins/src/registry/readme.test.ts
git commit -m "feat(plugins): README fetch + sanitized HTML render with relative-image rewrite"
```

---

## Task 5: Sync service (dependency-injected, unit-testable)

**Files:**
- Create: `packages/plugins/src/registry/sync-service.ts`
- Test: `packages/plugins/src/registry/sync-service.test.ts`

The service is written against a `SyncPersistence` port so the upsert / is_latest / checkpoint logic is unit-tested with a fake; the default port is backed by `withSystemDb` (the catalog is cross-tenant).

- [ ] **Step 1: Write the failing test** `packages/plugins/src/registry/sync-service.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { syncRegistry, type SyncPersistence, type SyncDeps } from "./sync-service";
import type { ServerResponse } from "./types";

const REG = { id: "reg-1", baseUrl: "https://r", lastSyncedAt: null as Date | null };

function resp(name: string, version: string, isLatest: boolean): ServerResponse {
  return { server: { name, description: "d", version }, _meta: { isLatest, status: "active" } };
}

function fakePersistence() {
  const upserts: Array<{ name: string; version: string; isLatest: boolean }> = [];
  const markedNotLatest: string[] = [];
  let checkpoint: { cursor: string | undefined; at: Date } | null = null;
  const p: SyncPersistence = {
    getRegistry: async () => REG,
    markOthersNotLatest: async (_regId, name) => { markedNotLatest.push(name); },
    upsertCatalogRow: async (row) => { upserts.push({ name: row.name, version: row.version, isLatest: row.isLatest }); return "cat-" + row.name; },
    getReadmeFreshness: async () => null,
    setReadme: async () => {},
    updateCheckpoint: async (_regId, cursor, at) => { checkpoint = { cursor, at }; },
  };
  return { p, upserts, markedNotLatest, get checkpoint() { return checkpoint; } };
}

describe("syncRegistry", () => {
  it("paginates until nextCursor is absent and upserts every server", async () => {
    const f = fakePersistence();
    const pages = [
      { servers: [resp("io.x/a", "1.0.0", true)], nextCursor: "c2" },
      { servers: [resp("io.x/b", "2.0.0", true)], nextCursor: undefined },
    ];
    let call = 0;
    const deps: SyncDeps = {
      listServers: vi.fn(async () => pages[call++]),
      fetchAndRenderReadme: vi.fn(async () => "<p>x</p>"),
      now: () => 1_000,
    };
    const result = await syncRegistry("reg-1", { mode: "full" }, f.p, deps);
    expect(result.upserted).toBe(2);
    expect(f.upserts.map((u) => u.name)).toEqual(["io.x/a", "io.x/b"]);
    expect(deps.listServers).toHaveBeenCalledTimes(2);
  });

  it("marks prior latest false before upserting a new latest version", async () => {
    const f = fakePersistence();
    const deps: SyncDeps = {
      listServers: vi.fn(async () => ({ servers: [resp("io.x/a", "3.0.0", true)], nextCursor: undefined })),
      fetchAndRenderReadme: vi.fn(async () => null),
      now: () => 1_000,
    };
    await syncRegistry("reg-1", { mode: "incremental" }, f.p, deps);
    expect(f.markedNotLatest).toContain("io.x/a");
  });

  it("passes updated_since on incremental sync when lastSyncedAt is set", async () => {
    const f = fakePersistence();
    f.p.getRegistry = async () => ({ ...REG, lastSyncedAt: new Date("2026-01-01T00:00:00Z") });
    const listServers = vi.fn(async () => ({ servers: [], nextCursor: undefined }));
    await syncRegistry("reg-1", { mode: "incremental" }, f.p, { listServers, fetchAndRenderReadme: vi.fn(), now: () => 1 });
    expect(listServers.mock.calls[0][1].updatedSince).toBe("2026-01-01T00:00:00.000Z");
  });

  it("checkpoints after the run", async () => {
    const f = fakePersistence();
    const deps: SyncDeps = {
      listServers: vi.fn(async () => ({ servers: [], nextCursor: undefined })),
      fetchAndRenderReadme: vi.fn(),
      now: () => 42,
    };
    await syncRegistry("reg-1", { mode: "full" }, f.p, deps);
    expect(f.checkpoint).not.toBeNull();
    expect(f.checkpoint!.at).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 1b: Run it to verify it fails**

Run: `pnpm --filter @oxagen/plugins test:unit -- sync-service`
Expected: FAIL — "Cannot find module './sync-service'".

- [ ] **Step 2: Create `packages/plugins/src/registry/sync-service.ts`**

```ts
/**
 * Registry → catalog sync. Paginates a registry (cursor), upserts each server
 * version into mcp.catalog_servers (maintaining is_latest), refreshes READMEs
 * respecting a 24h TTL, and checkpoints last_synced_cursor/last_synced_at.
 *
 * Written against a SyncPersistence port for offline unit testing; the default
 * port (createSystemSyncPersistence) is backed by withSystemDb — the catalog is
 * cross-tenant shared state, not org-scoped.
 */
import { listServers as defaultListServers, type ListServersResult } from "./registry-client";
import { fetchAndRenderReadme as defaultRenderReadme, isReadmeFresh } from "./readme";
import { mapServerDetailToCatalogRow, type CatalogRowInput } from "./map-server";

export interface SyncRegistryRow {
  id: string;
  baseUrl: string;
  lastSyncedAt: Date | null;
}

/** Persistence port — the only DB surface the sync logic touches. */
export interface SyncPersistence {
  getRegistry(registryId: string): Promise<SyncRegistryRow | null>;
  markOthersNotLatest(registryId: string, name: string): Promise<void>;
  /** Upsert by (registry_id, name, version); returns the catalog row id. */
  upsertCatalogRow(row: CatalogRowInput): Promise<string>;
  getReadmeFreshness(catalogId: string): Promise<Date | null>;
  setReadme(catalogId: string, html: string | null, fetchedAt: Date): Promise<void>;
  updateCheckpoint(registryId: string, cursor: string | undefined, at: Date): Promise<void>;
}

export interface SyncDeps {
  listServers: (baseUrl: string, opts: { cursor?: string; limit?: number; updatedSince?: string }) => Promise<ListServersResult>;
  fetchAndRenderReadme: typeof defaultRenderReadme;
  now: () => number;
}

export interface SyncResult {
  upserted: number;
  readmesRefreshed: number;
}

const PAGE_LIMIT = 100;

export async function syncRegistry(
  registryId: string,
  opts: { mode: "full" | "incremental" },
  persistence: SyncPersistence,
  deps: SyncDeps = { listServers: defaultListServers, fetchAndRenderReadme: defaultRenderReadme, now: () => Date.now() },
): Promise<SyncResult> {
  const registry = await persistence.getRegistry(registryId);
  if (!registry) throw new Error(`registry not found: ${registryId}`);

  const updatedSince =
    opts.mode === "incremental" && registry.lastSyncedAt
      ? registry.lastSyncedAt.toISOString()
      : undefined;

  let cursor: string | undefined;
  let lastCursor: string | undefined;
  let upserted = 0;
  let readmesRefreshed = 0;

  do {
    const page = await deps.listServers(registry.baseUrl, { cursor, limit: PAGE_LIMIT, updatedSince });
    for (const entry of page.servers) {
      const row = mapServerDetailToCatalogRow(entry.server, entry._meta, registryId);
      if (row.isLatest) {
        await persistence.markOthersNotLatest(registryId, row.name);
      }
      const catalogId = await persistence.upsertCatalogRow(row);

      if (row.repository) {
        const freshness = await persistence.getReadmeFreshness(catalogId);
        if (!isReadmeFresh(freshness, deps.now())) {
          const html = await deps.fetchAndRenderReadme(row.repository);
          await persistence.setReadme(catalogId, html, new Date(deps.now()));
          if (html) readmesRefreshed += 1;
        }
      }
      upserted += 1;
    }
    lastCursor = page.nextCursor;
    cursor = page.nextCursor;
  } while (cursor);

  await persistence.updateCheckpoint(registryId, lastCursor, new Date(deps.now()));
  return { upserted, readmesRefreshed };
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `pnpm --filter @oxagen/plugins test:unit -- sync-service`
Expected: PASS (4 tests).

- [ ] **Step 4: Create the system-DB persistence adapter** — append to `sync-service.ts`:

```ts
import { schema, withSystemDb } from "@oxagen/database";
import { and, eq, ne } from "drizzle-orm";

/** Default persistence port backed by withSystemDb (cross-tenant catalog). */
export function createSystemSyncPersistence(): SyncPersistence {
  return {
    async getRegistry(registryId) {
      return withSystemDb(async (tx) => {
        const [r] = await tx
          .select({ id: schema.mcpRegistries.id, baseUrl: schema.mcpRegistries.baseUrl, lastSyncedAt: schema.mcpRegistries.lastSyncedAt })
          .from(schema.mcpRegistries)
          .where(eq(schema.mcpRegistries.id, registryId))
          .limit(1);
        return r ?? null;
      });
    },
    async markOthersNotLatest(registryId, name) {
      await withSystemDb(async (tx) => {
        await tx
          .update(schema.mcpCatalogServers)
          .set({ isLatest: false })
          .where(and(eq(schema.mcpCatalogServers.registryId, registryId), eq(schema.mcpCatalogServers.name, name)));
      });
    },
    async upsertCatalogRow(row) {
      return withSystemDb(async (tx) => {
        const [inserted] = await tx
          .insert(schema.mcpCatalogServers)
          .values(row)
          .onConflictDoUpdate({
            target: [schema.mcpCatalogServers.registryId, schema.mcpCatalogServers.name, schema.mcpCatalogServers.version],
            set: {
              isLatest: row.isLatest, title: row.title, description: row.description, repository: row.repository,
              websiteUrl: row.websiteUrl, icons: row.icons, packages: row.packages, remotes: row.remotes,
              transportTypes: row.transportTypes, authKind: row.authKind, status: row.status,
              publishedAt: row.publishedAt, upstreamUpdatedAt: row.upstreamUpdatedAt, statusChangedAt: row.statusChangedAt,
              meta: row.meta, updatedAt: new Date(),
            },
          })
          .returning({ id: schema.mcpCatalogServers.id });
        return inserted.id;
      });
    },
    async getReadmeFreshness(catalogId) {
      return withSystemDb(async (tx) => {
        const [r] = await tx
          .select({ fetchedAt: schema.mcpCatalogServers.readmeFetchedAt })
          .from(schema.mcpCatalogServers)
          .where(eq(schema.mcpCatalogServers.id, catalogId))
          .limit(1);
        return r?.fetchedAt ?? null;
      });
    },
    async setReadme(catalogId, html, fetchedAt) {
      await withSystemDb(async (tx) => {
        await tx.update(schema.mcpCatalogServers).set({ readmeHtml: html, readmeFetchedAt: fetchedAt }).where(eq(schema.mcpCatalogServers.id, catalogId));
      });
    },
    async updateCheckpoint(registryId, cursor, at) {
      await withSystemDb(async (tx) => {
        await tx.update(schema.mcpRegistries).set({ lastSyncedCursor: cursor ?? null, lastSyncedAt: at }).where(eq(schema.mcpRegistries.id, registryId));
      });
    },
  };
}
```

VERIFY: `ne` import is unused if not referenced — remove it if eslint flags `no-unused-vars`. Confirm `onConflictDoUpdate` target column references match the Drizzle `uniqueIndex` (`catalog_servers_name_version_uniq` on registryId,name,version).

- [ ] **Step 5: Typecheck + re-run sync tests**

Run: `pnpm --filter @oxagen/plugins typecheck && pnpm --filter @oxagen/plugins test:unit -- sync-service`
Expected: typecheck PASS; 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/src/registry/sync-service.ts packages/plugins/src/registry/sync-service.test.ts
git commit -m "feat(plugins): registry catalog sync service (DI port + system-db adapter)"
```

---

## Task 6: Inngest sync jobs (cron + on-demand event)

**Files:**
- Modify: `packages/inngest-functions/src/inngest.ts` — add the `plugin/registry.sync` event to the `Events` type
- Create: `packages/inngest-functions/src/functions/plugin.catalog-sync-cron.ts`
- Create: `packages/inngest-functions/src/functions/plugin.registry-sync.ts`
- Modify: `packages/inngest-functions/src/functions.ts` — register both

- [ ] **Step 1: Add the event to the `Events` type** in `packages/inngest-functions/src/inngest.ts`

Inside the `Events` type (alongside the existing events), add:

```ts
  "plugin/registry.sync": { data: { registryId: string; mode: "full" | "incremental" } };
```

VERIFY the exact shape of the `Events` type (object-of-records vs interface) by reading the file, and match the existing entries' formatting.

- [ ] **Step 2: Create the cron function** `packages/inngest-functions/src/functions/plugin.catalog-sync-cron.ts`

```ts
/**
 * Hourly-ish incremental catalog sync across all enabled registries. Each
 * registry is synced in its own step so one failure doesn't abort the rest.
 */
import { eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { syncRegistry, createSystemSyncPersistence } from "@oxagen/plugins";
import { inngest } from "../inngest";

export const pluginCatalogSyncCron = inngest.createFunction(
  { id: "plugin.catalog-sync-cron", retries: 2 },
  { cron: "0 */6 * * *" },
  async ({ step }) => {
    const registries = await step.run("load-enabled-registries", () =>
      withSystemDb((tx) =>
        tx
          .select({ id: schema.mcpRegistries.id })
          .from(schema.mcpRegistries)
          .where(eq(schema.mcpRegistries.enabled, true)),
      ),
    );

    const persistence = createSystemSyncPersistence();
    let total = 0;
    for (const r of registries) {
      const result = await step.run(`sync-${r.id}`, () =>
        syncRegistry(r.id, { mode: "incremental" }, persistence),
      );
      total += result.upserted;
    }
    return { registries: registries.length, upserted: total };
  },
);
```

- [ ] **Step 3: Create the on-demand event function** `packages/inngest-functions/src/functions/plugin.registry-sync.ts`

```ts
/** On-demand sync of a single registry (dispatched by plugin.registry.sync). */
import { syncRegistry, createSystemSyncPersistence } from "@oxagen/plugins";
import { inngest } from "../inngest";

export const pluginRegistrySync = inngest.createFunction(
  { id: "plugin.registry-sync", retries: 2 },
  { event: "plugin/registry.sync" },
  async ({ event, step }) => {
    const { registryId, mode } = event.data;
    const persistence = createSystemSyncPersistence();
    return step.run("sync", () => syncRegistry(registryId, { mode }, persistence));
  },
);
```

- [ ] **Step 4: Register both** in `packages/inngest-functions/src/functions.ts`

Import them and add to the `functions` array:

```ts
import { pluginCatalogSyncCron } from "./functions/plugin.catalog-sync-cron";
import { pluginRegistrySync } from "./functions/plugin.registry-sync";
```
…and add `pluginCatalogSyncCron, pluginRegistrySync` to the `export const functions = [...]` array.

VERIFY: `@oxagen/plugins` must be a dependency of `packages/inngest-functions` — add `"@oxagen/plugins": "workspace:*"` to `packages/inngest-functions/package.json` dependencies and `pnpm install --no-frozen-lockfile` if missing.

- [ ] **Step 5: Typecheck inngest-functions**

Run: `pnpm --filter @oxagen/inngest-functions typecheck`
Expected: PASS. (If it fails on the missing `@oxagen/plugins` dep, add it per Step 4's VERIFY note and re-run.)

- [ ] **Step 6: Commit**

```bash
git add packages/inngest-functions/src/inngest.ts packages/inngest-functions/src/functions/plugin.catalog-sync-cron.ts packages/inngest-functions/src/functions/plugin.registry-sync.ts packages/inngest-functions/src/functions.ts packages/inngest-functions/package.json pnpm-lock.yaml
git commit -m "feat(inngest): catalog sync cron + on-demand registry sync event"
```

---

## Task 7: Capabilities — registry management + catalog browse/get (API ⇄ MCP parity)

Six capabilities. Each follows the **same four-file wiring** (contract → handler → api route → mcp tool) plus a contract unit test. Below: (a) the shared wiring template stated once, (b) all six contracts in full, (c) all six handler bodies in full, (d) `plugin.catalog.browse` fully instantiated as the reference, (e) registration + manifest steps.

> All capabilities are **org-scoped, not workspace-scoped** (`scoped: false`), `mode: "sync"`, `surfaces: ["api","mcp"]`, `layers: ["api","mcp","unit"]`. Management writes (`registry.add/remove/sync`) use `defaultRoles: { org: { Owner: "allow", Admin: "allow" } }`, `defaultEffect: "deny"`. Reads (`registry.list`, `catalog.browse`, `catalog.get`) use the same roles for now (Plan 3 refines who can browse vs. manage). `sensitivity`: `registry.add`=medium, `registry.remove`=medium (destructive set true on remove), `registry.sync`=low, reads=low.

### (a) Shared wiring template

**API route** — `apps/api/src/routes/v1/<cap-name>.ts` (mirror `apps/api/src/routes/v1/workspace.create.ts` EXACTLY for ctx construction + Hono registration):

```ts
import { <camelName> } from "@oxagen/oxagen/contracts/<cap-name>";
import { invoke } from "@oxagen/oxagen/kernel";
// VERIFY: copy the exact router/ctx-builder imports + export style from
// apps/api/src/routes/v1/workspace.create.ts (it builds `ctx` from the request).
// Then:
//   const body = <camelName>.input.parse(await c.req.json());
//   const out = await invoke(<camelName>.name, body, ctx, { surface: "api" });
//   return c.json(out);
```

**MCP tool** — `apps/mcp/src/tools/<cap-name>.ts` (mirror `apps/mcp/src/tools/workspace.create.ts` EXACTLY):

```ts
import { headers } from "...";            // VERIFY: same import workspace.create uses
import { buildContext } from "...";       // VERIFY: same
import { invoke } from "@oxagen/oxagen/kernel";
import { <camelName> } from "@oxagen/oxagen/contracts/<cap-name>";
import type { ToolMetadata } from "xmcp";

export const schema = { ...<camelName>.input.shape };
export const metadata: ToolMetadata = { name: <camelName>.name, description: <camelName>.description };
export default async function tool(args: unknown) {
  const ctx = await buildContext(headers());
  const out = await invoke(<camelName>.name, args, ctx, { surface: "mcp" });
  return <camelName>.output.parse(out);
}
```

**Handler** — `packages/handlers/src/<cap-name>.ts` exporting `export const handler: CapabilityHandlerFn = async (input, ctx) => {...}` (VERIFY the `CapabilityHandlerFn` signature + how `ctx.orgId` is exposed by reading an existing handler, e.g. `packages/handlers/src/chat.message.send.ts`).

**Registration** — add to `packages/handlers/src/register.ts`:
```ts
registerHandler("<cap-name>", async () => (await import("./<cap-name>")).handler);
```

### (b) The six contracts (create each `packages/oxagen/src/contracts/<name>.ts`)

- [ ] **plugin.registry.list** — `packages/oxagen/src/contracts/plugin.registry.list.ts`

```ts
import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginRegistryList = registerCapability({
  name: "plugin.registry.list",
  domain: "plugin",
  description: "List MCP registries available to the org (global default seed + org-added).",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({}),
  output: z.object({
    registries: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        baseUrl: z.string(),
        enabled: z.boolean(),
        isDefaultSeed: z.boolean(),
        lastSyncedAt: z.string().nullable(),
      }),
    ),
  }),
});
```

- [ ] **plugin.registry.add** — `packages/oxagen/src/contracts/plugin.registry.add.ts`

```ts
import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginRegistryAdd = registerCapability({
  name: "plugin.registry.add",
  domain: "plugin",
  description: "Add an MCP registry source for the org (any registry implementing the MCP Registry OpenAPI).",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({ name: z.string().min(1).max(120), baseUrl: z.string().url() }),
  output: z.object({ registryId: z.string() }),
});
```

- [ ] **plugin.registry.remove** — `packages/oxagen/src/contracts/plugin.registry.remove.ts`

```ts
import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginRegistryRemove = registerCapability({
  name: "plugin.registry.remove",
  domain: "plugin",
  description: "Remove an org-added MCP registry source (the global default seed cannot be removed).",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: false,
  sensitivity: "destructive",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({ registryId: z.string() }),
  output: z.object({ ok: z.boolean() }),
});
```

- [ ] **plugin.registry.sync** — `packages/oxagen/src/contracts/plugin.registry.sync.ts`

```ts
import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginRegistrySync = registerCapability({
  name: "plugin.registry.sync",
  domain: "plugin",
  description: "Trigger an on-demand catalog sync for a registry (async; returns accepted).",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({ registryId: z.string(), mode: z.enum(["full", "incremental"]).default("incremental") }),
  output: z.object({ accepted: z.boolean() }),
});
```

- [ ] **plugin.catalog.browse** — `packages/oxagen/src/contracts/plugin.catalog.browse.ts`

```ts
import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginCatalogBrowse = registerCapability({
  name: "plugin.catalog.browse",
  domain: "plugin",
  description: "Search and filter the MCP server catalog (latest versions) by text, category, transport, and auth kind.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    search: z.string().optional(),
    categories: z.array(z.string()).optional(),
    transportTypes: z.array(z.string()).optional(),
    authKind: z.enum(["oauth", "secret", "none"]).optional(),
    limit: z.number().int().min(1).max(100).default(30),
    offset: z.number().int().min(0).default(0),
  }),
  output: z.object({
    servers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        title: z.string().nullable(),
        description: z.string(),
        icons: z.array(z.object({ src: z.string() }).passthrough()),
        transportTypes: z.array(z.string()),
        authKind: z.string(),
        categories: z.array(z.string()),
        version: z.string(),
      }),
    ),
    nextOffset: z.number().nullable(),
    total: z.number(),
  }),
});
```

- [ ] **plugin.catalog.get** — `packages/oxagen/src/contracts/plugin.catalog.get.ts`

```ts
import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginCatalogGet = registerCapability({
  name: "plugin.catalog.get",
  domain: "plugin",
  description: "Get full detail for one catalog server, including rendered README HTML, packages, and remotes.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({ catalogId: z.string() }),
  output: z.object({
    id: z.string(),
    name: z.string(),
    title: z.string().nullable(),
    description: z.string(),
    version: z.string(),
    repository: z.unknown().nullable(),
    websiteUrl: z.string().nullable(),
    icons: z.array(z.unknown()),
    packages: z.array(z.unknown()),
    remotes: z.array(z.unknown()),
    transportTypes: z.array(z.string()),
    authKind: z.string(),
    categories: z.array(z.string()),
    readmeHtml: z.string().nullable(),
    status: z.string(),
  }),
});
```

### (c) The six handler bodies (create each `packages/handlers/src/<name>.ts`)

> Each exports `export const handler: CapabilityHandlerFn = async (input, ctx) => {...}`. VERIFY the exact `CapabilityHandlerFn` type + how `ctx` exposes the org id (read `packages/handlers/src/chat.message.send.ts`). The catalog tables are cross-tenant → use `withSystemDb`. Registry rows are org+global → `withSystemDb` with explicit `orgId` filters.

- [ ] **plugin.registry.list handler**

```ts
import { or, eq, isNull } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/types"; // VERIFY exact type export

export const handler: CapabilityHandlerFn = async (_input, ctx) => {
  const orgId = ctx.orgId; // VERIFY accessor
  const rows = await withSystemDb((tx) =>
    tx
      .select()
      .from(schema.mcpRegistries)
      .where(or(isNull(schema.mcpRegistries.orgId), eq(schema.mcpRegistries.orgId, orgId))),
  );
  return {
    registries: rows.map((r) => ({
      id: r.id, name: r.name, baseUrl: r.baseUrl, enabled: r.enabled,
      isDefaultSeed: r.isDefaultSeed, lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
    })),
  };
};
```

- [ ] **plugin.registry.add handler**

```ts
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/types";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { name, baseUrl } = input as { name: string; baseUrl: string };
  const [row] = await withSystemDb((tx) =>
    tx.insert(schema.mcpRegistries).values({ orgId: ctx.orgId, name, baseUrl, enabled: true, isDefaultSeed: false }).returning({ id: schema.mcpRegistries.id }),
  );
  return { registryId: row.id };
};
```

- [ ] **plugin.registry.remove handler** (block removing the global seed)

```ts
import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/types";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { registryId } = input as { registryId: string };
  const deleted = await withSystemDb((tx) =>
    tx
      .delete(schema.mcpRegistries)
      .where(and(eq(schema.mcpRegistries.id, registryId), eq(schema.mcpRegistries.orgId, ctx.orgId), eq(schema.mcpRegistries.isDefaultSeed, false)))
      .returning({ id: schema.mcpRegistries.id }),
  );
  return { ok: deleted.length > 0 };
};
```

- [ ] **plugin.registry.sync handler** (dispatch the Inngest event)

```ts
import { inngest } from "@oxagen/inngest-functions"; // VERIFY export path for the client
import type { CapabilityHandlerFn } from "@oxagen/oxagen/types";

export const handler: CapabilityHandlerFn = async (input) => {
  const { registryId, mode } = input as { registryId: string; mode: "full" | "incremental" };
  await inngest.send({ name: "plugin/registry.sync", data: { registryId, mode } });
  return { accepted: true };
};
```

- [ ] **plugin.catalog.browse handler**

```ts
import { and, desc, eq, ilike, arrayOverlaps, sql } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/types";

export const handler: CapabilityHandlerFn = async (input) => {
  const { search, categories, transportTypes, authKind, limit, offset } = input as {
    search?: string; categories?: string[]; transportTypes?: string[]; authKind?: string; limit: number; offset: number;
  };
  const conds = [eq(schema.mcpCatalogServers.isLatest, true), eq(schema.mcpCatalogServers.status, "active")];
  if (search) conds.push(ilike(schema.mcpCatalogServers.name, `%${search}%`));
  if (authKind) conds.push(eq(schema.mcpCatalogServers.authKind, authKind));
  if (categories?.length) conds.push(arrayOverlaps(schema.mcpCatalogServers.categories, categories));
  if (transportTypes?.length) conds.push(arrayOverlaps(schema.mcpCatalogServers.transportTypes, transportTypes));
  const where = and(...conds);

  return withSystemDb(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.mcpCatalogServers)
      .where(where)
      .orderBy(desc(schema.mcpCatalogServers.publishedAt))
      .limit(limit)
      .offset(offset);
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.mcpCatalogServers)
      .where(where);
    return {
      servers: rows.map((r) => ({
        id: r.id, name: r.name, title: r.title, description: r.description,
        icons: (r.icons as Array<{ src: string }>) ?? [], transportTypes: r.transportTypes,
        authKind: r.authKind, categories: r.categories, version: r.version,
      })),
      nextOffset: offset + rows.length < count ? offset + limit : null,
      total: count,
    };
  });
};
```

VERIFY: `ilike` searches `name` only; if you want title/description search too, OR additional `ilike` conditions. Confirm `arrayOverlaps` is exported by the installed `drizzle-orm` version; if not, use `sql\`${col} && ${array}\``.

- [ ] **plugin.catalog.get handler**

```ts
import { eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/types";

export const handler: CapabilityHandlerFn = async (input) => {
  const { catalogId } = input as { catalogId: string };
  const [r] = await withSystemDb((tx) =>
    tx.select().from(schema.mcpCatalogServers).where(eq(schema.mcpCatalogServers.id, catalogId)).limit(1),
  );
  if (!r) throw new Error("catalog server not found");
  return {
    id: r.id, name: r.name, title: r.title, description: r.description, version: r.version,
    repository: r.repository ?? null, websiteUrl: r.websiteUrl, icons: (r.icons as unknown[]) ?? [],
    packages: (r.packages as unknown[]) ?? [], remotes: (r.remotes as unknown[]) ?? [],
    transportTypes: r.transportTypes, authKind: r.authKind, categories: r.categories,
    readmeHtml: r.readmeHtml, status: r.status,
  };
};
```

### (d) Reference instantiation — `plugin.catalog.browse` fully wired + tested

- [ ] **Step 1: Contract unit test** `packages/oxagen/src/contracts/plugin.catalog.browse.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { pluginCatalogBrowse } from "./plugin.catalog.browse";

describe("plugin.catalog.browse contract", () => {
  it("registers with api+mcp surfaces and org admin roles", () => {
    expect(pluginCatalogBrowse.name).toBe("plugin.catalog.browse");
    expect(pluginCatalogBrowse.surfaces).toContain("api");
    expect(pluginCatalogBrowse.surfaces).toContain("mcp");
    expect(pluginCatalogBrowse.defaultRoles.org.Owner).toBe("allow");
  });
  it("applies input defaults (limit 30, offset 0)", () => {
    const parsed = pluginCatalogBrowse.input.parse({});
    expect(parsed.limit).toBe(30);
    expect(parsed.offset).toBe(0);
  });
  it("rejects an invalid authKind", () => {
    expect(() => pluginCatalogBrowse.input.parse({ authKind: "bogus" })).toThrow();
  });
});
```

Run: `pnpm --filter @oxagen/oxagen test:unit -- plugin.catalog.browse`
Expected: PASS (3 tests).

- [ ] **Step 2: Create the api route + mcp tool** for `plugin.catalog.browse` from the template in (a) (read `workspace.create` route/tool first and copy ctx/registration verbatim, substituting `pluginCatalogBrowse` / `plugin.catalog.browse`). Register the route in the api route registrar and the tool per the mcp tool-discovery convention (VERIFY both against how `workspace.create` is registered).

- [ ] **Step 3: Repeat (b)+(c)+(d-Step1/2) for the other five capabilities.** Each: contract file, contract test (assert name/surfaces/roles + one input-validation case), handler file, route file, tool file. Use the exact templates above.

### (e) Register handlers + manifest

- [ ] **Step 1: Register all six handlers** in `packages/handlers/src/register.ts`:

```ts
registerHandler("plugin.registry.list", async () => (await import("./plugin.registry.list")).handler);
registerHandler("plugin.registry.add", async () => (await import("./plugin.registry.add")).handler);
registerHandler("plugin.registry.remove", async () => (await import("./plugin.registry.remove")).handler);
registerHandler("plugin.registry.sync", async () => (await import("./plugin.registry.sync")).handler);
registerHandler("plugin.catalog.browse", async () => (await import("./plugin.catalog.browse")).handler);
registerHandler("plugin.catalog.get", async () => (await import("./plugin.catalog.get")).handler);
```

- [ ] **Step 2: Ensure contracts are discovered** — run the manifest generator (it rewrites `packages/oxagen/src/contracts.generated.ts`):

Run: `pnpm check:manifest`
Expected: warn-only; the six `plugin.*` capabilities appear with `api`/`mcp`/`unit` layers satisfied (no warnings for these). Fix any reported missing file.

- [ ] **Step 3: Commit**

```bash
git add packages/oxagen/src/contracts/plugin.*.ts packages/oxagen/src/contracts/plugin.*.test.ts packages/handlers/src/plugin.*.ts packages/handlers/src/register.ts apps/api/src/routes/v1/plugin.*.ts apps/mcp/src/tools/plugin.*.ts packages/oxagen/src/contracts.generated.ts packages/oxagen/capabilities.manifest.json
git commit -m "feat(plugins): registry+catalog capabilities (contracts, handlers, api routes, mcp tools) with parity"
```

---

## Task 8: Final verification

- [ ] **Step 1: Manifest parity**

Run: `pnpm check:manifest`
Expected: no warnings for any `plugin.*` capability (all declared layers have files).

- [ ] **Step 2: Typecheck touched packages**

Run: `pnpm --filter @oxagen/plugins --filter @oxagen/oxagen --filter @oxagen/handlers --filter @oxagen/inngest-functions typecheck`
Expected: all PASS.

- [ ] **Step 3: Unit tests**

Run: `pnpm --filter @oxagen/plugins test:unit && pnpm --filter @oxagen/oxagen test:unit -- plugin.`
Expected: plugins suite green (registry-client 4, map-server 6, readme 5, sync-service 4, + Plan 1's 5 = 24); contract tests green (≥6 plugin contract tests).

- [ ] **Step 4: Lint**

Run: `pnpm --filter @oxagen/plugins lint`
Expected: clean (remove any unused imports flagged, e.g. `ne` in sync-service if unused).

- [ ] **Step 5: Live sync smoke (optional, requires local PG + network)**

Run a one-off `tsx` script (or a temporary test) calling `syncRegistry(<seedRegistryId>, { mode: "full" }, createSystemSyncPersistence())` against the seeded official registry and assert `mcp.catalog_servers` row count > 0. Document in the PR; do not commit the throwaway script.

---

## Done criteria for Plan 2

- The MCP registry client paginates the official registry and is Zod-validated.
- `syncRegistry` upserts catalog rows, maintains `is_latest`, refreshes READMEs (sanitized HTML, relative images rewritten) on a 24h TTL, and checkpoints the cursor.
- An Inngest cron syncs all enabled registries every 6h; an on-demand event syncs a single registry.
- Six capabilities (`plugin.registry.add|remove|list|sync`, `plugin.catalog.browse|get`) are reachable identically over `/v1` API and MCP; `pnpm check:manifest` is clean for them.
- All unit tests green; typecheck + lint clean across touched packages.

**Next plan:** `2026-06-06-installable-plugins-03-spine-capabilities-runtime.md` — the `PluginType` spine, MCP `contributeTools`, org install/enable + denylist governance capabilities, `assertMcpManager`, and the governance-gated `materializeTools` extension.
