import { describe, expect, it } from "vitest";
import { digestBytes } from "../digest";
import { MAX_CONTENT_REDACTIONS } from "../envelope";
import { TACHO_MAX_BODY_BYTES } from "../wire";
import {
  contentClassOf,
  jsonContent,
  prepareContent,
  retentionAllows,
  textContent,
} from "./frame-body";
import { redactionMarker } from "./redaction";

const dec = new TextDecoder();

describe("prepareContent", () => {
  it("digests the bytes it ships when nothing needs redacting", () => {
    const prepared = prepareContent(textContent("deploy the fix"));
    expect(prepared.omitted).toBeUndefined();
    expect(prepared.body?.content_type).toBe("text/plain; charset=utf-8");
    expect(dec.decode(prepared.body?.bytes)).toBe("deploy the fix");
    expect(prepared.digest).toBe(digestBytes("deploy the fix"));
    expect(prepared.redactions).toEqual([]);
  });

  it("redacts before digesting, so the chain names the shipped bytes", () => {
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const prepared = prepareContent(textContent(`use ${key} now`));
    const shipped = `use ${redactionMarker("model_api_key")} now`;
    expect(dec.decode(prepared.body?.bytes)).toBe(shipped);
    expect(prepared.digest).toBe(digestBytes(shipped));
    expect(prepared.digest).not.toBe(digestBytes(`use ${key} now`));
    expect(prepared.redactions).toEqual([
      {
        path: `bytes:4-${4 + key.length}`,
        reason: "model_api_key",
        original_digest: digestBytes(key),
      },
    ]);
  });

  it("keeps the digest and drops the body past the size cap", () => {
    const big = new Uint8Array(TACHO_MAX_BODY_BYTES + 1).fill(0x61);
    const prepared = prepareContent({
      content_type: "text/plain; charset=utf-8",
      bytes: big,
    });
    expect(prepared.omitted).toBe("too_large");
    expect(prepared.body).toBeUndefined();
    expect(prepared.digest).toBe(digestBytes(big));
  });

  it("keeps the redacted body and total when the detail list reaches the cap", () => {
    const keys = Array.from(
      { length: MAX_CONTENT_REDACTIONS + 1 },
      (_, i) => `AKIA${String(i).padStart(16, "0")}`,
    ).join(" ");
    const prepared = prepareContent(textContent(keys));
    expect(prepared.omitted).toBeUndefined();
    expect(prepared.redactions).toHaveLength(MAX_CONTENT_REDACTIONS);
    expect(prepared.redactionsTotal).toBe(MAX_CONTENT_REDACTIONS + 1);
    const expected = Array.from({ length: MAX_CONTENT_REDACTIONS + 1 }, () =>
      redactionMarker("aws_access_key"),
    ).join(" ");
    expect(dec.decode(prepared.body?.bytes)).toBe(expected);
    expect(prepared.digest).toBe(digestBytes(expected));
  });

  it("records every detail at the exact redaction cap", () => {
    const keys = Array.from(
      { length: MAX_CONTENT_REDACTIONS },
      (_, i) => `AKIA${String(i).padStart(16, "0")}`,
    ).join(" ");
    const prepared = prepareContent(textContent(keys));
    expect(prepared.redactions).toHaveLength(MAX_CONTENT_REDACTIONS);
    expect(prepared.redactionsTotal).toBe(MAX_CONTENT_REDACTIONS);
    expect(prepared.omitted).toBeUndefined();
    expect(prepared.digest).toBe(
      digestBytes(prepared.body?.bytes as Uint8Array),
    );
  });

  it("retains the digest and full count when both limits are exceeded", () => {
    const keys = Array.from(
      { length: MAX_CONTENT_REDACTIONS + 1 },
      (_, i) => `AKIA${String(i).padStart(16, "0")}`,
    ).join(" ");
    const padding = "x".repeat(TACHO_MAX_BODY_BYTES);
    const prepared = prepareContent(textContent(`${keys} ${padding}`));
    const redacted = Array.from({ length: MAX_CONTENT_REDACTIONS + 1 }, () =>
      redactionMarker("aws_access_key"),
    ).join(" ");
    expect(prepared.omitted).toBe("too_large");
    expect(prepared.body).toBeUndefined();
    expect(prepared.redactions).toHaveLength(MAX_CONTENT_REDACTIONS);
    expect(prepared.redactionsTotal).toBe(MAX_CONTENT_REDACTIONS + 1);
    expect(prepared.digest).toBe(digestBytes(`${redacted} ${padding}`));
  });

  it("carries canonical JSON as application/json", () => {
    const prepared = prepareContent(jsonContent('{"a":1}'));
    expect(prepared.body?.content_type).toBe("application/json");
    expect(dec.decode(prepared.body?.bytes)).toBe('{"a":1}');
  });
});

describe("contentClassOf", () => {
  it("maps model, tool and approval frames and nothing else", () => {
    expect(contentClassOf("turn_start")).toBe("model_call");
    expect(contentClassOf("turn_end")).toBe("model_call");
    expect(contentClassOf("oxagen:message")).toBe("model_call");
    expect(contentClassOf("subagent_stop")).toBe("model_call");
    expect(contentClassOf("tool_requested")).toBe("tool_call");
    expect(contentClassOf("tool_call")).toBe("tool_call");
    expect(contentClassOf("token_denied")).toBe("tool_call");
    expect(contentClassOf("approval_request")).toBe("approval_receipt");
    expect(contentClassOf("checkpoint")).toBeUndefined();
  });
});

describe("retentionAllows", () => {
  it("needs content_exact and the class listed", () => {
    expect(
      retentionAllows(
        { mode: "digest_only", classes: ["model_call"] },
        "model_call",
      ),
    ).toBe(false);
    expect(
      retentionAllows(
        { mode: "content_exact", classes: ["tool_call"] },
        "model_call",
      ),
    ).toBe(false);
    expect(
      retentionAllows(
        { mode: "content_exact", classes: ["model_call"] },
        "model_call",
      ),
    ).toBe(true);
  });
});
