// tenant.executed-cypher.test.ts — the seam re-checks the string it EXECUTES.
//
// `applyGraphScope` rewrites the query after every guard has read it
// (`clampVarLengthHops`, `clampLimits`), and `session.run` is handed the
// rewritten form. `tenant.ts` therefore re-asserts the tenancy anchor on
// `applied.cypher` whenever it differs from the authored text.
//
// No clamp can currently produce an unanchored rewrite — their whole output
// alphabet is digits, `*` and `..` between an existing `[` and `]`, plus a
// trailing newline and `LIMIT <digits>` — which is exactly why that re-check
// needs a test of its own. `tenant.scope-guard.test.ts` pins the property over
// every real clamp branch; this file pins the WIRING, by substituting a rewrite
// step that does break the anchor and asserting the seam refuses to run it.
// Without that, the re-check is a line no test can distinguish from its absence.
import { beforeEach, describe, expect, it, vi } from "vitest";

const run = vi.fn(
  async (_cypher: string, _params?: Record<string, unknown>) => ({
    records: [],
  }),
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

const applyGraphScope = vi.fn();
vi.mock("./graph-scope", async () => {
  const actual =
    await vi.importActual<typeof import("./graph-scope")>("./graph-scope");
  return {
    ...actual,
    applyGraphScope: (...a: unknown[]) => applyGraphScope(...a),
  };
});

import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "./tenant";

const ORG = "00000000-0000-0000-0000-00000000a111";
const WS = "00000000-0000-0000-0000-00000000b222";
const ANCHORED = "MATCH (n) WHERE n.orgId = $orgId RETURN n";

/** Drive the seam with a scope, and report what happened. */
async function runThroughSeam(
  cypher: string,
): Promise<{ threw: string | null; sent: string | undefined }> {
  run.mockClear();
  return runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
    try {
      await scopedSession({ budget: { maxNodes: 10 } }).run(cypher);
      return { threw: null, sent: run.mock.calls[0]?.[0] };
    } catch (err) {
      return { threw: (err as Error).name, sent: run.mock.calls[0]?.[0] };
    }
  });
}

describe("the seam re-checks the Cypher it executes", () => {
  beforeEach(() => {
    applyGraphScope.mockReset();
  });

  it("refuses a rewrite that dropped the anchor, and runs nothing", async () => {
    // A rewrite step that strips the anchor. The authored text is scoped and
    // passes the first guard; only the re-check can catch this.
    applyGraphScope.mockReturnValue({
      cypher: "MATCH (n) RETURN n\nLIMIT 10",
      params: {},
    });
    const { threw, sent } = await runThroughSeam(ANCHORED);
    expect(threw).toBe("TenantScopeError");
    expect(sent).toBeUndefined();
  });

  it("refuses a rewrite that demoted the anchor to a projection", async () => {
    // The subtler shape: the token is still present, so a re-check that tested
    // the raw text rather than the filtering positions would pass it.
    applyGraphScope.mockReturnValue({
      cypher: "MATCH (n) RETURN n, n.orgId = $orgId AS mine\nLIMIT 10",
      params: {},
    });
    const { threw, sent } = await runThroughSeam(ANCHORED);
    expect(threw).toBe("TenantScopeError");
    expect(sent).toBeUndefined();
  });

  it("runs a rewrite that kept the anchor, and sends the REWRITTEN text", async () => {
    const rewritten = `${ANCHORED}\nLIMIT 10`;
    applyGraphScope.mockReturnValue({ cypher: rewritten, params: {} });
    const { threw, sent } = await runThroughSeam(ANCHORED);
    expect(threw).toBeNull();
    expect(sent).toBe(rewritten);
  });

  it("skips the re-check when no clamp changed anything", async () => {
    // Identity, not re-validation, is what makes the common path free. An
    // unchanged string was already checked once and must not be charged twice.
    applyGraphScope.mockReturnValue({ cypher: ANCHORED, params: {} });
    const { threw, sent } = await runThroughSeam(ANCHORED);
    expect(threw).toBeNull();
    expect(sent).toBe(ANCHORED);
  });

  it("is discriminating: the same rewrite passes when it is the authored text", async () => {
    // Proves the refusals above come from the RE-check and not from the first
    // guard: hand the seam the unanchored text as-authored and the first guard
    // is what stops it — a different error path, asserted by the absence of any
    // call to applyGraphScope at all.
    applyGraphScope.mockReturnValue({ cypher: ANCHORED, params: {} });
    const { threw } = await runThroughSeam("MATCH (n) RETURN n");
    expect(threw).toBe("TenantScopeError");
    expect(applyGraphScope).not.toHaveBeenCalled();
  });
});
