import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "./hash.js";
import { isTruncatedBlob } from "./records.js";
import { RECORD_DIR_NAME, RecordStore, openRecordStore } from "./store.js";

let dir: string;
let store: RecordStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "replay-store-"));
  store = new RecordStore({ dir });
  await store.init();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("blob store", () => {
  it("content-addresses blobs and round-trips them", async () => {
    const { ref, isTruncated } = await store.putBlob("hello world");
    expect(isTruncated).toBe(false);
    expect(ref).toBe(sha256Hex("hello world"));
    expect(await store.getBlob(ref)).toBe("hello world");
  });

  it("dedups identical content to one blob", async () => {
    const a = await store.putBlob("same");
    const b = await store.putBlob("same");
    expect(a.ref).toBe(b.ref);
  });

  it("stores an explicit truncation marker over the ceiling", async () => {
    const big = "x".repeat(100);
    const { ref, isTruncated } = await store.putBlob(big, { maxBytes: 10 });
    expect(isTruncated).toBe(true);
    const marker = await store.getJsonBlob(ref);
    expect(isTruncatedBlob(marker)).toBe(true);
    if (isTruncatedBlob(marker)) {
      expect(marker.bytes).toBe(100);
      expect(marker.sha256).toBe(sha256Hex(big));
      expect(big.startsWith(marker.head)).toBe(true);
    }
  });

  it("putJsonBlob stores stable JSON and getJsonBlob parses it", async () => {
    const { ref } = await store.putJsonBlob({ b: 1, a: 2 });
    expect(await store.getBlob(ref)).toBe('{"a":2,"b":1}');
    expect(await store.getJsonBlob(ref)).toEqual({ a: 2, b: 1 });
  });

  it("getBlob returns null for unresolvable or malformed refs", async () => {
    expect(await store.getBlob("f".repeat(64))).toBeNull();
    expect(await store.getBlob("../../etc/passwd")).toBeNull();
    expect(await store.getBlob("short")).toBeNull();
  });

  it("getJsonBlob returns null for unparsable blob content", async () => {
    const { ref } = await store.putBlob("not json");
    expect(await store.getJsonBlob(ref)).toBeNull();
  });
});

describe("record log writer/reader", () => {
  it("stamps rv/sid/seq/ts and reads records back in order", async () => {
    const writer = store.openWriter({ sid: "s-1", now: () => 1720000000000 });
    writer.append({ t: "turn.start", turn: 1, prompt: "go" });
    writer.append({
      t: "turn.end",
      turn: 1,
      historyRef: "a".repeat(64),
      changedFiles: [],
      steps: 1,
      usage: { inputTokens: 1, outputTokens: 2, costUsd: 0 },
    });
    await writer.flush();

    const records = await store.readRecords();
    expect(records.map((r) => r.seq)).toEqual([1, 2]);
    expect(records[0]).toMatchObject({
      rv: 1,
      sid: "s-1",
      ts: 1720000000000,
      t: "turn.start",
    });
  });

  it("seeds seq from lastSeq for a resumed writer", async () => {
    const writer = store.openWriter({ sid: "s-1", lastSeq: 5 });
    const record = writer.append({ t: "turn.start", turn: 2, prompt: "more" });
    expect(record.seq).toBe(6);
    await writer.flush();
  });

  it("skips torn and foreign lines on read", async () => {
    const writer = store.openWriter({ sid: "s-1" });
    writer.append({ t: "turn.start", turn: 1, prompt: "go" });
    await writer.flush();
    await writeFile(
      join(dir, "record.ndjson"),
      (await readFile(join(dir, "record.ndjson"), "utf8")) +
        '{"garbage\n{"foreign":1}\n',
    );
    const records = await store.readRecords();
    expect(records).toHaveLength(1);
  });

  it("readRecords/hasRecords on a missing log", async () => {
    const empty = new RecordStore({ dir: join(dir, "nope") });
    expect(await empty.readRecords()).toEqual([]);
    expect(await empty.hasRecords()).toBe(false);
    expect(await store.hasRecords()).toBe(true);
  });
});

describe("openRecordStore", () => {
  it("roots the store at the session's record/ subdirectory", () => {
    const s = openRecordStore("/sessions/s-9");
    expect(s.rootDir).toBe(join("/sessions/s-9", RECORD_DIR_NAME));
  });
});
