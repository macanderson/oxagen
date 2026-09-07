import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  loadDataPlaneBinding: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ query: { dataPlanes: { findFirst: mocks.findFirst } } }),
  };
});
vi.mock("@oxagen/database/data-plane", () => ({
  loadDataPlaneBinding: mocks.loadDataPlaneBinding,
}));

import {
  hostFor,
  orgDataPlaneGetHandler,
  toBindingDto,
} from "./org.data_plane.get";
import { orgDataPlaneGet } from "@oxagen/oxagen/contracts/org.data_plane.get";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

beforeEach(() => {
  mocks.findFirst.mockReset();
  mocks.loadDataPlaneBinding.mockReset();
});

describe("hostFor", () => {
  it("returns the Postgres host verbatim", () => {
    expect(hostFor("postgres", { host: "pg.acme.example" })).toBe(
      "pg.acme.example",
    );
  });

  it("extracts host:port from a neo4j URI without userinfo", () => {
    expect(
      hostFor("neo4j", { uri: "neo4j+s://neo4j:s3cret@graph.acme.example:7687" }),
    ).toBe("graph.acme.example:7687");
  });

  it("extracts host from a ClickHouse URL", () => {
    expect(hostFor("clickhouse", { url: "https://ch.acme.example:8443" })).toBe(
      "ch.acme.example:8443",
    );
  });

  it("returns null for an unparseable endpoint rather than throwing", () => {
    expect(hostFor("clickhouse", { url: "not a url" })).toBeNull();
  });

  it("returns null when there is no config at all", () => {
    expect(hostFor("postgres", undefined)).toBeNull();
  });
});

describe("toBindingDto", () => {
  it("maps a missing row to the shared plane (absence IS the default)", () => {
    expect(toBindingDto({ kind: "neo4j", row: null })).toEqual({
      kind: "neo4j",
      mode: "shared",
      status: "active",
      host: null,
      database: null,
      schemaVersion: null,
      lastVerifiedAt: null,
      rotatedAt: null,
    });
  });

  it("never exposes the endpoint of a SHARED plane", () => {
    const dto = toBindingDto({
      kind: "postgres",
      row: {
        mode: "shared",
        status: "active",
        schemaVersion: null,
        lastVerifiedAt: null,
        rotatedAt: null,
      },
      config: { host: "platform-internal.example", database: "oxagen" },
    });
    expect(dto.host).toBeNull();
    expect(dto.database).toBeNull();
  });

  it("serialises timestamps as ISO-8601 and narrows an unknown status to disabled", () => {
    const dto = toBindingDto({
      kind: "clickhouse",
      row: {
        mode: "dedicated",
        status: "nonsense",
        schemaVersion: "v3",
        lastVerifiedAt: new Date("2026-09-07T00:00:00.000Z"),
        rotatedAt: new Date("2026-09-06T00:00:00.000Z"),
      },
      config: { url: "https://ch.acme.example:8443", database: "acme_events" },
    });
    expect(dto.status).toBe("disabled");
    expect(dto.lastVerifiedAt).toBe("2026-09-07T00:00:00.000Z");
    expect(dto.rotatedAt).toBe("2026-09-06T00:00:00.000Z");
    expect(dto.database).toBe("acme_events");
  });
});

describe("org.data_plane.get handler", () => {
  it("returns the shared plane and never opens an envelope when no row exists", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    const out = await orgDataPlaneGetHandler({ kind: "postgres" }, CTX);
    expect(out.mode).toBe("shared");
    expect(mocks.loadDataPlaneBinding).not.toHaveBeenCalled();
  });

  it("does not decrypt for a shared row", async () => {
    mocks.findFirst.mockResolvedValue({
      mode: "shared",
      status: "active",
      schemaVersion: null,
      lastVerifiedAt: null,
      rotatedAt: null,
    });
    await orgDataPlaneGetHandler({ kind: "clickhouse" }, CTX);
    expect(mocks.loadDataPlaneBinding).not.toHaveBeenCalled();
  });

  it("decrypts a dedicated row and returns ONLY host + database", async () => {
    mocks.findFirst.mockResolvedValue({
      mode: "dedicated",
      status: "active",
      schemaVersion: "20260907130000",
      lastVerifiedAt: null,
      rotatedAt: new Date("2026-09-07T00:00:00.000Z"),
    });
    mocks.loadDataPlaneBinding.mockResolvedValue({
      config: {
        host: "pg.acme.example",
        port: 6543,
        database: "acme",
        username: "acme_app",
        password: "super-secret",
      },
    });
    const out = await orgDataPlaneGetHandler({ kind: "postgres" }, CTX);
    expect(out).toEqual({
      kind: "postgres",
      mode: "dedicated",
      status: "active",
      host: "pg.acme.example",
      database: "acme",
      schemaVersion: "20260907130000",
      lastVerifiedAt: null,
      rotatedAt: "2026-09-07T00:00:00.000Z",
    });
    // ADR-042 §4 — the raw DSN is never returned by any read capability.
    expect(JSON.stringify(out)).not.toContain("super-secret");
    expect(JSON.stringify(out)).not.toContain("acme_app");
    expect(JSON.stringify(out)).not.toContain("6543");
  });

  it("returns a payload the contract's output schema accepts", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    const out = await orgDataPlaneGetHandler({ kind: "neo4j" }, CTX);
    expect(() => orgDataPlaneGet.output.parse(out)).not.toThrow();
  });

  it("surfaces a degraded plane so the operator can see why writes fail", async () => {
    mocks.findFirst.mockResolvedValue({
      mode: "shared",
      status: "degraded",
      schemaVersion: null,
      lastVerifiedAt: null,
      rotatedAt: null,
    });
    const out = await orgDataPlaneGetHandler({ kind: "neo4j" }, CTX);
    expect(out.status).toBe("degraded");
  });
});
