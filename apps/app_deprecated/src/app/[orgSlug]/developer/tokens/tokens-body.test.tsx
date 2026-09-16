/**
 * DeveloperTokensBody — the org's API key roster, and the panel that revokes
 * and rotates from it.
 *
 * `auth.api_keys` is policy class `standard`, so its RLS USING clause requires
 * workspace_id to equal the workspace GUC. Read under the org-only workspace
 * sentinel that predicate matched nothing, and every key minted with a real
 * workspace — which is every key `oxagen login` mints — was invisible here. A
 * key nobody can see is a key nobody can revoke, and the bare `catch { return
 * [] }` rendered that as "no keys" rather than as the failure it was.
 *
 * `withTenantDb` is mocked inert so that regression fails here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: [] as Array<Record<string, unknown>>,
    error: null as Error | null,
  },
}));

vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: vi.fn().mockResolvedValue({ id: "org-1", slug: "acme" }),
}));

vi.mock("./tokens-panel", () => ({
  TokensPanel: (props: unknown) => props,
}));

vi.mock("drizzle-orm", () => ({
  desc: (a: unknown) => a,
  eq: (a: unknown, b: unknown) => [a, b],
}));

vi.mock("@oxagen/database", () => {
  const chain = (): Record<string, unknown> => {
    const self: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy"]) self[m] = () => self;
    self.limit = () =>
      dbState.error === null
        ? Promise.resolve(dbState.rows)
        : Promise.reject(dbState.error);
    return self;
  };
  return {
    withSystemDb: vi.fn((fn: (tx: unknown) => unknown) =>
      fn({ select: () => chain() }),
    ),
    withTenantDb: vi.fn(() => undefined),
    schema: {
      apiKeys: {
        publicId: "publicId",
        name: "name",
        keyPrefix: "keyPrefix",
        scope: "scope",
        expiresAt: "expiresAt",
        lastUsedAt: "lastUsedAt",
        createdAt: "createdAt",
        deletedAt: "deletedAt",
        orgId: "orgId",
      },
    },
  };
});

import { DeveloperTokensBody } from "./tokens-body";
import { logger } from "@oxagen/handlers/logger";

function key(publicId: string, workspaceId: string | null) {
  return {
    publicId,
    name: publicId,
    keyPrefix: "oxg_",
    scope: { purpose: "cli_session" },
    workspaceId,
    expiresAt: null,
    lastUsedAt: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    deletedAt: null,
  };
}

/** The props the panel is handed. The body returns the element, not the props. */
async function render() {
  const element = (await DeveloperTokensBody({
    orgSlug: "acme",
  })) as unknown as {
    props: {
      keys: Array<{
        publicId: string;
        createdAt: string;
        expiresAt: string | null;
      }>;
    };
  };
  return element.props;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.rows = [];
  dbState.error = null;
});

describe("DeveloperTokensBody", () => {
  it("lists the keys bound to a real workspace, which the sentinel scope hid", async () => {
    dbState.rows = [key("key_cli", "ws-1"), key("key_other", "ws-2")];
    const props = await render();
    expect(props.keys.map((k) => k.publicId)).toEqual(["key_cli", "key_other"]);
  });

  it("reads through the system seam, never the tenant-scoped one", async () => {
    const { withSystemDb, withTenantDb } = await import("@oxagen/database");
    dbState.rows = [key("key_cli", "ws-1")];
    await render();
    expect(withSystemDb).toHaveBeenCalled();
    expect(withTenantDb).not.toHaveBeenCalled();
  });

  it("serializes the dates the client component needs", async () => {
    dbState.rows = [key("key_cli", "ws-1")];
    const props = await render();
    expect(props.keys[0]?.createdAt).toBe("2026-09-01T00:00:00.000Z");
    expect(props.keys[0]?.expiresAt).toBeNull();
  });

  it("logs a genuine read failure rather than rendering it as 'no keys'", async () => {
    dbState.error = new Error("connection refused");
    const props = await render();
    expect(props.keys).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });
});
