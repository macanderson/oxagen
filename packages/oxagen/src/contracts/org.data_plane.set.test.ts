import { describe, expect, it } from "vitest";
import {
  orgDataPlaneSet,
  orgDataPlaneSetInputObject,
} from "./org.data_plane.set";
import { getCapability } from "../registry";

const PG = {
  host: "pg.acme.example",
  port: 6543,
  database: "acme",
  username: "acme_app",
  password: "s3cret",
};
const NEO = {
  uri: "neo4j+s://graph.acme.example",
  username: "neo4j",
  password: "s3cret",
  database: "acme",
};
const CH = {
  url: "https://ch.acme.example:8443",
  username: "acme",
  password: "s3cret",
  database: "acme_events",
};

describe("org.data_plane.set capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("set_data_plane")).toBe(orgDataPlaneSet);
  });

  it("exposes the base object so the MCP tool can read .shape", () => {
    expect(Object.keys(orgDataPlaneSetInputObject.shape).sort()).toEqual([
      "config",
      "kind",
      "mode",
    ]);
  });

  it("accepts mode:shared with no config", () => {
    const parsed = orgDataPlaneSet.input.parse({
      kind: "postgres",
      mode: "shared",
    });
    expect(parsed.config).toBeUndefined();
  });

  it("rejects a config alongside mode:shared", () => {
    expect(() =>
      orgDataPlaneSet.input.parse({
        kind: "postgres",
        mode: "shared",
        config: PG,
      }),
    ).toThrow(/config must be omitted/);
  });

  it("rejects mode:dedicated without a config", () => {
    expect(() =>
      orgDataPlaneSet.input.parse({ kind: "neo4j", mode: "dedicated" }),
    ).toThrow(/config is required/);
  });

  it("accepts a matching config for each kind", () => {
    expect(
      orgDataPlaneSet.input.parse({
        kind: "postgres",
        mode: "dedicated",
        config: PG,
      }).config,
    ).toMatchObject({ host: "pg.acme.example", port: 6543, ssl: true });
    expect(
      orgDataPlaneSet.input.parse({
        kind: "neo4j",
        mode: "dedicated",
        config: NEO,
      }).config,
    ).toMatchObject({ uri: "neo4j+s://graph.acme.example" });
    expect(
      orgDataPlaneSet.input.parse({
        kind: "clickhouse",
        mode: "dedicated",
        config: CH,
      }).config,
    ).toMatchObject({ url: "https://ch.acme.example:8443" });
  });

  it("rejects a config that does not match the declared kind", () => {
    expect(() =>
      orgDataPlaneSet.input.parse({
        kind: "clickhouse",
        mode: "dedicated",
        config: NEO,
      }),
    ).toThrow(/does not match the clickhouse plane shape/);
  });

  it("defaults the Postgres port and forces TLS on unless opted out", () => {
    const parsed = orgDataPlaneSet.input.parse({
      kind: "postgres",
      mode: "dedicated",
      config: { ...PG, port: undefined, ssl: undefined },
    });
    expect(parsed.config).toMatchObject({ port: 5432, ssl: true });
    const insecure = orgDataPlaneSet.input.parse({
      kind: "postgres",
      mode: "dedicated",
      config: { ...PG, ssl: false },
    });
    expect(insecure.config).toMatchObject({ ssl: false });
  });

  it("rejects a Neo4j URI with the wrong scheme", () => {
    expect(() =>
      orgDataPlaneSet.input.parse({
        kind: "neo4j",
        mode: "dedicated",
        config: { ...NEO, uri: "https://graph.acme.example" },
      }),
    ).toThrow();
  });

  it("returns the same REDACTED binding shape as the read capability", () => {
    const out = orgDataPlaneSet.output.parse({
      kind: "postgres",
      mode: "dedicated",
      status: "active",
      host: "pg.acme.example",
      database: "acme",
      schemaVersion: null,
      lastVerifiedAt: null,
      rotatedAt: "2026-09-07T00:00:00.000Z",
      password: "s3cret",
    });
    expect(out).not.toHaveProperty("password");
    expect(JSON.stringify(out)).not.toContain("s3cret");
  });

  it("is governed: org-admin only, high sensitivity, approval required, no billing gate", () => {
    expect(orgDataPlaneSet.scoped).toBe(false);
    expect(orgDataPlaneSet.sensitivity).toBe("high");
    expect(orgDataPlaneSet.defaultEffect).toBe("deny");
    expect(orgDataPlaneSet.noBillingGate).toBe(true);
    expect(orgDataPlaneSet.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgDataPlaneSet.agent).toEqual({
      requiresApproval: true,
      riskLevel: "high",
      category: "configuration",
    });
    expect(orgDataPlaneSet.layers).toEqual([
      "schema",
      "api",
      "mcp",
      "unit",
      "docs",
    ]);
  });
});
