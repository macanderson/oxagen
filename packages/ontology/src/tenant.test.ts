import { describe, expect, it, vi } from "vitest";

const run = vi.fn(
  async (
    _cypher: string,
    _params?: Record<string, unknown>,
    _cfg?: { timeout: number },
  ) => ({ records: [] }),
);
const close = vi.fn(async () => undefined);
const executeRead = vi.fn(
  async (
    work: (tx: { run: typeof run }) => Promise<unknown>,
    _config?: { timeout: number },
  ) => work({ run }),
);
const executeWrite = vi.fn(
  async (
    work: (tx: { run: typeof run }) => Promise<unknown>,
    _config?: { timeout: number },
  ) => work({ run }),
);
vi.mock("./client", () => ({
  session: () => ({ run, close, executeRead, executeWrite }),
}));

import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "./tenant";
import {
  SCOPE_LABELS_PARAM,
  SCOPE_REL_TYPES_PARAM,
  type GraphScope,
} from "./graph-scope";

const ORG = "00000000-0000-0000-0000-00000000a111";
const WS = "00000000-0000-0000-0000-00000000b222";

describe("scopedSession", () => {
  it("requires a scope", () => {
    expect(() => scopedSession()).toThrow(/tenant scope/);
  });

  it("injects $orgId/$workspaceId into scoped Cypher", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      const s = scopedSession();
      await s.run("MATCH (n) WHERE n.orgId = $orgId RETURN n", { extra: 1 });
    });
    expect(run).toHaveBeenCalledWith(
      "MATCH (n) WHERE n.orgId = $orgId RETURN n",
      { extra: 1, orgId: ORG, workspaceId: WS },
    );
  });

  it("rejects Cypher that does not bind the tenant", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      const s = scopedSession();
      await expect(s.run("MATCH (n) RETURN n")).rejects.toThrow(
        /must bind the tenant/,
      );
    });
  });
});

describe("scopedSession with GraphScope", () => {
  const inScope = <T>(
    scope: GraphScope | undefined,
    fn: (s: ReturnType<typeof scopedSession>) => Promise<T>,
  ) =>
    runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      fn(scopedSession(scope)),
    );

  it("pass-through: an undefined scope injects no scope params and uses a 2-arg run", async () => {
    run.mockClear();
    await inScope(undefined, (s) =>
      s.run("MATCH (n) WHERE n.orgId = $orgId RETURN n", { a: 1 }),
    );
    const call = run.mock.calls[0]!;
    expect(call).toHaveLength(2);
    expect(call[1]).toEqual({ a: 1, orgId: ORG, workspaceId: WS });
    expect(call[1]).not.toHaveProperty(SCOPE_LABELS_PARAM);
  });

  it("injects the label allow-list for a labels-constrained scope", async () => {
    run.mockClear();
    await inScope({ labels: ["Doc"] }, (s) =>
      s.run(
        `MATCH (n) WHERE n.orgId = $orgId AND any(l IN labels(n) WHERE l IN $${SCOPE_LABELS_PARAM}) RETURN n`,
      ),
    );
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining(`$${SCOPE_LABELS_PARAM}`),
      expect.objectContaining({
        [SCOPE_LABELS_PARAM]: ["Doc"],
        orgId: ORG,
        workspaceId: WS,
      }),
    );
  });

  it("injects the relationship-type allow-list", async () => {
    run.mockClear();
    await inScope({ relationshipTypes: ["REFERS_TO"] }, (s) =>
      s.run(
        `MATCH (a)-[r]->(b) WHERE a.orgId = $orgId AND type(r) IN $${SCOPE_REL_TYPES_PARAM} RETURN r`,
      ),
    );
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining(`$${SCOPE_REL_TYPES_PARAM}`),
      expect.objectContaining({ [SCOPE_REL_TYPES_PARAM]: ["REFERS_TO"] }),
    );
  });

  it("clamps an existing larger LIMIT down to maxNodes", async () => {
    run.mockClear();
    await inScope({ budget: { maxNodes: 100 } }, (s) =>
      s.run("MATCH (n) WHERE n.orgId = $orgId RETURN n LIMIT 5000"),
    );
    expect(run.mock.calls[0]![0]).toContain("LIMIT 100");
    expect(run.mock.calls[0]![0]).not.toContain("5000");
  });

  it("preserves a smaller existing LIMIT", async () => {
    run.mockClear();
    await inScope({ budget: { maxNodes: 100 } }, (s) =>
      s.run("MATCH (n) WHERE n.orgId = $orgId RETURN n LIMIT 10"),
    );
    expect(run.mock.calls[0]![0]).toContain("LIMIT 10");
  });

  it("appends a LIMIT when maxNodes is set and none is present", async () => {
    run.mockClear();
    await inScope({ budget: { maxNodes: 42 } }, (s) =>
      s.run("MATCH (n) WHERE n.orgId = $orgId RETURN n"),
    );
    expect(run.mock.calls[0]![0]).toMatch(/LIMIT 42/);
  });

  it("clamps variable-length hops down to maxHops", async () => {
    run.mockClear();
    await inScope({ budget: { maxHops: 2 } }, (s) =>
      s.run("MATCH (a)-[r*1..9]->(b) WHERE a.orgId = $orgId RETURN b"),
    );
    expect(run.mock.calls[0]![0]).toContain("[r*1..2]");
  });

  it("passes a per-query transaction timeout for maxTraversalMs", async () => {
    run.mockClear();
    await inScope({ budget: { maxTraversalMs: 250 } }, (s) =>
      s.run("MATCH (n) WHERE n.orgId = $orgId RETURN n"),
    );
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining("RETURN n"),
      expect.objectContaining({ orgId: ORG }),
    );
    expect(executeRead).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 250,
    });
  });

  it("rejects write clauses under read mode (defense in depth)", async () => {
    await expect(
      inScope({ mode: "read" }, (s) =>
        s.run("MATCH (n) WHERE n.orgId = $orgId DETACH DELETE n"),
      ),
    ).rejects.toThrow(/read-mode graph scope/);
    expect(run).not.toHaveBeenCalledWith(
      expect.stringContaining("DELETE"),
      expect.anything(),
    );
  });

  it("bypass guard: a labels-constrained query without the marker throws", async () => {
    await expect(
      inScope({ labels: ["Doc"] }, (s) =>
        s.run("MATCH (n) WHERE n.orgId = $orgId RETURN n"),
      ),
    ).rejects.toThrow(/\$__scopeLabels/);
  });

  it("handles a tricky UNION + WITH chain with markers and per-branch clamps", async () => {
    run.mockClear();
    const cypher =
      `MATCH (a) WHERE a.orgId = $orgId AND any(l IN labels(a) WHERE l IN $${SCOPE_LABELS_PARAM}) ` +
      `WITH a ORDER BY a.rank LIMIT 900 RETURN a.publicId AS id LIMIT 900 ` +
      `UNION ` +
      `MATCH (b) WHERE b.orgId = $orgId AND any(l IN labels(b) WHERE l IN $${SCOPE_LABELS_PARAM}) ` +
      `RETURN b.publicId AS id LIMIT 800`;
    await inScope({ labels: ["Doc"], budget: { maxNodes: 100 } }, (s) =>
      s.run(cypher),
    );
    const sent = run.mock.calls[0]![0];
    expect(sent).not.toMatch(/LIMIT (900|800)/);
    expect(sent.match(/LIMIT 100/g)?.length).toBe(3);
  });

  it("supports the parameterized-labels builder form", async () => {
    run.mockClear();
    await inScope({ labels: ["Doc", "Case"] }, (s) =>
      s.run(
        `MATCH (n) WHERE n.orgId = $orgId AND any(lbl IN labels(n) WHERE lbl IN $${SCOPE_LABELS_PARAM}) RETURN n`,
      ),
    );
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining(`$${SCOPE_LABELS_PARAM}`),
      expect.objectContaining({ [SCOPE_LABELS_PARAM]: ["Doc", "Case"] }),
    );
  });
});

describe("graph transaction retry safety", () => {
  it("retries reads but never sends writes or unknown procedures to managed transactions", async () => {
    executeRead.mockClear();
    executeWrite.mockClear();
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      const s = scopedSession();
      await s.run("MATCH (n {orgId: $orgId}) RETURN n");
      await s.run(
        "MATCH (owner {orgId: $orgId}) CREATE (n:Node {orgId: $orgId, id: randomUUID()}) RETURN n",
      );
      await s.run("MATCH (n {orgId: $orgId}) CALL custom.mutate(n) RETURN n");
    });
    expect(executeRead).toHaveBeenCalledTimes(1);
    expect(executeWrite).not.toHaveBeenCalled();
  });

  it("propagates a transient write error without replaying the mutation", async () => {
    const failure = Object.assign(new Error("commit acknowledgement lost"), {
      code: "Neo.TransientError.Transaction.Terminated",
    });
    run.mockClear();
    executeWrite.mockClear();
    run.mockRejectedValueOnce(failure);
    await expect(
      runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
        await scopedSession().run(
          "MATCH (owner {orgId: $orgId}) CREATE (n:Node {orgId: $orgId, id: randomUUID()}) RETURN n",
        );
      }),
    ).rejects.toBe(failure);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1]).toEqual({ orgId: ORG, workspaceId: WS });
    expect(executeWrite).not.toHaveBeenCalled();
  });

  it("keeps scoped write deadlines on the non-retrying transaction", async () => {
    run.mockClear();
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      await scopedSession({ budget: { maxTraversalMs: 250 } }).run(
        "MATCH (n) WHERE n.orgId = $orgId SET n.count = n.count + 1 RETURN n",
      );
    });
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining("SET n.count"),
      expect.objectContaining({ orgId: ORG, workspaceId: WS }),
      { timeout: 250 },
    );
  });
});
