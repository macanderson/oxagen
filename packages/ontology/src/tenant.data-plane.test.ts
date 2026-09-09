// tenant.data-plane.test.ts — scopedSession against the ADR-042 seam.
//
// Invariants:
//   1. Default (no resolver) → the shared driver, byte-for-byte as before.
//   2. A dedicated binding opens the organisation's own driver, keyed by
//      (orgId, configDigest), and still injects $orgId/$workspaceId.
//   3. A degraded/disabled graph plane throws DataPlaneUnavailableError and
//      opens NO session at all — never a shared-plane fallback.
//   4. Plane resolution is LAZY: constructing a session opens nothing, and
//      close() on an unused session is a no-op.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sharedSession: vi.fn(),
  dedicatedSession: vi.fn(),
  run: vi.fn(async () => ({ records: [] })),
  close: vi.fn(async () => undefined),
}));

vi.mock("./client", () => ({
  session: () => {
    mocks.sharedSession();
    return { run: mocks.run, close: mocks.close };
  },
}));
vi.mock("./data-plane-driver", () => ({
  dedicatedSession: (args: unknown) => {
    mocks.dedicatedSession(args);
    return { run: mocks.run, close: mocks.close };
  },
}));
// The breaker would otherwise need real telemetry env; pass-through here.
vi.mock("@oxagen/telemetry", () => ({
  neo4jBreaker: () => ({ exec: <T>(fn: () => T) => fn() }),
}));

import {
  clearDataPlaneResolver,
  DataPlaneUnavailableError,
  runInTenantScope,
  setDataPlaneResolver,
  type DataPlaneStatus,
} from "@oxagen/tenancy";
import { scopedSession } from "./tenant";

const ORG = "00000000-0000-0000-0000-00000000a111";
const WS = "00000000-0000-0000-0000-00000000b222";
const CYPHER = "MATCH (n) WHERE n.orgId = $orgId RETURN n";

const NEO_CONFIG = {
  uri: "neo4j+s://graph.acme.example",
  username: "neo4j",
  password: "s3cret",
  database: "acme",
};

beforeEach(() => {
  mocks.sharedSession.mockClear();
  mocks.dedicatedSession.mockClear();
  mocks.run.mockClear();
  mocks.close.mockClear();
});

afterEach(() => clearDataPlaneResolver());

describe("scopedSession — shared plane (default)", () => {
  it("uses the shared driver when no resolver is injected", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      const s = scopedSession();
      await s.run(CYPHER);
    });
    expect(mocks.sharedSession).toHaveBeenCalledTimes(1);
    expect(mocks.dedicatedSession).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalledWith(CYPHER, {
      orgId: ORG,
      workspaceId: WS,
    });
  });

  it("opens the underlying session lazily and only once", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      const s = scopedSession();
      expect(mocks.sharedSession).not.toHaveBeenCalled();
      await s.run(CYPHER);
      await s.run(CYPHER);
      expect(mocks.sharedSession).toHaveBeenCalledTimes(1);
    });
  });

  it("close() on a session that never ran opens and closes nothing", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      await scopedSession().close();
    });
    expect(mocks.sharedSession).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("close() after a run closes the opened session", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      const s = scopedSession();
      await s.run(CYPHER);
      await s.close();
    });
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("rejects unscoped Cypher BEFORE resolving a plane", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      await expect(scopedSession().run("MATCH (n) RETURN n")).rejects.toThrow(
        /must filter by \$orgId/,
      );
    });
    expect(mocks.sharedSession).not.toHaveBeenCalled();
  });
});

describe("scopedSession — dedicated plane", () => {
  beforeEach(() => {
    setDataPlaneResolver(async (orgId, kind) => ({
      orgId,
      kind,
      mode: "dedicated",
      status: "active",
      config: NEO_CONFIG,
      configDigest: "digest-1",
    }));
  });

  it("opens the organisation's own driver, keyed by org + digest", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      await scopedSession().run(CYPHER);
    });
    expect(mocks.dedicatedSession).toHaveBeenCalledWith({
      orgId: ORG,
      config: NEO_CONFIG,
      configDigest: "digest-1",
    });
    expect(mocks.sharedSession).not.toHaveBeenCalled();
  });

  it("still injects the tenant params on a dedicated plane", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      await scopedSession().run(CYPHER, { extra: 1 });
    });
    expect(mocks.run).toHaveBeenCalledWith(CYPHER, {
      extra: 1,
      orgId: ORG,
      workspaceId: WS,
    });
  });
});

describe("scopedSession — fail closed", () => {
  it.each<DataPlaneStatus>(["degraded", "disabled"])(
    "throws for a %s graph plane and opens no session",
    async (status) => {
      setDataPlaneResolver(async (orgId, kind) => ({
        orgId,
        kind,
        mode: "dedicated",
        status,
        config: NEO_CONFIG,
      }));
      await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
        await expect(scopedSession().run(CYPHER)).rejects.toThrow(
          DataPlaneUnavailableError,
        );
      });
      expect(mocks.sharedSession).not.toHaveBeenCalled();
      expect(mocks.dedicatedSession).not.toHaveBeenCalled();
    },
  );
});
