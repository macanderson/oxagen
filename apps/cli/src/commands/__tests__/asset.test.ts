/**
 * `oxagen asset upload` output-discipline tests (ADR-023 §4).
 *
 * --json → one single-line JSON value on stdout (shape preserved); pretty →
 * upload summary on stdout; a bad --kind is a usage error (exit 2, no API
 * call); an API failure is a uniform stderr error line (exit 1). Nothing but
 * the result ever reaches stdout.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { CommandWriter } from "../../lib/capture-writer.js";

vi.mock("../../lib/api.js", () => ({
  apiPostOrThrow: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status = 0) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  },
}));

import { handleAssetUpload } from "../asset.js";
import { apiPostOrThrow, ApiError } from "../../lib/api.js";

const mockPost = apiPostOrThrow as unknown as Mock;

function makeWriter(): { writer: CommandWriter; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: {
      write: (l) => void out.push(l),
      writeErr: (l) => void err.push(l),
    },
    out,
    err,
  };
}

const RESULT = {
  url: "https://blob.test/img.png",
  key: "assets/img.png",
  contentType: "image/png",
  bytes: 2048,
  publicId: "asset_9",
};

let prevExit: typeof process.exitCode;

beforeEach(() => {
  prevExit = process.exitCode;
  process.exitCode = 0;
  mockPost.mockReset();
});

afterEach(() => {
  process.exitCode = prevExit;
});

describe("handleAssetUpload", () => {
  it("emits one single-line JSON value on stdout in --json mode", async () => {
    mockPost.mockResolvedValueOnce(RESULT);
    const { writer, out, err } = makeWriter();
    await handleAssetUpload("https://x/img.png", { json: true }, writer);
    expect(out).toEqual([JSON.stringify(RESULT)]);
    expect(err).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  it("prints the upload summary on stdout in pretty mode", async () => {
    mockPost.mockResolvedValueOnce(RESULT);
    const { writer, out, err } = makeWriter();
    await handleAssetUpload("https://x/img.png", {}, writer);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Uploaded image (2048 bytes, image/png)");
    expect(out[0]).toContain("key: assets/img.png");
    expect(out[0]).toContain("id:  asset_9");
    expect(err).toEqual([]);
  });

  it("defaults kind to image and forwards conversation attachments", async () => {
    mockPost.mockResolvedValueOnce(RESULT);
    const { writer } = makeWriter();
    await handleAssetUpload(
      "https://x/img.png",
      { conversation: "cnv_1" },
      writer,
    );
    expect(mockPost).toHaveBeenCalledWith("asset/upload", {
      sourceUrl: "https://x/img.png",
      kind: "image",
      source: "user_upload",
      conversationId: "cnv_1",
    });
  });

  it("rejects an invalid --kind as a usage error (exit 2, no API call)", async () => {
    const { writer, out, err } = makeWriter();
    await handleAssetUpload(
      "https://x/img.png",
      { kind: "spreadsheet" },
      writer,
    );
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^✗ /);
    expect(err[0]).toContain('Invalid --kind "spreadsheet"');
    expect(process.exitCode).toBe(2);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("routes an API failure to a uniform stderr error (exit 1)", async () => {
    mockPost.mockRejectedValueOnce(
      new ApiError("Error 500 from asset/upload: boom", 500),
    );
    const { writer, out, err } = makeWriter();
    await handleAssetUpload("https://x/img.png", {}, writer);
    expect(out).toEqual([]);
    expect(err[0]).toContain("✗ Error 500 from asset/upload");
    expect(process.exitCode).toBe(1);
  });

  it("emits a json error object on stderr in --json mode", async () => {
    mockPost.mockRejectedValueOnce(new ApiError("nope", 403));
    const { writer, out, err } = makeWriter();
    await handleAssetUpload("https://x/img.png", { json: true }, writer);
    expect(out).toEqual([]);
    expect(JSON.parse(err[0] as string)).toEqual({
      type: "error",
      code: "api",
      message: "nope",
    });
    expect(process.exitCode).toBe(1);
  });
});
