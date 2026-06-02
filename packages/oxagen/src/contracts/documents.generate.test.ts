import { describe, expect, it } from "vitest";
import { documentsGenerate } from "./documents.generate";

describe("documents.generate capability", () => {
  it("parses a minimal valid input", () => {
    const parsed = documentsGenerate.input.parse({
      provider: "google",
      kind: "document",
      title: "My Doc",
    });
    expect(parsed.provider).toBe("google");
    expect(parsed.kind).toBe("document");
    expect(parsed.title).toBe("My Doc");
    expect(parsed.instructions).toBeUndefined();
    expect(parsed.brandKitId).toBeUndefined();
  });

  it("parses a full input including instructions and brandKitId", () => {
    const parsed = documentsGenerate.input.parse({
      provider: "microsoft",
      kind: "spreadsheet",
      title: "Budget",
      instructions: "Create a Q1 budget spreadsheet",
      brandKitId: "bk_abc",
    });
    expect(parsed.brandKitId).toBe("bk_abc");
    expect(parsed.instructions).toBe("Create a Q1 budget spreadsheet");
  });

  it("rejects an empty title", () => {
    expect(() =>
      documentsGenerate.input.parse({
        provider: "google",
        kind: "presentation",
        title: "",
      }),
    ).toThrow();
  });

  it("rejects an unknown provider", () => {
    expect(() =>
      documentsGenerate.input.parse({
        provider: "dropbox",
        kind: "document",
        title: "Test",
      }),
    ).toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      documentsGenerate.input.parse({
        provider: "google",
        kind: "notebook",
        title: "Test",
      }),
    ).toThrow();
  });

  it("parses a valid stub output", () => {
    const parsed = documentsGenerate.output.parse({
      stub: true,
      provider: "google",
      kind: "document",
      fileId: "stub_abc123",
      url: "https://stub.invalid/stub_abc123",
    });
    expect(parsed.stub).toBe(true);
    expect(parsed.fileId).toBe("stub_abc123");
  });

  it("rejects output where stub is not true", () => {
    expect(() =>
      documentsGenerate.output.parse({
        stub: false,
        provider: "google",
        kind: "document",
        fileId: "f",
        url: "https://stub.invalid/f",
      }),
    ).toThrow();
  });
});
