// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  ASSISTANT_DRAFT_EVENT,
  ASSISTANT_DRAFT_MAX,
  assistantDraftOf,
} from "./assistant-draft";

describe("assistant draft boundary", () => {
  const read = (detail: unknown) =>
    assistantDraftOf(new CustomEvent(ASSISTANT_DRAFT_EVENT, { detail }));
  it("accepts a scoped request without submitting it", () => {
    const draft = {
      org: "acme",
      ws: "product",
      content: "Inspect repeated reads and propose a code change.",
    };
    expect(read(draft)).toEqual(draft);
  });
  it("preserves the exact text at the accepted size boundary", () => {
    const content = "x".repeat(ASSISTANT_DRAFT_MAX);
    expect(read({ org: "acme", ws: "product", content })).toEqual({
      org: "acme",
      ws: "product",
      content,
    });
  });
  it.each([
    "draft",
    42,
    { org: 42, ws: "product", content: "fix" },
    { org: "acme", ws: [], content: "fix" },
    { org: "acme", ws: "product", content: {} },
    { org: "", ws: "product", content: "fix" },
    { ws: "product", content: "fix" },
    { org: "acme", content: "fix" },
    { org: "acme", ws: "product" },
  ])("rejects invalid request fields: %j", (detail) => {
    expect(read(detail)).toBeNull();
  });
  it("rejects malformed and oversized requests", () => {
    expect(assistantDraftOf(new Event(ASSISTANT_DRAFT_EVENT))).toBeNull();
    for (const detail of [
      null,
      {},
      { org: "acme", ws: "product", content: " " },
      { org: "acme", ws: "", content: "fix" },
      {
        org: "acme",
        ws: "product",
        content: "x".repeat(ASSISTANT_DRAFT_MAX + 1),
      },
    ])
      expect(read(detail)).toBeNull();
  });
});
