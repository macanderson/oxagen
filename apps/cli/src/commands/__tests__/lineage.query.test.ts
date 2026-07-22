/**
 * `oxagen lineage show <dispatchId>` output-discipline tests. Mocks the shared
 * API client so no network is needed; asserts --json emits the exact contract
 * payload, pretty mode renders a multi-level indented tree and visibly flags a
 * delegation violation, and API failures (incl. a 404 fanout-not-found) route
 * to stderr.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { CommandWriter } from "../../lib/capture-writer.js";

vi.mock("../../lib/api.js", () => ({
  apiGetOrThrow: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status = 0) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  },
}));

import { lineageShow, type LineageQueryOutput } from "../lineage.query.js";
import { apiGetOrThrow, ApiError } from "../../lib/api.js";

function memoryWriter(): {
  writer: CommandWriter;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: {
      write: (line) => {
        out.push(line);
      },
      writeErr: (line) => {
        err.push(line);
      },
    },
    out,
    err,
  };
}

const DISPATCH_ID = "sfo_abc123";

/** Root run -> one nested child run (2-level tree), the child carrying a delegation violation. */
const TREE_RESULT: LineageQueryOutput = {
  dispatchId: DISPATCH_ID,
  rootStatus: "completed",
  totalChildren: 1,
  completedChildren: 1,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:05:00.000Z",
  nodes: [
    {
      runId: "sar_root",
      fanoutId: DISPATCH_ID,
      parentRunId: null,
      childFanoutId: "sfo_child",
      depth: 0,
      capabilityName: "workflow.run",
      outcome: "completed",
      attempts: 1,
      principal: { id: "p1", kind: "human", displayName: "Alice" },
      delegationCeiling: null,
      model: "claude-sonnet-5",
      provider: "anthropic",
      spend: {
        costUsd: 0.0034,
        inputTokens: 100,
        outputTokens: 50,
        llmCalls: 1,
      },
      delegationViolation: null,
      startedAt: "2026-07-01T00:00:00.000Z",
      completedAt: "2026-07-01T00:00:02.000Z",
      durationMs: 2000,
    },
    {
      runId: "sar_child",
      fanoutId: "sfo_child",
      parentRunId: "sar_root",
      childFanoutId: null,
      depth: 1,
      capabilityName: "agent.code.execute",
      outcome: "failed",
      attempts: 1,
      principal: { id: "p2", kind: "agent", displayName: "Agent Bravo" },
      delegationCeiling: { principalId: "p1", displayName: "Alice" },
      model: null,
      provider: null,
      spend: { costUsd: 0, inputTokens: 0, outputTokens: 0, llmCalls: 0 },
      delegationViolation: {
        ruleId: "agent_delegation:capability_denied",
        message:
          'IAM denied "agent.code.execute" for principal: exceeds delegation ceiling',
      },
      startedAt: "2026-07-01T00:00:03.000Z",
      completedAt: "2026-07-01T00:00:04.000Z",
      durationMs: 1000,
    },
  ],
  nodeCount: 2,
  truncated: false,
  maxDepthReached: false,
};

const savedExit = process.exitCode;
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  process.exitCode = savedExit;
});

describe("lineage show", () => {
  it("--json emits the exact payload on stdout", async () => {
    (apiGetOrThrow as unknown as Mock).mockResolvedValueOnce(TREE_RESULT);
    const { writer, out } = memoryWriter();

    await lineageShow(DISPATCH_ID, { json: true }, writer);

    expect(apiGetOrThrow).toHaveBeenCalledWith(`lineage/query/${DISPATCH_ID}`, {
      maxDepth: undefined,
      maxNodes: undefined,
    });
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual(TREE_RESULT);
  });

  it("forwards --max-depth/--max-nodes as numbers", async () => {
    (apiGetOrThrow as unknown as Mock).mockResolvedValueOnce(TREE_RESULT);
    const { writer } = memoryWriter();

    await lineageShow(
      DISPATCH_ID,
      { maxDepth: "3", maxNodes: "50", json: true },
      writer,
    );

    expect(apiGetOrThrow).toHaveBeenCalledWith(`lineage/query/${DISPATCH_ID}`, {
      maxDepth: 3,
      maxNodes: 50,
    });
  });

  it("pretty mode renders a multi-level indented tree (parent before child, deeper indent)", async () => {
    (apiGetOrThrow as unknown as Mock).mockResolvedValueOnce(TREE_RESULT);
    const { writer, out } = memoryWriter();

    await lineageShow(DISPATCH_ID, { stdoutIsTTY: true }, writer);

    const text = out.join("\n");
    expect(text).toContain("workflow.run");
    expect(text).toContain("agent.code.execute");
    // Parent renders before its child.
    expect(text.indexOf("workflow.run")).toBeLessThan(
      text.indexOf("agent.code.execute"),
    );
    // The child line is indented deeper than the root line. The tree is
    // written as one multi-line block (writer.write(lines.join("\n"))), so
    // split on "\n" first — filtering the raw `out` array would match both
    // capability names against the same joined entry.
    const lines = text
      .split("\n")
      .filter(
        (l) => l.includes("workflow.run") || l.includes("agent.code.execute"),
      );
    const rootLine = lines.find((l) => l.includes("workflow.run"))!;
    const childLine = lines.find((l) => l.includes("agent.code.execute"))!;
    const rootIndent = rootLine.length - rootLine.trimStart().length;
    const childIndent = childLine.length - childLine.trimStart().length;
    expect(childIndent).toBeGreaterThan(rootIndent);
    // Spend and principal render for the root node.
    expect(text).toContain("$0.0034");
    expect(text).toContain("Alice");
  });

  it("pretty mode visibly flags a delegation violation", async () => {
    (apiGetOrThrow as unknown as Mock).mockResolvedValueOnce(TREE_RESULT);
    const { writer, out } = memoryWriter();

    await lineageShow(DISPATCH_ID, { stdoutIsTTY: true }, writer);

    const text = out.join("\n");
    expect(text).toContain("⚠ DELEGATION VIOLATION");
    expect(text).toContain("agent_delegation:capability_denied");
    expect(text).toContain("⚠ Delegation violations:");
    expect(text).toContain("agent.code.execute (sar_child)");
    expect(text).toContain("exceeds delegation ceiling");
  });

  it("pretty mode does not flag anything when no node has a violation", async () => {
    const clean: LineageQueryOutput = {
      ...TREE_RESULT,
      nodes: TREE_RESULT.nodes.map((n) => ({
        ...n,
        delegationViolation: null,
      })),
    };
    (apiGetOrThrow as unknown as Mock).mockResolvedValueOnce(clean);
    const { writer, out } = memoryWriter();

    await lineageShow(DISPATCH_ID, { stdoutIsTTY: true }, writer);

    expect(out.join("\n")).not.toContain("⚠");
  });

  it("routes an API failure to stderr", async () => {
    (apiGetOrThrow as unknown as Mock).mockRejectedValueOnce(new Error("boom"));
    const { writer, out, err } = memoryWriter();

    await lineageShow(DISPATCH_ID, { stdoutIsTTY: true }, writer);

    expect(out).toHaveLength(0);
    expect(err.join("\n")).toContain("boom");
  });

  it("maps a 404 ApiError to a friendly not-found message on stderr", async () => {
    (apiGetOrThrow as unknown as Mock).mockRejectedValueOnce(
      new ApiError("not found", 404),
    );
    const { writer, out, err } = memoryWriter();

    await lineageShow(DISPATCH_ID, { stdoutIsTTY: true }, writer);

    expect(out).toHaveLength(0);
    expect(err.join("\n")).toContain(`Dispatch not found: ${DISPATCH_ID}`);
  });
});
