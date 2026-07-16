import { describe, expect, it } from "vitest";
import { skillVersionList } from "./skill.version.list";
import { getCapability } from "../registry";

describe("skill.version.list capability", () => {
  // ── input: required fields ─────────────────────────────────────────────────

  it("accepts a valid skill_id", () => {
    const parsed = skillVersionList.input.parse({ skill_id: "skl_abc123" });
    expect(parsed.skill_id).toBe("skl_abc123");
  });

  it("applies default limit of 20 when omitted", () => {
    const parsed = skillVersionList.input.parse({ skill_id: "skl_abc" });
    expect(parsed.limit).toBe(20);
  });

  it("applies default offset of 0 when omitted", () => {
    const parsed = skillVersionList.input.parse({ skill_id: "skl_abc" });
    expect(parsed.offset).toBe(0);
  });

  it("accepts explicit limit and offset", () => {
    const parsed = skillVersionList.input.parse({
      skill_id: "skl_abc",
      limit: 50,
      offset: 10,
    });
    expect(parsed.limit).toBe(50);
    expect(parsed.offset).toBe(10);
  });

  // ── input: validation ─────────────────────────────────────────────────────

  it("rejects missing skill_id", () => {
    expect(() => skillVersionList.input.parse({})).toThrow();
  });

  it("rejects limit exceeding 100", () => {
    expect(() =>
      skillVersionList.input.parse({ skill_id: "skl_abc", limit: 101 }),
    ).toThrow();
  });

  it("rejects negative offset", () => {
    expect(() =>
      skillVersionList.input.parse({ skill_id: "skl_abc", offset: -1 }),
    ).toThrow();
  });

  it("rejects non-integer limit", () => {
    expect(() =>
      skillVersionList.input.parse({ skill_id: "skl_abc", limit: 5.5 }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output with one version", () => {
    const parsed = skillVersionList.output.parse({
      skill_id: "skl_abc",
      versions: [
        {
          id: "slv_001",
          versionNumber: 1,
          isLatest: true,
          isActive: true,
          changeSummary: null,
          createdAt: "2024-01-01T00:00:00.000Z",
          createdBy: "u_1",
          createdByEmail: null,
        },
      ],
      total: 1,
    });
    expect(parsed.versions).toHaveLength(1);
    const v = parsed.versions[0]!;
    expect(v.id).toBe("slv_001");
    expect(v.versionNumber).toBe(1);
    expect(v.isLatest).toBe(true);
    expect(v.isActive).toBe(true);
    expect(v.createdBy).toBe("u_1");
    expect(parsed.total).toBe(1);
  });

  it("parses output with empty versions array", () => {
    const parsed = skillVersionList.output.parse({
      skill_id: "skl_abc",
      versions: [],
      total: 0,
    });
    expect(parsed.versions).toHaveLength(0);
    expect(parsed.total).toBe(0);
  });

  it("accepts null createdBy", () => {
    const parsed = skillVersionList.output.parse({
      skill_id: "skl_abc",
      versions: [
        {
          id: "slv_002",
          versionNumber: 2,
          isLatest: false,
          isActive: false,
          changeSummary: null,
          createdAt: "2024-02-01T00:00:00.000Z",
          createdBy: null,
          createdByEmail: null,
        },
      ],
      total: 1,
    });
    expect(parsed.versions[0]!.createdBy).toBeNull();
  });

  it("accepts multiple versions with mixed isActive/isLatest", () => {
    const parsed = skillVersionList.output.parse({
      skill_id: "skl_abc",
      versions: [
        {
          id: "slv_003",
          versionNumber: 3,
          isLatest: true,
          isActive: false,
          changeSummary: null,
          createdAt: "2024-03-01T00:00:00.000Z",
          createdBy: "u_2",
          createdByEmail: null,
        },
        {
          id: "slv_002",
          versionNumber: 2,
          isLatest: false,
          isActive: true,
          changeSummary: null,
          createdAt: "2024-02-01T00:00:00.000Z",
          createdBy: "u_1",
          createdByEmail: null,
        },
      ],
      total: 3,
    });
    expect(parsed.versions).toHaveLength(2);
    expect(parsed.versions[0]!.isLatest).toBe(true);
    expect(parsed.versions[0]!.isActive).toBe(false);
    expect(parsed.versions[1]!.isActive).toBe(true);
    expect(parsed.total).toBe(3);
  });

  it("rejects version missing versionNumber", () => {
    expect(() =>
      skillVersionList.output.parse({
        skill_id: "skl_abc",
        versions: [
          {
            id: "slv_001",
            isLatest: true,
            isActive: true,
            changeSummary: null,
            createdAt: "2024-01-01T00:00:00.000Z",
            createdBy: "u_1",
            createdByEmail: null,
          },
        ],
        total: 1,
      }),
    ).toThrow();
  });

  it("rejects output missing total field", () => {
    expect(() =>
      skillVersionList.output.parse({
        skill_id: "skl_abc",
        versions: [],
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("list_skill_versions")).toBe(skillVersionList);
  });

  it("has noBillingGate set", () => {
    expect(skillVersionList.noBillingGate).toBe(true);
  });

  it("exposes name correctly", () => {
    expect(skillVersionList.name).toBe("list_skill_versions");
  });
});
