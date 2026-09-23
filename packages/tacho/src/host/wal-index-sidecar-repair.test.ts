/**
 * Tacho collector P1-5: the body index sidecar (`<session>.bodies.index`)
 * appended without a leading newline, so a write landing right after a crash
 * mid-append concatenated onto the unfinished line instead of starting a new
 * one. `load` skipped the resulting joined line as unparseable — correct for
 * an ordinary torn *last* line — but a `through` marker written after it
 * still claimed coverage of the bytes the joined line should have indexed,
 * so `bodiesOfSession` (via `Wal.bodiesFor`) treated a body that is really on
 * disk as one that never arrived, permanently: nothing ever rescans past a
 * `covered` mark that already claims the file.
 */
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BodyIndexStore, type StoredBody } from "./wal-index";

const SESSION = "5c1f0a2e-0000-4000-8000-00000000f00d";

const dirs: string[] = [];
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tacho-wal-index-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function storedLine(idem: string, seq: number, text: string): string {
  const stored: StoredBody = {
    event_id_idem: idem,
    seq,
    content_type: "text/plain",
    bytes_base64: Buffer.from(text).toString("base64"),
  };
  return JSON.stringify(stored);
}

describe("BodyIndexStore sidecar durability", () => {
  it("separates a fresh append from a torn sidecar tail with a leading newline", () => {
    const dir = scratchDir();
    const bodyPath = join(dir, `${SESSION}.bodies.jsonl`);
    writeFileSync(bodyPath, `${storedLine("evt_a", 0, "body a")}\n`);
    new BodyIndexStore(dir).ensure(
      SESSION,
      bodyPath,
      () => {},
      () => {},
    );
    const sidecarPath = join(dir, `${SESSION}.bodies.index`);
    // A crash after the content bytes landed but before the newline that
    // closes the sidecar's last line.
    writeFileSync(
      sidecarPath,
      readFileSync(sidecarPath, "utf8").replace(/\n$/, ""),
    );
    appendFileSync(bodyPath, `${storedLine("evt_b", 1, "body b")}\n`);
    // A fresh instance, the shape of a daemon restart: no in-memory cache,
    // so this reads the torn sidecar from disk.
    new BodyIndexStore(dir).ensure(
      SESSION,
      bodyPath,
      () => {},
      () => {},
    );
    const raw = readFileSync(sidecarPath, "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("forces a full rescan rather than trust a `through` marker written after a corrupted middle line", () => {
    const dir = scratchDir();
    const bodyPath = join(dir, `${SESSION}.bodies.jsonl`);
    writeFileSync(
      bodyPath,
      `${storedLine("evt_a", 0, "body a")}\n${storedLine("evt_b", 1, "body b")}\n`,
    );
    const sidecarPath = join(dir, `${SESSION}.bodies.index`);
    const size = readFileSync(bodyPath, "utf8").length;
    // A sidecar written by a build before the leading-newline fix: the
    // header and evt_a's entry landed; evt_b's entry line is a crash-torn
    // fragment (joined with whatever the next append started with, here
    // simplified to an unparseable line on its own); and a LATER append's
    // `through` marker still landed as a clean, valid, final line claiming
    // the whole file is covered.
    writeFileSync(
      sidecarPath,
      [
        JSON.stringify(["tacho/bodies-index", 1]),
        JSON.stringify(["evt_a", 0, storedLine("evt_a", 0, "body a").length]),
        '["evt_b",{"offset":999', // torn mid-object: not valid JSON
        JSON.stringify(["through", size]),
      ].join("\n") + "\n",
    );
    const found = new BodyIndexStore(dir).ensure(
      SESSION,
      bodyPath,
      () => {},
      () => {},
    );
    // A `load` that trusted the `through` marker after the corrupted line
    // would answer with `evt_a` only, `covered` already claiming the whole
    // file, and `evt_b` lost for good. Forcing a rescan finds both, because
    // the body file itself was never corrupted.
    expect([...found.entries.keys()].sort()).toEqual(["evt_a", "evt_b"]);
  });
});
