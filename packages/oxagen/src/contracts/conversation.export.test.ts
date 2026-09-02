import { describe, expect, it } from "vitest";
import {
  conversationExport,
  conversationExportFormat,
} from "./conversation.export";
import { getCapability } from "../registry";

describe("conversation.export capability", () => {
  // ── input ─────────────────────────────────────────────────────────────────

  it("accepts markdown and pdf formats", () => {
    for (const format of ["markdown", "pdf"] as const) {
      const parsed = conversationExport.input.parse({
        conversationId: "cnv_1",
        format,
      });
      expect(parsed.format).toBe(format);
    }
  });

  it("rejects an unknown format", () => {
    expect(() =>
      conversationExport.input.parse({
        conversationId: "cnv_1",
        format: "docx",
      }),
    ).toThrow();
  });

  it("requires conversationId", () => {
    expect(() =>
      conversationExport.input.parse({ format: "markdown" }),
    ).toThrow();
  });

  it("exposes exactly the two formats in the enum", () => {
    expect(conversationExportFormat.options).toEqual(["markdown", "pdf"]);
  });

  // ── output ────────────────────────────────────────────────────────────────

  it("parses a markdown output envelope", () => {
    const parsed = conversationExport.output.parse({
      format: "markdown",
      filename: "chat-2026-07-07.md",
      content: "# Chat",
      url: null,
      messageCount: 3,
    });
    expect(parsed.content).toBe("# Chat");
    expect(parsed.url).toBeNull();
  });

  it("parses a pdf output envelope", () => {
    const parsed = conversationExport.output.parse({
      format: "pdf",
      filename: "chat-2026-07-07.pdf",
      content: null,
      url: "/api/v1/assets/gen_1",
      messageCount: 3,
    });
    expect(parsed.content).toBeNull();
    expect(parsed.url).toBe("/api/v1/assets/gen_1");
  });

  it("rejects a non-integer messageCount", () => {
    expect(() =>
      conversationExport.output.parse({
        format: "markdown",
        filename: "x.md",
        content: "",
        url: null,
        messageCount: 1.5,
      }),
    ).toThrow();
  });

  // ── registration & governance posture ────────────────────────────────────

  it("registers in the capability registry", () => {
    const cap = getCapability("export_conversation");
    expect(cap).toBeDefined();
    expect(cap?.domain).toBe("conversation");
    expect(cap?.mode).toBe("sync");
  });

  it("declares api, mcp, and agent surfaces", () => {
    expect(conversationExport.surfaces).toEqual(["api", "mcp", "agent"]);
  });

  it("is billing-gate exempt (cheap read/serialize) and low risk", () => {
    expect(conversationExport.noBillingGate).toBe(true);
    expect(conversationExport.agent?.riskLevel).toBe("low");
    expect(conversationExport.agent?.requiresApproval).toBe(false);
  });

  it("is tenant + workspace scoped with deny-by-default IAM", () => {
    expect(conversationExport.scoped).toBe(true);
    expect(conversationExport.defaultEffect).toBe("deny");
    expect(conversationExport.defaultRoles?.workspace?.Member).toBe("allow");
  });
});
