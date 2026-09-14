import { NO_BODY, tachoFrame } from "@oxagen/run-ledger";
import { digestBytes } from "@oxagen/tacho";
import { describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: vi.fn(),
  modelIdOf: vi.fn(),
  resolveModelFundingSource: vi.fn(),
  selectModel: vi.fn(),
}));
vi.mock("@oxagen/database", () => ({ schema: {}, withTenantDb: vi.fn() }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: vi.fn() }));
vi.mock("@oxagen/run-ledger/evidence-store", () => ({
  evidenceStore: vi.fn(),
}));
vi.mock("../lib/run-record", () => ({
  ledgerStore: vi.fn(),
  readRunFrames: vi.fn(),
  resolveRunRecord: vi.fn(),
}));

import {
  collectSummarySteps,
  SUMMARY_STEP_MAX,
  SUMMARY_TEXT_MAX,
  summaryPrompt,
  summarySchema,
} from "./run.summarize";

const enc = new TextEncoder();
const scope = { orgId: "o", workspaceId: "w" };

function row(seq: number, kind: string, text?: string) {
  const bytes = text === undefined ? null : enc.encode(text);
  return tachoFrame({
    seq,
    ts: "2026-09-11 09:00:00.000",
    kind,
    hash: `sha256:${String(seq).padStart(64, "0")}`,
    contentDigest: bytes ? digestBytes(bytes) : "",
    bytesRef: bytes ? `evb:v1:k:${digestBytes(bytes).slice(7)}` : "",
    redactions: "",
    toolName: kind === "tool_call" ? "Read" : "",
    toolStatus: kind === "tool_call" ? "ok" : "",
    model: kind === "llm_call" ? "haiku" : "",
    provider: "",
    policyDecision: "",
    costUsdMicros: null,
    turnSeq: null,
  });
}

const objects = new Map<string, Uint8Array>();
const store = (text: string) => {
  const bytes = enc.encode(text);
  objects.set(`evb:v1:k:${digestBytes(bytes).slice(7)}`, bytes);
};
const getBody = (_s: unknown, ref: string) => {
  const bytes = objects.get(ref);
  return bytes
    ? Promise.resolve({ bytes })
    : Promise.reject(new Error("no object"));
};

describe("run.summarize", () => {
  it("collects the steps with their body text, and says when a body was not retained or does not hash", async () => {
    store("What is in README?");
    store('{"path":"README.md"}');
    objects.set(
      `evb:v1:k:${digestBytes(enc.encode("forged")).slice(7)}`,
      enc.encode("other"),
    );
    const frames = [
      row(0, "agent_start"),
      row(1, "llm_call", "What is in README?"),
      row(2, "tool_call", '{"path":"README.md"}'),
      row(3, "llm_call", "forged"),
      { ...row(4, "llm_call"), body: NO_BODY },
      row(5, "agent_stop"),
    ];
    const collected = await collectSummarySteps(scope, frames, getBody);
    expect(collected.total).toBe(5);
    expect(collected.steps.map((s) => [s.seq, s.kind, s.text])).toEqual([
      ["0", "frame", null],
      ["1", "model_call", "What is in README?"],
      ["2", "tool_call", '{"path":"README.md"}'],
      ["3", "model_call", null],
      ["4", "model_call", null],
    ]);
    const prompt = summaryPrompt("tse_0a1b2c", collected);
    expect(prompt).toContain("[1] model_call haiku\nWhat is in README?");
    expect(prompt).toContain("[3] model_call haiku\n(body not retained)");
    expect(prompt).not.toContain("omitted");
  });

  it("bounds the steps and each body's text, and says how many steps were left out", async () => {
    const long = "x".repeat(SUMMARY_TEXT_MAX + 10);
    store(long);
    const frames = Array.from({ length: SUMMARY_STEP_MAX + 5 }, (_, i) =>
      row(i, "llm_call", long),
    );
    const collected = await collectSummarySteps(scope, frames, getBody);
    expect(collected.steps).toHaveLength(SUMMARY_STEP_MAX);
    expect(collected.steps[0]?.text).toHaveLength(SUMMARY_TEXT_MAX);
    expect(summaryPrompt("tse_x", collected)).toContain(
      "(5 later steps omitted)",
    );
  });

  it("refuses a generated name or summary outside the bounds (negative)", () => {
    expect(
      summarySchema.safeParse({
        name: "Review PR 42",
        summary: "Left two comments.",
      }).success,
    ).toBe(true);
    expect(summarySchema.safeParse({ name: "", summary: "x" }).success).toBe(
      false,
    );
    expect(
      summarySchema.safeParse({ name: "x".repeat(81), summary: "x" }).success,
    ).toBe(false);
  });
});
