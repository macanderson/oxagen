// The shared read of a revision's files (ADR-292): get_revision_diff and
// get_run_work both answer hunks from here. A failure comes back as a reason
// for the caller to act on, never as a throw, and the budget cuts later files
// rather than the first.
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@oxagen/storage/s3";
import {
  manifestFiles,
  readRevisionFiles,
  type RevisionForFiles,
} from "./revision-files";

const DIFF = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1 +1 @@",
  "-one",
  "+two",
  "diff --git a/b.ts b/b.ts",
  "--- a/b.ts",
  "+++ b/b.ts",
  "@@ -1 +1 @@",
  "-three",
  "+four",
  "",
].join("\n");
const BYTES = new TextEncoder().encode(DIFF);

function revision(over: Partial<RevisionForFiles> = {}): RevisionForFiles {
  return {
    diffStatus: "stored",
    diffKey: "pr-diffs/o/w/github/1/2/head.diff",
    diffSha256: sha256Hex(BYTES),
    files: [
      { path: "a.ts", status: "modified", additions: 1, deletions: 1 },
      { path: "b.ts", status: "modified", additions: 1, deletions: 1 },
    ],
    ...over,
  };
}

function store(bytes: Uint8Array | null) {
  return {
    name: "s3" as const,
    bucket: "diffs",
    putOnce: vi.fn(),
    get: vi.fn().mockResolvedValue(bytes),
  };
}

const WIDE = { maxChars: 10_000, maxFileChars: 10_000 };

describe("readRevisionFiles", () => {
  it("answers each file's hunks from the stored bytes", async () => {
    const out = await readRevisionFiles(revision(), store(BYTES), WIDE);
    expect(out).toEqual({
      ok: true,
      diffSha256: sha256Hex(BYTES),
      truncated: false,
      files: [
        expect.objectContaining({ path: "a.ts", patch: "@@ -1 +1 @@\n-one\n+two" }),
        expect.objectContaining({ path: "b.ts", patch: "@@ -1 +1 @@\n-three\n+four" }),
      ],
    });
  });

  it("gives the budget to the first files and leaves later ones without hunks", async () => {
    const first = "@@ -1 +1 @@\n-one\n+two".length;
    const out = await readRevisionFiles(revision(), store(BYTES), {
      maxChars: first,
      maxFileChars: 10_000,
    });
    expect(out.ok && out.files.map((file) => file.patch !== null)).toEqual([
      true,
      false,
    ]);
    expect(out.ok && out.truncated).toBe(true);
  });

  it("answers the file list of a revision whose bytes are not kept, and reads nothing", async () => {
    const held = store(BYTES);
    const out = await readRevisionFiles(
      revision({ diffStatus: "too_large", diffKey: null, diffSha256: null }),
      held,
      WIDE,
    );
    expect(held.get).not.toHaveBeenCalled();
    expect(out).toEqual({
      ok: true,
      diffSha256: null,
      truncated: false,
      files: manifestFiles(revision()),
    });
  });

  it("answers a reason, never a diff, when the bytes are missing, differ, or have no store (negative)", async () => {
    await expect(
      readRevisionFiles(revision(), store(null), WIDE),
    ).resolves.toEqual({ ok: false, reason: "diff_missing" });
    await expect(
      readRevisionFiles(revision(), store(new TextEncoder().encode("x")), WIDE),
    ).resolves.toEqual({ ok: false, reason: "diff_digest_mismatch" });
    await expect(readRevisionFiles(revision(), null, WIDE)).resolves.toEqual({
      ok: false,
      reason: "diff_store_unconfigured",
    });
  });

  it("keeps only the paths asked for", async () => {
    const out = await readRevisionFiles(
      revision(),
      store(BYTES),
      WIDE,
      new Set(["b.ts"]),
    );
    expect(out.ok && out.files.map((file) => file.path)).toEqual(["b.ts"]);
  });
});
