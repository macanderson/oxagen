/**
 * documents.pdf.create handler tests.
 *
 * This is a foundation-milestone stub. Tests verify:
 *   - the output shape matches the contract
 *   - render directive is file-attachment with a .pdf filename
 *   - handler never throws (stub policy)
 */

import { describe, it, expect } from "vitest";
import { documentsPdfCreateHandler } from "./documents.pdf.create";
import type { CapabilityContext } from "@oxagen/oxagen";

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

describe("documentsPdfCreateHandler", () => {
  it("returns a valid response shape matching contract", async () => {
    const result = await documentsPdfCreateHandler(
      { title: "Annual Report" },
      CTX,
    );

    expect(result).toHaveProperty("assetId");
    expect(result).toHaveProperty("publicId");
    expect(result.kind).toBe("pdf");
    expect(result.mimeType).toBe("application/pdf");
    expect(typeof result.sizeBytes).toBe("number");
    expect(typeof result.url).toBe("string");
    expect(typeof result.serveUrl).toBe("string");
  });

  it("emits a file-attachment render directive with .pdf filename", async () => {
    const result = await documentsPdfCreateHandler(
      { title: "My Report" },
      CTX,
    );

    expect(result.render.componentId).toBe("file-attachment");
    expect(result.render.props.kind).toBe("pdf");
    expect(result.render.props.name).toBe("My Report.pdf");
    expect(result.render.props.mimeType).toBe("application/pdf");
  });

  it("works with minimal input (title only, no content)", async () => {
    await expect(
      documentsPdfCreateHandler({ title: "Minimal PDF" }, CTX),
    ).resolves.not.toThrow();
  });

  it("works with multi-section content", async () => {
    await expect(
      documentsPdfCreateHandler(
        {
          title: "Multi Section",
          content: {
            sections: [
              { heading: "Chapter 1", paragraphs: ["First paragraph."] },
              { paragraphs: ["Paragraph without heading."] },
              {
                heading: "Chapter 3",
                paragraphs: ["Alpha.", "Beta.", "Gamma."],
              },
            ],
          },
        },
        CTX,
      ),
    ).resolves.not.toThrow();
  });

  it("never throws (stub policy)", async () => {
    await expect(
      documentsPdfCreateHandler({ title: "" }, CTX),
    ).resolves.not.toThrow();
  });
});
