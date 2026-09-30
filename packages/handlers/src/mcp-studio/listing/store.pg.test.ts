// store.pg.test.ts: the listing store against a real Postgres (ADR-233,
// #4756). It covers the request that pins a listing on a draft revision, the
// claim a machine's MCP process makes, and the one transaction that writes
// the draft's source and finishes the listing. It runs wherever DATABASE_URL
// points at a migrated database. CI's unit job migrates Postgres with Atlas
// first, and a run without DATABASE_URL skips the file.
//
// mcp.studio_drafts and mcp.studio_listings carry no foreign key to an
// organization or a workspace, so the file writes neither. Each case takes a
// fresh workspace id, and afterAll removes every row the file wrote by its
// org id.
import { randomUUID } from "node:crypto";
import type { McpLockSource } from "@oxagen/mcp-studio";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  CLAIM_STALE_MS,
  postgresListingClaimStore,
  postgresListingStore,
  type ListingScope,
} from "./store";

const enabled = Boolean(process.env.DATABASE_URL);

const ORG = randomUUID();
const T0 = new Date("2026-09-30T10:00:00.000Z");
const T1 = new Date("2026-09-30T10:00:05.000Z");
const DIGEST = `sha256:${"c3".repeat(32)}`;

const PIN: McpLockSource = {
  type: "local",
  command: "/usr/local/bin/notes-mcp",
  package: { name: "notes-mcp", version: "0.9.2", digest: DIGEST },
};

const TOOLS = [{ name: "list_notes", description: "List notes.", inputSchema: { type: "object" } }];

function scope(): ListingScope {
  return { orgId: ORG, workspaceId: randomUUID() };
}

/** A live draft for `server` at `revision`. */
async function seedDraft(at: ListingScope, server = "notes", revision = 3): Promise<string> {
  const [row] = await withSystemDb((tx) =>
    tx
      .insert(schema.mcpStudioDrafts)
      .values({
        orgId: at.orgId,
        workspaceId: at.workspaceId,
        serverName: server,
        ops: [],
        serverToml: "the draft's server.toml",
        revision,
      })
      .returning({ id: schema.mcpStudioDrafts.id }),
  );
  return row!.id;
}

async function draftRow(id: string) {
  const [row] = await withSystemDb((tx) =>
    tx
      .select({ revision: schema.mcpStudioDrafts.revision, source: schema.mcpStudioDrafts.source })
      .from(schema.mcpStudioDrafts)
      .where(eq(schema.mcpStudioDrafts.id, id)),
  );
  return row!;
}

const request = (at: ListingScope, over: { draftRevision?: number; groups?: string[] } = {}) =>
  postgresListingStore.request(
    at,
    {
      server: "notes",
      draftRevision: over.draftRevision ?? 3,
      groups: over.groups ?? ["dev-laptops"],
      lockSource: PIN,
      requestedBy: null,
    },
    T0,
  );

describe.skipIf(!enabled)("postgresListingStore", () => {
  afterAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.delete(schema.mcpStudioListings).where(eq(schema.mcpStudioListings.orgId, ORG));
      await tx.delete(schema.mcpStudioDrafts).where(eq(schema.mcpStudioDrafts.orgId, ORG));
    });
    await closeDatabase();
  });

  it("pins a listing on the draft's revision, and a second request replaces it", async () => {
    const at = scope();
    await seedDraft(at);

    const first = await request(at);
    expect(first).toMatchObject({
      server: "notes",
      status: "waiting_for_machine",
      machineGroups: ["dev-laptops"],
      lockSource: PIN,
      draftRevision: 3,
      requestedAt: T0,
      claimedAt: null,
    });
    await request(at, { groups: ["build-hosts"] });
    expect(await postgresListingStore.get(at, "notes")).toMatchObject({ machineGroups: ["build-hosts"] });
    const rows = await withSystemDb((tx) =>
      tx.select().from(schema.mcpStudioListings).where(eq(schema.mcpStudioListings.workspaceId, at.workspaceId)),
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses a request on a stale revision, and a server with no draft (negative)", async () => {
    const at = scope();
    await seedDraft(at);
    await expect(request(at, { draftRevision: 2 })).rejects.toMatchObject({ code: "conflict", reason: "draft_revision_stale" });
    await expect(
      postgresListingStore.request(
        at,
        { server: "ghost", draftRevision: 1, groups: ["dev-laptops"], lockSource: PIN, requestedBy: null },
        T0,
      ),
    ).rejects.toMatchObject({ code: "not_found", reason: "draft_not_found" });
    expect(await postgresListingStore.get(at, "notes")).toBeNull();
  });

  it("claims a listing for a machine in one of its groups, once", async () => {
    const at = scope();
    await seedDraft(at);
    await request(at);

    expect(await postgresListingClaimStore.claimOpen(at, ["build-hosts"], T1)).toBeNull();
    const claimed = await postgresListingClaimStore.claimOpen(at, ["dev-laptops", "build-hosts"], T1);
    expect(claimed).toMatchObject({ server: "notes", draftRevision: 3, lockSource: PIN, claimedAt: T1 });
    // A running claim is not open again until it goes stale.
    expect(await postgresListingClaimStore.claimOpen(at, ["dev-laptops"], T1)).toBeNull();
    const later = new Date(T1.getTime() + CLAIM_STALE_MS + 1_000);
    expect(await postgresListingClaimStore.claimOpen(at, ["dev-laptops"], later)).toMatchObject({ claimedAt: later });
  });

  it("writes the draft's source and finishes the listing in one transaction", async () => {
    const at = scope();
    const draftId = await seedDraft(at);
    await request(at);
    const claimed = (await postgresListingClaimStore.claimOpen(at, ["dev-laptops"], T1))!;
    const source = { type: "mcp" as const, lockSource: { ...PIN }, tools: TOOLS };

    const done = await postgresListingClaimStore.complete(
      at,
      claimed,
      { source, machine: "tch_laptop01", toolCount: 1 },
      T1,
    );

    expect(done).toEqual({ status: "succeeded", draftRevision: 4 });
    expect(await draftRow(draftId)).toEqual({ revision: 4, source });
    expect(await postgresListingStore.get(at, "notes")).toMatchObject({
      status: "succeeded",
      machine: "tch_laptop01",
      toolCount: 1,
      finishedAt: T1,
      error: null,
    });
  });

  it("writes nothing into a draft saved after the listing was asked (negative)", async () => {
    const at = scope();
    const draftId = await seedDraft(at);
    await request(at);
    const claimed = (await postgresListingClaimStore.claimOpen(at, ["dev-laptops"], T1))!;
    await withSystemDb((tx) =>
      tx.update(schema.mcpStudioDrafts).set({ revision: 4 }).where(eq(schema.mcpStudioDrafts.id, draftId)),
    );

    const done = await postgresListingClaimStore.complete(
      at,
      claimed,
      { source: { type: "mcp", lockSource: { ...PIN }, tools: TOOLS }, machine: "tch_laptop01", toolCount: 1 },
      T1,
    );

    expect(done).toEqual({ status: "draft_changed" });
    expect(await draftRow(draftId)).toEqual({ revision: 4, source: null });
    expect(await postgresListingStore.get(at, "notes")).toMatchObject({ status: "failed" });
  });

  it("drops an answer, and a failure, whose claim a new request replaced (negative)", async () => {
    const at = scope();
    const draftId = await seedDraft(at);
    await request(at);
    const claimed = (await postgresListingClaimStore.claimOpen(at, ["dev-laptops"], T1))!;
    await request(at);

    await postgresListingClaimStore.fail(at, claimed, "the machine went away", T1);
    expect(
      await postgresListingClaimStore.complete(
        at,
        claimed,
        { source: { type: "mcp", lockSource: { ...PIN }, tools: TOOLS }, machine: "tch_laptop01", toolCount: 1 },
        T1,
      ),
    ).toEqual({ status: "claim_lost" });
    expect(await postgresListingStore.get(at, "notes")).toMatchObject({ status: "waiting_for_machine", error: null });
    expect(await draftRow(draftId)).toEqual({ revision: 3, source: null });
  });
});
