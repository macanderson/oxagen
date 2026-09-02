import { describe, it, expect } from "vitest";
import { conversationAttachmentAdd } from "./conversation.attachment.add";
import { getCapability } from "../registry";

describe("conversation.attachment.add capability", () => {
  it("is registered", () => {
    expect(getCapability("add_conversation_attachment")).toBeDefined();
  });

  it("does not gate on billing (file linkage consumes no AI tokens)", () => {
    expect(conversationAttachmentAdd.noBillingGate).toBe(true);
  });

  it("parses valid input", () => {
    expect(() =>
      conversationAttachmentAdd.input.parse({
        conversationId: "conv_abc123",
        assetPublicId: "gen_xyz789",
      }),
    ).not.toThrow();
  });

  it("rejects input missing conversationId", () => {
    expect(() =>
      conversationAttachmentAdd.input.parse({
        assetPublicId: "gen_xyz789",
      }),
    ).toThrow();
  });

  it("rejects input missing assetPublicId", () => {
    expect(() =>
      conversationAttachmentAdd.input.parse({
        conversationId: "conv_abc123",
      }),
    ).toThrow();
  });

  it("rejects an empty conversationId", () => {
    expect(() =>
      conversationAttachmentAdd.input.parse({
        conversationId: "",
        assetPublicId: "gen_xyz789",
      }),
    ).toThrow();
  });

  it("parses a valid output — the shared conversationAssetItem shape", () => {
    expect(() =>
      conversationAttachmentAdd.output.parse({
        publicId: "gen_xyz789",
        kind: "image",
        name: "photo.png",
        mimeType: "image/png",
        sizeBytes: 1024,
        status: "ready",
        accessPolicy: "org",
        createdAt: new Date().toISOString(),
        url: "/api/v1/assets/gen_xyz789",
      }),
    ).not.toThrow();
  });

  it("rejects output with an invalid kind", () => {
    expect(() =>
      conversationAttachmentAdd.output.parse({
        publicId: "gen_xyz789",
        kind: "not-a-kind",
        name: "photo.png",
        mimeType: "image/png",
        sizeBytes: 1024,
        status: "ready",
        accessPolicy: "org",
        createdAt: new Date().toISOString(),
        url: "/api/v1/assets/gen_xyz789",
      }),
    ).toThrow();
  });

  it("capability has correct defaults", () => {
    expect(conversationAttachmentAdd.defaultEffect).toBe("deny");
    expect(conversationAttachmentAdd.defaultRoles?.org?.Owner).toBe("allow");
    expect(conversationAttachmentAdd.defaultRoles?.org?.Admin).toBe("allow");
    expect(conversationAttachmentAdd.defaultRoles?.workspace?.Owner).toBe(
      "allow",
    );
    expect(conversationAttachmentAdd.defaultRoles?.workspace?.Member).toBe(
      "allow",
    );
  });
});
