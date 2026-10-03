// get_revision_diff (ADR-292): a stored revision's hunks per file, checked
// against the recorded digest; a revision without bytes answers its file list
// and the reason; a mismatch or a missing object is an error, never a diff.
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@oxagen/storage/s3";
import {
  createGetRevisionDiffHandler,
  type RevisionDiffGetDeps,
} from "./forge.revision.diff.get";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const ctx = SCOPE as unknown as Parameters<
  ReturnType<typeof createGetRevisionDiffHandler>
>[1];

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1,2 @@",
  "-old",
  "+new",
  "+more",
  "diff --git a/img.png b/img.png",
  "Binary files a/img.png and b/img.png differ",
  "diff --git a/old.ts b/new.ts",
  "similarity index 90%",
  "rename from old.ts",
  "rename to new.ts",
  "--- a/old.ts",
  "+++ b/new.ts",
  "@@ -3 +3 @@",
  "-x",
  "+y",
  "",
].join("\n");
const BYTES = new TextEncoder().encode(DIFF);

function revision(over: Record<string, unknown> = {}) {
  return {
    publicId: "prv_1",
    headSha: "a".repeat(40),
    mergeBaseSha: "b".repeat(40),
    diffStatus: "stored",
    diffKey: "pr-diffs/o/w/github/991/42/aaaa.diff",
    diffSha256: sha256Hex(BYTES),
    complete: true,
    limitations: [],
    files: [
      { path: "src/a.ts", status: "modified", additions: 2, deletions: 1 },
      { path: "img.png", status: "modified", additions: 0, deletions: 0 },
      { path: "new.ts", previousPath: "old.ts", status: "renamed", additions: 1, deletions: 1 },
    ],
    ...over,
  };
}

function deps(over: {
  revision?: ReturnType<typeof revision> | null;
  object?: Uint8Array | null;
  store?: boolean;
}): RevisionDiffGetDeps {
  const rev = over.revision === undefined ? revision() : over.revision;
  return {
    revision: async () =>
      rev === null
        ? null
        : ({ revision: rev, pullRequestPublicId: "fpr_1" } as never),
    store: () =>
      over.store === false
        ? null
        : {
            name: "s3",
            bucket: "diffs",
            putOnce: async () => "written",
            get: async () => (over.object === undefined ? BYTES : over.object),
          },
  };
}

describe("get_revision_diff", () => {
  it("answers each file's hunks, marks a binary file, and keeps a rename's old path", async () => {
    const out = await createGetRevisionDiffHandler(deps({}))(
      { revisionId: "prv_1" },
      ctx,
    );
    expect(out).toMatchObject({
      revisionId: "prv_1",
      pullRequestId: "fpr_1",
      diffStatus: "stored",
      diffSha256: sha256Hex(BYTES),
      truncated: false,
    });
    expect(out.files).toEqual([
      {
        path: "src/a.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1 +1,2 @@\n-old\n+new\n+more",
        binary: false,
        truncated: false,
      },
      {
        path: "img.png",
        status: "modified",
        additions: 0,
        deletions: 0,
        patch: null,
        binary: true,
        truncated: false,
      },
      {
        path: "new.ts",
        previousPath: "old.ts",
        status: "renamed",
        additions: 1,
        deletions: 1,
        patch: "@@ -3 +3 @@\n-x\n+y",
        binary: false,
        truncated: false,
      },
    ]);
  });

  it("reads only the paths asked for", async () => {
    const out = await createGetRevisionDiffHandler(deps({}))(
      { revisionId: "prv_1", paths: ["new.ts"] },
      ctx,
    );
    expect(out.files.map((file) => file.path)).toEqual(["new.ts"]);
  });

  it.each(["too_large", "unreadable", "unconfigured"])(
    "answers a %s revision's file list with no hunks, and reads no bytes",
    async (diffStatus) => {
      const out = await createGetRevisionDiffHandler(
        deps({
          revision: revision({
            diffStatus,
            diffKey: null,
            diffSha256: null,
            complete: false,
          }),
          store: false,
        }),
      )({ revisionId: "prv_1" }, ctx);
      expect(out.diffStatus).toBe(diffStatus);
      expect(out.diffSha256).toBeNull();
      expect(out.files.map((file) => [file.path, file.patch])).toEqual([
        ["src/a.ts", null],
        ["img.png", null],
        ["new.ts", null],
      ]);
    },
  );

  it("refuses bytes that do not match the recorded digest (negative)", async () => {
    await expect(
      createGetRevisionDiffHandler(
        deps({ object: new TextEncoder().encode("tampered") }),
      )({ revisionId: "prv_1" }, ctx),
    ).rejects.toMatchObject({ code: "conflict", reason: "diff_digest_mismatch" });
  });

  it("is not_found for an unknown revision and for bytes the store lost (negative)", async () => {
    await expect(
      createGetRevisionDiffHandler(deps({ revision: null }))(
        { revisionId: "prv_9" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "not_found", reason: "revision_not_found" });
    await expect(
      createGetRevisionDiffHandler(deps({ object: null }))(
        { revisionId: "prv_1" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "not_found", reason: "diff_missing" });
  });

  it("refuses a stored revision when the deployment names no store (negative)", async () => {
    await expect(
      createGetRevisionDiffHandler(deps({ store: false }))(
        { revisionId: "prv_1" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "conflict", reason: "diff_store_unconfigured" });
  });
});
