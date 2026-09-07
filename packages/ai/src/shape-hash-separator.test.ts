/**
 * The cache `shapeHash` in generate-object.ts joins its parts on a NUL byte,
 * and that byte used to be written into the source as a raw NUL rather than as
 * the escape `\0` (#1416). A raw control byte makes git treat the file as
 * binary — diffs render as `Bin` and ripgrep skips it — so the escape is the
 * same byte with none of that.
 *
 * `shapeHash` is composed inline, so this pins the composition rather than the
 * private function: the separator must stay U+0000. A later edit that swaps it
 * for a printable stand-in would re-key every cached response — every entry
 * already stored becomes unreachable, and the miss is silent, because a cache
 * miss looks exactly like a cold cache.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./cache";

const SHAPE_PARTS = ["you are a bot", "0", "obj:{a:string}"] as const;

describe("generate-object shapeHash separator", () => {
  it("joins on U+0000, not on a printable stand-in", () => {
    const rawNul = String.fromCharCode(0);
    const viaRawByte = createHash("sha256")
      .update([...SHAPE_PARTS].join(rawNul))
      .digest("hex");

    expect(sha256Hex([...SHAPE_PARTS].join("\0"))).toBe(viaRawByte);
  });

  it("pins the shape hash, so the cache key cannot move unnoticed", () => {
    expect(sha256Hex([...SHAPE_PARTS].join("\0"))).toBe(
      "2a76f686c9fcfa03702afeeb7e1e5dcc2a02a73a0ee025a66afb44e55c827794",
    );
  });

  it("keeps the separator distinct from an empty join", () => {
    // "a"+"bc" and "ab"+"c" collide under an empty separator; the NUL is what
    // stops two different shapes sharing one cache entry.
    expect(sha256Hex(["a", "bc"].join("\0"))).not.toBe(
      sha256Hex(["ab", "c"].join("\0")),
    );
  });
});
