import { mkdtempSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { TACHO_MAX_BODY_BYTES } from "../wire";
import type { RetentionMandate } from "../evidence/retention";
import { BodyStore } from "./body-store";

const enc = new TextEncoder();
/** A mandate that retains the model exchange, which `turn_start` belongs to. */
const KEEPS: RetentionMandate = {
  mode: "content_exact",
  classes: ["model_call", "tool_call"],
};
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
    expect(store.put(idem("a"), "turn_start", "text/plain", enc.encode("ship it"))).toBe(
      true,
    );
    expect(store.take([idem("a")], KEEPS)).toEqual([
      {
        event_id_idem: idem("a"),
        content_type: "text/plain",
        bytes_base64: Buffer.from("ship it").toString("base64"),
      },
    ]);
  });

  it("keeps the files to the owner only", () => {
    store.put(idem("b"), "turn_start", "text/plain", enc.encode("private"));
    const file = readdirSync(dir)[0];
    expect(file).toBeDefined();
    expect(statSync(join(dir, file as string)).mode & 0o777).toBe(0o600);
  });

  it("refuses an id it will not name a file after", () => {
    // Anything but `evt_` and 64 hex: a traversal attempt reaches the same
    // answer as a typo, and neither writes a file.
    expect(store.put("../../etc/passwd", "turn_start", "text/plain", enc.encode("x"))).toBe(
      false,
    );
    expect(store.put("evt_short", "turn_start", "text/plain", enc.encode("x"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a body over the wire's ceiling rather than shipping it to be refused", () => {
    const tooBig = new Uint8Array(TACHO_MAX_BODY_BYTES + 1);
    expect(store.put(idem("c"), "turn_start", "text/plain", tooBig)).toBe(false);
    expect(store.take([idem("c")], KEEPS)).toEqual([]);
  });

  it("skips an event it holds nothing for", () => {
    store.put(idem("d"), "turn_start", "text/plain", enc.encode("here"));
    expect(store.take([idem("d"), idem("e")], KEEPS).map((b) => b.event_id_idem)).toEqual(
      [idem("d")],
    );
  });

  it("drops what the control plane settled, and ignores what is already gone", () => {
    store.put(idem("f"), "turn_start", "text/plain", enc.encode("done"));
    store.drop([idem("f"), idem("f"), idem("aa")]);
    expect(store.take([idem("f")], KEEPS)).toEqual([]);
    expect(store.stats()).toEqual({ bodies: 0, bytes: 0 });
  });

  it("compacts a body no batch ever came back for", () => {
    store.put(idem("11"), "turn_start", "text/plain", enc.encode("stranded"));
    store.put(idem("22"), "turn_start", "text/plain", enc.encode("fresh"));
    const old = join(dir, `${idem("11")}.json`);
    const past = new Date(Date.now() - 10 * 24 * 60 * 60_000);
    utimesSync(old, past, past);

    expect(store.compact(Date.now(), 7 * 24 * 60 * 60_000)).toEqual([
      idem("11"),
    ]);
    expect(store.take([idem("11")], KEEPS)).toEqual([]);
    expect(store.take([idem("22")], KEEPS)).toHaveLength(1);
  });
});

describe("BodyStore and a mandate that narrows", () => {
  let dir: string;
  let store: BodyStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tacho-bodies-"));
    store = new BodyStore(dir);
    store.put(idem("a1"), "turn_start", "text/plain", enc.encode("a prompt"));
    store.put(idem("b2"), "tool_call", "text/plain", enc.encode("a result"));
  });

  it("hands over nothing once the mode is digest_only, and keeps nothing either", () => {
    // The race this closes: bodies written while the mandate said
    // content_exact, then a refresh to digest_only before the WAL drains.
    // The control plane would refuse them, but the bytes would already have
    // left the machine, which is the one thing digest_only promises.
    expect(
      store.take([idem("a1"), idem("b2")], { mode: "digest_only", classes: [] }),
    ).toEqual([]);
    expect(store.stats().bodies).toBe(0);
  });

  it("hands over only the classes the mandate names", () => {
    const only = { mode: "content_exact", classes: ["tool_call"] } as const;
    expect(store.take([idem("a1"), idem("b2")], only).map((b) => b.event_id_idem)).toEqual([
      idem("b2"),
    ]);
    // The prompt was not authorised, so it is gone rather than held back.
    expect(store.take([idem("a1")], KEEPS)).toEqual([]);
  });

  it("keeps nothing when the mandate names no class at all", () => {
    expect(
      store.take([idem("a1"), idem("b2")], {
        mode: "content_exact",
        classes: [],
      }),
    ).toEqual([]);
  });

  it("drops what a narrowed mandate no longer retains, on refresh", () => {
    expect(
      store.dropDisallowed({ mode: "content_exact", classes: ["tool_call"] }),
    ).toBe(1);
    expect(store.stats().bodies).toBe(1);
    expect(store.dropDisallowed({ mode: "digest_only", classes: [] })).toBe(1);
    expect(store.stats().bodies).toBe(0);
  });
});
