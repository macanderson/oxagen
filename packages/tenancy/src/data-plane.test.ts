// data-plane.test.ts — the ADR-042 organisation-scoped data-plane seam.
//
// Four invariants:
//   1. Pre-bootstrap, every organisation resolves to the SHARED plane — the
//      platform must behave exactly as it did before ADR-042.
//   2. An injected resolver is consulted for every (orgId, kind) pair.
//   3. `assertDataPlaneUsable` fails CLOSED on degraded/disabled and on a
//      dedicated binding with no config — never a silent shared fallback.
//   4. The thrown error carries the stable `data_plane_unavailable` code.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertDataPlaneUsable,
  clearDataPlaneResolver,
  DataPlaneUnavailableError,
  hasDataPlaneResolver,
  resolveDataPlane,
  setDataPlaneResolver,
  type DataPlaneBinding,
  type DataPlaneKind,
} from "./data-plane";

const ORG = "00000000-0000-0000-0000-00000000a111";

afterEach(() => clearDataPlaneResolver());

describe("default resolver", () => {
  it("reports no resolver injected before bootstrap", () => {
    expect(hasDataPlaneResolver()).toBe(false);
  });

  it.each<DataPlaneKind>(["postgres", "neo4j", "clickhouse"])(
    "resolves %s to the shared plane with no config",
    async (kind) => {
      const binding = await resolveDataPlane(ORG, kind);
      expect(binding).toEqual({
        orgId: ORG,
        kind,
        mode: "shared",
        status: "active",
        configDigest: null,
        schemaVersion: null,
      });
      expect(binding.config).toBeUndefined();
    },
  );

  it("never throws for an organisation with no binding row", async () => {
    await expect(resolveDataPlane(ORG, "postgres")).resolves.toMatchObject({
      mode: "shared",
    });
  });
});

describe("injected resolver", () => {
  it("is consulted with the organisation id and store kind", async () => {
    const resolver = vi.fn(
      async (orgId: string, kind: DataPlaneKind): Promise<DataPlaneBinding> => ({
        orgId,
        kind,
        mode: "dedicated",
        status: "active",
        config: {
          host: "pg.acme.example",
          port: 5432,
          database: "acme",
          username: "acme_app",
          password: "s3cret",
        },
        configDigest: "abc123",
      }),
    );
    setDataPlaneResolver(resolver);
    expect(hasDataPlaneResolver()).toBe(true);

    const binding = await resolveDataPlane(ORG, "postgres");
    expect(resolver).toHaveBeenCalledWith(ORG, "postgres");
    expect(binding.mode).toBe("dedicated");
    expect(binding.configDigest).toBe("abc123");
  });

  it("is dropped by clearDataPlaneResolver, restoring the shared default", async () => {
    setDataPlaneResolver(async (orgId, kind) => ({
      orgId,
      kind,
      mode: "dedicated",
      status: "disabled",
    }));
    clearDataPlaneResolver();
    await expect(resolveDataPlane(ORG, "neo4j")).resolves.toMatchObject({
      mode: "shared",
      status: "active",
    });
  });
});

describe("assertDataPlaneUsable — fail closed", () => {
  const base = { orgId: ORG, kind: "postgres" as const };

  it("passes an active shared plane", () => {
    expect(() =>
      assertDataPlaneUsable({ ...base, mode: "shared", status: "active" }),
    ).not.toThrow();
  });

  it.each(["degraded", "disabled"] as const)(
    "throws DataPlaneUnavailableError for a %s plane",
    (status) => {
      const call = () =>
        assertDataPlaneUsable({ ...base, mode: "shared", status });
      expect(call).toThrow(DataPlaneUnavailableError);
      try {
        call();
      } catch (err) {
        const e = err as DataPlaneUnavailableError;
        expect(e.code).toBe("data_plane_unavailable");
        expect(e.name).toBe("DataPlaneUnavailableError");
        expect(e.status).toBe(status);
        expect(e.orgId).toBe(ORG);
        expect(e.kind).toBe("postgres");
      }
    },
  );

  it("throws for a dedicated plane whose config is missing (resolver bug)", () => {
    expect(() =>
      assertDataPlaneUsable({ ...base, mode: "dedicated", status: "active" }),
    ).toThrow(/degraded/);
  });

  it("passes a dedicated plane that carries its config", () => {
    expect(() =>
      assertDataPlaneUsable({
        ...base,
        mode: "dedicated",
        status: "active",
        config: {
          host: "pg.acme.example",
          port: 5432,
          database: "acme",
          username: "u",
          password: "p",
        },
      }),
    ).not.toThrow();
  });

  it("never leaks the plane's credentials into the error message", () => {
    try {
      assertDataPlaneUsable({
        ...base,
        mode: "dedicated",
        status: "disabled",
        config: {
          host: "pg.acme.example",
          port: 5432,
          database: "acme",
          username: "acme_app",
          password: "super-secret-password",
        },
      });
      expect.unreachable("expected a throw");
    } catch (err) {
      expect((err as Error).message).not.toContain("super-secret-password");
    }
  });
});
