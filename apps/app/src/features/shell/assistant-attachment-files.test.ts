// @vitest-environment jsdom
// The rules a file on the assistant's composer meets before it uploads, and
// the upload itself (#4690, ADR-222). The composer's checks mirror the
// contract's caps so a file the server would refuse shows its problem on its
// own chip. The upload never rejects: every failure is a problem on the chip.
import {
  ASSISTANT_ATTACHMENT_MAX_BYTES,
  ASSISTANT_ATTACHMENT_MAX_FILES,
  ASSISTANT_ATTACHMENT_NAME_MAX_CHARS,
  ASSISTANT_ATTACHMENT_TEXT_TURN_MAX_BYTES,
  ASSISTANT_ATTACHMENT_TURN_MAX_BYTES,
} from "@oxagen/oxagen/contracts/assistant.attachment.upload";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASSISTANT_ATTACHMENT_ACCEPT,
  type AttachmentFile,
  mediaTypeOf,
  planAttachments,
  problemOfUpload,
  readBase64,
  uploadAssistantAttachment,
} from "./assistant-attachment-files";

const MIB = 1024 * 1024;

function keys() {
  let n = 0;
  return () => {
    n += 1;
    return `k${n}`;
  };
}

function onComposer(
  mediaType: string,
  size: number,
  state: AttachmentFile["state"] = "done",
): AttachmentFile {
  return {
    key: `old-${mediaType}-${size}-${state}`,
    name: "old",
    mediaType,
    size,
    state,
    publicId: state === "done" ? "gen_old" : null,
    problem: state === "error" ? "upload" : null,
  };
}

function problemsOf(chips: readonly AttachmentFile[]) {
  return chips.map((c) => c.problem);
}

describe("mediaTypeOf", () => {
  it("keeps a declared type the assistant reads, without its parameters", () => {
    expect(mediaTypeOf({ name: "a.png", type: "IMAGE/PNG; x=1" })).toBe("image/png");
    expect(mediaTypeOf({ name: "a", type: "application/pdf" })).toBe("application/pdf");
  });

  it("falls back to the extension when the device reports nothing or a type off the list", () => {
    expect(mediaTypeOf({ name: "notes.md", type: "" })).toBe("text/markdown");
    expect(mediaTypeOf({ name: "data.CSV", type: "application/vnd.ms-excel" })).toBe(
      "text/csv",
    );
    expect(mediaTypeOf({ name: "photo.jpg", type: "" })).toBe("image/jpeg");
  });

  it("keeps an unknown declared type, so the chip can name the problem (negative)", () => {
    expect(mediaTypeOf({ name: "app.exe", type: "application/x-msdownload" })).toBe(
      "application/x-msdownload",
    );
    expect(mediaTypeOf({ name: "blob", type: "" })).toBe("application/octet-stream");
  });

  it("offers every accepted type and the extensions a device may not type", () => {
    const accept = ASSISTANT_ATTACHMENT_ACCEPT.split(",");
    expect(accept).toEqual(
      expect.arrayContaining(["image/png", "application/pdf", "text/csv", ".md", ".json"]),
    );
  });
});

describe("planAttachments", () => {
  it("starts uploading each file that meets the rules, with a key of its own", () => {
    const chips = planAttachments(
      [],
      [
        { name: "shot.png", type: "image/png", size: 1024 },
        { name: "notes.md", type: "", size: 200 },
      ],
      keys(),
    );
    expect(chips).toEqual([
      {
        key: "k1",
        name: "shot.png",
        mediaType: "image/png",
        size: 1024,
        state: "uploading",
        publicId: null,
        problem: null,
      },
      {
        key: "k2",
        name: "notes.md",
        mediaType: "text/markdown",
        size: 200,
        state: "uploading",
        publicId: null,
        problem: null,
      },
    ]);
  });

  it("names the rule each refused file breaks and uploads none of them (negative)", () => {
    const chips = planAttachments(
      [],
      [
        { name: "app.exe", type: "application/x-msdownload", size: 10 },
        { name: "empty.txt", type: "text/plain", size: 0 },
        { name: "big.png", type: "image/png", size: ASSISTANT_ATTACHMENT_MAX_BYTES.image + 1 },
        { name: "big.txt", type: "text/plain", size: ASSISTANT_ATTACHMENT_MAX_BYTES.text + 1 },
      ],
      keys(),
    );
    expect(chips.every((c) => c.state === "error")).toBe(true);
    expect(problemsOf(chips)).toEqual(["type", "empty", "size", "size"]);
  });

  it("counts the files already on the composer toward the most one message carries", () => {
    const full = Array.from({ length: ASSISTANT_ATTACHMENT_MAX_FILES }, (_, i) =>
      onComposer("text/plain", i + 1),
    );
    const chips = planAttachments(full, [{ name: "one-more.txt", type: "text/plain", size: 1 }], keys());
    expect(problemsOf(chips)).toEqual(["count"]);
  });

  it("counts the files of one pick against each other", () => {
    const picked = Array.from({ length: ASSISTANT_ATTACHMENT_MAX_FILES + 1 }, (_, i) => ({
      name: `f${i}.txt`,
      type: "text/plain",
      size: 1,
    }));
    const chips = planAttachments([], picked, keys());
    expect(chips.filter((c) => c.state === "uploading")).toHaveLength(
      ASSISTANT_ATTACHMENT_MAX_FILES,
    );
    expect(chips.at(-1)?.problem).toBe("count");
  });

  it("leaves a file already in error out of the caps, since it will not be sent", () => {
    const failed = Array.from({ length: ASSISTANT_ATTACHMENT_MAX_FILES }, () =>
      onComposer("image/png", 3 * MIB, "error"),
    );
    const chips = planAttachments(failed, [{ name: "a.png", type: "image/png", size: 3 * MIB }], keys());
    expect(chips[0]?.state).toBe("uploading");
  });

  it("holds images and PDFs to the turn's total and text to its own total", () => {
    const carried = [onComposer("image/png", ASSISTANT_ATTACHMENT_TURN_MAX_BYTES - MIB)];
    const chips = planAttachments(
      carried,
      [
        { name: "b.pdf", type: "application/pdf", size: 2 * MIB },
        { name: "c.txt", type: "text/plain", size: 1024 },
      ],
      keys(),
    );
    expect(problemsOf(chips)).toEqual(["total", null]);

    const half = ASSISTANT_ATTACHMENT_TEXT_TURN_MAX_BYTES / 2 + 1;
    const text = planAttachments(
      [],
      [
        { name: "a.txt", type: "text/plain", size: half },
        { name: "b.txt", type: "text/plain", size: half },
      ],
      keys(),
    );
    expect(problemsOf(text)).toEqual([null, "total"]);
  });

  it("cuts a long name to the contract's cap and names a blank one", () => {
    const [long, blank] = planAttachments(
      [],
      [
        { name: `${"a".repeat(ASSISTANT_ATTACHMENT_NAME_MAX_CHARS + 50)}.txt`, type: "text/plain", size: 1 },
        { name: "   ", type: "text/plain", size: 1 },
      ],
      keys(),
    );
    expect(long?.name).toHaveLength(ASSISTANT_ATTACHMENT_NAME_MAX_CHARS);
    expect(blank?.name).toBe("file");
  });
});

describe("readBase64", () => {
  it("returns the bytes without the data URL's prefix", async () => {
    await expect(readBase64(new Blob(["hello"], { type: "text/plain" }))).resolves.toBe(
      "aGVsbG8=",
    );
  });
});

describe("problemOfUpload", () => {
  it("reads the refusal's reason from the route's envelope", () => {
    const refused = (reason: string) => ({
      error: { code: "attachment_refused", reason, message: "refused" },
    });
    expect(problemOfUpload(400, refused("type_not_allowed"))).toBe("type");
    expect(problemOfUpload(400, refused("too_large"))).toBe("size");
    expect(problemOfUpload(400, refused("bytes_do_not_match_type"))).toBe("bytes");
    expect(problemOfUpload(400, refused("something_new"))).toBe("upload");
  });

  it("reads a body the route's limit cut off as too large", () => {
    expect(problemOfUpload(413, null)).toBe("size");
  });

  it("treats any other failure as a failed upload (negative)", () => {
    expect(problemOfUpload(500, { error: { code: "internal" } })).toBe("upload");
    expect(problemOfUpload(403, "forbidden")).toBe("upload");
    expect(problemOfUpload(502, null)).toBe("upload");
  });
});

describe("uploadAssistantAttachment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function answer(status: number, body: unknown) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () =>
        body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body),
    };
  }

  const file = { name: "notes.md", mediaType: "text/markdown", data: "aGVsbG8=" };

  it("posts the file to the workspace's upload route and returns its id", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        answer(200, {
          publicId: "gen_abc123",
          name: "notes.md",
          mediaType: "text/markdown",
          sizeBytes: 5,
          sha256: "x",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(uploadAssistantAttachment("acme co", "core", file)).resolves.toEqual({
      ok: true,
      publicId: "gen_abc123",
      mediaType: "text/markdown",
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/acme%20co/core/assistant/attachments/upload",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify(file),
      }),
    );
  });

  it("returns the chip's problem for a refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          answer(400, { error: { code: "attachment_refused", reason: "bytes_do_not_match_type" } }),
        ),
      ),
    );
    await expect(uploadAssistantAttachment("acme", "core", file)).resolves.toEqual({
      ok: false,
      problem: "bytes",
    });
  });

  it("reads a 413 with no JSON body as too large", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(answer(413, undefined))));
    await expect(uploadAssistantAttachment("acme", "core", file)).resolves.toEqual({
      ok: false,
      problem: "size",
    });
  });

  it("never rejects: a network failure or an answer without an id is a failed upload (negative)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("offline"))));
    await expect(uploadAssistantAttachment("acme", "core", file)).resolves.toEqual({
      ok: false,
      problem: "upload",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(answer(200, { publicId: "not-an-id", mediaType: "text/plain" }))),
    );
    await expect(uploadAssistantAttachment("acme", "core", file)).resolves.toEqual({
      ok: false,
      problem: "upload",
    });
  });
});
