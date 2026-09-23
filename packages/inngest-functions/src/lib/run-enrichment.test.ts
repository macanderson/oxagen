import { describe, expect, it, vi } from "vitest";
import { tachoFrame } from "@oxagen/run-ledger";
import { digestBytes } from "@oxagen/tacho";
vi.mock("@oxagen/agent", () => ({ runGovernedTurn: vi.fn() }));
vi.mock("@oxagen/ai", () => ({
  resolveModelFundingSource: vi.fn(),
  selectModelForOrg: vi.fn(),
}));
vi.mock("@oxagen/billing", () => ({ evaluateTurnCreditGate: vi.fn() }));
import {
  collectRunText,
  ENRICHMENT_CHUNK_CHARS,
  uniqueRunName,
} from "./run-enrichment";
const scope = { orgId: "o", workspaceId: "w" };
function frame(seq: number, text: string) {
  const digest = digestBytes(new TextEncoder().encode(text));
  return tachoFrame({
    seq,
    ts: "2026-09-22 00:00:00.000",
    kind: "user_prompt",
    hash: digest,
    contentDigest: digest,
    bytesRef: `body-${seq}`,
    redactions: "",
    toolName: "",
    toolStatus: "",
    toolUseId: "",
    model: "",
    provider: "",
    policyDecision: "",
    costUsdMicros: null,
    turnSeq: seq,
  });
}
describe("the full recorded input", () => {
  it("includes later turns beyond the old sixty-step limit and the end of long bodies", async () => {
    const bodies = Array.from(
      { length: 75 },
      (_, i) =>
        `turn-${i}: ${i === 74 ? "x".repeat(ENRICHMENT_CHUNK_CHARS * 2) + "FINAL CORRECTION" : "prompt and agent reply"}`,
    );
    const frames = bodies.map((body, i) => frame(i, body));
    const got = await collectRunText(scope, frames, async (_scope, ref) => ({
      bytes: new TextEncoder().encode(bodies[Number(ref.slice(5))]!),
    }));
    expect(got.retained).toBe(75);
    expect(got.missing).toBe(0);
    expect(
      got.chunks.every((chunk) => chunk.length <= ENRICHMENT_CHUNK_CHARS),
    ).toBe(true);
    for (let i = 0; i < 75; i += 1)
      expect(got.chunks.join("")).toContain(`turn-${i}:`);
    expect(got.chunks.join("")).toContain("FINAL CORRECTION");
  });
  it("does not use bytes whose digest disagrees and marks missing evidence", async () => {
    const got = await collectRunText(
      scope,
      [frame(1, "original")],
      async () => ({ bytes: new TextEncoder().encode("tampered") }),
    );
    expect(got.retained).toBe(0);
    expect(got.missing).toBe(1);
    expect(got.chunks.join("")).not.toContain("tampered");
  });
  it("changes its fingerprint when an unavailable retained body becomes readable", async () => {
    const frames = [frame(1, "restored")];
    const missing = await collectRunText(scope, frames, async () => {
      throw new Error("temporary outage");
    });
    const present = await collectRunText(scope, frames, async () => ({
      bytes: new TextEncoder().encode("restored"),
    }));
    expect(missing.unavailable).toBe(1);
    expect(present.unavailable).toBe(0);
    expect(present.digest).not.toBe(missing.digest);
  });
  it("fingerprints the complete input, including later appended frames", async () => {
    const one = frame(1, "one");
    const two = frame(2, "two");
    const get = async (_scope: unknown, ref: string) => ({
      bytes: new TextEncoder().encode(ref === "body-1" ? "one" : "two"),
    });
    const a = await collectRunText(scope, [one], get);
    expect((await collectRunText(scope, [one], get)).digest).toBe(a.digest);
    expect((await collectRunText(scope, [one, two], get)).digest).not.toBe(
      a.digest,
    );
  });
  it("distinguishes runs with the same model-written title", () => {
    expect(uniqueRunName("Fix login", "tse_12345678")).not.toBe(
      uniqueRunName("Fix login", "tse_87654321"),
    );
    expect(
      uniqueRunName("x".repeat(100), "tse_12345678").length,
    ).toBeLessThanOrEqual(80);
  });
});
