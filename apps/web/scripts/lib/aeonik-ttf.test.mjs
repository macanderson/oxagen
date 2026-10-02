import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  STAMP,
  TTF,
  UNPACK,
  WOFF2,
  aeonikDrift,
  aeonikStamp,
} from "./aeonik-ttf.mjs";

const woff2 = Buffer.from("the kit's woff2");
const ttf = Buffer.from("its unpack");
const hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

describe("aeonikStamp", () => {
  it("writes one shasum line for the WOFF2 and one for the TTF", () => {
    expect(aeonikStamp(woff2, ttf)).toBe(
      `${hex(woff2)}  ${WOFF2}\n${hex(ttf)}  ${TTF}\n`,
    );
  });

  it("names repo paths, so `shasum -a 256 -c` reads it from the root", () => {
    expect(WOFF2).toBe("apps/web/fonts/aeonik-wght.woff2");
    expect(TTF).toBe("apps/web/scripts/fonts/aeonik-wght.ttf");
    expect(STAMP).toBe("apps/web/scripts/fonts/aeonik-wght.sha256");
    expect(UNPACK).toBe("node apps/web/scripts/unpack-aeonik.mjs");
  });
});

describe("aeonikDrift", () => {
  const stamp = aeonikStamp(woff2, ttf);

  it("passes the TTF the stamp names, unpacked from the WOFF2 it names", () => {
    expect(aeonikDrift(stamp, woff2, ttf)).toBeNull();
  });

  it("reads shasum's binary marker and CRLF line ends", () => {
    const binary = `${hex(woff2)} *${WOFF2}\r\n${hex(ttf)} *${TTF}\r\n`;
    expect(aeonikDrift(binary, woff2, ttf)).toBeNull();
  });

  // #5237: the brand sync rewrites the WOFF2 and leaves the TTF alone.
  it("fails when the WOFF2 changed after the unpack", () => {
    expect(aeonikDrift(stamp, Buffer.from("a newer woff2"), ttf)).toBe(
      `${WOFF2} changed after the TTF was unpacked from it`,
    );
  });

  it("fails when the TTF changed after the unpack", () => {
    expect(aeonikDrift(stamp, woff2, Buffer.from("edited"))).toBe(
      `${TTF} changed after the unpack wrote it`,
    );
  });

  it("fails unless the stamp holds the WOFF2 line and then the TTF line", () => {
    const want = `${STAMP} must hold two lines, one for ${WOFF2} and then one for ${TTF}`;
    const other = `${hex(woff2)}  some/other.woff2\n${hex(ttf)}  some/other.ttf\n`;
    const swapped = `${hex(ttf)}  ${TTF}\n${hex(woff2)}  ${WOFF2}\n`;
    // A stale line for the same file must not sit beside the current one.
    const stale = `${stamp}${hex(Buffer.from("older woff2"))}  ${WOFF2}\n`;
    const oneLine = `${hex(woff2)}  ${WOFF2}\n`;
    const wrongTtf = `${hex(woff2)}  ${WOFF2}\n${hex(ttf)}  some/other.ttf\n`;
    for (const bad of [other, swapped, stale, oneLine, wrongTtf]) {
      expect(aeonikDrift(bad, woff2, ttf)).toBe(want);
    }
  });

  it("fails on a stamp line that is not a sha256 and a path", () => {
    expect(aeonikDrift(`${stamp}not a line\n`, woff2, ttf)).toBe(
      `${STAMP} has a line that is not "<sha256>  <path>"`,
    );
  });

  it("names whichever file is missing", () => {
    expect(aeonikDrift(stamp, null, ttf)).toBe(`${WOFF2} is missing`);
    expect(aeonikDrift(stamp, woff2, null)).toBe(`${TTF} is missing`);
    expect(aeonikDrift(null, woff2, ttf)).toBe(
      `${STAMP} is missing, so nothing records which WOFF2 the TTF came from`,
    );
  });
});
