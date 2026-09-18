import { mkdtempSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { TACHO_MAX_BODY_BYTES } from "../wire";
import { BodyStore } from "./body-store";

const enc = new TextEncoder();
const idem = (suffix: string) =>
  `evt_${suffix.padStart(64, "0")}` as `evt_${string}`;

describe("BodyStore", () => {
  let dir: string;
  let store: BodyStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tacho-bodies-"));
    store = new BodyStore(dir);
  });

  it("hands back what it was given, base64 for the wire", () => {
    expect(store.put(idem("a"), "text/plain", enc.encode("ship it"))).toBe(
      true,
    );
    expect(store.take([idem("a")])).toEqual([
      {
        event_id_idem: idem("a"),
        content_type: "text/plain",
        bytes_base64: Buffer.from("ship it").toString("base64"),
      },
    ]);
  });

  it("keeps the files to the owner only", () => {
    store.put(idem("b"), "text/plain", enc.encode("private"));
    const file = readdirSync(dir)[0];
    expect(file).toBeDefined();
    expect(statSync(join(dir, file as string)).mode & 0o777).toBe(0o600);
  });

  it("refuses an id it will not name a file after", () => {
    // Anything but `evt_` and 64 hex: a traversal attempt reaches the same
    // answer as a typo, and neither writes a file.
    expect(store.put("../../etc/passwd", "text/plain", enc.encode("x"))).toBe(
      false,
    );
    expect(store.put("evt_short", "text/plain", enc.encode("x"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a body over the wire's ceiling rather than shipping it to be refused", () => {
    const tooBig = new Uint8Array(TACHO_MAX_BODY_BYTES + 1);
    expect(store.put(idem("c"), "text/plain", tooBig)).toBe(false);
    expect(store.take([idem("c")])).toEqual([]);
  });

  it("skips an event it holds nothing for", () => {
    store.put(idem("d"), "text/plain", enc.encode("here"));
    expect(store.take([idem("d"), idem("e")]).map((b) => b.event_id_idem)).toEqual(
      [idem("d")],
    );
  });

  it("drops what the control plane settled, and ignores what is already gone", () => {
    store.put(idem("f"), "text/plain", enc.encode("done"));
    store.drop([idem("f"), idem("f"), idem("aa")]);
    expect(store.take([idem("f")])).toEqual([]);
    expect(store.stats()).toEqual({ bodies: 0, bytes: 0 });
  });

  it("compacts a body no batch ever came back for", () => {
    store.put(idem("11"), "text/plain", enc.encode("stranded"));
    store.put(idem("22"), "text/plain", enc.encode("fresh"));
    const old = join(dir, `${idem("11")}.json`);
    const past = new Date(Date.now() - 10 * 24 * 60 * 60_000);
    utimesSync(old, past, past);

    expect(store.compact(Date.now(), 7 * 24 * 60 * 60_000)).toEqual([
      idem("11"),
    ]);
    expect(store.take([idem("11")])).toEqual([]);
    expect(store.take([idem("22")])).toHaveLength(1);
  });
});
