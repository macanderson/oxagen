/**
 * `oxagen conversation export` handler unit tests.
 *
 * Strategy (mirrors file-lock.test.ts):
 *   - Mock `../../lib/api.js` so apiGetOrThrow returns controlled results or
 *     throws ApiError.
 *   - Mock node:fs/promises writeFile for the --output path.
 *   - Capture stdout/stderr and process.exit to assert on output.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";

vi.mock("../../lib/api.js", () => ({
  apiGetOrThrow: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status = 0) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  },
}));

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { handleConversationExport } from "../conversation.js";
import { apiGetOrThrow, ApiError } from "../../lib/api.js";
import { writeFile } from "node:fs/promises";

const mockGet = apiGetOrThrow as unknown as Mock;
const mockWrite = writeFile as unknown as Mock;

let out = "";
let err = "";
const restorers: Array<() => void> = [];

beforeEach(() => {
  out = "";
  err = "";
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((s: unknown) => {
      out += String(s);
      return true;
    }) as never);
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(((s: unknown) => {
      err += String(s);
      return true;
    }) as never);
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code}`);
  }) as never);
  restorers.push(
    () => outSpy.mockRestore(),
    () => errSpy.mockRestore(),
    () => exitSpy.mockRestore(),
  );
});

afterEach(() => {
  for (const r of restorers.splice(0)) r();
  mockGet.mockReset();
  mockWrite.mockReset();
});

const MD_RESPONSE = {
  format: "markdown",
  filename: "planning-2026-07-07.md",
  content: "# Planning\n\nhello\n",
  url: null,
  messageCount: 4,
};

const PDF_RESPONSE = {
  format: "pdf",
  filename: "planning-2026-07-07.pdf",
  content: null,
  url: "/api/v1/assets/gen_9",
  messageCount: 4,
};

describe("handleConversationExport", () => {
  it("defaults to markdown and streams content to stdout", async () => {
    mockGet.mockResolvedValueOnce(MD_RESPONSE);
    await handleConversationExport("cnv_1", {});
    expect(mockGet).toHaveBeenCalledWith("conversations/cnv_1/export", {
      format: "markdown",
    });
    expect(out).toBe("# Planning\n\nhello\n");
  });

  it('accepts "md" as an alias for markdown', async () => {
    mockGet.mockResolvedValueOnce(MD_RESPONSE);
    await handleConversationExport("cnv_1", { format: "md" });
    expect(mockGet).toHaveBeenCalledWith("conversations/cnv_1/export", {
      format: "markdown",
    });
  });

  it("writes markdown to a file with --output", async () => {
    mockGet.mockResolvedValueOnce(MD_RESPONSE);
    await handleConversationExport("cnv_1", { format: "markdown", output: "chat.md" });
    expect(mockWrite).toHaveBeenCalledWith("chat.md", "# Planning\n\nhello\n", "utf8");
    expect(out).toContain("Exported 4 messages to chat.md");
  });

  it("prints filename and serve URL for pdf exports", async () => {
    mockGet.mockResolvedValueOnce(PDF_RESPONSE);
    await handleConversationExport("cnv_1", { format: "pdf" });
    expect(mockGet).toHaveBeenCalledWith("conversations/cnv_1/export", {
      format: "pdf",
    });
    expect(out).toContain("Exported 4 messages as PDF");
    expect(out).toContain("planning-2026-07-07.pdf");
    expect(out).toContain("/api/v1/assets/gen_9");
  });

  it("emits raw JSON with --json", async () => {
    mockGet.mockResolvedValueOnce(PDF_RESPONSE);
    await handleConversationExport("cnv_1", { format: "pdf", json: true });
    expect(JSON.parse(out)).toEqual(PDF_RESPONSE);
  });

  it("rejects an invalid --format client-side", async () => {
    await expect(
      handleConversationExport("cnv_1", { format: "docx" }),
    ).rejects.toThrow("process.exit:1");
    expect(err).toContain('Invalid --format "docx"');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("exits(1) with a friendly message on ApiError", async () => {
    mockGet.mockRejectedValueOnce(new ApiError("Not logged in"));
    await expect(handleConversationExport("cnv_1", {})).rejects.toThrow(
      "process.exit:1",
    );
    expect(err).toContain("Not logged in");
  });

  it("url-encodes the conversation id", async () => {
    mockGet.mockResolvedValueOnce(MD_RESPONSE);
    await handleConversationExport("cnv/../1", {});
    expect(mockGet).toHaveBeenCalledWith(
      "conversations/cnv%2F..%2F1/export",
      { format: "markdown" },
    );
  });
});
