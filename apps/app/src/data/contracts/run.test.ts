import { TRANSCRIPT_ENTRY_DEFAULT as CONTRACT_TRANSCRIPT_ENTRY_DEFAULT } from "@oxagen/oxagen/contracts/run.transcript.get";
import { describe, expect, it } from "vitest";
import { parseSteeringManifest, TRANSCRIPT_ENTRY_DEFAULT } from "./run";

// The Run page's transcript is a client component, and the kernel's contract
// module reaches `@oxagen/run-evidence` and the Context Graph SDK, which
// import Node builtins. Importing it from a `"use client"` file puts
// `node:readline` in a browser chunk and fails the Turbopack build, so the
// value the client needs is mirrored in `./run` and this test is what keeps
// the mirror honest. Tests run under Node, where the contract imports fine.
describe("run contract mirrors", () => {
  it("mirrors the transcript page size the contract defaults to", () => {
    expect(TRANSCRIPT_ENTRY_DEFAULT).toBe(CONTRACT_TRANSCRIPT_ENTRY_DEFAULT);
  });
});

describe("parseSteeringManifest", () => {
  const frame = {
    schema: "oxagen.steering.manifest/1",
    delivers: ["must"],
    budget_tokens: 100,
    spent_tokens: 40,
    included: 1,
    cut: 0,
    text_digest: null,
    items: [
      {
        id: "ctx.one",
        kind: "instruction",
        force: "must",
        recorded_at: "2026-09-20T00:00:00Z",
        tokens: 40,
        outcome: "included",
      },
    ],
    bundle_version: 3,
    bundle_etag: "e3",
  };

  it("reads a sealed manifest and carries each candidate's record key as ref", () => {
    const parsed = parseSteeringManifest(JSON.stringify(frame));
    expect(parsed?.bundle_version).toBe(3);
    expect(parsed?.items[0]?.ref).toBe("ctx.one");
    expect(parsed?.items[0]).not.toHaveProperty("id");
  });

  it("answers null for no text, text that is not JSON, and another schema (negative)", () => {
    expect(parseSteeringManifest(null)).toBeNull();
    expect(parseSteeringManifest("{not json")).toBeNull();
    expect(
      parseSteeringManifest(JSON.stringify({ ...frame, schema: "other/1" })),
    ).toBeNull();
  });

  it("leaves ref null for a candidate the frame names with no key (negative)", () => {
    const [item] = frame.items;
    const parsed = parseSteeringManifest(
      JSON.stringify({ ...frame, items: [{ ...item, id: "" }] }),
    );
    expect(parsed?.items[0]?.ref).toBeNull();
  });
});
