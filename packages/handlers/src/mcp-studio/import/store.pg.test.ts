// store.pg.test.ts: Studio's draft store against a migrated Postgres. It runs
// wherever DATABASE_URL points at a migrated database, as in CI's unit job,
// and skips without one. afterAll removes every row it writes.
//
// The store's revision rule: 0 starts a draft and never overwrites one, N must
// equal the stored revision, and an omitted revision saves over any. A
// soft-deleted draft does not count, and recording a PR keeps the revision.
import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import type { StudioDraftOp, StudioSource } from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq } from "drizzle-orm";
import { postgresStudioDraftStore, type SaveStudioDraftInput, type StudioDraftScope } from "./store";

const enabled = Boolean(process.env.DATABASE_URL);

const CLASSIFY: StudioDraftOp = {
  kind: "classify",
  tool: "list_charges",
  risk: "low",
  sideEffect: "read",
  egress: "org_tenant",
  impacts: [],
};
const REMOVE: StudioDraftOp = { kind: "remove", tool: "create_refund" };
const SOURCE: StudioSource = { type: "graphql", sdl: "type Query { charges: [String!]! }\n" };
const SERVER_TOML = 'schema = "mcp-server/v1"\nname = "billing"\n';

describe.skipIf(!enabled)("Studio's draft store against Postgres", () => {
  const orgId = crypto.randomUUID();
  const scope: StudioDraftScope = { orgId, workspaceId: crypto.randomUUID() };
  const otherScope: StudioDraftScope = { orgId, workspaceId: crypto.randomUUID() };
  const userId = crypto.randomUUID();
  const store = postgresStudioDraftStore();

  const inScope = <T>(at: StudioDraftScope, fn: () => Promise<T>) => runInTenantScope(at, fn);
  const save = (fields: Partial<SaveStudioDraftInput> & { server: string }, at = scope) =>
    inScope(at, () => store.save(at, { ops: [], actorUserId: userId, ...fields }));
  const get = (server: string, at = scope) => inScope(at, () => store.get(at, server));

  async function refusal(promise: Promise<unknown>): Promise<HandlerError> {
    try {
      await promise;
    } catch (err) {
      if (err instanceof HandlerError) return err;
      throw err;
    }
    throw new Error("The store did not refuse.");
  }

  afterAll(async () => {
    await withSystemDb((tx) => tx.delete(schema.mcpStudioDrafts).where(eq(schema.mcpStudioDrafts.orgId, orgId)));
    await closeDatabase();
  });

  it("follows the revision rule from the first save to a save over any", async () => {
    await expect(get("billing")).resolves.toBeNull();

    const first = await save({ server: "billing", ops: [CLASSIFY], serverToml: SERVER_TOML, source: SOURCE, revision: 0 });
    expect(first).toMatchObject({
      server: "billing",
      serverId: null,
      ops: [CLASSIFY],
      serverToml: SERVER_TOML,
      source: SOURCE,
      revision: 1,
      pr: null,
    });

    const again = await refusal(save({ server: "billing", revision: 0 }));
    expect(again.code).toBe("conflict");
    expect(again.reason).toBe("draft_revision_stale");
    expect(again.message).toContain("A draft for billing already exists at revision 1.");

    // A save that omits server.toml and the source keeps the stored ones.
    const second = await save({ server: "billing", ops: [CLASSIFY, REMOVE], revision: 1 });
    expect(second).toMatchObject({ ops: [CLASSIFY, REMOVE], serverToml: SERVER_TOML, source: SOURCE, revision: 2 });

    const stale = await refusal(save({ server: "billing", ops: [], revision: 1 }));
    expect(stale.reason).toBe("draft_revision_stale");
    expect(stale.message).toContain("The draft for billing is at revision 2, not 1.");
    await expect(get("billing")).resolves.toMatchObject({ ops: [CLASSIFY, REMOVE], revision: 2 });

    const any = await save({ server: "billing", ops: [REMOVE] });
    expect(any).toMatchObject({ ops: [REMOVE], revision: 3 });
  });

  it("refuses a revision above 0 when no draft exists", async () => {
    const err = await refusal(save({ server: "ledger", revision: 4 }));
    expect(err.reason).toBe("draft_revision_stale");
    expect(err.message).toBe("No draft for ledger exists. Save at revision 0 to start one.");
    await expect(get("ledger")).resolves.toBeNull();
  });

  it("records the PR without raising the revision", async () => {
    const saved = await save({ server: "payments", ops: [CLASSIFY], revision: 0 });
    const pr = { number: 17, url: "https://github.com/acme/steering/pull/17", branch: "tools/payments" };
    await inScope(scope, () => store.recordPr(scope, "payments", pr));

    await expect(get("payments")).resolves.toMatchObject({ pr, revision: saved.revision });
  });

  it("lets revision 0 start a new draft after the live one is deleted", async () => {
    await save({ server: "search", ops: [CLASSIFY], revision: 0 });
    await withSystemDb((tx) =>
      tx
        .update(schema.mcpStudioDrafts)
        .set({ deletedAt: new Date(), deletedById: userId })
        .where(
          and(
            eq(schema.mcpStudioDrafts.orgId, scope.orgId),
            eq(schema.mcpStudioDrafts.workspaceId, scope.workspaceId),
            eq(schema.mcpStudioDrafts.serverName, "search"),
          ),
        ),
    );
    await expect(get("search")).resolves.toBeNull();

    const fresh = await save({ server: "search", ops: [REMOVE], revision: 0 });
    expect(fresh).toMatchObject({ ops: [REMOVE], revision: 1 });
  });

  it("refuses a serverId this workspace does not hold and stores nothing", async () => {
    const err = await refusal(save({ server: "crm", serverId: "mcs_unknown", revision: 0 }));
    expect(err.code).toBe("not_found");
    expect(err.reason).toBe("server_not_found");
    expect(err.message).toBe("No MCP server mcs_unknown in this workspace.");
    await expect(get("crm")).resolves.toBeNull();
  });

  it("keeps one workspace's draft out of another's", async () => {
    await save({ server: "tickets", ops: [CLASSIFY], revision: 0 });
    await expect(get("tickets", otherScope)).resolves.toBeNull();

    const theirs = await save({ server: "tickets", ops: [REMOVE], revision: 0 }, otherScope);
    expect(theirs.revision).toBe(1);
    await expect(get("tickets")).resolves.toMatchObject({ ops: [CLASSIFY], revision: 1 });
  });
});
