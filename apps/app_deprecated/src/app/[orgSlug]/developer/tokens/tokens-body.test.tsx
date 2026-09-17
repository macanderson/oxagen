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
  assertOrgAdmin: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSessionOrRedirect: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
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
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
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
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { DeveloperTokensBody } from "./tokens-body";
import { logger } from "@oxagen/handlers/logger";
import { assertOrgAdmin } from "@/lib/resolve-org";

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

  // RLS was narrowing this read to nothing, which is also what kept the panel
  // from showing a member the organization's keys. Reading it correctly without
  // the gate would have handed every member every workspace's key names,
  // prefixes, scopes and last-used timestamps — data list_api_keys classifies
  // as Owner/Admin, and which the three actions on this same panel already
  // gated for.
  it("gates on org admin before reading anything", async () => {
    dbState.rows = [key("key_cli", "ws-1")];
    await render();
    expect(assertOrgAdmin).toHaveBeenCalledWith("org-1", "user-1");
  });

  it("does not read the keys when the admin gate refuses", async () => {
    const { withSystemDb } = await import("@oxagen/database");
    vi.mocked(assertOrgAdmin).mockRejectedValueOnce(
      new Error("NEXT_NOT_FOUND"),
    );
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(withSystemDb).not.toHaveBeenCalled();
  });

  it("logs a genuine read failure rather than rendering it as 'no keys'", async () => {
    dbState.error = new Error("connection refused");
    const props = await render();
    expect(props.keys).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });
});
