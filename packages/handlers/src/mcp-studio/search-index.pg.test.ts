/**
 * The search index's Postgres side against Postgres (lane M15; ADR-217).
 * Runs in the CI Postgres job and locally with DATABASE_URL set; skipped
 * otherwise.
 *
 * Two workspaces in one organization store vectors in mcp.search_embeddings
 * through postgresSearchStore, which runs every statement in the tenant scope
 * a publish uses. The tests show that a write keeps the first vector for a
 * hash, that a read spans more hashes than one statement carries, that each
 * sweep deletes only the rows search no longer reads, and that neither
 * workspace sees or deletes the other's rows.
 */
import { randomUUID } from "node:crypto";
import { schema, withSystemDb } from "@oxagen/database";
import { contentHash } from "@oxagen/mcp-studio";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { postgresSearchStore, readEmbeddingSettings, type SearchScope } from "./search-index";

const KEY = "a".repeat(32);
const OTHER_KEY = "b".repeat(32);

function vector(...values: number[]): Float32Array {
  return new Float32Array(values);
}

function values(found: ReadonlyArray<{ hash: string; vector: Float32Array }>): Array<[string, number[]]> {
  return found.map((row): [string, number[]] => [row.hash, [...row.vector]]).sort(([a], [b]) => a.localeCompare(b));
}

describe.skipIf(!process.env.DATABASE_URL)("postgresSearchStore against Postgres", () => {
  const tag = randomUUID().replace(/-/g, "").slice(0, 8);
  const orgId = randomUUID();
  const workspaceId = randomUUID();
  const neighbourId = randomUUID();
  const scope: SearchScope = { orgId, workspaceId, principalKind: "service", capabilityName: "publish_steering_version" };
  const neighbourScope: SearchScope = { ...scope, workspaceId: neighbourId };
  const store = postgresSearchStore(scope);
  const neighbour = postgresSearchStore(neighbourScope);
  const refund = contentHash("refund");
  const charges = contentHash("charges");
  const customer = contentHash("customer");

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(schema.organizations).values({
        id: orgId,
        name: `M15 search index ${tag}`,
        slug: `m15-search-${tag}`,
        namespace: `s${tag.slice(0, 5)}`,
        planType: "free",
        status: "active",
      });
      await tx.insert(schema.workspaces).values([
        { id: workspaceId, orgId, name: "Tools", slug: "tools", namespace: `w${tag.slice(0, 5)}` },
        { id: neighbourId, orgId, name: "Neighbour", slug: "neighbour", namespace: `n${tag.slice(0, 5)}` },
      ]);
    });
  });

  beforeEach(async () => {
    await withSystemDb((tx) => tx.delete(schema.mcpSearchEmbeddings).where(eq(schema.mcpSearchEmbeddings.orgId, orgId)));
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.delete(schema.mcpSearchEmbeddings).where(eq(schema.mcpSearchEmbeddings.orgId, orgId));
      await tx.delete(schema.workspaces).where(eq(schema.workspaces.orgId, orgId));
      await tx.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    });
  });

  it("reads back what it writes and keeps the first vector for a hash", async () => {
    await store.write(KEY, [
      { hash: refund, vector: vector(1, 0, 0.5) },
      { hash: charges, vector: vector(0, 1, 0.25) },
    ]);
    await store.write(KEY, [{ hash: refund, vector: vector(9, 9, 9) }]);

    expect(values(await store.read(KEY, [refund, charges, customer]))).toEqual(
      values([
        { hash: refund, vector: vector(1, 0, 0.5) },
        { hash: charges, vector: vector(0, 1, 0.25) },
      ]),
    );
    expect(await store.read(OTHER_KEY, [refund, charges])).toEqual([]);
    expect(await store.read(KEY, [])).toEqual([]);
  });

  it("reads and writes more hashes than one statement carries", async () => {
    const hashes = Array.from({ length: 300 }, (_, at) => contentHash(`entry ${at}`));
    await store.write(
      KEY,
      hashes.map((hash, at) => ({ hash, vector: vector(at, 1) })),
    );

    const found = await store.read(KEY, hashes);

    expect(found).toHaveLength(300);
    expect(found.find((row) => row.hash === hashes[299])?.vector).toEqual(vector(299, 1));
  });

  it("sweeps other target keys and stale hashes, and keeps the rest", async () => {
    await store.write(KEY, [
      { hash: refund, vector: vector(1) },
      { hash: charges, vector: vector(2) },
    ]);
    await store.write(OTHER_KEY, [{ hash: refund, vector: vector(3) }]);

    expect(await store.sweep(KEY, [refund])).toBe(2);

    expect(values(await store.read(KEY, [refund, charges]))).toEqual([[refund, [1]]]);
    expect(await store.read(OTHER_KEY, [refund])).toEqual([]);
  });

  it("sweeps only other target keys when no hashes are given", async () => {
    await store.write(KEY, [
      { hash: refund, vector: vector(1) },
      { hash: charges, vector: vector(2) },
    ]);
    await store.write(OTHER_KEY, [{ hash: customer, vector: vector(3) }]);

    expect(await store.sweep(KEY)).toBe(1);

    expect(await store.read(KEY, [refund, charges])).toHaveLength(2);
    expect(await store.read(OTHER_KEY, [customer])).toEqual([]);
  });

  it("sweeps every row under the kept key when the hashes are empty", async () => {
    await store.write(KEY, [{ hash: refund, vector: vector(1) }]);

    expect(await store.sweep(KEY, [])).toBe(1);
  });

  it("sweeps every row of its own workspace and none of its neighbour's", async () => {
    await store.write(KEY, [{ hash: refund, vector: vector(1) }]);
    await store.write(OTHER_KEY, [{ hash: charges, vector: vector(2) }]);
    await neighbour.write(KEY, [{ hash: refund, vector: vector(7) }]);

    expect(await store.sweep(null)).toBe(2);

    expect(await store.read(KEY, [refund])).toEqual([]);
    expect(values(await neighbour.read(KEY, [refund]))).toEqual([[refund, [7]]]);
  });

  it("reads the workspace's [embeddings] setting", async () => {
    expect(await readEmbeddingSettings(scope)).toBeUndefined();

    const embeddings = { provider: "custom", url: "https://embed.example.com/v1/embeddings", model: "house-embed" };
    await withSystemDb((tx) =>
      tx.update(schema.workspaces).set({ settings: { embeddings } }).where(eq(schema.workspaces.id, workspaceId)),
    );

    expect(await readEmbeddingSettings(scope)).toEqual(embeddings);
    expect(await readEmbeddingSettings(neighbourScope)).toBeUndefined();
  });
});
