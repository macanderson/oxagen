import { describe, expect, it } from "vitest";
import { contextRecordPublish } from "./context.record.publish";
import { getCapability } from "../registry";

const VALID_INPUT = {
  record_id: "no-bare-unwrap",
  title: "No bare unwrap on runtime data",
  body: 'id = "no-bare-unwrap"\n',
};

describe("context.record.publish capability", () => {
  it("registers under its verb-first name", () => {
    expect(getCapability("publish_context_record")).toBe(contextRecordPublish);
  });

  it("is an api-only, high-sensitivity, default-deny governance write", () => {
    expect(contextRecordPublish.surfaces).toEqual(["api"]);
    expect(contextRecordPublish.sensitivity).toBe("high");
    expect(contextRecordPublish.defaultEffect).toBe("deny");
  });

  // ── input ─────────────────────────────────────────────────────────────────

  it("accepts a valid record without provenance", () => {
    const parsed = contextRecordPublish.input.parse(VALID_INPUT);
    expect(parsed.record_id).toBe("no-bare-unwrap");
    expect(parsed.provenance).toBeUndefined();
  });

  it("accepts provenance entries in the ContextProvenanceV1 vocabulary", () => {
    const parsed = contextRecordPublish.input.parse({
      ...VALID_INPUT,
      provenance: [
        { type: "file", uri: ".stella/rules/no-bare-unwrap.toml" },
        { type: "review", by: "usr_1", method: "manual" },
      ],
    });
    expect(parsed.provenance).toHaveLength(2);
  });

  it("rejects a provenance entry with unknown keys", () => {
    expect(() =>
      contextRecordPublish.input.parse({
        ...VALID_INPUT,
        provenance: [{ type: "file", origin: "elsewhere" }],
      }),
    ).toThrow();
  });

  it("rejects an empty body", () => {
    expect(() =>
      contextRecordPublish.input.parse({ ...VALID_INPUT, body: "" }),
    ).toThrow();
  });

  // ── output ────────────────────────────────────────────────────────────────

  it("parses a valid output", () => {
    const parsed = contextRecordPublish.output.parse({
      publicId: "ctr_abc",
      recordId: "no-bare-unwrap",
      version: 1,
      checksum: "a".repeat(64),
      published: true,
    });
    expect(parsed.published).toBe(true);
  });
});
