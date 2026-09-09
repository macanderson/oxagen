import { describe, expect, it } from "vitest";
import { orgDataPlaneGet } from "./org.data_plane.get";
import { getCapability } from "../registry";

describe("org.data_plane.get capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("get_data_plane")).toBe(orgDataPlaneGet);
  });

  it("accepts each of the three store kinds", () => {
    for (const kind of ["postgres", "neo4j", "clickhouse"] as const) {
      expect(orgDataPlaneGet.input.parse({ kind }).kind).toBe(kind);
    }
  });

  it("rejects an unknown store kind", () => {
    expect(() => orgDataPlaneGet.input.parse({ kind: "mysql" })).toThrow();
  });

  it("requires a kind", () => {
    expect(() => orgDataPlaneGet.input.parse({})).toThrow();
  });

  it("parses a shared-plane binding with null endpoint fields", () => {
    const out = orgDataPlaneGet.output.parse({
      kind: "postgres",
      mode: "shared",
      status: "active",
      host: null,
      database: null,
      schemaVersion: null,
      lastVerifiedAt: null,
      rotatedAt: null,
    });
    expect(out.mode).toBe("shared");
    expect(out.host).toBeNull();
  });

  it("STRIPS any secret a handler mistakenly returned (no passthrough)", () => {
    const out = orgDataPlaneGet.output.parse({
      kind: "postgres",
      mode: "dedicated",
      status: "active",
      host: "pg.acme.example",
      database: "acme",
      schemaVersion: "20260907130000",
      lastVerifiedAt: "2026-09-07T00:00:00.000Z",
      rotatedAt: null,
      // Hostile / buggy extras — the ADR-042 §4 rule is that a read capability
      // never surfaces credentials, and the schema is the last line of defence.
      password: "s3cret",
      username: "acme_app",
      url: "postgres://acme_app:s3cret@pg.acme.example/acme",
    });
    expect(out).not.toHaveProperty("password");
    expect(out).not.toHaveProperty("username");
    expect(out).not.toHaveProperty("url");
    expect(JSON.stringify(out)).not.toContain("s3cret");
  });

  it("is governed: org-admin only, high sensitivity, deny by default, no billing gate", () => {
    expect(orgDataPlaneGet.scoped).toBe(false);
    expect(orgDataPlaneGet.sensitivity).toBe("high");
    expect(orgDataPlaneGet.defaultEffect).toBe("deny");
    expect(orgDataPlaneGet.noBillingGate).toBe(true);
    expect(orgDataPlaneGet.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgDataPlaneGet.agent).toEqual({
      requiresApproval: true,
      riskLevel: "high",
      category: "configuration",
    });
    expect(orgDataPlaneGet.surfaces).toEqual(["api", "mcp"]);
  });
});
