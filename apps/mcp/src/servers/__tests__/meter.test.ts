// meter.test.ts: the ledger entry one governed action records (lane M15).
import { describe, expect, it } from "vitest";
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen/types";
import { filesCalls, meterEntry, servedCallRow } from "../meter";
import type { MeterEvent, ServedCallRecord } from "../types";
import { NOW, run } from "./fixtures";

const WORKSPACE = "5f0c2a9e-3b1d-4c7a-8e6f-9a0b1c2d3e4f";

function event(overrides: Partial<MeterEvent> = {}): MeterEvent {
  return {
    id: "act_1",
    kind: "call",
    tool: "billing__list_charges",
    server: "billing",
    outcome: "allowed",
    agent: "aintel.finops.release-bot",
    run: run(),
    at: new Date(NOW),
    ...overrides,
  };
}

describe("meterEntry", () => {
  it("keys the entry by the action's id, not by the client's request id", () => {
    const first = meterEntry(event({ id: "act_1" }));
    const second = meterEntry(event({ id: "act_2" }));
    expect(first.idempotencyKey).toBe("external_tool:ses_1:mcp:act_1");
    expect(second.idempotencyKey).toBe("external_tool:ses_1:mcp:act_2");
    expect(first.requestId).toBe("req_1");
    expect(second.requestId).toBe("req_1");
  });

  it("scopes the key by the workspace when the run names no session", () => {
    const entry = meterEntry(event({ run: run({ sessionId: null }) }));
    expect(entry.idempotencyKey).toBe("external_tool:ws_1:mcp:act_1");
  });

  it("records the tool, the server, the agent, and one unit", () => {
    expect(meterEntry(event())).toMatchObject({
      source: "external_tool",
      toolName: "billing__list_charges",
      mcpServer: "billing",
      surface: "mcp",
      harness: "claude-code",
      agentId: "aintel.finops.release-bot",
      sessionId: "ses_1",
      units: 1,
      occurredAt: new Date(NOW),
    });
  });

  it("records the run's session as the run when the request names a session", () => {
    expect(meterEntry(event()).runId).toBe("tse_1");
  });

  it("records no run when the request names no session", () => {
    const entry = meterEntry(event({ run: run({ sessionId: null, runPublicId: null }) }));
    expect(entry.runId).toBeNull();
    expect(entry.sessionId).toBeNull();
  });

  it("records no run when the session id is absent, even if a run id is known", () => {
    expect(meterEntry(event({ run: run({ sessionId: null }) })).runId).toBeNull();
  });

  it("attributes a workspace only when its id is a UUID", () => {
    expect(meterEntry(event()).workspaceId).toBeNull();
    expect(meterEntry(event({ run: run({ workspaceId: WORKSPACE }) })).workspaceId).toBe(WORKSPACE);
  });
});

describe("servedCallRow (ADR-234)", () => {
  function record(overrides: Partial<ServedCallRecord> = {}): ServedCallRecord {
    return {
      server: "billing",
      tool: "billing__create_refund",
      outcome: "failed",
      problem: "schema_rejected",
      run: run({ workspaceId: WORKSPACE }),
      at: new Date(NOW),
      ...overrides,
    };
  }

  it("files the call under the tool, the session's run, the outcome, and the problem", () => {
    expect(servedCallRow(record())).toEqual({
      server: "billing",
      tool: "billing__create_refund",
      run_public_id: "tse_1",
      outcome: "failed",
      problem: "schema_rejected",
      created_at: new Date(NOW).toISOString(),
    });
  });

  it("writes an empty problem for a call the tool is not the reason for", () => {
    expect(servedCallRow(record({ outcome: "allowed", problem: null }))?.problem).toBe("");
  });

  it("writes an empty run when the request names no session", () => {
    expect(servedCallRow(record({ run: run({ workspaceId: WORKSPACE, sessionId: null }) }))?.run_public_id).toBe("");
  });

  it("files nothing for a run with no workspace", () => {
    expect(servedCallRow(record({ run: run({ workspaceId: ORG_ONLY_WORKSPACE_ID }) }))).toBeNull();
    expect(servedCallRow(record({ run: run({ workspaceId: "ws_1" }) }))).toBeNull();
  });
});

describe("filesCalls", () => {
  // The rate read counts nothing for a run whose calls are never filed.
  it("is true only for a run whose workspace id is a UUID", () => {
    expect(filesCalls(run({ workspaceId: WORKSPACE }))).toBe(true);
    expect(filesCalls(run({ workspaceId: ORG_ONLY_WORKSPACE_ID }))).toBe(false);
    expect(filesCalls(run({ workspaceId: "ws_1" }))).toBe(false);
  });
});
