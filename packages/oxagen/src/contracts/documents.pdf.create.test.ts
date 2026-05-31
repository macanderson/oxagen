import { describe, expect, it } from "vitest";
import { documentsPdfCreate } from "./documents.pdf.create.js";

describe("documents.pdf.create capability", () => {
  it("parses a minimal valid input (title only)", () => {
    const parsed = documentsPdfCreate.input.parse({ title: "Report" });
    expect(parsed.title).toBe("Report");
    expect(parsed.sourceHtml).toBeUndefined();
    expect(parsed.sourceFileId).toBeUndefined();
    expect(parsed.brandKitId).toBeUndefined();
  });

  it("parses a full input with all optional fields", () => {
    const parsed = documentsPdfCreate.input.parse({
      title: "Invoice",
      sourceHtml: "<h1>Hello</h1>",
      sourceFileId: "file_xyz",
      brandKitId: "bk_123",
    });
    expect(parsed.sourceHtml).toBe("<h1>Hello</h1>");
    expect(parsed.sourceFileId).toBe("file_xyz");
    expect(parsed.brandKitId).toBe("bk_123");
  });

  it("rejects an empty title", () => {
    expect(() => documentsPdfCreate.input.parse({ title: "" })).toThrow();
  });

  it("parses a valid stub output", () => {
    const parsed = documentsPdfCreate.output.parse({
      stub: true,
      fileId: "stub_abc",
      url: "https://stub.invalid/stub_abc",
    });
    expect(parsed.stub).toBe(true);
    expect(parsed.fileId).toBe("stub_abc");
    expect(parsed.url).toBe("https://stub.invalid/stub_abc");
  });

  it("rejects output where stub is not true", () => {
    expect(() =>
      documentsPdfCreate.output.parse({
        stub: false,
        fileId: "f",
        url: "https://stub.invalid/f",
      }),
    ).toThrow();
  });

  it("rejects output with an invalid url", () => {
    expect(() =>
      documentsPdfCreate.output.parse({
        stub: true,
        fileId: "f",
        url: "not-a-url",
      }),
    ).toThrow();
  });
});
