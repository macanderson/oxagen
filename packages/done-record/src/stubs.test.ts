// stubs.test.ts: decide and lockDigest keep their final signatures and throw
// until their lanes build them. Delete a case when its lane replaces the stub.
import { describe, expect, it } from "vitest";
import { type DoneEvidence, decide } from "./decide";
import { lockDigest } from "./lock-digest";
import { NotBuiltError } from "./not-built";
import type { DoneRecord } from "./types";

const record: DoneRecord = {
  schema: "done-record/v1",
  item: "wi_01K5ZQ4M8T2DXW",
  lineage: "aintel.platform.invoice-export-timeout",
  criteria: [{ id: "c1", text: "The export finishes.", tag: "code", check: { run: "pnpm test" } }],
};

describe("stubs", () => {
  it("decide is not built", () => {
    const evidence: DoneEvidence = { record, criteria: [], models: { build: [] } };
    expect(() => decide(evidence)).toThrow(NotBuiltError);
  });

  it("lockDigest is not built", () => {
    expect(() => lockDigest(record)).toThrow(NotBuiltError);
  });
});
