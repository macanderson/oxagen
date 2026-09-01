/**
 * The witness: a Stella agent asks the business ontology a question and gets an
 * answer back.
 *
 * ## What is real here and what is not
 *
 * REAL: the capability registry (the shipped `query_ontology` contract, its Zod
 * input schema, its risk metadata), `materializeTools`' filtering and tool
 * construction, the mutating classification that decides Stella's dispatch bit,
 * and `@oxagen/agent-runner/stella`'s `toToolSchemas` / `executeToolRequest` —
 * the two functions that turn a host `ToolSet` into what the engine is
 * advertised and turn an engine `tool_request` back into a host tool call.
 *
 * FAKED: `invoke()` (a graph read needs Neo4j) and the tenancy/telemetry/MCP
 * seams around it. The assertion is that the call ARRIVES at `invoke` with the
 * run's own context and `surface: "agent"` — which is the design's whole claim:
 * the engine holds no credential, and every graph read re-enters the host where
 * IAM, billing, entitlement and the decision-rules gate live.
 *
 * The sidecar transport is deliberately not exercised — `@oxagen/agent-runner`
 * already covers the SSE stream and reverse-request dispatch against a scripted
 * engine. What nothing covered until now is the COMPOSITION: that a real,
 * shipped ontology contract survives materialization, reaches the engine as a
 * concurrent-dispatchable read, and answers.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeToolRequest,
  mutatingToolSet,
  toToolSchemas,
} from "@oxagen/agent-runner/stella";
import type { CapabilityContext } from "../types";

// ── Seams the graph read does not need, stubbed so the test is hermetic ──────

const dbMocks = vi.hoisted(() => {
  const schema = {
    mcpServers: { orgId: "mcp.orgId" },
    pluginInstalledPlugins: { id: "listing.id" },
    pluginOrgDenylist: { orgId: "deny.orgId" },
  };
  const builder = {
    select: () => ({
      from: () => {
        const chain = { innerJoin: () => chain, where: async () => [] };
        return chain;
      },
    }),
  };
  return { schema, db: vi.fn((): unknown => builder) };
});
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: dbMocks.db,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(dbMocks.db()),
    schema: dbMocks.schema,
  };
});

vi.mock("@oxagen/plugins", () => ({
  getWorkspaceSecret: vi.fn(async () => null),
  markCredentialNeedsReauth: vi.fn(async () => undefined),
  listEntitledCapabilityPluginIds: vi.fn(async () => new Set<string>()),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: async <T>(
    _scope: unknown,
    fn: () => Promise<T> | T,
  ): Promise<T> => fn(),
  getScope: () => null,
  requireScope: () => ({ orgId: "org", workspaceId: "ws" }),
}));

vi.mock("@oxagen/sandbox", () => ({ isSandboxAvailable: vi.fn(() => false) }));

// Partial, and both writers stubbed. Partial because @oxagen/billing reads
// other exports of this module at import time, so replacing the whole surface
// breaks a module the tool path pulls in. Both writers because the tool path
// makes TWO ClickHouse writes per call — insertToolInvocation from
// materializeTools and insertExecutionLogs from the beforeTool/afterTool hooks
// — and a test that reaches a real endpoint is neither hermetic nor honest
// about what it proved.
vi.mock("@oxagen/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/telemetry")>()),
  insertToolInvocation: vi.fn(async () => undefined),
  insertExecutionLogs: vi.fn(async () => undefined),
}));

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class extends Error {},
}));

vi.mock("../dispatch/mcp-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("../dispatch/mcp-client")>();
  return {
    ...real,
    connectMcp: vi.fn(async () => ({})),
    listMcpToolDescriptors: vi.fn(async () => []),
  };
});

// ── The one seam the assertions are about ───────────────────────────────────

const kernel = vi.hoisted(() => ({
  invoke: vi.fn(
    async (
      _name: string,
      _input: unknown,
      _ctx?: unknown,
      _opts?: unknown,
    ) => ({
      startNode: {
        nodeId: "n_acme",
        label: "Company",
        displayName: "Acme Corp",
        description: null,
        depth: 0,
      },
      nodes: [
        {
          nodeId: "n_acme",
          label: "Company",
          displayName: "Acme Corp",
          description: null,
          depth: 0,
        },
        {
          nodeId: "n_churn",
          label: "Issue",
          displayName: "Renewal at risk",
          description: null,
          depth: 1,
        },
      ],
      edges: [
        { fromNodeId: "n_acme", toNodeId: "n_churn", edgeType: "HAS_ISSUE" },
      ],
      truncated: false,
    }),
  ),
}));
vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: kernel.invoke,
  authorizeExternalCapability: vi.fn(async () => ({
    allowed: true,
    outcome: "allow",
    reason: null,
    decision: null,
  })),
}));

// ── The run ─────────────────────────────────────────────────────────────────

const CTX: CapabilityContext = {
  orgId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  userId: null,
  apiKeyId: null,
  requestId: "run_witness",
  surface: "runner",
  messageId: null,
} as CapabilityContext;

/**
 * A narrowed run — exactly the shape that loses the graph today. Its declared
 * allowlist names one unrelated capability, so without the opt-in the ontology
 * is absent from the tool set the engine is advertised.
 */
const DECLARED_ALLOWLIST = new Set(["get_budget_policy"]);

type Materialized = Awaited<ReturnType<typeof stellaToolSchemasFor>>;

async function stellaToolSchemasFor(ontologyEnabled: boolean) {
  const { materializeTools } = await import("./materialize-tools");
  const { withOntologyReads } = await import("./ontology-tools");
  const { tools, nameMap, mutatingToolNames } = await materializeTools(CTX, {
    allowlist: withOntologyReads(DECLARED_ALLOWLIST, ontologyEnabled),
  });
  const schemas = await toToolSchemas(
    tools,
    mutatingToolSet(mutatingToolNames),
  );
  return { tools, nameMap, schemas };
}

/**
 * Materialized once for the file, not per test.
 *
 * Building this loads the real registry — 340 contracts and their Zod schemas —
 * which costs over a second on an idle machine and considerably more when the
 * rest of the package's suite is running beside it. Per-test it blew the 5s
 * default under full-suite contention while passing in isolation, which is the
 * worst failure shape a test can have: green when you check it, red in CI.
 *
 * Safe to share because every assertion below reads the tool set; the one test
 * that changes behaviour does it on the `invoke` mock, which the tool closures
 * consult at call time.
 */
let optedIn: Materialized;
let notOptedIn: Materialized;

describe("a Stella agent asking the ontology", () => {
  beforeAll(async () => {
    optedIn = await stellaToolSchemasFor(true);
    notOptedIn = await stellaToolSchemasFor(false);
  }, 60_000);

  beforeEach(() => {
    kernel.invoke.mockClear();
  });

  it("advertises the graph reads to the engine when the run opts in", () => {
    const names = new Set(optedIn.schemas.map((s) => s.name));
    expect(names.has("query_ontology")).toBe(true);
    expect(names.has("get_ontology_neighbors")).toBe(true);
    expect(names.has("search_graph")).toBe(true);
    // The run's own declared tool is still there — the opt-in widens, never
    // replaces.
    expect(names.has("get_budget_policy")).toBe(true);
  });

  it("withholds them from a narrowed run that did not opt in", () => {
    // This is main's behaviour for an allowlisted run, and the reason the
    // opt-in exists rather than the set being unconditional.
    const names = new Set(notOptedIn.schemas.map((s) => s.name));
    expect(names.has("query_ontology")).toBe(false);
    expect(names.has("get_budget_policy")).toBe(true);
  });

  it("marks them read_only so the engine may dispatch them concurrently", () => {
    for (const name of [
      "query_ontology",
      "get_ontology_neighbors",
      "search_graph",
    ]) {
      const schema = optedIn.schemas.find((s) => s.name === name);
      expect(schema, `${name} was not advertised`).toBeDefined();
      expect(schema!.read_only, `${name} would serialize`).toBe(true);
    }
  });

  it("advertises the contract's real input schema, not a placeholder", () => {
    const schema = optedIn.schemas.find((s) => s.name === "query_ontology")!;
    const properties = schema.input_schema.properties as Record<
      string,
      unknown
    >;
    // The shipped contract's own fields — a model that cannot see
    // `startNodeId` cannot traverse.
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(["startNodeId", "edgeTypes", "direction"]),
    );
    expect(schema.description).toContain("Multi-hop traversal");
  });

  it("answers a tool_request by re-entering invoke() with the run's own context", async () => {
    const output = await executeToolRequest(
      optedIn.tools,
      "query_ontology",
      { startNodeId: "n_acme", direction: "out", maxDepth: 2, limit: 100 },
      { toolCallId: "stella-query_ontology-0" },
    );

    // The engine got an answer it can hand the model. `ToolOutput` is a
    // discriminated union, so asserting the arm is the assertion.
    expect("ok" in output, `the graph read failed: ${JSON.stringify(output)}`)
      .toBe(true);
    const content = (output as { ok: { content: string } }).ok.content;
    expect(content).toContain("Renewal at risk");
    expect(content).toContain("HAS_ISSUE");

    // ...and it got there through the kernel, on the run's identity, tagged as
    // an agent action. The engine was handed no credential and no Neo4j reach.
    expect(kernel.invoke).toHaveBeenCalledTimes(1);
    const [capability, input, ctx, opts] = kernel.invoke.mock.calls[0]!;
    expect(capability).toBe("query_ontology");
    expect(input).toMatchObject({ startNodeId: "n_acme" });
    expect(ctx).toMatchObject({
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
    });
    expect(opts).toEqual({ surface: "agent" });
  });

  it("hands a rejected graph read to the model as a tool error, not a dead turn", async () => {
    // Requirement 4: a tenant-scope rejection, a missing Neo4j config, or an
    // entitlement denial is something the model reads and reacts to. A
    // rejection that escaped as an exception would kill the turn instead.
    kernel.invoke.mockRejectedValueOnce(
      new Error("neo4j is not configured for this workspace"),
    );
    const output = await executeToolRequest(
      optedIn.tools,
      "query_ontology",
      { startNodeId: "n_acme" },
      { toolCallId: "stella-query_ontology-1" },
    );

    expect("error" in output, "the rejection escaped as a success").toBe(true);
    expect((output as { error: { message: string } }).error.message).toContain(
      "neo4j is not configured",
    );
  });

  it("exposes no write-shaped graph capability through this path", async () => {
    // Requirement 1, enforced against the REAL registry rather than the
    // declared list: whatever the opt-in adds beyond the run's own allowlist
    // must be exactly the read set.
    const { ONTOLOGY_READ_CAPABILITIES } = await import("./ontology-tools");
    const declared = new Set(Object.values(notOptedIn.nameMap));
    const added = new Set(
      Object.values(optedIn.nameMap).filter((real) => !declared.has(real)),
    );
    expect([...added].sort()).toEqual([...ONTOLOGY_READ_CAPABILITIES].sort());
  });
});
