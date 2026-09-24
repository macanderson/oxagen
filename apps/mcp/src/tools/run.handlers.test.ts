// run.handlers.test.ts — handler invocation tests for the run recorder tools
// (#2952, ADR-058): get_run_frame_body, get_run_transcript, get_run_chain,
// bisect_runs, get_run_export, and seal_run (#4073, ADR-169).
// fork_run, export_run and summarize_run check an org role in the handler and
// an MCP context carries no user, so they have no MCP tool. get_run_export and
// seal_run check a role too but their contracts declare the mcp surface; the
// handler resolves the acting user from the API key, and refuses when it
// cannot.
//
// Pattern: vi.mock the kernel `invoke` and the context seam `buildContext` so
// each default-export handler runs without a live runtime. Each tool asserts:
// the schema exposes the contract's input fields and the metadata names the
// contract with the annotations its mutability warrants; buildContext then
// invoke are called once with the contract name, the args and
// { surface: "mcp" }; the handler answers the parsed output; an output the
// contract refuses is refused here; an invoke error propagates.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

import runFrameBodyGetTool, {
  schema as frameBodySchema,
  metadata as frameBodyMetadata,
} from "./run.frame_body.get";
import runTranscriptGetTool, {
  schema as transcriptSchema,
  metadata as transcriptMetadata,
} from "./run.transcript.get";
import runBisectTool, {
  schema as bisectSchema,
  metadata as bisectMetadata,
} from "./run.bisect";
import runChainGetTool, {
  schema as chainSchema,
  metadata as chainMetadata,
} from "./run.chain.get";
import runExportGetTool, {
  schema as exportGetSchema,
  metadata as exportGetMetadata,
} from "./run.export.get";
import runSealTool, {
  schema as sealSchema,
  metadata as sealMetadata,
} from "./run.seal";

const fakeCtx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: null,
  apiKeyId: "key_test",
  requestId: "req_test",
  surface: "mcp" as const,
  messageId: null,
  clientIp: null,
};

const LEDGER_ID = "arun_5f0c2e9a1b7d4c3e8f6a02";
const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";
const DIGEST = `sha256:${"a".repeat(64)}`;
const EXPORT_ID = "rexp_0a1b2c3d";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

interface ToolCase {
  name: string;
  /** Parameters are contravariant: every tool's typed handler is assignable here. */
  handler: (args: never) => Promise<unknown>;
  schema: Record<string, unknown>;
  metadata: { name: string; annotations?: Record<string, unknown> };
  fields: string[];
  readOnly: boolean;
  /** True for a tool whose effect cannot be undone; false when absent. */
  destructive?: boolean;
  args: Record<string, unknown>;
  validOutput: Record<string, unknown>;
  /** An output the contract's schema refuses. */
  invalidOutput: Record<string, unknown>;
}

const CASES: ToolCase[] = [
  {
    name: "get_run_frame_body",
    handler: runFrameBodyGetTool,
    schema: frameBodySchema,
    metadata: frameBodyMetadata,
    fields: ["runId", "seq"],
    readOnly: true,
    args: { runId: LEDGER_ID, seq: "7" },
    validOutput: {
      contentType: "text/plain",
      bytes: "aGVsbG8=",
      digest: DIGEST,
      redactions: [],
    },
    invalidOutput: {
      contentType: "text/plain",
      bytes: "aGVsbG8=",
      digest: "not-a-digest",
      redactions: [],
    },
  },
  {
    name: "get_run_transcript",
    handler: runTranscriptGetTool,
    schema: transcriptSchema,
    metadata: transcriptMetadata,
    fields: ["runId", "zoom", "kinds", "after", "limit"],
    readOnly: true,
    args: { runId: TACHO_ID, zoom: "turns", kinds: [], limit: 200 },
    validOutput: {
      zoom: "turns",
      kinds: [],
      entries: [],
      cursor: null,
      complete: true,
    },
    invalidOutput: {
      zoom: "frames",
      kinds: [],
      entries: [],
      cursor: null,
      complete: true,
    },
  },
  {
    name: "get_run_chain",
    handler: runChainGetTool,
    schema: chainSchema,
    metadata: chainMetadata,
    fields: ["runId"],
    readOnly: true,
    args: { runId: TACHO_ID },
    validOutput: {
      runId: TACHO_ID,
      hashRule: "tacho.sha256_prev_hash_v1",
      frameCount: 0,
      firstSeq: null,
      lastSeq: null,
      merkleRoot: null,
      checkpoints: [],
      gaps: {
        missingSequences: [],
        missingFrameCount: 0,
        missingBodies: 0,
        recorded: [],
      },
      seals: [],
      enforcementTier: "observe",
      recordedGrade: null,
      ladder: [{ grade: "inspect", met: true, reason: "frames_recorded" }],
      complete: true,
    },
    // A hash rule outside the closed set: a verifier cannot recompute with it.
    invalidOutput: {
      runId: TACHO_ID,
      hashRule: "sha1",
      frameCount: 0,
      firstSeq: null,
      lastSeq: null,
      merkleRoot: null,
      checkpoints: [],
      gaps: {
        missingSequences: [],
        missingFrameCount: 0,
        missingBodies: 0,
        recorded: [],
      },
      seals: [],
      enforcementTier: "observe",
      recordedGrade: null,
      ladder: [],
      complete: true,
    },
  },
  {
    name: "bisect_runs",
    handler: runBisectTool,
    schema: bisectSchema,
    metadata: bisectMetadata,
    fields: ["runA", "runB"],
    readOnly: true,
    args: { runA: LEDGER_ID, runB: TACHO_ID },
    validOutput: {
      divergentSeq: "4",
      keyA: "tool_call:read_file",
      keyB: "tool_call:write_file",
      aligned: 3,
    },
    invalidOutput: { divergentSeq: 4, keyA: null, keyB: null, aligned: 3 },
  },
  {
    name: "get_run_export",
    handler: runExportGetTool,
    schema: exportGetSchema,
    metadata: exportGetMetadata,
    fields: ["exportId"],
    readOnly: true,
    args: { exportId: EXPORT_ID },
    validOutput: {
      exportId: EXPORT_ID,
      runId: TACHO_ID,
      status: "ready",
      createdAt: "2026-09-22T09:00:00.000Z",
      completedAt: "2026-09-22T09:01:00.000Z",
      bundleDigest: DIGEST,
      bundleBytes: 4096,
      merkleRoot: DIGEST,
      frameCount: 3,
      error: null,
      download: {
        url: "/v1/run-exports/download?token=abc",
        expiresAt: "2026-09-22T09:16:00.000Z",
      },
    },
    // A status outside the job's four: the contract refuses it.
    invalidOutput: {
      exportId: EXPORT_ID,
      runId: TACHO_ID,
      status: "done",
      createdAt: "2026-09-22T09:00:00.000Z",
      completedAt: null,
      bundleDigest: null,
      bundleBytes: null,
      merkleRoot: null,
      frameCount: null,
      error: null,
      download: null,
    },
  },
  {
    name: "seal_run",
    handler: runSealTool,
    schema: sealSchema,
    metadata: sealMetadata,
    fields: ["runId", "reason"],
    readOnly: false,
    // The seal is final and the kill ends the agent's process.
    destructive: true,
    args: { runId: TACHO_ID, reason: "the agent answered an hour ago" },
    validOutput: {
      runId: TACHO_ID,
      sealedAt: "2026-09-24T16:00:00.000Z",
      sessionsSealed: 1,
      kill: { status: "queued", commandId: "tcm_0a1b2c3d" },
    },
    // A seal that sealed no chain: the contract counts at least the root.
    invalidOutput: {
      runId: TACHO_ID,
      sealedAt: "2026-09-24T16:00:00.000Z",
      sessionsSealed: 0,
      kill: { status: "not_sent", reason: "host_offline" },
    },
  },
];

for (const tool of CASES) {
  describe(`${tool.name} tool`, () => {
    it("exports the contract's input fields and metadata naming the contract", () => {
      expect(Object.keys(tool.schema).sort()).toEqual([...tool.fields].sort());
      expect(tool.metadata.name).toBe(tool.name);
      expect(tool.metadata.annotations?.readOnlyHint).toBe(tool.readOnly);
      expect(tool.metadata.annotations?.destructiveHint).toBe(
        tool.destructive ?? false,
      );
    });

    it(`calls buildContext then invoke with '${tool.name}', the args and surface 'mcp'`, async () => {
      mocks.invoke.mockResolvedValue(tool.validOutput);
      const result = await tool.handler(tool.args as never);
      expect(mocks.buildContext).toHaveBeenCalledOnce();
      expect(mocks.invoke).toHaveBeenCalledOnce();
      expect(mocks.invoke).toHaveBeenCalledWith(tool.name, tool.args, fakeCtx, {
        surface: "mcp",
      });
      expect(result).toEqual(tool.validOutput);
    });

    it("refuses an output the contract refuses (negative)", async () => {
      mocks.invoke.mockResolvedValue(tool.invalidOutput);
      await expect(tool.handler(tool.args as never)).rejects.toThrow();
    });

    it("propagates invoke errors", async () => {
      mocks.invoke.mockRejectedValue(new Error("invoke failed"));
      await expect(tool.handler(tool.args as never)).rejects.toThrow(
        "invoke failed",
      );
    });
  });
}
