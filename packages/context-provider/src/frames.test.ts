import { createHash } from "node:crypto";
import { budgetTokens } from "@contextgraphprotocol/typescript-sdk";
import { describe, expect, it } from "vitest";
import {
  contentDigest,
  frameProvenance,
  frameTitle,
  frameUri,
  renderContent,
  toFrame,
} from "./frames";
import { fakeRecord } from "./testing/fake-store";

describe("renderContent", () => {
  it("carries a string body as itself", () => {
    expect(renderContent("plain text")).toBe("plain text");
  });

  it("serializes an object body", () => {
    expect(renderContent({ a: 1 })).toBe('{"a":1}');
  });

  it("is stable under key order, because the digest is taken over it", () => {
    const a = renderContent({ zebra: 1, apple: 2, mid: { z: 1, a: 2 } });
    const b = renderContent({ apple: 2, mid: { a: 2, z: 1 }, zebra: 1 });
    expect(a).toBe(b);
    expect(contentDigest(a)).toBe(contentDigest(b));
  });

  it("renders an absent body as empty rather than as the string undefined", () => {
    expect(renderContent(undefined)).toBe("");
  });
});

describe("contentDigest", () => {
  it("is a labelled sha256 of the content bytes", () => {
    const expected = createHash("sha256").update("hello", "utf8").digest("hex");
    expect(contentDigest("hello")).toBe(`sha256:${expected}`);
  });
});

describe("frameUri", () => {
  it("addresses a record inside its workspace", () => {
    const record = fakeRecord({ id: "a".repeat(64) });
    expect(frameUri(record)).toBe(`engram://acme/platform/${"a".repeat(64)}`);
  });

  it("escapes a workspace name that would otherwise change the path", () => {
    const record = fakeRecord({
      id: "b".repeat(64),
      namespace: { org: "acme", workspace: "a/b" },
    });
    expect(frameUri(record)).toContain("a%2Fb");
  });
});

describe("frameTitle", () => {
  it("takes the first line", () => {
    const record = fakeRecord({ id: "c".repeat(64) });
    expect(frameTitle(record, "first line\nsecond line")).toBe("first line");
  });

  it("clips a long line so a citation list stays readable", () => {
    const record = fakeRecord({ id: "c".repeat(64) });
    const title = frameTitle(record, "x".repeat(200));
    expect(title).toHaveLength(78);
    expect(title.endsWith("…")).toBe(true);
  });

  it("falls back to the kind when there is no content", () => {
    const record = fakeRecord({ id: "c".repeat(64), kind: "episodic" });
    expect(frameTitle(record, "")).toBe("episodic record");
  });
});

describe("frameProvenance", () => {
  it("always starts from the record's own content address", () => {
    const record = fakeRecord({ id: "d".repeat(64) });
    const [first] = frameProvenance(record);
    expect(first).toMatchObject({
      type: "engram-record",
      digest: "d".repeat(64),
      method: "content-address",
      by: "agent:test",
    });
  });

  it("names a tool, a model and a parent only when the record does", () => {
    const bare = frameProvenance(fakeRecord({ id: "e".repeat(64) }));
    expect(bare).toHaveLength(1);

    const rich = frameProvenance(
      fakeRecord({
        id: "f".repeat(64),
        provenance: {
          author: "agent:test",
          derivedFrom: ["parent-1"],
          tool: "search",
          model: "claude",
          timestamp: 1,
        },
      }),
    );
    expect(rich.map((link) => link.type)).toEqual([
      "engram-record",
      "tool",
      "model",
      "derived-from",
    ]);
  });
});

describe("toFrame", () => {
  const record = fakeRecord({
    id: "1".repeat(64),
    kind: "episodic",
    body: { text: "the deploy failed at 3am" },
    ttl: 1_800_000_000_000,
  });

  it("reports the protocol's token cost for the content it carries", () => {
    const frame = toFrame(record, 0.5);
    expect(frame.token_cost).toBe(budgetTokens(frame.content));
  });

  it("keeps the source hash and the carried-bytes hash apart", () => {
    const frame = toFrame(record, 0.5);
    expect(frame.canonical_content_hash).toBe(record.id);
    expect(frame.content_digest).toBe(contentDigest(frame.content ?? ""));
    expect(frame.content_digest).not.toBe(frame.canonical_content_hash);
  });

  it("maps the record kind into the protocol's vocabulary", () => {
    expect(toFrame(record, 0.5).kind).toBe("episode");
  });

  it("declares a full, exact representation", () => {
    const frame = toFrame(record, 0.5);
    expect(frame.representation).toBe("full");
    expect(frame.content_fidelity).toBe("exact");
  });

  it("dates the frame from the record", () => {
    const frame = toFrame(record, 0.5);
    expect(frame.valid_from).toBe(new Date(record.createdAt).toISOString());
    expect(frame.valid_to).toBe(new Date(1_800_000_000_000).toISOString());
  });

  it("leaves valid_to absent for a record that never expires", () => {
    const forever = fakeRecord({ id: "2".repeat(64) });
    expect(toFrame(forever, 0.5).valid_to).toBeUndefined();
  });

  it.each([
    [1.4, 1],
    [-0.2, 0],
    [Number.NaN, 0],
    [0.25, 0.25],
  ])("clamps a score of %s to %s", (given, expected) => {
    expect(toFrame(record, given).score).toBe(expected);
  });
});
