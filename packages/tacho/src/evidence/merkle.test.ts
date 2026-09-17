import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { digestBytes } from "../digest";
import { merkleRoot } from "./merkle";

const sha = (...parts: Buffer[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
const raw = (d: string) => Buffer.from(d.slice("sha256:".length), "hex");
const leaf = (d: string) => sha(Buffer.from([0]), raw(d));
const node = (l: Buffer, r: Buffer) => sha(Buffer.from([1]), l, r);
const hex = (b: Buffer): string => `sha256:${b.toString("hex")}`;

const d = [0, 1, 2, 3, 4].map((i) => digestBytes(`frame-${i}`));

describe("merkleRoot", () => {
  it("is the hash of nothing for an empty stream", () => {
    expect(merkleRoot([])).toBe(hex(sha()));
  });

  it("is the domain-separated leaf hash for one frame", () => {
    expect(merkleRoot([d[0]!])).toBe(hex(leaf(d[0]!)));
    expect(merkleRoot([d[0]!])).not.toBe(d[0]);
  });

  it("splits at the largest power of two below n (RFC 6962 §2.1)", () => {
    const two = node(leaf(d[0]!), leaf(d[1]!));
    expect(merkleRoot(d.slice(0, 2))).toBe(hex(two));
    const three = node(two, leaf(d[2]!));
    expect(merkleRoot(d.slice(0, 3))).toBe(hex(three));
    const four = node(two, node(leaf(d[2]!), leaf(d[3]!)));
    const five = node(four, leaf(d[4]!));
    expect(merkleRoot(d)).toBe(hex(five));
  });

  it("commits to order", () => {
    expect(merkleRoot([d[0]!, d[1]!])).not.toBe(merkleRoot([d[1]!, d[0]!]));
  });

  it("refuses a leaf that is not a sha256 digest", () => {
    expect(() => merkleRoot(["md5:abc"])).toThrow(/not a sha256 digest/);
  });
});
