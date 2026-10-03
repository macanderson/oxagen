// A write-once object store on one private S3 bucket (ADR-288).
//
// This is not a `StorageAdapter` driver. A driver serves every blob kind
// through `storage()`, and a deployment picks one for all of them. This store
// serves one caller that needs its own bucket: pull request diffs, which are
// customer source code and must never share a store that can be public.
//
// Each put is write-once. `If-None-Match: *` makes S3 refuse a put over an
// object that already exists (412), and the key names its content, so a
// refused put means the same bytes are already there and the put is done. S3
// checks the sha256 the put names against the bytes it received and refuses a
// put whose bytes do not match, so a stored object is the object the caller
// hashed. The bucket's default encryption applies to every object, and the
// process's AWS credentials come from the SDK's default chain (the instance
// role in production).
import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";

/** A put's outcome: this call wrote the object, or it was already there. */
export type PutOnceOutcome = "written" | "exists";

export interface ObjectStore {
  /** The store's name, as a row that points into it records it. */
  readonly name: "s3";
  readonly bucket: string;
  /**
   * Write `bytes` at `key` unless an object is already there. `sha256` is the
   * lower-case hex digest the caller computed; S3 refuses bytes that differ.
   */
  putOnce(
    key: string,
    bytes: Uint8Array,
    opts: { sha256: string; contentType: string },
  ): Promise<PutOnceOutcome>;
  /** The object's bytes, or null when no object is at `key`. */
  get(key: string): Promise<Uint8Array | null>;
}

/** The part of an S3 client this store calls; a test passes its own. */
export interface S3Sender {
  send(command: PutObjectCommand | GetObjectCommand): Promise<unknown>;
}

function statusOf(err: unknown): number | undefined {
  if (err instanceof S3ServiceException) return err.$metadata.httpStatusCode;
  const meta = (err as { $metadata?: { httpStatusCode?: number } } | null)
    ?.$metadata;
  return meta?.httpStatusCode;
}

function nameOf(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "name" in err
    ? String((err as { name: unknown }).name)
    : undefined;
}

/** The base64 sha256 S3 checks a put against, from its hex digest. */
export function checksumOf(sha256Hex: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex))
    throw new Error("s3: sha256 must be 64 lower-case hex characters");
  return Buffer.from(sha256Hex, "hex").toString("base64");
}

/** The lower-case hex sha256 of `bytes`. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createS3ObjectStore(opts: {
  bucket: string;
  region?: string;
  client?: S3Sender;
}): ObjectStore {
  if (opts.bucket.trim() === "") throw new Error("s3: a bucket is required");
  const client: S3Sender =
    opts.client ??
    new S3Client(opts.region === undefined ? {} : { region: opts.region });
  return {
    name: "s3",
    bucket: opts.bucket,
    async putOnce(key, bytes, put) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: opts.bucket,
            Key: key,
            Body: bytes,
            ContentType: put.contentType,
            ContentLength: bytes.byteLength,
            ChecksumSHA256: checksumOf(put.sha256),
            IfNoneMatch: "*",
            Metadata: { sha256: put.sha256 },
          }),
        );
        return "written";
      } catch (err) {
        // 412: an object is already at the key. The key names the bytes, so
        // the put is done. A 409 is a put racing another for the same key;
        // it is thrown, and the caller's retry finds the winner's object.
        if (statusOf(err) === 412 || nameOf(err) === "PreconditionFailed")
          return "exists";
        throw err;
      }
    },
    async get(key) {
      try {
        const out = (await client.send(
          new GetObjectCommand({ Bucket: opts.bucket, Key: key }),
        )) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
        return out.Body === undefined
          ? new Uint8Array(0)
          : await out.Body.transformToByteArray();
      } catch (err) {
        if (statusOf(err) === 404 || nameOf(err) === "NoSuchKey") return null;
        throw err;
      }
    },
  };
}
