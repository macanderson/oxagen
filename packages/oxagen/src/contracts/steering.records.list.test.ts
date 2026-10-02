import { describe, expect, it } from "vitest";
import { steeringRecordsList } from "./steering.records.list";

describe("list_records contract", () => {
  it("is a console read: scoped, non-mutating, unmetered, readable by every workspace role", () => {
    expect(steeringRecordsList.name).toBe("list_records");
    expect(steeringRecordsList.scoped).toBe(true);
    expect(steeringRecordsList.mutates).toBe(false);
    expect(steeringRecordsList.noBillingGate).toBe(true);
    expect(steeringRecordsList.defaultEffect).toBe("deny");
    expect(steeringRecordsList.defaultRoles.workspace).toEqual({
      Owner: "allow",
      Member: "allow",
      Viewer: "allow",
    });
  });

  it("filters by kind, scope, status and lineage, pages to 200, refuses unknown fields", () => {
    expect(steeringRecordsList.input.parse({})).toEqual({
      limit: 50,
      offset: 0,
    });
    expect(
      steeringRecordsList.input.parse({ kind: "constraint", status: "active" }),
    ).toMatchObject({ kind: "constraint", status: "active" });
    expect(
      steeringRecordsList.input.safeParse({ kind: "directive" }).success,
    ).toBe(false);
    expect(steeringRecordsList.input.safeParse({ limit: 201 }).success).toBe(
      false,
    );
    expect(steeringRecordsList.input.safeParse({ q: "x" }).success).toBe(false);
  });

  it("answers records whose classification may be null for a record no steering PR published", () => {
    const out = steeringRecordsList.output.parse({
      records: [
        {
          id: "ctr_0123456789abcdefghjkmn",
          lineageId: "ctx.platform.changelog-once",
          title: "changelog once",
          kind: null,
          force: null,
          constraintEffect: null,
          sharingScope: "workspace",
          statement: null,
          status: "active",
          version: 1,
          checksum: "a".repeat(64),
          commit: null,
          path: null,
          publishedAt: null,
          updatedAt: "2026-09-15T00:00:00.000Z",
        },
      ],
      total: 1,
    });
    expect(out.records[0]?.kind).toBeNull();
  });
});
