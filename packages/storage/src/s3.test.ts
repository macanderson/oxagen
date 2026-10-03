// The write-once S3 object store (ADR-288): each put names its sha256 and
// refuses to overwrite, a 412 means the same bytes are already there, and a
// missing object reads null. A fake sender records the commands sent.
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  checksumOf,
  createS3ObjectStore,
  type S3Sender,
  sha256Hex,
} from "./s3";

const BYTES = new TextEncoder().encode("diff --git a/a.ts b/a.ts\n");
const HEX = sha256Hex(BYTES);

function sender(answer: (command: unknown) => Promise<unknown>) {
  const sent: unknown[] = [];
  const client: S3Sender = {
    send: (command) => {
      sent.push(command);
      return answer(command);
    },
  };
  return { client, sent };
}

function failure(status: number, name: string): Error {
  return Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode: status },
  });
}

describe("createS3ObjectStore", () => {
  it("puts once, naming the sha256 S3 checks and refusing to overwrite", async () => {
    const { client, sent } = sender(() => Promise.resolve({}));
    const store = createS3ObjectStore({ bucket: "diffs", client });
    await expect(
      store.putOnce("pr-diffs/o/w/a.diff", BYTES, {
        sha256: HEX,
        contentType: "text/x-diff",
      }),
    ).resolves.toBe("written");
    const put = sent[0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({
      Bucket: "diffs",
      Key: "pr-diffs/o/w/a.diff",
      ContentType: "text/x-diff",
      ContentLength: BYTES.byteLength,
      ChecksumSHA256: Buffer.from(HEX, "hex").toString("base64"),
      IfNoneMatch: "*",
      Metadata: { sha256: HEX },
    });
  });

  it("answers exists when an object is already at the key, so a retried put is done", async () => {
    const { client } = sender(() =>
      Promise.reject(failure(412, "PreconditionFailed")),
    );
    const store = createS3ObjectStore({ bucket: "diffs", client });
    await expect(
      store.putOnce("k", BYTES, { sha256: HEX, contentType: "text/x-diff" }),
    ).resolves.toBe("exists");
  });

  it("throws any other refusal, a racing put included (negative)", async () => {
    for (const err of [
      failure(409, "ConditionalRequestConflict"),
      failure(403, "AccessDenied"),
      failure(400, "BadDigest"),
    ]) {
      const { client } = sender(() => Promise.reject(err));
      const store = createS3ObjectStore({ bucket: "diffs", client });
      await expect(
        store.putOnce("k", BYTES, { sha256: HEX, contentType: "text/x-diff" }),
      ).rejects.toBe(err);
    }
  });

  it("refuses a digest that is not lower-case hex before sending (negative)", async () => {
    const { client, sent } = sender(() => Promise.resolve({}));
    const store = createS3ObjectStore({ bucket: "diffs", client });
    await expect(
      store.putOnce("k", BYTES, {
        sha256: HEX.toUpperCase(),
        contentType: "text/x-diff",
      }),
    ).rejects.toThrow(/sha256/);
    expect(sent).toEqual([]);
    expect(() => checksumOf("abc")).toThrow(/sha256/);
  });

  it("reads an object's bytes, and null for a key with none", async () => {
    const { client, sent } = sender((command) =>
      (command as GetObjectCommand).input.Key === "there"
        ? Promise.resolve({
            Body: { transformToByteArray: () => Promise.resolve(BYTES) },
          })
        : Promise.reject(failure(404, "NoSuchKey")),
    );
    const store = createS3ObjectStore({ bucket: "diffs", client });
    await expect(store.get("there")).resolves.toEqual(BYTES);
    await expect(store.get("gone")).resolves.toBeNull();
    expect(sent[0]).toBeInstanceOf(GetObjectCommand);
  });

  it("refuses an empty bucket name (negative)", () => {
    expect(() => createS3ObjectStore({ bucket: " " })).toThrow(/bucket/);
  });
});
