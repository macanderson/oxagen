/**
 * walk-active-branch.test.ts — unit tests for the walkActiveBranch helper.
 *
 * walkActiveBranch reconstructs the visible message branch by walking
 * parent links from the active leaf to the root. It is a pure function with
 * no side-effects, making it straightforward to exercise here without DB or
 * Next.js mocks.
 *
 * Coverage:
 *   1. Empty rows → empty result
 *   2. Single root message, no leaf → returns the root
 *   3. Linear chain: leafId = last message → returns full chain in order
 *   4. Linear chain: leafId = middle message → returns root→middle only
 *   5. Branch: leafId selects the non-default branch
 *   6. Sibling count is correct for a forked node
 *   7. leafId not found in rows → returns an empty path (no root fallback)
 *   8. contentBlocks preserved when present; undefined when absent
 *   9. metadata.attachments parsed, filtered, and defaulted to undefined
 */

import { describe, it, expect } from "vitest";
import { walkActiveBranch } from "./walk-active-branch";
import type { DbMessageRow } from "@oxagen/database";

// ---------------------------------------------------------------------------
// Fixtures — minimal DbMessageRow shapes
// ---------------------------------------------------------------------------

function makeRow(
  overrides: Partial<DbMessageRow> & { id: string },
): DbMessageRow {
  return {
    id: overrides.id,
    publicId: overrides.publicId ?? `pub_${overrides.id}`,
    orgId: overrides.orgId ?? "org-1",
    workspaceId: overrides.workspaceId ?? "ws-1",
    conversationId: overrides.conversationId ?? "conv-1",
    parentMessageId: overrides.parentMessageId ?? null,
    role: overrides.role ?? "user",
    content: overrides.content ?? "hello",
    contentBlocks: overrides.contentBlocks ?? null,
    branchReason: overrides.branchReason ?? null,
    metadata: overrides.metadata ?? {},
    createdByUserId: overrides.createdByUserId ?? "user-1",
    updatedByUserId: overrides.updatedByUserId ?? "user-1",
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
  } as DbMessageRow;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("walkActiveBranch", () => {
  // 1. Empty rows
  it("returns empty array when rows is empty", () => {
    expect(walkActiveBranch([], "any-leaf-id")).toEqual([]);
    expect(walkActiveBranch([], null)).toEqual([]);
  });

  // 2. Single root message, no leafId
  it("returns the root message when no leafId is provided", () => {
    const root = makeRow({ id: "m1", role: "user", content: "hi" });
    const result = walkActiveBranch([root], null);
    expect(result).toHaveLength(1);
    expect(result[0]?.publicId).toBe("pub_m1");
    expect(result[0]?.content).toBe("hi");
  });

  // 3. Linear chain with a real leafId
  it("returns the full chain root→leaf when leafId points to the last message", () => {
    const m1 = makeRow({
      id: "m1",
      parentMessageId: null,
      role: "user",
      content: "u1",
    });
    const m2 = makeRow({
      id: "m2",
      parentMessageId: "m1",
      role: "assistant",
      content: "a1",
    });
    const m3 = makeRow({
      id: "m3",
      parentMessageId: "m2",
      role: "user",
      content: "u2",
    });

    const result = walkActiveBranch([m1, m2, m3], "m3");
    expect(result.map((r) => r.publicId)).toEqual([
      "pub_m1",
      "pub_m2",
      "pub_m3",
    ]);
    expect(result[0]?.role).toBe("user");
    expect(result[1]?.role).toBe("assistant");
    expect(result[2]?.role).toBe("user");
  });

  // 4. leafId points to a middle node — only root→middle returned
  it("returns root→leafId slice when leafId is a middle message", () => {
    const m1 = makeRow({ id: "m1", parentMessageId: null });
    const m2 = makeRow({ id: "m2", parentMessageId: "m1" });
    const m3 = makeRow({ id: "m3", parentMessageId: "m2" });

    const result = walkActiveBranch([m1, m2, m3], "m2");
    expect(result.map((r) => r.publicId)).toEqual(["pub_m1", "pub_m2"]);
  });

  // 5. Branched tree: two children of m2 — leafId selects the non-default branch
  it("returns the branch ending at the selected leaf, not the default branch", () => {
    const m1 = makeRow({ id: "m1", parentMessageId: null, content: "root" });
    const m2 = makeRow({
      id: "m2",
      parentMessageId: "m1",
      content: "branch A",
    });
    const m3 = makeRow({
      id: "m3",
      parentMessageId: "m1",
      content: "branch B",
    });

    // leafId selects m3 (branch B)
    const result = walkActiveBranch([m1, m2, m3], "m3");
    expect(result.map((r) => r.publicId)).toEqual(["pub_m1", "pub_m3"]);
  });

  // 6. Sibling count is correct for a forked node
  it("reports siblingCount > 1 for a node whose parent has multiple children", () => {
    const m1 = makeRow({ id: "m1", parentMessageId: null });
    const m2 = makeRow({ id: "m2", parentMessageId: "m1" });
    const m3 = makeRow({ id: "m3", parentMessageId: "m1" });

    // Walk via m2 — m2 is one of two children of m1
    const result = walkActiveBranch([m1, m2, m3], "m2");
    const m2Result = result.find((r) => r.publicId === "pub_m2");
    expect(m2Result?.siblingCount).toBe(2);
  });

  // 7. leafId not found in rows → returns empty (cursor is immediately undefined)
  it("returns empty when leafId is not in the rows map", () => {
    const m1 = makeRow({ id: "m1", parentMessageId: null });
    const m2 = makeRow({ id: "m2", parentMessageId: "m1" });

    // "ghost-id" doesn't exist in the byId map — cursor starts as undefined,
    // the while-loop body never executes, and the empty path maps to [].
    const result = walkActiveBranch([m1, m2], "ghost-id");
    expect(result).toHaveLength(0);
  });

  // 8. contentBlocks preserved when present; undefined when absent
  it("preserves contentBlocks array when the row has them", () => {
    const blocks = [
      {
        type: "approval-request" as const,
        approvalId: "ap-1",
        resolution: undefined,
      },
    ];
    const m1 = makeRow({
      id: "m1",
      parentMessageId: null,
      contentBlocks: blocks as unknown as DbMessageRow["contentBlocks"],
    });

    const result = walkActiveBranch([m1], "m1");
    expect(result[0]?.contentBlocks).toEqual(blocks);
  });

  it("returns undefined contentBlocks when the row has null/non-array contentBlocks", () => {
    const m1 = makeRow({
      id: "m1",
      parentMessageId: null,
      contentBlocks: null,
    });

    const result = walkActiveBranch([m1], "m1");
    expect(result[0]?.contentBlocks).toBeUndefined();
  });

  // 9. metadata.attachments — user-turn attachment refs
  it("maps metadata.attachments to ChatMessage.attachments", () => {
    const attachment = {
      publicId: "gen_abc",
      kind: "image",
      name: "photo.png",
      mimeType: "image/png",
      url: "/api/v1/assets/gen_abc",
    };
    const m1 = makeRow({
      id: "m1",
      parentMessageId: null,
      metadata: { attachments: [attachment] },
    });

    const result = walkActiveBranch([m1], "m1");
    expect(result[0]?.attachments).toEqual([attachment]);
  });

  it("returns undefined attachments when metadata has no attachments key", () => {
    const m1 = makeRow({ id: "m1", parentMessageId: null, metadata: {} });
    const result = walkActiveBranch([m1], "m1");
    expect(result[0]?.attachments).toBeUndefined();
  });

  it("returns undefined attachments when metadata.attachments is an empty array", () => {
    const m1 = makeRow({
      id: "m1",
      parentMessageId: null,
      metadata: { attachments: [] },
    });
    const result = walkActiveBranch([m1], "m1");
    expect(result[0]?.attachments).toBeUndefined();
  });

  it("filters out malformed attachment entries instead of throwing", () => {
    const good = {
      publicId: "gen_ok",
      kind: "image",
      name: "ok.png",
      mimeType: "image/png",
      url: "/api/v1/assets/gen_ok",
    };
    const m1 = makeRow({
      id: "m1",
      parentMessageId: null,
      metadata: {
        attachments: [good, { publicId: "gen_bad" }, "not-an-object", null],
      },
    });
    const result = walkActiveBranch([m1], "m1");
    expect(result[0]?.attachments).toEqual([good]);
  });

  it("returns undefined attachments when metadata is null", () => {
    const m1 = makeRow({
      id: "m1",
      parentMessageId: null,
      metadata: null as never,
    });
    const result = walkActiveBranch([m1], "m1");
    expect(result[0]?.attachments).toBeUndefined();
  });
});
