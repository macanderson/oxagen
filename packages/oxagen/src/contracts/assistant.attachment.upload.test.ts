import { describe, expect, it } from "vitest";
import { assistantAsk } from "./assistant.ask";
import {
  ASSISTANT_ATTACHMENT_BASE64_MAX_CHARS,
  ASSISTANT_ATTACHMENT_MAX_BYTES,
  ASSISTANT_ATTACHMENT_MAX_FILES,
  ASSISTANT_ATTACHMENT_NAME_MAX_CHARS,
  ASSISTANT_ATTACHMENT_TEXT_TURN_MAX_BYTES,
  ASSISTANT_ATTACHMENT_TURN_MAX_BYTES,
  ASSISTANT_ATTACHMENT_TYPES,
  assistantAttachmentCategory,
  assistantAttachmentSchema,
  assistantAttachmentUpload,
} from "./assistant.attachment.upload";

/** stella-serve's request body limit (`MAX_BODY_BYTES`). */
const ENGINE_MAX_BODY_BYTES = 8 * 1024 * 1024;

const SHA = "a".repeat(64);

describe("upload_assistant_attachment contract", () => {
  it("is a scoped, mutating write that spends no credits", () => {
    expect(assistantAttachmentUpload.name).toBe("upload_assistant_attachment");
    expect(assistantAttachmentUpload.mode).toBe("sync");
    expect(assistantAttachmentUpload.scoped).toBe(true);
    expect(assistantAttachmentUpload.mutates).toBe(true);
    expect(assistantAttachmentUpload.noBillingGate).toBe(true);
    expect(assistantAttachmentUpload.defaultEffect).toBe("deny");
  });

  it("grants the roles ask_assistant grants: whoever may ask may attach", () => {
    expect(assistantAttachmentUpload.defaultRoles).toEqual(
      assistantAsk.defaultRoles,
    );
  });

  it("is the person's and not the model's: never on the agent surface", () => {
    expect(assistantAttachmentUpload.surfaces).toEqual(["api", "mcp"]);
    expect(assistantAttachmentUpload.surfaces).not.toContain("agent");
    expect(assistantAttachmentUpload.layers).toContain("app");
  });

  it("sorts each accepted type into the category the turn hands the model", () => {
    expect(assistantAttachmentCategory("image/png")).toBe("image");
    expect(assistantAttachmentCategory("image/jpeg")).toBe("image");
    expect(assistantAttachmentCategory("image/webp")).toBe("image");
    expect(assistantAttachmentCategory("image/gif")).toBe("image");
    expect(assistantAttachmentCategory("application/pdf")).toBe("pdf");
    expect(assistantAttachmentCategory("text/plain")).toBe("text");
    expect(assistantAttachmentCategory("text/markdown")).toBe("text");
    expect(assistantAttachmentCategory("text/csv")).toBe("text");
    expect(assistantAttachmentCategory("application/json")).toBe("text");
    for (const type of ASSISTANT_ATTACHMENT_TYPES) {
      expect(assistantAttachmentCategory(type)).not.toBeNull();
    }
  });

  it("reads a type's parameters and case the way a browser sends them", () => {
    expect(assistantAttachmentCategory("TEXT/Plain; charset=utf-8")).toBe(
      "text",
    );
    expect(assistantAttachmentCategory(" image/PNG ")).toBe("image");
  });

  it("refuses every type outside the list (negative)", () => {
    for (const type of [
      "",
      "image/svg+xml",
      "text/html",
      "application/octet-stream",
      "application/zip",
      "application/x-msdownload",
      "video/mp4",
    ]) {
      expect(assistantAttachmentCategory(type)).toBeNull();
    }
  });

  it("keeps a whole turn's file bytes, as base64, under the engine's body limit", () => {
    const base64Turn = Math.ceil(ASSISTANT_ATTACHMENT_TURN_MAX_BYTES / 3) * 4;
    // The rest of the body (instruction, history, tools) needs room too.
    expect(base64Turn).toBeLessThan(ENGINE_MAX_BODY_BYTES * 0.75);
    expect(ASSISTANT_ATTACHMENT_MAX_BYTES.image).toBeLessThanOrEqual(
      ASSISTANT_ATTACHMENT_TURN_MAX_BYTES,
    );
    expect(ASSISTANT_ATTACHMENT_MAX_BYTES.pdf).toBeLessThanOrEqual(
      ASSISTANT_ATTACHMENT_TURN_MAX_BYTES,
    );
    expect(ASSISTANT_ATTACHMENT_MAX_BYTES.text).toBeLessThanOrEqual(
      ASSISTANT_ATTACHMENT_TEXT_TURN_MAX_BYTES,
    );
    expect(ASSISTANT_ATTACHMENT_MAX_FILES).toBe(10);
  });

  it("sizes the base64 cap to exactly the largest file", () => {
    const largest = Math.max(...Object.values(ASSISTANT_ATTACHMENT_MAX_BYTES));
    expect(ASSISTANT_ATTACHMENT_BASE64_MAX_CHARS).toBe(
      Math.ceil(largest / 3) * 4,
    );
  });

  it("takes a name, a declared type and the base64 bytes, and trims the name", () => {
    expect(
      assistantAttachmentUpload.input.parse({
        name: "  report.pdf ",
        mediaType: "application/pdf",
        data: "JVBERi0=",
      }),
    ).toEqual({
      name: "report.pdf",
      mediaType: "application/pdf",
      data: "JVBERi0=",
    });
  });

  it("refuses an empty file, a blank name, an oversized body and unknown keys (negative)", () => {
    const base = { name: "a.txt", mediaType: "text/plain", data: "aGk=" };
    const empty = assistantAttachmentUpload.input.safeParse({
      ...base,
      data: "",
    });
    expect(empty.success).toBe(false);
    expect(empty.error?.issues[0]?.message).toBe("The file is empty.");

    const blank = assistantAttachmentUpload.input.safeParse({
      ...base,
      name: "   ",
    });
    expect(blank.success).toBe(false);
    expect(blank.error?.issues[0]?.message).toBe("The file needs a name.");

    const long = assistantAttachmentUpload.input.safeParse({
      ...base,
      name: "a".repeat(ASSISTANT_ATTACHMENT_NAME_MAX_CHARS + 1),
    });
    expect(long.success).toBe(false);

    const big = assistantAttachmentUpload.input.safeParse({
      ...base,
      data: "A".repeat(ASSISTANT_ATTACHMENT_BASE64_MAX_CHARS + 4),
    });
    expect(big.success).toBe(false);
    expect(big.error?.issues[0]?.message).toBe("The file is larger than 4 MB.");

    expect(
      assistantAttachmentUpload.input.safeParse({ ...base, url: "https://x" })
        .success,
    ).toBe(false);
  });

  it("returns an attachment with a gen_ id and a lowercase SHA-256", () => {
    const out = {
      publicId: "gen_0123456789abcdefghjkmn",
      name: "a.png",
      mediaType: "image/png",
      sizeBytes: 12,
      sha256: SHA,
    };
    expect(assistantAttachmentSchema.parse(out)).toEqual(out);
    expect(
      assistantAttachmentSchema.safeParse({ ...out, sha256: SHA.toUpperCase() })
        .success,
    ).toBe(false);
    expect(
      assistantAttachmentSchema.safeParse({ ...out, publicId: "cnv_1" })
        .success,
    ).toBe(false);
    expect(
      assistantAttachmentSchema.safeParse({ ...out, storageKey: "k" }).success,
    ).toBe(false);
  });
});
